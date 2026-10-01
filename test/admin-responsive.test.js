import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');

test('the admin page is built for phones: viewport tag, one-row scrolling tabs, no wrapped tab strip', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(css, /\.tabs \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
  assert.match(css, /\.tabs a \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.tabs \{[^}]*position: sticky;/);
});

test('on phones every table row becomes a labelled card instead of a squeezed column table', () => {
  assert.match(css, /@media \(max-width: 720px\)/);
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
  assert.match(phone, /table, tbody \{ display: block;/);
  assert.match(phone, /td::before \{ content: attr\(data-label\)/);
  assert.match(phone, /thead \{ position: absolute;/);
  assert.match(js, /el\('td', \{ 'data-label': column\.label \}\)/);
});

test('table headers stay readable for screen readers and wide screens keep a scrolling table wrapper', () => {
  assert.match(js, /el\('th', \{ scope: 'col' \}, column\.label\)/);
  assert.match(js, /class: 'scroll'/);
  assert.match(css, /\.scroll \{ overflow-x: auto;/);
  assert.match(css, /th \{ position: sticky;/);
});

test('the hidden attribute still wins, so Load more only shows when there is a next page', () => {
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(js, /more\.hidden = !next/);
});

test('controls are at least 44px tall and the header keeps Sign out on the first row', () => {
  assert.match(css, /button \{ min-height: 44px;/);
  assert.match(css, /\.signout \{ grid-column: 2; grid-row: 1;[^}]*min-height: 44px;/);
  assert.ok(html.indexOf('class="signout"') < html.indexOf('id="banner"'));
});

test('empty lists say so, and the active tab scrolls into view', () => {
  assert.match(js, /Nothing to show yet\./);
  assert.match(js, /link\.scrollIntoView\?\.\(\{ block: 'nearest', inline: 'center' \}\)/);
});

test('the admin notice no longer says medicine contents', () => {
  assert.doesNotMatch(html, /medicine contents/);
});
