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

test('the landing page points every sign-in at the app, runs only its own scripts, and names the product', async () => {
  const page = await html();
  assert.match(page, /<title>Inventory Management System<\/title>/);
  assert.equal((page.match(/href="\/signin"/g) || []).length, 3, 'Sign in in the header, the hero and the closing call to action');
  assert.doesNotMatch(page, /href="\/">/, 'nothing links to /, which sends signed-out visitors back here');
  const scripts = [...page.matchAll(/<script\b[^>]*>/gi)].map(match => match[0]);
  assert.equal(scripts.length, 2);
  for (const tag of scripts) assert.match(tag, /src="\/welcome\/[\w.-]+\.js"/, 'every script is a file under /welcome, never inline');
  assert.doesNotMatch(page, /<script\b[^>]*>\s*[^<\s]/i, 'no inline script body: the CSP allows only files');
  assert.doesNotMatch(page, /style=|<style/i, 'no inline styles: the CSP allows only the stylesheet');
  assert.doesNotMatch(page, /medicine inventory|medicineinventory/i);
  assert.match(page, /href="\/welcome\/landing\.css"/);
  assert.match(page, /by invitation/i);
  assert.doesNotMatch(page, /waitlist|join the list/i, 'there is no waitlist: access is by invitation');
});

test('the landing files, fonts and scripts are public, only for GET, and revalidated where they change', async () => {
  for (const path of ['/welcome/landing.js', '/welcome/theme.js', '/welcome/fonts/bricolage-grotesque-v1.woff2', '/welcome/fonts/instrument-sans-v1.woff2']) {
    assert.ok(publicAssetPaths.has(path), `${path} must be allowed`);
    const { response, asked } = await serve(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(asked, [path]);
    assert.equal((await serve(path, 'POST')).response.status, 404);
  }
  assert.equal(assetCacheControl('/welcome/landing.js'), 'no-cache, must-revalidate');
  assert.equal(assetCacheControl('/welcome/theme.js'), 'no-cache, must-revalidate');
  for (const file of ['bricolage-grotesque-v1.woff2', 'instrument-sans-v1.woff2']) {
    const bytes = await readFile(new URL(`../public/welcome/fonts/${file}`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${file} is a real woff2`);
  }
});

test('the landing stylesheet defines the animations, the dark theme and reduced motion', async () => {
  const css = await readFile(new URL('../public/welcome/landing.css', import.meta.url), 'utf8');
  assert.match(css, /@keyframes float/);
  assert.match(css, /@keyframes pulse-ring/);
  assert.match(css, /\.dark\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.js \[data-reveal\]/, 'content is hidden for the reveal only when the script runs');
  assert.match(css, /font-family: "Bricolage Grotesque"/);
  assert.match(css, /url\("\/welcome\/fonts\//, 'fonts come from this site, which the CSP requires');
  assert.doesNotMatch(css, /https?:\/\//, 'nothing is loaded from another site');
});

test('the app itself still needs Access: root is not part of the public landing routes', async () => {
  const { asked } = await serve('/');
  assert.deepEqual(asked, ['/index.html']);
  assert.equal((await serve('/api/batches')).response.status === 200, false);
});

test('the logo files for the Cloudflare Access login page are public, cached as images, and real PNGs', async () => {
  for (const path of ['/welcome/logo-v1.png', '/welcome/icon-v1.png']) {
    assert.ok(publicAssetPaths.has(path), path);
    const { response, asked } = await serve(path);
    assert.equal(response.status, 200);
    assert.deepEqual(asked, [path]);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const file = await readFile(new URL(`../public${path}`, import.meta.url));
    assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is a PNG`);
    assert.ok(file.length < 200 * 1024, `${path} stays small`);
  }
});

test('/signin sends a signed-in visitor on to the app and is never cached', async () => {
  const { response, asked } = await serve('/signin');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(asked, []);
  assert.equal((await serve('/signin', 'POST')).response.status, 404);
});
