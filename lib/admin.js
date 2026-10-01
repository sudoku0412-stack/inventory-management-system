import { randomUUID } from 'node:crypto';
import { accessConfig, requireCloudflareAccess } from './shared.js';
import { keepDaysOf, revokeInvitationCore } from './household-access.js';
import { restoreShopStatement } from './shop-purge.js';
import { isFlag, shopFlagStates } from './feature-flags.js';
import { shopOptions, shopTypeRef } from './options.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (message, status) => Object.assign(new Error(message), { status });

export function adminEmails(env = {}) {
  return String(env.ADMIN_EMAILS || '').split(',').map(item => item.trim().toLowerCase()).filter(item => item.includes('@'));
}

/**
 * Verifies the admin Access application's JWT (its own AUD) and requires the email to be
 * allow-listed. Customer-app tokens fail the AUD check. Missing configuration fails closed.
 */
export async function authorizeAdmin(request, env, keys) {
  const emails = adminEmails(env);
  if (!env.ADMIN_ACCESS_AUD || !emails.length || !accessConfig({ ...env, ACCESS_AUD: env.ADMIN_ACCESS_AUD })) throw failure('Admin console is not configured.', 503);
  const principal = await requireCloudflareAccess(request, { env: { ...env, ACCESS_AUD: env.ADMIN_ACCESS_AUD }, now: Date.now, keys });
  if (!principal?.email || !emails.includes(principal.email)) throw failure('This account is not allowed to use the admin console.', 403);
  return { email: principal.email };
}

export async function writeAdminAudit(db, { email, action, target = null, requestId = randomUUID() }, now = () => new Date().toISOString()) {
  try {
    await db.prepare('INSERT INTO admin_audit (id,admin_email,action,target,request_id,created_at) VALUES (?,?,?,?,?,?)')
      .bind(randomUUID(), email, action, target, requestId, now()).run();
  } catch { throw failure('Admin audit is unavailable, so this request was refused.', 503); }
}

function limitOf(params) {
  const raw = params.get('limit');
  if (raw === null) return 50;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw failure('Invalid limit.', 400);
  return Number(raw);
}

function pageOf(rows, limit, key) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: more ? key(items.at(-1)) : null };
}

const count = async (db, sql) => Number((await db.prepare(sql).first())?.n ?? 0);

export async function adminOverview(db, now = () => new Date().toISOString()) {
  const since = new Date(new Date(now()).getTime() - 24 * 60 * 60 * 1000).toISOString();
  let migrations = null, migrationState = null;
  try { migrations = await count(db, 'SELECT count(*) AS n FROM d1_migrations'); } catch { /* absent outside D1 */ }
  try { migrationState = (await db.prepare('SELECT state FROM migration_runs WHERE singleton=1').first())?.state ?? null; } catch { /* absent */ }
  return {
    shops: await count(db, 'SELECT count(*) AS n FROM households'),
    users: await count(db, 'SELECT count(*) AS n FROM users'),
    memberships: await count(db, 'SELECT count(*) AS n FROM memberships'),
    owners: await count(db, "SELECT count(*) AS n FROM memberships WHERE role='owner'"),
    pendingInvitations: Number((await db.prepare('SELECT count(*) AS n FROM household_invitations WHERE expires_at IS NULL OR expires_at > ?').bind(now()).first())?.n ?? 0),
    medicines: await count(db, 'SELECT count(*) AS n FROM batches WHERE discarded_at IS NULL'),
    changeFeedRows: await count(db, 'SELECT count(*) AS n FROM batch_changes'),
    emailsNeedingAttention: await count(db, "SELECT count(*) AS n FROM notification_outbox WHERE status IN ('failed','uncertain')").catch(() => 0),
    emailsQueued: await count(db, "SELECT count(*) AS n FROM notification_outbox WHERE status IN ('pending','sending')").catch(() => 0),
    auditEventsLast24h: Number((await db.prepare('SELECT count(*) AS n FROM access_audit WHERE created_at >= ?').bind(since).first())?.n ?? 0),
    appliedMigrations: migrations,
    migrationState
  };
}

