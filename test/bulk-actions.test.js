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
  return { sqlite, one, two, deleted };
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
