import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../landing-site/${path}`, import.meta.url), 'utf8');
const APP = 'https://inventory-management.craftloop.ca/';

test('every call to action opens the app URL, which sends a signed-out visitor to the app welcome page', async () => {
  const page = await read('public/index.html');
  const buttons = [...page.matchAll(/<a class="(?:pill-button|button(?: on-dark)?)" href="([^"]+)"/g)].map(match => match[1]);
  assert.equal(buttons.length, 3, 'header, hero and closing buttons');
  for (const href of buttons) assert.equal(href, APP);
  assert.doesNotMatch(page, /waitlist|join the list|<form|<input/i, 'no waitlist form');
  assert.doesNotMatch(page, /href="\/signin"|href="\/welcome/, 'nothing points at routes that exist only inside the app');
});

test('the marketing page runs only its own files and loads nothing from another site', async () => {
  const page = await read('public/index.html'), css = await read('public/landing.css');
  const scripts = [...page.matchAll(/<script\b[^>]*>/gi)].map(match => match[0]);
  assert.equal(scripts.length, 2);
  for (const tag of scripts) assert.match(tag, /src="\/[\w.-]+\.js"/);
  assert.doesNotMatch(page, /<script\b[^>]*>\s*[^<\s]/i, 'no inline script');
  assert.doesNotMatch(page, /style=|<style/i, 'no inline style');
  assert.doesNotMatch(css, /https?:\/\//);
  assert.match(css, /url\("\/fonts\/bricolage-grotesque-v1\.woff2"\)/);
  assert.match(css, /url\("\/fonts\/instrument-sans-v1\.woff2"\)/);
  assert.match(page, /<title>Inventory Management System<\/title>/);
  assert.doesNotMatch(page, /medicine inventory|medicineinventory/i);
});

test('the Worker serves static files only, with a strict security policy', async () => {
  const config = await read('wrangler.toml'), headers = await read('public/_headers');
  assert.match(config, /name = "inventory-management-landing"/);
  assert.match(config, /\[assets\]\s*\ndirectory = "\.\/public"/);
  assert.doesNotMatch(config, /main\s*=|d1_databases|r2_buckets|kv_namespaces|\[vars\]/, 'no code, no data, no secrets');
  assert.match(headers, /default-src 'self'/);
  assert.match(headers, /script-src 'self'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /connect-src 'none'/);
});

test('the animations and dark theme are defined, and reduced motion is respected', async () => {
  const css = await read('public/landing.css');
  assert.match(css, /@keyframes float/);
  assert.match(css, /@keyframes pulse-ring/);
  assert.match(css, /\.dark\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.js \[data-reveal\]/);
});
