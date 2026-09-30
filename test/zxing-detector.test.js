import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createZxingDetectorClass, loadZxing } from '../public/zxing-detector.js';
import { bindBarcodeScan, SCAN_FORMATS } from '../public/barcode-client.js';

// The vendored reader is a browser bundle; run it the way a page would and feed it the WebAssembly bytes directly.
const sandbox = { TextDecoder, TextEncoder, URL, console, setTimeout, clearTimeout, queueMicrotask };
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${readFileSync(new URL('../public/vendor/zxing-reader.iife.js', import.meta.url), 'utf8')};globalThis.ZXingWASM = ZXingWASM;`, sandbox);
const ZXing = sandbox.ZXingWASM;
const overrides = { wasmBinary: readFileSync(new URL('../public/vendor/zxing_reader.wasm', import.meta.url)) };

// Build barcode modules here (standard L/G/R digit patterns); the reader library only decodes.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map(code => [...code].map(bit => bit === '1' ? '0' : '1').join(''));
const G = R.map(code => [...code].reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const UPCE_PARITY = { 4: 'GLGGLL' };
function modules(digits) {
  const d = [...digits].map(Number);
  if (digits.startsWith('upce:')) { const six = [...digits.slice(5)].map(Number); return `101${six.map((n, i) => (UPCE_PARITY[4][i] === 'L' ? L : G)[n]).join('')}010101`; }
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
  const context = { drawImage() {}, getImageData: (x, y, width, height) => ({ data: image.data, width, height, colorSpace: 'srgb' }) };
  return { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
}

for (const [text, name, rawValue] of [['3017620422003', 'EAN-13', '3017620422003'], ['96385074', 'EAN-8', '96385074'], ['0036000291452', 'UPC-A (reported in its 13-digit form)', '0036000291452'], ['upce:552550', 'UPC-E (reported in its 13-digit form)', '0055000002554']]) {
  test(`the fallback reads a ${name} barcode`, async () => {
    const image = frame(text);
    const Detector = createZxingDetectorClass(ZXing, fakeDocument(image), { overrides });
    const found = await new Detector({ formats: SCAN_FORMATS }).detect({ videoWidth: image.width, videoHeight: image.height });
    assert.deepEqual(Array.from(found, item => item.rawValue), [rawValue]);
  });
}

test('the fallback returns nothing for a blank frame or a missing video size', async () => {
  const blank = { data: new Uint8ClampedArray(200 * 100 * 4).fill(255), width: 200, height: 100 };
  const Detector = createZxingDetectorClass(ZXing, fakeDocument(blank), { overrides });
  assert.deepEqual(Array.from(await new Detector().detect({ videoWidth: 200, videoHeight: 100 })), []);
  assert.deepEqual(await new Detector().detect({ videoWidth: 0, videoHeight: 0 }), []);
});

test('loadZxing reuses the loaded library and reports a load failure', async () => {
  assert.equal(await loadZxing({}, '/x.js', { ZXingWASM: ZXing }), ZXing);
  const appended = [];
  const doc = { createElement: () => ({}), head: { append: script => { appended.push(script); script.onerror(); } } };
  await assert.rejects(loadZxing(doc, '/vendor/zxing-reader.iife.js', {}), /could not be loaded/);
  assert.equal(appended[0].src, '/vendor/zxing-reader.iife.js');
  const loads = { createElement: () => ({}), head: { append: script => { win.ZXingWASM = ZXing; script.onload(); } } };
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

test('the native detector is asked which formats it supports, so an unsupported one cannot break the scan', async () => {
  const seen = [];
  class Native { static async getSupportedFormats() { return ['ean_13', 'upc_e', 'code_128']; } constructor(options) { seen.push(options.formats); } async detect() { return []; } }
  const f = scanSetup({ DetectorClass: Native });
  f.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [['ean_13', 'upc_e', 'code_128']]);
  assert.equal(f.ticks.length, 1);
});

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
