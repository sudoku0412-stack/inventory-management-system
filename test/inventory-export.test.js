import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { EXPORT_ROW_LIMIT, csvCell, exportInventoryCsv } from '../lib/export.js';
import { exportFileName } from '../public/inventory-export-client.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const [owner, member, outsider] = [1, 2, 3].map(uuid), [shop, other] = [11, 12].map(uuid);

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const id of [owner, member, outsider]) sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, 'Família Shop!', 'before');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(other, 'Other', 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, owner, 'owner', 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, member, 'member', 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(other, outsider, 'owner', 'before');
  const add = (id, householdId, fields = {}) => {
    const row = { name: 'Med', strength: '', form: 'Tablets', quantity: 3, unit: 'tablets', expiry_date: null, location: '', notes: '', low_stock_threshold: 4, photo_path: null, created_at: 'c', updated_at: 'u', discarded_at: null, ...fields };
    sqlite.prepare('INSERT INTO batches (id,household_id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at,discarded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, householdId, row.name, row.strength, row.form, row.quantity, row.unit, row.expiry_date, row.location, row.notes, row.low_stock_threshold, row.photo_path, row.created_at, row.updated_at, row.discarded_at);
  };
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }) });
  return { sqlite, db: { prepare: statement }, add };
}
const tenant = (userId, householdId = shop) => ({ userId, householdId });

test('csvCell quotes per RFC 4180 and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(5), '5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  for (const dangerous of ['=SUM(A1)', '+1', '-2', '@cmd', '\tx', '\rx']) assert.ok(csvCell(dangerous).replace(/^"/, '').startsWith("'"), JSON.stringify(dangerous));
  assert.equal(csvCell('a=b'), 'a=b', 'only a leading character matters');
});

test('an Owner or Member exports every medicine of their Shop, including discarded ones, in a stable order', async () => {
  const f = fixture();
  f.add('b1', shop, { name: 'zinc', expiry_date: '2027-01-01' });
  f.add('b2', shop, { name: 'Aspirin', strength: '500 mg', expiry_date: '2026-12-01', notes: 'with "food", after meals', photo_path: 'photos/b2.jpg' });
  f.add('b3', shop, { name: 'aspirin', expiry_date: null, discarded_at: '2026-09-01T00:00:00.000Z' });
  f.add('b4', shop, { name: '=HYPERLINK("x")' });
  f.add('x1', other, { name: 'OTHER SHOP SECRET' });
  const file = await exportInventoryCsv(f.db, tenant(owner), () => '2026-09-30T10:00:00.000Z');
  assert.equal(file.filename, 'familia-shop-inventory-2026-09-30.csv');
  assert.equal(file.rows, 4);
  assert.ok(file.csv.startsWith('﻿name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,status,has_photo,created_at,updated_at,discarded_at\r\n'));
  const lines = file.csv.replace('﻿', '').split('\r\n');
  assert.equal(lines.at(-1), '', 'ends with a CRLF');
  assert.deepEqual(lines.slice(1, -1).map(line => line.split(',')[0]), ['"\'=HYPERLINK(""x"")"', 'Aspirin', 'aspirin', 'zinc'], 'case-insensitive name order, then expiry with unknown last');
  assert.match(file.csv, /Aspirin,500 mg,Tablets,3,tablets,2026-12-01,,"with ""food"", after meals",4,active,yes,c,u,/);
  assert.match(file.csv, /aspirin,,Tablets,3,tablets,,,,4,discarded,no,c,u,2026-09-01T00:00:00\.000Z/);
  assert.match(file.csv, /"'=HYPERLINK\(""x""\)"/, 'formula neutralized');
  assert.doesNotMatch(file.csv, /SECRET/, 'another Shop never leaks in');
  assert.doesNotMatch(file.csv, /photos\/b2\.jpg/, 'photo paths are not exported');
});

test('outsiders and members of deleted Shops cannot export, but Members can', async () => {
  const f = fixture();
  f.add('b1', shop);
  assert.equal((await exportInventoryCsv(f.db, tenant(member))).rows, 1, 'a Member may export');
  await assert.rejects(exportInventoryCsv(f.db, tenant(outsider)), { status: 403 });
  await assert.rejects(exportInventoryCsv(f.db, tenant(owner, other)), { status: 403 }, 'not a member of that Shop');
  await assert.rejects(exportInventoryCsv(f.db, {}), { status: 403 });
  f.sqlite.prepare('INSERT INTO household_deletions VALUES (?,?,?,?,?)').run(shop, 'now', '2999-01-01T00:00:00.000Z', owner, null);
  await assert.rejects(exportInventoryCsv(f.db, tenant(owner)), { status: 403 }, 'a deleted Shop is gone');
});

test('an empty Shop exports just the header; an oversized one is refused with 413', async () => {
  const f = fixture();
  const empty = await exportInventoryCsv(f.db, tenant(owner));
  assert.equal(empty.rows, 0);
  assert.equal(empty.csv.replace('﻿', '').split('\r\n').length, 2);
  f.sqlite.exec('BEGIN');
  const insert = f.sqlite.prepare("INSERT INTO batches (id,household_id,name,form,quantity,unit,created_at,updated_at) VALUES (?,?,'m','Tablets',1,'u','c','u')");
  for (let i = 0; i <= EXPORT_ROW_LIMIT; i += 1) insert.run(`big-${i}`, shop);
  f.sqlite.exec('COMMIT');
  await assert.rejects(exportInventoryCsv(f.db, tenant(owner)), { status: 413 });
});

test('the browser file name is a safe slug with the date', () => {
  assert.equal(exportFileName('Família Shop!', new Date('2026-09-30T10:00:00Z')), 'familia-shop-inventory-2026-09-30.csv');
  assert.equal(exportFileName('日本語', new Date('2026-09-30T10:00:00Z')), 'shop-inventory-2026-09-30.csv');
  assert.equal(exportFileName('../../etc/passwd\r\n', new Date('2026-09-30T10:00:00Z')), 'etc-passwd-inventory-2026-09-30.csv');
});

test('UI and Worker contract: button, pinned Shop route before tenant resolution, safe headers, allow-listed', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const worker = read('worker/index.js'), html = read('public/index.html'), app = read('public/app.js');
  assert.ok(worker.indexOf("'/api/household/export'") < worker.indexOf('const tenant = await resolveTenant('));
  assert.match(worker, /'content-type': 'text\/csv; charset=utf-8', 'content-disposition': `attachment; filename="\$\{file\.filename\}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'/);
  assert.match(worker, /pinnedTenant\(env\.DB, principal, request\.headers\.get\('x-shop-id'\)\);\n\s+const file = await exportInventoryCsv/);
  for (const id of ['exportInventorySection', 'exportInventoryButton', 'exportInventoryStatus']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /id="exportInventorySection"[^>]*hidden/);
  assert.match(app, /bindInventoryExport/);
  assert.ok(read('lib/shared.js').includes("'/inventory-export-client.js'") && worker.includes("'/inventory-export-client.js'"));
  assert.doesNotMatch(read('public/inventory-export-client.js'), /role/, 'visibility does not depend on the role');
});
