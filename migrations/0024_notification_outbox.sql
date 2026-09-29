-- Transactional email outbox: one row per recipient, written in the same batch as the business mutation.
-- No foreign keys on purpose: invitations are deleted on accept/revoke and Shops are purged; the dispatcher cancels stale rows.
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invitation_created')),
  dedupe_key TEXT NOT NULL UNIQUE,
  recipient_email TEXT NOT NULL,
  household_id TEXT NOT NULL,
  invitation_id TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','cancelled','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX notification_outbox_due ON notification_outbox(status, next_attempt_at);
