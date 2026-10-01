import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { addDefaultOption, addShopOption, removeDefaultOption, removeShopOption, setShopOptionHidden, shopOptions } from '../lib/options.js';
import { normalizeBatch } from '../lib/shared.js';
import { bindOptions } from '../public/options-client.js';
import { alertNote, restockItems, restockText } from '../public/restock-client.js';

const [user, a, b, g] = ['u1', 'shopA', 'shopB', 'shopG'];
const migrations = () => readdirSync(new URL('../migrations/', import.meta.url)).sort();
const run = (sqlite, name) => sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

function wrap(sqlite) {
  const statement = (sql, values = []) => ({ sql, values, bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  return { prepare: sql => statement(sql) };
}
function seed(sqlite) {
  sqlite.prepare('INSERT INTO users VALUES (?,?)').run(user, 't');
  for (const [id, name] of [[a, 'Alpha'], [b, 'Beta'], [g, 'Goods']]) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, name, 't');
  for (const id of [a, b, g]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, user, 'owner', 't');
  sqlite.prepare("INSERT INTO shop_types VALUES (?, 'goods')").run(g);
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations()) run(sqlite, name);
  seed(sqlite);
  return { sqlite, db: wrap(sqlite) };
}
const owner = householdId => ({ userId: user, householdId, role: 'owner' });

test('medicine Shops start with strength suggestions and goods Shops start with none', async () => {
  const { db } = fixture();
  assert.ok((await shopOptions(db, a)).lists.strength.includes('500 mg'));
  assert.deepEqual((await shopOptions(db, g)).lists.strength, []);
});

test('an Owner adds, hides and removes strength suggestions for one Shop only', async () => {
  const { db } = fixture();
  let options = await addShopOption(db, owner(a), { list: 'strength', value: '75 mg' });
  assert.ok(options.lists.strength.includes('75 mg'));
  assert.ok(!(await shopOptions(db, b)).lists.strength.includes('75 mg'));
  options = await setShopOptionHidden(db, owner(a), { list: 'strength', value: '500 mg', hidden: true });
  assert.ok(!options.lists.strength.includes('500 mg'));
  options = await removeShopOption(db, owner(a), { list: 'strength', value: '75 mg' });
  assert.ok(!options.lists.strength.includes('75 mg'));
});

test('the strength list may be emptied, but Form, Unit and Location may not', async () => {
  const { db } = fixture();
  let options = await shopOptions(db, a);
  for (const value of options.lists.strength) options = await setShopOptionHidden(db, owner(a), { list: 'strength', value, hidden: true });
  assert.deepEqual(options.lists.strength, []);
  options = await shopOptions(db, a);
  const forms = options.lists.form;
  for (const value of forms.slice(0, -1)) await setShopOptionHidden(db, owner(a), { list: 'form', value, hidden: true });
  await assert.rejects(setShopOptionHidden(db, owner(a), { list: 'form', value: forms.at(-1), hidden: true }), /at least one/);
});

test('platform defaults for strength can be added and emptied', async () => {
  const { db } = fixture();
  let all = await addDefaultOption(db, { shopType: 'goods', list: 'strength', value: '1 kg' });
  assert.deepEqual(all.goods.strength, ['1 kg']);
  all = await removeDefaultOption(db, { shopType: 'goods', list: 'strength', value: '1 kg' });
  assert.deepEqual(all.goods.strength, []);
  for (const value of ['piece', 'box', 'pack', 'bottle', 'kg']) await removeDefaultOption(db, { shopType: 'goods', list: 'unit', value });
  await assert.rejects(removeDefaultOption(db, { shopType: 'goods', list: 'unit', value: 'litre' }), /at least one/);
});

test('strength stays free text: a value outside the list still saves', () => {
  const batch = normalizeBatch({ name: 'Aspirin', quantity: 3, form: 'Tablets', unit: 'tablet', strength: '81 mg low dose' }, true, { forms: new Set(['Tablets']), units: new Set(['tablet']) });
  assert.equal(batch.strength, '81 mg low dose');
});

test('migration 0031 keeps every existing list row and Shop choice', () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations().filter(name => name < '0031')) run(sqlite, name);
  seed(sqlite);
  sqlite.prepare("INSERT INTO shop_options VALUES (?, 'unit', 'blister', 0, 1, 't')").run(a);
  sqlite.prepare("INSERT INTO shop_options VALUES (?, 'form', 'Tablets', 1, 0, 't')").run(a);
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM option_defaults').get().n;
  run(sqlite, '0031_strength_suggestions.sql');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM shop_options').get().n, 2);
  assert.equal(sqlite.prepare("SELECT hidden FROM shop_options WHERE list='form'").get().hidden, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM option_defaults').get().n, before + 6);
  assert.throws(() => sqlite.prepare("INSERT INTO shop_options VALUES (?, 'bogus', 'x', 0, 1, 't')").run(a));
});

