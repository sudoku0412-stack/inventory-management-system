-- Custom Shop types. An Owner defines a named type (starting lists, whether Strength shows, how Form is labelled)
-- and uses it for any of their own Shops. Built-in types stay as they are.
-- shop_types keeps the BASE type ('medicine' or 'goods') for every Shop, so older code paths and rows still work;
-- custom_type_id, when set, points at the custom type that overrides the lists and labels.
CREATE TABLE custom_shop_types (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  base_type TEXT NOT NULL CHECK (base_type IN ('medicine','goods')),
  uses_strength INTEGER NOT NULL DEFAULT 1 CHECK (uses_strength IN (0,1)),
  form_label TEXT NOT NULL DEFAULT 'Form' CHECK (form_label IN ('Form','Category')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX custom_shop_types_owner_name ON custom_shop_types (owner_user_id, name COLLATE NOCASE);

CREATE TABLE custom_type_options (
  type_id TEXT NOT NULL REFERENCES custom_shop_types(id),
  list TEXT NOT NULL CHECK (list IN ('form','unit','location','strength')),
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (type_id, list, value)
);

ALTER TABLE shop_types ADD COLUMN custom_type_id TEXT REFERENCES custom_shop_types(id);
