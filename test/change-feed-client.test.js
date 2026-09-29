import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindChangeFeed, decodeChangePage, decodeCursor } from '../public/change-feed-client.js';

const batch = (id, revision = 1) => ({ id, name: `Med ${id}`, revision, status: 'healthy', has_photo: false });
const upsert = (seq, id, revision = 1) => ({ seq, id, kind: 'upsert', revision, batch: batch(id, revision) });
const remove = (seq, id, revision = 2) => ({ seq, id, kind: 'remove', revision, batch: null });
const page = (changes = [], nextAfter = 0, more = false, reset = false) => ({ changes, nextAfter, more, reset });
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const fail = (status, retryAfter) => Object.assign(Error('x'), { status, retryAfter });

function harness({ handler, eligible = true, context, onAccessLost } = {}) {
  const state = { time: 1_000_000, eligible, applied: [], reloads: 0, requests: [], timers: [], context: context || { accountContextKey: 'acct', activeShopId: 'shop-a' } };
  const feed = bindChangeFeed({
    getContext: () => state.context,
    request: async path => { state.requests.push(path); return handler(path, state); },
    applyChanges: changes => state.applied.push(...changes),
    reloadAll: async () => { state.reloads += 1; },
    isEligible: () => state.eligible, onAccessLost: () => { state.lost = (state.lost || 0) + 1; onAccessLost?.(); },
    now: () => state.time, random: () => 0.5,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; state.timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; }
  });
  state.feed = feed;
  state.live = () => state.timers.filter(timer => !timer.cleared);
  state.fire = async () => { const timer = state.live().at(-1); timer.cleared = true; timer.fn(); await flush(); };
  return state;
}

test('decoders require the exact deployed shape', () => {
  assert.deepEqual(decodeChangePage(page([upsert(1, 'a'), remove(2, 'b')], 2, true)), page([upsert(1, 'a'), remove(2, 'b')], 2, true));
  assert.equal(decodeCursor(page([], 42)), 42);
  const bad = [null, [], {}, { ...page(), extra: 1 }, { changes: [], nextAfter: 0, more: false }, page([], -1), page([], 1.5), page([], 0, 'no'), page([], 0, false, 'no'),
    page([{ ...upsert(1, 'a'), batch: null }]), page([{ ...remove(1, 'a'), batch: batch('a') }]), page([{ ...upsert(1, 'a'), kind: 'weird' }]), page([{ ...upsert(1, 'a'), batch: batch('other') }]),
    page([{ ...upsert(1, 'a', 2), batch: batch('a', 1) }]), page([{ ...upsert(1, 'a'), seq: '1' }]), page(Array.from({ length: 201 }, (_, i) => remove(i, `x${i}`)))];
  for (const value of bad) assert.throws(() => decodeChangePage(value), /not recognized/);
  assert.throws(() => decodeCursor(page([upsert(1, 'a')], 1)), /not recognized/);
  assert.throws(() => decodeCursor(page([], 1, true)), /not recognized/);
});

test('cursor is read before the list; failures leave the feed off and a 404 disables it', async () => {
  let h = harness({ handler: async () => page([], 7) });
  assert.equal(await h.feed.readCursor(), 7);
  assert.deepEqual(h.requests, ['/api/changes']);
  h = harness({ handler: async () => { throw fail(503); } });
  assert.equal(await h.feed.readCursor(), null);
  assert.equal(h.feed.disabled, false);
  h = harness({ handler: async () => { throw fail(404); } });
  assert.equal(await h.feed.readCursor(), null);
  assert.equal(h.feed.disabled, true);
  h = harness({ handler: async () => ({ garbage: true }) });
  assert.equal(await h.feed.readCursor(), null);
});

test('start polls after adopt, applies changes, advances the cursor, follows pages up to the cap, and schedules the next tick', async () => {
  let calls = 0;
  const h = harness({ handler: async path => {
    calls += 1;
    if (path.includes('after=5')) return page([upsert(6, 'a')], 6, true);
    if (path.includes('after=6')) return page([remove(7, 'a', 2)], 7, false);
    return page([], 7);
  } });
  h.feed.adopt(5);
  h.feed.start(); await flush();
  assert.deepEqual(h.requests, ['/api/changes?after=5&limit=100', '/api/changes?after=6&limit=100']);
  assert.deepEqual(h.applied.map(c => c.seq), [6, 7]);
  assert.equal(h.feed.cursor, 7);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 60_000);
  await h.fire();
  assert.equal(h.requests.at(-1), '/api/changes?after=7&limit=100');
  assert.equal(calls, 3);
  assert.equal(h.applied.length, 2, 'empty page applies nothing');
});

test('a runaway "more" chain is capped per tick', async () => {
  let cursor = 0;
  const h = harness({ handler: async () => page([upsert(++cursor, `id${cursor}`)], cursor, true) });
  h.feed.adopt(0); h.feed.start(); await flush();
  assert.equal(h.requests.length, 5);
});

test('nothing is requested while ineligible (hidden tab, other view, local mode); wake resumes immediately', async () => {
  const h = harness({ handler: async () => page([], 3), eligible: false });
  h.feed.adopt(3); h.feed.start(); await flush();
  assert.equal(h.requests.length, 0);
  await h.fire();
  assert.equal(h.requests.length, 0, 'timer tick while ineligible is a no-op that reschedules');
  assert.equal(h.live().length, 1);
  h.feed.wake(); await flush();
  assert.equal(h.requests.length, 0, 'wake while still ineligible is a no-op');
  h.eligible = true;
  h.feed.wake(); await flush();
  assert.deepEqual(h.requests, ['/api/changes?after=3&limit=100']);
});

