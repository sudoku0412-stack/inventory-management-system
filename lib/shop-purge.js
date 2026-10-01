import { randomUUID } from 'node:crypto';
import { shopOverrides } from './feature-flags.js';

export const PURGED_SHOP_NAME = '(deleted Shop)';

/**
 * Permanently removes Shops whose grace period has ended. R2 is not transactional with D1, so photos
 * go first: a crash afterwards leaves rows without photos (harmless, retried), never photos without rows.
 * The households row stays as a tombstone so audit rows and receipts keep valid foreign keys.
 * `dryRun` is the global default (SHOP_PURGE_ENABLED off); a per-Shop `shop_purge` override wins either way:
 * off holds that Shop's data, on purges it even while the global default is a dry run.
 */
export async function purgeDeletedShops(db, photos, { now = () => new Date().toISOString(), limit = 5, dryRun = true, log = () => {} } = {}) {
  const due = await db.prepare(`SELECT household_id, deleted_by_user_id FROM household_deletions
    WHERE purged_at IS NULL AND purge_after <= ? ORDER BY purge_after, household_id LIMIT ?`).bind(now(), limit).all();
  const result = { due: (due.results || []).length, purged: 0, dryRun };
  for (const { household_id: id, deleted_by_user_id: actor } of due.results || []) {
    const overrides = await shopOverrides(db, id);
    const live = Object.hasOwn(overrides, 'shop_purge') ? overrides.shop_purge : !dryRun;
    if (!live) { log(`shop purge (${Object.hasOwn(overrides, 'shop_purge') ? 'held by staff' : 'dry run'}): would purge ${id}`); continue; }
    const rows = await db.prepare('SELECT photo_path FROM batches WHERE household_id=? AND photo_path IS NOT NULL').bind(id).all();
    let photosGone = true;
    for (const { photo_path } of rows.results || []) {
      // Deleting a missing object succeeds; a real failure leaves the rows so the next run retries.
      try { await photos.delete(photo_path); } catch { photosGone = false; break; }
    }
    if (!photosGone) { result.failed = (result.failed || 0) + 1; log(`shop purge: photo cleanup failed for ${id}; will retry`); continue; }
    const stamp = now();
    await db.batch([
      db.prepare('DELETE FROM batch_changes WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM mutation_receipts WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM batches WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM notifications WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM push_subscriptions WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM household_invitations WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM household_settings WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM user_shop_preferences WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM batch_barcodes WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM shop_options WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM shop_types WHERE household_id=?').bind(id),
      db.prepare('DELETE FROM memberships WHERE household_id=?').bind(id),
      db.prepare('UPDATE households SET name=? WHERE id=?').bind(PURGED_SHOP_NAME, id),
      db.prepare('UPDATE household_deletions SET purged_at=? WHERE household_id=? AND purged_at IS NULL').bind(stamp, id),
      db.prepare(`INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
        VALUES (?,'shop_purged',?,?,?,?,?)`).bind(randomUUID(), id, actor, `shop:${id}`, stamp, randomUUID())
    ]);
    result.purged += 1;
  }
  return result;
}

/** The guarded un-delete: only inside the grace period and never after a purge. Members regain exact access. */
export const restoreShopStatement = (db, householdId, at) =>
  db.prepare('DELETE FROM household_deletions WHERE household_id=? AND purged_at IS NULL AND purge_after > ?').bind(householdId, at);
