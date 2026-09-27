import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bindOwnerPromotion } from '../public/owner-promotion-client.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const member = { user_id: 'member', email: 'very-long-member-name@example.test', role: 'member' };
function page(request) {
  let focused, context = { accountContextKey: 'account', activeShopId: 'shop', active: { id: 'shop', name: '<Shop & name>', role: 'owner' }, shops: [{ id: 'shop', name: '<Shop & name>', role: 'owner' }] };
  let access = { members: [{ user_id: 'actor', email: 'owner@example.test', role: 'owner', is_you: true }, { ...member }, { ...member, user_id: 'second', email: 'second@example.test' }], invitations: [] }, controller, id = 0;
  const nodes = new Map(), calls = [], profile = { display_name: 'Unsaved name', household_name: 'Unsaved Shop' };
  class Node {
    constructor(tag, root = false) { this.tag = tag; this.root = root; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.disabled = false; this.open = false; this.classList = { toggle() {} }; }
    set textContent(text) { this.text = text; this.replaceChildren(); }
    get textContent() { return (this.text || '') + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = value; if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value; }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...children) { for (const child of children) { this.children.push(child); if (typeof child !== 'string') child.parent = this; } }
    replaceChildren(...children) { for (const child of this.children) if (typeof child !== 'string') child.parent = null; this.children = []; this.append(...children); }
    get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
    matches(selector) { return selector.startsWith('[') && Object.hasOwn(this.attributes, selector.slice(1, -1)); }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(child => typeof child === 'string' ? [] : [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    async emit(type, target = this) { for (const fn of this.listeners[type] || []) await fn({ target, currentTarget: this, preventDefault() {} }); }
    focus() { if (this.tag === 'button' || this.attributes.tabindex !== undefined) focused = this; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.emit('close'); }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node(/^(cancel|confirm)/.test(id) ? 'button' : 'div', true)); return nodes.get(id); };
  node('householdAccessTitle').setAttribute('tabindex', '-1');
  const document = { querySelector: selector => node(selector.slice(1)), createElement: tag => new Node(tag) };
  const el = (tag, attributes = {}, ...children) => {
    const result = new Node(tag); for (const [key, value] of Object.entries(attributes)) key === 'text' ? result.textContent = value : result.setAttribute(key, value); result.append(...children); return result;
  };
  // Exercise production row creation, including actual tabindex and stable IDs.
  const sandbox = { el, ownerPromotion: { retryTarget: () => controller?.retryTarget() } };
  vm.runInNewContext(app.match(/function accessItem\(member\)\{[^\n]+/)[0], sandbox);
  const renderAccess = next => { access = next; node('householdMembers').replaceChildren(...(next?.members || []).map(sandbox.accessItem)); };
  controller = bindOwnerPromotion({ document, getContext: () => context, getAccess: () => access, renderAccess,
    renderContext: next => { context = { ...next, active: next.shops.find(shop => shop.id === next.activeShopId) }; }, operationId: () => `operation-${++id}`,
    request: async (path, options) => { calls.push({ path, options }); return request ? request(path, options) : options.method === 'POST' ? { changed: true } : path === '/api/shops' ? context : { ...access, members: access.members.map(item => item.user_id === member.user_id ? { ...item, role: 'owner' } : item) }; }
  });
  renderAccess(access);
  return { node, calls, profile, controller, get access() { return access; }, get context() { return context; }, get focused() { return focused; },
    changeContext(next) { context = next; },
    async open(target = member.user_id) { const button = node('householdMembers').querySelectorAll('[data-promote-member]').find(item => item.dataset.promoteMember === target); await node('householdMembers').emit('click', button); return button; },
    submit: () => node('promoteMemberForm').emit('submit'), reload: () => node('householdAccessStatus').children.find(child => child.tag === 'button')
  };
}

test('promotion confirmation and native dismissal preserve trigger focus; confirmed success focuses actual Owner label and dirty Profile', async () => {
  const ui = page(), dirty = JSON.stringify(ui.profile);
  const trigger = await ui.open();
  assert.equal(ui.focused, ui.node('cancelPromoteMember'));
  assert.match(ui.node('promoteMemberTitle').textContent, /Make very-long-member/);
  assert.equal(ui.node('promoteMemberShop').textContent, 'Shop: <Shop & name>');
  ui.node('promoteMemberModal').close(); // Native Escape/backdrop close event.
  assert.equal(ui.focused, trigger); assert.equal(ui.calls.length, 0);
  await ui.open(); await ui.submit();
  assert.equal(ui.node('promoteMemberModal').open, false);
  assert.equal(ui.focused.dataset.ownerMember, member.user_id);
  assert.equal(ui.focused.getAttribute('tabindex'), '-1');
  assert.match(ui.node('householdAccessStatus').textContent, /is now an owner of <Shop & name>/);
  assert.equal(JSON.stringify(ui.profile), dirty);
  assert.equal(ui.node('shopSelector').disabled, false);
});

for (const failingRead of ['/api/household/access', '/api/shops']) test(`confirmed result stays durable when ${failingRead} fails; Reload only reads`, async () => {
  let fail = true, ui;
  ui = page(async (path, options) => {
    if (options.method === 'POST') return { changed: true };
    if (fail && path === failingRead) throw Error('offline');
    return path === '/api/shops' ? ui.context : ui.access;
  });
  await ui.open(); const dirty = JSON.stringify(ui.profile); await ui.submit();
  assert.equal(ui.access.members.find(item => item.user_id === member.user_id).role, 'owner');
  assert.match(ui.node('householdAccessStatus').textContent, /is now an owner.*Reload Shop access/);
  assert.equal(ui.reload().textContent, 'Reload Shop access'); assert.equal(ui.focused, ui.reload());
  await ui.reload().emit('click'); // A second failed read still preserves success and a usable retry.
  assert.match(ui.node('householdAccessStatus').textContent, /is now an owner/); assert.equal(ui.reload().disabled, false);
  fail = false; await ui.reload().emit('click');
  assert.equal(ui.reload(), undefined); assert.equal(ui.focused.dataset.ownerMember, member.user_id);
  assert.equal(ui.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(ui.calls.every(call => call.options.headers['X-Shop-Id'] === 'shop'));
  assert.equal(JSON.stringify(ui.profile), dirty);
});

test('close/reopen during flight cannot dispatch duplicates or retarget; ambiguous retry retains operation and pinned context', async () => {
  const pending = deferred(); let ui, posts = 0;
  ui = page((path, options) => options.method === 'POST' ? ++posts === 1 ? pending.promise : { changed: false } : path === '/api/shops' ? ui.context : { ...ui.access, members: ui.access.members.map(item => item.user_id === member.user_id ? { ...item, role: 'owner' } : item) });
  await ui.open(); const action = ui.submit();
  assert.equal(ui.node('confirmPromoteMember').disabled, true); assert.equal(ui.node('shopSelector').disabled, true);
  assert.equal(ui.node('promoteMemberForm').getAttribute('aria-busy'), 'true');
  ui.node('promoteMemberModal').close(); await ui.open('second');
  assert.equal(ui.node('promoteMemberModal').open, false);
  await ui.open(); await ui.submit(); assert.equal(posts, 1);
  pending.reject(Error('lost response')); await action;
  assert.equal(ui.controller.retryTarget(), member.user_id); assert.equal(ui.node('confirmPromoteMember').textContent, 'Retry');
  ui.node('promoteMemberModal').close(); await ui.open(); assert.equal(posts, 1);
  await ui.submit();
  const mutations = ui.calls.filter(call => call.options.method === 'POST');
  assert.equal(mutations[0].options.body, mutations[1].options.body); assert.equal(mutations[0].path, mutations[1].path);
  assert.match(ui.node('householdAccessStatus').textContent, /is already an owner/);
});

test('account/Shop changes suppress stale results and do not reuse old intents', async () => {
  const pending = deferred(), ui = page(() => pending.promise);
  await ui.open(); const action = ui.submit();
  ui.changeContext({ ...ui.context, accountContextKey: 'another-account', activeShopId: 'another-shop', active: { id: 'another-shop', role: 'owner', name: 'Another' } });
  const before = ui.node('householdAccessStatus').textContent;
  pending.resolve({ changed: true }); await action;
  assert.equal(ui.node('householdAccessStatus').textContent, before);
  assert.equal(ui.access.members.find(item => item.user_id === member.user_id).role, 'member');
  assert.equal(ui.calls.length, 1); assert.equal(ui.controller.retryTarget(), null);
});

test('Member context cannot open promotion; forbidden result uses definitive guidance and no optimistic change', async () => {
  const ui = page(async () => { throw Object.assign(Error('Forbidden'), { status: 403 }); });
  ui.changeContext({ ...ui.context, active: { ...ui.context.active, role: 'member' } });
  await ui.open(); assert.equal(ui.node('promoteMemberModal').open, false); assert.equal(ui.calls.length, 0);
  ui.changeContext({ ...ui.context, active: { ...ui.context.active, role: 'owner' } });
  await ui.open(); await ui.submit();
  assert.equal(ui.access.members.find(item => item.user_id === member.user_id).role, 'member');
  assert.match(ui.node('householdAccessStatus').textContent, /no longer have permission/);
});

test('wired controller and 320px / 200% zoom reflow contract keep focus, touch targets, wrapping and independently scrolling body', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /const ownerPromotion=bindOwnerPromotion/);
  assert.match(html, /id="householdAccessTitle" tabindex="-1"/);
  assert.match(html, /<dialog class="modal confirm-modal" id="promoteMemberModal" aria-labelledby="promoteMemberTitle" aria-describedby="promoteMemberShop promoteMemberHelp">/);
  assert.match(html, /id="promoteMemberStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="cancelPromoteMember"[^>]*>Cancel<.*id="confirmPromoteMember"/);
  assert.match(css, /\.access-email \{ overflow-wrap: anywhere/);
  assert.match(css, /#promoteMemberModal \{ overflow-wrap: anywhere/);
  assert.match(css, /#promoteMemberModal \.modal-body \{ overflow-y: auto; min-height: 0/);
  assert.match(css, /#promoteMemberModal \.button, #householdAccessStatus \.button \{ min-height: 44px/);
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
  for (const effectiveWidth of [320, 640 / 2]) {
    assert.ok(effectiveWidth <= 760);
    assert.match(mobile, /\.access-list li \{ display:grid; grid-template-columns:minmax\(0,1fr\) auto/);
    assert.match(mobile, /\.access-list li > \.button \{ grid-column:1 \/ -1; width:100%/);
    assert.match(mobile, /\.confirm-modal \.modal-footer \{ display:grid; grid-template-columns:1fr/);
    assert.match(mobile, /\.modal \{ position: fixed; inset: auto 0 0; width: 100%; max-width: none;[^}]*100dvh/);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
