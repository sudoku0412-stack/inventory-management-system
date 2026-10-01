import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { addShopOption, allowedFor, restoreShopType, setShopOptionHidden, setShopType, shopOptions, shopTypeRef } from '../lib/options.js';
import { changeTypeOption, createShopType, deleteShopType, listShopTypes, updateShopType, userIdFor } from '../lib/shop-types.js';
import { createAdditionalShop } from '../lib/tenants.js';
import { createD1Store } from '../lib/store-d1.js';
import { ownerOverview } from '../lib/overview.js';
import { bindShopTypes } from '../public/shop-types-client.js';

const [u1, u2, a, b, c, d] = ['u1', 'u2', 'shopA', 'shopB', 'shopC', 'shopD'];
const principal = { provider: 'access', subject: 's1', email: 'o@x.com' };
const migrations = () => readdirSync(new URL('../migrations/', import.meta.url)).sort();
const run = (sqlite, name) => sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

function wrap(sqlite) {
  const statement = (sql, values = []) => ({ sql, values, bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      const out = [];
      sqlite.exec('BEGIN');
      try { for (const s of statements) out.push({ meta: { changes: sqlite.prepare(s.sql).run(...s.values).changes } }); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      return out;
    }
  };
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations()) run(sqlite, name);
  for (const [id, subject, email] of [[u1, 's1', 'o@x.com'], [u2, 's2', 'p@x.com']]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 't');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('access', subject, id, email, 't');
  }
  for (const [id, name] of [[a, 'Alpha'], [b, 'Beta'], [c, 'Gamma'], [d, 'Delta']]) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, name, 't');
  for (const [id, user, role] of [[a, u1, 'owner'], [b, u1, 'owner'], [c, u1, 'member'], [d, u2, 'owner']]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, user, role, 't');
  sqlite.prepare('INSERT INTO users VALUES (?,?)').run('u3', 't');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(a, 'u3', 'member', 't');
  return { sqlite, db: wrap(sqlite) };
}
const owner = (householdId, userId = u1) => ({ userId, householdId, role: 'owner' });
const byName = (types, name) => types.custom.find(type => type.name === name);

test('an Owner creates a type that starts as a copy of Medicine', async () => {
  const { db } = fixture();
  const types = await createShopType(db, u1, { name: 'Pharmacy' });
  const type = byName(types, 'Pharmacy');
  assert.equal(type.baseType, 'medicine');
  assert.equal(type.usesStrength, true);
  assert.equal(type.formLabel, 'Form');
  assert.ok(type.lists.form.includes('Tablets') && type.lists.strength.includes('500 mg') && type.lists.location.includes('Medicine cabinet'));
  assert.equal(type.key, `custom:${type.id}`);
  assert.equal(types.builtin.length, 2);
});

test('starting from General goods copies its lists and labels, and the choices can be overridden', async () => {
  const { db } = fixture();
  let types = await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' });
  assert.equal(byName(types, 'Pantry').usesStrength, false);
  assert.equal(byName(types, 'Pantry').formLabel, 'Category');
  assert.ok(byName(types, 'Pantry').lists.unit.includes('kg'));
  types = await createShopType(db, u1, { name: 'Workshop', startFrom: 'goods', usesStrength: true, formLabel: 'Form' });
  assert.equal(byName(types, 'Workshop').usesStrength, true);
  assert.equal(byName(types, 'Workshop').formLabel, 'Form');
});

test('a new type can start from one of your own types', async () => {
  const { db } = fixture();
  let types = await createShopType(db, u1, { name: 'Base', startFrom: 'goods' });
  const base = byName(types, 'Base');
  await changeTypeOption(db, u1, { id: base.id, list: 'unit', value: 'crate', action: 'add' });
  types = await createShopType(db, u1, { name: 'Copy', startFrom: base.key });
  assert.ok(byName(types, 'Copy').lists.unit.includes('crate'));
  assert.equal(byName(types, 'Copy').formLabel, 'Category');
  await assert.rejects(createShopType(db, u1, { name: 'Nope', startFrom: 'custom:123e4567-e89b-42d3-a456-426614174000' }), /starting type/);
});

