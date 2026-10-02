import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryDb, seedPeople } from './db-fixture.js';
import { createD1Store } from '../lib/store-d1.js';
import { parseBulk, BULK_LIMIT } from '../lib/bulk-actions.js';
import { bindBulkSelect } from '../public/bulk-select-client.js';

test('parseBulk accepts move and discard and rejects everything else', () => {
  assert.deepEqual(parseBulk({ action: 'discard', ids: ['a', 'b', 'a'] }), { action: 'discard', ids: ['a', 'b'] });
  assert.deepEqual(parseBulk({ action: 'move', ids: ['a'], location: '  Top   shelf ' }), { action: 'move', ids: ['a'], location: 'Top shelf' });
  for (const bad of [null, {}, { action: 'delete', ids: ['a'] }, { action: 'discard', ids: [] }, { action: 'discard', ids: 'a' }, { action: 'discard', ids: [5] }, { action: 'discard', ids: ['x'.repeat(65)] },
    { action: 'move', ids: ['a'] }, { action: 'move', ids: ['a'], location: '   ' }, { action: 'move', ids: ['a'], location: 'x'.repeat(101) }, { action: 'move', ids: ['a'], location: 'a\u0007b' }]) {
    assert.throws(() => parseBulk(bad), error => error.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => parseBulk({ action: 'discard', ids: Array.from({ length: BULK_LIMIT + 1 }, (_, i) => `i${i}`) }), error => error.status === 413);
  assert.equal(parseBulk({ action: 'discard', ids: Array.from({ length: BULK_LIMIT }, (_, i) => `i${i}`) }).ids.length, BULK_LIMIT);
});

const base = { quantity: 4, form: 'Tablets', unit: 'tablet', expiry_date: '2030-01-01', location: 'Medicine cabinet' };
function shops() {
  const { sqlite, db } = memoryDb();
  seedPeople(sqlite);
  const deleted = [];
  const photos = { put: async () => {}, delete: async key => { deleted.push(key); } };
  const one = createD1Store(db, photos, {}, { householdId: 'h1', userId: 'u1' });
  const two = createD1Store(db, photos, {}, { householdId: 'h2', userId: 'u3' });
  return { sqlite, db, one, two, deleted };
}

test('moving items changes their location, bumps the revision and feeds the change log', async () => {
  const { sqlite, one } = shops();
  const [a, b, c] = [await one.create({ ...base, name: 'A' }), await one.create({ ...base, name: 'B' }), await one.create({ ...base, name: 'C' })];
  const before = sqlite.prepare('SELECT count(*) n FROM batch_changes').get().n;
  assert.deepEqual(await one.bulkChange({ action: 'move', ids: [a.id, b.id], location: 'Fridge' }), { changed: 2, skipped: 0 });
  const list = Object.fromEntries((await one.list()).map(item => [item.name, item]));
  assert.equal(list.A.location, 'Fridge'); assert.equal(list.B.location, 'Fridge'); assert.equal(list.C.location, 'Medicine cabinet');
  assert.equal(list.A.revision, 2); assert.equal(list.C.revision, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM batch_changes').get().n, before + 2);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM stock_events WHERE kind<>'added'").get().n, 0, 'moving is not a stock change');
  assert.ok(c.id);
});

test('discarding items removes them, their reminders and photos, and records the stock history', async () => {
  const { sqlite, one, deleted } = shops();
  const a = await one.create({ ...base, name: 'A', photo: 'data:image/jpeg;base64,/9j/' });
  const b = await one.create({ ...base, name: 'B' });
  const keep = await one.create({ ...base, name: 'Keep' });
  sqlite.prepare("INSERT INTO notifications (id,batch_id,household_id,kind,trigger_date,created_at) VALUES ('n1',?,'h1','expiry_30','2030-01-01','t')").run(a.id);
  assert.deepEqual(await one.bulkChange({ action: 'discard', ids: [a.id, b.id] }), { changed: 2, skipped: 0 });
  assert.deepEqual((await one.list()).map(item => item.name), ['Keep']);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM notifications WHERE batch_id=?").get(a.id).n, 0);
  assert.equal(deleted.length, 1);
  assert.deepEqual(sqlite.prepare("SELECT item_name,change,quantity_after FROM stock_events WHERE kind='discarded' ORDER BY item_name").all().map(row => ({ ...row })), [{ item_name: 'A', change: -4, quantity_after: 0 }, { item_name: 'B', change: -4, quantity_after: 0 }]);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM batch_changes WHERE kind='remove'").get().n, 2);
  assert.ok(keep.id);
});

test('unknown, repeated, already discarded and other-Shop ids are skipped, never an error', async () => {
  const { one, two } = shops();
  const mine = await one.create({ ...base, name: 'Mine' });
  const theirs = await two.create({ ...base, name: 'Theirs' });
  assert.deepEqual(await one.bulkChange({ action: 'discard', ids: [theirs.id, 'nope'] }), { changed: 0, skipped: 2 });
  assert.equal((await two.list()).length, 1, 'another Shop is never touched');
  assert.deepEqual(await one.bulkChange({ action: 'move', ids: [mine.id, theirs.id, mine.id], location: 'Shelf' }), { changed: 1, skipped: 1 });
  await one.bulkChange({ action: 'discard', ids: [mine.id] });
  assert.deepEqual(await one.bulkChange({ action: 'discard', ids: [mine.id] }), { changed: 0, skipped: 1 });
  await assert.rejects(one.bulkChange({ action: 'move', ids: [mine.id] }), /where to move/);
});

/* Client */
function dom() {
  const make = (extra = {}) => ({ hidden: false, disabled: false, textContent: '', children: [], listeners: {}, attrs: {}, classes: new Set(), dataset: {},
    classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); } }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...items) { this.children = items; }, open: false, showModal() { this.open = true; }, close() { this.open = false; }, ...extra });
  const withClasses = node => { node.classList = { toggle: (name, on) => { on ? node.classes.add(name) : node.classes.delete(name); }, contains: name => node.classes.has(name) }; return node; };
  const nodes = {};
  for (const id of ['inventoryView', 'bulkToggle', 'bulkBar', 'bulkCount', 'bulkAll', 'bulkMove', 'bulkDiscard', 'bulkCancel', 'bulkMoveModal', 'bulkMoveLocation', 'bulkMoveConfirm', 'bulkMoveStatus', 'bulkMoveText', 'bulkDiscardModal', 'bulkDiscardText', 'bulkDiscardConfirm', 'bulkDiscardStatus']) nodes[`#${id}`] = withClasses(make());
  const rowNodes = ['a', 'b', 'c'].map(id => withClasses(make({ dataset: { batchId: id }, closest(selector) { return this; } })));
  nodes['#inventoryView'].querySelectorAll = () => rowNodes;
  const captured = {};
  const document = { querySelector: selector => nodes[selector], createElement: () => make(), addEventListener: (type, fn) => { captured[type] = fn; } };
  return { document, nodes, rowNodes, captured };
}
const click = (captured, row) => { let stopped = false; captured.click({ target: row, preventDefault() {}, stopPropagation() { stopped = true; } }); return stopped; };

