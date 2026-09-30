// Barcode reading for browsers without the built-in BarcodeDetector (Safari, Firefox). It wraps the vendored
// zxing-wasm reader (MIT; zxing-cpp compiled to WebAssembly, in public/vendor/) behind the same
// `new Detector({ formats }).detect(video)` shape. It reads UPC-E, which the plain JavaScript ZXing could not.
const FORMAT_NAMES = { ean_13: 'EAN-13', ean_8: 'EAN-8', upc_a: 'UPC-A', upc_e: 'UPC-E', code_128: 'Code128', itf: 'ITF' };
const MAX_WIDTH = 1280;
export const ZXING_SCRIPT = '/vendor/zxing-reader.iife.js';
export const ZXING_WASM = '/vendor/zxing_reader.wasm';

export function loadZxing(doc = document, src = ZXING_SCRIPT, win = globalThis) {
  if (win.ZXingWASM) return Promise.resolve(win.ZXingWASM);
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = src;
    script.onload = () => win.ZXingWASM ? resolve(win.ZXingWASM) : reject(new Error('Scanner library did not load.'));
    script.onerror = () => reject(new Error('Scanner library could not be loaded.'));
    doc.head.append(script);
  });
}

export function createZxingDetectorClass(ZXingWASM, doc = document, { wasmUrl = ZXING_WASM, overrides = null } = {}) {
  ZXingWASM.setZXingModuleOverrides(overrides || { locateFile: (path, prefix) => path.endsWith('.wasm') ? wasmUrl : prefix + path });
  return class ZxingDetector {
    constructor({ formats = Object.keys(FORMAT_NAMES) } = {}) {
      this.formats = formats.map(name => FORMAT_NAMES[name]).filter(Boolean);
      this.canvas = doc.createElement('canvas');
    }

    async detect(video) {
      const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
      if (!sourceWidth || !sourceHeight) return [];
      const scale = Math.min(1, MAX_WIDTH / sourceWidth);
      const width = Math.round(sourceWidth * scale), height = Math.round(sourceHeight * scale);
      this.canvas.width = width; this.canvas.height = height;
      const context = this.canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, width, height);
      const results = await ZXingWASM.readBarcodes(context.getImageData(0, 0, width, height), { formats: this.formats, tryHarder: true, maxNumberOfSymbols: 1 });
      return results.filter(result => result.isValid && result.text).map(result => ({ rawValue: result.text, format: result.format }));
    }
  };
}

/** Loads the vendored library on first use and returns a Detector class. */
export async function loadZxingDetector(doc = document) {
  return createZxingDetectorClass(await loadZxing(doc), doc);
}
