-- A Shop-wide default for the low-stock alert, used when an item is added without its own number.
ALTER TABLE household_settings ADD COLUMN default_low_stock_threshold INTEGER NOT NULL DEFAULT 4
  CHECK (default_low_stock_threshold >= 0 AND default_low_stock_threshold <= 1000000);
