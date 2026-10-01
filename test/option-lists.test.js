import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createD1Store } from '../lib/store-d1.js';
import { addDefaultOption, addShopOption, removeDefaultOption, removeShopOption, setShopOptionHidden, setShopType, shopOptions } from '../lib/options.js';
import { createAdditionalShop } from '../lib/tenants.js';
import { ownerOverview, ownerOverviewCsv } from '../lib/overview.js';
import { goodsWording } from '../public/options-client.js';
import { escapeHtml, reportHtml } from '../public/overview-client.js';

const [user, a, b, c] = ['u1', 'shopA', 'shopB', 'shopC'];
const principal = { provider: 'access', subject: 's1', email: 'o@x.com' };

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO users VALUES (?,?)').run(user, 't');
  sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('access', 's1', user, 'o@x.com', 't');
  for (const [id, name] of [[a, 'Alpha'], [b, 'Beta'], [c, 'Gamma']]) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, name, 't');
  for (const [id, role] of [[a, 'owner'], [b, 'owner'], [c, 'member']]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, user, role, 't');
  const statement = (sql, values = []) => ({ sql, values, bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = {
    prepare: sql => statement(sql),
    batch: async statements => {
      const out = [];
      sqlite.exec('BEGIN');
      try { for (const s of statements) out.push({ meta: { changes: sqlite.prepare(s.sql).run(...s.values).changes } }); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      return out;
    }
  };
  return { sqlite, db };
}
const owner = householdId => ({ userId: user, householdId, role: 'owner' });

test('a Shop starts from the defaults; Owners add and hide options without touching other Shops', async () => {
  const { db } = fixture();
  let options = await shopOptions(db, a);
  assert.equal(options.shopType, 'medicine');
  assert.ok(options.lists.unit.includes('bottle'));
  options = await addShopOption(db, owner(a), { list: 'unit', value: 'blister' });
  assert.ok(options.lists.unit.includes('blister'));
  options = await setShopOptionHidden(db, owner(a), { list: 'unit', value: 'dose', hidden: true });
  assert.ok(!options.lists.unit.includes('dose'));
  const other = await shopOptions(db, b);
  assert.ok(other.lists.unit.includes('dose') && !other.lists.unit.includes('blister'));
  await assert.rejects(addShopOption(db, owner(a), { list: 'unit', value: 'BLISTER' }), /already/);
  options = await setShopOptionHidden(db, owner(a), { list: 'unit', value: 'dose', hidden: false });
  assert.ok(options.lists.unit.includes('dose'));
  options = await removeShopOption(db, owner(a), { list: 'unit', value: 'blister' });
  assert.ok(!options.lists.unit.includes('blister'));
  await assert.rejects(removeShopOption(db, owner(a), { list: 'unit', value: 'bottle' }), /custom/);
});

test('only Owners change lists, values are validated, and a list keeps one option', async () => {
  const { db } = fixture();
  await assert.rejects(addShopOption(db, { userId: user, householdId: c, role: 'member' }, { list: 'unit', value: 'x' }), /Owners/);
  await assert.rejects(addShopOption(db, { userId: user, householdId: c, role: 'owner' }, { list: 'unit', value: 'x' }), /Owners/);
  await assert.rejects(addShopOption(db, owner(a), { list: 'nope', value: 'x' }), /valid list/);
  await assert.rejects(addShopOption(db, owner(a), { list: 'unit', value: '  ' }), /1–30/);
  await assert.rejects(addShopOption(db, owner(a), { list: 'unit', value: 'x'.repeat(31) }), /1–30/);
  for (const value of ['bottle', 'sachet', 'tube', 'pack', 'tablet', 'capsule', 'dose']) await setShopOptionHidden(db, owner(a), { list: 'unit', value, hidden: true });
  await assert.rejects(setShopOptionHidden(db, owner(a), { list: 'unit', value: 'piece', hidden: true }), /at least one/);
});

test('create and edit use the Shop lists, and old values stay editable', async () => {
  const { db } = fixture();
  const store = createD1Store(db, null, {}, { householdId: a, userId: user });
  const base = { name: 'Para', quantity: 5, form: 'Tablets', unit: 'bottle', expiry_date: '2030-01-01', location: 'Medicine cabinet' };
  await setShopOptionHidden(db, owner(a), { list: 'unit', value: 'sachet', hidden: true });
  await assert.rejects(store.create({ ...base, unit: 'sachet' }), /Invalid/);
  const created = await store.create(base);
  await setShopOptionHidden(db, owner(a), { list: 'unit', value: 'bottle', hidden: true });
  assert.equal((await store.update(created.id, { quantity: 4 })).quantity, 4);
  await assert.rejects(store.create(base), /Invalid/);
  assert.equal((await store.create({ ...base, unit: 'tablets' })).unit, 'tablets', 'legacy plural units stay accepted');
});

test('Shop type: default location is checked against the type, and goods Shops start with goods lists', async () => {
  const { db, sqlite } = fixture();
  const store = createD1Store(db, null, {}, { householdId: a, userId: user });
  assert.equal((await store.settings()).shop_type, 'medicine');
  await assert.rejects(store.updateSettings({ display_name: 'X', household_name: 'Y', default_storage_location: 'Shelf' }), /valid default/);
  await assert.rejects(setShopType(db, { userId: user, householdId: a, role: 'member' }, 'goods'), /Owners/);
  await assert.rejects(setShopType(db, owner(a), 'other'), /valid Shop type/);
  await setShopType(db, owner(a), 'goods');
  assert.equal((await store.updateSettings({ display_name: 'X', household_name: 'Y', default_storage_location: 'Shelf' })).shop_type, 'goods');
  const made = await createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-000000000001', shopName: 'Hardware', displayName: 'Me', shopType: 'goods' });
  const created = await shopOptions(db, made.shop.id);
  assert.equal(created.shopType, 'goods');
  assert.ok(created.lists.unit.includes('box'));
  assert.equal(sqlite.prepare('SELECT default_storage_location d FROM household_settings WHERE household_id=?').get(made.shop.id).d, 'Shelf');
  await assert.rejects(createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-000000000002', shopName: 'Bad', displayName: 'Me', shopType: 'x' }), /valid Shop type/);
});

test('platform defaults can be added and removed but never emptied', async () => {
  const { db } = fixture();
  let defaults = await addDefaultOption(db, { shopType: 'goods', list: 'unit', value: 'crate' });
  assert.ok(defaults.goods.unit.includes('crate'));
  await assert.rejects(addDefaultOption(db, { shopType: 'goods', list: 'unit', value: 'Crate' }), /already/);
  defaults = await removeDefaultOption(db, { shopType: 'goods', list: 'unit', value: 'crate' });
  assert.ok(!defaults.goods.unit.includes('crate'));
  for (const value of ['pack', 'bottle', 'kg', 'litre', 'box']) await removeDefaultOption(db, { shopType: 'goods', list: 'unit', value });
  await assert.rejects(removeDefaultOption(db, { shopType: 'goods', list: 'unit', value: 'piece' }), /at least one/);
  await assert.rejects(addDefaultOption(db, { shopType: 'nope', list: 'unit', value: 'x' }), /valid Shop type/);
});

test('the overview covers only owned Shops, with counts and a combined CSV', async () => {
  const { db, sqlite } = fixture();
  const add = (id, household, fields) => sqlite.prepare('INSERT INTO batches (id,household_id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, household, fields.name, '', 'Tablets', fields.quantity, 'bottle', fields.expiry, '', '', 4, 't', 't');
  add('1', a, { name: 'Old', quantity: 2, expiry: '2020-01-01' });
  add('2', b, { name: '=Formula', quantity: 9, expiry: '2026-10-05' });
  add('3', c, { name: 'Member only', quantity: 9, expiry: '2030-01-01' });
  sqlite.prepare("UPDATE batches SET discarded_at='t' WHERE id='1'").run();
  add('4', a, { name: 'Gone', quantity: 0, expiry: '2030-01-01' });
  add('5', a, { name: 'Fresh', quantity: 9, expiry: '2030-01-01' });
  const overview = await ownerOverview(db, principal, () => new Date('2026-09-30T00:00:00Z'));
  assert.deepEqual(overview.shops.map(shop => shop.name), ['Alpha', 'Beta']);
  assert.deepEqual(overview.items.map(item => item.name).sort(), ['=Formula', 'Fresh']);
  assert.equal(overview.shops[0].counts.total, 1);
  assert.equal(overview.shops[1].counts.expiring, 1);
  const csv = await ownerOverviewCsv(db, principal, () => new Date('2026-09-30T00:00:00Z'));
  assert.match(csv.csv, /^﻿shop,name,/);
  assert.match(csv.csv, /'=Formula/);
  assert.equal(csv.filename, 'all-shops-inventory-2026-09-30.csv');
  await assert.rejects(ownerOverview(db, { provider: 'access', subject: 'nobody' }), /Owners/);
  sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id IN (?,?)").run(a, b);
  await assert.rejects(ownerOverview(db, principal), /Owners/);
});

test('goods wording rewords medicine text but keeps the brand', () => {
  assert.equal(goodsWording('Add medicine to your medicine cabinet. Medicines: a medicine. Medicine Tracker'), 'Add item to your inventory. Items: an item. Medicine Tracker');
  assert.equal(goodsWording('YOUR MEDICINE CABINET'), 'YOUR INVENTORY');
});

test('the report escapes Shop and item names', () => {
  assert.equal(escapeHtml('<b>"&\''), '&lt;b&gt;&quot;&amp;&#39;');
  const html = reportHtml({ generatedAt: '2026-09-30T00:00:00Z', shops: [{ id: 'a', name: 'A <script>', counts: { total: 1, expired: 0, expiring: 0, low: 0 }, truncated: false }], items: [{ shopId: 'a', name: '<img onerror=x>', strength: '', quantity: 1, unit: 'box', expiry_date: null, location: '', status: 'healthy' }] });
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.ok(html.includes('A &lt;script&gt;'));
});

test('a Shop-wide default low-stock alert fills new items and is validated', async () => {
  const { db } = fixture();
  const store = createD1Store(db, null, {}, { householdId: a, userId: user });
  const base = { name: 'Para', quantity: 5, form: 'Tablets', unit: 'bottle', expiry_date: '2030-01-01', location: 'Medicine cabinet' };
  assert.equal((await store.settings()).default_low_stock_threshold, 4);
  assert.equal((await store.create(base)).low_stock_threshold, 4);
  const profile = { display_name: 'X', household_name: 'Y', default_storage_location: 'Medicine cabinet' };
  assert.equal((await store.updateSettings({ ...profile, default_low_stock_threshold: '12' })).default_low_stock_threshold, 12);
  assert.equal((await store.create({ ...base, name: 'Ibu' })).low_stock_threshold, 12);
  assert.equal((await store.create({ ...base, name: 'Zinc', low_stock_threshold: 2 })).low_stock_threshold, 2);
  assert.equal((await store.create({ ...base, name: 'Zero', low_stock_threshold: 0 })).low_stock_threshold, 0);
  assert.equal((await store.updateSettings(profile)).default_low_stock_threshold, 12, 'omitting it keeps the saved value');
  for (const bad of ['-1', '1.5', 'abc', '1000001']) await assert.rejects(store.updateSettings({ ...profile, default_low_stock_threshold: bad }), /whole number/);
  assert.equal((await store.settings()).default_low_stock_threshold, 12);
  const other = createD1Store(db, null, {}, { householdId: b, userId: user });
  assert.equal((await other.settings()).default_low_stock_threshold, 4, 'another Shop is unaffected');
});
