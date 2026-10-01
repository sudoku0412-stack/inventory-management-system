import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { deleteHousehold, validateShopDeletion } from '../lib/household-access.js';
import { purgeDeletedShops, PURGED_SHOP_NAME } from '../lib/shop-purge.js';
import { pendingHouseholdInvitations } from '../lib/household-access.js';
import { listShops, pinnedTenant, resolveTenant } from '../lib/tenants.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const [a, b, m, outsider] = [1, 2, 3, 4].map(uuid), [shop, other] = [11, 12].map(uuid);
const principal = id => ({ provider: 'cloudflare_access', subject: id, email: `${id}@example.test` });
const T0 = '2026-09-29T12:00:00.000Z';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const id of [a, b, m, outsider]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', id, id, `${id}@example.test`, 'before');
  }
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, 'Family Shop', 'before');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(other, 'Other Shop', 'before');
  for (const [id, role] of [[a, 'owner'], [b, 'owner'], [m, 'member']]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(other, a, 'owner', 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(other, outsider, 'owner', 'before');
  sqlite.prepare('INSERT INTO household_settings (household_id,display_name,household_name,default_storage_location,updated_at,display_name_source) VALUES (?,?,?,?,?,?)').run(shop, 'Name', 'Shop', 'Cabinet', 'before', 'user');
  sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,photo_path,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?,?)').run('batch-1', 'Med', 'Tablets', 3, 'tablets', 'photos/batch-1.jpg', 'before', 'before', shop);
  sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,photo_path,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?,?)').run('batch-2', 'Med', 'Tablets', 3, 'tablets', 'photos/batch-2.jpg', 'before', 'before', other);
  sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)').run('e-shop', 'p', 'a', shop, m, 'before');
  sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)').run('e-other', 'p', 'a', other, a, 'before');
  sqlite.prepare("INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(uuid(50), shop, 'new@example.test', 'member', a, 'before', '2999-01-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(a, shop, 'before');
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = statements.map(item => item.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const del = ({ by = a, h = shop, op = uuid(100), name = 'Family Shop', body, database = db } = {}) => deleteHousehold(database, principal(by), { userId: by, householdId: h }, body ?? { operationId: op, confirmName: name }, uuid(900), () => T0);
  const rows = sql => sqlite.prepare(sql).all().map(r => ({ ...r }));
  return { sqlite, db, del, rows };
}
const status = p => p.then(() => 200, e => e.status ?? e);

test('an owner soft-deletes a Shop: tombstone state, audit, invitations and push gone, data and roles kept', async () => {
  const f = fixture();
  const result = await f.del();
  assert.equal(result.deleted, true);
  assert.equal(result.purgeAfter, '2026-10-13T12:00:00.000Z');
  assert.deepEqual(f.rows('SELECT household_id,deleted_at,deleted_by_user_id,purged_at FROM household_deletions'), [{ household_id: shop, deleted_at: T0, deleted_by_user_id: a, purged_at: null }]);
  assert.deepEqual(f.rows("SELECT actor_user_id,target_identifier FROM access_audit WHERE event='shop_deleted'"), [{ actor_user_id: a, target_identifier: `shop:${shop}` }]);
  assert.equal(f.rows('SELECT * FROM household_invitations').length, 0);
  assert.deepEqual(f.rows('SELECT endpoint FROM push_subscriptions'), [{ endpoint: 'e-other' }]);
  assert.equal(f.rows('SELECT * FROM memberships WHERE household_id=?'.replace('?', `'${shop}'`)).length, 3, 'roles survive for restore');
  assert.equal(f.rows('SELECT * FROM batches').length, 2, 'medicines are kept during the grace period');
  assert.equal(f.rows('SELECT * FROM household_deletions WHERE household_id=?'.replace('?', `'${other}'`)).length, 0);
});

test('every Shop reader treats a deleted Shop as gone and falls back to another Shop', async () => {
  const f = fixture();
  await f.del();
  for (const who of [a, b, m]) await assert.rejects(pinnedTenant(f.db, principal(who), shop), { status: 403 });
  await assert.rejects(resolveTenant(f.db, principal(m), { shopId: shop }), { status: 403 });
  assert.deepEqual((await listShops(f.db, principal(a))).map(s => s.id), [other]);
  assert.equal((await resolveTenant(f.db, principal(a))).householdId, other, 'the stale preference is ignored');
  await assert.rejects(resolveTenant(f.db, principal(m)), { status: 403 }, 'a member with only this Shop has no Shop');
  assert.equal(f.rows(`SELECT count(*) AS n FROM active_memberships WHERE role='owner' AND user_id='${b}'`)[0].n, 0, 'the ownership cap slot is freed');
});

test('validation, authorization, name confirmation and the sole-Shop guard', async () => {
  const f = fixture();
  for (const body of [{}, { operationId: uuid(1) }, { operationId: uuid(1), confirmName: 'x', extra: 1 }, { operationId: 'x', confirmName: 'x' }]) assert.throws(() => validateShopDeletion(body), { status: 400 });
  assert.equal(await status(f.del({ by: m })), 403);
  assert.equal(await status(f.del({ by: outsider })), 403);
  assert.equal(await status(f.del({ name: 'family shop' })), 400, 'case-sensitive');
  assert.equal(await status(f.del({ by: b })), 409, 'their only Shop');
  assert.equal(f.rows('SELECT * FROM household_deletions').length, 0);
  assert.equal(await status(f.del({ name: '  Family Shop  ' })), 200, 'trimmed');
});

test('replay is a no-op; a new operation on a deleted Shop is 404; a concurrent loser sees the winner', async () => {
  const f = fixture();
  await f.del();
  assert.deepEqual(await f.del(), { deleted: false });
  assert.equal(await status(f.del({ op: uuid(101) })), 404);
  assert.equal(f.rows('SELECT * FROM access_audit WHERE event=\'shop_deleted\'').length, 1);
  const g = fixture();
  const racing = g.del({ database: { ...g.db, batch: async s => { await g.del({ by: b, op: uuid(7) }).catch(() => {}); return g.db.batch(s); } } });
  await racing.catch(() => {});
  assert.equal(g.rows('SELECT * FROM household_deletions').length, 1);
});

test('a failing audit insert rolls the whole deletion back', async () => {
  const f = fixture();
  f.sqlite.exec("CREATE TRIGGER block_delete_audit BEFORE INSERT ON access_audit WHEN NEW.event='shop_deleted' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;");
  await assert.rejects(f.del());
  assert.equal(f.rows('SELECT * FROM household_deletions').length, 0);
  assert.equal(f.rows('SELECT * FROM shop_deletion_receipts').length, 0);
  assert.equal(f.rows('SELECT * FROM household_invitations').length, 1);
  assert.equal(f.rows('SELECT * FROM push_subscriptions').length, 2);
});

test('purge: dry run changes nothing; live purge removes data and photos, keeps a valid tombstone, and is idempotent', async () => {
  const f = fixture();
  await f.del();
  const deleted = [], photos = { delete: async key => { deleted.push(key); } };
  const early = () => '2026-10-01T00:00:00.000Z', late = () => '2026-10-14T00:00:00.000Z';
  assert.equal((await purgeDeletedShops(f.db, photos, { now: late, dryRun: false })).purged, 1);
  assert.deepEqual(deleted, ['photos/batch-1.jpg']);
  assert.equal(f.rows(`SELECT count(*) AS n FROM batches WHERE household_id='${shop}'`)[0].n, 0);
  assert.equal(f.rows(`SELECT count(*) AS n FROM memberships WHERE household_id='${shop}'`)[0].n, 0);
  assert.equal(f.rows(`SELECT count(*) AS n FROM batches WHERE household_id='${other}'`)[0].n, 1, 'other Shops are untouched');
  assert.equal(f.rows(`SELECT name FROM households WHERE id='${shop}'`)[0].name, PURGED_SHOP_NAME);
  assert.ok(f.rows(`SELECT purged_at FROM household_deletions WHERE household_id='${shop}'`)[0].purged_at);
  assert.equal(f.rows("SELECT * FROM access_audit WHERE event='shop_purged'").length, 1);
  assert.deepEqual(f.rows('PRAGMA foreign_key_check'), []);
  const again = await purgeDeletedShops(f.db, photos, { now: late, dryRun: false });
  assert.equal(again.due, 0);
  assert.equal(f.rows("SELECT * FROM access_audit WHERE event='shop_purged'").length, 1);
  const g = fixture();
  await g.del();
  assert.deepEqual(await purgeDeletedShops(g.db, photos, { now: late, dryRun: true }), { due: 1, purged: 0, dryRun: true });
  assert.equal(g.rows(`SELECT count(*) AS n FROM batches WHERE household_id='${shop}'`)[0].n, 1);
  assert.equal((await purgeDeletedShops(g.db, photos, { now: early, dryRun: false })).due, 0, 'not due inside the grace period');
});

test('purge keeps every row when photo cleanup fails, so the next run retries', async () => {
  const f = fixture();
  await f.del();
  const result = await purgeDeletedShops(f.db, { delete: async () => { throw new Error('r2 down'); } }, { now: () => '2026-10-14T00:00:00.000Z', dryRun: false });
  assert.equal(result.purged, 0);
  assert.equal(result.failed, 1);
  assert.equal(f.rows(`SELECT count(*) AS n FROM batches WHERE household_id='${shop}'`)[0].n, 1);
  assert.equal(f.rows('SELECT purged_at FROM household_deletions')[0].purged_at, null);
});

test('missing schema is a 503', async () => {
  const f = fixture();
  f.sqlite.exec('DROP TABLE shop_deletion_receipts');
  assert.equal(await status(f.del()), 503);
});

test('pending invitation discovery hides invitations to a deleted Shop', async () => {
  const f = fixture();
  await f.del();
  f.sqlite.prepare("INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(uuid(51), shop, `${outsider}@example.test`, 'member', a, 'now', '2999-01-01T00:00:00.000Z');
  assert.deepEqual((await pendingHouseholdInvitations(f.db, principal(outsider), null)).invitations, []);
  f.sqlite.prepare("INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(uuid(52), other, `${outsider}@example.test`, 'member', a, 'now', '2999-01-01T00:00:00.000Z');
  assert.equal((await pendingHouseholdInvitations(f.db, principal(outsider), null)).invitations.length, 1, 'other Shops are unaffected');
});

test('UI contract: gated card, dialog, binding, allowlists, and the route stays behind the flag', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const html = read('public/index.html'), app = read('public/app.js'), worker = read('worker/index.js');
  for (const id of ['deleteShopSection', 'deleteShopButton', 'deleteShopModal', 'deleteShopForm', 'deleteShopConfirm', 'confirmDeleteShop', 'cancelDeleteShop']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /id="deleteShopSection"[^>]*hidden/);
  assert.match(html, /id="confirmDeleteShop"[^>]*disabled/);
  assert.match(app, /bindShopDeletion/);
  assert.ok(read('lib/shared.js').includes("'/shop-deletion-client.js'") && worker.includes("'/shop-deletion-client.js'"));
  assert.match(worker, /effectiveFlag\(env\.DB, env, tenant\.householdId, 'shop_deletion'\)\) return json\(\{ error: 'Not found' \}, 404\)/);
  assert.match(worker, /SHOP_PURGE_ENABLED !== 'true'/, 'purge is dry-run unless explicitly enabled');
  assert.match(read('public/shop-deletion-client.js'), /getAccess\(\)\?\.shop_deletion === true/);
});

test('the Owner chooses how many days to keep a deleted Shop: 7 to 30, default 14', async () => {
  for (const [keepDays, expected] of [[undefined, '2026-10-13T12:00:00.000Z'], [7, '2026-10-06T12:00:00.000Z'], [30, '2026-10-29T12:00:00.000Z']]) {
    const f = fixture();
    const body = { operationId: uuid(100), confirmName: 'Family Shop', ...(keepDays === undefined ? {} : { keepDays }) };
    assert.equal((await f.del({ body })).purgeAfter, expected, String(keepDays));
    assert.equal(f.rows('SELECT purge_after FROM household_deletions')[0].purge_after, expected);
  }
  for (const keepDays of [0, 6, 31, 10.5, '14', null, NaN, 1e9]) {
    const f = fixture();
    assert.equal(await status(f.del({ body: { operationId: uuid(100), confirmName: 'Family Shop', keepDays } })), 400, String(keepDays));
    assert.equal(f.rows('SELECT * FROM household_deletions').length, 0);
  }
  assert.throws(() => validateShopDeletion({ operationId: uuid(1), confirmName: 'x', keepDays: 14, extra: 1 }), { status: 400 });
});

test('UI contract: the delete dialog asks for 7 to 30 days and sends keepDays', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), js = readFileSync(new URL('../public/shop-deletion-client.js', import.meta.url), 'utf8');
  assert.match(html, /id="deleteShopDays" type="number"[^>]*min="7"[^>]*max="30"[^>]*value="14"/);
  assert.match(js, /keepDays: chosenDays/);
});

