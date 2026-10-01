import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, seedPeople } from './db-fixture.js';
import { createD1Store } from '../lib/store-d1.js';
import { prepareImport, IMPORT_ROW_LIMIT } from '../lib/batch-import.js';
import { exportInventoryCsv } from '../lib/export.js';
import { parseCsv, rowsFromCsv, templateCsv, bindCsvImport } from '../public/csv-import-client.js';

const allowed = { forms: new Set(['Tablets', 'Syrup']), units: new Set(['tablet', 'bottle']) };
const defaults = { location: 'Medicine cabinet', threshold: 4 };

test('the parser handles quotes, doubled quotes, line breaks in cells, CRLF, a BOM and other separators', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('﻿a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",2'), [['a', 'b'], ['line1\nline2', '2']]);
  assert.deepEqual(parseCsv('a,b\n\n,\n1,2\n'), [['a', 'b'], ['1', '2']], 'blank lines are skipped');
});

test('headers are matched by name in any order, with common alternatives', () => {
  const rows = rowsFromCsv('Qty,Item,Category,Units,Expiry Date,Low stock alert\n5,Paracetamol,Tablets,tablet,2027-03-31,2\n');
  assert.deepEqual(rows, [{ quantity: '5', name: 'Paracetamol', form: 'Tablets', unit: 'tablet', expiry_date: '2027-03-31', low_stock_threshold: '2' }]);
  assert.throws(() => rowsFromCsv('name,quantity\nA,1\n'), /form, unit/);
  assert.throws(() => rowsFromCsv(''), /empty/);
  assert.throws(() => rowsFromCsv('name,quantity,form,unit\n'), /no items/);
  const many = `name,quantity,form,unit\n${'A,1,Tablets,tablet\n'.repeat(IMPORT_ROW_LIMIT + 1)}`;
  assert.throws(() => rowsFromCsv(many), /up to 200/);
  assert.equal(rowsFromCsv(templateCsv()).length, 1, 'the template is itself importable');
});

test('a file from the export imports back, including cells the export protected from spreadsheet formulas', async () => {
  const { sqlite, db } = memoryDb();
  seedPeople(sqlite);
  const store = createD1Store(db, null, {}, { householdId: 'h1', userId: 'u1' });
  const base = { quantity: 3, form: 'Tablets', unit: 'tablet', expiry_date: '2030-01-01', location: 'Medicine cabinet' };
  await store.create({ ...base, name: '=SUM(A1)', notes: 'a, "quoted" note' });
  const { csv } = await exportInventoryCsv(db, { householdId: 'h1', userId: 'u1' });
  const rows = rowsFromCsv(csv);
  assert.equal(rows[0].name, '=SUM(A1)');
  assert.equal(rows[0].notes, 'a, "quoted" note');
  const target = createD1Store(db, null, {}, { householdId: 'h2', userId: 'u3' });
  await target.importBatches(rows.map(({ name, strength, form, quantity, unit, expiry_date, location, notes, low_stock_threshold }) => ({ name, strength, form, quantity, unit, expiry_date, location, notes, low_stock_threshold })));
  const [copy] = await target.list();
  assert.deepEqual([copy.name, copy.notes, copy.quantity, copy.expiry_date], ['=SUM(A1)', 'a, "quoted" note', 3, '2030-01-01']);
});

