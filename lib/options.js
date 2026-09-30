import { forms, units } from './shared.js';

export const OPTION_LISTS = Object.freeze(['form', 'unit', 'location']);
export const SHOP_TYPES = Object.freeze(['medicine', 'goods']);
export const MAX_CUSTOM_OPTIONS = 30;
const LEGACY_UNITS = ['tablets', 'capsules', 'bottles', 'tubes', 'sachets', 'ml', 'units'];
const LEGACY_LOCATIONS = ['Medicine cabinet', 'Bathroom cabinet', 'Kitchen drawer', 'Refrigerator', 'First aid kit'];

const failure = (message, status) => Object.assign(new Error(message), { status });
export const isShopType = value => SHOP_TYPES.includes(value);
export const isOptionList = value => OPTION_LISTS.includes(value);

export function optionValue(value) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (cleaned.length < 1 || cleaned.length > 30 || /[\u0000-\u001f]/.test(cleaned)) throw failure('An option must be 1–30 characters.', 400);
  return cleaned;
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export async function shopTypeOf(db, householdId) {
  try {
    const row = await db.prepare('SELECT shop_type FROM shop_types WHERE household_id=?').bind(householdId).first();
    return isShopType(row?.shop_type) ? row.shop_type : 'medicine';
  } catch { return 'medicine'; }
}

async function defaultsFor(db, shopType) {
  const { results } = await db.prepare('SELECT list,value FROM option_defaults WHERE shop_type=? ORDER BY list,sort_order,value').bind(shopType).all();
  return results || [];
}

/** Management view for one Shop: every list as [{ value, source: 'default'|'custom', hidden }]. */
export async function manageOptions(db, householdId, shopType) {
  const [defaults, shopRows] = await Promise.all([
    defaultsFor(db, shopType),
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
  const shopType = await shopTypeOf(db, householdId);
  const manage = await manageOptions(db, householdId, shopType);
  return { shopType, lists: visibleOf(manage), manage };
}

/**
 * Allowed values for validating a batch. Values the batch already holds are kept valid so old items stay editable.
 * An older database without the tables falls back to the built-in medicine lists.
 */
export async function allowedFor(db, householdId, existing = {}) {
  let lists;
  try { lists = (await shopOptions(db, householdId)).lists; } catch { lists = { form: [...forms], unit: [...units], location: LEGACY_LOCATIONS }; }
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
  return shopTypeOf(db, tenant.householdId);
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
  if (hidden && !manage[list].some(item => !item.hidden && !same(item.value, value))) throw failure('Keep at least one option in each list.', 400);
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
  if (!existing.hidden && !manage[list].some(item => !item.hidden && !same(item.value, value))) throw failure('Keep at least one option in each list.', 400);
  await db.prepare('DELETE FROM shop_options WHERE household_id=? AND list=? AND LOWER(value)=LOWER(?) AND is_custom=1').bind(tenant.householdId, list, value).run();
  return shopOptions(db, tenant.householdId);
}

/** Owner-changeable Shop type. Wording and default lists change; stored items never do. */
export async function setShopType(db, tenant, shopType) {
  requireOwner(tenant);
  if (!isShopType(shopType)) throw failure('Choose a valid Shop type.', 400);
  await db.prepare('INSERT INTO shop_types (household_id,shop_type) VALUES (?,?) ON CONFLICT(household_id) DO UPDATE SET shop_type=excluded.shop_type').bind(tenant.householdId, shopType).run();
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
  if (rows.length <= 1) throw failure('Keep at least one default in each list.', 400);
  await db.prepare('DELETE FROM option_defaults WHERE shop_type=? AND list=? AND LOWER(value)=LOWER(?)').bind(data.shopType, data.list, value).run();
  return listDefaultOptions(db);
}
