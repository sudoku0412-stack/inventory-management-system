import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindMemberRemoval } from '../public/member-removal-client.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function page(handler) {
  let focused, id = 0;
  let context = { accountContextKey: 'account', activeShopId: 'shop', active: { id: 'shop', name: 'Shop <A>', role: 'owner' } };
  let access = { members: [{ user_id: 'actor', email: 'o@x.test', role: 'owner', is_you: true }, { user_id: 'm1', email: 'm1@x.test', role: 'member' }] };
  const nodes = new Map(), calls = [];
  class Node {
    constructor() { this.listeners = {}; this.attributes = {}; this.dataset = {}; this.disabled = false; this.open = false; this.textContent = ''; this.classList = { toggle() {} }; }
    setAttribute(k, v) { this.attributes[k] = v; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    async emit(type, extra = {}) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, ...extra }); }
    focus() { focused = this; }
    isConnected = true;
    showModal() { this.open = true; }
    close() { this.open = false; void this.emit('close'); }
  }
  const node = key => { if (!nodes.has(key)) nodes.set(key, new Node()); return nodes.get(key); };
  const document = { querySelector: selector => node(selector.slice(1)) };
  bindMemberRemoval({ document, getContext: () => context, getAccess: () => access, renderAccess: next => { access = next; }, operationId: () => `op-${++id}`,
    request: async (path, options) => { calls.push({ path, options }); return handler ? handler(path, options, calls) : path === '/api/household/access' ? access : { removed: true }; } });
  const button = userId => ({ dataset: { removeMember: userId }, closest: () => button.self });
  return { node, calls, get access() { return access; }, get focused() { return focused; }, setContext: next => { context = next; },
    async open(userId = 'm1') { const b = { dataset: { removeMember: userId } }; b.closest = () => b; await node('householdMembers').emit('click', { target: b }); return b; },
    submit: () => node('removeMemberForm').emit('submit'), button };
}

test('confirming removes exactly the chosen member with the pinned Shop and a stable operation id', async () => {
  const ui = page((path, options) => path.endsWith('/remove') ? { removed: true } : { members: [{ user_id: 'actor', email: 'o@x.test', role: 'owner' }] });
  await ui.open();
  assert.equal(ui.node('removeMemberTitle').textContent, 'Remove m1@x.test from Shop <A>?');
  assert.equal(ui.focused, ui.node('cancelRemoveMember'));
  await ui.submit();
  const post = ui.calls[0];
  assert.equal(post.path, '/api/household/members/m1/remove');
  assert.equal(post.options.headers['X-Shop-Id'], 'shop');
  assert.deepEqual(JSON.parse(post.options.body), { operationId: 'op-1' });
  assert.equal(ui.node('removeMemberModal').open, false);
  assert.deepEqual(ui.access.members.map(m => m.user_id), ['actor']);
  assert.match(ui.node('householdAccessStatus').textContent, /m1@x\.test was removed from Shop <A>\./);
  assert.equal(ui.node('shopSelector').disabled, false);
});

test('owners and unknown rows never open the dialog', async () => {
  const ui = page();
  await ui.open('actor'); await ui.open('nobody');
  assert.equal(ui.node('removeMemberModal').open, false);
  ui.setContext({ accountContextKey: 'account', activeShopId: 'shop', active: { id: 'shop', name: 'S', role: 'member' } });
  await ui.open();
  assert.equal(ui.node('removeMemberModal').open, false);
});

test('an unconfirmed failure keeps the same operation id for Retry', async () => {
  let attempts = 0;
  const ui = page(path => { if (path.endsWith('/remove') && ++attempts === 1) throw Object.assign(Error('x'), { status: 503 }); return path.endsWith('/remove') ? { removed: true } : { members: [] }; });
  await ui.open(); await ui.submit();
  assert.equal(ui.node('confirmRemoveMember').textContent, 'Retry');
  assert.equal(ui.node('removeMemberModal').open, true);
  await ui.submit();
  assert.deepEqual(ui.calls.filter(c => c.path.endsWith('/remove')).map(c => JSON.parse(c.options.body).operationId), ['op-1', 'op-1']);
});

test('definitive failures close the dialog, refresh, and explain', async () => {
  for (const [status, message, expected] of [[403, 'x', /no longer have permission/], [404, 'x', /no longer a member/], [409, 'Owners can’t be removed.', /Owners can’t be removed\./], [409, 'other', /can’t be completed right now/]]) {
    const ui = page(path => { if (path.endsWith('/remove')) throw Object.assign(new Error(message), { status }); return { members: [] }; });
    await ui.open(); await ui.submit();
    assert.equal(ui.node('removeMemberModal').open, false);
    assert.match(ui.node('householdAccessStatus').textContent, expected);
    assert.equal(ui.calls.at(-1).path, '/api/household/access');
  }
});

test('a Shop switch during the request drops the response instead of touching the new Shop', async () => {
  let release;
  const ui = page(path => path.endsWith('/remove') ? new Promise(resolve => { release = () => resolve({ removed: true }); }) : { members: [] });
  await ui.open();
  const pending = ui.submit();
  ui.setContext({ accountContextKey: 'account', activeShopId: 'other', active: { id: 'other', name: 'B', role: 'owner' } });
  release(); await pending;
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.node('householdAccessStatus').textContent, '');
});

test('markup and wiring: labelled dialog, live status, Remove only on Member rows', () => {
  assert.match(html, /<dialog class="modal confirm-modal" id="removeMemberModal" aria-labelledby="removeMemberTitle" aria-describedby="removeMemberShop removeMemberHelp">/);
  assert.match(html, /id="removeMemberStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="cancelRemoveMember"[^>]*>Cancel<.*id="confirmRemoveMember"/);
  assert.match(app, /bindMemberRemoval\(\{document,/);
  const item = app.match(/function accessItem\(member\)\{[^\n]+/)[0];
  assert.equal((item.match(/data-remove-member/g) || []).length, 1);
  assert.ok(item.indexOf('if(owner){') < item.indexOf('data-remove-member'), 'the owner branch returns before the Remove button is built');
});
