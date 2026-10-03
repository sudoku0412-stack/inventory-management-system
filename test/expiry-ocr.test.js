import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseExpiry, repairDigits } from '../public/expiry-text.js';
import { bindExpiryScan, describeRead } from '../public/expiry-scan-client.js';
import { createOcrEngine, frameCanvas, loadTesseract } from '../public/ocr-engine.js';
import { publicAssetPaths } from '../lib/shared.js';
import { assetCacheControl } from '../worker/index.js';

const today = new Date('2026-10-03T00:00:00Z');
const read = text => parseExpiry(text, { today });
const dateOf = text => read(text)?.date ?? null;

test('reads the common label formats after an expiry word', () => {
  const cases = [
    ['EXP 03/2027', '2027-03-31'], ['Exp: 2027-03-31', '2027-03-31'], ['EXPIRY DATE 2027/03/05', '2027-03-05'],
    ['BEST BEFORE 31MAR2027', '2027-03-31'], ['USE BY MAR 2028', '2028-03-31'], ['Use by: 12 Mar 2028', '2028-03-12'],
    ['best before 12/27', '2027-12-31'], ['EXP 15/04/2027', '2027-04-15'], ['EXP 04/15/27', '2027-04-15'],
    ['EXP\n03 2027', '2027-03-31'], ['EXP. 2027-11-05', '2027-11-05'], ['EXP 2027-10-31', '2027-10-31'], ['EXP 2027/12/12', '2027-12-12'], ['EXP 31 OCT 2027', '2027-10-31'], ['EXP FEBRUARY 2028', '2028-02-29'], ['MEILLEUR AVANT 2027 MR 31', '2027-03-31']
  ];
  for (const [text, expected] of cases) assert.equal(dateOf(text), expected, text);
});

test('a month and year alone means the last day of that month', () => {
  assert.deepEqual([read('EXP 02/2027').date, read('EXP 02/2027').precision], ['2027-02-28', 'month']);
  assert.equal(read('EXP 02/2028').date, '2028-02-29', 'leap year');
  assert.equal(read('EXP 2027-03-31').precision, 'day');
});

test('repairs the characters OCR confuses inside numbers, and leaves words alone', () => {
  assert.equal(dateOf('EXP. O3/2O27'), '2027-03-31');
  assert.equal(dateOf('EXP 2O27-O3-I5'), '2027-03-15');
  assert.equal(repairDigits('exp 03/2027 oral'), 'EXP 03/2027 ORAL');
  assert.equal(repairDigits('BEST BEFORE'), 'BEST BEFORE');
});

test('ignores a manufacturing or lot date and picks the one after the expiry word', () => {
  assert.equal(dateOf('MFG 01/2024 EXP 12/2026'), '2026-12-31');
  assert.equal(dateOf('Lot A1234 MFG 2024-01-15 EXP 2027 JAN 30'), '2027-01-30');
  assert.equal(read('MFG 03/2025'), null);
  assert.equal(read('LOT 2027-03-31'), null);
});

test('without a keyword the latest plausible date is a guess, flagged as unlabeled', () => {
  const guess = read('Paracetamol 500 mg 24 tablets 03/2027');
  assert.deepEqual([guess.date, guess.confidence], ['2027-03-31', 'unlabeled']);
  assert.equal(read('EXP 03/2027').confidence, 'labeled');
  assert.equal(read('01/2025 05/2027').date, '2027-05-31');
});

test('flags a day and month that could be the other way round', () => {
  const both = read('EXP 05/06/2027');
  assert.deepEqual([both.date, both.ambiguous], ['2027-06-05', true], 'day first');
  assert.equal(read('EXP 15/04/2027').ambiguous, false);
  assert.equal(read('EXP 04/15/2027').ambiguous, false);
  assert.equal(read('EXP 05/05/2027').ambiguous, false);
});

test('rejects noise, impossible dates and dates far outside the plausible range', () => {
  for (const text of ['', 'junk', 'tablets 500 mg', 'EXP 31/02/2027', 'EXP 13/2027', 'EXP 03/1999', 'EXP 2099-01-01', null, undefined]) assert.equal(read(text), null, String(text));
});

test('expiry words are matched as words, so a name containing exp is not a label', () => {
  assert.equal(read('EXPERT FORMULA 2027-03-31').confidence, 'unlabeled');
});

test('describeRead tells the person what was read and to check it', () => {
  assert.match(describeRead({ raw: '03/2027', date: '2027-03-31', precision: 'month', ambiguous: false }), /Read “03\/2027” as 2027-03-31 \(end of that month\)\. Check it before saving\./);
  assert.match(describeRead({ raw: '05/06/2027', date: '2027-06-05', precision: 'day', ambiguous: true }), /other way round/);
});

