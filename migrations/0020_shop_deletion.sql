-- Shop deletion: soft delete with a grace period, then an automated purge. The households row is kept as a tombstone.
-- Deletion state lives beside households (never in it) so existing readers and positional inserts stay valid.
CREATE TABLE household_deletions (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  deleted_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  deleted_by_user_id TEXT NOT NULL REFERENCES users(id),
  purged_at TEXT
);
CREATE INDEX household_deletions_purge ON household_deletions(purge_after) WHERE purged_at IS NULL;

-- Single point of truth for "memberships of Shops that still exist". Readers use this; writes keep using the table.
CREATE VIEW active_memberships AS
  SELECT m.* FROM memberships m WHERE NOT EXISTS (SELECT 1 FROM household_deletions d WHERE d.household_id=m.household_id);

CREATE TABLE shop_deletion_receipts (
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, actor_user_id, operation_id)
);

CREATE TRIGGER shop_deletion_receipt_guard
BEFORE INSERT ON shop_deletion_receipts
WHEN NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.actor_user_id AND role='owner')
  OR EXISTS (SELECT 1 FROM household_deletions WHERE household_id=NEW.household_id)
  OR NOT EXISTS (SELECT 1 FROM active_memberships WHERE user_id=NEW.actor_user_id AND household_id != NEW.household_id)
BEGIN
  SELECT RAISE(ABORT, 'shop deletion is no longer eligible');
END;

CREATE TABLE access_audit_next (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('bootstrap','invite_created','invite_accepted','invite_revoked','shop_created','member_promoted','member_removed','member_demoted','member_left','ownership_transferred','shop_deleted','shop_restored','shop_purged')),
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT REFERENCES users(id),
  target_identifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE TABLE _shop_deletion_audit_guard (expected_count INTEGER NOT NULL);
INSERT INTO _shop_deletion_audit_guard(expected_count) SELECT count(*) FROM access_audit;
INSERT INTO access_audit_next (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
  SELECT id,event,household_id,actor_user_id,target_identifier,created_at,request_id FROM access_audit;
CREATE TRIGGER _shop_deletion_audit_copy_guard
BEFORE DELETE ON access_audit
WHEN (SELECT count(*) FROM access_audit_next) != (SELECT expected_count FROM _shop_deletion_audit_guard)
BEGIN SELECT RAISE(ABORT, 'access_audit copy count mismatch'); END;
DELETE FROM access_audit;
DROP TABLE access_audit;
ALTER TABLE access_audit_next RENAME TO access_audit;
CREATE INDEX access_audit_household_created_at ON access_audit(household_id, created_at);
CREATE TRIGGER _shop_deletion_integrity_guard
BEFORE INSERT ON _shop_deletion_audit_guard
WHEN NEW.expected_count = -1
BEGIN SELECT RAISE(ABORT, 'foreign key integrity check failed'); END;
INSERT INTO _shop_deletion_audit_guard(expected_count)
  SELECT -1 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
DROP TRIGGER _shop_deletion_integrity_guard;
DROP TABLE _shop_deletion_audit_guard;
