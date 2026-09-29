import { deletionReadSchema } from './deletion-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { promoteHouseholdMember } from '../lib/household-access.js';
import { createAdditionalShop } from '../lib/tenants.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const migration = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const actor = uuid(1), otherOwner = uuid(2), target = uuid(3), otherTarget = uuid(4), shop = uuid(5), otherShop = uuid(6);
const principal = userId => ({ provider: 'cloudflare_access', subject: userId, email: `${userId}@example.test` });
function fixture({ migrate = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0003_profile_settings.sql', '0004_household_tenants.sql', '0005_household_invitations.sql', '0006_household_invitation_expiration.sql', '0007_sync_mutation_foundation.sql', '0008_household_display_name_source.sql', '0009_seed_legacy_household_display_names.sql', '0010_access_audit.sql', '0011_user_shop_preferences.sql', '0012_shop_creation.sql']) sqlite.exec(migration(name));
  for (const id of [actor, otherOwner, target, otherTarget]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', id, id, `${id}@example.test`, 'before');
  }
  for (const id of [shop, otherShop]) {
    sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, id, 'before');
    for (const userId of [actor, otherOwner, target, otherTarget]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, userId, [actor, otherOwner].includes(userId) ? 'owner' : 'member', 'before');
    sqlite.prepare('INSERT INTO household_settings VALUES (?,?,?,?,?,?)').run(id, 'Name', 'Shop', 'Medicine cabinet', 'before', 'user');
    sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,photo_path,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?,?)').run(`batch-${id}`, 'Medicine', 'Tablets', 3, 'tablets', `photos/${id}.jpg`, 'before', 'before', id);
  }
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(actor, otherShop, 'unchanged actor');
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(target, shop, 'unchanged target');
  sqlite.prepare('INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)').run('old-audit', 'shop_created', shop, actor, `cloudflare_access:${actor}`, 'before', 'old-request');
  sqlite.exec(deletionReadSchema);
  if (migrate) sqlite.exec(migration('0013_shop_owner_promotion.sql'));
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  // No awaits inside a batch: real D1 serializes each atomic SQLite transaction.
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const results = statements.map(item => item.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const promote = (overrides = {}) => promoteHouseholdMember(overrides.db || db, principal(overrides.actor || actor), { userId: overrides.actor || actor, householdId: overrides.shop || shop }, overrides.target || target, { operationId: overrides.operationId || uuid(10) }, 'test-request', () => '2026-09-27T12:00:00.000Z');
  const rows = table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const snapshot = () => JSON.stringify(['memberships', 'shop_owner_promotion_receipts', 'access_audit'].map(rows));
  const unaffected = () => JSON.stringify(['households', 'users', 'identities', 'household_settings', 'batches', 'user_shop_preferences'].map(rows));
  return { sqlite, db, promote, rows, snapshot, unaffected };
}
function barrierDb(db, beforeBatch = () => {}) {
  let arrivals = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  return { ...db, batch: async statements => {
    if (++arrivals === 2) release();
    await ready; beforeBatch(); return db.batch(statements);
  }, arrivals: () => arrivals };
}

