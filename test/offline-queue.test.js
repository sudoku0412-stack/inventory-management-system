import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQueue, enqueue, entryFromRequest, pickFields, replayQueue, requestFor, statusFor } from '../public/offline-queue.js';
import { openOfflineStore } from '../public/offline-store.js';

const DAY = '2026-10-05';
const batch = (id, extra = {}) => ({ id, name: `Item ${id}`, strength: '', form: 'Tablets', quantity: 10, unit: 'tablet', expiry_date: '2027-06-01', location: 'Shelf', notes: '', low_stock_threshold: 4, revision: 3, updated_at: '2026-10-01T00:00:00.000Z', discarded_at: null, ...extra });
const make = (kind, extra = {}) => ({ kind, batchId: 'b1', operationId: `op-${kind}`, baseRevision: 3, editedAt: 1000, ...extra });

test('only the editable fields are picked from a batch', () => {
  const picked = pickFields({ ...batch('b1'), revision: 9, has_photo: true, photo_path: 'x' });
  assert.deepEqual(Object.keys(picked).sort(), ['expiry_date', 'form', 'location', 'low_stock_threshold', 'name', 'notes', 'quantity', 'strength', 'unit']);
  assert.deepEqual(pickFields(null), {});
});

test('status follows the server rules: unknown, expired, expiring, low, healthy', () => {
  assert.equal(statusFor({ expiry_date: null }, DAY), 'unknown');
  assert.equal(statusFor({ expiry_date: '2026-10-04', quantity: 99, low_stock_threshold: 4 }, DAY), 'expired');
  assert.equal(statusFor({ expiry_date: DAY, quantity: 99, low_stock_threshold: 4 }, DAY), 'expiring');
  assert.equal(statusFor({ expiry_date: '2026-11-04', quantity: 99, low_stock_threshold: 4 }, DAY), 'expiring');
  assert.equal(statusFor({ expiry_date: '2026-11-05', quantity: 4, low_stock_threshold: 4 }, DAY), 'low');
  assert.equal(statusFor({ expiry_date: '2026-11-05', quantity: 5, low_stock_threshold: 4 }, DAY), 'healthy');
});

test('requests become queue entries: create, update, consume and discard; anything else is not queueable', () => {
  const list = [batch('b1')];
  const create = entryFromRequest({ method: 'POST', path: '/api/batches', body: { name: 'New', quantity: 2, operationId: 'o1', baseRevision: 0 }, list, now: 5 });
  assert.deepEqual(create, { kind: 'create', batchId: 'pending-o1', fields: { name: 'New', quantity: 2 }, operationId: 'o1', baseRevision: 0, editedAt: 5 });
  assert.equal(entryFromRequest({ method: 'PATCH', path: '/api/batches/b1', body: { name: 'X', operationId: 'o2', baseRevision: 3 }, list, now: 6 }).kind, 'update');
  const consume = entryFromRequest({ method: 'POST', path: '/api/batches/b1/consume', body: { amount: 4, operationId: 'o3', baseRevision: 3 }, list, now: 7 });
  assert.deepEqual([consume.kind, consume.amount, consume.quantityAfter], ['consume', 4, 6]);
  assert.equal(entryFromRequest({ method: 'POST', path: '/api/batches/b1/consume', body: { amount: 99, operationId: 'o', baseRevision: 3 }, list }).quantityAfter, 0);
  assert.equal(entryFromRequest({ method: 'POST', path: '/api/batches/b1/discard', body: { operationId: 'o4', baseRevision: 3 }, list, now: 8 }).kind, 'discard');
  for (const input of [{ method: 'PATCH', path: '/api/batches/missing', body: { operationId: 'o' } }, { method: 'GET', path: '/api/batches', body: {} }, { method: 'POST', path: '/api/settings', body: {} }, { method: 'POST', path: '/api/batches', body: null }, { method: 'DELETE', path: '/api/batches/b1', body: {} }, { method: 'POST', path: '/api/batches/b1/photo', body: {} }]) assert.equal(entryFromRequest({ list, ...input }), null, `${input.method} ${input.path}`);
});

