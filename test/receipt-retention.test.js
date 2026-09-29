import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_RECEIPT_RETENTION_DAYS, RECEIPT_TABLES, pruneReceipts, retentionDays } from '../lib/retention.js';

const NOW = new Date('2026-12-31T00:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  // Receipt guard triggers check live memberships on insert; these tests seed rows directly.
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) sqlite.exec(`DROP TRIGGER ${name}`);
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: statement };
  const seed = (table, column, when, key) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    const values = columns.map(c => c.name === column ? when : `${c.name}-${key}`);
    sqlite.prepare(`INSERT INTO ${table} (${columns.map(c => c.name).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
  };
  const count = table => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return { sqlite, db, seed, count };
}

test('receipts past retention are pruned; recent ones, audit history and tombstones are kept', async () => {
  const f = fixture();
  for (const [table, column] of RECEIPT_TABLES) {
    f.seed(table, column, daysAgo(200), 'old1'); f.seed(table, column, daysAgo(91), 'old2');
    f.seed(table, column, daysAgo(89), 'new1'); f.seed(table, column, daysAgo(1), 'new2');
  }
  f.sqlite.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) VALUES ('a','shop_created','h','u','t',?,'r')").run(daysAgo(400));
  f.seed('admin_audit', 'created_at', daysAgo(400), 'b'); f.seed('household_deletions', 'deleted_at', daysAgo(400), 'c');
  const deleted = await pruneReceipts(f.db, { now: () => NOW });
  for (const [table] of RECEIPT_TABLES) { assert.equal(deleted[table], 2, table); assert.equal(f.count(table), 2, table); }
  assert.equal(f.count('access_audit'), 1);
  assert.equal(f.count('admin_audit'), 1);
  assert.equal(f.count('household_deletions'), 1);
  assert.deepEqual(await pruneReceipts(f.db, { now: () => NOW }), {}, 'a second run finds nothing');
});

test('a run deletes at most a bounded page per table, oldest first', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i += 1) f.seed('shop_deletion_receipts', 'created_at', daysAgo(300 - i), `r${i}`);
  assert.equal((await pruneReceipts(f.db, { now: () => NOW, limit: 2 })).shop_deletion_receipts, 2);
  assert.equal(f.count('shop_deletion_receipts'), 3);
  assert.deepEqual(f.sqlite.prepare('SELECT household_id FROM shop_deletion_receipts ORDER BY created_at').all().map(r => r.household_id), ['household_id-r2', 'household_id-r3', 'household_id-r4']);
});

test('the retention period cannot be set below 30 days, and a missing table never stops the others', async () => {
  assert.equal(retentionDays({}), DEFAULT_RECEIPT_RETENTION_DAYS);
  for (const value of ['abc', '7', '29', '30.5', '-90', '']) assert.equal(retentionDays({ RECEIPT_RETENTION_DAYS: value }), DEFAULT_RECEIPT_RETENTION_DAYS, value);
  assert.equal(retentionDays({ RECEIPT_RETENTION_DAYS: '45' }), 45);
  const f = fixture();
  f.seed('shop_deletion_receipts', 'created_at', daysAgo(20), 'x');
  assert.deepEqual(await pruneReceipts(f.db, { now: () => NOW, days: 1 }), {}, 'a tiny value is floored to 30 days');
  f.sqlite.exec('DROP TABLE shop_creation_receipts');
  f.seed('shop_deletion_receipts', 'created_at', daysAgo(100), 'y');
  assert.equal((await pruneReceipts(f.db, { now: () => NOW })).shop_deletion_receipts, 1);
});

test('the scheduled handler runs the prune', () => {
  assert.match(readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8'), /pruneReceipts\(env\.DB, \{ days: retentionDays\(env\) \}\)/);
});
