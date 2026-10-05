import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_COLUMNS, bindBoard, bindHeader, bindPills, bindReveal, bindThemeToggle, boardScale, nextStage, stageDelay } from '../public/welcome/landing.js';

const classes = () => { const set = new Set(); return { add: name => set.add(name), remove: name => set.delete(name), toggle: (name, on) => { (on ?? !set.has(name)) ? set.add(name) : set.delete(name); return set.has(name); }, contains: name => set.has(name), set }; };
const node = (extra = {}) => { const props = new Map(), attrs = new Map(), listeners = new Map(); return { classList: classes(), dataset: {}, textContent: '', style: { setProperty: (name, value) => props.set(name, value) }, props, attrs, listeners, setAttribute: (name, value) => attrs.set(name, value), addEventListener: (name, fn) => listeners.set(name, fn), ...extra }; };

test('the board scales down to fit narrow screens and never grows past its drawn size', () => {
  assert.equal(boardScale(760), 1);
  assert.equal(boardScale(1400), 1);
  assert.equal(boardScale(380), 0.5);
  assert.equal(boardScale(100), 0.3, 'a tiny width does not collapse the board');
});

test('the demo item moves one column at a time, rests on the last, then starts over', () => {
  const visited = [0];
  for (let i = 0; i < BOARD_COLUMNS; i += 1) visited.push(nextStage(visited.at(-1)));
  assert.deepEqual(visited, [0, 1, 2, 3, 4, 0]);
  assert.equal(stageDelay(0), 1500);
  assert.equal(stageDelay(3), 1500);
  assert.equal(stageDelay(4), 3400, 'the finished state stays visible longer');
});

test('reveal: every block gets its offset and delay, and shows when it scrolls into view', () => {
  const near = node({ dataset: { y: '40', delay: '0.32' } }), plain = node();
  let observed, callback;
  class FakeObserver { constructor(fn, options) { callback = fn; this.options = options; observed = this; this.watched = []; this.gone = []; } observe(item) { this.watched.push(item); } unobserve(item) { this.gone.push(item); } }
  const document = { querySelectorAll: () => [near, plain] };
  bindReveal({ document, IntersectionObserverClass: FakeObserver });
  assert.equal(near.props.get('--y'), '40px');
  assert.equal(near.props.get('--d'), '0.32s');
  assert.equal(plain.props.get('--y'), '24px');
  assert.equal(plain.props.get('--d'), '0s');
  assert.equal(observed.options.rootMargin, '0px 0px -80px 0px');
  assert.equal(near.classList.contains('in'), false, 'hidden until seen');
  callback([{ isIntersecting: false, target: near }, { isIntersecting: true, target: plain }]);
  assert.equal(plain.classList.contains('in'), true);
  assert.equal(near.classList.contains('in'), false);
  assert.deepEqual(observed.gone, [plain], 'each block animates once');
});

test('reveal: reduced motion, or no observer support, shows everything at once', () => {
  for (const options of [{ reduceMotion: true }, { IntersectionObserverClass: undefined }]) {
    const item = node();
    bindReveal({ document: { querySelectorAll: () => [item] }, ...options });
    assert.equal(item.classList.contains('in'), true);
  }
});

function boardFixture({ reduceMotion = false, width = 380 } = {}) {
  const chip = node({ dataset: { open: 'Medicine cabinet', done: '✓ Restocked' } });
  const mover = node({ querySelector: () => chip });
  const wrap = node({ clientWidth: width });
  const document = { querySelector: selector => selector === '[data-board]' ? wrap : selector === '[data-board-mover]' ? mover : null };
  const timers = [], cleared = [];
  let resize;
  class FakeResize { constructor(fn) { resize = fn; } observe() {} }
  const board = bindBoard({ document, reduceMotion, ResizeObserverClass: FakeResize, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: id => cleared.push(id) });
  return { board, wrap, mover, chip, timers, cleared, resize: () => resize() };
}

