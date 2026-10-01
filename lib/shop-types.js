// Custom Shop types. An Owner defines named types for their own Shops: starting lists, whether Strength shows,
// and how Form is labelled. Types are private to the Owner who made them. Built-in types are not editable here.
import { BUILTIN_TYPES, OPTION_LISTS, customTypeId, isShopType, optionValue } from './options.js';

export const MAX_CUSTOM_TYPES = 10;
export const MAX_TYPE_OPTIONS = 60;
const OPTIONAL_LISTS = new Set(['strength']);
const failure = (message, status) => Object.assign(new Error(message), { status });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export function typeName(value) {
  const cleaned = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (cleaned.length < 1 || cleaned.length > 40 || /[\u0000-\u001f]/.test(cleaned)) throw failure('A Shop type name must be 1–40 characters.', 400);
  return cleaned;
}

async function requireOwnerUser(db, userId) {
  const row = userId && await db.prepare("SELECT 1 AS ok FROM active_memberships WHERE user_id=? AND role='owner' LIMIT 1").bind(userId).first();
  if (!row) throw failure('Only Shop Owners can manage Shop types.', 403);
}

async function ownedType(db, userId, id) {
  await requireOwnerUser(db, userId);
  const type = id && await db.prepare('SELECT id,name,base_type,uses_strength,form_label FROM custom_shop_types WHERE id=? AND owner_user_id=?').bind(id, userId).first();
  if (!type) throw failure('That Shop type does not exist.', 404);
  return type;
}

/** The caller's custom types with their lists and how many of their Shops use each. */
export async function listShopTypes(db, userId) {
  await requireOwnerUser(db, userId);
  const { results: types } = await db.prepare('SELECT id,name,base_type,uses_strength,form_label FROM custom_shop_types WHERE owner_user_id=? ORDER BY name COLLATE NOCASE').bind(userId).all();
  const custom = [];
  for (const type of types || []) {
    const { results: rows } = await db.prepare('SELECT list,value FROM custom_type_options WHERE type_id=? ORDER BY list,sort_order,value').bind(type.id).all();
    const used = await db.prepare('SELECT COUNT(*) AS n FROM shop_types WHERE custom_type_id=?').bind(type.id).first();
    const lists = Object.fromEntries(OPTION_LISTS.map(list => [list, []]));
    for (const row of rows || []) lists[row.list]?.push(row.value);
    custom.push({ id: type.id, key: `custom:${type.id}`, name: type.name, baseType: type.base_type, usesStrength: Boolean(type.uses_strength), formLabel: type.form_label, lists, shopCount: used?.n || 0 });
  }
  return { builtin: Object.values(BUILTIN_TYPES), custom };
}

export async function createShopType(db, userId, data, now = () => new Date().toISOString()) {
  await requireOwnerUser(db, userId);
  const name = typeName(data?.name);
  if (Object.values(BUILTIN_TYPES).some(type => same(type.name, name))) throw failure('That name is already used by a built-in type.', 409);
  const existing = await listShopTypes(db, userId);
  if (existing.custom.length >= MAX_CUSTOM_TYPES) throw failure(`You can have up to ${MAX_CUSTOM_TYPES} Shop types.`, 400);
  if (existing.custom.some(type => same(type.name, name))) throw failure('You already have a Shop type with that name.', 409);
  const from = data?.startFrom === undefined ? 'medicine' : data.startFrom;
  let base, usesStrength, formLabel, copy;
  const id = globalThis.crypto.randomUUID();
  if (isShopType(from)) {
    base = from; usesStrength = BUILTIN_TYPES[from].usesStrength; formLabel = BUILTIN_TYPES[from].formLabel;
    copy = ['INSERT INTO custom_type_options (type_id,list,value,sort_order) SELECT ?,list,value,sort_order FROM option_defaults WHERE shop_type=?', id, from];
  } else {
    const source = existing.custom.find(type => type.key === from);
    if (!source) throw failure('Choose a valid starting type.', 400);
    base = source.baseType; usesStrength = source.usesStrength; formLabel = source.formLabel;
    copy = ['INSERT INTO custom_type_options (type_id,list,value,sort_order) SELECT ?,list,value,sort_order FROM custom_type_options WHERE type_id=?', id, source.id];
  }
  if (typeof data?.usesStrength === 'boolean') usesStrength = data.usesStrength;
  if (data?.formLabel === 'Form' || data?.formLabel === 'Category') formLabel = data.formLabel;
  await db.batch([
    db.prepare('INSERT INTO custom_shop_types (id,owner_user_id,name,base_type,uses_strength,form_label,created_at) VALUES (?,?,?,?,?,?,?)').bind(id, userId, name, base, usesStrength ? 1 : 0, formLabel, now()),
    db.prepare(copy[0]).bind(copy[1], copy[2])
  ]);
  return listShopTypes(db, userId);
}