test('select mode ticks rows instead of opening them, selects all, and clears when cancelled', () => {
  const { document, nodes, rowNodes, captured } = dom();
  const records = ['a', 'b', 'c'].map(id => ({ id }));
  const bulk = bindBulkSelect({ document, api: async () => ({}), getRecords: () => records, getLocations: () => [], toast() {} });
  assert.equal(click(captured, rowNodes[0]), false, 'normal taps still open the item');
  nodes['#bulkToggle'].listeners.click();
  assert.equal(nodes['#bulkBar'].hidden, false);
  assert.equal(nodes['#bulkMove'].disabled, true);
  assert.equal(click(captured, rowNodes[0]), true, 'in select mode the page handler never sees the tap');
  assert.equal(rowNodes[0].classes.has('selected'), true);
  assert.equal(nodes['#bulkCount'].textContent, '1 item selected');
  assert.equal(nodes['#bulkMove'].disabled, false);
  click(captured, rowNodes[0]);
  assert.equal(nodes['#bulkCount'].textContent, 'Tap items to select them');
  nodes['#bulkAll'].listeners.click();
  assert.deepEqual(bulk.selected, ['a', 'b', 'c']);
  assert.equal(nodes['#bulkAll'].textContent, 'Clear selection');
  nodes['#bulkCancel'].listeners.click();
  assert.deepEqual(bulk.selected, []);
  assert.equal(nodes['#bulkBar'].hidden, true);
  assert.equal(rowNodes[0].classes.has('selected'), false);
});