test('the queue keeps one entry per item and collapses later changes into it', () => {
  const create = make('create', { batchId: 'pending-1', baseRevision: 0, fields: { name: 'New', quantity: 5 } });
  assert.equal(enqueue([], create).length, 1);
  // create then update merges fields
  let q = enqueue([create], make('update', { batchId: 'pending-1', fields: { name: 'Renamed' }, editedAt: 2000 }));
  assert.deepEqual([q.length, q[0].kind, q[0].fields, q[0].editedAt], [1, 'create', { name: 'Renamed', quantity: 5 }, 2000]);
  // create then consume lowers quantity; consuming everything cancels the create
  q = enqueue([create], make('consume', { batchId: 'pending-1', amount: 2, quantityAfter: 3 }));
  assert.equal(q[0].fields.quantity, 3);
  assert.deepEqual(enqueue([create], make('consume', { batchId: 'pending-1', amount: 5, quantityAfter: 0 })), []);
  // create then discard disappears completely
  assert.deepEqual(enqueue([create], make('discard', { batchId: 'pending-1' })), []);
  // update then update, update then consume
  const update = make('update', { fields: { name: 'A' } });
  q = enqueue([update], make('update', { fields: { notes: 'B' }, editedAt: 3000 }));
  assert.deepEqual(q[0].fields, { name: 'A', notes: 'B' });
  q = enqueue([update], make('consume', { amount: 2, quantityAfter: 8 }));
  assert.deepEqual(q[0].fields, { name: 'A', quantity: 8 });
  // consume then consume adds up; consume then update keeps the first base revision
  const consume = make('consume', { amount: 2, quantityAfter: 8 });
  q = enqueue([consume], make('consume', { amount: 3, quantityAfter: 5, baseRevision: 9 }));
  assert.deepEqual([q[0].amount, q[0].quantityAfter, q[0].baseRevision], [5, 5, 3]);
  q = enqueue([consume], make('update', { fields: { name: 'Z' }, baseRevision: 9 }));
  assert.deepEqual([q[0].kind, q[0].baseRevision], ['update', 3]);
  // discard replaces an update and keeps the earliest base revision
  q = enqueue([update], make('discard', { baseRevision: 9 }));
  assert.deepEqual([q[0].kind, q[0].baseRevision], ['discard', 3]);
  // different items stay separate
  assert.equal(enqueue([update], make('update', { batchId: 'b2', fields: {} })).length, 2);
});

test('the list shows queued changes at once: new items, edits, consumed and discarded items', () => {
  const list = [batch('b1'), batch('b2'), batch('b3', { quantity: 2 })];
  const queue = [
    make('create', { batchId: 'pending-1', baseRevision: 0, fields: { name: 'New', form: 'Tablets', quantity: '3', unit: 'tablet', low_stock_threshold: '5', expiry_date: '2026-10-10' }, editedAt: Date.parse('2026-10-05T10:00:00.000Z') }),
    make('update', { batchId: 'b1', fields: { name: 'Edited', quantity: '2' } }),
    make('consume', { batchId: 'b2', amount: 3, quantityAfter: 7 }),
    make('discard', { batchId: 'b3' }),
    make('update', { batchId: 'ghost', fields: { name: 'ignored' } })
  ];
  const out = applyQueue(list, queue, DAY);
  assert.deepEqual(out.map(item => item.id), ['b1', 'b2', 'pending-1']);
  const created = out.find(item => item.id === 'pending-1');
  assert.deepEqual([created.quantity, created.low_stock_threshold, created.status, created.pending, created.revision], [3, 5, 'expiring', true, 0]);
  assert.deepEqual(out[0].pending, true); assert.equal(out[0].name, 'Edited'); assert.equal(out[0].quantity, 2); assert.equal(out[0].status, 'low');
  assert.equal(out[1].quantity, 7);
  assert.equal(list[0].name, 'Item b1', 'the original list is not changed');
  assert.deepEqual(applyQueue([batch('b1')], [make('consume', { amount: 10, quantityAfter: 0 })], DAY), []);
});

