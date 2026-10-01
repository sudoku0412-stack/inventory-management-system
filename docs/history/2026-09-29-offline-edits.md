# Offline Edits (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add, edit, consume and discard medicines with no signal; the changes queue on the device and sync when signal returns, with the later timestamp winning any conflict.

**Architecture:** A pure module (`offline-queue.js`) holds the queue rules (collapse per medicine, optimistic view, replay with timestamp rule). `offline-store.js` persists one queue per account-and-Shop. `app.js` routes the four batch mutations into the queue when offline or on a network error, shows the optimistic list, and replays on reconnect. Browser-only: the existing 409-with-current-batch response drives conflict handling.

**Tech Stack:** Vanilla browser JS modules, IndexedDB, existing REST API.

**Spec:** `docs/history/2026-09-29-offline-use-design.md` (components 3 to 5). Slice 1 (`docs/history/2026-09-29-offline-read.md`) is deployed.

## Global Constraints

- No server, migration, secret or flag change. Local (loopback SQLite) mode never queues.
- Only these four requests are queued: `POST /api/batches`, `PATCH /api/batches/:id`, `POST /api/batches/:id/consume`, `POST /api/batches/:id/discard`. Photos, settings, Shop access, invitations and notifications stay online-only.
- A queued replay always reuses the entry's stored `operationId` (server replays duplicates safely). Only a timestamp rebase mints a new `operationId`.
- Timestamp rule: the later edit wins, every operation type; an equal or earlier edit is dropped with a notice. A consume that wins a conflict is re-sent as "set quantity to X" (X = its computed final quantity), or as a full consume when X is 0.
- Clock correction: `editedAt` is shifted by (server `Date` header − device time) measured at sync, and never later than the server time at sync.
- A rebase that conflicts again retries up to 3 times, then the entry stays queued in "needs retry". 401/403 pauses the queue without dropping anything. A network error, 408, 429 or 5xx stops the replay and keeps the entries.
- Queue and snapshot are keyed by `accountContextKey:shopId`; replay only ever sends the current scope's entries.
- New browser module `/offline-queue.js` goes in BOTH `publicAssetPaths` (`lib/shared.js`) and `bootstrapAssetPaths` (`worker/index.js`) and in `PRECACHE` in `public/sw.js`.
- Project owner rule: do not write or update tests unless asked. Existing tests must still pass (`npm test 2>&1 | grep -A 10 'FAIL'`). Verify new logic with throwaway scripts in the scratchpad, not committed.

## Review Focus

- Replay after an ambiguous failure (request reached the server, response lost) must not double-apply: same `operationId` is reused, never regenerated on a plain retry.
- Edit then consume-to-zero on a medicine created offline: the queued create is removed and nothing is sent.
- Switching Shop or account never sends another scope's entries.
- Expired session (401/403) pauses with entries intact; a redirect or network failure keeps them queued.
- Saving a medicine with a photo (add, replace or remove) while offline is rejected with a clear message and never queued (no data URL persisted).

---

## File Structure

- Create `public/offline-queue.js`: pure queue logic (no DOM, no storage).
- Modify `public/offline-store.js`: add a `queues` object store and `loadQueue` / `saveQueue`.
- Modify `public/app.js`: queue state, routing in `api()`, optimistic list, `syncQueue()`, banner rendering.
- Modify `public/index.html`, `public/styles.css`: banner with a **Sync now** button.
- Modify `lib/shared.js`, `worker/index.js`, `public/sw.js`: allowlist / precache entries.
- Modify `HANDOVER.md`.

### Task 1: Queue logic module

**Files:**
- Create: `public/offline-queue.js`
- Modify: `lib/shared.js`, `worker/index.js` (insert `'/offline-queue.js', ` after `'/offline-store.js', `), `public/sw.js` (add `'/offline-queue.js', ` after `'/offline-store.js', ` in `PRECACHE`)

