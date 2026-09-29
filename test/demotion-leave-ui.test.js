import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindOwnerDemotion } from '../public/owner-demotion-client.js';
import { bindShopLeave } from '../public/shop-leave-client.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fail = (status, message = 'x') => Object.assign(new Error(message), { status });

function dom() {
  let focused;
  const nodes = new Map();
  class Node {
    constructor() { this.listeners = {}; this.attributes = {}; this.dataset = {}; this.disabled = false; this.open = false; this.hidden = false; this.textContent = ''; this.errorFlag = false; this.classList = { toggle: (_, on) => { this.errorFlag = on; } }; this.isConnected = true; }
    setAttribute(k, v) { this.attributes[k] = v; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    async emit(type, extra = {}) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, ...extra }); }
    focus() { focused = this; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.emit('close'); }
  }
  const node = key => { if (!nodes.has(key)) nodes.set(key, new Node()); return nodes.get(key); };
  return { node, document: { querySelector: selector => node(selector.slice(1)) }, focused: () => focused };
}
const owner = (id, is_you = false) => ({ user_id: id, email: `${id}@x.test`, role: 'owner', is_you });
const ctx = (role = 'owner', shop = 'shop') => ({ accountContextKey: 'account', activeShopId: shop, active: { id: shop, name: 'Shop <A>', role } });

function demotionPage(handler) {
  const d = dom();
  let context = ctx(), access = { members: [owner('me', true), owner('o2'), { user_id: 'm1', email: 'm1@x.test', role: 'member' }] }, id = 0;
  const calls = [];
  bindOwnerDemotion({ document: d.document, getContext: () => context, getAccess: () => access, renderAccess: next => { access = next; }, operationId: () => `op-${++id}`,
    request: async (path, options) => { calls.push({ path, options }); return handler ? handler(path, options) : path === '/api/household/access' ? access : { changed: true }; } });
  return { ...d, calls, get access() { return access; }, setContext: next => { context = next; },
    async open(userId = 'o2') { const b = { dataset: { demoteMember: userId } }; b.closest = () => b; await d.node('householdMembers').emit('click', { target: b }); },
    submit: () => d.node('demoteMemberForm').emit('submit') };
}

test('demoting posts to the pinned Shop with a stable operation id and shows the new role', async () => {
  const ui = demotionPage(path => path.endsWith('/demote') ? { changed: true } : { members: [owner('me', true), { user_id: 'o2', email: 'o2@x.test', role: 'member' }] });
  await ui.open();
  assert.equal(ui.node('demoteMemberTitle').textContent, 'Make o2@x.test a member?');
  assert.equal(ui.focused(), ui.node('cancelDemoteMember'));
  await ui.submit();
  assert.equal(ui.calls[0].path, '/api/household/members/o2/demote');
  assert.equal(ui.calls[0].options.headers['X-Shop-Id'], 'shop');
  assert.deepEqual(JSON.parse(ui.calls[0].options.body), { operationId: 'op-1' });
  assert.equal(ui.node('demoteMemberModal').open, false);
  assert.match(ui.node('householdAccessStatus').textContent, /o2@x\.test is now a member of Shop <A>\./);
  assert.equal(ui.access.members.find(m => m.user_id === 'o2').role, 'member');
});

test('only other owners open the demotion dialog, and only for owners of the Shop', async () => {
  const ui = demotionPage();
  await ui.open('me'); await ui.open('m1'); await ui.open('nobody');
  assert.equal(ui.node('demoteMemberModal').open, false);
  ui.setContext(ctx('member'));
  await ui.open();
  assert.equal(ui.node('demoteMemberModal').open, false);
});

test('demotion retry reuses the operation id; definitive failures explain and refresh', async () => {
  let attempts = 0;
  const retry = demotionPage(path => { if (path.endsWith('/demote') && ++attempts === 1) throw fail(503); return path.endsWith('/demote') ? { changed: true } : { members: [] }; });
  await retry.open(); await retry.submit();
  assert.equal(retry.node('confirmDemoteMember').textContent, 'Retry');
  await retry.submit();
  assert.deepEqual(retry.calls.filter(c => c.path.endsWith('/demote')).map(c => JSON.parse(c.options.body).operationId), ['op-1', 'op-1']);
  for (const [status, message, expected] of [[403, 'x', /no longer have permission/], [404, 'x', /no longer an owner/], [409, 'A Shop must keep at least one owner.', /keep at least one owner/], [409, 'other', /can’t be completed right now/]]) {
    const ui = demotionPage(path => { if (path.endsWith('/demote')) throw fail(status, message); return { members: [] }; });
    await ui.open(); await ui.submit();
    assert.equal(ui.node('demoteMemberModal').open, false);
    assert.match(ui.node('householdAccessStatus').textContent, expected);
    assert.equal(ui.calls.at(-1).path, '/api/household/access');
  }
});

