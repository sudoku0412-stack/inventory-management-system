import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

/** Runs sw.js against in-memory fakes and returns its handlers, the cache store and the call log. */
const basic = (body, init = {}) => { const response = new Response(body, init); Object.defineProperty(response, 'type', { value: 'basic' }); return response; };

function load({ network = async () => basic('net'), existing = {} } = {}) {
  const handlers = {}, stores = new Map(), log = { fetched: [], notifications: [], opened: [] };
  for (const [name, entries] of Object.entries(existing)) stores.set(name, new Map(Object.entries(entries)));
  const open = async name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      add: async request => { const response = await network(request); if (!response.ok) throw new Error('not ok'); store.set(new URL(request.url, 'https://app.test').pathname, response); },
      put: async (request, response) => { store.set(new URL(request.url, 'https://app.test').pathname, response); },
      match: async request => store.get(new URL(request.url || request, 'https://app.test').pathname)
    };
  };
  const caches = { open, keys: async () => [...stores.keys()], delete: async name => stores.delete(name) };
  const self = {
    location: { origin: 'https://app.test' }, skipWaiting: async () => { log.skipped = true; }, clients: { claim: async () => { log.claimed = true; }, matchAll: async () => [], openWindow: async url => { log.opened.push(url); } },
    registration: { showNotification: async (title, options) => { log.notifications.push([title, options]); } },
    addEventListener: (type, handler) => { handlers[type] = handler; }
  };
  const fakeFetch = async request => { log.fetched.push(request.url || String(request)); return network(request); };
  class FakeRequest { constructor(input, init = {}) { this.url = new URL(input, 'https://app.test').href; Object.assign(this, { method: 'GET', mode: 'cors' }, init); } }
  vm.runInNewContext(source, { self, caches, fetch: fakeFetch, Request: FakeRequest, Response, URL, Promise });
  return { handlers, stores, log };
}
const run = async (handler, extra = {}) => { let pending; await handler({ waitUntil: promise => { pending = promise; }, ...extra }); await pending; };
const fetchEvent = (path, { method = 'GET', mode = 'cors', origin = 'https://app.test' } = {}) => {
  const event = { request: { method, mode, url: `${origin}${path}` }, responded: null, respondWith(promise) { event.responded = promise; } };
  return event;
};

test('install caches the app shell under the new cache name and takes over at once', async () => {
  const sw = load();
  await run(sw.handlers.install);
  assert.ok(sw.stores.has('inventory-shell-v1'));
  assert.ok(sw.stores.get('inventory-shell-v1').has('/index.html'));
  assert.ok(sw.stores.get('inventory-shell-v1').has('/app.js'));
  assert.equal(sw.log.skipped, true);
});

test('activate removes caches from before the rename and older shell versions, and keeps everything else', async () => {
  const sw = load({ existing: { 'medicine-shell-v1': { '/old': new Response('x') }, 'inventory-shell-v0': {}, 'inventory-shell-v1': { '/keep': new Response('y') }, 'someone-elses-cache': {} } });
  await run(sw.handlers.activate);
  assert.deepEqual([...sw.stores.keys()].sort(), ['inventory-shell-v1', 'someone-elses-cache']);
  assert.equal(sw.log.claimed, true);
});

test('the worker never touches API, admin, Access, cross-origin or non-GET requests', async () => {
  const sw = load();
  for (const event of [fetchEvent('/api/batches'), fetchEvent('/admin/api/shops'), fetchEvent('/cdn-cgi/access/logout'), fetchEvent('/app.js', { origin: 'https://other.test' }), fetchEvent('/app.js', { method: 'POST' }), fetchEvent('/photo.heic')]) {
    sw.handlers.fetch(event);
    assert.equal(event.responded, null, event.request.url);
  }
});

test('pages and static files are fetched from the network first and cached for offline use', async () => {
  const sw = load();
  const page = fetchEvent('/', { mode: 'navigate' });
  sw.handlers.fetch(page);
  assert.equal(await (await page.responded).text(), 'net');
  assert.ok(sw.stores.get('inventory-shell-v1').has('/'));
  const script = fetchEvent('/styles.css');
  sw.handlers.fetch(script);
  await script.responded;
  assert.ok(sw.stores.get('inventory-shell-v1').has('/styles.css'));
});

test('offline, the cached copy is served, and a missing page falls back to the cached index', async () => {
  const cached = new Response('cached css');
  const sw = load({ network: async () => { throw new TypeError('offline'); }, existing: { 'inventory-shell-v1': { '/styles.css': cached, '/index.html': new Response('shell') } } });
  const css = fetchEvent('/styles.css');
  sw.handlers.fetch(css);
  assert.equal(await (await css.responded).text(), 'cached css');
  const nav = fetchEvent('/#inventory', { mode: 'navigate' });
  sw.handlers.fetch(nav);
  assert.equal(await (await nav.responded).text(), 'shell');
  const missing = fetchEvent('/unknown.js');
  sw.handlers.fetch(missing);
  await assert.rejects(missing.responded, /offline/);
});

test('failed and redirected responses are not stored (an Access login must never be cached)', async () => {
  const redirected = basic('login');
  Object.defineProperty(redirected, 'redirected', { value: true });
  const sw = load({ network: async () => redirected });
  const event = fetchEvent('/', { mode: 'navigate' });
  sw.handlers.fetch(event);
  await event.responded;
  assert.ok(!sw.stores.get('inventory-shell-v1')?.has('/'));
  const failing = load({ network: async () => basic('nope', { status: 500 }) });
  const bad = fetchEvent('/app.js');
  failing.handlers.fetch(bad);
  await bad.responded;
  assert.ok(!failing.stores.get('inventory-shell-v1')?.has('/app.js'));
});

test('a push shows one generic reminder and a click opens the notifications view', async () => {
  const sw = load();
  await run(sw.handlers.push);
  assert.equal(sw.log.notifications.length, 1);
  assert.equal(sw.log.notifications[0][0], 'Expiry reminder');
  assert.equal(sw.log.notifications[0][1].data.url, '/#notifications');
  let closed = false;
  await run(sw.handlers.notificationclick, { notification: { close: () => { closed = true; }, data: { url: '/#notifications' } } });
  assert.equal(closed, true);
  assert.deepEqual(sw.log.opened, ['/#notifications']);
});