test('each entry turns back into the right HTTP request with its operation id and base revision', () => {
  assert.deepEqual(requestFor(make('create', { batchId: 'pending-1', baseRevision: 0, fields: { name: 'N' } })), { method: 'POST', path: '/api/batches', body: { name: 'N', operationId: 'op-create', baseRevision: 0 } });
  assert.deepEqual(requestFor(make('update', { fields: { name: 'N' } })), { method: 'PATCH', path: '/api/batches/b1', body: { name: 'N', operationId: 'op-update', baseRevision: 3 } });
  assert.deepEqual(requestFor(make('consume', { amount: 2 })), { method: 'POST', path: '/api/batches/b1/consume', body: { amount: 2, operationId: 'op-consume', baseRevision: 3 } });
  assert.deepEqual(requestFor(make('discard')), { method: 'POST', path: '/api/batches/b1/discard', body: { operationId: 'op-discard', baseRevision: 3 } });
});

const conflict = (updatedAt, extra = {}) => Object.assign(new Error('stale'), { status: 409, current: batch('b1', { revision: 8, updated_at: updatedAt, quantity: 6, ...extra }) });
const replay = (queue, send, correct = ms => ms) => {
  const saved = []; let ids = 0;
  return replayQueue({ queue, send, persist: async remaining => { saved.push(remaining.length); }, correct, newId: () => `new-${++ids}` }).then(result => ({ ...result, saved }));
};

test('replay sends entries in order and saves progress after each one', async () => {
  const sent = [];
  const result = await replay([make('update', { batchId: 'a' }), make('discard', { batchId: 'b' })], async entry => { sent.push(entry.batchId); });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual([result.state, result.queue.length, result.replaced, result.skipped, result.saved], ['done', 0, 0, 0, [1, 0]]);
});

test('on a conflict the later edit wins: a newer device edit is re-sent on top of the server copy, an older one is dropped', async () => {
  const sent = [];
  let first = true;
  const newer = await replay([make('update', { fields: { name: 'Mine' }, editedAt: Date.parse('2026-10-03T00:00:00.000Z') })], async entry => { sent.push(entry); if (first) { first = false; throw conflict('2026-10-01T00:00:00.000Z'); } });
  assert.equal(newer.state, 'done');
  assert.deepEqual([sent[1].operationId, sent[1].baseRevision, sent[1].fields.name, sent[1].fields.unit], ['new-1', 8, 'Mine', 'tablet']);
  const older = await replay([make('update', { fields: { name: 'Mine' }, editedAt: Date.parse('2026-09-01T00:00:00.000Z') })], async () => { throw conflict('2026-10-01T00:00:00.000Z'); });
  assert.deepEqual([older.replaced, older.queue.length], [1, 0]);
  const discardedElsewhere = await replay([make('update', { fields: {}, editedAt: Date.parse('2026-10-03T00:00:00.000Z') })], async () => { throw conflict('2026-10-01T00:00:00.000Z', { discarded_at: '2026-10-02T00:00:00.000Z' }); });
  assert.deepEqual([discardedElsewhere.replaced, discardedElsewhere.queue.length], [1, 0]);
});

test('a consume that conflicts becomes an update to the remaining quantity, or takes everything that is left', async () => {
  const sent = [];
  let first = true;
  await replay([make('consume', { amount: 2, quantityAfter: 8, editedAt: Date.parse('2026-10-03T00:00:00.000Z') })], async entry => { sent.push(entry); if (first) { first = false; throw conflict('2026-10-01T00:00:00.000Z'); } });
  assert.deepEqual([sent[1].kind, sent[1].fields.quantity], ['update', 8]);
  const all = [];
  first = true;
  await replay([make('consume', { amount: 10, quantityAfter: 0, editedAt: Date.parse('2026-10-03T00:00:00.000Z') })], async entry => { all.push(entry); if (first) { first = false; throw conflict('2026-10-01T00:00:00.000Z'); } });
  assert.deepEqual([all[1].kind, all[1].amount], ['consume', 6]);
});

