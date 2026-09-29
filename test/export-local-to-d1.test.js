import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server.js';
import { buildExport } from '../tools/export-local-to-d1.js';

const SHOP = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function d1Copy() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO households (id,name,created_at) VALUES (?,?,?)').run(SHOP, 'Shop', '2026-01-01');
  return sqlite;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  const store = createStore(join(dir, 'inventory.sqlite'));
  const a = await store.create({ name: "O'Brien\nCough", strength: '5mg', form: 'Syrup', quantity: 3, unit: 'ml', expiry_date: '2027-01-01', location: 'Kitchen drawer', notes: 'n', photo: `data:image/png;base64,${PNG.toString('base64')}` });
  const b = await store.create({ name: 'Plain', form: 'Tablets', quantity: 5, unit: 'tablets' });
  const gone = await store.create({ name: 'Gone', form: 'Tablets', quantity: 1, unit: 'tablets' });
  await store.discard(gone.id);
  store.db.prepare("INSERT INTO batches (id,name,strength,form,quantity,unit,location,notes,low_stock_threshold,created_at,updated_at) VALUES ('bad-1','Bad','','Nope',1,'tablets','','',4,'2026-01-01','2026-01-01')").run();
  store.db.prepare("INSERT INTO push_subscriptions VALUES ('https://x','k','a','2026-01-01')").run();
  store.close();
  return { dir, a, b, path: join(dir, 'inventory.sqlite') };
}

test('generated SQL imports valid batches into the D1 schema, idempotently', async () => {
  const { path, a, b } = await fixture();
  const { sql, script, summary } = buildExport({ shopId: SHOP, dbPath: path });
  assert.equal(summary.imported, 2);
  assert.equal(summary.skippedDiscarded, 1);
  assert.equal(summary.invalid.length, 1);
  assert.equal(summary.photos, 1);
  assert.doesNotMatch(sql, /push_subscriptions|https:\/\/x/);
  const d1 = d1Copy();
  d1.exec(sql);
  d1.exec(sql);
  const rows = d1.prepare('SELECT * FROM batches ORDER BY name').all();
  assert.equal(rows.length, 2);
  const imported = rows.find(r => r.id === a.id);
  assert.equal(imported.name, "O'Brien\nCough");
  assert.equal(imported.household_id, SHOP);
  assert.equal(imported.revision, 1);
  assert.equal(imported.photo_path, `photos/${a.id}.png`);
  assert.equal(rows.find(r => r.id === b.id).photo_path, null);
  assert.equal(d1.prepare('SELECT COUNT(*) n FROM batch_changes WHERE household_id=?').get(SHOP).n, 2);
  assert.match(script, new RegExp(`object put 'medicine-inventory-photos/photos/${a.id}\\.png' --remote --file '.*' --content-type 'image/png'`));
  assert.equal(script.split('\n').filter(l => l.includes('r2 object put')).length, 1);
});

test('invalid photo files import without a photo and an unknown shop fails on the foreign key', async () => {
  const { dir, path, a } = await fixture();
  const photoDir = join(dir, 'photos');
  for (const f of readdirSync(photoDir)) writeFileSync(join(photoDir, f), 'not an image');
  const { sql, summary } = buildExport({ shopId: SHOP, dbPath: path });
  assert.equal(summary.photos, 0);
  assert.equal(summary.warnings.length, 1);
  const d1 = d1Copy();
  d1.exec(sql);
  assert.equal(d1.prepare('SELECT photo_path FROM batches WHERE id=?').get(a.id).photo_path, null);
  const other = d1Copy();
  other.exec('PRAGMA foreign_keys = ON');
  assert.throws(() => other.exec(buildExport({ shopId: '22222222-2222-4222-8222-222222222222', dbPath: path }).sql));
});

test('rejects a bad shop id', () => {
  assert.throws(() => buildExport({ shopId: 'nope', dbPath: 'x' }), /Shop UUID/);
});
