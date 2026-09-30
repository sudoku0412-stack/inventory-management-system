-- Barcodes a Shop has already used, with the details it saved, so the next scan of the same code fills the form.
CREATE TABLE batch_barcodes (
  household_id TEXT NOT NULL REFERENCES households(id),
  barcode TEXT NOT NULL,
  name TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT '',
  form TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (household_id, barcode)
);
