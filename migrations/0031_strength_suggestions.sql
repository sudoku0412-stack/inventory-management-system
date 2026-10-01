-- Per-Shop Strength suggestions. The Strength field stays free text; the list only feeds suggestions.
-- The list name is limited by a CHECK, so both tables are rebuilt to allow 'strength'.
-- Existing rows are copied unchanged.
CREATE TABLE option_defaults_new (
  shop_type TEXT NOT NULL CHECK (shop_type IN ('medicine','goods')),
  list TEXT NOT NULL CHECK (list IN ('form','unit','location','strength')),
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (shop_type, list, value)
);
INSERT INTO option_defaults_new (shop_type,list,value,sort_order) SELECT shop_type,list,value,sort_order FROM option_defaults;
DROP TABLE option_defaults;
ALTER TABLE option_defaults_new RENAME TO option_defaults;

CREATE TABLE shop_options_new (
  household_id TEXT NOT NULL REFERENCES households(id),
  list TEXT NOT NULL CHECK (list IN ('form','unit','location','strength')),
  value TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, list, value)
);
INSERT INTO shop_options_new (household_id,list,value,hidden,is_custom,created_at) SELECT household_id,list,value,hidden,is_custom,created_at FROM shop_options;
DROP TABLE shop_options;
ALTER TABLE shop_options_new RENAME TO shop_options;

INSERT INTO option_defaults (shop_type,list,value,sort_order) VALUES
  ('medicine','strength','100 mg',1),('medicine','strength','200 mg',2),('medicine','strength','250 mg',3),
  ('medicine','strength','500 mg',4),('medicine','strength','1000 mg',5),('medicine','strength','5 mg/5 mL',6);