test('type names are checked: length, duplicates, built-in names and the cap', async () => {
  const { db } = fixture();
  await createShopType(db, u1, { name: 'Pantry' });
  await assert.rejects(createShopType(db, u1, { name: '  ' }), /1–40/);
  await assert.rejects(createShopType(db, u1, { name: 'x'.repeat(41) }), /1–40/);
  await assert.rejects(createShopType(db, u1, { name: 'pantry' }), /already have/);
  await assert.rejects(createShopType(db, u1, { name: 'medicine' }), /built-in/);
  await assert.rejects(createShopType(db, u1, { name: 'General Goods' }), /built-in/);
  for (let i = 0; i < 9; i += 1) await createShopType(db, u1, { name: `Type ${i}` });
  await assert.rejects(createShopType(db, u1, { name: 'One too many' }), /up to 10/);
});

test('only Shop Owners can manage types, and types are private to their creator', async () => {
  const { db } = fixture();
  await assert.rejects(createShopType(db, 'u3', { name: 'Sneaky' }), { status: 403 });
  await assert.rejects(listShopTypes(db, 'u3'), { status: 403 });
  const mine = byName(await createShopType(db, u1, { name: 'Mine' }), 'Mine');
  assert.deepEqual((await listShopTypes(db, u2)).custom, []);
  await assert.rejects(updateShopType(db, u2, { id: mine.id, name: 'Stolen' }), { status: 404 });
  await assert.rejects(changeTypeOption(db, u2, { id: mine.id, list: 'unit', value: 'x', action: 'add' }), { status: 404 });
  await assert.rejects(deleteShopType(db, u2, { id: mine.id }), { status: 404 });
  assert.equal(byName(await listShopTypes(db, u1), 'Mine').name, 'Mine');
});

test('a type can be renamed and its Strength and Form label changed', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pharmacy' }), 'Pharmacy');
  let types = await updateShopType(db, u1, { id: type.id, name: 'Chemist', usesStrength: false, formLabel: 'Category' });
  assert.equal(byName(types, 'Chemist').usesStrength, false);
  assert.equal(byName(types, 'Chemist').formLabel, 'Category');
  await createShopType(db, u1, { name: 'Other' });
  await assert.rejects(updateShopType(db, u1, { id: type.id, name: 'other' }), /already have/);
  await assert.rejects(updateShopType(db, u1, { id: type.id, name: 'Medicine' }), /built-in/);
  await assert.rejects(updateShopType(db, u1, { id: type.id, formLabel: '   ' }), /1–20/);
  await assert.rejects(updateShopType(db, u1, { id: type.id, formLabel: 'x'.repeat(21) }), /1–20/);
  types = await updateShopType(db, u1, { id: type.id, formLabel: 'Kind' });
  assert.equal(byName(types, 'Chemist').formLabel, 'Kind');
  types = await updateShopType(db, u1, { id: type.id, name: 'Chemist' });
  assert.equal(byName(types, 'Chemist').usesStrength, false);
});

test('type lists: add, remove, duplicates, caps, and every list except Strength keeps one option', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  let types = await changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'tin', action: 'add' });
  assert.ok(byName(types, 'Pantry').lists.unit.includes('tin'));
  await assert.rejects(changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'TIN', action: 'add' }), /already exists/);
  types = await changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'tin', action: 'remove' });
  assert.ok(!byName(types, 'Pantry').lists.unit.includes('tin'));
  await assert.rejects(changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'missing', action: 'remove' }), { status: 404 });
  await assert.rejects(changeTypeOption(db, u1, { id: type.id, list: 'bogus', value: 'x', action: 'add' }), /valid list/);
  await assert.rejects(changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'x', action: 'rename' }), /add or remove/);
  await assert.rejects(changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'x'.repeat(31), action: 'add' }), /1–30/);
  for (const value of byName(types, 'Pantry').lists.location.slice(1)) await changeTypeOption(db, u1, { id: type.id, list: 'location', value, action: 'remove' });
  await assert.rejects(changeTypeOption(db, u1, { id: type.id, list: 'location', value: 'Shelf', action: 'remove' }), /at least one/);
  types = await changeTypeOption(db, u1, { id: type.id, list: 'strength', value: 'any', action: 'add' });
  types = await changeTypeOption(db, u1, { id: type.id, list: 'strength', value: 'any', action: 'remove' });
  assert.deepEqual(byName(types, 'Pantry').lists.strength, []);
});

