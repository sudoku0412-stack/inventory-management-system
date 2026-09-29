import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicAssetPaths } from '../lib/shared.js';
import { isShopScoped, requestShopApi } from '../public/shop-client.js';
import {
  bindShopInvitations, decodeAcceptance, decodePendingPage, joinIntentForAccount, joinIntentStorageKey, persistJoinIntent, retryDuration
} from '../public/shop-invitations-client.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const A = '123e4567-e89b-42d3-a456-426614174000', B = '223e4567-e89b-42d3-a456-426614174000';
const JOINED_ID = '9f8f2f7e-4b9e-4c62-8f5e-2f3f0c2d1a10';
const NOW = Date.parse('2026-09-29T00:00:00Z');
const future = '2026-10-06T00:00:00.000Z';
const invitation = (id, name = `Shop ${id}`, expires_at = future) => ({ id, household_name: name, role: 'member', expires_at });
const pendingPage = (invitations, nextCursor = null, member = false) => ({ invitations, nextCursor, member });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const fail = (status, message = 'Failed', retryAfter) => Object.assign(Error(message), { status, retryAfter });
const memoryStorage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data }; };

class Node {
  constructor(tag, ids) {
    this.tag = tag; this.ids = ids; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.scrollTop = 0; this.className = ''; this.type = '';
    this.text = ''; this.classes = new Set();
    this.classList = { toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)) };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  get isConnected() { return Boolean(this.root) || Boolean(this.parent?.isConnected); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  emit(type) { const event = { preventDefault() {}, currentTarget: this }; return Promise.all((this.listeners[type] || []).map(handler => handler(event))); }
  click() { return this.emit('click'); }
  focus() { this.ids.focused = this; this.ids.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.emit('close'); }
  find(predicate) { const out = []; const walk = n => { if (predicate(n)) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
}

function page({ route, storage = memoryStorage(), account = A, shops, switchOutcome = 'switching' } = {}) {
  const ids = { focused: null };
  const nodes = new Map(), requests = [];
  const document = { activeElement: null, createElement: tag => new Node(tag, ids), querySelector: selector => node(selector.slice(1)) };
  ids.document = document;
  function node(id) {
    if (!nodes.has(id)) { const n = new Node('div', ids); n.root = true; nodes.set(id, n); }
    return nodes.get(id);
  }
  for (const id of ['shopInvitationsCard', 'shopInvitationsMore', 'shopInvitationsRefresh', 'shopInvitationsCheckPrevious', 'shopInvitationsSwitch', 'shopInvitationsReload']) node(id).hidden = true;
  node('shopInvitationsCheckPrevious').text = 'Check previous join request';
  let context = { accountContextKey: account, activeShopId: 'shop-a', shops: shops || [{ id: 'shop-a', name: 'Shop A', role: 'owner' }] };
  const switches = [];
  let controller;
  const timers = [];
  const dirty = JSON.stringify({ display_name: 'Unsaved name' });
  const api = (path, options = {}) => {
    requests.push({ path, options });
    return requestShopApi(async (url, init) => {
      const result = await route(url, init);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }, path, options, 'shop-a');
  };
  controller = bindShopInvitations({
    document, storage, getContext: () => context, request: api,
    renderContext: next => { context = next; controller.contextChanged(); },
    switchToShop: async (id, options) => { switches.push({ id, options }); return switchOutcome; },
    schedule: callback => callback(), now: () => NOW + (timers.elapsed || 0),
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimer: () => {}
  });
  const api2 = {
    node, requests, storage, controller, switches, timers, dirty, ids,
    get context() { return context; }, set context(value) { context = value; },
    setAccount(next) { context = { ...context, accountContextKey: next }; controller.contextChanged(); },
    status: () => node('shopInvitationsStatus').textContent,
    rowButton: id => node('shopInvitationsList').find(n => n.dataset.invitationId === id)[0],
    rows: () => node('shopInvitationsList').children,
    async open() { controller.contextChanged(); controller.profileOpened(); await flush(); },
    async join(id = 'inv-1') { await api2.rowButton(id).click(); },
    async confirm() { const done = node('joinShopForm').emit('submit'); await done; await flush(); }
  };
  return api2;
}

const shopsWithJoined = { accountContextKey: A, activeShopId: 'shop-a', shops: [{ id: 'shop-a', name: 'Shop A', role: 'owner' }, { id: JOINED_ID, name: 'Shop inv-1', role: 'member' }] };
function happyRoute(overrides = {}) {
  return async (path, init) => {
    const handler = overrides[path] || overrides[path.split('?')[0]];
    if (handler) return handler(path, init);
    if (path.startsWith('/api/household/invitations/pending')) return pendingPage([invitation('inv-1')]);
    if (path === '/api/household/invitations/inv-1/accept') return { householdId: JOINED_ID, role: 'member', accepted: true };
    if (path === '/api/shops') return shopsWithJoined;
    throw Error(`unexpected ${path}`);
  };
}

test('decoders accept the deployed payloads and reject every deviation', () => {
  const ok = pendingPage([invitation('inv-1')]);
  for (const member of [false, true]) assert.deepEqual(decodePendingPage(pendingPage([invitation('inv-1')], 'abc_-', member)), { invitations: [invitation('inv-1')], nextCursor: 'abc_-' });
  const bad = [
    { invitations: ok.invitations, nextCursor: null }, { ...ok, extra: 1 }, { ...ok, member: 'no' }, { ...ok, nextCursor: 'has space' }, { ...ok, nextCursor: 5 },
    pendingPage(Array.from({ length: 21 }, (_, i) => invitation(`i${i}`))), pendingPage([invitation('same'), invitation('same')]),
    pendingPage([{ ...invitation('x'), email: 'a@b.c' }]), pendingPage([{ ...invitation('x'), role: 'owner' }]), pendingPage([{ id: 'x', household_name: 'n', role: 'member' }]),
    pendingPage([invitation('x', 'name', 'not a date')]), pendingPage([invitation('x', '')]), pendingPage([{ ...invitation('x'), id: 5 }]), null, []
  ];
  for (const value of bad) assert.throws(() => decodePendingPage(value), /not recognized/);
  assert.equal(decodePendingPage(pendingPage(Array.from({ length: 20 }, (_, i) => invitation(`i${i}`)))).invitations.length, 20);

  for (const accepted of [true, false]) assert.deepEqual(decodeAcceptance({ householdId: JOINED_ID, role: 'member', accepted }), { householdId: JOINED_ID, role: 'member', accepted });
  for (const value of [
    { householdId: JOINED_ID, role: 'member' }, { householdId: JOINED_ID, role: 'member', accepted: true, extra: 1 }, { householdId: JOINED_ID.toUpperCase(), role: 'member', accepted: true },
    { householdId: 'not-a-uuid', role: 'member', accepted: true }, { householdId: JOINED_ID, role: 'owner', accepted: true }, { householdId: JOINED_ID, role: 'member', accepted: 'true' }, null
  ]) assert.throws(() => decodeAcceptance(value), /not recognized/);
});

test('invitation routes never receive X-Shop-Id, including paginated discovery, and Retry-After is validated', async () => {
  for (const path of ['/api/household/invitations/pending', '/api/household/invitations/pending?cursor=abc', '/api/household/invitations/x/accept', '/api/shops']) assert.equal(isShopScoped(path), false, path);
  assert.equal(isShopScoped('/api/batches?x=1'), true);
  const respond = value => async () => new Response('{}', { status: 429, headers: value === null ? {} : { 'retry-after': value } });
  assert.equal((await requestShopApi(respond('30'), '/api/x').catch(e => e)).retryAfter, 30);
  for (const bad of [null, 'abc', '-3', '1.5', '999999']) assert.equal((await requestShopApi(respond(bad), '/api/x').catch(e => e)).retryAfter, undefined);
  assert.equal(retryDuration(1), '1 second'); assert.equal(retryDuration(90), '2 minutes');
});

test('local or unaffiliated context never renders or fetches the card', async () => {
  const ui = page({ route: happyRoute() });
  ui.context = { accountContextKey: undefined, activeShopId: 'x', shops: [] };
  await ui.open();
  assert.equal(ui.node('shopInvitationsCard').hidden, true);
  assert.equal(ui.requests.length, 0);
  ui.controller.profileClosed(); ui.controller.profileOpened(); await flush();
  assert.equal(ui.requests.length, 0);
});

test('discovery 404 or 405 hides the card and leaves the page unchanged', async () => {
  for (const code of [404, 405]) {
    const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async () => { throw fail(code); } }) });
    await ui.open();
    assert.equal(ui.node('shopInvitationsCard').hidden, true);
  }
});

