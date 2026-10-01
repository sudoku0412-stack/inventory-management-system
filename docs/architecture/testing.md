# Testing approach

Run everything with `npm test` (`node --test`, Node.js 26 or later, no packages to install). Node finds every `test/*.test.js` file.

## What the suites use

| Technique | How | Examples |
| --- | --- | --- |
| Real schema | Each database test creates an in-memory `node:sqlite` database and applies the files in `migrations/` in order, so tests run against the production schema | `admin-console`, `barcode`, `option-lists`, `shop-deletion` |
| D1 adapter | A small adapter in the test exposes D1's `prepare().bind().first()/all()/run()` and `batch()` over SQLite; transaction tests wrap `batch()` in `BEGIN`/`COMMIT` to match D1's atomic batches | `tenants`, `owner-promotion-transactions`, `ownership-transfer` |
| Older schema | `test/deletion-stub.js` adds the deletion view and newer tables to fixtures that apply only older migrations | `tenants`, `worker-invitations` |
| Signed tokens | Tests generate an RSA key pair, sign Access JWTs and pass the JWKS to the Worker, so the real verification code runs | `access-auth`, `admin-console`, `worker-invitations` |
| Worker end to end | Tests call `handleRequest(new Request(...), env, ctx)` with fake `ASSETS`, `PHOTOS` and `KV` bindings | `worker-assets`, `legacy-redirect`, `shop-types-routes` |
| Browser modules | Feature modules take their dependencies (document, request, storage) as arguments, so tests import them directly with small fakes | `change-feed-client`, `stock-alert-strength` (restock rules), `zxing-detector` |
| Source checks | Some UI tests read `public/*.html`, `*.css` or `*.js` and assert on markup, wording or wiring | `generic-wording`, `profile-tabs`, `admin-responsive` |
| Race checks | Tests force constraint conflicts and concurrent batches to prove replay and "exactly one" outcomes | `additional-shop-joins`, `demotion-leave` |

Guard tests worth knowing:

- `worker-assets.test.js`: every module imported by a browser module must be in `publicAssetPaths` and get the bootstrap cache policy, or the app would not start in production.
- `admin-console.test.js`: admin responses never contain item names, notes, photo paths or push details.
- `product-name.test.js` and `generic-wording.test.js`: user-facing names and wording.
- `email-outbox.test.js`, `weekly-digest.test.js`, `email-preferences.test.js`: queueing, sending, retries, cancellation, the weekly summary and the opt-out switches.
- `offline-queue.test.js`: the offline change queue (collapse rules, list preview, replay and conflict handling) and the offline store.
- `service-worker.test.js`: `public/sw.js` run against fakes (cache cleanup, network-first, what it never caches).
- `db-fixture.js` is a shared helper, not a test: an in-memory SQLite database with every real migration applied.
- `shop-terminology.test.js`: the UI says Shop while internal `household` names stay unchanged.

## What tests do not cover

- Real Cloudflare services (D1, R2, KV, Access, cron) and real email delivery.
- Real email delivery (the Resend call is replaced by a stub in `email-outbox.test.js`) and a real browser IndexedDB (`offline-queue.test.js` uses an in-memory fake).
- Real phone cameras and browser layout. Important browser flows and responsive states are checked by hand in a browser before release (see `HANDOVER.md` entries).

Tests are added when a feature or fix needs them; there is no coverage target.