function scanFixture({ texts = [], media = true, loadEngine, camera } = {}) {
  const listeners = new Map();
  const node = (extra = {}) => ({ textContent: '', classList: { toggle() {} }, addEventListener: (name, fn) => listeners.set(`${extra.id}:${name}`, fn), ...extra });
  const dialog = node({ id: 'dialog', open: false, showModal() { this.open = true; }, close() { this.open = false; listeners.get('dialog:close')?.(); } });
  const video = node({ id: 'video', srcObject: null, play: async () => {} });
  const nodes = { expiryScanModal: dialog, expiryScanVideo: video, expiryScanStatus: node({ id: 'status' }) };
  const triggers = [node({ id: 'trigger' })];
  const document = { querySelector: selector => nodes[selector.slice(1)], querySelectorAll: () => triggers };
  const stopped = [], terminated = [], results = [], ticks = [];
  const engine = { read: async () => texts.length ? texts.shift() : '', terminate: () => terminated.push(1) };
  const stream = { getTracks: () => [{ stop: () => stopped.push(1) }] };
  const scan = bindExpiryScan({
    document, onResult: result => results.push(result), loadEngine: loadEngine || (async () => engine),
    getMediaDevices: () => media ? { getUserMedia: camera || (async () => stream) } : undefined,
    schedule: fn => { ticks.push(fn); return ticks.length; }, cancel: () => {}
  });
  return { scan, nodes, listeners, results, ticks, stopped, terminated, click: () => listeners.get('trigger:click')() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('live scan: the same labeled date in two frames fills the result, stops the camera and the reader', async () => {
  const f = scanFixture({ texts: ['nothing here', 'EXP 03/2027', 'EXP 03/2027'] });
  f.click();
  await settle();
  assert.equal(f.nodes.expiryScanModal.open, true);
  await f.ticks[0](); assert.equal(f.results.length, 0, 'no date in the first frame');
  await f.ticks[0](); assert.equal(f.results.length, 0, 'one sighting is not enough');
  assert.match(f.nodes.expiryScanStatus.textContent, /Hold steady/);
  await f.ticks[0]();
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].date, '2027-03-31');
  assert.equal(f.nodes.expiryScanModal.open, false);
  assert.ok(f.stopped.length >= 1, 'camera tracks stopped');
  await settle();
  assert.ok(f.terminated.length >= 1, 'reader stopped');
});

test('live scan: a changing date restarts the count, and an unlabeled guess needs three matching frames', async () => {
  const f = scanFixture({ texts: ['EXP 03/2027', 'EXP 04/2027', 'EXP 04/2027'] });
  f.click(); await settle();
  for (let i = 0; i < 2; i += 1) await f.ticks[0]();
  assert.equal(f.results.length, 0, 'a different date resets the streak');
  await f.ticks[0]();
  assert.equal(f.results[0].date, '2027-04-30');

  const g = scanFixture({ texts: ['tablets 03/2027', 'tablets 03/2027', 'tablets 03/2027'] });
  g.click(); await settle();
  await g.ticks[0](); await g.ticks[0]();
  assert.equal(g.results.length, 0, 'two frames of a guess are not enough');
  await g.ticks[0]();
  assert.equal(g.results[0].confidence, 'unlabeled');
});

test('live scan: a frame that cannot be read is skipped and later frames still work', async () => {
  let calls = 0;
  const f = scanFixture({ loadEngine: async () => ({ read: async () => { calls += 1; if (calls === 1) throw new Error('bad frame'); return 'EXP 03/2027'; }, terminate() {} }) });
  f.click(); await settle();
  await f.ticks[0](); await f.ticks[0](); await f.ticks[0]();
  assert.equal(f.results.length, 1);
});

test('live scan: with no camera, or a blocked camera, the person is told to type the date', async () => {
  const none = scanFixture({ media: false });
  none.click(); await settle();
  assert.match(none.nodes.expiryScanStatus.textContent, /Type the date/);
  assert.equal(none.ticks.length, 0);

  const blocked = scanFixture({ camera: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); } });
  blocked.click(); await settle();
  assert.match(blocked.nodes.expiryScanStatus.textContent, /Camera access was blocked/);
  assert.equal(blocked.ticks.length, 0);
});

test('live scan: a reader that fails to load shows a message instead of throwing', async () => {
  const f = scanFixture({ loadEngine: async () => { throw new Error('offline'); } });
  f.click(); await settle();
  assert.match(f.nodes.expiryScanStatus.textContent, /could not start/);
  assert.equal(f.ticks.length, 0);
});

