import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (message, status) => Object.assign(new Error(message), { status });

function identityOf(principal) {
  if (!principal?.provider || !principal?.subject) throw failure('This account is not a member of a shop.', 403);
  return principal;
}

/**
 * Deleted Shops this account owns that can still be restored (inside their keep period, not purged).
 * Account-scoped and read from the memberships table itself, because deleted Shops are hidden from
 * every ordinary Shop lookup. Only Owners see a Shop here.
 */
export async function listDeletedShops(db, principal, now = () => new Date().toISOString()) {
  const { provider, subject } = identityOf(principal);
  const { results } = await db.prepare(`SELECT h.id, h.name, d.deleted_at, d.purge_after
    FROM identities i JOIN memberships m ON m.user_id=i.user_id
    JOIN households h ON h.id=m.household_id
    JOIN household_deletions d ON d.household_id=h.id
    WHERE i.provider=? AND i.subject=? AND m.role='owner' AND d.purged_at IS NULL AND d.purge_after > ?
    ORDER BY d.deleted_at DESC, h.id LIMIT 20`).bind(provider, subject, now()).all();
  return { shops: (results || []).map(row => ({ id: row.id, name: row.name, deleted_at: row.deleted_at, purge_after: row.purge_after })) };
}

export function validateOwnRestore(data = {}) {
  if (!data || typeof data !== 'object' || Object.keys(data).join(',') !== 'operationId') throw failure('Unexpected restore field.', 400);
  if (typeof data.operationId !== 'string' || !UUID.test(data.operationId)) throw failure('Enter a valid operation id.', 400);
  return data.operationId;
}

/**
 * An Owner restores their own deleted Shop inside its keep period. Members regain exact access; invitations and
 * push subscriptions removed at deletion are not restored. Idempotent by state: an already-active Shop the caller
 * owns answers restored:false. A non-owner, or an unknown Shop, is 404 so nothing is revealed.
 */
export async function restoreOwnDeletedShop(db, principal, shopId, data, requestId = randomUUID(), now = () => new Date().toISOString()) {
  const { provider, subject } = identityOf(principal);
  validateOwnRestore(data);
  if (!UUID.test(String(shopId))) throw failure('Shop not found.', 404);
  const owner = () => db.prepare(`SELECT i.user_id, h.name FROM identities i JOIN memberships m ON m.user_id=i.user_id
    JOIN households h ON h.id=m.household_id
    WHERE i.provider=? AND i.subject=? AND m.household_id=? AND m.role='owner' LIMIT 1`).bind(provider, subject, shopId).first();
  const actor = await owner();
  if (!actor) throw failure('Shop not found.', 404);
  const state = await db.prepare('SELECT purge_after, purged_at FROM household_deletions WHERE household_id=?').bind(shopId).first();
  if (!state) return { restored: false, shop: { id: shopId, name: actor.name } };
  if (state.purged_at || state.purge_after <= now()) throw failure('The keep period has ended; this Shop can no longer be restored.', 409);
  const owned = await db.prepare("SELECT count(*) AS n FROM active_memberships WHERE user_id=? AND role='owner'").bind(actor.user_id).first();
  if (Number(owned?.n) >= 5) throw failure('You can own up to 5 Shops. Delete or leave one first.', 409);
  const stamp = now();
  const result = await db.batch([
    db.prepare(`DELETE FROM household_deletions WHERE household_id=? AND purged_at IS NULL AND purge_after > ?
      AND EXISTS (SELECT 1 FROM identities i JOIN memberships m ON m.user_id=i.user_id WHERE i.provider=? AND i.subject=? AND m.household_id=? AND m.role='owner')`)
      .bind(shopId, stamp, provider, subject, shopId),
    db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) SELECT ?,'shop_restored',?,?,?,?,? WHERE changes()=1")
      .bind(randomUUID(), shopId, actor.user_id, `shop:${shopId}`, stamp, requestId)
  ]);
  if (result[0]?.meta?.changes) return { restored: true, shop: { id: shopId, name: actor.name } };
  // Lost a race: it was restored, purged or expired, or ownership changed, between the preflight and the batch.
  if (!await owner()) throw failure('Shop not found.', 404);
  const after = await db.prepare('SELECT purge_after, purged_at FROM household_deletions WHERE household_id=?').bind(shopId).first();
  if (!after) return { restored: false, shop: { id: shopId, name: actor.name } };
  throw failure('The keep period has ended; this Shop can no longer be restored.', 409);
}