export async function updateShopType(db, userId, data) {
  const type = await ownedType(db, userId, data?.id);
  const name = data?.name === undefined ? type.name : typeName(data.name);
  const usesStrength = typeof data?.usesStrength === 'boolean' ? data.usesStrength : Boolean(type.uses_strength);
  const formLabel = data?.formLabel === undefined ? type.form_label : data.formLabel;
  if (formLabel !== 'Form' && formLabel !== 'Category') throw failure('Choose Form or Category.', 400);
  if (Object.values(BUILTIN_TYPES).some(builtin => same(builtin.name, name))) throw failure('That name is already used by a built-in type.', 409);
  const clash = await db.prepare('SELECT 1 AS ok FROM custom_shop_types WHERE owner_user_id=? AND id<>? AND LOWER(name)=LOWER(?)').bind(userId, type.id, name).first();
  if (clash) throw failure('You already have a Shop type with that name.', 409);
  await db.prepare('UPDATE custom_shop_types SET name=?,uses_strength=?,form_label=? WHERE id=? AND owner_user_id=?').bind(name, usesStrength ? 1 : 0, formLabel, type.id, userId).run();
  return listShopTypes(db, userId);
}

/** Add or remove one value in one list of a custom type. Saved items are never touched. */
export async function changeTypeOption(db, userId, data) {
  const type = await ownedType(db, userId, data?.id);
  if (!OPTION_LISTS.includes(data?.list)) throw failure('Choose a valid list.', 400);
  const value = optionValue(data?.value);
  const { results } = await db.prepare('SELECT value FROM custom_type_options WHERE type_id=? AND list=?').bind(type.id, data.list).all();
  const rows = results || [];
  const found = rows.find(row => same(row.value, value));
  if (data.action === 'add') {
    if (found) throw failure('That option already exists.', 409);
    if (rows.length >= MAX_TYPE_OPTIONS) throw failure(`A list can have up to ${MAX_TYPE_OPTIONS} options.`, 400);
    await db.prepare('INSERT INTO custom_type_options (type_id,list,value,sort_order) VALUES (?,?,?,?)').bind(type.id, data.list, value, rows.length + 1).run();
  } else if (data.action === 'remove') {
    if (!found) throw failure('That option does not exist.', 404);
    if (rows.length <= 1 && !OPTIONAL_LISTS.has(data.list)) throw failure('Keep at least one option in each list.', 400);
    await db.prepare('DELETE FROM custom_type_options WHERE type_id=? AND list=? AND LOWER(value)=LOWER(?)').bind(type.id, data.list, value).run();
  } else {
    throw failure('Choose add or remove.', 400);
  }
  return listShopTypes(db, userId);
}

export async function deleteShopType(db, userId, data) {
  const type = await ownedType(db, userId, data?.id);
  const used = await db.prepare('SELECT COUNT(*) AS n FROM shop_types WHERE custom_type_id=?').bind(type.id).first();
  if (used?.n) throw failure(`${used.n} Shop${used.n === 1 ? '' : 's'} use this type. Move ${used.n === 1 ? 'it' : 'them'} to another type first.`, 409);
  await db.batch([
    db.prepare('DELETE FROM custom_type_options WHERE type_id=?').bind(type.id),
    db.prepare('DELETE FROM custom_shop_types WHERE id=? AND owner_user_id=?').bind(type.id, userId)
  ]);
  return listShopTypes(db, userId);
}

/** For Shop creation: the type's base and its first storage location, or null when the id is not yours. */
export async function customTypeForCreation(db, userId, key) {
  const id = customTypeId(key);
  if (!id) return null;
  const type = await db.prepare('SELECT id,base_type FROM custom_shop_types WHERE id=? AND owner_user_id=?').bind(id, userId).first();
  if (!type) return null;
  const location = await db.prepare("SELECT value FROM custom_type_options WHERE type_id=? AND list='location' ORDER BY sort_order LIMIT 1").bind(id).first();
  return { id, base: type.base_type, location: location?.value || null };
}

/** The user id behind a verified principal, or null. */
export async function userIdFor(db, principal) {
  if (!principal?.provider || !principal?.subject) return null;
  const row = await db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?').bind(principal.provider, principal.subject).first();
  return row?.user_id || null;
}
