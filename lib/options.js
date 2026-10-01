import { forms, units } from './shared.js';

export const OPTION_LISTS = Object.freeze(['form', 'unit', 'location', 'strength']);
// Strength only suggests values (the field stays free text), so it may be emptied. The other lists feed validation.
const OPTIONAL_LISTS = new Set(['strength']);
export const SHOP_TYPES = Object.freeze(['medicine', 'goods']);
export const MAX_CUSTOM_OPTIONS = 30;
const LEGACY_UNITS = ['tablets', 'capsules', 'bottles', 'tubes', 'sachets', 'ml', 'units'];
const LEGACY_LOCATIONS = ['Medicine cabinet', 'Bathroom cabinet', 'Kitchen drawer', 'Refrigerator', 'First aid kit'];

const failure = (message, status) => Object.assign(new Error(message), { status });
export const isShopType = value => SHOP_TYPES.includes(value);
const CUSTOM_KEY = /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** A Shop type key: 'medicine', 'goods' or 'custom:<id>'. Whether a custom id exists and is yours is checked where it is used. */
export const isShopTypeKey = value => isShopType(value) || (typeof value === 'string' && CUSTOM_KEY.test(value));
export const customTypeId = key => (typeof key === 'string' ? CUSTOM_KEY.exec(key)?.[1] : undefined) || null;
export const BUILTIN_TYPES = Object.freeze({
  medicine: Object.freeze({ key: 'medicine', name: 'Medicine', usesStrength: true, formLabel: 'Form' }),
  goods: Object.freeze({ key: 'goods', name: 'General goods', usesStrength: false, formLabel: 'Category' })
});
export const isOptionList = value => OPTION_LISTS.includes(value);

export function optionValue(value) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (cleaned.length < 1 || cleaned.length > 30 || /[\u0000-\u001f]/.test(cleaned)) throw failure('An option must be 1–30 characters.', 400);
  return cleaned;
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The Shop's type with everything that depends on it: base type, optional custom type, name and field labels. */
export async function shopTypeRef(db, householdId) {
  try {
    const row = await db.prepare(`SELECT st.shop_type,st.custom_type_id,c.name,c.uses_strength,COALESCE(c.form_label_text,c.form_label) AS form_label
      FROM shop_types st LEFT JOIN custom_shop_types c ON c.id=st.custom_type_id WHERE st.household_id=?`).bind(householdId).first();
    const base = isShopType(row?.shop_type) ? row.shop_type : 'medicine';
    if (row?.custom_type_id && row.name) {
      return { base, customId: row.custom_type_id, key: `custom:${row.custom_type_id}`, name: row.name, usesStrength: Boolean(row.uses_strength), formLabel: row.form_label || 'Form' };
    }
    return { base, customId: null, ...BUILTIN_TYPES[base] };
  } catch { return { base: 'medicine', customId: null, ...BUILTIN_TYPES.medicine }; }
}

/** The base type only ('medicine' or 'goods'). */
export async function shopTypeOf(db, householdId) {
  return (await shopTypeRef(db, householdId)).base;
}

async function defaultsFor(db, ref) {
  if (ref.customId) {
    const { results } = await db.prepare('SELECT list,value FROM custom_type_options WHERE type_id=? ORDER BY list,sort_order,value').bind(ref.customId).all();
    return results || [];
  }
  const { results } = await db.prepare('SELECT list,value FROM option_defaults WHERE shop_type=? ORDER BY list,sort_order,value').bind(ref.base).all();
  return results || [];
}

/** Management view for one Shop: every list as [{ value, source: 'default'|'custom', hidden }]. */
export async function manageOptions(db, householdId, typeRef) {
  const ref = typeof typeRef === 'string' ? { base: typeRef, customId: null } : typeRef;
  const [defaults, shopRows] = await Promise.all([
    defaultsFor(db, ref),
    db.prepare('SELECT list,value,hidden,is_custom FROM shop_options WHERE household_id=? ORDER BY rowid').bind(householdId).all()
  ]);
  const rows = shopRows.results || [];
  const manage = Object.fromEntries(OPTION_LISTS.map(list => [list, []]));
  for (const item of defaults) {
    const own = rows.find(row => row.list === item.list && same(row.value, item.value) && !row.is_custom);
    manage[item.list].push({ value: item.value, source: 'default', hidden: Boolean(own?.hidden) });
  }
  for (const row of rows.filter(row => row.is_custom)) {
    if (!manage[row.list].some(item => same(item.value, row.value))) manage[row.list].push({ value: row.value, source: 'custom', hidden: Boolean(row.hidden) });
  }
  return manage;
}

