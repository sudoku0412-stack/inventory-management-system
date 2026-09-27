import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindShopCreation, intentForAccount } from '../public/shop-creation-client.js';

const account = '123e4567-e89b-42d3-a456-426614174000';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };
function page({ store = storage(), request = async () => ({}) } = {}) {
  const nodes = new Map();
  let focused, context = { accountContextKey: account, activeShopId: 'original', shops: [{ id: 'original', name: 'Original', role: 'owner' }] }, ids = 0;
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map(), classes = new Set(), attrs = new Map();
    const value = { value: '', textContent: '', hidden: false, disabled: false, open: false, scrollTop: 10,
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      setAttribute: (name, value) => attrs.set(name, value), removeAttribute: name => attrs.delete(name), getAttribute: name => attrs.get(name),
      addEventListener: (type, handler) => listeners.set(type, handler),
      emit: (type) => listeners.get(type)?.({ preventDefault() {}, currentTarget: value }),
      focus: () => { focused = id; }, showModal() { this.open = true; }, close() { this.open = false; this.emit('close'); },
      checkValidity: () => true, reportValidity() { this.reported = true; }
    };
    nodes.set(id, value);
    return value;
  }
  const form = node('createShopForm');
  form.elements = { shopName: node('createShopName'), displayName: node('createDisplayName') };
  form.reset = () => { for (const field of Object.values(form.elements)) field.value = ''; };
  // A dirty Profile exists on the same page; creating/refetching context must
  // never call its reset, save, or settings-loading path.
  const profile = node('profileSettingsForm');
  profile.elements = { display_name: { value: 'Unsaved name' }, household_name: { value: 'Unsaved shop' }, default_storage_location: { value: 'Unsaved location' } };
  profile.reset = () => { throw Error('Dirty Profile reset'); };
  const requests = [];
  const controller = bindShopCreation({
    document: { querySelector: selector => node(selector.slice(1)) }, storage: store,
    getContext: () => context, getDisplayName: () => 'Saved display name', operationId: () => `operation-${++ids}`,
    request: (path, options) => { requests.push({ path, options }); return request(path, options); },
    renderContext: next => { context = next; controller.contextChanged(); }, schedule: callback => callback()
  });
  controller.contextChanged();
  return { node, requests, store, profile, get context() { return context; }, get focused() { return focused; },
    open() { node('createShopButton').emit('click'); },
    fill() { form.elements.shopName.value = '  New   Shop '; form.elements.displayName.value = ' New Owner '; },
    submit() { return form.emit('submit'); }
  };
}
const success = { shop: { id: 'new', name: 'New Shop', role: 'owner' } };
const refreshed = { accountContextKey: account, activeShopId: 'original', shops: [{ id: 'original', name: 'Original', role: 'owner' }, success.shop] };

test('wired dialog persists before dispatch, rejects duplicate submit, preserves dirty Profile and announces/focuses success', async () => {
  const response = deferred(), store = storage();
  const ui = page({ store, request: async (_path, options) => {
    if (options.method === 'POST') {
      assert.deepEqual(intentForAccount(store, account), { operationId: 'operation-1', accountContextKey: account, payload: { shopName: 'New Shop', displayName: 'New Owner' } });
      return response.promise;
    }
    assert.equal(options.headers['X-Shop-Id'], 'original');
    return refreshed;
  } });
  const dirty = JSON.stringify(ui.profile.elements);
  ui.open();
  assert.equal(ui.node('createShopModal').open, true);
  assert.equal(ui.focused, 'createShopName');
  assert.equal(ui.node('createShopModal').scrollTop, 0);
  ui.fill();
  const pending = ui.submit();
  assert.equal(ui.node('submitCreateShop').disabled, true);
  assert.equal(ui.node('createShopForm').getAttribute('aria-busy'), 'true');
  assert.equal(ui.node('createShopStatus').textContent, 'Creating your Shop…');
  await ui.submit();
  ui.node('createShopModal').close();
  ui.open();
  assert.equal(ui.node('submitCreateShop').disabled, true);
  await ui.submit();
  assert.equal(ui.requests.length, 1);
  response.resolve(success);
  await pending;
  assert.equal(ui.context.activeShopId, 'original');
  assert.equal(ui.context.shops.length, 2);
  assert.equal(ui.node('createShopModal').open, false);
  assert.match(ui.node('shopSwitchStatus').textContent, /Created New Shop.*current Shop is still open/);
  assert.equal(ui.focused, 'shopSelector');
  assert.equal(JSON.stringify(ui.profile.elements), dirty);
  assert.equal(intentForAccount(store, account), null);
});