test('a Shop on a custom type uses its lists, labels and type name; Shop-level changes still layer on top', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  await changeTypeOption(db, u1, { id: type.id, list: 'unit', value: 'tin', action: 'add' });
  await setShopType(db, owner(a), type.key);
  let options = await shopOptions(db, a);
  assert.equal(options.shopType, 'goods');
  assert.deepEqual(options.typeInfo, { key: type.key, name: 'Pantry', usesStrength: false, formLabel: 'Category' });
  assert.ok(options.lists.unit.includes('tin'));
  options = await addShopOption(db, owner(a), { list: 'unit', value: 'jar' });
  options = await setShopOptionHidden(db, owner(a), { list: 'unit', value: 'kg', hidden: true });
  assert.ok(options.lists.unit.includes('jar') && !options.lists.unit.includes('kg'));
  assert.ok((await shopOptions(db, b)).lists.unit.includes('bottle'));
  assert.deepEqual((await shopOptions(db, b)).typeInfo, { key: 'medicine', name: 'Medicine', usesStrength: true, formLabel: 'Form' });
  const allowed = await allowedFor(db, a);
  assert.ok(allowed.units.has('tin') && allowed.forms.has('General') && !allowed.forms.has('Tablets'));
});

test('choosing a type is limited to your own types, and built-in types clear the custom one', async () => {
  const { db } = fixture();
  const mine = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  const theirs = byName(await createShopType(db, u2, { name: 'Theirs' }), 'Theirs');
  await assert.rejects(setShopType(db, owner(a), theirs.key), /valid Shop type/);
  await assert.rejects(setShopType(db, owner(a), 'custom:123e4567-e89b-42d3-a456-426614174000'), /valid Shop type/);
  await assert.rejects(setShopType(db, { userId: 'u3', householdId: a, role: 'member' }, mine.key), /Only Owners/);
  await setShopType(db, owner(a), mine.key);
  assert.equal((await shopTypeRef(db, a)).customId, mine.id);
  await setShopType(db, owner(a), 'medicine');
  const ref = await shopTypeRef(db, a);
  assert.equal(ref.customId, null);
  assert.equal(ref.key, 'medicine');
});

test('another Owner can keep the Shop\'s current type, which is not theirs, but cannot pick it for another Shop', async () => {
  const { db, sqlite } = fixture();
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(a, u2, 'owner', 't');
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  await setShopType(db, owner(a), type.key);
  await setShopType(db, owner(a, u2), type.key);
  assert.equal((await shopTypeRef(db, a)).key, type.key);
  await assert.rejects(setShopType(db, owner(d, u2), type.key), /valid Shop type/);
  await setShopType(db, owner(a, u2), 'goods');
  assert.equal((await shopTypeRef(db, a)).key, 'goods');
});

test('a refused settings change can be undone to the exact previous type', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  await setShopType(db, owner(a), type.key);
  const previous = await shopTypeRef(db, a);
  await setShopType(db, owner(a), 'medicine');
  await restoreShopType(db, a, previous);
  assert.equal((await shopTypeRef(db, a)).key, type.key);
});

test('settings report the type key and its labels so the page can match its select', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  await setShopType(db, owner(a), type.key);
  const store = createD1Store(db, null, {}, { householdId: a, userId: u1 });
  const settings = await store.settings();
  assert.equal(settings.shop_type, type.key);
  assert.deepEqual(settings.shop_type_info, { key: type.key, name: 'Pantry', base: 'goods', usesStrength: false, formLabel: 'Category' });
});