test('first page renders text-only rows for Owners and Members, no polling, and Profile revisits refetch without touching Profile fields', async () => {
  for (const role of ['owner', 'member']) {
    const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async () => pendingPage([invitation('inv-1', '<b>Shop & "co"</b>')], null, true) }), shops: [{ id: 'shop-a', name: 'Shop A', role }] });
    await ui.open();
    assert.equal(ui.node('shopInvitationsCard').hidden, false);
    const row = ui.rows()[0];
    assert.equal(row.children[0].textContent, '<b>Shop & "co"</b>');
    assert.equal(row.children[0].tag, 'strong');
    assert.equal(row.children[1].textContent, 'Member access');
    assert.equal(row.children[2].attributes.datetime, future);
    assert.match(row.children[2].textContent, /^Expires /);
    assert.equal(ui.rowButton('inv-1').textContent, 'Join Shop');
    assert.equal(ui.rowButton('inv-1').attributes['aria-label'], 'Join Shop <b>Shop & "co"</b>');
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].options.headers?.['X-Shop-Id'], undefined);
    ui.controller.profileOpened(); await flush();
    assert.equal(ui.requests.length, 1, 'no repeated fetch while already in Profile');
    ui.controller.profileClosed(); ui.controller.profileOpened(); await flush();
    assert.equal(ui.requests.length, 2);
  }
});

