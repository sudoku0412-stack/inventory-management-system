import { randomUUID } from 'node:crypto';

function forbidden(message = 'This account is not a member of a shop.') { return Object.assign(new Error(message), { status: 403 }); }
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }
function limited(message, retryAfter) { return Object.assign(new Error(message), { status: 429, retryAfter }); }

export function bootstrapEmails(env = {}) {
  return new Set(String(env.INITIAL_OWNER_EMAILS || '').split(',').map(value => value.normalize('NFKC').trim().toLowerCase()).filter(value => value && value.includes('@')));
}

function verifiedPrincipal(principal) {
  if (!principal?.provider || !principal?.subject || !principal?.email) throw forbidden();
  return { ...principal, email: principal.email.normalize('NFKC').trim().toLowerCase() };
}

/** Resolves only a current membership; an explicit valid selector updates its advisory preference. */
export async function resolveTenant(db, principal, { shopId: selectedShopId = null } = {}) {
  const identity = verifiedPrincipal(principal);
  const memberFor = householdId => db.prepare(`SELECT i.user_id, m.household_id, m.role
    FROM identities i JOIN active_memberships m ON m.user_id=i.user_id
    WHERE i.provider=? AND i.subject=? AND m.household_id=? LIMIT 1`).bind(identity.provider, identity.subject, householdId).first();
  let member;
  if (selectedShopId !== null && selectedShopId !== undefined) {
    if (typeof selectedShopId !== 'string' || !selectedShopId.trim()) throw invalid('Select a valid Shop.');
    member = await memberFor(selectedShopId);
    if (!member) throw forbidden('This account is not a member of the selected Shop.');
    await db.prepare(`INSERT INTO user_shop_preferences (user_id,household_id,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET household_id=excluded.household_id,updated_at=excluded.updated_at`)
      .bind(member.user_id, member.household_id, new Date().toISOString()).run();
  } else {
    member = await db.prepare(`SELECT i.user_id, m.household_id, m.role
      FROM identities i JOIN user_shop_preferences p ON p.user_id=i.user_id
      JOIN active_memberships m ON m.user_id=p.user_id AND m.household_id=p.household_id
      WHERE i.provider=? AND i.subject=? LIMIT 1`).bind(identity.provider, identity.subject).first();
    if (!member) {
      member = await db.prepare(`SELECT i.user_id, m.household_id, m.role
        FROM identities i JOIN active_memberships m ON m.user_id=i.user_id
        JOIN households h ON h.id=m.household_id
        WHERE i.provider=? AND i.subject=?
        ORDER BY LOWER(h.name), h.id LIMIT 1`).bind(identity.provider, identity.subject).first();
    }
  }
  if (!member) throw forbidden();
  return { userId: member.user_id, householdId: member.household_id, role: member.role };
}

/** A mandatory, pinned membership lookup which intentionally does not persist a preference. */
export async function pinnedTenant(db, principal, shopId) {
  const identity = verifiedPrincipal(principal);
  if (typeof shopId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(shopId)) throw invalid('Select a valid Shop.');
  const member = await db.prepare(`SELECT i.user_id,m.household_id,m.role FROM identities i JOIN active_memberships m ON m.user_id=i.user_id
    WHERE i.provider=? AND i.subject=? AND m.household_id=? LIMIT 1`).bind(identity.provider, identity.subject, shopId).first();
  if (!member) throw forbidden('This account is not a member of the selected Shop.');
  return { userId: member.user_id, householdId: member.household_id, role: member.role };
}

/** Returns only the authenticated caller's memberships; no roster data. */
export async function listShops(db, principal) {
  const identity = verifiedPrincipal(principal);
  const rows = await db.prepare(`SELECT h.id,h.name,m.role
    FROM identities i JOIN active_memberships m ON m.user_id=i.user_id
    JOIN households h ON h.id=m.household_id
    WHERE i.provider=? AND i.subject=? ORDER BY LOWER(h.name), h.id`)
    .bind(identity.provider, identity.subject).all();
  return (rows.results || []).map(shop => ({ id: shop.id, name: shop.name, role: shop.role }));
}

/** The opaque internal account key is context only, never client authority. */
export async function shopContext(db, principal) {
  const identity = verifiedPrincipal(principal);
  const user = await db.prepare(`SELECT i.user_id FROM identities i
    JOIN active_memberships m ON m.user_id=i.user_id
    WHERE i.provider=? AND i.subject=? LIMIT 1`).bind(identity.provider, identity.subject).first();
  if (!user?.user_id) throw forbidden();
  return { accountContextKey: user.user_id, shops: await listShops(db, principal) };
}

function creationValues(data = {}) {
  const keys = Object.keys(data);
  if (keys.some(key => !['operationId', 'shopName', 'displayName', 'shopType'].includes(key))) throw invalid('Unexpected Shop creation field.');
  const operationId = typeof data.operationId === 'string' ? data.operationId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw invalid('Enter a valid operation id.');
  const shopName = typeof data.shopName === 'string' ? data.shopName.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  const displayName = typeof data.displayName === 'string' ? data.displayName.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (!shopName || shopName.length > 80) throw invalid('Enter a Shop name up to 80 characters.');
  if (!displayName || displayName.length > 60) throw invalid('Enter a display name up to 60 characters.');
  const shopType = data.shopType === undefined ? 'medicine' : data.shopType;
  if (shopType !== 'medicine' && shopType !== 'goods') throw invalid('Choose a valid Shop type.');
  return { operationId, shopName, displayName, shopType };
}