test('0013 preserves prior audit rows/index/FKs and rejects invalid events; invalid legacy FK aborts migration atomically', () => {
  const f = fixture({ migrate: false });
  try {
    const before = JSON.stringify(f.rows('access_audit'));
    f.sqlite.exec(migration('0013_shop_owner_promotion.sql'));
    assert.equal(JSON.stringify(f.rows('access_audit')), before);
    assert.ok(f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='access_audit_household_created_at'").get());
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => f.sqlite.prepare('INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)').run('bad', 'demotion', shop, actor, 'x', 'now', 'r'), /CHECK/);
  } finally { f.sqlite.close(); }
  const invalid = fixture({ migrate: false });
  try {
    invalid.sqlite.exec("PRAGMA foreign_keys=OFF; UPDATE access_audit SET actor_user_id='missing'; PRAGMA foreign_keys=ON;");
    const before = JSON.stringify(invalid.rows('access_audit'));
    invalid.sqlite.exec('BEGIN');
    assert.throws(() => invalid.sqlite.exec(migration('0013_shop_owner_promotion.sql')), /FOREIGN KEY|integrity/);
    invalid.sqlite.exec('ROLLBACK');
    assert.equal(JSON.stringify(invalid.rows('access_audit')), before);
    assert.equal(invalid.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='shop_owner_promotion_receipts'").get(), undefined);
  } finally { invalid.sqlite.close(); }
});

for (const scenario of ['receipt abort', 'update abort', 'audit abort', 'zero-row update', 'missing receipt']) test(`atomic promotion rolls back all effects on ${scenario}`, async () => {
  const f = fixture();
  try {
    const trigger = {
      'receipt abort': "CREATE TRIGGER fail_receipt BEFORE INSERT ON shop_owner_promotion_receipts BEGIN SELECT RAISE(ABORT,'forced receipt failure'); END;",
      'update abort': "CREATE TRIGGER fail_update BEFORE UPDATE ON memberships WHEN NEW.role='owner' BEGIN SELECT RAISE(ABORT,'forced update failure'); END;",
      'audit abort': "CREATE TRIGGER fail_audit BEFORE INSERT ON access_audit WHEN NEW.event='member_promoted' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END;",
      'zero-row update': "CREATE TRIGGER ignore_update BEFORE UPDATE ON memberships WHEN NEW.role='owner' BEGIN SELECT RAISE(IGNORE); END;",
      'missing receipt': "CREATE TRIGGER ignore_receipt BEFORE INSERT ON shop_owner_promotion_receipts BEGIN SELECT RAISE(IGNORE); END;"
    }[scenario];
    f.sqlite.exec(trigger);
    const before = f.snapshot(), untouched = f.unaffected();
    await assert.rejects(() => f.promote(), scenario.endsWith('abort') ? /forced .* failure/ : /NOT NULL constraint failed/);
    assert.equal(f.snapshot(), before); assert.equal(f.unaffected(), untouched);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.sqlite.close(); }
});

for (const loss of ['identity', 'owner role', 'target membership']) test(`stale preflight cannot promote after ${loss} disappears before its batch`, async () => {
  const f = fixture();
  try {
    const guarded = { ...f.db, batch: async statements => {
      if (loss === 'identity') f.sqlite.prepare('DELETE FROM identities WHERE user_id=?').run(actor);
      if (loss === 'owner role') f.sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id=? AND user_id=?").run(shop, actor);
      if (loss === 'target membership') f.sqlite.prepare('DELETE FROM memberships WHERE household_id=? AND user_id=?').run(shop, target);
      return f.db.batch(statements);
    } };
    const preferences = JSON.stringify(f.rows('user_shop_preferences'));
    await assert.rejects(() => f.promote({ db: guarded }), { status: loss === 'target membership' ? 404 : 403 });
    assert.equal(f.rows('shop_owner_promotion_receipts').length, 0);
    assert.equal(f.rows('access_audit').filter(row => row.event === 'member_promoted').length, 0);
    assert.equal(f.sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(shop, target)?.role, loss === 'target membership' ? undefined : 'member');
    assert.equal(JSON.stringify(f.rows('user_shop_preferences')), preferences);
  } finally { f.sqlite.close(); }
});

for (const scenario of ['duplicate operation', 'different owners same target', 'different targets']) test(`serialized concurrent promotion: ${scenario}`, async () => {
  const f = fixture();
  try {
    const racing = barrierDb(f.db), untouched = f.unaffected();
    const second = scenario === 'duplicate operation' ? {} : scenario === 'different owners same target' ? { actor: otherOwner, operationId: uuid(11) } : { target: otherTarget, operationId: uuid(11) };
    const outcomes = await Promise.all([f.promote({ db: racing }), f.promote({ ...second, db: racing })]);
    const changes = scenario === 'different targets' ? 2 : 1;
    assert.equal(racing.arrivals(), 2);
    assert.equal(outcomes.filter(outcome => outcome.changed).length, changes);
    assert.equal(f.rows('shop_owner_promotion_receipts').length, changes);
    assert.equal(f.rows('access_audit').filter(row => row.event === 'member_promoted').length, changes);
    assert.equal(f.unaffected(), untouched);
    assert.equal(f.sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(otherShop, target).role, 'member');
    assert.equal(f.sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(shop, actor).role, 'owner');
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.sqlite.close(); }
});

test('promotion and Shop creation contend at five ownerships without a sixth or partial receipts/audits', async () => {
  const f = fixture();
  try {
    for (const n of [30, 31, 32, 33]) {
      f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(uuid(n), `Owned ${n}`, 'before');
      f.sqlite.prepare("INSERT INTO memberships VALUES (?,?,'owner',?)").run(uuid(n), target, 'before');
    }
    const racing = barrierDb(f.db), preferences = JSON.stringify(f.rows('user_shop_preferences'));
    const outcomes = await Promise.allSettled([
      f.promote({ db: racing }),
      createAdditionalShop(racing, principal(target), { operationId: uuid(34), shopName: 'Competing creation', displayName: 'Target' }, { now: () => '2026-09-27T12:00:00.000Z' })
    ]);
    assert.equal(racing.arrivals(), 2);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.status, 409);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM memberships WHERE user_id=? AND role='owner'").get(target).n, 5);
    assert.equal(f.rows('shop_owner_promotion_receipts').length + f.rows('shop_creation_receipts').length, 1);
    assert.equal(f.rows('access_audit').filter(row => row.id !== 'old-audit').length, 1);
    assert.equal(JSON.stringify(f.rows('user_shop_preferences')), preferences);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.sqlite.close(); }
});

test('receipt scope distinguishes actors and Shops; key reuse conflicts, fresh authorization denies replay after loss', async () => {
  const f = fixture();
  try {
    assert.equal((await f.promote()).changed, true);
    assert.equal((await f.promote()).changed, false);
    await assert.rejects(() => f.promote({ target: otherTarget }), { status: 409 });
    assert.equal((await f.promote({ actor: otherOwner, target: otherTarget })).changed, true);
    assert.equal((await f.promote({ shop: otherShop })).changed, true);
    assert.equal(f.rows('shop_owner_promotion_receipts').length, 3);
    f.sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id=? AND user_id=?").run(shop, actor);
    await assert.rejects(() => f.promote(), { status: 403 });
    assert.equal(f.rows('shop_owner_promotion_receipts').length, 3);
  } finally { f.sqlite.close(); }
});