test('prepareImport fills defaults, matches lists ignoring case, and reports every problem with its row number', () => {
  const items = prepareImport([
    { name: ' Para ', quantity: '5', form: 'tablets', unit: 'TABLET' },
    { name: 'Cough', quantity: '2', form: 'Syrup', unit: 'bottle', expiry_date: '2027-03-31', location: 'Fridge', low_stock_threshold: '1', strength: '5 ml', notes: 'n' }
  ], allowed, defaults);
  assert.deepEqual(items[0], { name: 'Para', quantity: 5, form: 'Tablets', unit: 'tablet', expiry_date: null, low_stock_threshold: 4, strength: '', location: 'Medicine cabinet', notes: '' });
  assert.equal(items[1].location, 'Fridge');
  assert.equal(items[1].low_stock_threshold, 1);
  const bad = [
    { name: '', quantity: '1', form: 'Tablets', unit: 'tablet' }, { name: 'A', quantity: '0', form: 'Tablets', unit: 'tablet' }, { name: 'A', quantity: '1.5', form: 'Tablets', unit: 'tablet' },
    { name: 'A', quantity: '1', form: 'Gel', unit: 'tablet' }, { name: 'A', quantity: '1', form: 'Tablets', unit: 'jar' },
    { name: 'A', quantity: '1', form: 'Tablets', unit: 'tablet', expiry_date: '31/03/2027' }, { name: 'A', quantity: '1', form: 'Tablets', unit: 'tablet', low_stock_threshold: 'x' }, null
  ];
  try { prepareImport(bad, allowed, defaults); assert.fail('should throw'); } catch (error) {
    assert.equal(error.status, 422);
    assert.deepEqual(error.problems.map(item => item.row), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.match(error.problems[3].message, /Gel/);
    assert.match(error.message, /Nothing was imported/);
  }
  assert.throws(() => prepareImport([], allowed, defaults), /no items/);
  assert.throws(() => prepareImport(Array.from({ length: 201 }, () => ({})), allowed, defaults), /up to 200/);
  assert.throws(() => prepareImport('x', allowed, defaults), /no items/);
});

test('only the first 20 problems are listed, with a count of the rest', () => {
  try { prepareImport(Array.from({ length: 30 }, () => ({ name: '' })), allowed, defaults); assert.fail('should throw'); } catch (error) {
    assert.equal(error.problems.length, 20);
    assert.equal(error.moreProblems, 10);
  }
});

test('the store saves every valid row in one go, uses Shop defaults, and a bad row saves nothing', async () => {
  const { sqlite, db } = memoryDb();
  seedPeople(sqlite);
  const store = createD1Store(db, null, {}, { householdId: 'h1', userId: 'u1' });
  await store.updateSettings({ display_name: 'X', household_name: 'Y', default_storage_location: 'Medicine cabinet', default_low_stock_threshold: 9 });
  const row = name => ({ name, quantity: '3', form: 'Tablets', unit: 'tablet' });
  assert.deepEqual(await store.importBatches([row('A'), row('B')]), { imported: 2 });
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.ok(list.every(item => item.low_stock_threshold === 9 && item.location === 'Medicine cabinet'));
  await assert.rejects(store.importBatches([row('C'), { ...row('D'), form: 'Nope' }]), /Nothing was imported/);
  assert.equal((await store.list()).length, 2);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM batch_changes WHERE household_id='h1'").get().n, 2, 'each imported item reaches the change feed');
  assert.equal((await createD1Store(db, null, {}, { householdId: 'h2', userId: 'u3' }).list()).length, 0, 'other Shops are untouched');
});

function fakeDom() {
  const node = () => ({ hidden: false, textContent: '', children: [], listeners: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...items) { this.children = items; }, click() { this.clicked = true; } });
  const nodes = { '#importInventorySection': node(), '#importInventoryButton': node(), '#importInventoryFile': { ...node(), files: [], value: '' }, '#importInventoryTemplate': node(), '#importInventoryStatus': node(), '#importInventoryProblems': node() };
  return { nodes, document: { querySelector: selector => nodes[selector], createElement: () => node(), body: { append() {} } } };
}

test('choosing a file imports its rows and refreshes the list; problems are listed when the server refuses', async () => {
  const { nodes, document } = fakeDom();
  const sent = [], refreshed = [];
  let fail = null;
  const api = async (path, options) => { sent.push([path, JSON.parse(options.body)]); if (fail) throw fail; return { imported: 2 }; };
  const ui = bindCsvImport({ document, getContext: () => ({ accountContextKey: 'k', active: {}, activeShopId: 's1' }), api, onImported: () => refreshed.push(1), readFile: async file => file.text, toast() {} });
  ui.refresh();
  assert.equal(nodes['#importInventorySection'].hidden, false);
  nodes['#importInventoryFile'].files = [{ size: 100, text: 'name,quantity,form,unit\nA,1,Tablets,tablet\nB,2,Syrup,bottle\n' }];
  await nodes['#importInventoryFile'].listeners.change();
  assert.equal(sent[0][0], '/api/batches/import');
  assert.equal(sent[0][1].rows.length, 2);
  assert.equal(nodes['#importInventoryStatus'].textContent, 'Imported 2 items.');
  assert.equal(refreshed.length, 1);
  fail = Object.assign(new Error('Nothing was imported. 1 row needs fixing.'), { status: 422, problems: [{ row: 3, message: 'Form “Gel” is not in this Shop’s Form list.' }], moreProblems: 0 });
  nodes['#importInventoryFile'].files = [{ size: 100, text: 'name,quantity,form,unit\nA,1,Gel,tablet\n' }];
  await nodes['#importInventoryFile'].listeners.change();
  assert.match(nodes['#importInventoryStatus'].textContent, /Nothing was imported/);
  assert.equal(nodes['#importInventoryProblems'].children[0].textContent, 'Row 3: Form “Gel” is not in this Shop’s Form list.');
  assert.equal(refreshed.length, 1);
});

test('an unusable file is refused in the browser without any request', async () => {
  const { nodes, document } = fakeDom();
  let calls = 0;
  bindCsvImport({ document, getContext: () => ({ accountContextKey: 'k', active: {}, activeShopId: 's1' }), api: async () => { calls += 1; return {}; }, readFile: async file => file.text });
  nodes['#importInventoryFile'].files = [{ size: 10, text: 'name,quantity\nA,1\n' }];
  await nodes['#importInventoryFile'].listeners.change();
  assert.match(nodes['#importInventoryStatus'].textContent, /form, unit/);
  nodes['#importInventoryFile'].files = [{ size: 2 * 1024 * 1024, text: '' }];
  await nodes['#importInventoryFile'].listeners.change();
  assert.match(nodes['#importInventoryStatus'].textContent, /1 MB/);
  assert.equal(calls, 0);
});
