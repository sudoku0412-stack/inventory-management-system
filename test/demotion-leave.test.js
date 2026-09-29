import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { demoteHouseholdOwner, leaveHousehold, removeHouseholdMember, validateOwnerDemotion, validateShopLeave } from '../lib/household-access.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const [a, b, m, outsider] = [1, 2, 3, 4].map(uuid), [shop, other] = [11, 12].map(uuid);
const principal = id => ({ provider: 'cloudflare_access', subject: id, email: `${id}@example.test` });

function fixture(roles = { [a]: 'owner', [b]: 'owner', [m]: 'member' }) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const id of [a, b, m, outsider]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', id, id, `${id}@example.test`, 'before');
  }
  for (const id of [shop, other]) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, id, 'before');
  for (const [id, role] of Object.entries(roles)) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(other, outsider, 'owner', 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(other, a, 'member', 'before');
  const sub = (endpoint, h, u) => sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)').run(endpoint, 'p', 'a', h, u, 'before');
  sub('m-here', shop, m); sub('b-here', shop, b); sub('b-other', other, b);
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(b, shop, 'before');
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = statements.map(item => item.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const demote = ({ by = a, who = b, op = uuid(100), h = shop, database = db, body } = {}) => demoteHouseholdOwner(database, principal(by), { userId: by, householdId: h }, who, body ?? { operationId: op });
  const leave = ({ by = b, op = uuid(200), h = shop, database = db, body } = {}) => leaveHousehold(database, principal(by), { userId: by, householdId: h }, body ?? { operationId: op });
  const rows = sql => sqlite.prepare(sql).all().map(r => ({ ...r }));
  const role = (h, u) => sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(h, u)?.role ?? null;
  const events = e => rows(`SELECT actor_user_id,target_identifier FROM access_audit WHERE event='${e}'`);
  return { sqlite, db, demote, leave, rows, role, events };
}
const status = p => p.then(() => 200, e => e.status ?? e);

test('an owner demotes another owner: role only, receipt and audit, nothing else changes', async () => {
  const f = fixture();
  assert.deepEqual(await f.demote(), { member: { user_id: b, role: 'member' }, changed: true });
  assert.equal(f.role(shop, b), 'member');
  assert.equal(f.role(shop, a), 'owner');
  assert.deepEqual(f.events('member_demoted'), [{ actor_user_id: a, target_identifier: `user:${b}` }]);
  assert.equal(f.rows('SELECT * FROM shop_owner_demotion_receipts').length, 1);
  assert.equal(f.rows('SELECT * FROM push_subscriptions').length, 3, 'a demoted member keeps their subscriptions');
  assert.equal(f.rows('SELECT * FROM user_shop_preferences').length, 1);
  assert.equal(f.role(other, outsider), 'owner');
});

test('demotion authorization and targets', async () => {
  const f = fixture();
  assert.equal(await status(f.demote({ by: m })), 403);
  assert.equal(await status(f.demote({ by: outsider })), 403);
  assert.equal(await status(f.demote({ who: a })), 409, 'self-demotion is not offered');
  assert.equal(await status(f.demote({ who: uuid(999) })), 404);
  assert.equal(await status(f.demote({ who: outsider })), 404, 'foreign Shop member looks missing');
  assert.equal(await status(f.demote({ who: 'nope' })), 404);
  assert.deepEqual(await f.demote({ who: m }), { member: { user_id: m, role: 'member' }, changed: false });
  assert.equal(f.rows('SELECT * FROM shop_owner_demotion_receipts').length, 0);
});

test('body validation', () => {
  for (const body of [{}, { operationId: 'x' }, { operationId: uuid(1), role: 'owner' }]) {
    assert.throws(() => validateOwnerDemotion(b, body), { status: 400 });
    assert.throws(() => validateShopLeave(body), { status: 400 });
  }
});

test('the last owner can never be demoted; mutual demotion leaves exactly one owner', async () => {
  const f = fixture({ [a]: 'owner', [m]: 'member' });
  assert.equal(await status(f.demote({ who: a })), 409);
  const g = fixture();
  const racing = g.demote({ by: a, who: b, op: uuid(1), database: { ...g.db, batch: async s => {
    await g.demote({ by: b, who: a, op: uuid(2) });
    return g.db.batch(s);
  } } });
  assert.equal(await status(racing), 403, 'the demoted actor loses ownership first');
  assert.equal(g.role(shop, a), 'member');
  assert.equal(g.role(shop, b), 'owner');
  assert.equal(g.events('member_demoted').length, 1);
});

test('demotion replay is a no-op; same key for another target is 409; re-promoted target conflicts', async () => {
  const f = fixture({ [a]: 'owner', [b]: 'owner', [m]: 'owner' });
  await f.demote({ op: uuid(100) });
  assert.deepEqual(await f.demote({ op: uuid(100) }), { member: { user_id: b, role: 'member' }, changed: false });
  assert.equal(await status(f.demote({ op: uuid(100), who: m })), 409);
  f.sqlite.prepare("UPDATE memberships SET role='owner' WHERE household_id=? AND user_id=?").run(shop, b);
  assert.equal(await status(f.demote({ op: uuid(100) })), 409);
  assert.equal(f.events('member_demoted').length, 1);
});

