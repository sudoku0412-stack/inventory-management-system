import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetCacheControl, handleRequest } from '../worker/index.js';
import { publicAssetPaths } from '../lib/shared.js';

const html = () => readFile(new URL('../public/welcome/index.html', import.meta.url), 'utf8');
const serve = async (path, method = 'GET') => {
  const asked = [];
  const response = await handleRequest(new Request(`https://inventory-management.craftloop.ca${path}`, { method }), { ASSETS: { fetch: async url => { asked.push(new URL(url).pathname); return new Response(`asset ${new URL(url).pathname}`, { headers: { 'content-type': 'text/html' } }); } } }, {});
  return { response, asked };
};

test('the landing page and its stylesheet are served without any Access header', async () => {
  for (const path of ['/welcome', '/welcome/']) {
    const { response, asked } = await serve(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(asked, ['/welcome/index.html']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const css = await serve('/welcome/landing.css');
  assert.equal(css.response.status, 200);
  assert.deepEqual(css.asked, ['/welcome/landing.css']);
  assert.equal(assetCacheControl('/welcome/landing.css'), 'no-cache, must-revalidate');
});

test('only the landing files are public under /welcome, and only for GET', async () => {
  assert.equal((await serve('/welcome/other.js')).response.status, 404);
  assert.equal((await serve('/welcome/index.html')).response.status, 404);
  assert.equal((await serve('/welcome', 'POST')).response.status, 404);
  assert.equal((await serve('/welcome/landing.css', 'DELETE')).response.status, 404);
  assert.ok(publicAssetPaths.has('/welcome') && publicAssetPaths.has('/welcome/') && publicAssetPaths.has('/welcome/landing.css'));
});

test('the landing page points sign-in at the app, loads no scripts, and names the product', async () => {
  const page = await html();
  assert.match(page, /<title>Inventory Management System<\/title>/);
  assert.ok((page.match(/<a class="button[^"]*" href="\/">Sign in<\/a>/g) || []).length >= 2, 'sign-in buttons go to the app root, behind Access');
  assert.doesNotMatch(page, /<script/i, 'no scripts: the page stays inside the strict CSP');
  assert.doesNotMatch(page, /style=/i, 'no inline styles: the CSP allows only the stylesheet');
  assert.doesNotMatch(page, /medicine inventory|medicineinventory/i);
  assert.match(page, /href="\/welcome\/landing\.css"/);
  assert.match(page, /by invitation/i);
});

test('the landing stylesheet supports dark mode and small screens', async () => {
  const css = await readFile(new URL('../public/welcome/landing.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /@media \(max-width: 560px\)/);
});

test('the app itself still needs Access: root is not part of the public landing routes', async () => {
  const { asked } = await serve('/');
  assert.deepEqual(asked, ['/index.html']);
  assert.equal((await serve('/api/batches')).response.status === 200, false);
});
