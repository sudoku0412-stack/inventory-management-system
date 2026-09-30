import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { lookupBarcode, normalizeBarcode, rememberBarcode } from '../lib/barcode.js';
import { createD1Store } from '../lib/store-d1.js';
import { bindBarcodeScan, cleanBarcode } from '../public/barcode-client.js';

const shop = 'shopA';
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO users VALUES (?,?)').run('u1', 't');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, 'Alpha', 't');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run('shopB', 'Beta', 't');
  const statement = (sql, values = []) => ({ sql, values, bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: sql => statement(sql), batch: async statements => statements.map(s => ({ meta: { changes: sqlite.prepare(s.sql).run(...s.values).changes } })) };
  return { sqlite, db };
}
const json = body => ({ ok: true, json: async () => body });
const fetchFrom = routes => async url => { const hit = Object.entries(routes).find(([key]) => url.includes(key)); return hit ? hit[1] : { ok: false, json: async () => ({}) }; };

test('normalizeBarcode accepts 8 to 14 digits and strips spaces and dashes', () => {
  assert.equal(normalizeBarcode('3017620422003'), '3017620422003');
  assert.equal(normalizeBarcode(' 0 36000-29145 2'), '036000291452');
  for (const bad of ['1234567', '123456789012345', 'abc12345678', '', null, undefined, 5]) assert.equal(normalizeBarcode(bad), null);
  assert.equal(cleanBarcode('3017620422003'), '3017620422003');
  assert.equal(cleanBarcode('12'), null);
});

test('lookup tries the Shop first, then openFDA, then the Open Facts databases', async () => {
  const { db } = fixture();
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return fetchFrom({ 'api.fda.gov': json({ results: [{ openfda: { brand_name: ['SILICEA'] } }] }), 'openfoodfacts': json({ status: 1, product: { product_name: 'Nutella', brands: 'Nutella, Ferrero' } }) })(url); };
  const drug = await lookupBarcode(db, shop, '8907460005526', fetchImpl);
  assert.deepEqual([drug.found, drug.source, drug.name], [true, 'openfda', 'SILICEA']);
  calls.length = 0;
  const food = await lookupBarcode(db, shop, '3017620422003', async url => { calls.push(url); return fetchFrom({ 'openfoodfacts': json({ status: 1, product: { product_name: ' Nutella ', brands: 'Nutella, Ferrero' } }) })(url); });
  assert.deepEqual([food.found, food.source, food.name, food.brand], [true, 'openfacts', 'Nutella', 'Nutella']);
  assert.ok(calls[0].includes('api.fda.gov'));
  await rememberBarcode(db, shop, '3017620422003', { name: 'My jar', strength: '', form: 'General', unit: 'box', location: 'Shelf' });
  calls.length = 0;
  const own = await lookupBarcode(db, shop, '3017620422003', async url => { calls.push(url); throw new Error('network must not be used'); });
  assert.deepEqual([own.source, own.name, own.unit, calls.length], ['shop', 'My jar', 'box', 0]);
  const otherShop = await lookupBarcode(db, 'shopB', '3017620422003', fetchFrom({}));
  assert.deepEqual(otherShop, { code: '3017620422003', found: false }, 'another Shop never sees this Shop’s scans');
});

test('a miss, an error, a timeout or a bad code never throws a server error', async () => {
  const { db } = fixture();
  assert.deepEqual(await lookupBarcode(db, shop, '3017620422003', fetchFrom({})), { code: '3017620422003', found: false });
  assert.equal((await lookupBarcode(db, shop, '3017620422003', async () => { throw new Error('boom'); })).found, false);
  assert.equal((await lookupBarcode(db, shop, '3017620422003', fetchFrom({ 'openfoodfacts': json({ status: 1, product: { product_name: '' } }) }))).found, false);
  await assert.rejects(lookupBarcode(db, shop, 'nope', fetchFrom({})), error => error.status === 400);
});

test('remembering a barcode updates the saved details and ignores bad input', async () => {
  const { db, sqlite } = fixture();
  assert.equal(await rememberBarcode(db, shop, 'bad', { name: 'X' }), false);
  assert.equal(await rememberBarcode(db, shop, '3017620422003', {}), false);
  assert.equal(await rememberBarcode(db, shop, '3017620422003', { name: 'First' }), true);
  assert.equal(await rememberBarcode(db, shop, '3017620422003', { name: 'Second', unit: 'pack' }), true);
  const rows = sqlite.prepare('SELECT name,unit FROM batch_barcodes').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ name: 'Second', unit: 'pack' }]);
});

