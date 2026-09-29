-- Per-account switch for non-invitation email notices (Shop deletion, ownership transfer). No row means on.
CREATE TABLE user_email_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  notices_enabled INTEGER NOT NULL CHECK (notices_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
