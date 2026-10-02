import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, seedPeople } from './db-fixture.js';
import { createD1Store } from '../lib/store-d1.js';

const base = { name: 'Para', quantity: 10, form: 'Tablets', unit: 'tablet', expiry_date: '2030-01-01', location: 'Medicine cabinet' };
function shop(clockAt = '2026-06-15T12:00:00.000Z') {
  const { sqlite, db } = memoryDb();
  seedPeople(sqlite);
  const clock = { at: new Date(clockAt) };
  const store = createD1Store(db, null, {}, { householdId: 'h1', userId: 'u1' }, () => clock.at);
  const rows = (sql = 'SELECT kind,change,quantity_after,item_name,unit FROM stock_events ORDER BY id') => sqlite.prepare(sql).all().map(row => ({ ...row }));
  return { sqlite, db, store, clock, rows };
}
const op = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;

test('adding, using, editing the quantity and discarding each leave one history row', async () => {
  const { store, rows } = shop();
  const item = await store.create(base);
  await store.consume(item.id, 3);
  await store.update(item.id, { quantity: 12 });
  await store.update(item.id, { notes: 'only a note' });
  await store.discard(item.id);
  assert.deepEqual(rows(), [
    { kind: 'added', change: 10, quantity_after: 10, item_name: 'Para', unit: 'tablet' },
    { kind: 'used', change: -3, quantity_after: 7, item_name: 'Para', unit: 'tablet' },
    { kind: 'adjusted', change: 5, quantity_after: 12, item_name: 'Para', unit: 'tablet' },
    { kind: 'discarded', change: -12, quantity_after: 0, item_name: 'Para', unit: 'tablet' }
  ]);
});

test('a failed change records nothing', async () => {
  const { store, rows } = shop();
  const item = await store.create(base);
  await assert.rejects(store.consume(item.id, 99), /Not enough/);
  await assert.rejects(store.discard('missing'), /not found/);
  assert.equal(rows().length, 1);
});

test('offline-sync mutations record once, replays and stale edits add nothing', async () => {
  const { store, rows } = shop();
  const created = await store.create({ ...base, operationId: op(1), baseRevision: 0 });
  await store.create({ ...base, operationId: op(1), baseRevision: 0 });
  const used = await store.consume(created.id, { amount: 4, operationId: op(2), baseRevision: 1 });
  await store.consume(created.id, { amount: 4, operationId: op(2), baseRevision: 1 });
  await assert.rejects(store.consume(created.id, { amount: 1, operationId: op(3), baseRevision: 1 }), /changed elsewhere/);
  await store.update(created.id, { quantity: 2, operationId: op(4), baseRevision: used.revision });
  await store.discard(created.id, { operationId: op(5), baseRevision: used.revision + 1 });
  assert.deepEqual(rows().map(row => [row.kind, row.change, row.quantity_after]), [['added', 10, 10], ['used', -4, 6], ['adjusted', -4, 2], ['discarded', -2, 0]]);
});

test('an import records every item as added', async () => {
  const { store, rows } = shop();
  await store.importBatches([{ name: 'A', quantity: '3', form: 'Tablets', unit: 'tablet' }, { name: 'B', quantity: '5', form: 'Syrup', unit: 'bottle' }]);
  assert.deepEqual(rows().map(row => [row.item_name, row.kind, row.change]), [['A', 'added', 3], ['B', 'added', 5]]);
});

test('history is newest first, can be limited to one item, sums 30-day use, and stays inside the Shop', async () => {
  const { sqlite, db, store, clock } = shop('2026-05-01T12:00:00.000Z');
  const a = await store.create(base);
  const b = await store.create({ ...base, name: 'Ibu' });
  await store.consume(a.id, 2);
  clock.at = new Date('2026-06-20T12:00:00.000Z');
  await store.consume(a.id, 3);
  await store.consume(b.id, 1);
  await store.update(a.id, { name: 'Renamed' });
  const all = await store.stockHistory();
  assert.equal(all.events.length, 5);
  assert.deepEqual(all.events.map(event => event.kind), ['used', 'used', 'used', 'added', 'added']);
  assert.equal(all.usedLast30Days, 4, 'the 2 used on 1 May is outside the window');
  const one = await store.stockHistory({ batchId: a.id });
  assert.deepEqual(one.events.map(event => [event.kind, event.change]), [['used', -3], ['used', -2], ['added', 10]]);
  assert.equal(one.usedLast30Days, 3);
  assert.equal(one.events[0].item_name, 'Para', 'the name at the time is kept');
  assert.equal((await store.stockHistory({ limit: 2 })).events.length, 2);
  assert.equal((await store.stockHistory({ limit: 5000 })).events.length, 5, 'limit is capped');
  assert.equal((await store.stockHistory({ limit: 'x' })).events.length, 5);
  const other = createD1Store(db, null, {}, { householdId: 'h2', userId: 'u3' });
  assert.deepEqual(await other.stockHistory(), { events: [], usedLast30Days: 0 });
  assert.deepEqual((await other.stockHistory({ batchId: a.id })).events, [], 'another Shop cannot read an item by id');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM stock_events WHERE household_id='h2'").get().n, 0);
});

