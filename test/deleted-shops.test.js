import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { listDeletedShops, restoreOwnDeletedShop, validateOwnRestore } from '../lib/deleted-shops.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const [a, b, m, outsider] = [1, 2, 3, 4].map(uuid), [shop, other] = [11, 12].map(uuid);
const principal = id => ({ provider: 'cloudflare_access', subject: id, email: `${id}@example.test` });
const NOW = '2026-09-30T00:00:00.000Z', FUTURE = '2026-10-10T00:00:00.000Z';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const id of [a, b, m, outsider]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', id, id, `${id}@example.test`, 'before');
  }
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, 'Family Shop', 'before');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(other, 'Other Shop', 'before');
  for (const [id, role] of [[a, 'owner'], [b, 'owner'], [m, 'member']]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(other, a, 'owner', 'before');
  sqlite.prepare('INSERT INTO household_deletions VALUES (?,?,?,?,?)').run(shop, '2026-09-29T00:00:00.000Z', FUTURE, a, null);
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = statements.map(item => item.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const restore = ({ by = a, id = shop, op = uuid(100), body, database = db } = {}) => restoreOwnDeletedShop(database, principal(by), id, body ?? { operationId: op }, uuid(900), () => NOW);
  const rows = sql => sqlite.prepare(sql).all().map(r => ({ ...r }));
  return { sqlite, db, restore, rows };
}
const status = p => p.then(() => 200, e => e.status ?? e);

test('only Owners see a deleted Shop, only inside the keep period and before a purge', async () => {
  const f = fixture();
  assert.deepEqual((await listDeletedShops(f.db, principal(a), () => NOW)).shops, [{ id: shop, name: 'Family Shop', deleted_at: '2026-09-29T00:00:00.000Z', purge_after: FUTURE }]);
  assert.deepEqual((await listDeletedShops(f.db, principal(b), () => NOW)).shops.map(s => s.id), [shop], 'any Owner');
  assert.deepEqual((await listDeletedShops(f.db, principal(m), () => NOW)).shops, [], 'a Member does not');
  assert.deepEqual((await listDeletedShops(f.db, principal(outsider), () => NOW)).shops, []);
  assert.deepEqual((await listDeletedShops(f.db, principal(a), () => '2026-10-11T00:00:00.000Z')).shops, [], 'past the keep period');
  f.sqlite.prepare('UPDATE household_deletions SET purged_at=?').run('2026-09-30T00:00:00.000Z');
  assert.deepEqual((await listDeletedShops(f.db, principal(a), () => NOW)).shops, [], 'purged');
  await assert.rejects(listDeletedShops(f.db, {}), { status: 403 });
});

test('an Owner restores their deleted Shop: members regain access, audited with their own identity', async () => {
  const f = fixture();
  assert.deepEqual(await f.restore(), { restored: true, shop: { id: shop, name: 'Family Shop' } });
  assert.equal(f.rows('SELECT * FROM household_deletions').length, 0);
  assert.equal(f.rows(`SELECT count(*) AS n FROM active_memberships WHERE household_id='${shop}'`)[0].n, 3);
  assert.deepEqual(f.rows("SELECT household_id,actor_user_id,target_identifier FROM access_audit WHERE event='shop_restored'"), [{ household_id: shop, actor_user_id: a, target_identifier: `shop:${shop}` }]);
  assert.deepEqual(await f.restore({ op: uuid(101) }), { restored: false, shop: { id: shop, name: 'Family Shop' } }, 'replay or already active');
  assert.equal(f.rows("SELECT * FROM access_audit WHERE event='shop_restored'").length, 1);
});

test('non-owners and unknown Shops are 404; expired, purged and capped restores are 409; bodies are exact', async () => {
  const f = fixture();
  assert.equal(await status(f.restore({ by: m })), 404);
  assert.equal(await status(f.restore({ by: outsider })), 404);
  assert.equal(await status(f.restore({ id: uuid(99) })), 404);
  assert.equal(await status(f.restore({ id: 'nope' })), 404);
  for (const body of [{}, { operationId: 'x' }, { operationId: uuid(1), extra: 1 }]) assert.equal(await status(f.restore({ body })), 400);
  assert.throws(() => validateOwnRestore({ operationId: uuid(1), reason: 'x' }), { status: 400 });
  assert.equal(f.rows('SELECT * FROM household_deletions').length, 1, 'nothing changed');
  f.sqlite.prepare('UPDATE household_deletions SET purge_after=?').run('2026-09-29T12:00:00.000Z');
  assert.equal(await status(f.restore()), 409, 'expired');
  f.sqlite.prepare('UPDATE household_deletions SET purge_after=?, purged_at=?').run(FUTURE, NOW);
  assert.equal(await status(f.restore()), 409, 'purged');
  const capped = fixture();
  for (let i = 0; i < 5; i += 1) {
    const id = uuid(300 + i);
    capped.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, `Extra ${i}`, 'before');
    capped.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, a, 'owner', 'before');
  }
  assert.equal(await status(capped.restore()), 409, 'the five-owned-Shops cap');
  assert.equal(capped.rows('SELECT * FROM household_deletions').length, 1);
});

test('a failing audit insert rolls the restore back', async () => {
  const f = fixture();
  f.sqlite.exec("CREATE TRIGGER block_restore_audit BEFORE INSERT ON access_audit WHEN NEW.event='shop_restored' BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  await assert.rejects(f.restore());
  assert.equal(f.rows('SELECT * FROM household_deletions').length, 1, 'still deleted');
});

test('a demoted owner cannot restore: ownership is checked inside the batch', async () => {
  const f = fixture();
  const racing = f.restore({ database: { ...f.db, batch: async s => { f.sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id=? AND user_id=?").run(shop, a); return f.db.batch(s); } } });
  assert.equal(await status(racing), 404);
  assert.equal(f.rows('SELECT * FROM household_deletions').length, 1);
});

test('UI and Worker contract: routes are account-scoped before tenant resolution, card and dialog are wired and allow-listed', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const worker = read('worker/index.js'), html = read('public/index.html'), app = read('public/app.js');
  assert.ok(worker.indexOf("'/api/shops/deleted'") > 0 && worker.indexOf("'/api/shops/deleted'") < worker.indexOf('const tenant = await resolveTenant('));
  assert.ok(worker.indexOf('ownRestore') < worker.indexOf('const tenant = await resolveTenant('));
  for (const id of ['deletedShopsCard', 'deletedShopsList', 'restoreShopModal', 'restoreShopForm', 'confirmRestoreShop', 'cancelRestoreShop']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /id="deletedShopsCard"[^>]*hidden/);
  assert.match(app, /bindDeletedShops/);
  assert.ok(read('lib/shared.js').includes("'/deleted-shops-client.js'") && worker.includes("'/deleted-shops-client.js'"));
});