**Interfaces:**
- Produces (used by Task 3): `entryFromRequest({ method, path, body, list, now? }) -> entry | null`; `enqueue(queue, entry) -> queue`; `applyQueue(list, queue, day?) -> list`; `requestFor(entry) -> { method, path, body }`; `replayQueue({ queue, send, persist, correct, newId, maxTries? }) -> Promise<{ queue, replaced, skipped, state }>` where `state` is `'done' | 'retry' | 'auth' | 'offline'`.
- Entry shape: `{ kind: 'create'|'update'|'consume'|'discard', batchId, fields?, amount?, quantityAfter?, operationId, baseRevision, editedAt }`. A queued create has `batchId` `pending-<operationId>`.

- [ ] **Step 1: Create the module**

```js
// Offline change queue: pure rules, no DOM and no storage.
// One entry per medicine; later changes collapse into it. Replay applies the "later timestamp wins" rule using the 409's current batch.
const FIELDS = ['name', 'strength', 'form', 'quantity', 'unit', 'low_stock_threshold', 'location', 'notes', 'expiry_date'];
const isoDay = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');

export const pickFields = batch => Object.fromEntries(FIELDS.filter(key => batch && batch[key] !== undefined).map(key => [key, batch[key]]));

export function statusFor(batch, day = isoDay(new Date())) {
  if (!batch.expiry_date) return 'unknown';
  const end = new Date(`${day}T00:00:00`); end.setDate(end.getDate() + 30);
  if (batch.expiry_date < day) return 'expired';
  if (batch.expiry_date <= isoDay(end)) return 'expiring';
  return batch.quantity <= batch.low_stock_threshold ? 'low' : 'healthy';
}

/** Builds a queue entry from a batch mutation request, or null when the request is not a queueable batch mutation. */
export function entryFromRequest({ method, path, body, list, now = Date.now() }) {
  const match = /^\/api\/batches(?:\/([^/]+)(?:\/(consume|discard))?)?$/.exec(path);
  if (!match || !body) return null;
  const { operationId, baseRevision, ...rest } = body;
  const [, id, action] = match;
  if (method === 'POST' && !id) return { kind: 'create', batchId: `pending-${operationId}`, fields: rest, operationId, baseRevision: 0, editedAt: now };
  const current = id ? list.find(item => item.id === id) : null;
  if (!current) return null;
  if (method === 'PATCH' && !action) return { kind: 'update', batchId: id, fields: rest, operationId, baseRevision, editedAt: now };
  if (method === 'POST' && action === 'consume') return { kind: 'consume', batchId: id, amount: Number(rest.amount), quantityAfter: Math.max(0, current.quantity - Number(rest.amount)), operationId, baseRevision, editedAt: now };
  if (method === 'POST' && action === 'discard') return { kind: 'discard', batchId: id, operationId, baseRevision, editedAt: now };
  return null;
}

/** Collapses a new entry into the queue: one entry per medicine, the earliest baseRevision kept. */
export function enqueue(queue, entry) {
  const index = queue.findIndex(item => item.batchId === entry.batchId);
  if (index < 0) return [...queue, entry];
  const old = queue[index];
  const put = next => next ? [...queue.slice(0, index), next, ...queue.slice(index + 1)] : [...queue.slice(0, index), ...queue.slice(index + 1)];
  if (entry.kind === 'discard') return old.kind === 'create' ? put(null) : put({ ...entry, baseRevision: old.baseRevision });
  if (old.kind === 'create') {
    if (entry.kind === 'update') return put({ ...old, fields: { ...old.fields, ...entry.fields }, editedAt: entry.editedAt });
    if (entry.kind === 'consume') {
      const quantity = Number(old.fields.quantity) - entry.amount;
      return quantity < 1 ? put(null) : put({ ...old, fields: { ...old.fields, quantity }, editedAt: entry.editedAt });
    }
  }
  if (old.kind === 'update') {
    if (entry.kind === 'update') return put({ ...old, fields: { ...old.fields, ...entry.fields }, editedAt: entry.editedAt });
    if (entry.kind === 'consume') return put({ ...old, fields: { ...old.fields, quantity: entry.quantityAfter }, editedAt: entry.editedAt });
  }
  if (old.kind === 'consume') {
    if (entry.kind === 'consume') return put({ ...old, amount: old.amount + entry.amount, quantityAfter: entry.quantityAfter, editedAt: entry.editedAt });
    if (entry.kind === 'update') return put({ ...entry, baseRevision: old.baseRevision });
  }
  return put(entry);
}

/** The medicine list as it will look once the queue is applied. */
export function applyQueue(list, queue, day = isoDay(new Date())) {
  const out = list.map(item => ({ ...item }));
  for (const entry of queue) {
    const index = out.findIndex(item => item.id === entry.batchId);
    if (entry.kind === 'create') {
      const stamp = new Date(entry.editedAt).toISOString();
      const batch = { id: entry.batchId, strength: '', location: '', notes: '', low_stock_threshold: 4, expiry_date: null, ...entry.fields, has_photo: false, revision: 0, discarded_at: null, created_at: stamp, updated_at: stamp };
      batch.status = statusFor(batch, day);
      out.push(batch);
    } else if (index < 0) continue;
    else if (entry.kind === 'discard' || (entry.kind === 'consume' && entry.quantityAfter < 1)) out.splice(index, 1);
    else {
      const batch = { ...out[index], ...(entry.kind === 'update' ? entry.fields : { quantity: entry.quantityAfter }) };
      batch.status = statusFor(batch, day);
      out[index] = batch;
    }
  }
  return out;
}

/** The HTTP request that sends an entry. */
export function requestFor(entry) {
  const sync = { operationId: entry.operationId, baseRevision: entry.baseRevision };
  if (entry.kind === 'create') return { method: 'POST', path: '/api/batches', body: { ...entry.fields, ...sync } };
  if (entry.kind === 'update') return { method: 'PATCH', path: `/api/batches/${entry.batchId}`, body: { ...entry.fields, ...sync } };
  if (entry.kind === 'consume') return { method: 'POST', path: `/api/batches/${entry.batchId}/consume`, body: { amount: entry.amount, ...sync } };
  return { method: 'POST', path: `/api/batches/${entry.batchId}/discard`, body: sync };
}

/** The entry re-based onto the server's current batch, with a new operationId (its old one was tied to a stale revision). */
function rebase(entry, current, newId) {
  const sync = { operationId: newId(), baseRevision: current.revision };
  if (entry.kind === 'discard') return { ...entry, ...sync };
  if (entry.kind === 'consume' && entry.quantityAfter < 1) return { ...entry, amount: current.quantity, ...sync };
  if (entry.kind === 'consume') return { ...entry, kind: 'update', fields: { ...pickFields(current), quantity: entry.quantityAfter }, ...sync };
  return { ...entry, fields: { ...pickFields(current), ...entry.fields }, ...sync };
}

/**
 * Sends entries in order. `send(entry)` resolves or rejects with an error carrying `status` (and `current` on a 409).
 * `correct(ms)` maps a device time to server time. `persist(queue)` saves progress after each entry leaves the queue.
 */
export async function replayQueue({ queue, send, persist, correct, newId, maxTries = 3 }) {
  let pending = [...queue], replaced = 0, skipped = 0, state = 'done';
  const leave = async entry => { pending = pending.filter(item => item !== entry); await persist(pending); };
  for (const entry of queue) {
    let working = entry, tries = 0;
    for (;;) {
      try { await send(working); await leave(entry); break; }
      catch (error) {
        const status = error?.status;
        if (status === 409 && error.current) {
          const later = correct(entry.editedAt) > Date.parse(error.current.updated_at);
          if (!later || error.current.discarded_at) { replaced += 1; await leave(entry); break; }
          if (++tries > maxTries) { state = 'retry'; break; }
          working = rebase(entry, error.current, newId);
          continue;
        }
        if (status === 401 || status === 403) return { queue: pending, replaced, skipped, state: 'auth' };
        if (status === 404 || (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429)) { skipped += 1; await leave(entry); break; }
        return { queue: pending, replaced, skipped, state: 'offline' };
      }
    }
  }
  return { queue: pending, replaced, skipped, state };
}
```

