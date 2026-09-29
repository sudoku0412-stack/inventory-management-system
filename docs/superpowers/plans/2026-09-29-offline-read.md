# Offline Read (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The signed-in app opens with no signal and shows the inventory as last synced, with an offline banner and edits disabled.

**Architecture:** The service worker caches the app shell (network first, cached copy on network failure). IndexedDB keeps the last Shop context and a per-account-and-Shop snapshot of medicines, notifications and settings. `app.js` falls back to them only on a network error, in cloud mode only. Browser-only: no server, migration or secret change.

**Tech Stack:** Vanilla browser JS modules, Service Worker API, IndexedDB, existing Cloudflare Worker asset allowlists.

**Spec:** `docs/superpowers/specs/2026-09-29-offline-use-design.md` (this plan is slice 1: components 1 and 2; slice 2 is a later plan).

## Global Constraints

- No server, migration, secret or flag change. Local (loopback SQLite) mode never uses the snapshot, queue or offline banner.
- `/api/*`, `/admin/*`, `/cdn-cgi/*` and every non-GET request are never cached or served from cache by the service worker.
- A redirected response (Cloudflare Access login) is never cached.
- Every IndexedDB read and write is wrapped so a storage error leaves the app behaving exactly as today.
- New browser module `/offline-store.js` goes in BOTH `publicAssetPaths` (`lib/shared.js`) and `bootstrapAssetPaths` (`worker/index.js`), or the Worker returns 404 and the app never starts.
- Project owner rule: do not write or update tests unless asked. Existing tests must still pass (`npm test 2>&1 | grep -A 10 'FAIL'`).
- Snapshot data is the same medicine fields the page already shows: no tokens, secrets or emails beyond what `/api/shops` context and settings already return to the page.

## Review Focus

- IndexedDB unavailable or throwing (private mode): the app must load and work online exactly as before.
- Session expired while online (Access redirect): the shell from cache must not replace the sign-in prompt, and the redirect page must not be cached.
- Different account signs in on the same browser: the previous account's snapshot must never render (snapshot key includes `accountContextKey`; saving a context with a different account key clears all snapshots).
- Mutation attempted while offline mode is on: rejected with a clear message, never queued or sent.
- Connection returns while offline mode is on: the app re-runs `start()` and leaves offline mode without a manual reload.

---

## File Structure

- Create `public/offline-store.js`: IndexedDB wrapper (context and snapshots). One responsibility: durable, failure-tolerant local copy.
- Modify `public/sw.js`: add shell caching; push handlers unchanged.
- Modify `public/app.js`: register the service worker, save context and snapshots, offline boot and load fallback, offline mutation guard, `online` handler.
- Modify `public/index.html`, `public/styles.css`: offline banner.
- Modify `lib/shared.js`, `worker/index.js`: allowlists.
- Modify `HANDOVER.md`.

### Task 1: Offline store module

**Files:**
- Create: `public/offline-store.js`
- Modify: `lib/shared.js:21`, `worker/index.js:25`

**Interfaces:**
- Produces: `openOfflineStore({ indexedDB?, now? }) -> { saveContext(context), loadContext(), saveSnapshot(key, data), loadSnapshot(key) }`. All methods return a Promise and never reject; failures resolve `null`. `loadContext()` resolves `{ context, savedAt } | null`. `loadSnapshot(key)` resolves `{ ...data, savedAt } | null`. `saveContext(context)` clears every snapshot first when `context.accountContextKey` differs from the previously saved one.

- [ ] **Step 1: Create the module**

```js
// Durable local copy for offline reading: the last Shop context and a snapshot per account and Shop.
// Every method swallows storage failures and resolves null, so a blocked or unavailable IndexedDB never affects the online app.
const DB_NAME = 'medicine-offline';
const VERSION = 1;

export function openOfflineStore({ indexedDB = globalThis.indexedDB, now = () => new Date().toISOString() } = {}) {
  let dbPromise = null;
  const open = () => dbPromise ||= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('IndexedDB is unavailable'));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => { request.result.createObjectStore('meta'); request.result.createObjectStore('snapshots'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (store, mode, action) => {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = action(tx.objectStore(store));
        tx.oncomplete = () => resolve(request?.result ?? null);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } catch { dbPromise = null; return null; }
  };

  async function saveContext(context) {
    const previous = await loadContext();
    if (previous?.context?.accountContextKey && previous.context.accountContextKey !== context?.accountContextKey) await run('snapshots', 'readwrite', store => store.clear());
    return run('meta', 'readwrite', store => store.put({ context, savedAt: now() }, 'context'));
  }
  const loadContext = () => run('meta', 'readonly', store => store.get('context'));
  const saveSnapshot = (key, data) => run('snapshots', 'readwrite', store => store.put({ ...data, savedAt: now() }, key));
  const loadSnapshot = key => run('snapshots', 'readonly', store => store.get(key));
  return { saveContext, loadContext, saveSnapshot, loadSnapshot };
}
```