test('a per-Shop flag overrides the global secret either way, and is read on every call', async () => {
  const { effectiveFlag, shopOverrides } = await import('../lib/feature-flags.js');
  const f = fixture();
  for (const [global, override, expected] of [[undefined, undefined, false], ['true', undefined, true], ['true', 0, false], [undefined, 1, true], ['false', 1, true], ['true', 1, true]]) {
    f.sqlite.exec('DELETE FROM shop_feature_flags');
    if (override !== undefined) f.sqlite.prepare("INSERT INTO shop_feature_flags VALUES (?,?,?,?,?)").run(shop, 'shop_deletion', override, 'now', 'admin@example.test');
    assert.equal(await effectiveFlag(f.db, { SHOP_DELETION_ENABLED: global }, shop, 'shop_deletion'), expected, `${global}/${override}`);
  }
  assert.equal(await effectiveFlag(f.db, { SHOP_DELETION_ENABLED: 'true' }, other, 'shop_deletion'), true, 'other Shops follow the global secret');
  f.sqlite.exec('DROP TABLE shop_feature_flags');
  assert.deepEqual(await shopOverrides(f.db, shop), {}, 'a missing table means no overrides');
});

test('purge honours the per-Shop shop_purge flag: off holds a Shop, on purges it while the global default is a dry run', async () => {
  const late = () => '2026-10-14T00:00:00.000Z', photos = { delete: async () => {} };
  const held = fixture(); await held.del();
  held.sqlite.prepare("INSERT INTO shop_feature_flags VALUES (?,?,?,?,?)").run(shop, 'shop_purge', 0, 'now', 'admin@example.test');
  assert.equal((await purgeDeletedShops(held.db, photos, { now: late, dryRun: false })).purged, 0, 'held despite the global purge being on');
  assert.equal(held.rows(`SELECT count(*) AS n FROM batches WHERE household_id='${shop}'`)[0].n, 1);
  const forced = fixture(); await forced.del();
  forced.sqlite.prepare("INSERT INTO shop_feature_flags VALUES (?,?,?,?,?)").run(shop, 'shop_purge', 1, 'now', 'admin@example.test');
  assert.equal((await purgeDeletedShops(forced.db, photos, { now: late, dryRun: true })).purged, 1, 'purged though the global default is a dry run');
  assert.equal(forced.rows(`SELECT count(*) AS n FROM batches WHERE household_id='${shop}'`)[0].n, 0);
});

