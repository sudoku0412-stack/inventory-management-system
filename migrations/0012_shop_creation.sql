-- Account-scoped receipts make creation retries safe even though the new Shop
-- does not exist before the mutation begins.
CREATE TABLE shop_creation_receipts (
  user_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX shop_creation_receipts_user_created_at ON shop_creation_receipts(user_id, created_at);

-- 0010 is already deployed: rebuild rather than altering its CHECK constraint.
-- The migration runner applies this file as one transaction, so copied rows are
-- preserved or the original table remains intact.
CREATE TABLE access_audit_next (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('bootstrap','invite_created','invite_accepted','invite_revoked','shop_created')),
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT REFERENCES users(id),
  target_identifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL
);
-- Keep the expected count in a short-lived table, then make deletion abort if
-- the copy is incomplete. RAISE(ABORT) is deliberately used rather than a
-- result-only PRAGMA so a bad migration cannot be recorded as applied.
CREATE TABLE _shop_creation_audit_guard (expected_count INTEGER NOT NULL);
INSERT INTO _shop_creation_audit_guard(expected_count) SELECT count(*) FROM access_audit;
INSERT INTO access_audit_next (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
  SELECT id,event,household_id,actor_user_id,target_identifier,created_at,request_id FROM access_audit;
CREATE TRIGGER _shop_creation_audit_copy_guard
BEFORE DELETE ON access_audit
WHEN (SELECT count(*) FROM access_audit_next) != (SELECT expected_count FROM _shop_creation_audit_guard)
BEGIN
  SELECT RAISE(ABORT, 'access_audit copy count mismatch');
END;
DELETE FROM access_audit;
DROP TABLE access_audit;
ALTER TABLE access_audit_next RENAME TO access_audit;
CREATE INDEX access_audit_household_created_at ON access_audit(household_id, created_at);
-- A table-valued pragma turns foreign-key-check output into an aborting guard.
CREATE TRIGGER _shop_creation_integrity_guard
BEFORE INSERT ON _shop_creation_audit_guard
WHEN NEW.expected_count = -1
BEGIN
  SELECT RAISE(ABORT, 'foreign key integrity check failed');
END;
INSERT INTO _shop_creation_audit_guard(expected_count)
  SELECT -1 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
DROP TRIGGER _shop_creation_integrity_guard;
DROP TABLE _shop_creation_audit_guard;
