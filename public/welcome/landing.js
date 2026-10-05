// Motion for the welcome page: fade-up reveals, the stock board demo, floating cards, the sticky header and the theme switch.
// It only adds classes and sets CSS custom properties, so it works under the strict CSP (no inline styles or scripts).
export const BOARD_WIDTH = 760;
export const BOARD_COLUMNS = 5;
const BOARD_HEIGHT = 392;
const HOLD_STEP_MS = 1500;
const HOLD_LAST_MS = 3400;

/** The board is drawn at 760px wide and scaled down to fit narrow screens. */
export const boardScale = width => Math.max(0.3, Math.min(1, width / BOARD_WIDTH));
/** The demo item moves one column every 1.5 seconds, rests on the last one for 3.4 seconds, then starts again. */
export const nextStage = stage => stage >= BOARD_COLUMNS - 1 ? 0 : stage + 1;
export const stageDelay = stage => stage >= BOARD_COLUMNS - 1 ? HOLD_LAST_MS : HOLD_STEP_MS;

export function bindReveal({ document, IntersectionObserverClass = globalThis.IntersectionObserver, reduceMotion = false }) {
  const items = [...document.querySelectorAll('[data-reveal]')];
  for (const item of items) {
    item.style.setProperty('--y', `${item.dataset.y || 24}px`);
    item.style.setProperty('--d', `${item.dataset.delay || 0}s`);
  }
  if (reduceMotion || typeof IntersectionObserverClass !== 'function') { items.forEach(item => item.classList.add('in')); return { items }; }
  const observer = new IntersectionObserverClass(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
  }, { rootMargin: '0px 0px -80px 0px' });
  items.forEach(item => observer.observe(item));
  return { items, observer };
}

export function bindBoard({ document, reduceMotion = false, ResizeObserverClass = globalThis.ResizeObserver, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  const wrap = document.querySelector('[data-board]'), mover = document.querySelector('[data-board-mover]');
  if (!wrap || !mover) return null;
  const chip = mover.querySelector('[data-board-chip]');
  let stage = reduceMotion ? BOARD_COLUMNS - 1 : 0, timer = null;

  function paint() {
    const done = stage === BOARD_COLUMNS - 1;
    mover.style.setProperty('left', `${stage * 100 / BOARD_COLUMNS}%`);
    mover.classList.toggle('done', done);
    if (chip) chip.textContent = done ? chip.dataset.done : chip.dataset.open;
  }
  function tick() {
    stage = nextStage(stage);
    paint();
    timer = setTimer(tick, stageDelay(stage));
  }
  function fit() {
    const scale = boardScale(wrap.clientWidth || BOARD_WIDTH);
    wrap.style.setProperty('--s', String(scale));
    wrap.style.setProperty('height', `${Math.round(BOARD_HEIGHT * scale)}px`);
  }
  fit();
  if (typeof ResizeObserverClass === 'function') new ResizeObserverClass(fit).observe(wrap);
  paint();
  if (!reduceMotion) timer = setTimer(tick, stageDelay(stage));
  return { stop() { if (timer !== null) clearTimer(timer); timer = null; }, get stage() { return stage; } };
}

/** Lights each stage pill in turn, like the demo item moving through the board. */
export function bindPills({ document, reduceMotion = false, setTimer = (fn, ms) => setInterval(fn, ms) }) {
  const pills = [...document.querySelectorAll('[data-pill]')];
  if (!pills.length) return null;
  let at = 0;
  const show = () => pills.forEach((pill, index) => pill.classList.toggle('on', index === at));
  show();
  if (reduceMotion) return { pills };
  setTimer(() => { at = (at + 1) % pills.length; show(); }, 1400);
  return { pills };
}

export function bindHeader({ window, document }) {
  const header = document.querySelector('[data-header]');
  if (!header) return;
  const update = () => header.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', update, { passive: true });
  update();
}

export function bindThemeToggle({ document, storage = globalThis.localStorage }) {
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  const root = document.documentElement;
  const sync = () => {
    const dark = root.classList.contains('dark');
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  };
  button.addEventListener('click', () => {
    const dark = root.classList.toggle('dark');
    try { storage?.setItem('welcome-theme', dark ? 'dark' : 'light'); } catch { /* the choice just is not remembered */ }
    sync();
  });
  sync();
}

export function startLanding(env = {}) {
  const document = env.document || globalThis.document, window = env.window || globalThis.window;
  const reduceMotion = env.reduceMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  bindHeader({ window, document });
  bindThemeToggle({ document });
  bindReveal({ document, reduceMotion });
  bindBoard({ document, reduceMotion });
  bindPills({ document, reduceMotion });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__LANDING_TEST__) startLanding();