test('demotion is atomic with its receipt and audit', async () => {
  const f = fixture();
  f.sqlite.exec("CREATE TRIGGER block BEFORE INSERT ON access_audit WHEN NEW.event='member_demoted' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  await assert.rejects(f.demote());
  assert.equal(f.role(shop, b), 'owner');
  assert.equal(f.rows('SELECT * FROM shop_owner_demotion_receipts').length, 0);
});

test('a member leaves: membership, this Shop\'s subscriptions and preference go; everything else stays', async () => {
  const f = fixture();
  f.sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(m, shop, 'before');
  assert.deepEqual(await f.leave({ by: m }), { left: true });
  assert.equal(f.role(shop, m), null);
  assert.deepEqual(f.rows('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').map(r => r.endpoint), ['b-here', 'b-other']);
  assert.deepEqual(f.rows('SELECT user_id FROM user_shop_preferences').map(r => r.user_id), [b]);
  assert.deepEqual(f.events('member_left'), [{ actor_user_id: m, target_identifier: `user:${m}` }]);
  assert.equal(f.rows('SELECT * FROM users').length, 4);
});

test('an owner may leave only while another owner remains, and their other Shops are untouched', async () => {
  const f = fixture();
  assert.deepEqual(await f.leave({ by: b }), { left: true });
  assert.equal(f.role(shop, b), null);
  assert.equal(f.rows("SELECT * FROM push_subscriptions WHERE endpoint='b-other'").length, 1);
  assert.equal(await status(f.leave({ by: a })), 409, 'now the last owner');
  assert.equal(f.role(shop, a), 'owner');
  const solo = fixture({ [a]: 'owner', [m]: 'member' });
  assert.equal(await status(solo.leave({ by: a })), 409);
  assert.equal(solo.rows('SELECT * FROM shop_member_leave_receipts').length, 0);
});

test('leave: non-members are 403, replay is a conflict while a member and a no-op after leaving', async () => {
  const f = fixture();
  assert.equal(await status(f.leave({ by: outsider })), 403);
  assert.equal(await status(f.leave({ by: 'ghost' })), 403);
  await f.leave({ by: m, op: uuid(201) });
  assert.deepEqual(await f.leave({ by: m, op: uuid(201) }), { left: false });
  f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, m, 'member', 'again');
  assert.equal(await status(f.leave({ by: m, op: uuid(201) })), 409);
  assert.equal(f.role(shop, m), 'member');
  assert.equal(f.events('member_left').length, 1);
});

test('owner leaving racing another owner\'s demotion of them cannot empty the Shop', async () => {
  const f = fixture();
  const racing = f.leave({ by: a, op: uuid(300), database: { ...f.db, batch: async s => {
    await f.demote({ by: b, who: a, op: uuid(301) });
    return f.db.batch(s);
  } } });
  assert.deepEqual(await racing, { left: true }, 'the demoted owner may still leave as a member');
  assert.equal(f.role(shop, b), 'owner');
  const g = fixture();
  const other = g.leave({ by: a, op: uuid(310), database: { ...g.db, batch: async s => { await g.leave({ by: b, op: uuid(311) }); return g.db.batch(s); } } });
  assert.equal(await status(other), 409, 'the second owner to leave is refused');
  assert.equal(g.role(shop, a), 'owner');
});

test('leave is atomic with its receipt, audit and cleanup', async () => {
  const f = fixture();
  f.sqlite.exec("CREATE TRIGGER block BEFORE INSERT ON access_audit WHEN NEW.event='member_left' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  await assert.rejects(f.leave({ by: m }));
  assert.equal(f.role(shop, m), 'member');
  assert.equal(f.rows('SELECT * FROM shop_member_leave_receipts').length, 0);
  assert.equal(f.rows('SELECT * FROM push_subscriptions').length, 3);
});

test('demoted owners can then be removed, and removal still refuses owners', async () => {
  const f = fixture();
  assert.equal(await status(removeHouseholdMember(f.db, principal(a), { userId: a, householdId: shop }, b, { operationId: uuid(400) })), 409);
  await f.demote();
  assert.deepEqual(await removeHouseholdMember(f.db, principal(a), { userId: a, householdId: shop }, b, { operationId: uuid(401) }), { removed: true });
});

test('missing 0017 schema fails closed as 503', async () => {
  const f = fixture();
  f.sqlite.exec('DROP TRIGGER shop_owner_demotion_receipt_guard; DROP TABLE shop_owner_demotion_receipts; DROP TRIGGER shop_member_leave_receipt_guard; DROP TABLE shop_member_leave_receipts');
  assert.equal(await status(f.demote()), 503);
  assert.equal(await status(f.leave({ by: m })), 503);
});

test('0017 keeps audit history and allows exactly the new events', () => {
  const f = fixture();
  for (const e of ['member_demoted', 'member_left', 'member_removed', 'member_promoted']) f.sqlite.prepare('INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)').run(`id-${e}`, e, shop, a, 'x', 'now', 'r');
  assert.throws(() => f.sqlite.prepare('INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)').run('bad', 'nope', shop, a, 'x', 'now', 'r'), /CHECK/);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