test('closing the dialog while the reader is still loading stops the camera and the reader', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = scanFixture({ loadEngine: async () => { await gate; return { read: async () => '', terminate: () => f.terminated.push(1) }; } });
  f.click(); await settle();
  f.nodes.expiryScanModal.close();
  release(); await settle(); await settle();
  assert.equal(f.ticks.length, 0, 'scanning never starts');
  assert.ok(f.terminated.length >= 1, 'late reader is shut down');
});

test('readPhoto reads one photo, returns the parsed date or null, and always shuts the reader down', async () => {
  const f = scanFixture({ texts: ['EXP 2027-03-31', 'nothing'] });
  assert.equal((await f.scan.readPhoto('data:image/jpeg;base64,AAAA')).date, '2027-03-31');
  assert.equal(await f.scan.readPhoto('data:image/jpeg;base64,AAAA'), null);
  assert.equal(f.terminated.length, 2, 'the reader is shut down after every photo');
  const g = scanFixture({ loadEngine: async () => { throw new Error('no reader'); } });
  assert.equal(await g.scan.readPhoto('data:image/jpeg;base64,AAAA'), null);
});

test('loadTesseract uses an already loaded reader, loads the vendored script once, and reports a failed load', async () => {
  const loaded = {};
  assert.equal(await loadTesseract({}, { Tesseract: loaded }), loaded);
  const appended = [];
  const win = {};
  const doc = { createElement: () => ({}), head: { append: script => { appended.push(script); win.Tesseract = loaded; script.onload(); } } };
  assert.equal(await loadTesseract(doc, win), loaded);
  assert.equal(appended[0].src, '/vendor/tesseract/tesseract.min.js');
  const failing = { createElement: () => ({}), head: { append: script => script.onerror() } };
  await assert.rejects(loadTesseract(failing, {}), /could not be loaded/);
});

test('the reader runs from this site only and reads text from frames, canvases and photos', async () => {
  const calls = {};
  const worker = { setParameters: async params => { calls.params = params; }, recognize: async image => { calls.image = image; return { data: { text: 'EXP 03/2027' } }; }, terminate: async () => { calls.terminated = true; } };
  const win = { Tesseract: { createWorker: async (lang, oem, options) => { Object.assign(calls, { lang, oem, options }); return worker; } } };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => { calls.draw = args; } }) };
  const doc = { createElement: () => canvas };
  const engine = await createOcrEngine({ doc, win });
  assert.deepEqual([calls.lang, calls.oem], ['eng', 1]);
  assert.deepEqual([calls.options.workerPath, calls.options.corePath, calls.options.langPath], ['/vendor/tesseract/worker.min.js', '/vendor/tesseract/', '/vendor/tesseract/']);
  assert.equal(calls.options.workerBlobURL, false);
  assert.equal(calls.params.tessedit_pageseg_mode, '11');
  assert.equal(await engine.read('data:image/jpeg;base64,AAAA'), 'EXP 03/2027');
  assert.equal(calls.image, 'data:image/jpeg;base64,AAAA');
  assert.equal(await engine.read({ videoWidth: 0, videoHeight: 0 }), '', 'a camera that has not started gives no text');
  await engine.read({ videoWidth: 2560, videoHeight: 1440 });
  assert.deepEqual([canvas.width, canvas.height], [1280, 720], 'frames are scaled down');
  assert.equal(frameCanvas({ videoWidth: 640, videoHeight: 480 }, doc).width, 640, 'small frames are not enlarged');
  await engine.terminate();
  assert.equal(calls.terminated, true);
});

test('every file the reader needs is vendored, served by the Worker and the local server, and revalidated', () => {
  const files = ['tesseract.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js', 'eng.traineddata.gz'];
  for (const file of files) {
    assert.ok(existsSync(new URL(`../public/vendor/tesseract/${file}`, import.meta.url)), `${file} is vendored`);
    assert.ok(publicAssetPaths.has(`/vendor/tesseract/${file}`), `${file} must be allowed or the Worker returns 404`);
    assert.equal(assetCacheControl(`/vendor/tesseract/${file}`), 'no-cache, must-revalidate');
  }
  assert.ok(existsSync(new URL('../public/vendor/tesseract/TESSERACT-LICENSE.txt', import.meta.url)));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['expiryScanModal', 'expiryScanVideo', 'expiryScanStatus']) assert.match(html, new RegExp(`id="${id}"`));
  const from = html.indexOf('expiry-field'), to = html.indexOf('id="expiryUnknown"');
  assert.ok(from > 0 && html.slice(from, to).includes('scan-expiry-trigger'), 'Scan with camera sits in the expiry field of the add item form');
});