test('a type in use cannot be deleted; once its Shops move, it can', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry' }), 'Pantry');
  await setShopType(db, owner(a), type.key);
  await setShopType(db, owner(b), type.key);
  assert.equal(byName(await listShopTypes(db, u1), 'Pantry').shopCount, 2);
  await assert.rejects(deleteShopType(db, u1, { id: type.id }), /2 Shops use this type/);
  await setShopType(db, owner(a), 'goods');
  await assert.rejects(deleteShopType(db, u1, { id: type.id }), /1 Shop use this type\. Move it/);
  await setShopType(db, owner(b), 'medicine');
  const types = await deleteShopType(db, u1, { id: type.id });
  assert.deepEqual(types.custom, []);
});

test('creating a Shop with a custom type uses its lists and its first storage location', async () => {
  const { db, sqlite } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  await changeTypeOption(db, u1, { id: type.id, list: 'location', value: 'Larder', action: 'add' });
  for (const value of ['Shelf', 'Storeroom', 'Refrigerator', 'Freezer', 'Counter']) await changeTypeOption(db, u1, { id: type.id, list: 'location', value, action: 'remove' });
  const made = await createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-000000000010', shopName: 'Kitchen', displayName: 'Me', shopType: type.key });
  const ref = await shopTypeRef(db, made.shop.id);
  assert.equal(ref.key, type.key);
  assert.equal(sqlite.prepare('SELECT default_storage_location d FROM household_settings WHERE household_id=?').get(made.shop.id).d, 'Larder');
});

test('creating a Shop with someone else\'s or an unknown type is refused', async () => {
  const { db } = fixture();
  const theirs = byName(await createShopType(db, u2, { name: 'Theirs' }), 'Theirs');
  await assert.rejects(createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-000000000011', shopName: 'X', displayName: 'Me', shopType: theirs.key }), /valid Shop type/);
  await assert.rejects(createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-000000000012', shopName: 'Y', displayName: 'Me', shopType: 'custom:123e4567-e89b-42d3-a456-426614174000' }), /valid Shop type/);
});

test('the Owner overview shows the custom type name', async () => {
  const { db } = fixture();
  const type = byName(await createShopType(db, u1, { name: 'Pantry', startFrom: 'goods' }), 'Pantry');
  await setShopType(db, owner(a), type.key);
  const overview = await ownerOverview(db, principal);
  assert.equal(overview.shops.find(shop => shop.id === a).shopTypeName, 'Pantry');
  assert.equal(overview.shops.find(shop => shop.id === b).shopTypeName, null);
});

test('migration 0032 keeps existing Shop types and adds the custom type tables', () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations().filter(name => name < '0032')) run(sqlite, name);
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run('h1', 'Hardware', 't');
  sqlite.prepare("INSERT INTO shop_types (household_id,shop_type) VALUES ('h1','goods')").run();
  run(sqlite, '0032_custom_shop_types.sql');
  assert.deepEqual({ ...sqlite.prepare('SELECT shop_type,custom_type_id FROM shop_types').get() }, { shop_type: 'goods', custom_type_id: null });
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('custom_shop_types','custom_type_options')").all().length === 2);
});

test('userIdFor maps a verified principal to its user', async () => {
  const { db } = fixture();
  assert.equal(await userIdFor(db, principal), u1);
  assert.equal(await userIdFor(db, { provider: 'access', subject: 'nobody' }), null);
  assert.equal(await userIdFor(db, null), null);
});

