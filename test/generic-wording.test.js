import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Visible text of the page, without ids, classes and the two places where "Medicine" is real data:
// the Shop type choice and the default "Medicine cabinet" storage location.
function visibleText(html) {
  const withoutOptions = html.replace(/<option\b[^>]*>[^<]*<\/option>/g, '');
  const text = [...withoutOptions.matchAll(/>([^<>]+)</g)].map(match => match[1]);
  const attributes = [...withoutOptions.matchAll(/(?:placeholder|aria-label|title|content|alt)="([^"]*)"/g)].map(match => match[1]);
  return [...text, ...attributes].join('\n');
}

test('the page text is generic: items, not medicines', () => {
  assert.doesNotMatch(visibleText(read('public/index.html')), /medicine/i);
});

test('key labels read as items', () => {
  const html = read('public/index.html');
  for (const label of ['Add item', 'Total items', 'Item name', 'Item details', 'No items found', 'Search items']) assert.ok(html.includes(label), label);
});

test('messages in the app and the API say item', () => {
  const sources = ['public/app.js', 'public/inventory-export-client.js', 'public/admin/admin.js', 'lib/export.js', 'lib/store-d1.js'].map(read).join('\n');
  for (const old of ['Add medicine', 'Edit medicine', 'No expired medicines', 'Enter a medicine name', 'This medicine was changed', 'every medicine,']) assert.ok(!sources.includes(old), old);
  assert.ok(read('public/app.js').includes("'Add item'") && read('public/app.js').includes("'Edit item'"));
});

test('the Shop type choice keeps its Medicine label', () => {
  assert.match(read('public/index.html'), /<option value="medicine"[^>]*>Medicine<\/option>/);
});
