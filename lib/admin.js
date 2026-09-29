import { randomUUID } from 'node:crypto';
import { accessConfig, requireCloudflareAccess } from './shared.js';

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
      (SELECT max(a.created_at) FROM access_audit a WHERE a.household_id=h.id) AS last_audit_at
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

export async function adminShopDetail(db, shopId, now = () => new Date().toISOString()) {
  if (!UUID.test(shopId)) throw failure('Shop not found.', 404);
  const shop = await db.prepare('SELECT id, name, created_at FROM households WHERE id=?').bind(shopId).first();
  if (!shop) throw failure('Shop not found.', 404);
  const members = await db.prepare(`SELECT m.user_id, m.role, m.created_at AS joined_at,
      (SELECT i.email FROM identities i WHERE i.user_id=m.user_id ORDER BY i.email LIMIT 1) AS email
    FROM memberships m WHERE m.household_id=? ORDER BY m.role, m.created_at, m.user_id`).bind(shopId).all();
  const invitations = await db.prepare('SELECT id, email, created_at, expires_at FROM household_invitations WHERE household_id=? ORDER BY created_at, id').bind(shopId).all();
  const medicines = Number((await db.prepare('SELECT count(*) AS n FROM batches WHERE household_id=? AND discarded_at IS NULL').bind(shopId).first())?.n ?? 0);
  const audit = await auditPage(db, { shop: shopId, limit: 50 });
  return {
    shop: { ...shop, medicine_count: medicines },
    members: (members.results || []).map(item => ({ ...item })),
    invitations: (invitations.results || []).map(item => ({ ...item, pending: !item.expires_at || item.expires_at > now() })),
    audit: audit.events
  };
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