/* Client */
function fakeSelect(values) {
  const select = { addEventListener() {}, options: values.map(value => ({ value, textContent: value, dataset: {} })), value: values[0] || '' };
  select.append = option => { option.remove = () => { select.options = select.options.filter(item => item !== option); }; select.options.push(option); };
  select.options.forEach(option => { option.remove = () => { select.options = select.options.filter(item => item !== option); }; });
  select.replaceChildren = (...items) => { select.options = items; items.forEach(option => { option.dataset ||= {}; option.remove = () => { select.options = select.options.filter(item => item !== option); }; }); };
  return select;
}
function clientDom() {
  const make = () => ({ children: [], dataset: {}, listeners: {}, hidden: false, textContent: '', classList: { toggle() {} }, setAttribute() {},
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, addEventListener(type, handler) { this.listeners[type] = handler; }, querySelectorAll: () => [] });
  const nodes = { '#shopTypeSelect': fakeSelect(['medicine', 'goods']), '#createShopType': fakeSelect(['medicine', 'goods']), '#newShopTypeStart': fakeSelect(['medicine', 'goods']), '#shopTypesList': make(), '#shopTypesStatus': make(), '#openShopTypes': make(), '#shopTypesCard': make(),
    '#shopTypesModal': { open: false, showModal() { this.open = true; } },
    '#newShopTypeForm': { ...make(), elements: { name: { value: '' }, startFrom: { value: 'goods' }, usesStrength: { checked: false }, formLabel: { value: 'Category' } } } };
  const document = { querySelector: selector => nodes[selector] || null, createElement: tag => { const node = { ...make(), tagName: tag }; if (tag === 'option') node.dataset = {}; return node; } };
  return { document, nodes };
}
const pantry = { id: 'p1', key: 'custom:p1', name: 'Pantry', baseType: 'goods', usesStrength: false, formLabel: 'Category', lists: { form: ['General'], unit: ['kg'], location: ['Shelf'], strength: [] }, shopCount: 0 };
const ownerContext = () => ({ shops: [{ role: 'owner' }] });

test('Owners get the Shop types card and their types appear in both Shop type selects', async () => {
  const { document, nodes } = clientDom();
  const types = bindShopTypes({ document, api: async () => ({ builtin: [], custom: [pantry] }), getContext: ownerContext, getCurrentKey: () => 'medicine' });
  await types.refresh();
  assert.equal(nodes['#shopTypesCard'].hidden, false);
  assert.equal(nodes['#openShopTypes'].hidden, false);
  for (const id of ['#shopTypeSelect', '#createShopType']) assert.deepEqual(nodes[id].options.map(option => option.value), ['medicine', 'goods', 'custom:p1']);
  assert.deepEqual(nodes['#newShopTypeStart'].options.map(option => option.value), ['medicine', 'goods', 'blank', 'custom:p1']);
});

test('the Shop\'s current type stays selected, even when it is not one of your own types', async () => {
  const { document, nodes } = clientDom();
  nodes['#shopTypeSelect'].append({ value: 'custom:other', textContent: 'Their type', dataset: { custom: 'true' } });
  nodes['#shopTypeSelect'].value = 'custom:other';
  const types = bindShopTypes({ document, api: async () => ({ builtin: [], custom: [pantry] }), getContext: ownerContext, getCurrentKey: () => 'custom:other' });
  await types.refresh();
  assert.equal(nodes['#shopTypeSelect'].value, 'custom:other');
  assert.ok(nodes['#shopTypeSelect'].options.some(option => option.value === 'custom:p1'));
});

test('members never see the Shop types card and no request is made', async () => {
  const { document, nodes } = clientDom();
  let calls = 0;
  const types = bindShopTypes({ document, api: async () => { calls += 1; return { builtin: [], custom: [] }; }, getContext: () => ({ shops: [{ role: 'member' }] }), getCurrentKey: () => 'medicine' });
  assert.equal(await types.refresh(), null);
  assert.equal(nodes['#shopTypesCard'].hidden, true);
  assert.equal(calls, 0);
});

test('creating a type posts the form values and clears the name', async () => {
  const { document, nodes } = clientDom();
  const sent = [];
  const api = async (path, options) => { sent.push([path, options?.body && JSON.parse(options.body)]); return { builtin: [], custom: [pantry] }; };
  bindShopTypes({ document, api, getContext: ownerContext, getCurrentKey: () => 'medicine' });
  const form = nodes['#newShopTypeForm'];
  form.elements.name.value = '  Pantry ';
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(sent[0], ['/api/shop-types', { name: 'Pantry', startFrom: 'goods', usesStrength: false, formLabel: 'Category' }]);
  assert.equal(form.elements.name.value, '');
  assert.match(nodes['#shopTypesStatus'].textContent, /Pantry created/);
});