test('empty, loading, error, 503 and malformed states show exact guidance with Retry', async () => {
  const gate = deferred();
  let ui = page({ route: happyRoute({ '/api/household/invitations/pending': () => gate.promise }) });
  ui.controller.contextChanged(); ui.controller.profileOpened();
  assert.equal(ui.status(), 'Loading Shop invitations…');
  assert.equal(ui.node('shopInvitationsList').getAttribute('aria-busy'), 'true');
  gate.resolve(pendingPage([]));
  await flush();
  assert.equal(ui.status(), 'No Shop invitations for this account.');
  assert.equal(ui.node('shopInvitationsRefresh').textContent, 'Refresh invitations');

  const cases = [
    [async () => { throw new TypeError('offline'); }, 'We couldn’t load Shop invitations. Check your connection and try again.'],
    [async () => { throw fail(500); }, 'We couldn’t load Shop invitations. Check your connection and try again.'],
    [async () => { throw fail(503); }, 'Shop invitations are temporarily unavailable. Try again later.'],
    [async () => ({ invitations: [], nextCursor: null }), 'We couldn’t load Shop invitations. Check your connection and try again.']
  ];
  for (const [handler, message] of cases) {
    ui = page({ route: happyRoute({ '/api/household/invitations/pending': handler }) });
    await ui.open();
    assert.equal(ui.status(), message);
    assert.equal(ui.node('shopInvitationsRefresh').textContent, 'Retry');
  }
});

test('malformed refresh keeps existing rows', async () => {
  let calls = 0;
  const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async () => (++calls === 1 ? pendingPage([invitation('inv-1')]) : { bad: true }) }) });
  await ui.open();
  await ui.node('shopInvitationsRefresh').click(); await flush();
  assert.ok(ui.rowButton('inv-1'));
  assert.match(ui.status(), /couldn’t load Shop invitations/);
});

