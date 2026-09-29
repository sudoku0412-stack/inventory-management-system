-- Member-removal retries are scoped to the pinned Shop and acting owner.
CREATE TABLE shop_member_removal_receipts (
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, actor_user_id, operation_id)
);
CREATE INDEX shop_member_removal_receipts_target ON shop_member_removal_receipts(household_id, target_user_id);

-- A receipt can only exist for a currently authorized Owner removing a
-- currently plain Member. RAISE(ABORT) rolls the whole D1 batch back.
CREATE TRIGGER shop_member_removal_receipt_guard
BEFORE INSERT ON shop_member_removal_receipts
WHEN NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.actor_user_id AND role='owner')
  OR NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=NEW.household_id AND user_id=NEW.target_user_id AND role='member')
BEGIN
  SELECT RAISE(ABORT, 'member removal is no longer eligible');
END;

CREATE TABLE access_audit_next (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('bootstrap','invite_created','invite_accepted','invite_revoked','shop_created','member_promoted','member_removed')),
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_user_id TEXT REFERENCES users(id),
  target_identifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE TABLE _shop_member_removal_audit_guard (expected_count INTEGER NOT NULL);
INSERT INTO _shop_member_removal_audit_guard(expected_count) SELECT count(*) FROM access_audit;
INSERT INTO access_audit_next (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
  SELECT id,event,household_id,actor_user_id,target_identifier,created_at,request_id FROM access_audit;
CREATE TRIGGER _shop_member_removal_audit_copy_guard
BEFORE DELETE ON access_audit
WHEN (SELECT count(*) FROM access_audit_next) != (SELECT expected_count FROM _shop_member_removal_audit_guard)
BEGIN SELECT RAISE(ABORT, 'access_audit copy count mismatch'); END;
DELETE FROM access_audit;
DROP TABLE access_audit;
ALTER TABLE access_audit_next RENAME TO access_audit;
CREATE INDEX access_audit_household_created_at ON access_audit(household_id, created_at);
CREATE TRIGGER _shop_member_removal_integrity_guard
BEFORE INSERT ON _shop_member_removal_audit_guard
WHEN NEW.expected_count = -1
BEGIN SELECT RAISE(ABORT, 'foreign key integrity check failed'); END;
INSERT INTO _shop_member_removal_audit_guard(expected_count)
  SELECT -1 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
DROP TRIGGER _shop_member_removal_integrity_guard;
DROP TABLE _shop_member_removal_audit_guard;
