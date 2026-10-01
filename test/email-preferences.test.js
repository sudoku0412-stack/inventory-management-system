import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmailPreferences, setEmailPreferences, validateEmailPreferences } from '../lib/email-preferences.js';
import { bindEmailPreferences } from '../public/email-preferences-client.js';
import { memoryDb, seedPeople } from './db-fixture.js';

const owner = { provider: 'access', subject: 'sub-u1' };
const member = { provider: 'access', subject: 'sub-u2' };

function setup() { const f = memoryDb(); seedPeople(f.sqlite); return f; }

test('both email switches default to on', async () => {
  const f = setup();
  assert.deepEqual(await getEmailPreferences(f.db, owner), { noticesEnabled: true, digestEnabled: true });
});

test('changing one switch keeps the other, per account', async () => {
  const f = setup();
  assert.deepEqual(await setEmailPreferences(f.db, owner, { digestEnabled: false }), { noticesEnabled: true, digestEnabled: false });
  assert.deepEqual(await setEmailPreferences(f.db, owner, { noticesEnabled: false }), { noticesEnabled: false, digestEnabled: false });
  assert.deepEqual(await setEmailPreferences(f.db, owner, { noticesEnabled: true }), { noticesEnabled: true, digestEnabled: false });
  assert.deepEqual(await getEmailPreferences(f.db, member), { noticesEnabled: true, digestEnabled: true }, 'another account is unaffected');
  assert.equal(f.rows('SELECT count(*) AS n FROM user_email_preferences')[0].n, 1);
});

test('only known boolean settings are accepted', () => {
  assert.deepEqual(validateEmailPreferences({ noticesEnabled: false }), { noticesEnabled: false });
  for (const bad of [null, undefined, 'x', [], {}, { noticesEnabled: 'no' }, { digestEnabled: 1 }, { noticesEnabled: true, other: true }, { admin: true }]) assert.throws(() => validateEmailPreferences(bad), { status: 400 }, JSON.stringify(bad));
});

test('unknown or missing accounts cannot read or change settings', async () => {
  const f = setup();
  for (const who of [null, {}, { provider: 'access' }, { provider: 'access', subject: 'nobody' }]) {
    await assert.rejects(getEmailPreferences(f.db, who), { status: 403 });
    await assert.rejects(setEmailPreferences(f.db, who, { noticesEnabled: false }), { status: 403 });
  }
});

test('a database without the table reports the settings as unavailable', async () => {
  const f = setup();
  f.sqlite.exec('DROP TABLE user_email_preferences');
  await assert.rejects(getEmailPreferences(f.db, owner), { status: 503, message: /temporarily unavailable/ });
});

function fakePage({ request, key = 'account-1' } = {}) {
  const make = () => ({ checked: true, disabled: false, hidden: true, textContent: '', listeners: {}, classList: { toggle(name, on) { this.on = on; } }, addEventListener(type, handler) { this.listeners[type] = handler; } });
  const nodes = { '#emailPreferencesCard': make(), '#emailPreferencesStatus': make(), '#emailNoticesToggle': make(), '#emailDigestToggle': make() };
  const context = { accountContextKey: key };
  const calls = [];
  const send = request || (async (path, options) => { calls.push([path, options?.method, options?.body]); return options?.method === 'PUT' ? { noticesEnabled: true, digestEnabled: false, ...JSON.parse(options.body) } : { noticesEnabled: false, digestEnabled: true }; });
  const page = bindEmailPreferences({ document: { querySelector: selector => nodes[selector] }, getContext: () => context, request: send });
  return { page, nodes, context, calls };
}

test('the card appears with the saved switch positions, and loads once per account', async () => {
  const { page, nodes, calls } = fakePage();
  await page.refresh();
  assert.equal(nodes['#emailPreferencesCard'].hidden, false);
  assert.equal(nodes['#emailNoticesToggle'].checked, false);
  assert.equal(nodes['#emailDigestToggle'].checked, true);
  await page.refresh();
  assert.equal(calls.length, 1);
  await page.refresh(true);
  assert.equal(calls.length, 2);
});

test('the card stays hidden when there is no account or the settings cannot be read', async () => {
  const { page, nodes } = fakePage({ key: null });
  await page.refresh();
  assert.equal(nodes['#emailPreferencesCard'].hidden, true);
  const failing = fakePage({ request: async () => { throw new Error('down'); } });
  await failing.page.refresh();
  assert.equal(failing.nodes['#emailPreferencesCard'].hidden, true);
  const odd = fakePage({ request: async () => ({ noticesEnabled: 'yes' }) });
  await odd.page.refresh();
  assert.equal(odd.nodes['#emailPreferencesCard'].hidden, true);
});

test('flipping a switch saves just that setting, locks both while saving and reports the result', async () => {
  const { page, nodes, calls } = fakePage();
  await page.refresh();
  nodes['#emailDigestToggle'].checked = false;
  const pending = nodes['#emailDigestToggle'].listeners.change();
  assert.equal(nodes['#emailNoticesToggle'].disabled, true);
  await pending;
  assert.deepEqual(calls.at(-1), ['/api/email-preferences', 'PUT', JSON.stringify({ digestEnabled: false })]);
  assert.equal(nodes['#emailNoticesToggle'].disabled, false);
  assert.equal(nodes['#emailPreferencesStatus'].textContent, 'Weekly summary off.');
});

test('a failed save puts the switch back and says so', async () => {
  let fail = false;
  const { page, nodes } = fakePage({ request: async (path, options) => { if (options?.method === 'PUT' && fail) throw new Error('offline'); return { noticesEnabled: true, digestEnabled: true }; } });
  await page.refresh();
  fail = true;
  nodes['#emailNoticesToggle'].checked = false;
  await nodes['#emailNoticesToggle'].listeners.change();
  assert.equal(nodes['#emailNoticesToggle'].checked, true);
  assert.match(nodes['#emailPreferencesStatus'].textContent, /couldn’t save/);
  assert.equal(nodes['#emailPreferencesStatus'].classList.on, true);
  assert.equal(nodes['#emailDigestToggle'].disabled, false);
});