export async function adminShops(db, params) {
  const limit = limitOf(params), cursor = params.get('cursor');
  if (cursor !== null && !UUID.test(cursor)) throw failure('Invalid cursor.', 400);
  const { results } = await db.prepare(`SELECT h.id, h.name, h.created_at,
      (SELECT count(*) FROM memberships m WHERE m.household_id=h.id AND m.role='owner') AS owner_count,
      (SELECT count(*) FROM memberships m WHERE m.household_id=h.id) AS member_count,
      (SELECT count(*) FROM batches b WHERE b.household_id=h.id AND b.discarded_at IS NULL) AS medicine_count,
      COALESCE((SELECT c.name FROM shop_types st JOIN custom_shop_types c ON c.id=st.custom_type_id WHERE st.household_id=h.id),
        CASE (SELECT st.shop_type FROM shop_types st WHERE st.household_id=h.id) WHEN 'goods' THEN 'General goods' ELSE 'Medicine' END) AS shop_type,
      (SELECT max(a.created_at) FROM access_audit a WHERE a.household_id=h.id) AS last_audit_at,
      (SELECT d.deleted_at FROM household_deletions d WHERE d.household_id=h.id) AS deleted_at
    FROM households h WHERE (? IS NULL OR h.id > ?) ORDER BY h.id LIMIT ?`).bind(cursor, cursor, limit + 1).all();
  const page = pageOf(results || [], limit, item => item.id);
  return { shops: page.items.map(item => ({ ...item })), nextCursor: page.nextCursor };
}

const auditColumns = 'id, event, household_id, actor_user_id, target_identifier, created_at';

async function auditPage(db, { shop = null, cursor = null, limit }) {
  const { results } = await db.prepare(`SELECT ${auditColumns} FROM access_audit
    WHERE (? IS NULL OR household_id=?) AND (? IS NULL OR (created_at || '|' || id) < ?)
    ORDER BY created_at DESC, id DESC LIMIT ?`).bind(shop, shop, cursor, cursor, limit + 1).all();
  const page = pageOf(results || [], limit, item => `${item.created_at}|${item.id}`);
  return { events: page.items.map(item => ({ ...item })), nextCursor: page.nextCursor };
}

function auditCursor(params) {
  const cursor = params.get('cursor');
  if (cursor !== null && !/^[0-9TZ:.\-]{10,40}\|[A-Za-z0-9-]{1,64}$/.test(cursor)) throw failure('Invalid cursor.', 400);
  return cursor;
}

export async function adminShopDetail(db, shopId, now = () => new Date().toISOString(), env = {}) {
  if (!UUID.test(shopId)) throw failure('Shop not found.', 404);
  const shop = await db.prepare('SELECT id, name, created_at FROM households WHERE id=?').bind(shopId).first();
  if (!shop) throw failure('Shop not found.', 404);
  const members = await db.prepare(`SELECT m.user_id, m.role, m.created_at AS joined_at,
      (SELECT i.email FROM identities i WHERE i.user_id=m.user_id ORDER BY i.email LIMIT 1) AS email
    FROM memberships m WHERE m.household_id=? ORDER BY m.role, m.created_at, m.user_id`).bind(shopId).all();
  const invitations = await db.prepare('SELECT id, email, created_at, expires_at FROM household_invitations WHERE household_id=? ORDER BY created_at, id').bind(shopId).all();
  const medicines = Number((await db.prepare('SELECT count(*) AS n FROM batches WHERE household_id=? AND discarded_at IS NULL').bind(shopId).first())?.n ?? 0);
  const audit = await auditPage(db, { shop: shopId, limit: 50 });
  const deletion = await db.prepare('SELECT deleted_at, purge_after, purged_at FROM household_deletions WHERE household_id=?').bind(shopId).first();
  return {
    shop: { ...shop, medicine_count: medicines },
    shopType: await shopTypeDetail(db, shopId),
    deletion: deletion ? { ...deletion } : null,
    flags: await shopFlagStates(db, env, shopId),
    members: (members.results || []).map(item => ({ ...item })),
    invitations: (invitations.results || []).map(item => ({ ...item, pending: !item.expires_at || item.expires_at > now() })),
    audit: audit.events
  };
}

