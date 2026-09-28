-- Durable receipts distinguish a completed acceptance from a subsequently
-- consumed, expired, or revoked invitation.  They are deliberately scoped to
-- the invitation and internal account, never to an email-only identity.
CREATE TABLE household_invitation_acceptance_receipts (
  invitation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  invitation_email TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (invitation_id, user_id)
);
CREATE INDEX household_invitation_acceptance_receipts_user ON household_invitation_acceptance_receipts(user_id, accepted_at);

-- Short-lived, hashed-principal route events provide a durable rolling window
-- without storing emails, JWT subjects, or source IP addresses in plaintext.
CREATE TABLE household_invitation_route_throttle_events (
  id TEXT PRIMARY KEY,
  principal_hash TEXT NOT NULL,
  route TEXT NOT NULL CHECK(route IN ('pending','accept')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX household_invitation_route_throttle_window ON household_invitation_route_throttle_events(principal_hash, route, created_at);
