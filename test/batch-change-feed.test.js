import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createD1Store } from '../lib/store-d1.js';
import { currentChangeCursor, listBatchChanges, parseChangeQuery, pruneBatchChanges } from '../lib/batch-changes.js';

const op = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
function d1(sqlite) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...values),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } })
  });
  return { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const out = []; for (const item of statements) out.push(await item.run()); sqlite.exec('COMMIT'); return out; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const id of ['a', 'b']) {
    sqlite.prepare("INSERT INTO users VALUES (?, 'now')").run(`user-${id}`);
    sqlite.prepare("INSERT INTO households VALUES (?, ?, 'now')").run(`shop-${id}`, `Shop ${id}`);
    sqlite.prepare("INSERT INTO memberships VALUES (?, ?, 'owner', 'now')").run(`shop-${id}`, `user-${id}`);
  }
  const db = d1(sqlite), photos = { put: async () => {}, delete: async () => {} };
  const store = id => createD1Store(db, photos, { publicKey: 'test' }, { householdId: `shop-${id}`, userId: `user-${id}`, displayName: id });
  return { sqlite, db, a: store('a'), b: store('b'), log: () => sqlite.prepare('SELECT seq,household_id,batch_id,revision,kind FROM batch_changes ORDER BY seq').all() };
}
const medicine = (name = 'Aspirin', extra = {}) => ({ name, form: 'Tablets', quantity: 5, unit: 'tablets', low_stock_threshold: 1, ...extra });

test('every mutation appends exactly one feed row in the same batch, with the resulting revision and kind', async () => {
  const f = fixture();
  const created = await f.a.create({ ...medicine(), operationId: op(1), baseRevision: 0 });
  assert.deepEqual(f.log().map(r => [r.household_id, r.batch_id, r.revision, r.kind]), [['shop-a', created.id, 1, 'upsert']]);
  const updated = await f.a.update(created.id, { ...medicine('Aspirin 2'), operationId: op(2), baseRevision: 1 });
  assert.equal(updated.revision, 2);
  await f.a.consume(created.id, { amount: 2, operationId: op(3), baseRevision: 2 });
  await f.a.consume(created.id, { amount: 3, operationId: op(4), baseRevision: 3 });
  assert.deepEqual(f.log().map(r => [r.revision, r.kind]), [[1, 'upsert'], [2, 'upsert'], [3, 'upsert'], [4, 'remove']]);
  const other = await f.a.create({ ...medicine('Other'), operationId: op(5), baseRevision: 0 });
  await f.a.discard(other.id, { operationId: op(6), baseRevision: 1 });
  assert.deepEqual(f.log().slice(-2).map(r => [r.batch_id === other.id, r.revision, r.kind]), [[true, 1, 'upsert'], [true, 2, 'remove']]);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM mutation_receipts').get().n, 6);
  assert.equal(f.log().length, 6);
});

test('legacy requests without operation IDs are also recorded', async () => {
  const f = fixture();
  const created = await f.a.create(medicine());
  await f.a.update(created.id, medicine('Renamed'));
  await f.a.consume(created.id, 1);
  const gone = await f.a.create(medicine('Gone'));
  await f.a.discard(gone.id);
  assert.deepEqual(f.log().map(r => [r.batch_id === created.id, r.revision, r.kind]), [[true, 1, 'upsert'], [true, 2, 'upsert'], [true, 3, 'upsert'], [false, 1, 'upsert'], [false, 2, 'remove']]);
});

test('replays, stale revisions, and failed mutations add no feed rows', async () => {
  const f = fixture();
  const created = await f.a.create({ ...medicine(), operationId: op(1), baseRevision: 0 });
  await f.a.create({ ...medicine(), operationId: op(1), baseRevision: 0 });
  await f.a.consume(created.id, { amount: 1, operationId: op(2), baseRevision: 1 });
  await f.a.consume(created.id, { amount: 1, operationId: op(2), baseRevision: 1 });
  await assert.rejects(() => f.a.consume(created.id, { amount: 1, operationId: op(3), baseRevision: 1 }), { status: 409 });
  await assert.rejects(() => f.a.update(created.id, { ...medicine(), operationId: op(4), baseRevision: 1 }), { status: 409 });
  await assert.rejects(() => f.a.discard(created.id, { operationId: op(5), baseRevision: 1 }), { status: 409 });
  await assert.rejects(() => f.a.consume(created.id, { amount: 99, operationId: op(6), baseRevision: 2 }), { status: 400 });
  assert.equal(f.log().length, 2);
});

test('a failed receipt rolls back the mutation and its feed row together', async () => {
  const f = fixture();
  const created = await f.a.create({ ...medicine(), operationId: op(1), baseRevision: 0 });
  f.sqlite.exec("CREATE TRIGGER block_receipts BEFORE INSERT ON mutation_receipts WHEN NEW.operation='consume' BEGIN SELECT RAISE(ABORT, 'no receipts'); END");
  await assert.rejects(() => f.a.consume(created.id, { amount: 1, operationId: op(2), baseRevision: 1 }));
  assert.equal(f.log().length, 1);
  assert.equal(f.sqlite.prepare('SELECT quantity, revision FROM batches WHERE id=?').get(created.id).quantity, 5);
  assert.equal(f.sqlite.prepare('SELECT revision FROM batches WHERE id=?').get(created.id).revision, 1);
});