function leavePage({ role = 'owner', members, handler } = {}) {
  const d = dom();
  let context = ctx(role), access = members === undefined ? { members: [owner('me', true), owner('o2')] } : members, id = 0, reloads = 0;
  const calls = [];
  const controller = bindShopLeave({ document: d.document, getContext: () => context, getAccess: () => access, operationId: () => `leave-${++id}`, reload: () => { reloads += 1; },
    request: async (path, options) => { calls.push({ path, options }); return handler ? handler(path, options) : { left: true }; } });
  return { ...d, calls, controller, get reloads() { return reloads; }, setAccess: next => { access = next; }, setContext: next => { context = next; },
    click: () => d.node('leaveShopButton').emit('click'), submit: () => d.node('leaveShopForm').emit('submit') };
}

test('leave: confirm posts once to the pinned Shop and reloads into the next Shop', async () => {
  const ui = leavePage();
  ui.controller.refresh();
  assert.equal(ui.node('leaveShopSection').hidden, false);
  assert.equal(ui.node('leaveShopButton').disabled, false);
  await ui.click();
  assert.equal(ui.node('leaveShopTitle').textContent, 'Leave Shop <A>?');
  assert.equal(ui.focused(), ui.node('cancelLeaveShop'));
  await ui.submit();
  assert.equal(ui.calls[0].path, '/api/household/leave');
  assert.equal(ui.calls[0].options.headers['X-Shop-Id'], 'shop');
  assert.deepEqual(JSON.parse(ui.calls[0].options.body), { operationId: 'leave-1' });
  assert.equal(ui.reloads, 1);
});

test('leave is disabled with a visible reason for the last owner, enabled for members', async () => {
  const ui = leavePage({ members: { members: [owner('me', true), { user_id: 'm1', email: 'm', role: 'member' }] } });
  ui.controller.refresh();
  assert.equal(ui.node('leaveShopButton').disabled, true);
  assert.match(ui.node('leaveShopStatus').textContent, /Make another member an owner before leaving/);
  await ui.click();
  assert.equal(ui.node('leaveShopModal').open, false);
  ui.setAccess({ members: [owner('me', true), owner('o2')] });
  ui.controller.refresh();
  assert.equal(ui.node('leaveShopButton').disabled, false);
  assert.equal(ui.node('leaveShopStatus').textContent, '');
  const member = leavePage({ role: 'member', members: null });
  member.controller.refresh();
  assert.equal(member.node('leaveShopButton').disabled, false);
});

test('leave: retry keeps the operation id; 409 explains; 403 reloads; no context hides the control', async () => {
  let attempts = 0;
  const retry = leavePage({ handler: () => { if (++attempts === 1) throw fail(503); return { left: true }; } });
  await retry.click(); await retry.submit();
  assert.equal(retry.reloads, 0);
  assert.equal(retry.node('confirmLeaveShop').textContent, 'Retry');
  await retry.submit();
  assert.deepEqual(retry.calls.map(c => JSON.parse(c.options.body).operationId), ['leave-1', 'leave-1']);
  assert.equal(retry.reloads, 1);

  const conflict = leavePage({ handler: () => { throw fail(409, 'A Shop must keep at least one owner.'); } });
  await conflict.click(); await conflict.submit();
  assert.equal(conflict.node('leaveShopModal').open, false);
  assert.match(conflict.node('leaveShopStatus').textContent, /keep at least one owner/);
  assert.equal(conflict.reloads, 0);

  const gone = leavePage({ handler: () => { throw fail(403); } });
  await gone.click(); await gone.submit();
  assert.equal(gone.reloads, 1);

  const none = leavePage();
  none.setContext(null);
  none.controller.refresh();
  assert.equal(none.node('leaveShopSection').hidden, true);
});

test('markup and wiring', () => {
  assert.match(html, /id="demoteMemberModal" aria-labelledby="demoteMemberTitle" aria-describedby="demoteMemberShop demoteMemberHelp"/);
  assert.match(html, /id="leaveShopModal" aria-labelledby="leaveShopTitle" aria-describedby="leaveShopShop leaveShopHelp"/);
  assert.match(html, /id="demoteMemberStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="leaveShopModalStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="cancelLeaveShop"[^>]*>Cancel<.*id="confirmLeaveShop"/);
  assert.match(app, /bindOwnerDemotion\(\{document,/);
  assert.match(app, /const shopLeave=bindShopLeave\(/);
  const item = app.match(/function accessItem\(member\)\{[^\n]+/)[0];
  assert.equal((item.match(/data-demote-member/g) || []).length, 1);
  assert.match(item, /member\.is_you\?null:/);
});