/** Read-only: the Shop's type and the lists it currently offers. Lists are configuration, never item contents. */
async function shopTypeDetail(db, shopId) {
  const ref = await shopTypeRef(db, shopId);
  const { lists } = await shopOptions(db, shopId);
  let ownerEmail = null, createdAt = null;
  if (ref.customId) {
    const owner = await db.prepare(`SELECT c.created_at,
      (SELECT i.email FROM identities i WHERE i.user_id=c.owner_user_id ORDER BY i.email LIMIT 1) AS email
      FROM custom_shop_types c WHERE c.id=?`).bind(ref.customId).first();
    ownerEmail = owner?.email ?? null; createdAt = owner?.created_at ?? null;
  }
  return { key: ref.key, name: ref.name, base: ref.base, custom: Boolean(ref.customId), usesStrength: ref.usesStrength, formLabel: ref.formLabel, ownerEmail, createdAt, lists };
}

/** Read-only list of every Owner-made Shop type: who made it, how it behaves, how many Shops use it, and its lists. */
export async function adminShopTypes(db, params) {
  const limit = limitOf(params), cursor = params.get('cursor');
  if (cursor !== null && !UUID.test(cursor)) throw failure('Invalid cursor.', 400);
  const { results } = await db.prepare(`SELECT c.id, c.name, c.base_type, c.uses_strength, COALESCE(c.form_label_text, c.form_label) AS form_label, c.created_at,
      (SELECT i.email FROM identities i WHERE i.user_id=c.owner_user_id ORDER BY i.email LIMIT 1) AS owner_email,
      (SELECT count(*) FROM shop_types st WHERE st.custom_type_id=c.id) AS shop_count
    FROM custom_shop_types c WHERE (? IS NULL OR c.id > ?) ORDER BY c.id LIMIT ?`).bind(cursor, cursor, limit + 1).all();
  const page = pageOf(results || [], limit, item => item.id);
  const types = [];
  for (const item of page.items) {
    const rows = await db.prepare('SELECT list,value FROM custom_type_options WHERE type_id=? ORDER BY list,sort_order,value').bind(item.id).all();
    const lists = { form: [], unit: [], location: [], strength: [] };
    for (const row of rows.results || []) lists[row.list]?.push(row.value);
    types.push({ ...item, uses_strength: Boolean(item.uses_strength), lists });
  }
  return { types, nextCursor: page.nextCursor };
}

export async function adminAudit(db, params) {
  const shop = params.get('shop');
  if (shop !== null && !UUID.test(shop)) throw failure('Invalid Shop.', 400);
  return auditPage(db, { shop, cursor: auditCursor(params), limit: limitOf(params) });
}

export async function adminActivity(db, params) {
  const limit = limitOf(params), cursor = auditCursor(params);
  const { results } = await db.prepare(`SELECT id, admin_email, action, target, request_id, created_at FROM admin_audit
    WHERE (? IS NULL OR (created_at || '|' || id) < ?) ORDER BY created_at DESC, id DESC LIMIT ?`).bind(cursor, cursor, limit + 1).all();
  const page = pageOf(results || [], limit, item => `${item.created_at}|${item.id}`);
  return { events: page.items.map(item => ({ ...item })), nextCursor: page.nextCursor };
}

/** Emails that are not finished: queued, failed or uncertain. Sent and cancelled rows are not listed. */
export async function adminEmailOutbox(db, params) {
  const limit = limitOf(params), cursor = auditCursor(params);
  let results = [];
  try {
    ({ results } = await db.prepare(`SELECT id, kind, recipient_email, status, attempts, last_error, created_at, next_attempt_at FROM notification_outbox
      WHERE status IN ('pending','sending','failed','uncertain') AND (? IS NULL OR (created_at || '|' || id) < ?)
      ORDER BY created_at DESC, id DESC LIMIT ?`).bind(cursor, cursor, limit + 1).all());
  } catch (error) { if (!/no such table/i.test(String(error?.message || ''))) throw error; }
  const page = pageOf(results || [], limit, item => `${item.created_at}|${item.id}`);
  return { emails: page.items.map(item => ({ ...item })), nextCursor: page.nextCursor };
}

// ---- Audited write actions (v1): revoke a pending invitation, restore a Shop inside its grace period. ----

const WRITE_LIMIT_PER_MINUTE = 30;