test('board: fits the width, then walks the item through every column and back with the right waits', () => {
  const f = boardFixture();
  assert.equal(f.wrap.props.get('--s'), '0.5');
  assert.equal(f.wrap.props.get('height'), '196px');
  assert.equal(f.mover.props.get('left'), '0%');
  assert.equal(f.chip.textContent, 'Medicine cabinet');
  const waits = [];
  for (let i = 0; i < 5; i += 1) { const timer = f.timers.at(-1); waits.push(timer.ms); timer.fn(); }
  assert.deepEqual(waits, [1500, 1500, 1500, 1500, 3400]);
  assert.equal(f.board.stage, 0, 'back at the start after the rest');
  const f2 = boardFixture();
  for (let i = 0; i < 4; i += 1) f2.timers.at(-1).fn();
  assert.equal(f2.mover.props.get('left'), '80%');
  assert.equal(f2.mover.classList.contains('done'), true, 'the last column turns green');
  assert.equal(f2.chip.textContent, '✓ Restocked');
});

test('board: resizing refits it, stop cancels the timer, and reduced motion shows the finished board still', () => {
  const f = boardFixture();
  f.wrap.clientWidth = 760;
  f.resize();
  assert.equal(f.wrap.props.get('--s'), '1');
  assert.equal(f.wrap.props.get('height'), '392px');
  f.board.stop();
  assert.deepEqual(f.cleared, [1]);
  const still = boardFixture({ reduceMotion: true });
  assert.equal(still.timers.length, 0, 'nothing moves');
  assert.equal(still.mover.props.get('left'), '80%');
  assert.equal(still.chip.textContent, '✓ Restocked');
  assert.equal(bindBoard({ document: { querySelector: () => null } }), null, 'a page without the board is left alone');
});

test('pills light one stage at a time and loop; reduced motion leaves the first lit', () => {
  const pills = [node(), node(), node()];
  const ticks = [];
  bindPills({ document: { querySelectorAll: () => pills }, setTimer: fn => ticks.push(fn) });
  const lit = () => pills.map(pill => pill.classList.contains('on'));
  assert.deepEqual(lit(), [true, false, false]);
  ticks[0](); assert.deepEqual(lit(), [false, true, false]);
  ticks[0](); ticks[0](); assert.deepEqual(lit(), [true, false, false], 'wraps around');
  const still = [node(), node()];
  const none = [];
  bindPills({ document: { querySelectorAll: () => still }, reduceMotion: true, setTimer: fn => none.push(fn) });
  assert.equal(none.length, 0);
  assert.equal(still[0].classList.contains('on'), true);
});

test('header gains its background once the page scrolls', () => {
  const header = node();
  const window = { scrollY: 0, addEventListener: (name, fn) => { window.onScroll = fn; } };
  bindHeader({ window, document: { querySelector: () => header } });
  assert.equal(header.classList.contains('scrolled'), false);
  window.scrollY = 120; window.onScroll();
  assert.equal(header.classList.contains('scrolled'), true);
  window.scrollY = 0; window.onScroll();
  assert.equal(header.classList.contains('scrolled'), false);
});

test('theme toggle flips dark mode, remembers the choice, and survives storage being blocked', () => {
  const button = node();
  const root = { classList: classes() };
  const stored = new Map();
  bindThemeToggle({ document: { querySelector: () => button, documentElement: root }, storage: { setItem: (key, value) => stored.set(key, value) } });
  assert.equal(button.attrs.get('aria-pressed'), 'false');
  assert.equal(button.attrs.get('aria-label'), 'Switch to dark mode');
  button.listeners.get('click')();
  assert.equal(root.classList.contains('dark'), true);
  assert.equal(stored.get('welcome-theme'), 'dark');
  assert.equal(button.attrs.get('aria-pressed'), 'true');
  assert.equal(button.attrs.get('aria-label'), 'Switch to light mode');
  button.listeners.get('click')();
  assert.equal(stored.get('welcome-theme'), 'light');
  const blocked = node(), plainRoot = { classList: classes() };
  bindThemeToggle({ document: { querySelector: () => blocked, documentElement: plainRoot }, storage: { setItem: () => { throw new Error('blocked'); } } });
  assert.doesNotThrow(() => blocked.listeners.get('click')());
  assert.equal(plainRoot.classList.contains('dark'), true);
});
