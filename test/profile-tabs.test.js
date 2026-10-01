import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROFILE_TABS, bindProfileTabs } from '../public/profile-tabs.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function fakeDom() {
  const node = (attrs = {}) => {
    const classes = new Set(), listeners = {};
    return { dataset: attrs, attributes: {}, classes, listeners, tabIndex: 0, focused: false,
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(type, handler) { listeners[type] = handler; },
      focus() { this.focused = true; } };
  };
  const buttons = PROFILE_TABS.map(name => node({ profileTab: name }));
  const items = [node({ tabs: 'account' }), node({ tabs: 'shop' }), node({ tabs: 'people' }), node({ tabs: 'account shop' })];
  const document = { querySelectorAll: selector => selector === '[data-profile-tab]' ? buttons : items };
  return { document, buttons, items };
}
const memory = (initial = null) => { const data = { 'profile-tab': initial }; return { getItem: key => data[key], setItem: (key, value) => { data[key] = value; }, data }; };
const visible = items => items.map(item => !item.classes.has('tab-off'));

test('the Account tab shows first and hides the other sections', () => {
  const { document, items, buttons } = fakeDom();
  const tabs = bindProfileTabs({ document, storage: memory() });
  assert.equal(tabs.current, 'account');
  assert.deepEqual(visible(items), [true, false, false, true]);
  assert.deepEqual(buttons.map(button => button.attributes['aria-selected']), ['true', 'false', 'false']);
});

test('choosing a tab shows its cards, including cards that belong to two tabs', () => {
  const { document, items, buttons } = fakeDom();
  bindProfileTabs({ document, storage: memory() });
  buttons[1].listeners.click();
  assert.deepEqual(visible(items), [false, true, false, true]);
  buttons[2].listeners.click();
  assert.deepEqual(visible(items), [false, false, true, false]);
  assert.deepEqual(buttons.map(button => button.tabIndex), [-1, -1, 0]);
});

test('the last tab is remembered, and an unknown saved value falls back to Account', () => {
  const store = memory('shop');
  assert.equal(bindProfileTabs({ document: fakeDom().document, storage: store }).current, 'shop');
  assert.equal(bindProfileTabs({ document: fakeDom().document, storage: memory('bogus') }).current, 'account');
  const { document, buttons } = fakeDom();
  const saving = memory();
  bindProfileTabs({ document, storage: saving });
  buttons[2].listeners.click();
  assert.equal(saving.data['profile-tab'], 'people');
});

test('arrow keys, Home and End move between tabs and wrap around', () => {
  const { document, buttons } = fakeDom();
  const tabs = bindProfileTabs({ document, storage: memory() });
  const press = key => { let prevented = false; buttons[0].listeners.keydown({ key, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(press('ArrowRight'), true); assert.equal(tabs.current, 'shop');
  assert.equal(press('ArrowLeft'), true); assert.equal(tabs.current, 'account');
  assert.equal(press('ArrowLeft'), true); assert.equal(tabs.current, 'people');
  assert.equal(press('Home'), true); assert.equal(tabs.current, 'account');
  assert.equal(press('End'), true); assert.equal(tabs.current, 'people');
  assert.equal(press('a'), false);
  assert.equal(buttons[2].focused, true);
});

test('unavailable storage does not break the tabs', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const { document, buttons } = fakeDom();
  const tabs = bindProfileTabs({ document, storage: broken });
  buttons[1].listeners.click();
  assert.equal(tabs.current, 'shop');
});

test('every Profile card is assigned to a tab, and the page has the three tabs', () => {
  const profile = html.slice(html.indexOf('id="profileView"'), html.indexOf('</main>'));
  for (const name of PROFILE_TABS) assert.match(profile, new RegExp(`data-profile-tab="${name}"`));
  const sections = [...profile.matchAll(/<section\b[^>]*class="[^"]*(?:profile-card|household-access)[^"]*"[^>]*>/g)].map(match => match[0]);
  assert.ok(sections.length >= 10);
  for (const tag of sections) assert.match(tag, /data-tabs="(?:account|shop|people)(?: (?:account|shop|people))*"/, tag);
});

test('account cards, shop cards and people cards sit where a user would look for them', () => {
  const tab = id => html.match(new RegExp(`<section[^>]*id="${id}" data-tabs="([^"]+)"`))?.[1];
  assert.equal(tab('emailPreferencesCard'), 'account');
  for (const id of ['shopSelectorCard', 'overviewProfileCard', 'createShopCard', 'deletedShopsCard']) assert.equal(tab(id), 'shop', id);
  for (const id of ['shopInvitationsCard', 'householdAccess']) assert.equal(tab(id), 'people', id);
});

test('the profile form still wraps every field it saves, and tabs hide with display none', () => {
  const form = html.slice(html.indexOf('id="profileSettingsForm"'), html.indexOf('</form>', html.indexOf('id="profileSettingsForm"')));
  for (const field of ['display_name', 'household_name', 'shop_type', 'default_storage_location']) assert.ok(form.includes(`name="${field}"`), field);
  assert.match(css, /\.tab-off \{ display: none !important; \}/);
  assert.match(css, /#profileView > \.profile-card \{ max-width: 900px; margin: 0 0 18px; \}/);
});

test('checkbox rows in the email card stack, one per line', () => {
  assert.match(css, /\.check-row \{ display: flex; align-items: flex-start;/);
});
