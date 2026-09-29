import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { promoteHouseholdMember, removeHouseholdMember, validateMemberRemoval } from '../lib/household-access.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const [actor, otherOwner, target, bystander, outsider] = [1, 2, 3, 4, 5].map(uuid), [shop, otherShop] = [11, 12].map(uuid);
const principal = id => ({ provider: 'cloudflare_access', subject: id, email: `${id}@example.test` });

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const id of [actor, otherOwner, target, bystander, outsider]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', id, id, `${id}@example.test`, 'before');
  }
  for (const id of [shop, otherShop]) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, id, 'before');
  const member = (h, u, role) => sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(h, u, role, 'before');
  member(shop, actor, 'owner'); member(shop, otherOwner, 'owner'); member(shop, target, 'member'); member(shop, bystander, 'member');
  member(otherShop, target, 'owner'); member(otherShop, outsider, 'owner');
  const sub = (endpoint, h, u) => sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)').run(endpoint, 'p', 'a', h, u, 'before');
  sub('t-here', shop, target); sub('t-other', otherShop, target); sub('b-here', shop, bystander);
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(target, shop, 'before');
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(bystander, shop, 'before');
  sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?)').run('batch-1', 'Medicine', 'Tablets', 3, 'tablets', 'before', 'before', shop);
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = statements.map(item => item.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const remove = ({ by = actor, h = shop, who = target, op = uuid(100), body, database = db } = {}) =>
    removeHouseholdMember(database, principal(by), { userId: by, householdId: h }, who, body ?? { operationId: op });
  const rows = sql => sqlite.prepare(sql).all();
  const members = h => rows(`SELECT user_id FROM memberships WHERE household_id='${h}' ORDER BY user_id`).map(r => r.user_id);
  return { sqlite, db, remove, rows, members };
}
const status = promise => promise.then(() => 200, error => error.status ?? error);

test('an owner removes a member: one delete, receipt, audit, and scoped cleanup; nothing else changes', async () => {
  const f = fixture();
  assert.deepEqual(await f.remove(), { removed: true });
  assert.deepEqual(f.members(shop), [actor, otherOwner, bystander].sort());
  assert.deepEqual(f.members(otherShop), [target, outsider].sort(), 'other Shops untouched');
  assert.deepEqual(f.rows('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').map(r => r.endpoint), ['b-here', 't-other']);
  assert.deepEqual(f.rows('SELECT user_id FROM user_shop_preferences').map(r => r.user_id), [bystander]);
  assert.equal(f.rows('SELECT * FROM shop_member_removal_receipts').length, 1);
  const audit = f.rows("SELECT event,household_id,actor_user_id,target_identifier FROM access_audit WHERE event='member_removed'");
  assert.deepEqual(audit.map(r => ({ ...r })), [{ event: 'member_removed', household_id: shop, actor_user_id: actor, target_identifier: `user:${target}` }]);
  assert.equal(f.rows('SELECT * FROM batches').length, 1);
  assert.equal(f.rows('SELECT * FROM users').length, 5);
  assert.equal(f.rows('SELECT * FROM identities').length, 5);
});

test('preference pointing at another Shop is left alone', async () => {
  const f = fixture();
  f.sqlite.prepare('UPDATE user_shop_preferences SET household_id=? WHERE user_id=?').run(otherShop, target);
  await f.remove();
  assert.equal(f.rows('SELECT household_id FROM user_shop_preferences WHERE user_id=?'.replace('?', `'${target}'`))[0].household_id, otherShop);
});

test('members, foreign owners and unknown callers are 403 before any target lookup', async () => {
  const f = fixture();
  assert.equal(await status(f.remove({ by: bystander })), 403);
  assert.equal(await status(f.remove({ by: outsider })), 403);
  assert.equal(await status(f.remove({ by: 'nobody' })), 403);
  assert.equal(f.rows('SELECT * FROM shop_member_removal_receipts').length, 0);
  assert.equal(f.members(shop).length, 4);
});

test('targets: owners and self are 409, missing and foreign are 404, malformed is 404', async () => {
  const f = fixture();
  assert.equal(await status(f.remove({ who: otherOwner })), 409);
  assert.equal(await status(f.remove({ who: actor })), 409);
  assert.equal(await status(f.remove({ who: uuid(999) })), 404);
  assert.equal(await status(f.remove({ who: outsider })), 404);
  assert.equal(await status(f.remove({ who: 'not-a-uuid' })), 404);
  assert.equal(f.members(shop).length, 4);
  assert.equal(f.rows('SELECT * FROM shop_member_removal_receipts').length, 0);
});