- [ ] **Step 2: Add `'/offline-store.js'` to both allowlists**

In `lib/shared.js` `publicAssetPaths` and `worker/index.js` `bootstrapAssetPaths`, insert `'/offline-store.js', ` immediately after `'/change-feed-client.js', `.

- [ ] **Step 3: Verify**

Run: `node --check public/offline-store.js && npm test 2>&1 | grep -A 10 'FAIL'`
Expected: no output (existing `test/worker-assets.test.js` also confirms the allowlists).

- [ ] **Step 4: Commit**

```bash
git add public/offline-store.js lib/shared.js worker/index.js
git commit -m "feat: offline store for saved Shop context and snapshots"
```

### Task 2: Service worker shell cache

**Files:**
- Modify: `public/sw.js` (add above the existing push handlers)

**Interfaces:**
- Produces: none used by other tasks except that `/sw.js` controls the page after registration (Task 3).

- [ ] **Step 1: Add the caching code at the top of `public/sw.js`**

```js
// App shell cache. Network first so a deploy is picked up immediately; the cached copy is only used when the network fails.
// API, admin and Cloudflare Access paths and every non-GET request are never touched. Redirected responses (an Access login) are never cached.
const SHELL_CACHE = 'medicine-shell-v1';
const PRECACHE = ['/', '/index.html', '/app.js', '/greeting.js', '/shop-client.js', '/shop-creation-client.js', '/owner-promotion-client.js', '/member-removal-client.js', '/owner-demotion-client.js', '/ownership-transfer-client.js', '/shop-leave-client.js', '/shop-deletion-client.js', '/deleted-shops-client.js', '/email-preferences-client.js', '/inventory-export-client.js', '/shop-invitations-client.js', '/change-feed-client.js', '/offline-store.js', '/styles.css'];
const STATIC_FILE = /\.(?:js|css|png|svg|ico|webmanifest|json)$/;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(PRECACHE.map(path => cache.add(new Request(path, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('medicine-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && !response.redirected) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true }) || (request.mode === 'navigate' ? await cache.match('/index.html') : null);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || /^\/(?:api|admin|cdn-cgi)\//.test(url.pathname)) return;
  if (request.mode === 'navigate' || STATIC_FILE.test(url.pathname)) event.respondWith(networkFirst(request));
});
```

- [ ] **Step 2: Verify**

Run: `node --check public/sw.js`
Expected: no output. Runtime behavior is checked in Task 4.

- [ ] **Step 3: Commit**

```bash
git add public/sw.js
git commit -m "feat: service worker caches the app shell, network first"
```

### Task 3: App integration and banner

**Files:**
- Modify: `public/app.js` (lines 23, 80, 120-130), `public/index.html` (inside `<main class="main-content">`, before `<header class="topbar">`), `public/styles.css` (append)

**Interfaces:**
- Consumes: `openOfflineStore` from Task 1 (`saveContext`, `loadContext`, `saveSnapshot`, `loadSnapshot`).
- Produces: none.

- [ ] **Step 1: Banner markup and style**

In `public/index.html`, insert before `<header class="topbar">`:

```html
        <p class="offline-banner" id="offlineBanner" role="status" aria-live="polite" hidden></p>
```

Append to `public/styles.css`:

```css
.offline-banner { margin: 0 0 14px; padding: 11px 14px; border-radius: 12px; background: #fff4d6; color: #5c4200; font-weight: 600; }
```

- [ ] **Step 2: Import, state and helpers in `public/app.js`**

Add next to the other imports (top of file): `import { openOfflineStore } from './offline-store.js';`

Add directly above `function api(path,opts={})` (line 23) and replace that line:

```js
const offlineStore=openOfflineStore();
let offlineMode=false;
function isNetworkError(error){return !error?.status&&(error instanceof TypeError||navigator.onLine===false)}
function setOffline(on,savedAt){offlineMode=on;const banner=qs('#offlineBanner');banner.hidden=!on;banner.textContent=on?`Offline: showing saved data${savedAt?` from ${new Date(savedAt).toLocaleString(undefined,{hour:'numeric',minute:'numeric',month:'short',day:'numeric'})}`:''}. Changes need a connection.`:''}
function snapshotKey(){return !localShopMode&&shopContext&&activeShopId?`${shopContext.accountContextKey}:${activeShopId}`:null}
function api(path,opts={}){if(offlineMode&&(opts.method||'GET').toUpperCase()!=='GET')return Promise.reject(Object.assign(new Error('You’re offline. Changes need a connection.'),{status:0}));return requestShopApi(fetch,path,opts,activeShopId)}
```

- [ ] **Step 3: Save and fall back in `load()` (line 80)**

In the `try` block of `load()`, after `applySettings(profile);` add:

```js
setOffline(false);const key=snapshotKey();if(key)offlineStore.saveSnapshot(key,{medicines,notifications,settings:profile});
```

At the start of the `catch(e){` of `load()`, add as the first statement:

```js
if(await loadFromSnapshot(e))return;
```

Add this function next to `load()`:

```js
async function loadFromSnapshot(error){const key=snapshotKey();if(!key||!isNetworkError(error))return false;const saved=await offlineStore.loadSnapshot(key);if(!saved||!Array.isArray(saved.medicines))return false;setOffline(true,saved.savedAt);medicines=saved.medicines;notifications=saved.notifications||[];if(saved.settings)applySettings(saved.settings);dashboard();inventory();notices();return true}
```

- [ ] **Step 4: Save context, offline boot, `online` handler**

In `openConfirmedShop()` (line 124), after `renderShopContext(context);` and before `showApp()` add `offlineStore.saveContext(context);`, and at the start of its `catch(error){` add `if(await offlineBoot(error))return;`.

In `start()`'s `catch(error){` (line 130) add as the first statement `if(await offlineBoot(error))return;`.

Add next to `showApp`:

```js
async function offlineBoot(error){if(!isNetworkError(error))return false;const saved=await offlineStore.loadContext();if(!saved?.context||!Array.isArray(saved.context.shops))return false;renderShopContext(saved.context);showApp();return true}
window.addEventListener('online',()=>{if(offlineMode)start()});
```

Register the service worker: add at the end of `public/app.js` before `start();`-line's neighbors (any top-level position after `start` is defined):

```js
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});
```

- [ ] **Step 5: Verify syntax and suite**

Run: `node --check public/app.js && npm test 2>&1 | grep -A 10 'FAIL'`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html public/styles.css
git commit -m "feat: open and read the saved inventory offline"
```

### Task 4: Browser verification, handover, release

**Files:**
- Modify: `HANDOVER.md`

- [ ] **Step 1: Verify in a browser against a mock API**

Start a small local mock (scratchpad script) serving `public/` plus `/api/shop/onboarding-status` `{membership:true}`, `/api/shops` (context with `accountContextKey`, one Shop, `activeShopId`), `/api/batches` (two medicines), `/api/notifications` `[]`, `/api/settings`, `/api/packaging/status`. In the browser pane: load once online; confirm the service worker is active and `medicine-offline` exists in IndexedDB; stop the mock (server down); reload; expect the inventory from the saved copy, the offline banner with the saved time, and an "Add medicine" save rejected with "You’re offline". Restart the mock and dispatch `window.dispatchEvent(new Event('online'))`; expect the banner to clear and fresh data. Also confirm a simulated redirect response is not cached (respond `302` to `/` once; the cached shell is not replaced).

- [ ] **Step 2: Handover**

Add a `## Offline read (slice 1)` section at the top of `HANDOVER.md`: what shipped, that new browser modules must also be added to the `PRECACHE` list in `public/sw.js` (runtime caching covers drift after the first online load), that fonts load from Google and fall back to system fonts offline, and that slice 2 (offline edits) is the next plan.

- [ ] **Step 3: Code review, PR, merge, deploy**

Run the code-review skill (medium), fix findings, commit, open the PR, merge. Deploy with `npm run deploy` (no migration). Then re-check `https://medicineinventory.craftloop.ca/sw.js` returns the new file (`no-cache`) and report the Worker version.