test('discovery 429 disables controls until Retry-After, then re-enables without a request', async () => {
  const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async () => { throw fail(429, 'Slow down', 30); } }) });
  await ui.open();
  assert.equal(ui.status(), 'Too many invitation checks. Try again in about 30 seconds.');
  assert.equal(ui.node('shopInvitationsRefresh').disabled, true);
  assert.equal(ui.timers.length, 1);
  await ui.node('shopInvitationsRefresh').click(); await flush();
  assert.equal(ui.requests.length, 1);
  ui.timers.elapsed = 31_000; ui.timers[0].callback();
  assert.equal(ui.node('shopInvitationsRefresh').disabled, false);
  assert.equal(ui.requests.length, 1, 'timer never issues a request');

  const missing = page({ route: happyRoute({ '/api/household/invitations/pending': async () => { throw fail(429, 'Slow down'); } }) });
  await missing.open();
  assert.equal(missing.status(), 'Too many invitation checks. Try again in a minute.');
});

test('pagination appends, de-duplicates in server order, retries a failed page, stops on a repeated cursor, and never chases pages', async () => {
  const pages = { first: pendingPage([invitation('a'), invitation('b')], 'c1'), c1: pendingPage([invitation('b'), invitation('c')], 'c2'), c2: pendingPage([invitation('d')], 'c1') };
  let failNext = true;
  const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async (path) => {
    const cursor = new URL(`https://x${path}`).searchParams.get('cursor');
    if (cursor === 'c1' && failNext) { failNext = false; throw fail(500); }
    return pages[cursor || 'first'];
  } }) });
  await ui.open();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.node('shopInvitationsMore').hidden, false);
  await ui.node('shopInvitationsMore').click(); await flush();
  assert.deepEqual(ui.rows().map(row => row.children[0].textContent), ['Shop a', 'Shop b']);
  assert.equal(ui.status(), 'We couldn’t load more invitations. Try again.');
  assert.equal(ui.node('shopInvitationsMore').textContent, 'Retry');
  await ui.node('shopInvitationsMore').click(); await flush();
  assert.deepEqual(ui.rows().map(row => row.children[0].textContent), ['Shop a', 'Shop b', 'Shop c']);
  await ui.node('shopInvitationsMore').click(); await flush();
  assert.equal(ui.rows().length, 4);
  assert.equal(ui.node('shopInvitationsMore').hidden, true, 'repeated cursor stops pagination');
  assert.equal(ui.status(), 'We couldn’t load more invitations. Try again.');
  assert.equal(ui.requests.length, 4);
  for (const request of ui.requests) assert.equal(request.options.headers?.['X-Shop-Id'], undefined);
});

