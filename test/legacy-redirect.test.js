import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest, legacyRedirect } from '../worker/index.js';

const env = { LEGACY_HOST: 'medicineinventory.craftloop.ca', APP_URL: 'https://inventory-management.craftloop.ca' };
const at = (url, method = 'GET') => new Request(url, { method });

test('the old host redirects to the new one, keeping path and query', () => {
  const response = legacyRedirect(at('https://medicineinventory.craftloop.ca/inventory?x=1&y=a%20b#frag'), env);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://inventory-management.craftloop.ca/inventory?x=1&y=a%20b');
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/'), env).headers.get('location'), 'https://inventory-management.craftloop.ca/');
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/admin/api/shops'), env).headers.get('location'), 'https://inventory-management.craftloop.ca/admin/api/shops');
});

test('non-GET requests keep their method with a 308, and HEAD uses 301', () => {
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/api/batches', 'POST'), env).status, 308);
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/api/batches', 'PATCH'), env).status, 308);
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/', 'HEAD'), env).status, 301);
});

test('the host match is case-insensitive and the target never comes from the request', () => {
  assert.equal(legacyRedirect(at('https://MedicineInventory.CraftLoop.ca/x'), env).headers.get('location'), 'https://inventory-management.craftloop.ca/x');
  const sneaky = legacyRedirect(at('https://medicineinventory.craftloop.ca//evil.example/path'), env);
  assert.equal(new URL(sneaky.headers.get('location')).hostname, 'inventory-management.craftloop.ca');
  const withHost = legacyRedirect(new Request('https://medicineinventory.craftloop.ca/', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } }), env);
  assert.equal(new URL(withHost.headers.get('location')).hostname, 'inventory-management.craftloop.ca');
});

test('nothing is redirected on the new host, other hosts, or without the setting', () => {
  assert.equal(legacyRedirect(at('https://inventory-management.craftloop.ca/'), env), null);
  assert.equal(legacyRedirect(at('http://127.0.0.1:3000/'), env), null);
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/'), { APP_URL: env.APP_URL }), null);
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/'), { LEGACY_HOST: env.LEGACY_HOST }), null);
});

test('a redirect that would loop or a bad APP_URL is ignored', () => {
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/'), { ...env, APP_URL: 'https://medicineinventory.craftloop.ca' }), null);
  assert.equal(legacyRedirect(at('https://medicineinventory.craftloop.ca/'), { ...env, APP_URL: 'not a url' }), null);
});

test('handleRequest redirects before any authentication or asset work, and the redirect is cached for a day', async () => {
  let touched = false;
  const spy = { ...env, ASSETS: { fetch: async () => { touched = true; return new Response('asset'); } } };
  const response = await handleRequest(at('https://medicineinventory.craftloop.ca/api/batches'), spy, { waitUntil() {} });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(touched, false);
});

test('production configuration names the old host as LEGACY_HOST and the new one as APP_URL', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^LEGACY_HOST = "medicineinventory\.craftloop\.ca"$/m);
  assert.match(toml, /^APP_URL = "https:\/\/inventory-management\.craftloop\.ca"$/m);
});
