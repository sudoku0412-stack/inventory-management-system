-- Invitations may carry the Owner role. SQLite cannot widen a CHECK in place, so rebuild the table (no foreign keys point at it).
CREATE TABLE household_invitations_next (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member','owner')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(household_id, email)
);
INSERT INTO household_invitations_next (id,household_id,email,role,created_by_user_id,created_at,expires_at)
  SELECT id,household_id,email,role,created_by_user_id,created_at,expires_at FROM household_invitations;
DROP TABLE household_invitations;
ALTER TABLE household_invitations_next RENAME TO household_invitations;
CREATE INDEX household_invitations_household_id ON household_invitations(household_id);
CREATE INDEX household_invitations_email_expires_at ON household_invitations(email, expires_at);

-- The role granted at acceptance, so replays report it. Older receipts are Member joins.
ALTER TABLE household_invitation_acceptance_receipts ADD COLUMN role TEXT;