async function creationUser(db, identity) {
  const user = await db.prepare(`SELECT i.user_id FROM identities i
    WHERE i.provider=? AND i.subject=? AND EXISTS (SELECT 1 FROM active_memberships m WHERE m.user_id=i.user_id)
    LIMIT 1`).bind(identity.provider, identity.subject).first();
  return user?.user_id || null;
}

async function receiptResult(db, userId, values) {
  const receipt = await db.prepare(`SELECT r.shop_name,r.display_name,r.household_id
    FROM shop_creation_receipts r WHERE r.user_id=? AND r.operation_id=?`).bind(userId, values.operationId).first();
  if (!receipt) return null;
  if (receipt.shop_name !== values.shopName || receipt.display_name !== values.displayName) throw conflict('This operation id was already used for a different Shop creation request.');
  const membership = await db.prepare("SELECT 1 FROM active_memberships WHERE household_id=? AND user_id=? AND role='owner' LIMIT 1").bind(receipt.household_id, userId).first();
  if (!membership) throw forbidden();
  return { shop: { id: receipt.household_id, name: receipt.shop_name, role: 'owner' }, created: false };
}

/** Create an isolated owner Shop. This intentionally never resolves a tenant or preference. */
export async function createAdditionalShop(db, principal, data, { requestId = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const identity = verifiedPrincipal(principal);
  const values = creationValues(data);
  const userId = await creationUser(db, identity);
  if (!userId) throw forbidden();
  const replay = await receiptResult(db, userId, values);
  if (replay) return replay;
  const householdId = randomUUID(), stamp = now();
  // The guarded first write serializes both quotas under D1's batch transaction.
  const eligibleHousehold = db.prepare(`INSERT INTO households (id,name,created_at)
    SELECT ?,?,? WHERE EXISTS (
      SELECT 1 FROM identities i JOIN active_memberships m ON m.user_id=i.user_id
      WHERE i.provider=? AND i.subject=? AND i.user_id=?
    ) AND NOT EXISTS (SELECT 1 FROM shop_creation_receipts WHERE user_id=? AND operation_id=?)
      AND (SELECT count(*) FROM active_memberships WHERE user_id=? AND role='owner') < 5
      AND (SELECT count(*) FROM active_memberships WHERE user_id=?) < 50
      AND (SELECT count(*) FROM shop_creation_receipts WHERE user_id=? AND created_at > ?) < 1`)
    .bind(householdId, values.shopName, stamp, identity.provider, identity.subject, userId, userId, values.operationId, userId, userId, userId, new Date(Date.parse(stamp) - 24 * 60 * 60 * 1000).toISOString());
  try {
    const results = await db.batch([
      eligibleHousehold,
      db.prepare("INSERT INTO memberships (household_id,user_id,role,created_at) SELECT ?,?,'owner',? WHERE EXISTS (SELECT 1 FROM households WHERE id=? AND name=?)").bind(householdId, userId, stamp, householdId, values.shopName),
      db.prepare("INSERT INTO household_settings (household_id,display_name,household_name,default_storage_location,updated_at,display_name_source) SELECT ?,?,?,?,?,'user' WHERE EXISTS (SELECT 1 FROM households WHERE id=?)").bind(householdId, values.displayName, values.shopName, values.shopType === 'goods' ? 'Shelf' : 'Medicine cabinet', stamp, householdId),
      ...(values.shopType === 'goods' ? [db.prepare("INSERT INTO shop_types (household_id,shop_type) SELECT ?,'goods' WHERE EXISTS (SELECT 1 FROM households WHERE id=?)").bind(householdId, householdId)] : []),
      db.prepare('INSERT INTO shop_creation_receipts (user_id,operation_id,shop_name,display_name,household_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM households WHERE id=?)').bind(userId, values.operationId, values.shopName, values.displayName, householdId, stamp, householdId),
      db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) SELECT ?,'shop_created',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM households WHERE id=?)").bind(randomUUID(), householdId, userId, `${identity.provider}:${identity.subject}`, stamp, requestId, householdId)
    ]);
    if (results[0]?.meta?.changes) return { shop: { id: householdId, name: values.shopName, role: 'owner' }, created: true };
  } catch (error) {
    // A concurrent same-operation request loses its entire batch, then sees the receipt.
    if (!/unique|constraint|primary key/i.test(String(error?.message || ''))) throw error;
  }
  const winning = await receiptResult(db, userId, values);
  if (winning) return winning;
  const current = await creationUser(db, identity);
  if (!current) throw forbidden();
  const owned = await db.prepare("SELECT count(*) AS count FROM active_memberships WHERE user_id=? AND role='owner'").bind(userId).first();
  if (Number(owned?.count) >= 5) throw conflict('You can own up to 5 Shops.');
  const memberships = await db.prepare('SELECT count(*) AS count FROM active_memberships WHERE user_id=?').bind(userId).first();
  if (Number(memberships?.count) >= 50) throw conflict('You can belong to up to 50 Shops.');
  const recent = await db.prepare('SELECT created_at FROM shop_creation_receipts WHERE user_id=? ORDER BY created_at DESC LIMIT 1').bind(userId).first();
  if (recent) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(recent.created_at) + 24 * 60 * 60 * 1000 - Date.now()) / 1000));
    throw limited('You can create one Shop every 24 hours. Try again later.', retryAfter);
  }
  throw forbidden();
}

