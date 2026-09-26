import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetCacheControl, handleRequest } from '../worker/index.js';

test('worker cache policy requires fresh shell and bootstrap assets', () => {
  assert.equal(assetCacheControl('/index.html'), 'no-store');
  assert.equal(assetCacheControl('/app.js'), 'no-cache, must-revalidate');
  assert.equal(assetCacheControl('/shop-client.js'), 'no-cache, must-revalidate');
  assert.equal(assetCacheControl('/styles.css'), 'no-cache, must-revalidate');
  assert.equal(assetCacheControl('/sw.js'), 'no-cache, must-revalidate');
});

test('worker preserves immutable caching for image assets', () => {
  assert.equal(assetCacheControl('/icons/medicine.abc123.png'), 'public, max-age=31536000, immutable');
  assert.equal(assetCacheControl('/fonts/app.woff2'), null);
});

test('worker applies asset headers without changing the asset body', async () => {
  const response = await handleRequest(new Request('https://example.test/'), {
    ASSETS: { fetch: async () => new Response('shell', { headers: { 'content-type': 'text/html' } }) }
  }, {});
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'shell');
});

test('invite gate remains hidden when the app reveals the shell', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.invite-gate\[hidden\]\s*\{\s*display:\s*none\s*;\s*\}/);
});
