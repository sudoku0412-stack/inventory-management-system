import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('medicine dialog resets its own scroll position and focuses without moving the viewport', () => {
  assert.match(app, /function openMedicineModal\(focusName=true\)\{const m=qs\('#addMedicineModal'\);m\.showModal\(\);m\.scrollTop=0;requestAnimationFrame\(\(\)=>\{m\.scrollTop=0;if\(focusName\)qs\('#medicineName'\)\.focus\(\{preventScroll:true\}\)\}\)\}/);
  assert.match(app, /async function add\(\)[\s\S]*?openMedicineModal\(\)/);
  assert.match(app, /function edit\(\)[\s\S]*?qs\('#batchModal'\)\.close\(\);openMedicineModal\(\)/);
});

test('mobile dialogs stay bottom-anchored to the dynamic viewport and contain scroll changes', () => {
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.modal \{ position: fixed; inset: auto 0 0;[\s\S]*?max-height: calc\(100dvh - env\(safe-area-inset-top, 0px\)\);[\s\S]*?margin: 0; overflow-anchor: none; overscroll-behavior: contain;/);
});

test('medicine form keeps a compact accessible expiry date and unknown-expiry choice', () => {
  assert.match(page, /<div class="form-field expiry-field">\s*<div class="expiry-label-row"><label for="expiryDate">Expiry date<\/label><button class="text-button scan-expiry-trigger" type="button">Scan with camera<\/button><\/div>\s*<input id="expiryDate" class="expiry-date-input" name="expiry" type="date" autocomplete="off" aria-describedby="expiryDateHelp" \/>\s*<label class="expiry-unknown" for="expiryUnknown"><input id="expiryUnknown" name="expiry_unknown" type="checkbox" \/><span>I don’t know the expiry date<\/span><\/label>\s*<small id="expiryDateHelp">Choose this when the package does not show an expiry date.<\/small>/);
  assert.match(styles, /\.expiry-unknown input\[type="checkbox"\] \{ width: 18px; height: 18px; flex: none;/);
  assert.match(styles, /\.expiry-date-input \{[\s\S]*?appearance: none;[\s\S]*?-webkit-appearance: none;[\s\S]*?box-sizing: border-box;[\s\S]*?block-size: 44px;[\s\S]*?min-block-size: 44px;[\s\S]*?max-block-size: 44px;[\s\S]*?height: 44px;[\s\S]*?min-height: 44px;[\s\S]*?max-height: 44px;/);
  assert.match(styles, /\.expiry-date-input::\-webkit-calendar-picker-indicator \{ display: none; -webkit-appearance: none; \}/);
  assert.match(styles, /\.expiry-field \.expiry-date-input \{ padding-right: 40px; background-image: url\("data:image\/svg\+xml[^}]*background-repeat: no-repeat; background-position: right 12px center;/);
  assert.match(styles, /\.expiry-field \.expiry-date-input:disabled \{ background-image: url\("data:image\/svg\+xml/);
  assert.match(styles, /\.expiry-field input\[type="date"\]:disabled \{ background-color: #f2f5f4;/);
});

test('tapping a field in the Edit dialog never reopens the batch details', () => {
  // The edit form carries data-batch-id, so the page-wide row click handler must skip forms.
  assert.match(app, /f\.dataset\.batchId=b\.id/);
  assert.match(app, /closest\('\[data-batch-id\]:not\(form\)'\);if\(b\)batch\(b\.dataset\.batchId\)/);
  assert.doesNotMatch(app, /closest\('\[data-batch-id\]'\);if\(b\)batch\(/);
});

test('the Restock list button is spaced from the cards above it, centered, and full width on phones', () => {
  assert.match(styles, /\.restock-open \{ display: flex; align-items: center; justify-content: center; gap: 8px; margin: 16px 0 18px; \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{ \.restock-open \{ width: 100%; \} \}/);
});

test('Inventory header actions are themed and sit in an even grid on phones', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="button secondary action-lists"/);
  assert.match(html, /class="button secondary action-scan scan-barcode-trigger"/);
  assert.match(css, /\.button\.action-scan \{[^}]*background: var\(--mint\)/);
  assert.match(css, /\.inventory-heading \.header-actions \{ display: grid; grid-template-columns: 1fr 1fr/);
  assert.match(css, /\.add-medicine-trigger \{ grid-column: 1 \/ -1; order: -1/);
});