- [ ] **Step 2: Add the module to both allowlists and `PRECACHE`**

In `lib/shared.js` (`publicAssetPaths`), `worker/index.js` (`bootstrapAssetPaths`) and `public/sw.js` (`PRECACHE`), insert `'/offline-queue.js', ` immediately after `'/offline-store.js', `.

- [ ] **Step 3: Verify the rules with a throwaway script**

Write `<scratchpad>/queue-check.mjs` (not committed) that imports `public/offline-queue.js` and asserts, printing `ok` per case: (a) create then update merges into the create; create then consume to 0 removes it; create then discard removes it; (b) update then consume sets `fields.quantity = quantityAfter`; consume twice accumulates `amount` and keeps the latest `quantityAfter`; consume then update becomes the update with the consume's `baseRevision`; anything then discard becomes a discard with the earliest `baseRevision`; (c) `applyQueue` adds a create with `status` and `revision: 0`, removes on discard and consume-to-zero, applies quantity on consume; (d) `replayQueue` with a `send` that rejects `{ status: 409, current: { revision: 5, updated_at: <older than editedAt>, quantity: 10, ...fields } }` once then resolves: the entry is re-sent with `baseRevision: 5` and a new `operationId`; with `updated_at` newer than `editedAt`: entry dropped, `replaced: 1`; `send` rejecting `{ status: 404 }`: `skipped: 1`; `{ status: 401 }`: `state: 'auth'` with the entry still queued; a `TypeError` (no status): `state: 'offline'`, entry queued; four 409s in a row: `state: 'retry'`, entry queued.