test('moving the selection posts the ids and location, then refreshes and leaves select mode', async () => {
  const { document, nodes, rowNodes, captured } = dom();
  const sent = [], toasts = [], done = [];
  const bulk = bindBulkSelect({ document, api: async (path, options) => { sent.push([path, JSON.parse(options.body)]); return { changed: 2, skipped: 1 }; }, getRecords: () => ['a', 'b', 'c'].map(id => ({ id })), getLocations: () => ['Fridge', 'Shelf'], onDone: () => done.push(1), toast: message => toasts.push(message) });
  nodes['#bulkToggle'].listeners.click();
  click(captured, rowNodes[0]); click(captured, rowNodes[1]);
  nodes['#bulkMove'].listeners.click();
  assert.equal(nodes['#bulkMoveModal'].open, true);
  assert.equal(nodes['#bulkMoveText'].textContent, 'Move 2 items to:');
  nodes['#bulkMoveLocation'].value = 'Shelf';
  await nodes['#bulkMoveConfirm'].listeners.click();
  assert.deepEqual(sent, [['/api/batches/bulk', { action: 'move', ids: ['a', 'b'], location: 'Shelf' }]]);
  assert.equal(toasts[0], 'Moved 2 items to Shelf. Skipped 1 that no longer exists.');
  assert.equal(done.length, 1);
  assert.equal(nodes['#bulkMoveModal'].open, false);
  assert.equal(bulk.active, false);
});

test('discarding asks first, and a failure keeps the dialog and the selection', async () => {
  const { document, nodes, rowNodes, captured } = dom();
  let fail = Object.assign(new Error('Failed to fetch'), { status: 0 });
  const sent = [];
  const bulk = bindBulkSelect({ document, api: async (path, options) => { sent.push(JSON.parse(options.body)); if (fail) throw fail; return { changed: 1, skipped: 0 }; }, getRecords: () => [{ id: 'a' }], getLocations: () => [], toast() {} });
  nodes['#bulkToggle'].listeners.click();
  click(captured, rowNodes[0]);
  nodes['#bulkDiscard'].listeners.click();
  assert.match(nodes['#bulkDiscardText'].textContent, /Discard 1 item\?.*cannot be undone/);
  assert.equal(sent.length, 0, 'nothing is sent until confirmed');
  await nodes['#bulkDiscardConfirm'].listeners.click();
  assert.match(nodes['#bulkDiscardStatus'].textContent, /needs a connection/);
  assert.deepEqual(bulk.selected, ['a']);
  assert.equal(nodes['#bulkDiscardModal'].open, true);
  fail = null;
  await nodes['#bulkDiscardConfirm'].listeners.click();
  assert.deepEqual(sent.at(-1), { action: 'discard', ids: ['a'] });
  assert.equal(bulk.active, false);
});

test('the page has the select toggle, action bar and both dialogs', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['bulkToggle', 'bulkBar', 'bulkMoveModal', 'bulkMoveLocation', 'bulkDiscardModal', 'bulkDiscardConfirm']) assert.match(html, new RegExp(`id="${id}"`));
});

test('each new control sits inside the screen it belongs to', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const at = text => { const index = html.indexOf(text); assert.ok(index >= 0, text); return index; };
  const inside = (id, start, end) => { const from = at(start), to = html.indexOf(end, from); assert.ok(at(`id="${id}"`) > from && at(`id="${id}"`) < to, `${id} is inside ${start}`); };
  inside('bulkToggle', 'id="inventoryView"', 'id="overviewView"');
  inside('bulkBar', 'id="inventoryView"', 'id="overviewView"');
  inside('shopHistory', 'id="notificationsView"', 'id="profileView"');
  inside('batchHistory', 'id="batchModal"', '</dialog>');
  inside('importInventorySection', 'id="profileView"', 'id="batchModal"');
});

/* Change form and copy to another Shop */
import { setShopType } from '../lib/options.js';
import { parseCopy } from '../lib/bulk-actions.js';

