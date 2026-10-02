-- Stock history: one row each time an item's quantity changes (added, used, adjusted by editing, discarded).
-- The item's name and unit are copied in so the history still reads correctly after a rename.
-- Written in the same D1 batch as the change itself (WHERE changes()=1, like batch_changes), never by triggers.
CREATE TABLE stock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL REFERENCES households(id),
  batch_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added','used','adjusted','discarded')),
  change INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX stock_events_household ON stock_events (household_id, id);
CREATE INDEX stock_events_batch ON stock_events (household_id, batch_id, id);
