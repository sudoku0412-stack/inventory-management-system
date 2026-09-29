-- Online pull feed for inventory. The Worker appends one row in the same D1
-- batch (transaction) as each inventory mutation. Deliberately not triggers:
-- D1 reports trigger-inserted rows in meta.changes, which would break the
-- store's exact changed-row checks. The log holds identifiers only; clients
-- read current batch state at request time.
CREATE TABLE batch_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL REFERENCES households(id),
  batch_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upsert','remove')),
  created_at TEXT NOT NULL
);
CREATE INDEX batch_changes_household_seq ON batch_changes(household_id, seq);
CREATE INDEX batch_changes_created_at ON batch_changes(created_at);

-- Highest sequence ever pruned. A client cursor below it may have missed
-- changes and must reload the full list.
CREATE TABLE batch_change_floor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  seq INTEGER NOT NULL
);
INSERT INTO batch_change_floor (id, seq) VALUES (1, 0);

-- The short-lived route throttle also serves the change feed. Its CHECK
-- constraint cannot be widened in place, and the table only holds one-minute
-- windows, so rebuilding it loses nothing that matters.
CREATE TABLE household_invitation_route_throttle_events_new (
  id TEXT PRIMARY KEY,
  principal_hash TEXT NOT NULL,
  route TEXT NOT NULL CHECK(route IN ('pending','accept','changes')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO household_invitation_route_throttle_events_new SELECT id, principal_hash, route, created_at, expires_at FROM household_invitation_route_throttle_events;
DROP TABLE household_invitation_route_throttle_events;
ALTER TABLE household_invitation_route_throttle_events_new RENAME TO household_invitation_route_throttle_events;
CREATE INDEX household_invitation_route_throttle_window ON household_invitation_route_throttle_events(principal_hash, route, created_at);
