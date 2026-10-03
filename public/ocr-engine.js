// Free text reading in the browser: Tesseract.js (Apache-2.0) and its English model are vendored in public/vendor/tesseract/,
// so nothing is sent to a server and no key is needed. Everything loads on first use; the files are about 7 MB the first time.
export const OCR_DIR = '/vendor/tesseract/';
export const OCR_SCRIPT = `${OCR_DIR}tesseract.min.js`;
const MAX_WIDTH = 1280;
const WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/.:- ';

export function loadTesseract(doc = document, win = globalThis, src = OCR_SCRIPT) {
  if (win.Tesseract) return Promise.resolve(win.Tesseract);
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = src;
    script.onload = () => win.Tesseract ? resolve(win.Tesseract) : reject(new Error('Text reader did not load.'));
    script.onerror = () => reject(new Error('Text reader could not be loaded.'));
    doc.head.append(script);
  });
}

/** Copies the current camera frame, scaled down, so the reader works on a modest image. */
export function frameCanvas(video, doc = document) {
  const width = video.videoWidth, height = video.videoHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_WIDTH / width);
  const canvas = doc.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Starts a reader. `read(source)` takes a video element, canvas or image data URL and returns the text found. */
export async function createOcrEngine({ doc = document, win = globalThis, dir = OCR_DIR, script = `${dir}tesseract.min.js`, onProgress } = {}) {
  const Tesseract = await loadTesseract(doc, win, script);
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: `${dir}worker.min.js`, corePath: dir, langPath: dir, workerBlobURL: false, gzip: true,
    logger: message => onProgress?.(message)
  });
  await worker.setParameters({ tessedit_char_whitelist: WHITELIST, tessedit_pageseg_mode: '11' });
  return {
    async read(source) {
      const image = source && source.videoWidth !== undefined ? frameCanvas(source, doc) : source;
      if (!image) return '';
      const result = await worker.recognize(image);
      return result?.data?.text || '';
    },
    terminate: () => worker.terminate()
  };
}