test('join confirmation: cancel does nothing, storage precedes dispatch, body is {}, success keeps the current Shop and offers a separate switch', async () => {
  const storage = memoryStorage();
  const gate = deferred();
  let stored;
  const ui = page({ storage, route: happyRoute({ '/api/household/invitations/inv-1/accept': async (path, init) => {
    stored = joinIntentForAccount(storage, A);
    assert.equal(init.body, '{}');
    assert.equal(init.method, 'POST');
    return gate.promise;
  } }) });
  await ui.open();
  await ui.join();
  const modal = ui.node('joinShopModal');
  assert.equal(modal.open, true);
  assert.equal(ui.node('joinShopTitle').textContent, 'Join Shop inv-1?');
  assert.equal(ui.node('joinShopAccess').textContent, 'Access: Member');
  assert.match(ui.node('joinShopHelp').textContent, /Your current Shop, Shop A, will stay open\. You can switch after joining\./);
  assert.equal(ui.ids.focused, ui.node('cancelJoinShop'));
  await ui.node('cancelJoinShop').click();
  assert.equal(modal.open, false);
  assert.equal(ui.ids.focused, ui.rowButton('inv-1'));
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 0);
  assert.equal(joinIntentForAccount(storage, A), null);

  await ui.join();
  const submitting = ui.node('joinShopForm').emit('submit');
  const duplicate = ui.node('joinShopForm').emit('submit');
  await flush();
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 1, 'duplicate submit is ignored');
  assert.deepEqual(stored, { accountContextKey: A, invitationId: 'inv-1', householdName: 'Shop inv-1', role: 'member', expiresAt: future, currentShopId: 'shop-a' });
  assert.equal(ui.node('joinShopForm').getAttribute('aria-busy'), 'true');
  assert.equal(ui.node('confirmJoinShop').textContent, 'Joining…');
  assert.equal(ui.node('confirmJoinShop').disabled, true);
  assert.equal(ui.node('joinShopStatus').textContent, 'Joining Shop inv-1 as a Member…');
  assert.equal(ui.node('shopSelector').disabled, true);
  assert.equal(ui.rowButton('inv-1').disabled, true);
  assert.equal(ui.rowButton('inv-1').textContent, 'Joining…');
  modal.close();
  await ui.rowButton('inv-1').click();
  assert.equal(modal.open, true, 'reopening shows busy state');
  assert.equal(ui.node('confirmJoinShop').disabled, true);
  gate.resolve({ householdId: JOINED_ID, role: 'member', accepted: true });
  await Promise.all([submitting, duplicate]); await flush();
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 1);
  assert.equal(modal.open, false);
  assert.equal(joinIntentForAccount(storage, A), null);
  assert.equal(ui.node('shopSelector').disabled, false);
  assert.equal(ui.context.activeShopId, 'shop-a', 'acceptance never changes the active Shop');
  assert.deepEqual(ui.context.shops.map(shop => shop.id), ['shop-a', JOINED_ID]);
  assert.match(ui.status(), /^Joined Shop inv-1 as a Member\. Your current Shop is still Shop A\./);
  const switchButton = ui.node('shopInvitationsSwitch');
  assert.equal(switchButton.hidden, false);
  assert.equal(switchButton.textContent, 'Switch to Shop inv-1');
  assert.equal(ui.ids.focused, switchButton);
  assert.equal(ui.switches.length, 0);
  const paths = ui.requests.map(r => r.path);
  assert.ok(paths.includes('/api/shops'));
  assert.ok(!paths.some(p => p.includes('settings') || p.includes('batches') || p.includes('access')));
  for (const request of ui.requests) assert.equal(request.options.headers?.['X-Shop-Id'], undefined);
  await switchButton.click();
  assert.deepEqual(ui.switches, [{ id: JOINED_ID, options: { fromSelector: false } }]);
});

test('storage failure blocks dispatch with safe copy', async () => {
  const storage = { getItem: () => null, setItem() { throw Error('quota'); } };
  const ui = page({ storage, route: happyRoute() });
  await ui.open(); await ui.join(); await ui.confirm();
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 0);
  assert.equal(ui.node('joinShopStatus').textContent, 'Safe retry storage is unavailable. You haven’t joined this Shop.');
  assert.equal(ui.node('joinShopModal').open, true);
});

test('ambiguous outcomes retain the same intent, focus Retry joining, and receipt replay resolves it', async () => {
  for (const failure of [fail(503), fail(500), fail(408), new TypeError('offline')]) {
    const storage = memoryStorage();
    let calls = 0;
    const ui = page({ storage, route: happyRoute({ '/api/household/invitations/inv-1/accept': async () => { if (++calls === 1) throw failure; return { householdId: JOINED_ID, role: 'member', accepted: false }; } }) });
    await ui.open(); await ui.join(); await ui.confirm();
    assert.equal(ui.node('joinShopModal').open, false);
    assert.equal(ui.status(), 'We couldn’t confirm whether you joined Shop inv-1. Retry joining to check the same invitation.');
    assert.equal(ui.rowButton('inv-1').textContent, 'Retry joining');
    assert.equal(ui.ids.focused, ui.rowButton('inv-1'));
    assert.equal(joinIntentForAccount(storage, A).invitationId, 'inv-1');
    assert.equal(ui.node('shopSelector').disabled, false);
    await ui.rowButton('inv-1').click();
    assert.equal(ui.node('confirmJoinShop').textContent, 'Retry joining');
    await ui.confirm();
    assert.equal(calls, 2);
    assert.equal(ui.requests.filter(r => r.path.includes('accept')).every(r => r.options.body === '{}'), true);
    assert.match(ui.status(), /^You already joined Shop inv-1 as a Member\. Your current Shop is still Shop A\./);
    assert.equal(joinIntentForAccount(storage, A), null);
  }
});