export function validateAdminWrite(data = {}, { withDays = false, withFlag = false } = {}) {
  const expected = withFlag ? 'flag,operationId,reason,value' : withDays ? 'keepDays,operationId,reason' : 'operationId,reason';
  if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== expected) throw failure('Unexpected admin action field.', 400);
  if (typeof data.operationId !== 'string' || !UUID.test(data.operationId)) throw failure('Enter a valid operation id.', 400);
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500) throw failure('Give a reason of 10 to 500 characters.', 400);
  if (withFlag) {
    if (typeof data.flag !== 'string' || !isFlag(data.flag)) throw failure('Unknown flag.', 400);
    if (data.value !== true && data.value !== false && data.value !== null) throw failure('Choose on, off, or follow the global setting.', 400);
  }
  return { operationId: data.operationId, reason, ...(withDays ? { keepDays: keepDaysOf(data.keepDays) } : {}), ...(withFlag ? { flag: data.flag, value: data.value } : {}) };
}

const findReceipt = (db, email, operationId) => db.prepare('SELECT action,target FROM admin_audit WHERE admin_email=? AND operation_id=?').bind(email, operationId).first();

async function guardWrite(db, email, now) {
  const since = new Date(new Date(now()).getTime() - 60 * 1000).toISOString();
  const recent = await db.prepare('SELECT count(*) AS n FROM admin_audit WHERE admin_email=? AND operation_id IS NOT NULL AND created_at > ?').bind(email, since).first();
  if (Number(recent?.n) >= WRITE_LIMIT_PER_MINUTE) throw Object.assign(failure('Too many admin changes. Try again in a minute.', 429), { retryAfter: 60 });
}

// The admin row must directly follow a statement that reports changes()=1, so it never commits without its mutation.
const auditStatement = (db, { email, action, target, reason, operationId, requestId, now }) => db.prepare(
  'INSERT INTO admin_audit (id,admin_email,action,target,request_id,created_at,reason,operation_id) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1'
).bind(randomUUID(), email, action, target, requestId, now(), reason, operationId);

async function runWrite(db, { email, action, target, operationId, now }, mutate) {
  const replayed = async () => {
    const receipt = await findReceipt(db, email, operationId);
    if (!receipt) return null;
    if (receipt.action !== action || receipt.target !== target) throw failure('This operation id was already used for a different action.', 409);
    return { changed: false };
  };
  const first = await replayed();
  if (first) return first;
  await guardWrite(db, email, now);
  try {
    return await mutate();
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) { const winner = await replayed(); if (winner) return winner; }
    throw error;
  }
}

export async function adminRevokeInvitation(db, admin, { shopId, invitationId }, data, { requestId = randomUUID(), now = () => new Date().toISOString()} = {}) {
  const { operationId, reason } = validateAdminWrite(data);
  if (!UUID.test(String(shopId))) throw failure('Shop not found.', 404);
  if (!await db.prepare('SELECT 1 FROM households WHERE id=?').bind(shopId).first()) throw failure('Shop not found.', 404);
  const action = 'invitation.revoke', target = `invitation:${invitationId}`;
  return runWrite(db, { email: admin.email, action, target, operationId, now }, async () => {
    await revokeInvitationCore(db, { householdId: shopId, invitationId, actorUserId: null, targetLabel: 'staff action', requestId, now,
      extra: [auditStatement(db, { email: admin.email, action, target, reason, operationId, requestId, now })] });
    return { changed: true };
  });
}

export async function adminRestoreShop(db, admin, shopId, data, { requestId = randomUUID(), now = () => new Date().toISOString()} = {}) {
  const { operationId, reason } = validateAdminWrite(data);
  if (!UUID.test(String(shopId))) throw failure('Shop not found.', 404);
  if (!await db.prepare('SELECT 1 FROM households WHERE id=?').bind(shopId).first()) throw failure('Shop not found.', 404);
  const action = 'shop.restore', target = `shop:${shopId}`;
  return runWrite(db, { email: admin.email, action, target, operationId, now }, async () => {
    const state = await db.prepare('SELECT purge_after, purged_at FROM household_deletions WHERE household_id=?').bind(shopId).first();
    if (!state) throw failure('This Shop is not pending deletion.', 409);
    if (state.purged_at || state.purge_after <= now()) throw failure('The grace period has ended; this Shop can no longer be restored.', 409);
    const result = await db.batch([
      restoreShopStatement(db, shopId, now()),
      db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) SELECT ?,'shop_restored',?,NULL,?,?,? WHERE changes()=1")
        .bind(randomUUID(), shopId, 'staff action', now(), requestId),
      auditStatement(db, { email: admin.email, action, target, reason, operationId, requestId, now })
    ]);
    if (!result[0]?.meta?.changes) throw failure('This Shop can no longer be restored.', 409);
    return { changed: true };
  });
}

