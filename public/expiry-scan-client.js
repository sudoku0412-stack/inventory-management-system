// Reads an expiry date from the camera (live) or from a photo that is already on screen. Reading happens in the browser
// (see ocr-engine.js). The date is only suggested: the caller fills the field and the person confirms it before saving.
import { parseExpiry } from './expiry-text.js';

const FRAME_INTERVAL_MS = 900;
const HINT_AFTER_FRAMES = 14;
// A date next to EXP or BEST BEFORE needs two matching frames; a date with no keyword needs three.
const AGREE = { labeled: 2, unlabeled: 3 };

export const describeRead = ({ raw, date, precision, ambiguous }) =>
  `Read “${raw}” as ${date}${precision === 'month' ? ' (end of that month)' : ''}.${ambiguous ? ' Day and month could be the other way round.' : ''} Check it before saving.`;

export function bindExpiryScan({ document, getMediaDevices = () => globalThis.navigator?.mediaDevices, loadEngine, parse = parseExpiry, onResult, schedule = (fn, ms) => setInterval(fn, ms), cancel = id => clearInterval(id) }) {
  const $ = id => document.querySelector(`#${id}`);
  const dialog = $('expiryScanModal'), video = $('expiryScanVideo'), status = $('expiryScanStatus');
  let stream = null, timer = null, engine = null, session = 0;
  const say = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };

  function stop() {
    session += 1;
    if (timer !== null) { cancel(timer); timer = null; }
    stream?.getTracks?.().forEach(track => track.stop());
    stream = null;
    if (video) video.srcObject = null;
    const finished = engine; engine = null;
    Promise.resolve(finished).then(value => value?.terminate?.()).catch(() => {});
  }

  async function start() {
    const mine = session;
    if (!getMediaDevices()?.getUserMedia) { say('The camera is not available here. Type the date, or upload a photo.', true); return; }
    try {
      say('Loading the text reader. The first time this downloads about 7 MB…');
      engine = loadEngine();
      const reader = await engine;
      if (mine !== session || !dialog.open) return;
      engine = reader;
      const media = await getMediaDevices().getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (mine !== session || !dialog.open) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media; video.srcObject = media; await video.play?.();
      say('Point the camera at the expiry date and hold steady.');
      let streak = { date: null, count: 0 }, frames = 0, reading = false;
      timer = schedule(async () => {
        if (reading || mine !== session) return;
        reading = true;
        try {
          const found = parse(await reader.read(video));
          frames += 1;
          if (mine !== session) return;
          if (found) {
            streak = found.date === streak.date ? { date: found.date, count: streak.count + 1 } : { date: found.date, count: 1 };
            if (streak.count >= AGREE[found.confidence]) { stop(); dialog.close(); onResult(found); return; }
            say('Found a date. Hold steady to confirm it.');
          } else if (frames >= HINT_AFTER_FRAMES && frames % HINT_AFTER_FRAMES === 0) say('Still looking. Move closer, avoid glare, or type the date yourself.');
        } catch { /* a frame that cannot be read is skipped */ } finally { reading = false; }
      }, FRAME_INTERVAL_MS);
    } catch (error) {
      say(error?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser, or type the date.' : 'The text reader or camera could not start. Type the date instead.', true);
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    start();
  }

  /** Reads one photo (a data URL). Resolves to the parsed date or null; never throws. */
  async function readPhoto(photo) {
    let reader = null;
    try {
      reader = await loadEngine();
      return parse(await reader.read(photo));
    } catch { return null; } finally { reader?.terminate?.(); }
  }

  dialog.addEventListener('close', stop);
  for (const button of document.querySelectorAll('.scan-expiry-trigger')) button.addEventListener('click', open);
  return { open, stop, readPhoto };
}