Run: `node <scratchpad>/queue-check.mjs`
Expected: every case prints `ok`.

- [ ] **Step 4: Verify and commit**

Run: `node --check public/offline-queue.js && npm test 2>&1 | grep -A 10 'FAIL'`
Expected: no output.

```bash
git add public/offline-queue.js lib/shared.js worker/index.js public/sw.js
git commit -m "feat: offline change queue rules"
```

### Task 2: Queue persistence

**Files:**
- Modify: `public/offline-store.js`

**Interfaces:**
- Consumes: existing `run(store, mode, action)` helper in the same file.
- Produces: `loadQueue(scopeKey) -> Promise<entry[] | null>`, `saveQueue(scopeKey, entries) -> Promise<unknown>`; both never reject (null on failure). `openOfflineStore` return value gains these two.

- [ ] **Step 1: Bump the database to version 2 with a `queues` store**

Change `const VERSION = 1;` to `const VERSION = 2;`. Replace the `onupgradeneeded` handler with:

```js
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['meta', 'snapshots', 'queues']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
```

- [ ] **Step 2: Add the two methods and export them**

Before the `return` line add:

```js
  const loadQueue = key => run('queues', 'readonly', store => store.get(key));
  const saveQueue = (key, entries) => run('queues', 'readwrite', store => store.put(entries, key));
```

Change the return to `return { saveContext, loadContext, saveSnapshot, loadSnapshot, loadQueue, saveQueue };`.

- [ ] **Step 3: Verify and commit**

Run: `node --check public/offline-store.js && npm test 2>&1 | grep -A 10 'FAIL'`
Expected: no output.

```bash
git add public/offline-store.js
git commit -m "feat: persist the offline change queue per account and Shop"
```

### Task 3: App integration and banner

**Files:**
- Modify: `public/app.js`, `public/index.html`, `public/styles.css`

**Interfaces:**
- Consumes: Task 1 exports and Task 2 `loadQueue` / `saveQueue`; existing `snapshotKey()`, `isNetworkError()`, `setOffline()`, `probeOnline()`, `operationId()`, `requestShopApi`, `activeShopId`, `medicines`, `load()`, `loadFromSnapshot()`.
- Produces: none.

- [ ] **Step 1: Banner markup and style**

In `public/index.html` replace `<p class="offline-banner" id="offlineBanner" role="status" aria-live="polite" hidden></p>` with:

```html
        <div class="offline-banner" id="offlineBanner" role="status" aria-live="polite" hidden><span id="offlineBannerText"></span> <button class="button secondary" id="syncNow" type="button" hidden>Sync now</button></div>
```

Append to `public/styles.css`:

```css
.offline-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.offline-banner .button { min-height: 44px; }
```

- [ ] **Step 2: Import and replace the offline block in `public/app.js`**

Add next to the other imports: `import { applyQueue, enqueue, entryFromRequest, replayQueue, requestFor } from './offline-queue.js';`

Replace ONLY the existing `function setOffline(...)` line and the existing `function api(...)` line (keep `const offlineStore`, `let offlineMode`, `let offlineTimer`, `isNetworkError`, `probeOnline` and `snapshotKey` exactly as they are). Put the first line and `renderBanner` and the new `setOffline` where `setOffline` was, and everything from `const batchMutation` on where `api` was:

```js
let savedAtShown=null,queue=[],queueScope=null,syncing=false,syncState='',syncNotice='',syncNoticeTimer=null,baseMedicines=[];
function renderBanner(){const banner=qs('#offlineBanner'),parts=[];if(offlineMode)parts.push(`Offline: showing saved data${savedAtShown?` from ${new Date(savedAtShown).toLocaleString(undefined,{hour:'numeric',minute:'numeric',month:'short',day:'numeric'})}`:''}.`);if(queue.length)parts.push(`${queue.length} change${queue.length===1?'':'s'} waiting to sync.`);if(syncing)parts.push('Syncing…');if(syncState==='auth')parts.push('Sign in again to sync your changes.');if(syncState==='retry')parts.push('Some changes need a retry.');if(syncNotice)parts.push(syncNotice);if(offlineMode&&!queue.length)parts.push('Changes need a connection.');banner.hidden=!parts.length;qs('#offlineBannerText').textContent=parts.join(' ');qs('#syncNow').hidden=!queue.length||syncing}
function setOffline(on,savedAt){offlineMode=on;if(on&&savedAt!==undefined)savedAtShown=savedAt;clearInterval(offlineTimer);offlineTimer=on?setInterval(()=>{if(!document.hidden)probeOnline()},30000):null;renderBanner()}
const batchMutation=/^\/api\/batches(?:\/[^/]+(?:\/(?:consume|discard))?)?$/;
const offlineError=()=>Object.assign(new Error('You’re offline. Changes need a connection.'),{status:0});
function queueMutation(path,opts){const scope=snapshotKey();let body;try{body=JSON.parse(opts.body||'{}')}catch{return Promise.reject(offlineError())}if(body&&'photo' in body)return Promise.reject(Object.assign(new Error('Photos need a connection. Remove the photo to save offline.'),{status:0}));const entry=entryFromRequest({method:(opts.method||'GET').toUpperCase(),path,body,list:medicines});if(!scope||!entry)return Promise.reject(offlineError());queue=enqueue(queue,entry);medicines=applyQueue(baseMedicines,queue);offlineStore.saveQueue(scope,queue);renderBanner();return Promise.resolve(entry.kind==='create'?{id:entry.batchId}:null)}
function api(path,opts={}){const method=(opts.method||'GET').toUpperCase();if(method!=='GET'&&batchMutation.test(path)&&snapshotKey()){if(offlineMode)return queueMutation(path,opts);return requestShopApi(fetch,path,opts,activeShopId).catch(error=>{if(!isNetworkError(error))throw error;setOffline(true,null);return queueMutation(path,opts)})}if(offlineMode&&method!=='GET')return Promise.reject(offlineError());return requestShopApi(fetch,path,opts,activeShopId)}
async function ensureQueue(){const scope=snapshotKey();if(scope&&queueScope!==scope){queue=(await offlineStore.loadQueue(scope))||[];queueScope=scope;syncState='';renderBanner()}}
async function syncQueue(){const scope=snapshotKey();if(!scope||syncing||!queue.length)return;syncing=true;syncState='';renderBanner();let result=null;try{const probe=await fetch('/api/shop/onboarding-status',{credentials:'same-origin'}),serverNow=Date.parse(probe.headers.get('date'))||Date.now(),offset=serverNow-Date.now();result=await replayQueue({queue,send:entry=>{const r=requestFor(entry);return requestShopApi(fetch,r.path,{method:r.method,body:JSON.stringify(r.body)},activeShopId)},persist:next=>{queue=next;return offlineStore.saveQueue(scope,next)},correct:ms=>Math.min(ms+offset,serverNow),newId:operationId});queue=result.queue;syncState=result.state==='auth'||result.state==='retry'?result.state:'';const notes=[];if(result.replaced)notes.push(`${result.replaced} change${result.replaced===1?' was':'s were'} replaced by a newer one.`);if(result.skipped)notes.push(`${result.skipped} change${result.skipped===1?'':'s'} couldn’t be applied.`);syncNotice=notes.join(' ');clearTimeout(syncNoticeTimer);if(syncNotice)syncNoticeTimer=setTimeout(()=>{syncNotice='';renderBanner()},20000)}catch{}finally{syncing=false;renderBanner()}if(result&&result.state!=='offline'&&result.state!=='auth')await load()}
qs('#syncNow').addEventListener('click',()=>{syncState='';syncQueue()});
```