test('body validation rejects extra fields and bad operation ids', () => {
  for (const body of [{}, { operationId: 'x' }, { operationId: uuid(1), role: 'member' }, { operationId: uuid(1), email: 'a@b.c' }, { operationId: 5 }]) assert.throws(() => validateMemberRemoval(target, body), { status: 400 });
});

test('replay is a no-op; same key for another target is 409; new key for an already removed member is a no-op', async () => {
  const f = fixture();
  await f.remove({ op: uuid(100) });
  const audits = () => f.rows("SELECT * FROM access_audit WHERE event='member_removed'").length;
  assert.deepEqual(await f.remove({ op: uuid(100) }), { removed: false });
  assert.equal(await status(f.remove({ op: uuid(100), who: bystander })), 409);
  assert.equal(await status(f.remove({ op: uuid(101) })), 404, 'a new operation for a gone member is not found');
  assert.equal(audits(), 1);
  assert.equal(f.rows('SELECT * FROM shop_member_removal_receipts').length, 1);
});

test('replay after the member was re-added is a conflict, never a second removal', async () => {
  const f = fixture();
  await f.remove({ op: uuid(100) });
  f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, target, 'member', 'again');
  assert.equal(await status(f.remove({ op: uuid(100) })), 409);
  assert.ok(f.members(shop).includes(target));
});

test('a failing audit insert rolls back the removal, receipt and cleanup together', async () => {
  const f = fixture();
  f.sqlite.exec("CREATE TRIGGER block_audit BEFORE INSERT ON access_audit WHEN NEW.event='member_removed' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END");
  await assert.rejects(f.remove());
  assert.ok(f.members(shop).includes(target));
  assert.equal(f.rows('SELECT * FROM shop_member_removal_receipts').length, 0);
  assert.equal(f.rows('SELECT * FROM push_subscriptions').length, 3);
  assert.equal(f.rows('SELECT * FROM user_shop_preferences').length, 2);
});

test('removal racing a promotion of the same member leaves exactly one outcome', async () => {
  const f = fixture();
  const gate = (db, run) => ({ ...db, batch: async s => { run(); return db.batch(s); } });
  const promoted = () => promoteHouseholdMember(f.db, principal(otherOwner), { userId: otherOwner, householdId: shop }, target, { operationId: uuid(200) });
  // Promotion commits between removal's preflight and its batch.
  const racing = f.remove({ database: gate(f.db, () => f.sqlite.prepare("UPDATE memberships SET role='owner' WHERE household_id=? AND user_id=?").run(shop, target)) });
  assert.equal(await status(racing), 409);
  assert.equal(f.rows('SELECT role FROM memberships WHERE household_id=? AND user_id=?'.replace('?', `'${shop}'`).replace('?', `'${target}'`))[0].role, 'owner');
  assert.equal(f.rows("SELECT * FROM access_audit WHERE event='member_removed'").length, 0);
  assert.equal(f.rows('SELECT * FROM shop_member_removal_receipts').length, 0);
  assert.equal(await status(promoted()), 200, 'later promotion of an owner is a harmless no-op');
});

test('removal racing a removal by another owner yields one event', async () => {
  const f = fixture();
  const other = () => removeHouseholdMember(f.db, principal(otherOwner), { userId: otherOwner, householdId: shop }, target, { operationId: uuid(300) });
  const racing = f.remove({ database: { ...f.db, batch: async s => { await other(); return f.db.batch(s); } } });
  assert.deepEqual(await racing, { removed: false });
  assert.equal(f.rows("SELECT * FROM access_audit WHERE event='member_removed'").length, 1);
  assert.equal(f.members(shop).includes(target), false);
});

test('an owner demoted between preflight and batch cannot remove anyone', async () => {
  const f = fixture();
  const racing = f.remove({ database: { ...f.db, batch: async s => { f.sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id=? AND user_id=?").run(shop, actor); return f.db.batch(s); } } });
  assert.equal(await status(racing), 403);
  assert.ok(f.members(shop).includes(target));
});

test('missing 0016 schema fails closed as 503', async () => {
  const f = fixture();
  f.sqlite.exec('DROP TRIGGER shop_member_removal_receipt_guard; DROP TABLE shop_member_removal_receipts');
  assert.equal(await status(f.remove()), 503);
});

test('0016 preserves audit history, allows the new event, and keeps the old ones', () => {
  const f = fixture();
  f.sqlite.prepare('INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)').run('a1', 'member_promoted', shop, actor, 'user:x', 'now', 'r');
  assert.ok(f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='access_audit_household_created_at'").get());
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => f.sqlite.prepare('INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)').run('bad', 'demotion', shop, actor, 'x', 'now', 'r'), /CHECK/);
});