test('pages have exact keys, collapse to the latest state, honor limit/more/nextAfter, and never leak internals', async () => {
  const f = fixture();
  const one = await f.a.create({ ...medicine('One'), operationId: op(1), baseRevision: 0 });
  await f.a.update(one.id, { ...medicine('One v2'), operationId: op(2), baseRevision: 1 });
  const two = await f.a.create({ ...medicine('Two'), operationId: op(3), baseRevision: 0 });
  const three = await f.a.create({ ...medicine('Three'), operationId: op(4), baseRevision: 0 });
  await f.a.discard(two.id, { operationId: op(5), baseRevision: 1 });

  const all = await listBatchChanges(f.db, 'shop-a', { after: 0, limit: 100 });
  assert.deepEqual(Object.keys(all), ['changes', 'nextAfter', 'more', 'reset']);
  assert.deepEqual(all.changes.map(c => [c.id, c.kind]), [[one.id, 'upsert'], [three.id, 'upsert'], [two.id, 'remove']]);
  assert.equal(all.changes[0].batch.name, 'One v2');
  assert.equal(all.changes[0].revision, 2);
  assert.equal(all.changes[2].batch, null);
  for (const change of all.changes) assert.deepEqual(Object.keys(change), ['seq', 'id', 'kind', 'revision', 'batch']);
  assert.equal(JSON.stringify(all).includes('change_seq'), false);
  assert.equal(JSON.stringify(all).includes('photo_path'), false);
  assert.equal(all.more, false);
  assert.equal(all.nextAfter, f.log().at(-1).seq);

  const first = await listBatchChanges(f.db, 'shop-a', { after: 0, limit: 2 });
  assert.equal(first.more, true);
  assert.equal(first.nextAfter, f.log()[1].seq);
  const second = await listBatchChanges(f.db, 'shop-a', { after: first.nextAfter, limit: 2 });
  assert.equal(second.more, true);
  const third = await listBatchChanges(f.db, 'shop-a', { after: second.nextAfter, limit: 2 });
  assert.equal(third.more, false);
  const seen = new Set([...first.changes, ...second.changes, ...third.changes].map(c => c.id));
  assert.deepEqual([...seen].sort(), [one.id, two.id, three.id].sort());
  const exact = await listBatchChanges(f.db, 'shop-a', { after: 0, limit: 5 });
  assert.equal(exact.more, false, 'exactly-full page is not "more"');
  const empty = await listBatchChanges(f.db, 'shop-a', { after: all.nextAfter, limit: 10 });
  assert.deepEqual(empty, { changes: [], nextAfter: all.nextAfter, more: false, reset: false });
});

test('a medicine deleted by another device is a remove for cursors before it, and a bootstrap cursor never reports it', async () => {
  const f = fixture();
  const kept = await f.a.create({ ...medicine('Kept'), operationId: op(1), baseRevision: 0 });
  const doomed = await f.a.create({ ...medicine('Doomed'), operationId: op(2), baseRevision: 0 });
  const before = (await listBatchChanges(f.db, 'shop-a', { after: null })).nextAfter;

  await f.a.discard(doomed.id, { operationId: op(3), baseRevision: 1 });
  const page = await listBatchChanges(f.db, 'shop-a', { after: before, limit: 100 });
  assert.deepEqual(page.changes.map(c => [c.id, c.kind, c.revision, c.batch]), [[doomed.id, 'remove', 2, null]]);

  const fromStart = await listBatchChanges(f.db, 'shop-a', { after: 0, limit: 100 });
  assert.deepEqual(fromStart.changes.map(c => [c.id, c.kind]), [[kept.id, 'upsert'], [doomed.id, 'remove']]);

  const after = await listBatchChanges(f.db, 'shop-a', { after: page.nextAfter, limit: 100 });
  assert.deepEqual(after.changes, []);
  assert.deepEqual((await listBatchChanges(f.db, 'shop-b', { after: 0, limit: 100 })).changes, []);
});

test('changes are isolated between Shops, and forged cursors only skip the caller\'s own changes', async () => {
  const f = fixture();
  const mine = await f.a.create({ ...medicine('Mine'), operationId: op(1), baseRevision: 0 });
  const theirs = await f.b.create({ ...medicine('Theirs'), operationId: op(1), baseRevision: 0 });
  const seenByA = await listBatchChanges(f.db, 'shop-a', { after: 0, limit: 100 });
  const seenByB = await listBatchChanges(f.db, 'shop-b', { after: 0, limit: 100 });
  assert.deepEqual(seenByA.changes.map(c => c.id), [mine.id]);
  assert.deepEqual(seenByB.changes.map(c => c.id), [theirs.id]);
  const forged = await listBatchChanges(f.db, 'shop-a', { after: 10_000_000, limit: 100 });
  assert.deepEqual(forged.changes, []);
  assert.equal(await currentChangeCursor(f.db, 'shop-a'), seenByA.nextAfter);
  assert.equal(await currentChangeCursor(f.db, 'shop-b'), seenByB.nextAfter);
});