- [ ] **Step 3: Use the queue in `load()` and `loadFromSnapshot()`**

- `async function load(){try{` becomes `async function load(){await ensureQueue();try{`.
- In `load()`: `medicines=batches;` becomes `baseMedicines=batches;medicines=applyQueue(batches,queue);`.
- In `load()`: `offlineStore.saveSnapshot(snapKey,{medicines,notifications,settings:profile})` becomes `offlineStore.saveSnapshot(snapKey,{medicines:batches,notifications,settings:profile})`.
- In `load()`: after `changeFeed.adopt(startCursor)` add `;if(queue.length&&syncState!=='retry'&&syncState!=='auth')syncQueue()`.
- In `loadFromSnapshot()`: `medicines=saved.medicines;` becomes `baseMedicines=saved.medicines;medicines=applyQueue(saved.medicines,queue);`.

- [ ] **Step 4: Verify syntax and suite**

Run: `node --check public/app.js && npm test 2>&1 | grep -A 10 'FAIL'`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/index.html public/styles.css
git commit -m "feat: queue medicine changes offline and sync them on reconnect"
```

### Task 4: Browser verification, handover, release

**Files:**
- Modify: `HANDOVER.md`

- [ ] **Step 1: Verify in the in-app browser against the mock API**

Reuse the slice 1 mock (`<scratchpad>/mock/server.mjs`, with its `/__down` switch) extended to accept `POST /api/batches`, `PATCH /api/batches/:id`, `POST /api/batches/:id/consume|discard` (log each call with body, return the batch or 204), and a switch to answer the next PATCH with `409 { error, current }` where `current.updated_at` is chosen newer or older than the queued edit. Steps: load online; set the API down; reload (offline banner); consume 2 of a medicine, edit its notes, add a new medicine: banner shows "3 changes waiting" and the list shows the changes; reload while still down (queue survives); bring the API up and dispatch `focus`: calls arrive in order with the stored `operationId`s and the banner clears; repeat with a newer server change to see the "replaced by a newer one" notice and with an older one to see the rebase (`PATCH` with the server's revision and a new `operationId`). Confirm saving a medicine with a photo offline is rejected with the photo message and nothing is queued.

- [ ] **Step 2: Handover**

Add `## Offline edits (slice 2)` at the top of `HANDOVER.md`: what shipped, the timestamp rule and clock correction, that the queue is per account-and-Shop, photos are online-only, no server change, and anything not verified (real service worker, real Access expiry).

- [ ] **Step 3: Review, PR, merge, deploy**

Run the code-review skill (medium), fix findings, commit, open the PR, merge. Ask before deploying; deploy with `npm run deploy` (no migration) and report the Worker version.
