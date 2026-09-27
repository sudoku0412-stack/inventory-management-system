import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confirmShopSwitch, createBatchPhotoLoader, mayDiscardProfileChanges, requestShopApi, revealSwitchAnnouncement } from '../public/shop-client.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Shop selector is a native Profile control with explicit live status and role copy', () => {
  const page = read('public/index.html'), css = read('public/styles.css');
  assert.match(page, /id="shopSelectorCard"/);
  assert.match(page, /<h2 id="shopSelectorTitle">Current Shop<\/h2>/);
  assert.match(page, /<label class="form-field" for="shopSelector"><span>Shop<\/span><select id="shopSelector"/);
  assert.match(page, /id="shopSelectorRole"/);
  assert.match(page, /id="shopSwitchStatus" role="status" aria-live="polite"/);
  assert.match(css, /shop-selector-card select \{ min-height: 44px; \}/);
  assert.match(css, /\.shop-role \{ margin: 8px 0 16px;/, 'role text must remain below the select with positive spacing');
  assert.doesNotMatch(css, /\.shop-role \{ margin: -/, 'role text must not use a negative offset that overlaps the select');
});

test('scoped page requests receive the resolved Shop header while onboarding requests do not', async () => {
  const calls = [], fetchImpl = async (path, options) => { calls.push({ path, options }); return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); };
  await requestShopApi(fetchImpl, '/api/batches', {}, 'shop-a');
  await requestShopApi(fetchImpl, '/api/shop/onboarding-status', {}, 'shop-a');
  assert.equal(calls[0].options.headers['X-Shop-Id'], 'shop-a');
  assert.equal(calls[1].options.headers['X-Shop-Id'], undefined);
});

test('photo loading is pinned, rejects stale Shop state, and revokes object URLs', async () => {
  const requests = [], revoked = [], image = { src: 'old', removeAttribute(name) { if (name === 'src') this.src = ''; } };
  const fetchImpl = async (path, options) => { requests.push({ path, options }); return new Response(new Blob(['photo'])); };
  const loader = createBatchPhotoLoader({ request: (path, options) => requestShopApi(fetchImpl, path, options, 'shop-a'), createObjectURL: () => 'blob:active-photo', revokeObjectURL: url => revoked.push(url) });
  await loader.load({ batchId: 'batch-a', shopId: 'shop-a', image, isCurrent: ({ batchId, shopId }) => batchId === 'batch-a' && shopId === 'shop-a' });
  assert.equal(requests[0].path, '/api/batches/batch-a/photo');
  assert.equal(requests[0].options.headers['X-Shop-Id'], 'shop-a');
  assert.equal(image.src, 'blob:active-photo');
  loader.clear(image);
  assert.deepEqual(revoked, ['blob:active-photo']);
  await loader.load({ batchId: 'batch-b', shopId: 'shop-a', image, isCurrent: () => false });
  assert.equal(image.src, '');
  assert.deepEqual(revoked, ['blob:active-photo']);
});

test('newest same-batch photo load wins out of order and clearing invalidates pending loads', async () => {
  const pending = [], created = [], revoked = [];
  const image = { src: '', removeAttribute() { this.src = ''; } };
  const loader = createBatchPhotoLoader({
    request: () => new Promise(resolve => pending.push(resolve)),
    createObjectURL: blob => { const url = `blob:${blob}`; created.push(url); return url; },
    revokeObjectURL: url => revoked.push(url)
  });
  const options = { batchId: 'batch-a', shopId: 'shop-a', image, isCurrent: () => true };
  const older = loader.load(options), newer = loader.load(options);
  pending[1]('newer');
  assert.equal(await newer, 'blob:newer');
  pending[0]('older');
  assert.equal(await older, null);
  assert.equal(image.src, 'blob:newer');
  assert.deepEqual(created, ['blob:newer']);

  const replacement = loader.load(options);
  assert.deepEqual(revoked, ['blob:newer']);
  pending[2]('replacement');
  assert.equal(await replacement, 'blob:replacement');
  const cancelled = loader.load(options);
  loader.clear(image);
  pending[3]('cancelled');
  assert.equal(await cancelled, null);
  assert.equal(image.src, '');
  assert.deepEqual(created, ['blob:newer', 'blob:replacement']);
  assert.deepEqual(revoked, created);
});

test('photo URL created by an invalidated load is revoked before display', async () => {
  const revoked = [], image = { src: '', removeAttribute() { this.src = ''; } };
  const loader = createBatchPhotoLoader({
    request: async () => new Blob(['photo']),
    createObjectURL: () => { loader.clear(image); return 'blob:invalidated'; },
    revokeObjectURL: url => revoked.push(url)
  });
  assert.equal(await loader.load({ batchId: 'batch-a', shopId: 'shop-a', image, isCurrent: () => true }), null);
  assert.equal(image.src, '');
  assert.deepEqual(revoked, ['blob:invalidated']);
});

test('switch behavior cancels dirty edits, confirms selection, and rejects malformed responses', async () => {
  let prompt;
  assert.equal(mayDiscardProfileChanges(false, () => { throw Error('unexpected'); }), true);
  assert.equal(mayDiscardProfileChanges(true, message => { prompt = message; return false; }), false);
  assert.equal(prompt, 'Switch Shops and discard your unsaved profile changes?');
  const seen = [];
  await confirmShopSwitch(async (path, options) => { seen.push({ path, options }); return { activeShopId: 'shop-b', shops: [{ id: 'shop-b' }] }; }, 'shop-b');
  assert.deepEqual(seen, [{ path: '/api/shops', options: { headers: { 'X-Shop-Id': 'shop-b' } } }]);
  await assert.rejects(confirmShopSwitch(async () => ({ activeShopId: 'shop-a', shops: [{ id: 'shop-b' }] }), 'shop-b'), /Switch not confirmed/);
});

test('reload announcement focuses only after the app shell is revealed', () => {
  const shell = { hidden: true }, selector = { focused: 0, focus() { this.focused += 1; } }, messages = [];
  let scheduled;
  assert.equal(revealSwitchAnnouncement({ pending: { shopName: 'North Shop' }, shell, selector, announce: message => messages.push(message), schedule: callback => { scheduled = callback; } }), null);
  scheduled();
  assert.equal(selector.focused, 0);
  shell.hidden = false;
  revealSwitchAnnouncement({ pending: { shopName: 'North Shop' }, shell, selector, announce: message => messages.push(message), schedule: callback => callback() });
  assert.equal(selector.focused, 1);
  assert.deepEqual(messages, ['Switched to North Shop. Showing its inventory.']);
});