test('purge also removes the Shop\'s type, list overrides and remembered barcode names, and only for that Shop', async () => {
  const f = fixture();
  for (const id of [shop, other]) {
    f.sqlite.prepare("INSERT INTO shop_types (household_id,shop_type) VALUES (?,'goods')").run(id);
    f.sqlite.prepare("INSERT INTO shop_options (household_id,list,value,hidden,is_custom,created_at) VALUES (?,'unit','crate',0,1,'before')").run(id);
    f.sqlite.prepare("INSERT INTO batch_barcodes (household_id,barcode,name,strength,form,unit,location,updated_at) VALUES (?,'012345678905','Secret item','','General','piece','Shelf','before')").run(id);
  }
  await f.del();
  const photos = { delete: async () => {} };
  assert.equal((await purgeDeletedShops(f.db, photos, { now: () => '2026-10-14T00:00:00.000Z', dryRun: false })).purged, 1);
  for (const table of ['shop_types', 'shop_options', 'batch_barcodes']) {
    assert.equal(f.rows(`SELECT count(*) AS n FROM ${table} WHERE household_id='${shop}'`)[0].n, 0, `${table} purged`);
    assert.equal(f.rows(`SELECT count(*) AS n FROM ${table} WHERE household_id='${other}'`)[0].n, 1, `${table} of another Shop kept`);
  }
  assert.deepEqual(f.rows('PRAGMA foreign_key_check'), []);
});
