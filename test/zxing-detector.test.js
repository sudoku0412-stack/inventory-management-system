import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createZxingDetectorClass, loadZxing } from '../public/zxing-detector.js';
import { bindBarcodeScan, SCAN_FORMATS } from '../public/barcode-client.js';

// The vendored file is a browser UMD bundle; run it the way a page would and read the global it defines.
const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(readFileSync(new URL('../public/vendor/zxing-library.min.js', import.meta.url), 'utf8'), sandbox);
const { ZXing } = sandbox;

// The library has no 1D encoders, so build EAN modules here (standard L/G/R digit patterns).
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map(code => [...code].map(bit => bit === '1' ? '0' : '1').join(''));
const G = R.map(code => [...code].reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function modules(digits) {
  const d = [...digits].map(Number);
  if (d.length === 8) return `101${d.slice(0, 4).map(n => L[n]).join('')}01010${d.slice(4).map(n => R[n]).join('')}101`;
  const left = d.slice(1, 7).map((n, i) => (PARITY[d[0]][i] === 'L' ? L : G)[n]).join('');
  return `101${left}01010${d.slice(7).map(n => R[n]).join('')}101`;
}

// Renders the modules into RGBA pixels the way a canvas would hand them back.
function frame(text, scale = 4, margin = 40) {
  const bits = modules(text), width = bits.length * scale + margin * 2, height = 140;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 20; y < height - 20; y += 1) for (let x = 0; x < bits.length; x += 1) {
    if (bits[x] !== '1') continue;
    for (let dx = 0; dx < scale; dx += 1) { const p = (y * width + margin + x * scale + dx) * 4; data[p] = data[p + 1] = data[p + 2] = 0; }
  }
  return { data, width, height };
}

function fakeDocument(image) {
  const context = { drawImage() {}, getImageData: () => ({ data: image.data }) };
  return { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
}

for (const [text, name, rawValue] of [['3017620422003', 'EAN-13', '3017620422003'], ['96385074', 'EAN-8', '96385074'], ['0036000291452', 'UPC-A', '036000291452']]) {
  test(`the fallback reads a ${name} barcode`, async () => {
    const image = frame(text);
    const Detector = createZxingDetectorClass(ZXing, fakeDocument(image));
    const found = await new Detector({ formats: SCAN_FORMATS }).detect({ videoWidth: image.width, videoHeight: image.height });
    assert.deepEqual(found, [{ rawValue }]);
  });
}

test('the fallback returns nothing for a blank frame or a missing video size', async () => {
  const blank = { data: new Uint8ClampedArray(200 * 100 * 4).fill(255), width: 200, height: 100 };
  const Detector = createZxingDetectorClass(ZXing, fakeDocument(blank));
  assert.deepEqual(await new Detector().detect({ videoWidth: 200, videoHeight: 100 }), []);
  assert.deepEqual(await new Detector().detect({ videoWidth: 0, videoHeight: 0 }), []);
});

test('loadZxing reuses the loaded library and reports a load failure', async () => {
  assert.equal(await loadZxing({}, '/x.js', { ZXing }), ZXing);
  const appended = [];
  const doc = { createElement: () => ({}), head: { append: script => { appended.push(script); script.onerror(); } } };
  await assert.rejects(loadZxing(doc, '/vendor/zxing-library.min.js', {}), /could not be loaded/);
  assert.equal(appended[0].src, '/vendor/zxing-library.min.js');
  const loads = { createElement: () => ({}), head: { append: script => { win.ZXing = ZXing; script.onload(); } } };
  const win = {};
  assert.equal(await loadZxing(loads, '/x.js', win), ZXing);
});

function scanSetup({ loadFallback, DetectorClass } = {}) {
  const listeners = new Map();
  const node = (id, extra = {}) => ({ textContent: '', value: '', classList: { toggle() {} }, addEventListener: (name, fn) => listeners.set(`${id}:${name}`, fn), ...extra });
  const dialog = node('dialog', { open: false, showModal() { this.open = true; }, close() { this.open = false; listeners.get('dialog:close')?.(); } });
  const nodes = { scanModal: dialog, scanVideo: node('video', { play: async () => {} }), scanStatus: node('status'), scanManual: node('manual'), scanManualForm: node('form') };
  const trigger = node('trigger');
  const ticks = [], results = [];
  bindBarcodeScan({
    document: { querySelector: selector => nodes[selector.slice(1)], querySelectorAll: () => [trigger] },
    api: async path => ({ code: path.split('=')[1], found: false }), onResult: result => results.push(result),
    getMediaDevices: () => ({ getUserMedia: async () => ({ getTracks: () => [] }) }),
    DetectorClass, loadFallback, schedule: fn => { ticks.push(fn); return ticks.length; }, cancel() {}
  });
  return { nodes, ticks, results, click: () => listeners.get('trigger:click')() };
}

test('without a native detector the scanner loads the fallback and scans with it', async () => {
  let loaded = 0;
  const f = scanSetup({ loadFallback: async () => { loaded += 1; return class { async detect() { return [{ rawValue: '3017620422003' }]; } }; } });
  f.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded, 1);
  await f.ticks[0]();
  assert.deepEqual(f.results, [{ code: '3017620422003', found: false }]);
});

test('the native detector is preferred, and a failing fallback leaves the typed box', async () => {
  let loaded = 0;
  const native = scanSetup({ DetectorClass: class { async detect() { return []; } }, loadFallback: async () => { loaded += 1; } });
  native.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded, 0);
  const broken = scanSetup({ loadFallback: async () => { throw new Error('offline'); } });
  broken.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(broken.nodes.scanStatus.textContent, /not available/);
  assert.equal(broken.ticks.length, 0);
});