test('the starting cursor read before the list plus idempotent apply never misses a concurrent change', async () => {
  const f = fixture();
  const first = await f.a.create({ ...medicine('First'), operationId: op(1), baseRevision: 0 });
  const cursor = await listBatchChanges(f.db, 'shop-a', { after: null, limit: 100 });
  assert.equal(cursor.nextAfter, f.log().at(-1).seq);
  const snapshot = await f.a.list();
  // A change lands after the cursor read but before/while the list was produced.
  await f.a.update(first.id, { ...medicine('First v2'), operationId: op(2), baseRevision: 1 });
  const pending = await listBatchChanges(f.db, 'shop-a', { after: cursor.nextAfter, limit: 100 });
  assert.equal(pending.changes.length, 1);
  const local = new Map(snapshot.map(b => [b.id, b]));
  for (const change of pending.changes) if (!local.has(change.id) || local.get(change.id).revision < change.batch.revision) local.set(change.id, change.batch);
  assert.equal(local.get(first.id).name, 'First v2');
  // Applying the same page again changes nothing.
  for (const change of pending.changes) if (!local.has(change.id) || local.get(change.id).revision < change.batch.revision) assert.fail('apply must be idempotent');
});

test('pruning removes old feed rows and receipts, records a floor, and forces old cursors to reset without looping', async () => {
  const f = fixture();
  const created = await f.a.create({ ...medicine(), operationId: op(1), baseRevision: 0 });
  await f.a.update(created.id, { ...medicine('v2'), operationId: op(2), baseRevision: 1 });
  const oldSeq = f.log().at(-1).seq;
  f.sqlite.prepare("UPDATE batch_changes SET created_at='2020-01-01T00:00:00.000Z'").run();
  f.sqlite.prepare("UPDATE mutation_receipts SET created_at='2020-01-01T00:00:00.000Z' WHERE operation_id=?").run(op(1));
  const fresh = await f.a.create({ ...medicine('Fresh'), operationId: op(3), baseRevision: 0 });
  await pruneBatchChanges(f.db, () => new Date('2026-09-29T00:00:00.000Z'));
  assert.equal(f.log().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM mutation_receipts').get().n, 2);
  assert.equal(f.sqlite.prepare('SELECT seq FROM batch_change_floor').get().seq, oldSeq);

  const stale = await listBatchChanges(f.db, 'shop-a', { after: 1, limit: 100 });
  assert.deepEqual(stale, { changes: [], nextAfter: 1, more: false, reset: true });
  const atFloor = await listBatchChanges(f.db, 'shop-a', { after: oldSeq, limit: 100 });
  assert.equal(atFloor.reset, false);
  assert.deepEqual(atFloor.changes.map(c => c.id), [fresh.id]);
  // A quiet Shop's fresh cursor is never below the floor, so it cannot reset forever.
  assert.equal(await currentChangeCursor(f.db, 'shop-b'), oldSeq);
  assert.equal((await listBatchChanges(f.db, 'shop-b', { after: oldSeq, limit: 100 })).reset, false);
});

test('query parsing is strict', () => {
  const parse = query => parseChangeQuery(new URLSearchParams(query));
  assert.deepEqual(parse(''), { after: null, limit: 100 });
  assert.deepEqual(parse('after=0&limit=200'), { after: 0, limit: 200 });
  assert.deepEqual(parse('after=123456789012345&limit=1'), { after: 123456789012345, limit: 1 });
  for (const bad of ['after=', 'after=-1', 'after=1e3', 'after=+1', 'after=0x10', 'after=1234567890123456', 'limit=0', 'limit=201', 'limit=abc', 'limit=', 'after=0&limit=1.5']) {
    assert.throws(() => parse(bad), { status: 400 }, bad);
  }
});

test('missing feed schema fails closed as 503', async () => {
  const f = fixture();
  f.sqlite.exec('DROP TABLE batch_changes');
  await assert.rejects(() => listBatchChanges(f.db, 'shop-a', { after: 0, limit: 10 }), { status: 503 });
  await assert.rejects(() => currentChangeCursor(f.db, 'shop-a'), { status: 503 });
});

test('migration 0015 keeps existing throttle rows and accepts the changes route', () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort().filter(n => n < '0015')) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  sqlite.prepare("INSERT INTO household_invitation_route_throttle_events VALUES ('1','hash','pending','2026-01-01','2026-01-02')").run();
  sqlite.exec(readFileSync(new URL('../migrations/0015_batch_change_feed.sql', import.meta.url), 'utf8'));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM household_invitation_route_throttle_events').get().n, 1);
  sqlite.prepare("INSERT INTO household_invitation_route_throttle_events VALUES ('2','hash','changes','2026-01-01','2026-01-02')").run();
  assert.throws(() => sqlite.prepare("INSERT INTO household_invitation_route_throttle_events VALUES ('3','hash','bogus','2026-01-01','2026-01-02')").run());
  assert.equal(sqlite.prepare('SELECT seq FROM batch_change_floor').get().seq, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='batches'").get().n, 0);
});
