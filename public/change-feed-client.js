const changeKinds = new Set(['upsert', 'remove']);
const MAX_BACKOFF_MS = 5 * 60_000;

export function decodeChangePage(data) {
  const keys = ['changes', 'nextAfter', 'more', 'reset'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key))) throw Error('Change feed response was not recognized.');
  if (!Array.isArray(data.changes) || data.changes.length > 200 || !Number.isSafeInteger(data.nextAfter) || data.nextAfter < 0 || typeof data.more !== 'boolean' || typeof data.reset !== 'boolean') throw Error('Change feed response was not recognized.');
  const changes = data.changes.map(change => {
    const ok = change && typeof change === 'object' && Number.isSafeInteger(change.seq) && typeof change.id === 'string' && changeKinds.has(change.kind)
      && Number.isSafeInteger(change.revision) && (change.kind === 'remove' ? change.batch === null : Boolean(change.batch) && typeof change.batch === 'object' && change.batch.id === change.id && change.batch.revision === change.revision);
    if (!ok) throw Error('Change feed response was not recognized.');
    return change;
  });
  return { changes, nextAfter: data.nextAfter, more: data.more, reset: data.reset };
}

export function decodeCursor(data) {
  const page = decodeChangePage(data);
  if (page.changes.length || page.more || page.reset) throw Error('Change feed response was not recognized.');
  return page.nextAfter;
}

/**
 * Online-only pull feed. It reads and never mutates; applyChanges owns all UI writes.
 * The cursor must be read BEFORE the list it accompanies (see readCursor/adopt).
 */
export function bindChangeFeed({
  getContext, request, applyChanges, reloadAll, isEligible,
  now = () => Date.now(), random = Math.random, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle),
  intervalMs = 60_000, maxPagesPerTick = 5, safetyReloadMs = 10 * 60_000
}) {
  let loadedAt = 0, cursor = null, epoch = 0, busy = false, disabled = false, failures = 0, blockedUntil = 0, timer = null, running = false;
  const contextKey = () => `${getContext()?.accountContextKey}:${getContext()?.activeShopId}`;
  let boundKey = null;

  function clearPending() { if (timer) clearTimer(timer); timer = null; }

  function delay() {
    const backoff = failures ? Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures) : intervalMs;
    const wait = Math.max(backoff * (0.85 + random() * 0.3), blockedUntil - now());
    return Math.round(wait);
  }

  function schedule() {
    clearPending();
    if (!running || disabled) return;
    timer = setTimer(() => { timer = null; tick(); }, delay());
  }

  async function tick() {
    if (busy || !running || disabled || !isEligible() || now() < blockedUntil) { schedule(); return; }
    const generation = epoch, key = contextKey();
    if (cursor === null || now() - loadedAt >= safetyReloadMs) {
      busy = true;
      try { await reloadAll(); } catch {} finally { if (generation === epoch) busy = false; }
      schedule();
      return;
    }
    busy = true;
    try {
      for (let pages = 0; pages < maxPagesPerTick; pages += 1) {
        const page = decodeChangePage(await request(`/api/changes?after=${cursor}&limit=100`));
        if (generation !== epoch || key !== contextKey()) return;
        if (page.reset) { cursor = null; await reloadAll(); return; }
        if (page.changes.length) applyChanges(page.changes);
        cursor = page.nextAfter;
        if (!page.more) break;
      }
      failures = 0;
    } catch (error) {
      if (generation !== epoch) return;
      const status = error?.status;
      if (status === 404 || status === 405) disabled = true;
      else if (status === 429) blockedUntil = now() + (Number.isInteger(error.retryAfter) ? error.retryAfter : 60) * 1000;
      failures = Math.min(failures + 1, 6);
    } finally {
      if (generation === epoch) busy = false;
      if (generation === epoch) schedule();
    }
  }

  function wake() {
    if (!running || disabled || cursor === null || busy || !isEligible()) return;
    clearPending();
    tick();
  }

  return {
    /** Read before fetching the list; a failure just leaves the feed off until the next load. */
    async readCursor() {
      try { return decodeCursor(await request('/api/changes')); }
      catch (error) { if (error?.status === 404 || error?.status === 405) disabled = true; return null; }
    },
    /** Called with the cursor read before a successful list load. */
    adopt(startCursor) {
      epoch += 1; busy = false; clearPending();
      boundKey = contextKey();
      cursor = Number.isSafeInteger(startCursor) && !disabled ? startCursor : null;
      loadedAt = now();
      failures = 0;
      schedule();
    },
    start() { running = true; wake(); schedule(); },
    stop() { running = false; clearPending(); },
    /** Visible again, focus, online, or navigation into an eligible view. */
    wake,
    get cursor() { return cursor; },
    get disabled() { return disabled; },
    get boundKey() { return boundKey; }
  };
}
