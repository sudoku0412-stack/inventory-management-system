import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const NAME = 'Inventory Management System';

test('the app is named the Inventory Management System wherever users see a product name', () => {
  const page = read('public/index.html');
  assert.match(page, new RegExp(`<title>${NAME}</title>`));
  assert.match(page, new RegExp(`<span>${NAME}</span>`));
  assert.match(read('public/admin/index.html'), new RegExp(`<title>Admin · ${NAME}</title>`));
  assert.match(read('public/sw.js'), /Open the Inventory Management System/);
  assert.match(read('wrangler.toml'), new RegExp(`EMAIL_FROM = "${NAME} <`));
  assert.match(read('README.md'), new RegExp(`^# ${NAME}`));
});

test('no user-facing file still calls the product a medicine tracker', () => {
  for (const path of ['public/index.html', 'public/admin/index.html', 'public/sw.js', 'lib/email-outbox.js', 'server.js', 'README.md']) {
    assert.doesNotMatch(read(path), /Medicine Inventory(?! Tracker architecture)|Medicine Tracker/, path);
  }
});

test('emails name the product and no longer say weekly medicine check', () => {
  const emails = read('lib/email-outbox.js');
  assert.match(emails, new RegExp(`on the ${NAME}`));
  assert.match(emails, /weekly inventory check/);
  assert.doesNotMatch(emails, /weekly medicine check/);
});