test('malformed, wrong-type, or extra-key 200 bodies are unsafe non-success: keep intent and selector, no Switch, no refresh', async () => {
  const bodies = [{}, { householdId: JOINED_ID, role: 'member' }, { householdId: JOINED_ID, role: 'owner', accepted: true }, { householdId: 'nope', role: 'member', accepted: true }, { householdId: JOINED_ID, role: 'member', accepted: true, x: 1 }, null, 'ok'];
  for (const body of bodies) {
    const storage = memoryStorage();
    const ui = page({ storage, route: happyRoute({ '/api/household/invitations/inv-1/accept': async () => body }) });
    await ui.open(); await ui.join(); await ui.confirm();
    assert.equal(ui.status(), 'We couldn’t safely confirm whether you joined Shop inv-1. Retry joining to check the same invitation.');
    assert.equal(ui.node('shopInvitationsSwitch').hidden, true);
    assert.equal(ui.requests.some(r => r.path === '/api/shops'), false);
    assert.equal(ui.context.shops.length, 1);
    assert.ok(joinIntentForAccount(storage, A));
    assert.equal(ui.ids.focused, ui.rowButton('inv-1'));
  }
});

test('definitive outcomes clear the intent with exact copy', async () => {
  const cases = [
    [fail(404, 'Gone'), 'This invitation expired, was revoked, or is no longer available.', true],
    [fail(409, 'You can belong to up to 50 Shops.'), 'You can belong to up to 50 Shops. You can’t join another Shop right now.', false],
    [fail(409, 'Already a member'), 'You already belong to this Shop.', true],
    [fail(400, 'Bad'), 'Shop joining isn’t available for this account. Reload and try again.', false],
    [fail(401, 'No'), 'Shop joining isn’t available for this account. Reload and try again.', false],
    [fail(403, 'No'), 'Shop joining isn’t available for this account. Reload and try again.', false]
  ];
  for (const [error, message, refetches] of cases) {
    const storage = memoryStorage();
    const ui = page({ storage, route: happyRoute({ '/api/household/invitations/inv-1/accept': async () => { throw error; } }) });
    await ui.open(); await ui.join(); await ui.confirm();
    assert.equal(ui.status(), message);
    assert.equal(joinIntentForAccount(storage, A), null);
    assert.equal(ui.node('joinShopModal').open, false);
    assert.equal(ui.ids.focused, ui.node('shopInvitationsStatus'));
    assert.equal(ui.requests.filter(r => r.path.startsWith('/api/household/invitations/pending')).length, refetches ? 2 : 1);
    if (error.message.includes('50 Shops')) assert.equal(ui.rowButton('inv-1').disabled, true);
    assert.equal(ui.node('shopInvitationsSwitch').hidden, true);
  }
});

test('join 429 retains intent, waits for Retry-After, and never resends automatically', async () => {
  const storage = memoryStorage();
  const ui = page({ storage, route: happyRoute({ '/api/household/invitations/inv-1/accept': async () => { throw fail(429, 'Slow', 45); } }) });
  await ui.open(); await ui.join(); await ui.confirm();
  assert.equal(ui.status(), 'Too many join attempts. Retry joining in about 45 seconds.');
  assert.equal(ui.rowButton('inv-1').textContent, 'Retry joining');
  assert.equal(ui.rowButton('inv-1').disabled, true);
  assert.ok(joinIntentForAccount(storage, A));
  ui.timers.elapsed = 46_000; ui.timers.at(-1).callback();
  assert.equal(ui.rowButton('inv-1').disabled, false);
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 1);
});