test('saving a new item with a scanned barcode remembers it, and a failed memory never blocks the save', async () => {
  const { db, sqlite } = fixture();
  const store = createD1Store(db, null, {}, { householdId: shop, userId: 'u1' });
  const base = { name: 'Scanned', quantity: 3, form: 'Tablets', unit: 'bottle', expiry_date: '2030-01-01', location: 'Medicine cabinet' };
  await store.create({ ...base, barcode: '3017620422003' });
  assert.equal(sqlite.prepare('SELECT name FROM batch_barcodes WHERE barcode=?').get('3017620422003').name, 'Scanned');
  await store.create({ ...base, name: 'No code' });
  assert.equal(sqlite.prepare('SELECT count(*) c FROM batch_barcodes').get().c, 1);
  sqlite.exec('DROP TABLE batch_barcodes');
  assert.equal((await store.create({ ...base, name: 'Still saves', barcode: '3017620422003' })).name, 'Still saves');
});

function scanFixture({ detect, media, Detector, apiImpl } = {}) {
  const listeners = new Map();
  const node = (extra = {}) => ({ textContent: '', value: '', classList: { toggle() {} }, addEventListener: (name, fn) => listeners.set(`${extra.id}:${name}`, fn), ...extra });
  const dialog = node({ id: 'dialog', open: false, showModal() { this.open = true; }, close() { this.open = false; listeners.get('dialog:close')?.(); } });
  const video = node({ id: 'video', srcObject: null, play: async () => {} });
  const nodes = { scanModal: dialog, scanVideo: video, scanStatus: node({ id: 'status' }), scanManual: node({ id: 'manual' }), scanManualForm: node({ id: 'form' }) };
  const triggers = [node({ id: 'trigger' })];
  const document = { querySelector: selector => nodes[selector.slice(1)], querySelectorAll: () => triggers };
  const stopped = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push(1) }] };
  const results = [], requests = [];
  const ticks = [];
  const scan = bindBarcodeScan({
    document, toast() {}, onResult: result => results.push(result),
    api: apiImpl || (async path => { requests.push(path); return { code: '3017620422003', found: true, name: 'Nutella' }; }),
    getMediaDevices: () => media === null ? undefined : { getUserMedia: async () => stream },
    DetectorClass: Detector === null ? undefined : class { async detect() { return detect ? detect() : []; } },
    schedule: fn => { ticks.push(fn); return ticks.length; }, cancel: () => {}
  });
  return { scan, nodes, listeners, results, requests, ticks, stopped, click: () => listeners.get('trigger:click')() };
}

test('live scan: a detected barcode stops the camera, looks it up, closes the dialog and reports the result', async () => {
  const f = scanFixture({ detect: () => [{ rawValue: 'junk' }, { rawValue: '3017620422003' }] });
  f.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nodes.scanModal.open, true);
  assert.equal(f.ticks.length, 1);
  await f.ticks[0]();
  assert.deepEqual(f.requests, ['/api/barcode?code=3017620422003']);
  assert.equal(f.nodes.scanModal.open, false);
  assert.equal(f.results[0].name, 'Nutella');
  assert.ok(f.stopped.length >= 1, 'camera tracks stopped');
});

test('typing a barcode works without a camera, and bad codes are refused', async () => {
  const f = scanFixture({ Detector: null });
  f.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.nodes.scanStatus.textContent, /not available/);
  f.nodes.scanManual.value = '12';
  f.listeners.get('form:submit')({ preventDefault() {} });
  assert.match(f.nodes.scanStatus.textContent, /8 to 14 digits/);
  assert.equal(f.requests.length, 0);
  f.nodes.scanManual.value = '3017 6204 22003';
  f.listeners.get('form:submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests, ['/api/barcode?code=3017620422003']);
  assert.equal(f.results.length, 1);
});

test('closing the dialog stops the camera', async () => {
  const f = scanFixture();
  f.click();
  await new Promise(resolve => setImmediate(resolve));
  f.nodes.scanModal.close();
  assert.ok(f.stopped.length >= 1);
});

test('a lookup failure reports an offline miss instead of throwing', async () => {
  const f = scanFixture({ Detector: null, apiImpl: async () => { throw new Error('offline'); } });
  f.click();
  f.nodes.scanManual.value = '3017620422003';
  f.listeners.get('form:submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.results, [{ code: '3017620422003', found: false, offline: true }]);
  assert.equal(f.nodes.scanModal.open, false);
});
