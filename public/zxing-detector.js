// Barcode reading for browsers without the built-in BarcodeDetector (Safari, Firefox). It wraps the vendored
// ZXing library (Apache-2.0, public/vendor/) behind the same `new Detector({ formats }).detect(video)` shape.
const FORMAT_NAMES = { ean_13: 'EAN_13', ean_8: 'EAN_8', upc_a: 'UPC_A', upc_e: 'UPC_E', code_128: 'CODE_128', itf: 'ITF' };
const MAX_WIDTH = 960;

export function loadZxing(doc = document, src = '/vendor/zxing-library.min.js', win = globalThis) {
  if (win.ZXing) return Promise.resolve(win.ZXing);
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = src;
    script.onload = () => win.ZXing ? resolve(win.ZXing) : reject(new Error('Scanner library did not load.'));
    script.onerror = () => reject(new Error('Scanner library could not be loaded.'));
    doc.head.append(script);
  });
}

export function createZxingDetectorClass(ZXing, doc = document) {
  return class ZxingDetector {
    constructor({ formats = Object.keys(FORMAT_NAMES) } = {}) {
      this.reader = new ZXing.MultiFormatReader();
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats.filter(name => FORMAT_NAMES[name]).map(name => ZXing.BarcodeFormat[FORMAT_NAMES[name]]));
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      this.reader.setHints(hints);
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
      const { data } = context.getImageData(0, 0, width, height);
      const luminance = new Uint8ClampedArray(width * height);
      for (let i = 0, p = 0; i < luminance.length; i += 1, p += 4) luminance[i] = (data[p] * 306 + data[p + 1] * 601 + data[p + 2] * 117) >> 10;
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(luminance, width, height)));
      try { return [{ rawValue: this.reader.decode(bitmap).getText() }]; } catch { return []; } finally { this.reader.reset(); }
    }
  };
}

/** Loads the vendored library on first use and returns a Detector class. */
export async function loadZxingDetector(doc = document) {
  return createZxingDetectorClass(await loadZxing(doc), doc);
}