/* Client */
import { readFileSync } from 'node:fs';
import { bindStockHistory, describeEvent, whenText } from '../public/stock-history-client.js';

const event = (kind, change, after, extra = {}) => ({ id: 1, batch_id: 'b1', item_name: 'Para', unit: 'tablet', kind, change, quantity_after: after, created_at: '2026-06-15T12:00:00.000Z', ...extra });

test('each kind of change reads as one plain sentence', () => {
  assert.equal(describeEvent(event('added', 10, 10)), 'Added 10 tablet · 10 tablet now');
  assert.equal(describeEvent(event('used', -3, 7)), 'Used 3 tablet · 7 tablet now');
  assert.equal(describeEvent(event('adjusted', 5, 12)), 'Quantity raised by 5 tablet · 12 tablet now');
  assert.equal(describeEvent(event('adjusted', -2, 8)), 'Quantity lowered by 2 tablet · 8 tablet now');
  assert.equal(describeEvent(event('discarded', -12, 0)), 'Discarded 12 tablet');
  assert.equal(describeEvent(event('used', -1, 1), { withName: true }), 'Para: Used 1 tablet · 1 tablet now');
});

test('times read as Today or a short date, and bad dates give nothing', () => {
  const now = new Date('2026-06-15T18:00:00.000Z');
  assert.match(whenText('2026-06-15T12:00:00.000Z', now), /^Today, /);
  assert.doesNotMatch(whenText('2026-03-02T12:00:00.000Z', now), /2026/);
  assert.match(whenText('2025-03-02T12:00:00.000Z', now), /2025/);
  assert.equal(whenText('nope', now), '');
});

function historyDom() {
  const mk = () => ({ hidden: true, textContent: '', children: [], className: '', replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); } });
  const nodes = Object.fromEntries(['#batchHistory', '#batchUsage', '#batchHistoryList', '#shopHistory', '#shopHistoryList', '#shopHistoryUsage'].map(id => [id, mk()]));
  return { nodes, document: { querySelector: id => nodes[id], createElement: mk } };
}

test('the item and Shop lists fill from the server and hide when empty or offline', async () => {
  const { nodes, document } = historyDom();
  const requests = [];
  let reply = { events: [event('used', -3, 7)], usedLast30Days: 3 };
  const history = bindStockHistory({ document, api: async path => { requests.push(path); if (reply instanceof Error) throw reply; return reply; }, now: () => new Date('2026-06-15T18:00:00.000Z') });
  await history.showItem('b 1');
  assert.equal(requests[0], '/api/stock-events?batch=b%201&limit=20');
  assert.equal(nodes['#batchHistory'].hidden, false);
  assert.equal(nodes['#batchUsage'].textContent, 'Used 3 in the last 30 days.');
  assert.equal(nodes['#batchHistoryList'].children[0].children[0].textContent, 'Used 3 tablet · 7 tablet now');
  await history.showShop();
  assert.equal(requests[1], '/api/stock-events?limit=50');
  assert.equal(nodes['#shopHistoryList'].children[0].children[0].textContent, 'Para: Used 3 tablet · 7 tablet now');
  reply = { events: [], usedLast30Days: 0 };
  await history.showItem('b1');
  assert.equal(nodes['#batchHistory'].hidden, true);
  reply = new Error('Failed to fetch');
  await history.showItem('b1'); await history.showShop();
  assert.equal(nodes['#batchHistory'].hidden, true);
  assert.equal(nodes['#shopHistory'].hidden, true);
});

test('a slow answer for an item that is no longer open is ignored', async () => {
  const { nodes, document } = historyDom();
  const waiting = [];
  const history = bindStockHistory({ document, api: path => new Promise(resolve => waiting.push([path, resolve])) });
  const first = history.showItem('a'), second = history.showItem('b');
  waiting[1][1]({ events: [event('added', 1, 1, { item_name: 'B' })], usedLast30Days: 0 });
  await second;
  waiting[0][1]({ events: [event('added', 9, 9, { item_name: 'A' })], usedLast30Days: 0 });
  await first;
  assert.equal(nodes['#batchHistoryList'].children[0].children[0].textContent, 'Added 1 tablet · 1 tablet now');
});

test('the page has both history sections and the new module is served', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['batchHistory', 'batchHistoryList', 'shopHistory', 'shopHistoryList']) assert.match(html, new RegExp(`id="${id}"`));
});