test('confirmed join with failed Shops verification shows Reload Shops, keeps the current Shop, and only performs reads', async () => {
  let shopReads = 0;
  const ui = page({ route: happyRoute({ '/api/shops': async () => { if (++shopReads === 1) throw new TypeError('offline'); return shopsWithJoined; } }) });
  await ui.open(); await ui.join(); await ui.confirm();
  assert.equal(ui.status(), 'Joined. Reload to see your Shops.');
  assert.equal(ui.node('shopInvitationsSwitch').hidden, true);
  assert.equal(ui.node('shopInvitationsReload').hidden, false);
  assert.equal(ui.ids.focused, ui.node('shopInvitationsReload'));
  assert.equal(ui.context.shops.length, 1);
  assert.equal(joinIntentForAccount(ui.storage, A), null);
  await ui.node('shopInvitationsReload').click(); await flush();
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 1);
  assert.equal(ui.node('shopInvitationsSwitch').hidden, false);
  assert.equal(ui.context.shops.length, 2);
});

test('a verification response for another account, missing Shop, or wrong role is rejected', async () => {
  for (const bad of [{ ...shopsWithJoined, accountContextKey: B }, { ...shopsWithJoined, shops: [shopsWithJoined.shops[0]] }, { ...shopsWithJoined, shops: [shopsWithJoined.shops[0], { ...shopsWithJoined.shops[1], role: 'owner' }] }, { ...shopsWithJoined, shops: [shopsWithJoined.shops[1]] }]) {
    const ui = page({ route: happyRoute({ '/api/shops': async () => bad }) });
    await ui.open(); await ui.join(); await ui.confirm();
    assert.equal(ui.status(), 'Joined. Reload to see your Shops.');
    assert.equal(ui.context.shops.length, 1);
    assert.equal(ui.node('shopInvitationsSwitch').hidden, true);
  }
});

test('invitation refresh failure after a verified join still offers Switch and a read-only refresh', async () => {
  let reads = 0;
  const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async () => { if (++reads === 1) return pendingPage([invitation('inv-1')]); throw fail(500); } }) });
  await ui.open(); await ui.join(); await ui.confirm();
  assert.match(ui.status(), /Joined, but invitations couldn’t be refreshed\.$/);
  assert.equal(ui.node('shopInvitationsSwitch').hidden, false);
  assert.equal(ui.node('shopInvitationsRefresh').textContent, 'Refresh invitations');
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 1);
});

test('cancelled or failed switches restore the Switch action without touching the selector', async () => {
  for (const [outcome, message] of [['cancelled', /^Joined /], ['failed', /^We couldn’t confirm the switch\./]]) {
    const ui = page({ route: happyRoute(), switchOutcome: outcome });
    await ui.open(); await ui.join(); await ui.confirm();
    await ui.node('shopInvitationsSwitch').click();
    assert.match(ui.status(), message);
    assert.equal(ui.node('shopInvitationsSwitch').disabled, false);
    assert.equal(ui.ids.focused, ui.node('shopInvitationsSwitch'));
    assert.equal(ui.context.activeShopId, 'shop-a');
  }
});

test('account changes discard rows and suppress stale responses; intents stay private and dormant', async () => {
  const storage = memoryStorage();
  const gate = deferred();
  const ui = page({ storage, route: happyRoute({ '/api/household/invitations/inv-1/accept': () => gate.promise }) });
  await ui.open(); await ui.join(); ui.node('joinShopForm').emit('submit'); await flush();
  ui.setAccount(B);
  assert.equal(ui.node('shopSelector').disabled, false);
  assert.equal(ui.rows().length, 0, 'no stale account rows');
  assert.equal(ui.node('joinShopModal').open, false);
  gate.resolve({ householdId: JOINED_ID, role: 'member', accepted: true });
  await flush();
  assert.equal(ui.node('shopInvitationsSwitch').hidden, true);
  assert.equal(ui.context.shops.length, 1);
  assert.ok(joinIntentForAccount(storage, A), 'original account intent stays dormant');
  assert.equal(joinIntentForAccount(storage, B), null);
  assert.equal(ui.node('shopInvitationsCheckPrevious').hidden, true);
  ui.setAccount(A);
  ui.controller.profileClosed(); ui.controller.profileOpened(); await flush();
  assert.equal(ui.rowButton('inv-1').textContent, 'Retry joining');
});