export const visibleOf = manage => Object.fromEntries(OPTION_LISTS.map(list => [list, manage[list].filter(item => !item.hidden).map(item => item.value)]));

/** Options a Shop currently offers, plus the shop type. */
export async function shopOptions(db, householdId) {
  const ref = await shopTypeRef(db, householdId);
  const manage = await manageOptions(db, householdId, ref);
  return { shopType: ref.base, typeInfo: { key: ref.key, name: ref.name, usesStrength: ref.usesStrength, formLabel: ref.formLabel }, lists: visibleOf(manage), manage };
}

/**
 * Allowed values for validating a batch. Values the batch already holds are kept valid so old items stay editable.
 * An older database without the tables falls back to the built-in medicine lists.
 */
export async function allowedFor(db, householdId, existing = {}) {
  let lists;
  try { lists = (await shopOptions(db, householdId)).lists; } catch { lists = { form: [...forms], unit: [...units], location: LEGACY_LOCATIONS, strength: [] }; }
  // Old plural units stay accepted for older clients and queued edits; they are not offered in the lists.
  const allowed = { forms: new Set(lists.form), units: new Set([...lists.unit, ...LEGACY_UNITS]), locations: new Set(lists.location) };
  if (existing.form) allowed.forms.add(existing.form);
  if (existing.unit) allowed.units.add(existing.unit);
  return allowed;
}

function requireOwner(tenant) {
  if (tenant?.role !== 'owner') throw failure('Only Owners can change this Shop’s lists.', 403);
}

async function ownerShop(db, tenant) {
  requireOwner(tenant);
  const member = await db.prepare("SELECT 1 FROM active_memberships WHERE household_id=? AND user_id=? AND role='owner'").bind(tenant.householdId, tenant.userId).first();
  if (!member) throw failure('Only Owners can change this Shop’s lists.', 403);
  return shopTypeRef(db, tenant.householdId);
}

function parseChange(data) {
  if (!isOptionList(data?.list)) throw failure('Choose a valid list.', 400);
  return { list: data.list, value: optionValue(data.value) };
}

export async function addShopOption(db, tenant, data, now = () => new Date().toISOString()) {
  const shopType = await ownerShop(db, tenant);
  const { list, value } = parseChange(data);
  const manage = await manageOptions(db, tenant.householdId, shopType);
  const existing = manage[list].find(item => same(item.value, value));
  if (existing && !existing.hidden) throw failure('That option already exists.', 409);
  if (existing) {
    await db.prepare('UPDATE shop_options SET hidden=0 WHERE household_id=? AND list=? AND LOWER(value)=LOWER(?)').bind(tenant.householdId, list, value).run();
  } else {
    if (manage[list].filter(item => item.source === 'custom').length >= MAX_CUSTOM_OPTIONS) throw failure(`A list can have up to ${MAX_CUSTOM_OPTIONS} custom options.`, 400);
    await db.prepare('INSERT INTO shop_options (household_id,list,value,hidden,is_custom,created_at) VALUES (?,?,?,0,1,?)').bind(tenant.householdId, list, value, now()).run();
  }
  return shopOptions(db, tenant.householdId);
}

export async function setShopOptionHidden(db, tenant, data, now = () => new Date().toISOString()) {
  const shopType = await ownerShop(db, tenant);
  const { list, value } = parseChange(data);
  const hidden = data.hidden === true;
  const manage = await manageOptions(db, tenant.householdId, shopType);
  const existing = manage[list].find(item => same(item.value, value));
  if (!existing) throw failure('That option does not exist.', 404);
  if (hidden && !OPTIONAL_LISTS.has(list) && !manage[list].some(item => !item.hidden && !same(item.value, value))) throw failure('Keep at least one option in each list.', 400);
  const updated = await db.prepare('UPDATE shop_options SET hidden=? WHERE household_id=? AND list=? AND LOWER(value)=LOWER(?)').bind(hidden ? 1 : 0, tenant.householdId, list, value).run();
  if (!updated.meta?.changes && hidden) {
    await db.prepare('INSERT INTO shop_options (household_id,list,value,hidden,is_custom,created_at) VALUES (?,?,?,1,0,?)').bind(tenant.householdId, list, existing.value, now()).run();
  }
  return shopOptions(db, tenant.householdId);
}

