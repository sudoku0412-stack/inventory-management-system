-- Audited admin write actions: a required reason and an idempotency key on admin_audit.
ALTER TABLE admin_audit ADD COLUMN reason TEXT;
ALTER TABLE admin_audit ADD COLUMN operation_id TEXT;
-- The unique key is the receipt: the same admin and operation id can only ever commit once.
CREATE UNIQUE INDEX admin_audit_operation ON admin_audit(admin_email, operation_id) WHERE operation_id IS NOT NULL;