test('replay stops for sign-in problems and being offline, skips entries the server refuses, and gives up after repeated conflicts', async () => {
  const entries = () => [make('update', { batchId: 'a' }), make('update', { batchId: 'b' })];
  const auth = await replay(entries(), async () => { throw Object.assign(new Error('no'), { status: 401 }); });
  assert.deepEqual([auth.state, auth.queue.length], ['auth', 2]);
  const forbidden = await replay(entries(), async () => { throw Object.assign(new Error('no'), { status: 403 }); });
  assert.equal(forbidden.state, 'auth');
  const offline = await replay(entries(), async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual([offline.state, offline.queue.length], ['offline', 2]);
  const serverDown = await replay(entries(), async () => { throw Object.assign(new Error('500'), { status: 503 }); });
  assert.equal(serverDown.state, 'offline');
  for (const status of [400, 404, 422]) {
    const refused = await replay(entries(), async () => { throw Object.assign(new Error('x'), { status }); });
    assert.deepEqual([refused.skipped, refused.queue.length, refused.state], [2, 0, 'done'], String(status));
  }
  for (const status of [408, 429]) assert.equal((await replay(entries(), async () => { throw Object.assign(new Error('x'), { status }); })).state, 'offline', String(status));
  let attempts = 0;
  const loop = await replay([make('update', { fields: {}, editedAt: Date.parse('2026-10-03T00:00:00.000Z') })], async () => { attempts += 1; throw conflict('2026-10-01T00:00:00.000Z'); });
  assert.deepEqual([loop.state, loop.queue.length, attempts], ['retry', 1, 4]);
});

/* Offline store, against a small in-memory IndexedDB fake. */
function fakeIndexedDB({ failOpen = false } = {}) {
  const stores = {};
  const db = {
    objectStoreNames: { contains: name => name in stores },
    createObjectStore: name => { stores[name] = new Map(); },
    transaction: name => {
      const tx = { objectStore: () => ({
        get: key => { const request = { result: stores[name].get(key) }; return request; },
        put: (value, key) => { stores[name].set(key, structuredClone(value)); return { result: key }; },
        clear: () => { stores[name].clear(); return { result: undefined }; }
      }) };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }
  };
  return { stores, open: () => {
    const request = { result: db };
    queueMicrotask(() => { if (failOpen) { request.error = new Error('blocked'); request.onerror?.(); return; } request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } };
}

test('the offline store keeps the Shop context, snapshots and queues, with a save time', async () => {
  const idb = fakeIndexedDB();
  const store = openOfflineStore({ indexedDB: idb, now: () => '2026-10-05T00:00:00.000Z' });
  assert.equal(await store.loadContext(), null, 'nothing saved yet reads as null');
  await store.saveContext({ accountContextKey: 'a1', shops: [] });
  assert.deepEqual(await store.loadContext(), { context: { accountContextKey: 'a1', shops: [] }, savedAt: '2026-10-05T00:00:00.000Z' });
  await store.saveSnapshot('a1:h1', { list: [1, 2] });
  assert.deepEqual(await store.loadSnapshot('a1:h1'), { list: [1, 2], savedAt: '2026-10-05T00:00:00.000Z' });
  await store.saveQueue('a1:h1', [{ kind: 'update' }]);
  assert.deepEqual(await store.loadQueue('a1:h1'), [{ kind: 'update' }]);
  assert.deepEqual([...Object.keys(idb.stores)].sort(), ['meta', 'queues', 'snapshots']);
});

test('signing in as a different account clears the stored snapshots, while the same account keeps them', async () => {
  const idb = fakeIndexedDB();
  const store = openOfflineStore({ indexedDB: idb });
  await store.saveContext({ accountContextKey: 'a1' });
  await store.saveSnapshot('a1:h1', { list: [1] });
  await store.saveContext({ accountContextKey: 'a1' });
  assert.ok(await store.loadSnapshot('a1:h1'), 'the same account keeps its snapshots');
  await store.saveContext({ accountContextKey: 'a2' });
  assert.equal(await store.loadSnapshot('a1:h1'), null);
  assert.equal((await store.loadContext()).context.accountContextKey, 'a2');
});

test('a blocked or missing IndexedDB never throws: every call resolves null', async () => {
  for (const options of [{ indexedDB: fakeIndexedDB({ failOpen: true }) }, { indexedDB: null }]) {
    const store = openOfflineStore(options);
    assert.equal(await store.loadContext(), null);
    assert.equal(await store.saveContext({ accountContextKey: 'a1' }), null);
    assert.equal(await store.saveSnapshot('k', {}), null);
    assert.equal(await store.loadSnapshot('k'), null);
    assert.equal(await store.loadQueue('k'), null);
    assert.equal(await store.saveQueue('k', []), null);
  }
});
