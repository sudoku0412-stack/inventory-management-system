import { readFileSync } from 'node:fs';

// The read-side of migration 0020 (deletion table and active_memberships view) without its
// audit rebuild, for fixtures that intentionally apply only an older subset of migrations.
const sql = readFileSync(new URL('../migrations/0020_shop_deletion.sql', import.meta.url), 'utf8');
export const deletionReadSchema = sql.slice(0, sql.indexOf('CREATE TABLE shop_deletion_receipts'));

// The outbox table (0024) for fixtures that create invitations but apply only older migrations.
export const outboxSchema = readFileSync(new URL('../migrations/0024_notification_outbox.sql', import.meta.url), 'utf8');
