import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { transferHouseholdOwnership, validateOwnershipTransfer } from '../lib/household-access.js';

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
  sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)').run('a-here', 'p', 'a', shop, a, 'before');
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(a, shop, 'before');
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = statements.map(item => item.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const transfer = ({ by = a, who = m, op = uuid(100), h = shop, database = db, body } = {}) => transferHouseholdOwnership(database, principal(by), { userId: by, householdId: h }, who, body ?? { operationId: op });
  const rows = sql => sqlite.prepare(sql).all().map(r => ({ ...r }));
  const role = (h, u) => sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(h, u)?.role ?? null;
  const events = () => rows("SELECT actor_user_id,target_identifier FROM access_audit WHERE event='ownership_transferred'");
  return { sqlite, db, transfer, rows, role, events };
}
const status = p => p.then(() => 200, e => e.status ?? e);

test('an owner transfers to a member atomically: roles swap, receipt and audit, nothing else changes', async () => {
  const f = fixture();
  assert.deepEqual(await f.transfer(), { transferred: true });
  assert.equal(f.role(shop, m), 'owner');
  assert.equal(f.role(shop, a), 'member');
  assert.equal(f.role(shop, b), 'owner');
  assert.deepEqual(f.events(), [{ actor_user_id: a, target_identifier: `user:${m}` }]);
  assert.equal(f.rows('SELECT * FROM shop_ownership_transfer_receipts').length, 1);
  assert.equal(f.rows('SELECT * FROM push_subscriptions').length, 1);
  assert.equal(f.rows('SELECT * FROM user_shop_preferences').length, 1);
  assert.equal(f.role(other, outsider), 'owner');
  assert.equal(f.role(other, a), 'member');
});

test('a sole owner can transfer and the Shop keeps exactly one owner', async () => {
  const f = fixture({ [a]: 'owner', [m]: 'member' });
  assert.deepEqual(await f.transfer(), { transferred: true });
  assert.deepEqual(f.rows("SELECT user_id FROM memberships WHERE household_id='" + shop + "' AND role='owner'"), [{ user_id: m }]);
});

test('authorization and target matrix', async () => {
  const f = fixture();
  assert.equal(await status(f.transfer({ by: m, who: b })), 403);
  assert.equal(await status(f.transfer({ by: outsider })), 403);
  assert.equal(await status(f.transfer({ who: a })), 409, 'self');
  assert.equal(await status(f.transfer({ who: b })), 409, 'existing owner');
  assert.equal(await status(f.transfer({ who: uuid(999) })), 404);
  assert.equal(await status(f.transfer({ who: outsider })), 404, 'foreign Shop member looks missing');
  assert.equal(await status(f.transfer({ who: 'nope' })), 404);
  assert.equal(f.rows('SELECT * FROM shop_ownership_transfer_receipts').length, 0);
  assert.equal(f.events().length, 0);
});

test('the target owning five Shops is refused with no partial state', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    const id = uuid(300 + i);
    f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, id, 'before');
    f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, m, 'owner', 'before');
  }
  assert.equal(await status(f.transfer()), 409);
  assert.equal(f.role(shop, m), 'member');
  assert.equal(f.role(shop, a), 'owner');
});

test('replay is safe and authorized by the receipt actor; key or target changes conflict', async () => {
  const f = fixture();
  await f.transfer();
  assert.deepEqual(await f.transfer(), { transferred: false }, 'the former owner can replay');
  assert.equal(f.rows('SELECT * FROM shop_ownership_transfer_receipts').length, 1);
  assert.equal(await status(f.transfer({ who: b })), 409, 'same key, other target');
  assert.equal(await status(f.transfer({ by: outsider })), 403);
  f.sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id=? AND user_id=?").run(shop, m);
  assert.equal(await status(f.transfer()), 409, 'replay after the target was demoted never grants again');
  assert.equal(f.role(shop, m), 'member');
});

test('a losing race leaves no partial state', async () => {
  const f = fixture();
  // The target is removed between the preflight and the batch.
  const racing = f.transfer({ database: { ...f.db, batch: async s => {
    f.sqlite.prepare('DELETE FROM memberships WHERE household_id=? AND user_id=?').run(shop, m);
    return f.db.batch(s);
  } } });
  assert.notEqual(await status(racing), 200);
  assert.equal(f.role(shop, a), 'owner');
  assert.equal(f.role(shop, m), null);
  assert.equal(f.events().length, 0);
  assert.equal(f.rows('SELECT * FROM shop_ownership_transfer_receipts').length, 0);
});

test('a failing audit insert rolls back the whole transfer', async () => {
  const f = fixture();
  f.sqlite.exec("CREATE TRIGGER block_transfer_audit BEFORE INSERT ON access_audit WHEN NEW.event='ownership_transferred' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;");
  await assert.rejects(f.transfer());
  assert.equal(f.role(shop, a), 'owner');
  assert.equal(f.role(shop, m), 'member');
  assert.equal(f.rows('SELECT * FROM shop_ownership_transfer_receipts').length, 0);
});

test('missing schema is a 503 and the migration creates the receipts table', async () => {
  const f = fixture();
  f.sqlite.exec('DROP TABLE shop_ownership_transfer_receipts');
  assert.equal(await status(f.transfer()), 503);
  const g = fixture();
  assert.ok(g.rows("SELECT name FROM sqlite_master WHERE name='shop_ownership_transfer_receipts'").length);
});

test('body validation', () => {
  for (const body of [{}, { operationId: 'x' }, { operationId: uuid(1), role: 'owner' }]) {
    assert.throws(() => validateOwnershipTransfer(m, body), { status: 400 });
  }
  assert.equal(validateOwnershipTransfer(m, { operationId: uuid(1) }), uuid(1));
});

test('UI contract: dialog, roster button, binding and asset allowlists are wired', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const html = read('public/index.html'), app = read('public/app.js');
  for (const id of ['transferOwnershipModal', 'transferOwnershipForm', 'confirmTransferOwnership', 'cancelTransferOwnership', 'transferOwnershipStatus']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(app, /import \{ bindOwnershipTransfer \} from '\.\/ownership-transfer-client\.js'/);
  assert.match(app, /data-transfer-member/);
  assert.ok(read('lib/shared.js').includes("'/ownership-transfer-client.js'"));
  assert.ok(read('worker/index.js').includes("'/ownership-transfer-client.js'"));
});