test('an empty name is refused before any request', async () => {
  const { document, nodes } = clientDom();
  let calls = 0;
  bindShopTypes({ document, api: async () => { calls += 1; return {}; }, getContext: ownerContext, getCurrentKey: () => 'medicine' });
  await nodes['#newShopTypeForm'].listeners.submit({ preventDefault() {} });
  assert.equal(calls, 0);
  assert.match(nodes['#shopTypesStatus'].textContent, /Enter a name/);
});

test('a server error is shown in the dialog', async () => {
  const { document, nodes } = clientDom();
  bindShopTypes({ document, api: async () => { throw Object.assign(new Error('You already have a Shop type with that name.'), { status: 409 }); }, getContext: ownerContext, getCurrentKey: () => 'medicine', toast() {} });
  nodes['#newShopTypeForm'].elements.name.value = 'Pantry';
  await nodes['#newShopTypeForm'].listeners.submit({ preventDefault() {} });
  assert.match(nodes['#shopTypesStatus'].textContent, /already have/);
});

test('the dialog lists each type with its Shop count, and delete is off while Shops use it', async () => {
  const { document, nodes } = clientDom();
  const types = bindShopTypes({ document, api: async () => ({ builtin: [], custom: [pantry, { ...pantry, id: 'p2', key: 'custom:p2', name: 'Busy', shopCount: 2 }] }), getContext: ownerContext, getCurrentKey: () => 'medicine' });
  await types.refresh();
  const blocks = nodes['#shopTypesList'].children;
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].children[0].textContent, /Pantry · 0 Shops/);
  assert.match(blocks[1].children[0].textContent, /Busy · 2 Shops/);
  const deleteButton = block => block.children.at(-1);
  assert.equal(deleteButton(blocks[0]).disabled, false);
  assert.equal(deleteButton(blocks[1]).disabled, true);
});

test('the page has the Shop types card in the Shop tab and the dialog with its create form', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<section[^>]*id="shopTypesCard" data-tabs="shop"/);
  assert.match(html, /<dialog[^>]*id="shopTypesModal"[\s\S]*id="newShopTypeForm"[\s\S]*id="shopTypesList"/);
});

test('a Blank type starts with one value per list and a free-text Form label', async () => {
  const { db } = fixture();
  const types = await createShopType(db, u1, { name: 'Craft', startFrom: 'blank', formLabel: 'Kind' });
  const type = byName(types, 'Craft');
  assert.deepEqual(type.lists, { form: ['General'], unit: ['pcs'], location: ['Main shelf'], strength: [] });
  assert.equal(type.formLabel, 'Kind');
  assert.equal(type.usesStrength, false);
  const grown = await changeTypeOption(db, u1, { id: type.id, list: 'form', value: 'Paint', action: 'add' });
  assert.deepEqual(byName(grown, 'Craft').lists.form, ['General', 'Paint']);
  await assert.rejects(createShopType(db, u1, { name: 'Bad', formLabel: ' ' }), /1–20/);
});

test('the Strength suggestions editor shows only for types that show Strength', async () => {
  const headings = custom => {
    const { document, nodes } = clientDom();
    const found = [];
    const walk = node => { if (node?.tagName === 'h4') found.push(node.textContent); (node?.children || []).forEach(walk); };
    return bindShopTypes({ document, api: async () => ({ builtin: [], custom }), getContext: ownerContext, getCurrentKey: () => 'medicine' }).refresh().then(() => { nodes['#shopTypesList'].children.forEach(walk); return found; });
  };
  assert.ok(!(await headings([pantry])).includes('Strength suggestions'));
  assert.ok((await headings([{ ...pantry, usesStrength: true }])).includes('Strength suggestions'));
});
