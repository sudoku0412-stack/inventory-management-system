-- An Owner can now word the Form field however they like (Type, Kind, Group, ...), not just Form or Category.
-- form_label keeps its Form/Category check for older code; form_label_text, when set, is the label shown.
ALTER TABLE custom_shop_types ADD COLUMN form_label_text TEXT;
