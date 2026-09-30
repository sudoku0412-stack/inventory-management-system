-- Configurable Add-item lists and Shop type. Platform defaults are managed in the admin console;
-- each Shop can add its own options or hide defaults without affecting other Shops.
-- No row means a medicine Shop, so every existing Shop is unchanged.
CREATE TABLE shop_types (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  shop_type TEXT NOT NULL CHECK (shop_type IN ('medicine','goods'))
);

CREATE TABLE option_defaults (
  shop_type TEXT NOT NULL CHECK (shop_type IN ('medicine','goods')),
  list TEXT NOT NULL CHECK (list IN ('form','unit','location')),
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (shop_type, list, value)
);

CREATE TABLE shop_options (
  household_id TEXT NOT NULL REFERENCES households(id),
  list TEXT NOT NULL CHECK (list IN ('form','unit','location')),
  value TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, list, value)
);

INSERT INTO option_defaults (shop_type,list,value,sort_order) VALUES
  ('medicine','form','Tablets',1),('medicine','form','Capsules',2),('medicine','form','Liquid',3),('medicine','form','Cream',4),
  ('medicine','form','Inhaler',5),('medicine','form','Drops',6),('medicine','form','Syrup',7),('medicine','form','Other',8),
  ('medicine','unit','bottle',1),('medicine','unit','sachet',2),('medicine','unit','tube',3),('medicine','unit','pack',4),
  ('medicine','unit','tablet',5),('medicine','unit','capsule',6),('medicine','unit','dose',7),('medicine','unit','piece',8),
  ('medicine','location','Medicine cabinet',1),('medicine','location','Bathroom cabinet',2),('medicine','location','Kitchen drawer',3),
  ('medicine','location','Refrigerator',4),('medicine','location','First aid kit',5),
  ('goods','form','General',1),('goods','form','Food & drink',2),('goods','form','Cleaning',3),('goods','form','Tools',4),
  ('goods','form','Office',5),('goods','form','Other',6),
  ('goods','unit','piece',1),('goods','unit','box',2),('goods','unit','pack',3),('goods','unit','bottle',4),('goods','unit','kg',5),('goods','unit','litre',6),
  ('goods','location','Shelf',1),('goods','location','Storeroom',2),('goods','location','Refrigerator',3),('goods','location','Freezer',4),('goods','location','Counter',5);