test('parseBulk and parseCopy validate the new actions', () => {
  assert.deepEqual(parseBulk({ action: 'form', ids: ['a'], form: ' Syrup ' }), { action: 'form', ids: ['a'], form: 'Syrup' });
  for (const bad of [{ action: 'form', ids: ['a'] }, { action: 'form', ids: ['a'], form: '  ' }, { action: 'form', ids: ['a'], form: 'x'.repeat(31) }]) assert.throws(() => parseBulk(bad), error => error.status === 400);
  assert.deepEqual(parseCopy({ ids: ['a', 'a', 'b'], targetShopId: 'h2' }), { ids: ['a', 'b'], targetShopId: 'h2' });
  for (const bad of [null, {}, { ids: [], targetShopId: 'h2' }, { ids: ['a'] }, { ids: ['a'], targetShopId: '' }, { ids: [1], targetShopId: 'h2' }]) assert.throws(() => parseCopy(bad), error => error.status === 400);
  assert.throws(() => parseCopy({ ids: Array.from({ length: BULK_LIMIT + 1 }, (_, i) => `i${i}`), targetShopId: 'h2' }), error => error.status === 413);
});

test('changing the form sets it on every selected item, matching the Shop list ignoring case', async () => {
  const { sqlite, one } = shops();
  const a = await one.create({ ...base, name: 'A' }), b = await one.create({ ...base, name: 'B' });
  assert.deepEqual(await one.bulkChange({ action: 'form', ids: [a.id, b.id], form: 'syrup' }), { changed: 2, skipped: 0 });
  assert.deepEqual((await one.list()).map(item => item.form), ['Syrup', 'Syrup']);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM batch_changes WHERE revision=2").get().n, 2);
  await assert.rejects(one.bulkChange({ action: 'form', ids: [a.id], form: 'Not a form' }), /not in this Shop/);
  assert.equal((await one.list())[0].form, 'Syrup');
});

function twoShops({ targetGoods = false, role = 'member' } = {}) {
  const ctx = shops();
  ctx.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run('h2', 'u1', role, 't');
  return ctx;
}

test('copying adds new items to the other Shop, keeps the originals, and records history there', async () => {
  const { sqlite, one, two } = twoShops();
  const a = await one.create({ ...base, name: 'A', strength: '5 mg', notes: 'n', low_stock_threshold: 2, photo: 'data:image/jpeg;base64,/9j/' });
  const b = await one.create({ ...base, name: 'B', quantity: 9 });
  assert.deepEqual(await one.copyToShop({ ids: [a.id, b.id], targetShopId: 'h2' }), { copied: 2, skipped: 0 });
  assert.equal((await one.list()).length, 2, 'originals stay');
  const copies = await two.list();
  assert.deepEqual(copies.map(item => [item.name, item.quantity, item.strength, item.notes, item.low_stock_threshold, item.has_photo]), [['A', 4, '5 mg', 'n', 2, false], ['B', 9, '', '', 4, false]]);
  assert.notEqual(copies[0].id, a.id);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM batch_changes WHERE household_id='h2'").get().n, 2);
  assert.deepEqual(sqlite.prepare("SELECT item_name,kind,change FROM stock_events WHERE household_id='h2' ORDER BY item_name").all().map(row => ({ ...row })), [{ item_name: 'A', kind: 'added', change: 4 }, { item_name: 'B', kind: 'added', change: 9 }]);
});

test('copy is refused for non-members, the same Shop, unknown items and lists that do not fit, all without side effects', async () => {
  const { sqlite, db, one, two } = shops();
  const a = await one.create({ ...base, name: 'A' });
  await assert.rejects(one.copyToShop({ ids: [a.id], targetShopId: 'h2' }), error => error.status === 403);
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run('h2', 'u1', 'member', 't');
  await assert.rejects(one.copyToShop({ ids: [a.id], targetShopId: 'h1' }), /different Shop/);
  await assert.rejects(one.copyToShop({ ids: ['nope'], targetShopId: 'h2' }), error => error.status === 404);
  await setShopType(db, { userId: 'u3', householdId: 'h2', role: 'owner' }, 'goods');
  await assert.rejects(one.copyToShop({ ids: [a.id], targetShopId: 'h2' }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.problems[0].name, 'A');
    assert.match(error.problems[0].message, /other Shop’s Form list/);
    assert.match(error.message, /Nothing was copied/);
    return true;
  });
  assert.equal((await two.list()).length, 0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM stock_events WHERE household_id='h2'").get().n, 0);
});

