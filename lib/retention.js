export const DEFAULT_RECEIPT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 30;
const ROWS_PER_TABLE_PER_RUN = 500;

// Idempotency receipts only need to outlive a client's retry window. Audit history (access_audit, admin_audit) and the
// deletion tombstones are never pruned. Mutation receipts and the change feed are pruned separately (30 days).
export const RECEIPT_TABLES = Object.freeze([
  ['shop_creation_receipts', 'created_at'],
  ['shop_owner_promotion_receipts', 'created_at'],
  ['shop_owner_demotion_receipts', 'created_at'],
  ['shop_member_removal_receipts', 'created_at'],
  ['shop_member_leave_receipts', 'created_at'],
  ['shop_ownership_transfer_receipts', 'created_at'],
  ['shop_deletion_receipts', 'created_at'],
  ['household_invitation_acceptance_receipts', 'accepted_at']
]);

/** Days from the optional RECEIPT_RETENTION_DAYS setting; anything invalid or under 30 falls back to the default. */
export function retentionDays(env = {}) {
  const value = Number(env.RECEIPT_RETENTION_DAYS);
  return Number.isInteger(value) && value >= MIN_RETENTION_DAYS ? value : DEFAULT_RECEIPT_RETENTION_DAYS;
}

/**
 * Deletes receipts older than the retention period, a bounded page per table per run so the 15-minute cron stays
 * cheap. A missing table (older database) or a failing table never stops the others. Returns rows deleted per table.
 */
export async function pruneReceipts(db, { now = () => new Date(), days = DEFAULT_RECEIPT_RETENTION_DAYS, limit = ROWS_PER_TABLE_PER_RUN } = {}) {
  const cutoff = new Date(now().getTime() - Math.max(days, MIN_RETENTION_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const deleted = {};
  for (const [table, column] of RECEIPT_TABLES) {
    try {
      const result = await db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? ORDER BY ${column} LIMIT ?)`).bind(cutoff, limit).run();
      const changes = Number(result?.meta?.changes ?? 0);
      if (changes) deleted[table] = changes;
    } catch { /* absent or failing: leave it for the next run */ }
  }
  return deleted;
}
