-- Owner demotion and leaving a Shop. Both are guarded so a Shop always keeps an owner.
CREATE TABLE shop_owner_demotion_receipts (
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, actor_user_id, operation_id)
);
CREATE INDEX shop_owner_demotion_receipts_target ON shop_owner_demotion_receipts(household_id, target_user_id);

CREATE TRIGGER shop_owner_demotion_receipt_guard
BEFORE INSERT ON shop_owner_demotion_receipts
WHEN NEW.actor_user_id = NEW.target_user_id
  OR NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.actor_user_id AND role='owner')
  OR NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.target_user_id AND role='owner')
  OR (SELECT count(*) FROM memberships WHERE household_id=NEW.household_id AND role='owner') < 2
BEGIN
  SELECT RAISE(ABORT, 'owner demotion is no longer eligible');
END;

CREATE TABLE shop_member_leave_receipts (
  household_id TEXT NOT NULL REFERENCES households(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id, operation_id)
);

CREATE TRIGGER shop_member_leave_receipt_guard
BEFORE INSERT ON shop_member_leave_receipts
WHEN NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.user_id)
  OR (SELECT role FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.user_id) = 'owner'
     AND (SELECT count(*) FROM memberships WHERE household_id=NEW.household_id AND role='owner') < 2
BEGIN
  SELECT RAISE(ABORT, 'leaving is no longer eligible');
END;

CREATE TABLE access_audit_next (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('bootstrap','invite_created','invite_accepted','invite_revoked','shop_created','member_promoted','member_removed','member_demoted','member_left')),
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT REFERENCES users(id),
  target_identifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE TABLE _shop_demotion_leave_audit_guard (expected_count INTEGER NOT NULL);
INSERT INTO _shop_demotion_leave_audit_guard(expected_count) SELECT count(*) FROM access_audit;
INSERT INTO access_audit_next (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
  SELECT id,event,household_id,actor_user_id,target_identifier,created_at,request_id FROM access_audit;
CREATE TRIGGER _shop_demotion_leave_audit_copy_guard
BEFORE DELETE ON access_audit
WHEN (SELECT count(*) FROM access_audit_next) != (SELECT expected_count FROM _shop_demotion_leave_audit_guard)
BEGIN SELECT RAISE(ABORT, 'access_audit copy count mismatch'); END;
DELETE FROM access_audit;
DROP TABLE access_audit;
ALTER TABLE access_audit_next RENAME TO access_audit;
CREATE INDEX access_audit_household_created_at ON access_audit(household_id, created_at);
CREATE TRIGGER _shop_demotion_leave_integrity_guard
BEFORE INSERT ON _shop_demotion_leave_audit_guard
WHEN NEW.expected_count = -1
BEGIN SELECT RAISE(ABORT, 'foreign key integrity check failed'); END;
INSERT INTO _shop_demotion_leave_audit_guard(expected_count)
  SELECT -1 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
DROP TRIGGER _shop_demotion_leave_integrity_guard;
DROP TABLE _shop_demotion_leave_audit_guard;
