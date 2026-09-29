-- Per-Shop feature flags managed by company staff. No row means "follow the global Worker secret".
CREATE TABLE shop_feature_flags (
  household_id TEXT NOT NULL REFERENCES households(id),
  flag TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (household_id, flag)
);

CREATE TABLE access_audit_next (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('bootstrap','invite_created','invite_accepted','invite_revoked','shop_created','member_promoted','member_removed','member_demoted','member_left','ownership_transferred','shop_deleted','shop_restored','shop_purged','shop_extended','shop_flag_changed')),
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT REFERENCES users(id),
  target_identifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE TABLE _shop_flags_audit_guard (expected_count INTEGER NOT NULL);
INSERT INTO _shop_flags_audit_guard(expected_count) SELECT count(*) FROM access_audit;
INSERT INTO access_audit_next (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
  SELECT id,event,household_id,actor_user_id,target_identifier,created_at,request_id FROM access_audit;
CREATE TRIGGER _shop_flags_audit_copy_guard
BEFORE DELETE ON access_audit
WHEN (SELECT count(*) FROM access_audit_next) != (SELECT expected_count FROM _shop_flags_audit_guard)
BEGIN SELECT RAISE(ABORT, 'access_audit copy count mismatch'); END;
DELETE FROM access_audit;
DROP TABLE access_audit;
ALTER TABLE access_audit_next RENAME TO access_audit;
CREATE INDEX access_audit_household_created_at ON access_audit(household_id, created_at);
CREATE TRIGGER _shop_flags_integrity_guard
BEFORE INSERT ON _shop_flags_audit_guard
WHEN NEW.expected_count = -1
BEGIN SELECT RAISE(ABORT, 'foreign key integrity check failed'); END;
INSERT INTO _shop_flags_audit_guard(expected_count)
  SELECT -1 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
DROP TRIGGER _shop_flags_integrity_guard;
DROP TABLE _shop_flags_audit_guard;
