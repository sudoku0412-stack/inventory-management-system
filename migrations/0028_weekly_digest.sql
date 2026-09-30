-- Weekly digest: a new outbox kind with a JSON payload of counts, and a per-account switch (default on).
-- SQLite cannot widen a CHECK in place, so rebuild the outbox.
CREATE TABLE notification_outbox_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invitation_created','shop_deleted','ownership_transferred','weekly_digest')),
  dedupe_key TEXT NOT NULL UNIQUE,
  recipient_email TEXT NOT NULL,
  household_id TEXT NOT NULL,
  invitation_id TEXT,
  role TEXT,
  deadline TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','cancelled','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
INSERT INTO notification_outbox_next (id,kind,dedupe_key,recipient_email,household_id,invitation_id,role,deadline,status,attempts,next_attempt_at,lease_until,last_error,created_at,sent_at)
  SELECT id,kind,dedupe_key,recipient_email,household_id,invitation_id,role,deadline,status,attempts,next_attempt_at,lease_until,last_error,created_at,sent_at FROM notification_outbox;
DROP TABLE notification_outbox;
ALTER TABLE notification_outbox_next RENAME TO notification_outbox;
CREATE INDEX notification_outbox_due ON notification_outbox(status, next_attempt_at);

ALTER TABLE user_email_preferences ADD COLUMN digest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (digest_enabled IN (0,1));