export async function removeShopOption(db, tenant, data) {
  const shopType = await ownerShop(db, tenant);
  const { list, value } = parseChange(data);
  const manage = await manageOptions(db, tenant.householdId, shopType);
  const existing = manage[list].find(item => same(item.value, value));
  if (!existing || existing.source !== 'custom') throw failure('Only custom options can be removed.', 400);
  if (!existing.hidden && !OPTIONAL_LISTS.has(list) && !manage[list].some(item => !item.hidden && !same(item.value, value))) throw failure('Keep at least one option in each list.', 400);
  await db.prepare('DELETE FROM shop_options WHERE household_id=? AND list=? AND LOWER(value)=LOWER(?) AND is_custom=1').bind(tenant.householdId, list, value).run();
  return shopOptions(db, tenant.householdId);
}

/** Owner-changeable Shop type. Wording and default lists change; stored items never do. */
const UPSERT_TYPE = 'INSERT INTO shop_types (household_id,shop_type,custom_type_id) VALUES (?,?,?) ON CONFLICT(household_id) DO UPDATE SET shop_type=excluded.shop_type, custom_type_id=excluded.custom_type_id';

export async function setShopType(db, tenant, key) {
  requireOwner(tenant);
  // The Profile form sends the Shop's current type with every save. Keeping the same type is not a change, so another
  // Owner can still save the form when the type belongs to the Owner who chose it.
  if (typeof key === 'string' && (await shopTypeRef(db, tenant.householdId)).key === key) return;
  if (isShopType(key)) {
    await db.prepare(UPSERT_TYPE).bind(tenant.householdId, key, null).run();
    return;
  }
  const id = customTypeId(key);
  const type = id && await db.prepare('SELECT base_type FROM custom_shop_types WHERE id=? AND owner_user_id=?').bind(id, tenant.userId).first();
  if (!type) throw failure('Choose a valid Shop type.', 400);
  await db.prepare(UPSERT_TYPE).bind(tenant.householdId, type.base_type, id).run();
}

/** Puts back a type read earlier with shopTypeRef, without an ownership check (used to undo a refused change). */
export async function restoreShopType(db, householdId, ref) {
  await db.prepare(UPSERT_TYPE).bind(householdId, ref.base, ref.customId || null).run();
}

/* Platform defaults for the admin console. */
export async function listDefaultOptions(db) {
  const { results } = await db.prepare('SELECT shop_type,list,value,sort_order FROM option_defaults ORDER BY shop_type,list,sort_order,value').all();
  const out = { medicine: Object.fromEntries(OPTION_LISTS.map(list => [list, []])), goods: Object.fromEntries(OPTION_LISTS.map(list => [list, []])) };
  for (const row of results || []) out[row.shop_type][row.list].push(row.value);
  return out;
}

export async function addDefaultOption(db, data) {
  if (!isShopType(data?.shopType) || !isOptionList(data?.list)) throw failure('Choose a valid Shop type and list.', 400);
  const value = optionValue(data.value);
  const rows = (await listDefaultOptions(db))[data.shopType][data.list];
  if (rows.some(item => same(item, value))) throw failure('That option already exists.', 409);
  if (rows.length >= 60) throw failure('A default list can have up to 60 options.', 400);
  await db.prepare('INSERT INTO option_defaults (shop_type,list,value,sort_order) VALUES (?,?,?,?)').bind(data.shopType, data.list, value, rows.length + 1).run();
  return listDefaultOptions(db);
}

export async function removeDefaultOption(db, data) {
  if (!isShopType(data?.shopType) || !isOptionList(data?.list)) throw failure('Choose a valid Shop type and list.', 400);
  const value = optionValue(data.value);
  const rows = (await listDefaultOptions(db))[data.shopType][data.list];
  if (!rows.some(item => same(item, value))) throw failure('That option does not exist.', 404);
  if (rows.length <= 1 && !OPTIONAL_LISTS.has(data.list)) throw failure('Keep at least one default in each list.', 400);
  await db.prepare('DELETE FROM option_defaults WHERE shop_type=? AND list=? AND LOWER(value)=LOWER(?)').bind(data.shopType, data.list, value).run();
  return listDefaultOptions(db);
}
