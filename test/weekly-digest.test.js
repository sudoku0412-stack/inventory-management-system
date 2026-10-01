import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueWeeklyDigests, inDigestWindow } from '../lib/digest.js';
import { memoryDb, seedPeople } from './db-fixture.js';

// Monday 2026-10-05, 14:15 UTC is inside the window.
const MONDAY = new Date('2026-10-05T14:15:00.000Z');

function setup() {
  const f = memoryDb();
  seedPeople(f.sqlite);
  return f;
}
let n = 0;
function batch(f, shop, { expiry = null, quantity = 10, threshold = 4, discarded = null } = {}) {
  n += 1;
  f.sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,expiry_date,low_stock_threshold,discarded_at,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(`b${n}`, `Item ${n}`, 'Tablets', quantity, 'tablet', expiry, threshold, discarded, 't', 't', shop);
}
const queued = f => f.rows("SELECT recipient_email,dedupe_key,payload FROM notification_outbox WHERE kind='weekly_digest' ORDER BY recipient_email").map(row => ({ ...row, payload: JSON.parse(row.payload) }));

test('the digest window is Monday 14:00 to 15:59 UTC only', () => {
  assert.equal(inDigestWindow(new Date('2026-10-05T14:00:00.000Z')), true);
  assert.equal(inDigestWindow(new Date('2026-10-05T15:59:59.000Z')), true);
  assert.equal(inDigestWindow(new Date('2026-10-05T13:59:59.000Z')), false);
  assert.equal(inDigestWindow(new Date('2026-10-05T16:00:00.000Z')), false);
  assert.equal(inDigestWindow(new Date('2026-10-06T14:30:00.000Z')), false);
});

test('outside the window nothing is queued, even when items need attention', async () => {
  const f = setup(); batch(f, 'h1', { expiry: '2026-09-01' });
  assert.equal(await enqueueWeeklyDigests(f.db, new Date('2026-10-06T14:30:00.000Z')), 0);
  assert.deepEqual(queued(f), []);
});

test('nothing is queued when every Shop is fine', async () => {
  const f = setup(); batch(f, 'h1', { expiry: '2027-06-01', quantity: 50 }); batch(f, 'h1', { expiry: null, quantity: 1 });
  assert.equal(await enqueueWeekly(f), 0);
});
const enqueueWeekly = f => enqueueWeeklyDigests(f.db, MONDAY);

test('counts expired, expiring within 30 days and low items per Shop; undated and discarded items are ignored', async () => {
  const f = setup();
  batch(f, 'h1', { expiry: '2026-09-01' });                         // expired
  batch(f, 'h1', { expiry: '2026-10-05' });                         // expires today
  batch(f, 'h1', { expiry: '2026-11-04' });                         // last day of the 30-day window
  batch(f, 'h1', { expiry: '2026-11-05', quantity: 2 });            // after the window, low stock
  batch(f, 'h1', { expiry: '2027-01-01', quantity: 4, threshold: 4 }); // low (at the threshold)
  batch(f, 'h1', { expiry: '2027-01-01', quantity: 5, threshold: 4 }); // fine
  batch(f, 'h1', { expiry: null, quantity: 0 });                    // no expiry: ignored
  batch(f, 'h1', { expiry: '2026-09-01', discarded: '2026-09-02' }); // discarded: ignored
  await enqueueWeekly(f);
  const owner = queued(f).find(row => row.recipient_email === 'owner@example.test');
  assert.deepEqual(owner.payload.shops, [{ name: 'Alpha', expired: 1, expiring: 2, low: 2 }]);
});

test('each person gets one email listing only their Shops that need attention', async () => {
  const f = setup();
  f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run('h2', 'u1', 'member', 't');
  batch(f, 'h1', { expiry: '2026-09-01' }); batch(f, 'h2', { expiry: '2026-09-01' });
  f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run('h3', 'Calm', 't');
  f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run('h3', 'u1', 'owner', 't');
  batch(f, 'h3', { expiry: '2028-01-01', quantity: 99 });
  assert.equal(await enqueueWeekly(f), 3);
  const rows = queued(f);
  assert.deepEqual(rows.map(row => row.recipient_email), ['member@example.test', 'other@example.test', 'owner@example.test']);
  assert.deepEqual(rows.find(row => row.recipient_email === 'owner@example.test').payload.shops.map(shop => shop.name), ['Alpha', 'Beta']);
  assert.deepEqual(rows.find(row => row.recipient_email === 'member@example.test').payload.shops.map(shop => shop.name), ['Alpha']);
});

test('a second run in the same week adds nothing, and the next week queues again', async () => {
  const f = setup(); batch(f, 'h1', { expiry: '2026-09-01' });
  await enqueueWeekly(f);
  const first = queued(f).length;
  await enqueueWeekly(f); await enqueueWeeklyDigests(f.db, new Date('2026-10-05T15:30:00.000Z'));
  assert.equal(queued(f).length, first);
  await enqueueWeeklyDigests(f.db, new Date('2026-10-12T14:15:00.000Z'));
  assert.equal(queued(f).length, first * 2);
  assert.match(queued(f)[0].dedupe_key, /^weekly_digest:u\d:2026-10-\d\d$/);
});

test('people who turned the summary off, Shops pending deletion and members without an email are skipped', async () => {
  const f = setup();
  batch(f, 'h1', { expiry: '2026-09-01' }); batch(f, 'h2', { expiry: '2026-09-01' });
  f.sqlite.prepare('INSERT INTO user_email_preferences (user_id,notices_enabled,digest_enabled,updated_at) VALUES (?,1,0,?)').run('u2', 't');
  f.sqlite.prepare('INSERT INTO household_deletions (household_id,deleted_at,purge_after,deleted_by_user_id) VALUES (?,?,?,?)').run('h2', 't', '2026-12-01', 'u3');
  f.sqlite.prepare("UPDATE identities SET email='' WHERE user_id='u1'").run();
  await enqueueWeekly(f);
  assert.deepEqual(queued(f), [], 'u1 has no email, u2 opted out, u3 only has a Shop that is being deleted');
});

test('a person with several addresses gets one email, to the alphabetically first address', async () => {
  const f = setup(); batch(f, 'h1', { expiry: '2026-09-01' });
  f.sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('apple', 'sub-extra', 'u1', 'a-first@example.test', 't');
  await enqueueWeekly(f);
  const owners = queued(f).filter(row => row.dedupe_key.startsWith('weekly_digest:u1:'));
  assert.deepEqual(owners.map(row => row.recipient_email), ['a-first@example.test']);
});

test('a person is listed for at most 20 Shops', async () => {
  const f = setup();
  for (let i = 0; i < 25; i += 1) {
    f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(`s${i}`, `Shop ${String(i).padStart(2, '0')}`, 't');
    f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(`s${i}`, 'u2', 'member', 't');
    batch(f, `s${i}`, { expiry: '2026-09-01' });
  }
  await enqueueWeekly(f);
  assert.equal(queued(f).find(row => row.recipient_email === 'member@example.test').payload.shops.length, 20);
});