test('failures back off exponentially with jitter bounds and a 5 minute ceiling; success resets', async () => {
  let failing = true;
  const h = harness({ handler: async () => { if (failing) throw fail(500); return page([], 3); } });
  h.feed.adopt(3); h.feed.start(); await flush();
  const delays = [h.live().at(-1).ms];
  for (let i = 0; i < 6; i += 1) { await h.fire(); delays.push(h.live().at(-1).ms); }
  assert.deepEqual(delays.slice(0, 3), [120_000, 240_000, 300_000]);
  assert.ok(delays.every(ms => ms <= 300_000));
  failing = false;
  await h.fire();
  assert.equal(h.live().at(-1).ms, 60_000);
});

test('429 waits for the validated Retry-After without sending, and 404 disables the feed', async () => {
  let mode = 'limit';
  const h = harness({ handler: async () => { if (mode === 'limit') throw fail(429, 90); if (mode === 'gone') throw fail(404); return page([], 3); } });
  h.feed.adopt(3); h.feed.start(); await flush();
  assert.equal(h.requests.length, 1);
  assert.ok(h.live().at(-1).ms >= 90_000);
  h.time += 30_000;
  await h.fire();
  assert.equal(h.requests.length, 1, 'still blocked');
  h.time += 61_000; mode = 'gone';
  await h.fire();
  assert.equal(h.requests.length, 2);
  assert.equal(h.feed.disabled, true);
  assert.equal(h.live().length, 0);
});

test('reset triggers a full reload and drops the cursor until the next adopt', async () => {
  const h = harness({ handler: async () => page([], 0, false, true) });
  h.feed.adopt(1); h.feed.start(); await flush();
  assert.equal(h.reloads, 1);
  assert.equal(h.feed.cursor, null);
  assert.deepEqual(h.applied, []);
  h.feed.adopt(20);
  assert.equal(h.feed.cursor, 20);
});

test('a Shop or account switch mid-flight is ignored', async () => {
  for (const next of [{ accountContextKey: 'acct', activeShopId: 'shop-b' }, { accountContextKey: 'other', activeShopId: 'shop-a' }]) {
  let release;
  const state = { context: { accountContextKey: 'acct', activeShopId: 'shop-a' }, applied: [] };
  const feed = bindChangeFeed({
    getContext: () => state.context, request: () => new Promise(resolve => { release = resolve; }),
    applyChanges: changes => state.applied.push(...changes), reloadAll: async () => {}, isEligible: () => true,
    setTimer: () => ({}), clearTimer: () => {}, random: () => 0.5
  });
  feed.adopt(8); feed.start();
  await flush();
  state.context = next;
  release(page([upsert(9, 'late')], 9));
  await flush();
  assert.deepEqual(state.applied, []);
  assert.equal(feed.cursor, 8);
  }
});

test('a malformed page is treated as a failure and applies nothing', async () => {
  const h = harness({ handler: async () => ({ changes: [{ seq: 1 }], nextAfter: 1, more: false, reset: false }) });
  h.feed.adopt(0); h.feed.start(); await flush();
  assert.deepEqual(h.applied, []);
  assert.equal(h.feed.cursor, 0);
  assert.equal(h.live().at(-1).ms, 120_000);
});

test('the safety net reloads the full list every ten minutes and revives a feed with no cursor', async () => {
  const h = harness({ handler: async () => page([], 3) });
  h.feed.adopt(3); h.feed.start(); await flush();
  assert.equal(h.reloads, 0);
  h.time += 10 * 60_000 + 1;
  await h.fire();
  assert.equal(h.reloads, 1);
  assert.equal(h.requests.filter(path => path.includes('after=')).length, 1, 'reload replaces that tick');

  const dead = harness({ handler: async () => page([], 3) });
  dead.feed.adopt(null); dead.feed.start(); await flush();
  assert.equal(dead.reloads, 0);
  dead.time += 10 * 60_000 + 1;
  await dead.fire();
  assert.equal(dead.reloads, 1);
});

test('stop clears timers', async () => {
  const h = harness({ handler: async () => page([], 3) });
  h.feed.adopt(3); h.feed.start(); await flush();
  h.feed.stop();
  assert.equal(h.live().length, 0);
});

test('app wiring: eligibility, cursor-before-list, apply semantics, and no unsafe rendering', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../public/change-feed-client.js', import.meta.url), 'utf8');
  assert.match(app, /const startCursor=localShopMode\|\|!shopContext\?null:await changeFeed\.readCursor\(\)/);
  assert.ok(app.indexOf('await changeFeed.readCursor()') < app.indexOf("api('/api/batches')"), 'cursor is read before the list');
  assert.match(app, /changeFeed\.adopt\(startCursor\)/);
  assert.match(app, /document\.visibilityState==='visible'&&\['dashboard','inventory'\]\.includes\(currentView\)/);
  assert.match(app, /if\(!localShopMode\)changeFeed\.start\(\)/);
  assert.match(app, /medicines\[i\]\.revision<c\.batch\.revision/);
  assert.match(app, /openBatchState\(c\.id\)/);
  assert.match(app, /addEventListener\('visibilitychange'/);
  assert.doesNotMatch(client, /innerHTML|setInterval|X-Shop-Id|localStorage/);
});

test('403 (access removed) stops the feed permanently and reports access loss exactly once', async () => {
  const h = harness({ handler: async () => { throw fail(403); } });
  h.feed.adopt(3); h.feed.start(); await flush();
  assert.equal(h.lost, 1);
  assert.equal(h.feed.disabled, true);
  assert.equal(h.live().length, 0);
  h.feed.wake(); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.lost, 1);
});