/** Safe before membership resolution: never returns the configured email allowlist. */
export async function onboardingStatus(db, principal, env) {
  const identity = verifiedPrincipal(principal);
  const member = await db.prepare(`SELECT m.household_id, m.role FROM identities i JOIN active_memberships m ON m.user_id=i.user_id WHERE i.provider=? AND i.subject=? LIMIT 1`).bind(identity.provider, identity.subject).first();
  const pending = await db.prepare('SELECT 1 FROM household_invitations WHERE email=? AND expires_at > ? LIMIT 1').bind(identity.email, new Date().toISOString()).first();
  if (member) return { membership: { role: member.role }, pendingInvitation: Boolean(pending), setupEligible: false };
  const bootstrap = await db.prepare('SELECT 1 FROM tenant_bootstrap WHERE singleton=1').first();
  return { membership: null, pendingInvitation: Boolean(pending), setupEligible: !bootstrap && bootstrapEmails(env).has(identity.email) };
}

function setupValues(data = {}) {
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim().replace(/\s+/g, ' ') : '';
  const shopName = typeof data.shopName === 'string' ? data.shopName.trim().replace(/\s+/g, ' ') : '';
  if (!displayName || displayName.length > 60) throw invalid('Enter a display name up to 60 characters.');
  if (!shopName || shopName.length > 80) throw invalid('Enter a Shop name up to 80 characters.');
  return { displayName, shopName };
}

async function resolveExisting(db, identity) {
  const member = await db.prepare(`SELECT i.user_id, m.household_id, m.role FROM identities i JOIN active_memberships m ON m.user_id=i.user_id WHERE i.provider=? AND i.subject=? LIMIT 1`).bind(identity.provider, identity.subject).first();
  return member && { userId: member.user_id, householdId: member.household_id, role: member.role };
}

/** Explicit, atomic, idempotent ownership claim. The bootstrap singleton is the write lock. */
export async function setupInitialShop(db, principal, env, data, { requestId = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const identity = verifiedPrincipal(principal);
  const existing = await resolveExisting(db, identity);
  if (existing) return { ...existing, created: false };
  const bootstrap = await db.prepare('SELECT household_id FROM tenant_bootstrap WHERE singleton=1').first();
  if (bootstrap) throw forbidden('Shop setup is no longer available.');
  if (!bootstrapEmails(env).has(identity.email)) throw forbidden('Shop setup is not available for this account.');
  const { displayName, shopName } = setupValues(data);
  const userId = randomUUID(), householdId = randomUUID(), stamp = now();
  try {
    await db.batch([
      db.prepare('INSERT INTO users (id,created_at) VALUES (?,?)').bind(userId, stamp),
      db.prepare('INSERT INTO identities (provider,subject,user_id,email,created_at) VALUES (?,?,?,?,?)').bind(identity.provider, identity.subject, userId, identity.email, stamp),
      db.prepare('INSERT INTO households (id,name,created_at) VALUES (?,?,?)').bind(householdId, shopName, stamp),
      db.prepare('INSERT INTO tenant_bootstrap (singleton,household_id,owner_user_id,created_at) VALUES (1,?,?,?)').bind(householdId, userId, stamp),
      db.prepare("INSERT INTO memberships (household_id,user_id,role,created_at) VALUES (?,?,'owner',?)").bind(householdId, userId, stamp),
      db.prepare('UPDATE batches SET household_id=? WHERE household_id IS NULL').bind(householdId),
      db.prepare('UPDATE notifications SET household_id=? WHERE household_id IS NULL').bind(householdId),
      db.prepare('UPDATE push_subscriptions SET household_id=?,user_id=? WHERE household_id IS NULL').bind(householdId, userId),
      db.prepare("INSERT INTO household_settings (household_id,display_name,household_name,default_storage_location,updated_at,display_name_source) VALUES (?,?,?,'Medicine cabinet',?,'user')").bind(householdId, displayName, shopName, stamp),
      db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) VALUES (?,'bootstrap',?,?,?,?,?)").bind(randomUUID(), householdId, userId, `${identity.provider}:${identity.subject}`, stamp, requestId)
    ]);
  } catch (error) {
    if (/unique|constraint|primary key/i.test(String(error?.message || ''))) {
      const claimed = await resolveExisting(db, identity);
      if (claimed) return { ...claimed, created: false };
      throw forbidden('Shop setup is already complete.');
    }
    throw error;
  }
  return { userId, householdId, role: 'owner', created: true };
}