test('items from another Shop cannot be copied by id', async () => {
  const { one, two } = twoShops();
  const theirs = await two.create({ ...base, name: 'Theirs' });
  await assert.rejects(one.copyToShop({ ids: [theirs.id], targetShopId: 'h2' }), error => error.status === 404);
});

test('the bar offers Change form and Copy to Shop, and posts to the right routes', async () => {
  const { document, nodes, rowNodes, captured } = dom();
  for (const id of ['bulkForm', 'bulkFormModal', 'bulkFormValue', 'bulkFormConfirm', 'bulkFormStatus', 'bulkFormText', 'bulkCopy', 'bulkCopyModal', 'bulkCopyShop', 'bulkCopyConfirm', 'bulkCopyStatus', 'bulkCopyText', 'bulkCopyProblems']) {
    nodes[`#${id}`] = { hidden: false, disabled: false, textContent: '', children: [], listeners: {}, value: '', open: false, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...items) { this.children = items; }, showModal() { this.open = true; }, close() { this.open = false; } };
  }
  const sent = [], toasts = [];
  let fail = null;
  bindBulkSelect({ document, api: async (path, options) => { sent.push([path, JSON.parse(options.body)]); if (fail) throw fail; return { changed: 2, copied: 2, skipped: 0 }; }, getRecords: () => ['a', 'b', 'c'].map(id => ({ id })), getLocations: () => [],
    getForms: () => ['Tablets', 'Syrup'], getFormLabel: () => 'Category', getShops: () => [{ id: 's2', name: 'Second' }], toast: message => toasts.push(message) });
  nodes['#bulkToggle'].listeners.click();
  assert.equal(nodes['#bulkForm'].textContent, 'Change category…');
  assert.equal(nodes['#bulkCopy'].hidden, false);
  click(captured, rowNodes[0]); click(captured, rowNodes[1]);
  nodes['#bulkForm'].listeners.click();
  assert.equal(nodes['#bulkFormText'].textContent, 'Set the category of 2 items to:');
  nodes['#bulkFormValue'].value = 'Syrup';
  await nodes['#bulkFormConfirm'].listeners.click();
  assert.deepEqual(sent[0], ['/api/batches/bulk', { action: 'form', ids: ['a', 'b'], form: 'Syrup' }]);
  assert.equal(toasts[0], 'Changed the category of 2 items to Syrup.');
  nodes['#bulkToggle'].listeners.click();
  click(captured, rowNodes[2]);
  nodes['#bulkCopy'].listeners.click();
  assert.equal(nodes['#bulkCopyText'].textContent, 'Copy 1 item to:');
  nodes['#bulkCopyShop'].value = 's2';
  fail = Object.assign(new Error('Nothing was copied. 1 item does not fit the other Shop’s lists.'), { status: 422, problems: [{ row: 2, name: 'C', message: 'Form “Tablets” is not in the other Shop’s Form list.' }] });
  await nodes['#bulkCopyConfirm'].listeners.click();
  assert.deepEqual(sent[1], ['/api/batches/copy', { ids: ['c'], targetShopId: 's2' }]);
  assert.match(nodes['#bulkCopyStatus'].textContent, /Nothing was copied/);
  assert.equal(nodes['#bulkCopyProblems'].children[0].textContent, 'C: Form “Tablets” is not in the other Shop’s Form list.');
  assert.equal(nodes['#bulkCopyModal'].open, true);
  fail = null;
  await nodes['#bulkCopyConfirm'].listeners.click();
  assert.equal(toasts.at(-1), 'Copied 2 items to Second. The originals stay here.');
  assert.equal(nodes['#bulkCopyModal'].open, false);
});

test('Copy to Shop is hidden when there is no other Shop', () => {
  const { document, nodes } = dom();
  nodes['#bulkCopy'] = { hidden: false, disabled: false, textContent: '', addEventListener() {} };
  nodes['#bulkForm'] = { hidden: false, disabled: false, textContent: '', addEventListener() {} };
  bindBulkSelect({ document, api: async () => ({}), getRecords: () => [], getLocations: () => [], getShops: () => [], toast() {} }).refresh();
  assert.equal(nodes['#bulkCopy'].hidden, true);
});