function fakeDom() {
  const make = () => ({ children: [], closest: () => null, querySelector: () => null, replaceChildren(...items) { this.children = items; }, append(item) { this.children.push(item); }, dataset: {}, addEventListener() {}, classList: { toggle() {} } });
  const nodes = { '#strengthOptions': make(), '#strengthChips': make(), '#addMedicineForm': { elements: { form: { name: 'form', ...make() }, unit: { name: 'unit', ...make() }, location: { name: 'location', ...make() }, strength: { value: '', closest: () => null, dispatchEvent(event) { this.fired = event.type; } } } }, '#defaultStorageLocation': { name: 'location', ...make() }, '#optionsCard': { hidden: false }, '#optionsLists': make() };
  const document = { documentElement: { dataset: {} }, querySelector: selector => nodes[selector] || null, querySelectorAll: () => [], createElement: () => { const node = { ...make(), setAttribute() {} }; node.addEventListener = (type, handler) => { node.handler = handler; }; return node; } };
  return { document, nodes };
}
const lists = { form: ['Tablets'], unit: ['bottle'], location: ['Shelf'], strength: ['250 mg', '500 mg'] };
const manage = { form: [], unit: [], location: [], strength: [{ value: '250 mg', source: 'default', hidden: false }, { value: '500 mg', source: 'default', hidden: false }] };

test('the strength field offers the Shop list as suggestions', async () => {
  const { document, nodes } = fakeDom();
  const client = bindOptions({ document, api: async () => ({ shopType: 'medicine', lists, manage }), getRole: () => 'owner', toast() {}, storage: null, observe: false });
  await client.load({});
  assert.deepEqual(nodes['#strengthOptions'].children.map(option => option.value), ['250 mg', '500 mg']);
});

test('the strength suggestions also show as tap-to-fill chips', async () => {
  const { document, nodes } = fakeDom();
  const client = bindOptions({ document, api: async () => ({ shopType: 'medicine', lists, manage }), getRole: () => 'owner', toast() {}, storage: null, observe: false });
  await client.load({});
  const chips = nodes['#strengthChips'];
  assert.deepEqual(chips.children.map(chip => chip.textContent), ['250 mg', '500 mg']);
  assert.equal(chips.hidden, false);
  chips.children[1].handler();
  const input = nodes['#addMedicineForm'].elements.strength;
  assert.equal(input.value, '500 mg');
  assert.equal(input.fired, 'input');
});

test('with no suggestions the chip row stays hidden', async () => {
  const { document, nodes } = fakeDom();
  const client = bindOptions({ document, api: async () => ({ shopType: 'goods', lists: { ...lists, strength: [] }, manage }), getRole: () => 'owner', toast() {}, storage: null, observe: false });
  await client.load({});
  assert.equal(nodes['#strengthChips'].hidden, true);
});

test('the Owner list editor shows strength for medicine Shops and hides it for goods Shops', async () => {
  const headings = async shopType => {
    const { document, nodes } = fakeDom();
    const client = bindOptions({ document, api: async () => ({ shopType, lists, manage }), getRole: () => 'owner', toast() {}, storage: null, observe: false });
    await client.load({});
    return nodes['#optionsLists'].children.map(block => block.children[0].textContent);
  };
  assert.ok((await headings('medicine')).includes('Strength suggestions'));
  assert.ok(!(await headings('goods')).includes('Strength suggestions'));
});

const day = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
const batch = (name, status, quantity, threshold, expiry = day(200)) => ({ name, strength: '', form: 'Tablets', unit: 'tablet', location: '', status, quantity, low_stock_threshold: threshold, expiry_date: expiry });

test('alertNote shows the number the low-stock alert starts at', () => {
  assert.equal(alertNote({ low_stock_threshold: 4 }), 'Alert at 4');
  assert.equal(alertNote({ low_stock_threshold: '10' }), 'Alert at 10');
  assert.equal(alertNote({ low_stock_threshold: 0 }), 'Alert at 0');
  assert.equal(alertNote({}), '');
  assert.equal(alertNote({ low_stock_threshold: '' }), '');
  assert.equal(alertNote(null), '');
});

test('the Restock list names the alert number and puts the biggest shortfall first', () => {
  const items = restockItems([batch('Mild', 'low', 4, 5), batch('Severe', 'low', 1, 10), batch('Medium', 'low', 2, 6)]);
  assert.deepEqual(items.map(item => item.name), ['Severe', 'Medium', 'Mild']);
  assert.deepEqual(items.map(item => item.gap), [9, 4, 1]);
  assert.equal(items[0].reason, 'Low: 1 left (alert at 10)');
  assert.match(restockText(items), /severe tablets \(low: 1 left \(alert at 10\)\)/i);
});

test('expired and expiring items still come before low items, soonest expiry first', () => {
  const items = restockItems([batch('Low', 'low', 1, 10), batch('Soon', 'expiring', 5, 4, day(20)), batch('Sooner', 'expiring', 5, 4, day(5)), batch('Gone', 'expired', 5, 4, day(-3))]);
  assert.deepEqual(items.map(item => item.name), ['Gone', 'Sooner', 'Soon', 'Low']);
});

test('a low item without a stored alert number still lists, without a gap', () => {
  const [item] = restockItems([{ ...batch('Legacy', 'low', 2, 0), low_stock_threshold: undefined }]);
  assert.equal(item.reason, 'Low: 2 left');
  assert.equal(item.gap, 0);
});