test('reload in flight resumes saved request; uncertain close/retry retains exactly that operation', async () => {
  const response = deferred(), store = storage();
  const original = page({ store, request: () => response.promise });
  original.open(); original.fill();
  const pending = original.submit();
  const saved = intentForAccount(store, account);
  const reloaded = page({ store, request: async (_path, options) => options.method === 'POST' ? success : refreshed });
  assert.equal(reloaded.node('createShopButton').textContent, 'Resume Shop creation');
  reloaded.open();
  assert.equal(reloaded.node('createShopName').value, 'New Shop');
  assert.equal(reloaded.node('submitCreateShop').textContent, 'Retry creation');
  response.reject(Error('lost response'));
  await pending;
  assert.equal(original.node('submitCreateShop').textContent, 'Retry creation');
  assert.equal(original.focused, 'submitCreateShop');
  original.node('createShopModal').close();
  assert.equal(original.focused, 'createShopButton');
  assert.deepEqual(intentForAccount(store, account), saved);
  await reloaded.submit();
  assert.deepEqual(JSON.parse(reloaded.requests[0].options.body), { ...saved.payload, operationId: saved.operationId });
  assert.equal(intentForAccount(store, account), null);
});

test('definitive validation resets intent and allows corrected new operation; local invalidity never dispatches', async () => {
  const ui = page({ request: async () => { throw Object.assign(Error('Enter a Shop name'), { status: 400 }); } });
  ui.open(); ui.fill();
  ui.node('createShopForm').checkValidity = () => false;
  await ui.submit();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.node('createShopForm').reported, true);
  ui.node('createShopForm').checkValidity = () => true;
  await ui.submit();
  assert.equal(intentForAccount(ui.store, account), null);
  assert.equal(ui.node('submitCreateShop').textContent, 'Create Shop');
  assert.equal(ui.node('createShopStatus').textContent, 'Enter a Shop name');
  ui.node('createShopName').value = 'Corrected';
  await ui.submit();
  assert.notEqual(JSON.parse(ui.requests[0].options.body).operationId, JSON.parse(ui.requests[1].options.body).operationId);
});

for (const refresh of ['network failure', 'mismatched active Shop']) test(`confirmed success with ${refresh} preserves safe context and persistent status`, async () => {
  const ui = page({ request: async (_path, options) => {
    if (options.method === 'POST') return success;
    if (refresh === 'network failure') throw Error('offline');
    return { ...refreshed, activeShopId: 'new' };
  } });
  ui.open(); ui.fill();
  const before = JSON.stringify(ui.context), dirty = JSON.stringify(ui.profile.elements);
  await ui.submit();
  assert.equal(JSON.stringify(ui.context), before);
  assert.equal(JSON.stringify(ui.profile.elements), dirty);
  assert.equal(intentForAccount(ui.store, account), null);
  assert.equal(ui.node('createShopUnavailable').hidden, false);
  assert.match(ui.node('createShopUnavailable').textContent, /created.*current Shop is still open.*Reload/);
  assert.equal(ui.focused, 'createShopButton');
});

test('storage failure blocks the wired flow before any request', async () => {
  const ui = page({ store: { getItem: () => null, setItem() { throw Error('blocked'); } } });
  ui.open(); ui.fill(); await ui.submit();
  assert.equal(ui.requests.length, 0);
  assert.match(ui.node('createShopStatus').textContent, /storage is unavailable.*not created/);
});

test('app binds this complete flow; native dialog, status, close controls and mobile sheet remain accessible', () => {
  const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const app = read('app.js'), html = read('index.html'), css = read('styles.css');
  assert.match(app, /const shopCreation=bindShopCreation\(\{document,storage:sessionStorage,getContext:\(\)=>shopContext,getDisplayName:\(\)=>settings\?\.display_name,operationId,request:api,renderContext:renderShopContext\}\)/);
  assert.match(app, /shopCreation\.contextChanged\(\)/);
  assert.match(html, /<dialog class="modal" id="createShopModal" aria-labelledby="createShopModalTitle" aria-describedby="createShopModalHelp">/);
  assert.match(html, /id="createShopStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="createShopUnavailable" role="status"/);
  assert.match(html, /data-close-modal aria-label="Close create Shop dialog"/);
  assert.match(app, /qsa\('\[data-close-modal\]'\).*closest\('dialog'\)\.close\(\)/);
  assert.match(css, /@media[^}]+\{[\s\S]*\.modal \{ position: fixed; inset: auto 0 0; width: 100%;[^}]+max-height: calc\(100dvh - env\(safe-area-inset-top, 0px\)\)/);
});
