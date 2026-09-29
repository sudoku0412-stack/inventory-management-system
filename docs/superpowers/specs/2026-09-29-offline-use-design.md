# Offline use — design

Status: draft for review (2026-09-29). No code, migration or deployment has changed.

## Goal

The app opens with no signal, shows the inventory as last synced, and lets a signed-in person add, edit, consume and discard medicines. Those changes queue on the device and sync when signal returns. When an offline change conflicts with a newer server change, the change with the later timestamp wins (user decision, including consumes).

## Out of scope

Photos (upload, capture, Gemini suggestions), settings, Shop access, invitations, notifications, Shop switching and creation stay online-only. Background sync while the app is closed is not included. No server or migration change.

## What exists

- Cloud mutations (`create`, `update`, `consume`, `discard` in `lib/store-d1.js`) carry an `operationId` and a base `revision`. A duplicate `operationId` replays the stored response. A stale `revision` returns 409 with the current batch, including `updated_at` and `revision`.
- `GET /api/batches` returns `changeCursor`; `GET /api/changes` is the online pull feed (`public/change-feed-client.js`).
- `public/sw.js` only handles push. Nothing is cached, so the app cannot load offline.
- The app sits behind Cloudflare Access; an expired session redirects API calls to a login page.

## Approach

Browser-only. The server keeps its current behavior; timestamp resolution happens in the client on top of the existing 409. Alternatives rejected: server-side timestamp resolution (migration and every mutation route change) and a full local database with two-way sync (much larger than the goal).

## Build order

- **Slice 1 — offline read:** components 1 and 2. Releasable on its own.
- **Slice 2 — offline edits:** components 3 to 5, after slice 1 is deployed.

## Components

### 1. App shell cache (`public/sw.js`)

- Precache the same file list as `bootstrapAssetPaths` / `publicAssetPaths` (kept in sync by the existing `test/worker-assets.test.js` rule: a module missing from either list fails the test). Versioned cache name; old caches removed on activate.
- Navigation and asset requests: network first, cached copy when the network fails. `/api/*`, `/admin/*`, `/cdn-cgi/*` and any non-GET request are never cached and never served from cache.
- A redirect to the Access login is not cached. If the network is up but Access answers with a login redirect, the app shows "Sign in again" instead of the cached shell replacing it silently.
- Push handlers stay as they are.

### 2. Saved copy (`public/offline-store.js`, IndexedDB)

- Object store `snapshots`, key `accountContextKey + ':' + shopId`: `{ medicines, changeCursor, settings subset needed to render, savedAt }`.
- Written after every successful `GET /api/batches` and after applied change-feed updates (debounced).
- On load, when `/api/batches` fails with a network error (not 401/403/5xx), render from the snapshot and show a banner: "Offline: showing saved data from <time>". Editing controls stay enabled only once slice 2 ships; in slice 1 they are disabled with the same banner.
- If IndexedDB is unavailable (private mode, blocked), the app behaves exactly as today. Every read and write is wrapped so a storage error never blocks the online app.
- Local (loopback SQLite) mode does not use any of this.

### 3. Change queue (slice 2)

- Object store `queue`, one entry per medicine: `{ key, kind: 'create'|'update'|'consume'|'discard', batchId or tempId, baseRevision, fields, consumeFinalQuantity, operationId, editedAt, tries, state }`.
- Changes to the same medicine collapse into one entry: edit on a queued create changes the create; repeated edits keep the last; consumes accumulate into one final quantity; a discard replaces earlier entries; a discard of a queued create removes both.
- `editedAt` is the device time of the last change. It is stored as-is and corrected at sync (below).
- The medicine list is updated optimistically from the queue so the UI shows the pending change (marked "Waiting to sync").
- A mutation goes to the queue when `navigator.onLine` is false or the request fails with a network error before any response. A 4xx/5xx response is never queued; it is shown as an error as today.
- Queue is per account and Shop; a different account or Shop never sees or replays it.

### 4. Sync and timestamp rule (slice 2)

Triggers: `online`, tab becoming visible, page load with a non-empty queue, and a manual **Sync now**. One replay at a time; entries in creation order.

For each entry:

1. Send the normal request with its `operationId` and `baseRevision`. A create sends as today.
2. `200/201`: remove the entry.
3. `409` with the current batch: compare the entry's corrected `editedAt` with the current batch's `updated_at`.
   - Edit is later: re-send against the current `revision` with a new `operationId` derived from the original, applying the entry's final state. A consume is sent as "set quantity to X", or as a full consume when X is 0.
   - Edit is earlier or equal: drop the entry and record a notice: "1 change was replaced by a newer one."
4. `404` (medicine deleted or purged meanwhile): drop the entry with the same notice.
5. A rebased request that returns another 409 retries up to 3 times, then the entry stays queued in state `needs retry` with a **Retry** button.

Clock correction: at each sync, offset = server `Date` header minus device time (measured on the first successful response). `editedAt` is shifted by that offset and never later than the server time at sync. This limits, but does not remove, the effect of a wrong device clock; that residual risk is accepted with the "latest wins" rule.

Auth: a `401/403` or an Access login redirect pauses the queue (nothing dropped) with "Sign in again to sync N changes". After sign-in the queue resumes.

### 5. Status UI

- Banner states: offline (with saved-data time), waiting (N changes), syncing, all synced, paused (sign in), needs retry.
- Live region announces state changes; banner controls are native buttons with 44px targets; text-safe rendering; usable at 320px and 200% zoom.

## Data and privacy

The snapshot and queue hold the same medicine fields the page already shows (no patient data, no secrets, no tokens, no emails). They are unencrypted browser storage on the device. Storage is cleared for an account key when the account changes. Sign-out through Access cannot be detected offline, so data remains until the next online sign-in as a different account or until browser data is cleared; this is stated in Profile help text.

## Error handling summary

Storage failure: online behavior only. Network error on read: snapshot fallback. Network error on mutation: queue. Auth expiry: pause. Stale change: timestamp rule. Missing medicine: drop with notice. Repeated conflict: needs retry.

## Testing

Server needs no new tests (no server change). Client units with injected IndexedDB, clock and request functions: collapse rules, queue ordering, timestamp rule (later wins, earlier dropped, equal dropped), clock offset correction, 404 drop, retry limit, auth pause and resume, account/Shop isolation, storage-unavailable fallback. Service worker: cache list matches the asset lists, API and non-GET never cached, Access redirect never cached. Manual browser checks: airplane mode load, offline edit then reconnect, two devices editing one medicine, expired session.

Note: the project owner's standing rule is no tests unless asked; add these only if requested.

## Rollout

Slice 1 and 2 are Worker asset changes only (new browser modules go in both asset allowlists). No migration, no secret, no flag. Bump the service worker cache version on each release.

## Open items

None blocking. Chosen defaults: photos online-only; latest timestamp wins for every operation; consume replay is "set quantity".
