import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIELD_TIPS, anchorFor, bindInfoTips, placeTip } from '../public/info-tips.js';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('every tip points at a real field in the page, is one short sentence and is unique', () => {
  const seen = new Set();
  for (const [selector, text] of FIELD_TIPS) {
    const id = /^#(\w+)$/.exec(selector)?.[1], name = /\[name=(\w+)\]/.exec(selector)?.[1];
    assert.ok(id ? page.includes(`id="${id}"`) : page.includes(`name="${name}"`), `${selector} exists in index.html`);
    assert.ok(text.length <= 100 && /\.$/.test(text) && !text.includes('\n'), `${selector} tip is one short sentence`);
    assert.ok(!/medicine/i.test(text.replace('Medicine or General goods', '')), `${selector} tip also fits General goods Shops`);
    assert.ok(!seen.has(selector), `${selector} appears once`);
    seen.add(selector);
  }
  assert.ok(FIELD_TIPS.length >= 15);
});

test('tip placement stays on screen and flips above when there is no room below', () => {
  const viewport = { width: 360, height: 640 };
  assert.deepEqual(placeTip({ left: 20, top: 100, bottom: 120 }, { width: 200, height: 40 }, viewport), { left: 20, top: 128 });
  assert.equal(placeTip({ left: 300, top: 100, bottom: 120 }, { width: 200, height: 40 }, viewport).left, 152, 'nudged left from the right edge');
  assert.equal(placeTip({ left: -30, top: 100, bottom: 120 }, { width: 200, height: 40 }, viewport).left, 8, 'nudged right from the left edge');
  assert.equal(placeTip({ left: 20, top: 600, bottom: 620 }, { width: 200, height: 40 }, viewport).top, 552, 'flipped above near the bottom');
  assert.equal(placeTip({ left: 20, top: 10, bottom: 30 }, { width: 200, height: 620 }, viewport).top, 38, 'stays below when above would not fit either');
});

// A tiny DOM: enough for the binder (append, querySelector, closest, events, attributes).
class Node {
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.ownerDocument = doc; this.children = []; this.parent = null; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.style = {}; this.className = ''; this.textContent = ''; }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  fire(name, extra = {}) { const event = { preventDefault() {}, stopPropagation() {}, target: this, ...extra }; (this.listeners[name] || []).forEach(fn => fn(event)); }
  closest(selector) { for (let node = this; node; node = node.parent) if (selector === 'dialog' ? node.tag === 'dialog' : node.className.split(' ').includes(selector.slice(1))) return node; return null; }
  querySelector(selector) { const walk = node => { for (const child of node.children) { if (selector === '.info-tip' ? child.className === 'info-tip' : false) return child; const found = walk(child); if (found) return found; } return null; }; return walk(this); }
  getBoundingClientRect() { return { left: 40, top: 100, bottom: 120, width: 180, height: 36 }; }
}

function pageFixture() {
  const doc = { listeners: {}, activeElement: null };
  doc.createElement = tag => new Node(tag, doc);
  doc.addEventListener = (name, fn) => (doc.listeners[name] ||= []).push(fn);
  doc.fire = (name, event) => (doc.listeners[name] || []).forEach(fn => fn(event));
  doc.body = new Node('body', doc);
  const dialog = new Node('dialog', doc); doc.body.append(dialog);
  const label = new Node('label', doc); dialog.append(label);
  const control = new Node('input', doc); control.id = 'field'; control.closest = () => null;
  doc.querySelector = selector => selector === '#field' ? control : selector === 'label[for="field"]' ? label : null;
  return { doc, dialog, label, control };
}

test('the binder adds one info button to a field label, shows and hides its tip, and ignores missing fields', () => {
  const { doc, dialog, label } = pageFixture();
  const tips = bindInfoTips({ document: doc, tips: [['#field', 'Explains the field.'], ['#missing', 'Nothing here.']], getViewport: () => ({ width: 360, height: 640 }) });
  assert.equal(tips.count, 1);
  const button = label.children[0];
  assert.equal(button.className, 'info-tip');
  assert.equal(button.attrs['aria-expanded'], 'false');
  button.fire('mouseenter');
  const node = dialog.children.find(child => child.className === 'info-tip-text');
  assert.ok(node, 'the tip opens inside the dialog so it is not hidden behind it');
  assert.equal(node.textContent, 'Explains the field.');
  assert.equal(node.attrs.role, 'tooltip');
  assert.equal(button.attrs['aria-describedby'], node.id);
  assert.equal(button.attrs['aria-expanded'], 'true');
  button.fire('mouseleave');
  assert.equal(dialog.children.some(child => child.className === 'info-tip-text'), false);
  assert.equal(button.attrs['aria-expanded'], 'false');
});

test('a tap pins the tip, a second tap, Escape or a tap elsewhere closes it, and the button is added only once', () => {
  const { doc, dialog, label } = pageFixture();
  bindInfoTips({ document: doc, tips: [['#field', 'Explains the field.']], getViewport: () => ({ width: 360, height: 640 }) });
  const button = label.children[0];
  const open = () => dialog.children.some(child => child.className === 'info-tip-text');
  button.fire('click'); assert.equal(open(), true);
  button.fire('mouseleave'); assert.equal(open(), true, 'a pinned tip survives the pointer leaving, even where a click does not focus the button (Safari)');
  button.fire('click'); assert.equal(open(), false, 'second tap closes');
  button.fire('click'); assert.equal(open(), true);
  doc.fire('keydown', { key: 'Escape', stopPropagation() {} }); assert.equal(open(), false, 'Escape closes');
  button.fire('click'); assert.equal(open(), true);
  doc.fire('click', { target: { closest: () => null } }); assert.equal(open(), false, 'a tap elsewhere closes');
  bindInfoTips({ document: doc, tips: [['#field', 'Explains the field.']] });
  assert.equal(label.children.length, 1, 'binding twice does not add a second button');
});

test('anchorFor prefers the label for the control, then the first span or label in the field', () => {
  const label = { tag: 'label' };
  const withLabel = { id: 'a', ownerDocument: { querySelector: () => label }, closest: () => null };
  assert.equal(anchorFor(withLabel), label);
  const span = { tag: 'span' };
  const inField = { id: '', ownerDocument: { querySelector: () => null }, closest: () => ({ querySelector: () => span }) };
  assert.equal(anchorFor(inField), span);
  assert.equal(anchorFor({ id: '', ownerDocument: {}, closest: () => null }), null);
});

test('renaming the Form label for General goods keeps the info button', () => {
  const source = readFileSync(new URL('../public/options-client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /formLabel\.textContent\s*=/, 'textContent would wipe the info button');
  assert.match(source, /labelText\.nodeValue\s*=/);
});
