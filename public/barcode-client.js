// Live barcode scanning with the browser's built-in BarcodeDetector (Chrome and Edge on Android and desktop).
// Where it is missing (Safari, Firefox) the dialog still works: type the code or a DIN and look it up.
// A scanned 8-digit code is tried as a Canadian DIN first, then as an ordinary barcode.
export const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'];
const SCAN_INTERVAL_MS = 300;

// A barcode is 8 to 14 digits. "DIN 02241234" (6 to 8 digits after DIN) is a Canadian Drug Identification Number.
export const cleanBarcode = value => {
  const text = String(value ?? '').trim();
  const din = /^din[\s:-]*(\d[\d\s-]*)$/i.exec(text);
  if (din) {
    const digits = din[1].replace(/[\s-]/g, '');
    return /^\d{6,8}$/.test(digits) ? `DIN${digits.padStart(8, '0')}` : null;
  }
  const digits = text.replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(digits) ? digits : null;
};

export function bindBarcodeScan({ document, api, onResult, getMediaDevices = () => globalThis.navigator?.mediaDevices, DetectorClass = globalThis.BarcodeDetector, toast, schedule = (fn, ms) => setInterval(fn, ms), cancel = id => clearInterval(id) }) {
  const $ = id => document.querySelector(`#${id}`);
  const dialog = $('scanModal'), video = $('scanVideo'), status = $('scanStatus'), manual = $('scanManual');
  let stream = null, timer = null, busy = false, session = 0;
  const say = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };

  function stop() {
    session += 1;
    if (timer !== null) { cancel(timer); timer = null; }
    stream?.getTracks?.().forEach(track => track.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  async function lookup(rawCode) {
    const code = cleanBarcode(rawCode);
    if (!code) { say('Enter a barcode of 8 to 14 digits, or a DIN like DIN 02241234.', true); return; }
    if (busy) return;
    busy = true; stop(); say('Looking it up…');
    let result;
    try { result = await api(`/api/barcode?code=${encodeURIComponent(code)}`); } catch { result = { code, found: false, offline: true }; }
    busy = false;
    dialog.close();
    onResult(result);
  }

  async function start() {
    const mySession = session;
    if (typeof DetectorClass !== 'function' || !getMediaDevices()?.getUserMedia) { say('Live scanning is not available in this browser. Type the barcode below.'); return; }
    try {
      const detector = new DetectorClass({ formats: SCAN_FORMATS });
      const media = await getMediaDevices().getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (mySession !== session || !dialog.open) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media; video.srcObject = media; await video.play?.();
      say('Point the camera at the barcode.');
      let scanning = false;
      timer = schedule(async () => {
        if (scanning || busy) return;
        scanning = true;
        try {
          const codes = await detector.detect(video);
          const code = codes.map(item => cleanBarcode(item.rawValue)).find(Boolean);
          if (code) await lookup(code);
        } catch { /* a frame that cannot be read is skipped */ } finally { scanning = false; }
      }, SCAN_INTERVAL_MS);
    } catch (error) {
      say(error?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser, or type the barcode below.' : 'The camera could not start. Type the barcode below.', true);
    }
  }

  function open() {
    manual.value = ''; say('Starting the camera…');
    if (!dialog.open) dialog.showModal();
    start();
  }

  dialog.addEventListener('close', stop);
  $('scanManualForm').addEventListener('submit', event => { event.preventDefault(); lookup(manual.value); });
  for (const button of document.querySelectorAll('.scan-barcode-trigger')) button.addEventListener('click', open);

  return { open, stop };
}