/** Push a pending Shop's purge deadline later (never earlier), counted from now. */
export async function adminExtendShop(db, admin, shopId, data, { requestId = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const { operationId, reason, keepDays } = validateAdminWrite(data, { withDays: true });
  if (!UUID.test(String(shopId))) throw failure('Shop not found.', 404);
  if (!await db.prepare('SELECT 1 FROM households WHERE id=?').bind(shopId).first()) throw failure('Shop not found.', 404);
  const action = 'shop.extend', target = `shop:${shopId}:${keepDays}d`;
  return runWrite(db, { email: admin.email, action, target, operationId, now }, async () => {
    const state = await db.prepare('SELECT purge_after, purged_at FROM household_deletions WHERE household_id=?').bind(shopId).first();
    if (!state) throw failure('This Shop is not pending deletion.', 409);
    if (state.purged_at || state.purge_after <= now()) throw failure('The grace period has ended; this Shop can no longer be extended.', 409);
    const purgeAfter = new Date(Date.parse(now()) + keepDays * 24 * 60 * 60 * 1000).toISOString();
    if (purgeAfter <= state.purge_after) throw failure('That is not later than the current deadline.', 409);
    const result = await db.batch([
      db.prepare('UPDATE household_deletions SET purge_after=? WHERE household_id=? AND purged_at IS NULL AND purge_after > ? AND purge_after < ?').bind(purgeAfter, shopId, now(), purgeAfter),
      db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) SELECT ?,'shop_extended',?,NULL,?,?,? WHERE changes()=1")
        .bind(randomUUID(), shopId, 'staff action', now(), requestId),
      auditStatement(db, { email: admin.email, action, target, reason, operationId, requestId, now })
    ]);
    if (!result[0]?.meta?.changes) throw failure('This Shop can no longer be extended.', 409);
    return { changed: true, purgeAfter };
  });
}

/** Switch one feature flag for one Shop: on, off, or null to follow the global secret again. Takes effect on the next request. */
export async function adminSetShopFlag(db, admin, shopId, data, { requestId = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const { operationId, reason, flag, value } = validateAdminWrite(data, { withFlag: true });
  if (!UUID.test(String(shopId))) throw failure('Shop not found.', 404);
  if (!await db.prepare('SELECT 1 FROM households WHERE id=?').bind(shopId).first()) throw failure('Shop not found.', 404);
  const state = value === null ? 'default' : value ? 'on' : 'off';
  const action = 'shop.flag', target = `shop:${shopId}:${flag}=${state}`;
  return runWrite(db, { email: admin.email, action, target, operationId, now }, async () => {
    let current;
    try { current = await db.prepare('SELECT enabled FROM shop_feature_flags WHERE household_id=? AND flag=?').bind(shopId, flag).first(); }
    catch (error) { if (/no such table/i.test(String(error?.message || ''))) throw failure('Per-Shop flags are temporarily unavailable.', 503); throw error; }
    const now0 = current === null || current === undefined ? null : Boolean(current.enabled);
    if (now0 === value) return { changed: false, flag, value };
    const mutation = value === null
      ? db.prepare('DELETE FROM shop_feature_flags WHERE household_id=? AND flag=?').bind(shopId, flag)
      : db.prepare(`INSERT INTO shop_feature_flags (household_id,flag,enabled,updated_at,updated_by) VALUES (?,?,?,?,?)
          ON CONFLICT(household_id,flag) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .bind(shopId, flag, value ? 1 : 0, now(), admin.email);
    const result = await db.batch([
      mutation,
      db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) SELECT ?,'shop_flag_changed',?,NULL,?,?,? WHERE changes()=1")
        .bind(randomUUID(), shopId, `${flag}=${state}`, now(), requestId),
      auditStatement(db, { email: admin.email, action, target, reason, operationId, requestId, now })
    ]);
    if (!result[0]?.meta?.changes) return { changed: false, flag, value };
    return { changed: true, flag, value };
  });
}