test('after reload a stored intent is only reopened by explicit Check previous join request', async () => {
  const storage = memoryStorage();
  persistJoinIntent(storage, { accountContextKey: A, invitationId: 'gone', householdName: 'Old Shop', role: 'member', expiresAt: future, currentShopId: 'shop-a' });
  const ui = page({ storage, route: happyRoute() });
  await ui.open();
  assert.equal(ui.node('shopInvitationsCheckPrevious').hidden, false);
  assert.equal(ui.node('shopInvitationsCheckPrevious').textContent, 'Check previous join request');
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 0);
  assert.equal(ui.rowButton('inv-1').disabled, true, 'other invitations wait for the unresolved intent');
  await ui.node('shopInvitationsCheckPrevious').click();
  assert.equal(ui.node('joinShopModal').open, true);
  assert.equal(ui.node('joinShopTitle').textContent, 'Join Old Shop?');
  assert.equal(ui.requests.filter(r => r.path.includes('accept')).length, 0);
});

test('expired invitations are non-actionable in the current view', async () => {
  const ui = page({ route: happyRoute({ '/api/household/invitations/pending': async () => pendingPage([invitation('inv-1', 'Old', '2026-09-28T00:00:00.000Z')]) }) });
  await ui.open();
  assert.equal(ui.rowButton('inv-1'), undefined);
  assert.equal(ui.rows()[0].children.at(-1).textContent, 'Expired');
});

test('stored intent decoding rejects malformed or foreign records', () => {
  const storage = memoryStorage();
  storage.setItem(joinIntentStorageKey, JSON.stringify({ [A]: { accountContextKey: B, invitationId: 'x', householdName: 'n', role: 'member', expiresAt: 'e', currentShopId: 's' } }));
  assert.equal(joinIntentForAccount(storage, A), null);
  storage.setItem(joinIntentStorageKey, 'not json');
  assert.equal(joinIntentForAccount(storage, A), null);
  assert.equal(joinIntentForAccount(storage, 'bad'), null);
});

test('markup, styles, worker cache policy and app wiring satisfy the UI contract', () => {
  const html = read('public/index.html'), css = read('public/styles.css'), app = read('public/app.js'), worker = read('worker/index.js');
  const order = ['id="shopSelectorCard"', 'id="shopInvitationsCard"', 'id="createShopCard"'].map(marker => html.indexOf(marker));
  assert.ok(order.every(index => index > 0) && order[0] < order[1] && order[1] < order[2], 'card sits between Current Shop and Create another Shop');
  assert.ok(html.indexOf('id="shopInvitationsCard"') < html.indexOf('id="householdAccessTitle"'));
  assert.match(html, /<section class="profile-card shop-invitations-card" id="shopInvitationsCard"[^>]* hidden>/);
  assert.match(html, /Invitations sent to your signed-in account\. Joining adds Member access and keeps your current Shop open\./);
  assert.match(html, /id="shopInvitationsStatus" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"/);
  assert.match(html, /<ul class="shop-invitation-list" id="shopInvitationsList"/);
  assert.match(html, /<dialog class="modal confirm-modal" id="joinShopModal" aria-labelledby="joinShopTitle" aria-describedby="joinShopAccess joinShopHelp">/);
  assert.ok(html.indexOf('id="cancelJoinShop"') < html.indexOf('id="confirmJoinShop"'), 'Cancel precedes Join in DOM order');
  assert.match(css, /\.shop-invitations-card \.button, #joinShopModal \.button \{ min-height: 44px; \}/);
  assert.match(css, /\.shop-invitations-card \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.shop-invitation-row \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(worker, /'\/shop-invitations-client\.js'/);
  assert.equal(publicAssetPaths.has('/shop-invitations-client.js'), true);
  assert.match(app, /bindShopInvitations\(\{document,storage:sessionStorage,getContext:\(\)=>shopContext/);
  assert.match(app, /switchToShop:switchToShopId/);
  assert.match(app, /decodePendingPage\(await api\('\/api\/household\/invitations\/pending'\)\)/);
  assert.doesNotMatch(read('public/shop-invitations-client.js'), /innerHTML|insertAdjacentHTML|setInterval|X-Shop-Id/);
});
