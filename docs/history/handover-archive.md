# Handover archive

Older entries moved out of `HANDOVER.md` without changes (except renamed document paths). They describe how the project reached its current state; the code and `docs/architecture/` are the source of truth.

## Weekly medicine check email (2026-09-29, built, not deployed)
- Migration `0028_weekly_digest.sql` (apply BEFORE deploying): outbox kind `weekly_digest` + `payload`, and `digest_enabled` (default on) on `user_email_preferences`. `lib/digest.js` queues one email per person on Monday 14:00-16:00 UTC via the 15-minute cron (dedupe key per person per week); counts of packs expired / expiring within 30 days / low per Shop (Shop name included, no medicine names); Shops with all zero and people with nothing to report get nothing. Cancelled at send time if the person opted out or the row is over 2 days old.
- `GET/PUT /api/email-preferences` now carries `noticesEnabled` and `digestEnabled` (PUT takes either or both); Profile card has a second switch "Weekly summary". Digest counts are packs (batches); the in-app Restock list counts medicines, so the numbers can differ by design.
- Verified with throwaway scripts against the real migrations (window, repeat guard, counts, plurals, opt-out, stale cancel, partial preference update) and the Profile switch in the in-app browser. Real send not exercised. Next in the agreed queue: barcode scan.

## Restock list (2026-09-29, built, not deployed)
- Client-only, no migration. `public/restock-client.js` (list rules, copy text, dialog binding; in both allowlists and `PRECACHE`), button + count on Dashboard and Inventory, `#restockModal` in `index.html`, wiring in `app.js`. Lists expired, expiring within 30 days, low stock; a medicine (name, strength, form, unit) with any healthy or no-expiry batch is left off. Per-row **Add stock** opens the Add form pre-filled (name, strength, form, unit, location; quantity focused); **Copy list**, and **Share** where `navigator.share` exists. Works offline from the optimistic list.
- Verified in the in-app browser against a mock API and a throwaway rules script. Not verified: Share on a real phone.
- Agreed queue for new features: restock list (this), expiry digest email, then barcode scan.

## Offline follow-ups (2026-09-29)
- Offline edits (slice 2) and read (slice 1) are deployed and were confirmed working on the user's phone. Fixed: an empty yellow banner showed online (`display:flex` overrode `hidden`; PR #96).
- Added: per-row "Waiting to sync" mark (optimistic rows carry `pending`), and a "session expired, reload to sign in" banner when the probe or sync sees an Access redirect (`redirect:'manual'` fetch returns `opaqueredirect`) or 401/403; entries stay queued. Verified in the in-app browser against a mock API.

## Offline edits, slice 2 (2026-09-29, built, not deployed)
- Plan `docs/history/2026-09-29-offline-edits.md`. Browser-only, no migration, no server change. `public/offline-queue.js` (pure queue rules: collapse per medicine, optimistic list, replay with the later-timestamp-wins rule on the 409's current batch), `public/offline-store.js` (`queues` store, DB version 2), `public/app.js` (batch mutations queue when offline or on a network error; `syncQueue()`; banner with **Sync now**).
- New module `/offline-queue.js` is in both allowlists and in `PRECACHE`. Queue is per account-and-Shop. Photos stay online-only: a data-URL photo, or removing an existing photo, is rejected offline; `photo: null` on a medicine with no photo is dropped.
- Rulings: no per-row "Waiting to sync" mark (banner counts only); form values are coerced to numbers in the optimistic list (found in browser testing: strings made "12" < "4").
- Verified in the in-app browser against a mock API: offline consume/edit/add queue and survive reload, reconnect sends them in order with stored operation ids, newer server change drops the entry with a notice, older server change rebases (new revision and operation id). NOT verified: real service worker, real Access session expiry, photo rejection click-through.

## Offline read, slice 1 (2026-09-29, built, not deployed)
- Spec `docs/history/2026-09-29-offline-use-design.md`, plan `docs/history/2026-09-29-offline-read.md`. Browser-only, no migration.
- `public/offline-store.js` (IndexedDB: last Shop context + snapshot per account/Shop, in both allowlists), `public/sw.js` (network-first app shell cache, never `/api` `/admin` `/cdn-cgi`, non-GET or redirected responses), `public/app.js` (registers the worker, saves context/snapshot after loads, opens from them on a network error, offline banner, mutations rejected while offline, `online` re-runs `start()`).
- New browser modules must ALSO be added to `PRECACHE` in `public/sw.js` (runtime caching covers drift after one online load). Fonts come from Google, so offline uses system fonts.
- Verified in the in-app browser against a mock API: context and snapshot saved, offline boot shows the banner and saved data, `online` clears it. NOT verified: the service worker (the in-app browser cannot register any worker) and the offline mutation rejection. Check on a real browser: load once online, go offline, reload.
- Slice 2 (offline edits queue with latest-timestamp-wins) is the next plan.

## Email notice opt-out (2026-09-29)
- Migration `0027_user_email_preferences.sql` (apply BEFORE deploying). `GET/PUT /api/email-preferences` `{ noticesEnabled }` (before tenant resolution, account-scoped), Profile card `public/email-preferences-client.js` (both allowlists). Off = no deletion or ownership-transfer emails, applied at queue time and again at send time; invitation emails always send. Default on (no row).
- Next agreed item: offline use (IndexedDB plus a change queue) — needs a design first.

## Admin Email tab (2026-09-29)
- Admin console tab **Email** lists unsent outbox rows (queued, failed, uncertain) via `GET /admin/api/email-outbox`; Overview shows "Emails needing attention" and "Emails queued". No migration. Resend domain `craftloop.ca` is verified; DMARC is Cloudflare's single record.
- Cleanup: a stray `build.log` was committed in #91; removed and git-ignored here.

## Email chunk 3: Owner-role invitations (2026-09-29)
- Migration `0026_owner_role_invitations.sql` (rebuilds `household_invitations` with role IN member/owner; adds `role` to acceptance receipts). Apply 0026 BEFORE deploying.
- `POST /api/household/invitations` accepts optional `role` (`member` default, `owner`; anything else 400). Acceptance grants exactly the persisted role, enforces the 5-owned-Shops cap for Owner invites, and replays report the receipt role. Pending list and join response now carry `role`; client decoders accept only member/owner.
- UI: Role select on the invite form, Owner-aware pending list, join dialog ("Access: Owner" plus authority warning), email wording. Email chunks 1-3 are all built; 1 and 2 are live (Worker `ac39e43c`).

## Email chunk 2: deletion and transfer notices (2026-09-29)
- Migration `0025_notification_outbox_kinds.sql` (rebuilds the outbox: new kinds, `deadline` column). Apply 0025 BEFORE deploying, or deletion/transfer fail on the CHECK.
- Deletion queues one notice per other member (deadline = purge date); cancelled at send time if the Shop was restored or purged. Transfer queues one notice to the new Owner. No Shop name in either email.
- Chunk 1 (0024, invitation notices) is live: Worker `bf4d5ee8`, test email delivered via Resend. Next: chunk 3 (Owner-role invitations).

## Email chunk 1 built, not committed or deployed (2026-09-29)
- Migration `0024_notification_outbox.sql`, `lib/email-outbox.js` (enqueue statement, lease/retry/cancel dispatcher, Resend send with idempotency key, 30-day prune), invitation-created notice queued in the same D1 batch as the invitation in `createHouseholdInvitation`, dispatcher + prune in the cron (`worker/index.js`). Apply 0024 BEFORE deploying.
- Sender stays off until `RESEND_API_KEY` (secret), `EMAIL_FROM` and `APP_URL` (https) are all set. Rows queue meanwhile; a still-pending invitation is sent once enabled, stale ones are cancelled.
- Full suite 314 pass (existing fixtures got the outbox schema). Dispatcher smoke-checked with a throwaway script; no new tests (user rule). Next: chunk 2 (deletion + transfer notices), chunk 3 (Owner invites).

## Transactional email and Owner invitations — design checkpoint (2026-09-29)
- Architecture is finalized in `ARCHITECTURE.md`; no application code, migration, provider account, secret, DNS record, deployment, or production data changed in this checkpoint.
- Provider choice: Resend HTTP API, initially on the free tier, with a D1 transactional outbox and the existing 15-minute cron. Business mutations commit independently of email delivery; stable event keys prevent duplicate sends on retry.
- Small implementation order: (1) migration 0024 + sender foundation + Member invitation notices, (2) deletion and ownership-transfer notices, (3) direct Owner-role invitations. Update this handover after every completed chunk.
- Required external setup before enabling delivery: create/verify a Resend sending domain, publish its SPF/DKIM/DMARC records, create a send-only API key, store it as the Wrangler secret `RESEND_API_KEY`, configure the From address, and enable the sender only after a controlled test. Keep delivery disabled when configuration is absent.
- Privacy boundary: transactional only; no medicine, inventory, patient, member-list, token, or secret content. Invitation email links to the app and requires sign-in with the invited address; it is not a bearer link.
- Usage checkpoint: weekly Codex capacity was at 3%, so implementation was intentionally not started without enough room for implementation, tests, review, and a safe checkpoint.

## Creation limit message fix (2026-09-29)
- Manual production data change (2026-09-29, run by the user): deleted one `shop_creation_receipts` row (the "test delete" Shop, created 16:54 UTC) from the remote D1 so the account could create a Shop before the 24-hour window ended. Only the rate-limit record was removed; the Shop itself stays soft-deleted and restorable from `/admin` until its purge date. Not a code change and not repeatable through the app.
- Reported "We couldn’t confirm creation" was the server's rolling limit (one created Shop per user per 24 hours, 429), not a failure; deleted Shops keep their creation receipt so the limit still counts them. `creationFailure` in `public/shop-creation-client.js` now shows the server's "You can create one Shop every 24 hours" text and drops the saved intent; other 429s and 5xx still say retry. No server or migration change.

## Per-Shop feature flags (2026-09-29)
- Migration `0023_shop_feature_flags.sql`, `lib/feature-flags.js` (registry: `shop_deletion`, `shop_purge`), `adminSetShopFlag` (`POST /admin/api/shops/:id/flags`), admin Shop page section **Feature flags for this Shop** (Turn on / Turn off / Follow global, each with a reason). Overrides beat the global secrets and apply on the next request. Apply 0023 BEFORE deploying (the code reads and writes the new table and history event).

## Current state summary (2026-09-29)
- Everything requested in this session is built, deployed and tested by the user in production: icon, ownership transfer, Shop deletion with owner-chosen keep days, admin revoke/restore/extend (with Shop-history rows), admin Sign out, roster layout fix. Migrations 0001 to 0022 are applied. Flags `ADMIN_WRITES_ENABLED`, `SHOP_DELETION_ENABLED`, `SHOP_PURGE_ENABLED` are all set. Latest Worker: `fbed3ba4-0b39-4054-882f-eeaedf85ed4a`.
- The local SQLite import tool (`tools/export-local-to-d1.js`) is merged but has never been run against real data (the user has no local data to import).
- Deploy rule reminder: apply migrations first, then `npm run deploy`; new browser modules go in both asset allowlists.
- Working rule from the user: one agent at a time, no multiple background agents.
- Docs refreshed in this pass: `README.md`, `ARCHITECTURE.md` (status notes), `docs/deployment.md` (flags).

## Shop deletion released (2026-09-29)
- PR #73 merged as `f2a30c8`. Remote migration `0020_shop_deletion.sql` applied, then Worker deployed: version `f27c3e78-6559-4f14-b8ae-79de4af18b50`. `SHOP_DELETION_ENABLED` and `SHOP_PURGE_ENABLED` are NOT set: the delete route returns 404, the card is hidden, and the cron purge only logs a dry run. User decision: turn deletion on only after admin restore is live.

## Extension in Shop history (2026-09-29)
- Migration `0022_shop_extension_audit.sql` allows `shop_extended`; an admin **Extend deadline** now also writes it to the Shop's own history (no admin identity), atomically with the `admin_audit` row. Apply 0022 BEFORE deploying (the new code inserts the event). Stray agent worktrees and their branches were deleted (their work is in main).

## Purge days option (2026-09-29)
- Owners choose how long a deleted Shop is kept when deleting: `keepDays` 7 to 30 (default 14) in `POST /api/household/delete`, number field in the delete dialog. Admin can extend a pending Shop's deadline (later only, counted from now, 7 to 30 days) with `POST /admin/api/shops/:id/extend` `{ operationId, reason, keepDays }`, audited as `shop.extend` in `admin_audit` (and, from 0022, `shop_extended` in the Shop history). No migration for this step.
- Purge is enabled (`SHOP_PURGE_ENABLED`), so a Shop is permanently removed at its own `purge_after`.

## Flags enabled (2026-09-29)
- `ADMIN_WRITES_ENABLED` and `SHOP_DELETION_ENABLED` are set as Worker secrets; the user tested delete, restore, revoke, sign-out and the other pending checks and confirmed all good. Admin console has a Sign out link (PR #76, Worker `8f4b4c52-e945-458f-9f05-67a18902ab2b`).
- `SHOP_PURGE_ENABLED` is now set too (2026-09-29): the 15-minute cron permanently purges each deleted Shop 14 days after deletion (photos first, then rows; tombstone kept). Nothing is due before 2026-10-13. To stop it, `npx wrangler secret delete SHOP_PURGE_ENABLED`.

## Admin write actions released (2026-09-29)
- PR #74 merged as `a03c6bf`. Remote migration `0021_admin_writes.sql` applied, then Worker deployed: version `39064e00-2849-4b5c-801c-ec2ccc5fec55`. Ownership transfer is live (`fdc19e22`), Shop deletion is deployed with its flag off.

## Admin write actions implemented
- Migration `0021_admin_writes.sql` (`admin_audit.reason`, `operation_id`, unique `(admin_email, operation_id)`). `revokeInvitationCore` (household-access) is shared by owners and admin; `adminRevokeInvitation`/`adminRestoreShop` in `lib/admin.js`; `restoreShopStatement` in `lib/shop-purge.js`.
- Routes `POST /admin/api/shops/:id/invitations/:invId/revoke` and `POST /admin/api/shops/:id/restore`, body `{ operationId, reason }` (10-500 chars). Off (403) unless `ADMIN_WRITES_ENABLED=true`. Requires JSON, exact Origin, no cross-site, header `X-Admin-Action: 1`; 30 writes/minute per admin. The admin row is in the same batch as the mutation and the Shop's own history gets an `invite_revoked`/`shop_restored` row with no admin identity.
- Console UI: Revoke on pending invitations, Restore Shop (typed name + reason) inside the grace period, banner shows "Changes are audited" when enabled. Restore does not bring back deleted invitations or push subscriptions.
- Not browser-verified. Full suite 285.
- Rollout: apply 0021, deploy, `wrangler secret put ADMIN_WRITES_ENABLED` = `true`, exercise revoke on a test invitation and check both audit rows; then enable `SHOP_DELETION_ENABLED` when ready.

## Shop deletion implemented, flag off (branch cursor/shop-deletion)
- Migration `0020_shop_deletion.sql`: `household_deletions` side table (not columns on `households`, so positional inserts and readers stay valid), `active_memberships` view, `shop_deletion_receipts` with guard trigger, audit events `shop_deleted`/`shop_restored`/`shop_purged`.
- Every Shop reader in `lib/tenants.js`, `lib/household-access.js` and the scheduled push enumeration now reads `active_memberships`; writes still use `memberships`. Pending-invitation discovery also hides deleted Shops. New code REQUIRES 0020: apply it before deploying the Worker. Test fixtures that apply only older migrations add `test/deletion-stub.js`.
- `deleteHousehold` (`lib/household-access.js`), route `POST /api/household/delete` (404 unless `SHOP_DELETION_ENABLED=true`), 14-day grace, sole-Shop 409, name confirmation, invitations and push removed at once. `GET /api/household/access` returns `shop_deletion` so the UI shows the owner-only **Delete this Shop** card only when enabled (`public/shop-deletion-client.js`, both allowlists).
- `lib/shop-purge.js` runs in the 15-minute cron in DRY-RUN unless `SHOP_PURGE_ENABLED=true`: photos first, a photo failure keeps rows for retry, tombstone `households` row renamed `(deleted Shop)`.
- Not built: restore (admin write action 0021 comes next), owner self-service "Recently deleted". Not browser-verified. Tests: `test/shop-deletion.test.js` (10). Full suite 276.
- Rollout: apply 0020, deploy (flag off), verify existing flows, then `wrangler secret put SHOP_DELETION_ENABLED` = `true`; enable `SHOP_PURGE_ENABLED` only after a week of dry-run logs.

## Expiry icon, local import tool, three approved designs (2026-09-29)

- Expiry field shows a decorative calendar icon (CSS background; input height/behavior unchanged). Not browser-verified: check the 44px height and icon on the original iPhone.
- `tools/export-local-to-d1.js` (offline; never touches remote) turns a local `data/inventory.sqlite` into a D1 SQL file plus an R2 upload script. The target Shop must already exist. Steps in `docs/deployment.md` ("One-time import"). Not run against production.
- `ARCHITECTURE.md` has three designs approved by the user, NOT implemented: ownership transfer (0019), Shop deletion (0020, soft delete + 14-day grace, ships behind a flag), admin write actions (0021, kill switch off by default, restore only after deletion exists). Build in that order, one at a time.
- User rule: use only one agent at a time; no multiple background agents.
- No migration in this release.
- Deployed Worker `6c105f14-344e-416d-a9cd-fff869b2c233` for the icon and import tool.

## Ownership transfer released (2026-09-29)
- PR #70 merged as `87d0dda`. Remote migration `0019_shop_ownership_transfer.sql` applied, then Worker deployed: version `fdc19e22-ebc2-4840-9c44-3d4d2f2e214b`.
- `transferHouseholdOwnership`, route `POST /api/household/members/:userId/transfer`, `public/ownership-transfer-client.js` (in both asset allowlists), **Transfer ownership** roster button and dialog. The page reloads after success. `test/ownership-transfer.test.js` (10). Full suite 265.
- Signed-in check pending: transfer to a Member with two accounts, confirm the roster and owner-only cards on both sides, and the dialog on a phone width. Not browser-verified.
- Next in order: Shop deletion (0020), then admin writes (0021), both approved designs in `ARCHITECTURE.md`.

## Profile Shop invitations card (implemented and deployed 2026-09-29)

- Implements the cloud-only Profile **Shop invitations** card and join dialog from `ARCHITECTURE.md` in `public/shop-invitations-client.js`, bound from `app.js`; no server, migration, or secret change. Deploy is Worker/UI only (the file is in the Worker bootstrap-asset allowlist).
- Exact decoders for pending `{ invitations, nextCursor, member }` (also used by the unaffiliated gate; `member` is validated then dropped) and acceptance `{ householdId, role, accepted }`. `requestShopApi` now exposes a validated `retryAfter`, and `isShopScoped` ignores query strings so paginated discovery never sends `X-Shop-Id`.
- Join intents persist in session storage keyed by account before dispatch; ambiguous outcomes keep the same intent (**Retry joining**, or **Check previous join request** after reload). Confirmed joins merge only the refreshed membership list; the active Shop, preference and dirty Profile fields are untouched, and **Switch to <Shop>** reuses the existing switch path (`switchToShopId`).
- Verification: `npm test` 170/170 (24 new tests with real payload fixtures). A Chrome run against a temporary mock API confirmed placement, dialog focus/Escape, 503 -> Retry joining -> success, selector unchanged, and 320px/200% layout without horizontal scroll.
- PR #55 is on `main` (`c50e889`) and was deployed with `npx wrangler deploy` as Worker version `594305e9-3f27-41c2-8d37-e111b745e7e2` (100%). The D1 ledger reported no pending migrations, so none were run. From the agent VM the custom domain answers with a Cloudflare bot challenge (403, `cf-mitigated: challenge`) on `/`, `/index.html` and `/api/*`, and the expected Access 302 on static asset paths, so the browser flow could not be exercised from there.
- Incident (same day): the first deploy (`594305e9`) left the app unable to start because `/shop-invitations-client.js` was missing from `publicAssetPaths` in `lib/shared.js`, so the Worker returned 404 for the module `app.js` imports. Fixed on `main` and redeployed as Worker version `73cf4508-d648-4c4f-850f-b0ef3c4e2206`; `test/worker-assets.test.js` now fails if any module imported by `public/*.js` is missing from `publicAssetPaths` or the bootstrap cache list. Lesson: unauthenticated `302` checks only prove Cloudflare Access is in front; they cannot prove assets are served, and the mock-API browser run did not enforce the Worker allowlist. Add a new browser module to `lib/shared.js` `publicAssetPaths` AND `worker/index.js` `bootstrapAssetPaths`.
- Update (2026-09-29): the user confirmed the app opens again after the asset fix and that authenticated join/replay/switch and the accessibility/responsive checks for the Shop invitations card were done and working. Still open from earlier releases: owner-promotion checks with two Owners and a separate Shop.
- Next chosen slice: online pull/change feed for inventory. The design is in `ARCHITECTURE.md` ("Design: online pull/change feed"); no code or migration exists yet. Migration would be `0015_batch_change_feed.sql`.

## Current Shop role label overlap fix (2026-09-27)

- The Profile Current Shop card's `Your role: Owner` label used a negative top margin, which could overlap the native Shop select on narrow iPhone widths and at 200% zoom.
- Changed `.shop-role` to use explicit positive spacing (`margin: 8px 0 16px`) so the role/status text stays below the select without changing the switch-status behavior or wider layout structure.
- Added a focused CSS contract assertion in `test/shop-selector-ui.test.js`; the focused selector suite passes (7/7), the full suite passes (111/111), and `git diff --check` is clean.
- PR #49 merged as `fd62249897f5dba921acc044f37fe7d8b203c539` and was deployed to production as Worker version `47b64a50-81ca-409a-b515-863c36fd4fb3`. The custom domain returned the expected Cloudflare Access 302 with private/no-store headers. No migration, Access, DNS, or secret change was needed.

## Owner promotion implementation and deployment (2026-09-27)

- Finalized in `ARCHITECTURE.md`: **Make owner** promotes an already accepted Member of the current Shop to the existing Owner role. Multiple equal Owners provide administration without an admin schema/tier; the acting Owner keeps ownership. Separate membership rows retain isolation across Shops.
- Added owner-only roster `user_id` and POST `/api/household/members/:userId/promote` with `{ operationId }`, mandatory pinned Shop header, strict same-origin JSON, fresh owner checks, five-owned-Shop target cap, receipt/audit, and safe no-op/replay. Migration `0013_shop_owner_promotion.sql` widens audit events with `member_promoted` and adds receipts.
- Smallest slice excludes demotion, removal, resignation, transfer and additional invitation joins. Today's acceptance rejects users who already have a membership; a target must already belong to this Shop. Additive promotion cannot remove its last Owner; future destructive endpoints need serialized last-owner guards and stronger lifecycle concurrency design.
- The route dispatches before `resolveTenant`, uses a read-only identity/membership join for its mandatory pinned Shop header, and leaves preferences untouched. The scheduler now selects each distinct Shop once using `MIN(user_id)` as stable owner context, preserving Shop-wide recipient delivery and expired-endpoint cleanup. Earlier phase-specific owner/admin-promotion deferrals are superseded by this design; the separate admin tier and destructive role changes remain deferred.
- Senior review follow-up closed the strict pinned UUID, route-validation ordering, missing-schema 503, durable UI success/reload/focus, and integrated scheduled-delivery blockers. The promotion controller reads access/context in place and preserves dirty Profile fields; a failed refresh keeps the confirmed Owner result and offers a read-only **Reload Shop access** action. Owner labels and the access heading are programmatically focusable. Same-page ambiguous retries retain their captured operation/account/Shop/target; close/reopen cannot duplicate or retarget an in-flight request.
- Transaction hardening makes the Member→Owner UPDATE depend on its receipt, rechecks verified identity and owner authority in the batch, and forces the audit NOT NULL guard to abort a zero-row transition. Failed receipts, updates, or audits roll back all mutation effects. Observed authorization/cap/race outcomes resolve explicitly; unexplained database failures remain retryable server errors.
- Verification checkpoint: `npm test` passes **111/111**, including 14 real SQLite transaction/migration/race tests, 7 DOM/controller/layout-contract tests, route validation/preference-neutrality coverage, and the actual scheduled handler with the default D1 store, valid VAPID signing, three Owners in Shop A, Shop B, multiple recipients, an ownerless control, and one 410 endpoint belonging to a nonselected Owner. Only that expired subscription is deleted; eligible notifications are marked pushed and each Shop endpoint is contacted once. App/controller/Worker/access/tenant syntax checks and `git diff --check` pass. Wrangler dry-run build passes: 102.58 KiB, gzip 22.09 KiB. Temporary loopback test servers were explicitly permitted; no remote mutation occurred.
- PR #47 was reviewed, merged to `main` at `67ceb71773d9fa6d8accf5ca675ff61e779e1ec4`, and deployed after applying production D1 migration `0013_shop_owner_promotion.sql`. The migration ledger reports no pending migrations. Production Worker version: `074bd9da-aa0f-42ff-97a2-02df9a689c04`. The custom domain returned the expected Cloudflare Access 302 with private/no-store cache headers; no Access, DNS, or secret changes were made.
- Remaining acceptance check: the 320px/200% checks are DOM/CSS contract tests, not a real browser or screen-reader run. Verify authenticated responsive promotion/retry/isolation/access with two Owners and a separate Shop when suitable test accounts are available. This is verification only; implementation, migration, and deployment are complete.

## What is on `main` (merged)

| PR | Topic |
| --- | --- |
| Phase 1 (1606a91) | Dashboard, inventory, in-app expiry reminders |
| #1 | Monthly cabinet check button |
| #2 | Packaging photos + confirmed suggestions |
| #3 | Web push expiry alerts (service worker) |
| #4 | Gemini packaging scan |
| #5 | `app.js` parse fix + form `autocomplete` |
| #6 | Live camera for **Take photo** (Chrome / phone HTTPS) |
| #8 | Always-on Cloudflare deploy (Worker, D1, R2, KV) |

**Open PRs:** none (as of last check).

**Follow-up on `main` after #8:** pin D1/KV ids in `wrangler.toml`, R2 setup notes, trust Access edge header for API after login, `credentials` on API `fetch` — landed via handover branch / small PR if not yet merged.

## Delivered behavior

- Batches: name, strength, form, quantity, unit, low-stock threshold, expiry (or unknown), location, notes; consume / discard; status filters and search.
- Optional pack photos (JPEG/PNG/WebP, 2 MB). **Take photo** uses camera on HTTPS; **Upload photo** uses file picker. Gemini suggests name/expiry when `GEMINI_API_KEY` is set; saving the form is confirmation.
- In-app 30-day expiry reminders; optional **Enable expiry alerts** (web push). Cloud cron delivers push on Workers; local uses `npm start` timer.
- Expiry rules: date-only calendar math, 30-day warning window.

## Phase 2 — done

1. Monthly cabinet check button (PR #1).
2. Packaging photos + AI suggest + confirm (PR #2, #4, #6).
3. Expiry delivery when app closed — web push (PR #3).

## Phase 3 — done (deploy)

Always-on hosting at **medicineinventory.craftloop.ca** without a home Mac or tunnel: Worker API, D1 inventory, R2 photos, KV for VAPID, Access login, Gemini via secret.

**Not done:** automatic import from an existing local `data/inventory.sqlite` into D1.

## Phase 4 — Profile & settings

Profile & settings is a single, local-household screen. It persists a display name (1–60 characters), household name (1–80 characters), and default storage location in both SQLite and D1. The default applies only when creating a new medicine; existing rows are not rewritten. The API is `GET`/`PATCH /api/settings`; production requires D1 migration `0003_profile_settings.sql`.

This phase intentionally excludes authentication, household sharing, cloud data sync, exports/deletion, themes, and configurable reminder windows.

## Phase 5 — Identity, tenant foundation, and household administration

Production API requests validate a signed Cloudflare Access JWT (signature, issuer, audience, and expiry); edge email headers are never accepted as identity. D1 now has tenant-scoped users, Access identities, households, memberships, household settings, and inventory/push records. One configured bootstrap owner atomically claims legacy rows. The migration and Worker deployment completed on 2026-09-25 (Worker version `4b2d9873-185f-4906-bf42-6cf92171369b`); `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `INITIAL_OWNER_EMAILS` are configured as production secrets. Local SQLite remains loopback-only and single-user.

Owner-only household administration is now implemented for Cloudflare/D1: `GET /api/household/access`, `POST /api/household/invitations`, and `DELETE /api/household/invitations/:id`. Migration `0005_household_invitations.sql` stores normalized, pending member invitations only; it never grants membership. Local SQLite remains a single-household workflow and explains that cloud access is required. The Profile UI isolates invitation loading/errors from medicine data, and hides roster controls from non-owners.

Migration `0005_household_invitations.sql` was applied to production D1 and the reviewed Worker was deployed on 2026-09-25 as version `00a374f7-f760-462d-b46d-02df92b06416`; a follow-up migration check reports no pending migrations. **Next safe step:** test the owner flow in Cloudflare Access. A future, separately designed chunk may add invitation acceptance after it verifies the signed-in provider-and-subject identity. Do not add automatic enrollment, resends, role changes, or member removal to this chunk. Apple and Google remain Cloudflare Access identity-provider configuration; no client-side OAuth secrets are stored in the repository.

## Phase 6 — invitation acceptance (deployed 2026-09-25)

- PR #15 (`3dcf9ce`, “Add secure household invitation acceptance”) is merged on `origin/main`. Production D1 migration `0006_household_invitation_expiration.sql` was the only pending migration, was applied successfully, and the final ledger contains 0001, 0003, 0004, 0005, and 0006 with no pending migrations.
- `GET /api/household/invitations/pending` and explicit `POST /api/household/invitations/:id/accept` authenticate a Cloudflare Access JWT before (and independently of) tenant resolution. Pending returns unexpired matching invitations plus a membership boolean solely so an existing member is never gated by an unrelated invite. Acceptance binds only the verified provider, subject, and normalized signed email; it never accepts an email, household, or role from the client.
- Acceptance uses one D1 batch transaction with matching invitation predicates on every write. It consumes the invitation only after membership exists; identity uniqueness conflicts roll the whole batch back. Existing identities without memberships are reused; any existing membership is a 409 conflict. Bootstrap/legacy ownership is never invoked by these routes.
- The browser gates cloud identities before loading normal inventory UI. It offers an accessible, explicit Accept action and terminal/retry states; local server behavior stays unchanged.
- The Worker was deployed with `npm run deploy` as version `b882eeab-edc1-49bc-b245-e51e74e19df9`; no Access or DNS configuration was changed. A safe unauthenticated `HEAD`-equivalent HTTPS header check returned `302` from `https://medicineinventory.craftloop.ca/` to the Cloudflare Access login. Next step: test invitation acceptance end-to-end with an authenticated invited account.

## Form and unit choice compatibility (2026-09-26)

- New medicine entries distinguish a clinical **Form** (Tablets, Capsules, Liquid, Cream, Inhaler, Drops, Other) from a countable **Unit** (bottle, sachet, tube, pack, tablet, capsule, dose, piece).
- No migration is needed: API validation continues to accept the pre-existing `Syrup` form and plural/`ml`/`units` unit values. When an old record is edited, its saved value is retained as a marked saved option rather than being silently rewritten; those saved-only options are removed before a new entry or another edit is opened.

## Identity-derived profile name (pending merge)

- New household settings are seeded from the signed Cloudflare Access JWT `name`/`common_name` claim. If neither claim is present, they use a sanitized email local-part. Migration `0008_household_display_name_source.sql` marks all existing settings as user-owned—including any intentionally named “Kaushik”—and newly created settings as identity-seeded. The browser never supplies identity data.
- Deploy migration `0008_household_display_name_source.sql` after `0007_sync_mutation_foundation.sql` and before the Worker. No secret changes are required; `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `INITIAL_OWNER_EMAILS` remain required for production.

## Display-name identity-seed compatibility fix (deployed 2026-09-26)

- Reported impact: `kmaz285@gmail.com` saw the inherited legacy profile name `Sudoku` in Profile and the greeting, despite a verified Access identity.
- Root cause: bootstrap copied the pre-identity local profile into `household_settings`; 0008 conservatively labelled it `user`, which correctly prevented replacement but incorrectly treated an inherited/default value as an explicit save.
- Migration `0009_seed_legacy_household_display_names.sql` is the explicitly authorized one-time compatibility rule: it changes every pre-0009 `user` marker to seed-eligible `default`, including inherited/default values such as `Sudoku`. Because no earlier edit audit exists, this can also replace a historic explicit name on that household's next authenticated settings read. Only the verified JWT `name`/`common_name` (or sanitized email local-part fallback) may replace it and records `identity_seed`. New bootstraps also label copied local profiles `default`. A later `PATCH /api/settings` records `user` and is never re-seeded.
- Migration `0009_seed_legacy_household_display_names.sql` was applied after 0008 and the Worker was deployed successfully. No Access, DNS, or secret changes were required. Verify the authenticated Profile and dashboard greeting for the reported account after deployment.

Do not launch Cursor cloud agents for this project. Read this file at the start of a new chat. Do not re-fix completed Phase 2 items unless a regression is found.

## Cache-policy checkpoint (2026-09-25)

- Diagnosis: the Worker forwarded `ASSETS.fetch()` responses without overriding cache headers, allowing Safari/edge to retain an old authenticated shell or bootstrap bundle after deployment.
- Fix: `worker/index.js` applies `no-store` to `/index.html`, `no-cache, must-revalidate` to `/app.js`, `/styles.css`, and `/sw.js`, and immutable caching to image assets. API routing is unchanged.
- Tests: added `test/worker-assets.test.js` for shell/bootstrap policies and the asset response path. No commit, push, or PR was created in this delegated worktree.
- Follow-up diagnosis: `.invite-gate { display: grid; }` overrode the browser’s `[hidden]` rule, so `showApp()` could not hide the invitation gate. Added `.invite-gate[hidden] { display: none; }` and a regression assertion.
- Living bug process: see `docs/bugfix-plan.md` for the evidence-first triage checklist, incident log template, communication expectations, and the invitation overlay incident record.

## Production deployment follow-up (2026-09-25)

- PR #17 (`6cad65f8424940b56566155adf018e002453acf2`) was verified merged into `main`.
- Redeployed the merged Worker with the existing Wrangler configuration to `medicineinventory.craftloop.ca`.
- Remote D1 migration status reported **no migrations to apply**; no migration was run.
- Cloudflare deployment version: `765ec7f5-94dc-452c-a925-f4b8abdb3b3c`.
- Unauthenticated HTTPS check returned the expected Cloudflare Access `302` redirect to the Access login endpoint. No Access or DNS settings were changed.

## Sign-out follow-up (2026-09-25)

- Profile & settings now includes an accessible **Sign out** link to the same-origin Cloudflare Access endpoint `/cdn-cgi/access/logout`. It does not add an application-side session or change Access/DNS configuration.
- This ends the user's Cloudflare Access session, which Cloudflare documents as applying across Access-protected applications. Verify on the deployed custom domain after merge.

## Online inventory sync foundation (implementation pending review)

- First data-sync slice only: D1 remains the server source of truth, and every cloud batch now has an integer `revision`. Browser create, edit, consume, and discard requests include a UUID `operationId` plus `baseRevision`; local SQLite continues to accept the extra fields without adding an offline queue.
- Additive production migration: `0007_sync_mutation_foundation.sql`. It adds `batches.revision` (default `1` for existing records) and tenant-scoped `mutation_receipts`. A replay of the same operation ID returns the recorded result without applying the change again. A stale revision returns `409` with the current batch, and the UI reloads that batch and asks the user to review and retry.
- Focused tests cover the migration schema/default, idempotent create/update replay, stale conflict with the current revision, and same operation IDs isolated between households. Full suite: `npm test` — 42 passing.
- Retry safety follow-up: each browser action retains its operation ID and base revision through an ambiguous network failure, timeout/rate limit, or server error. It clears only after success, a definitive client/validation error (including a 409 conflict), or an explicit new action. This prevents a retry from duplicating a create, consume, or discard. A concurrent duplicate create that had already uploaded a separate photo now removes the losing R2 object after replaying the receipt.
- This slice deliberately does **not** add IndexedDB, an offline mutation queue, a change feed, merge UI, background reconciliation, auth changes, notifications, or photo-sync redesign. The next safe step, after production migration and verification, is a separately scoped pull/change feed design.
- Operational note: operation receipts are retained indefinitely in this first slice; establish a retention policy before high-volume sync usage.

## Production deployment follow-up (2026-09-25)

- PR #19 (`e50bc03`) is merged to `main` and deployed to `medicineinventory.craftloop.ca`.
- Cloudflare Worker version: `fbcecb56-1043-445f-bd29-a83680165c6c`.
- D1 migration check reported **No migrations to apply**; no migrations were run.
- Unauthenticated custom-domain verification returned HTTP 302 to the Cloudflare Access login endpoint. No Access or DNS configuration was changed.
- Browser sign-out was not exercised because it requires a real authenticated user session.

## Greeting follow-up (2026-09-26)

- The dashboard greeting now derives from the browser's local hour: night (21:00–04:59), morning (05:00–11:59), afternoon (12:00–16:59), and evening (17:00–20:59).
- `public/greeting.js` keeps the time classification pure and explicit; fixed-hour regression coverage avoids dependence on the test machine clock or timezone.
- The greeting helper is included in the shared public-asset allowlist and has a Worker route regression test.

## Mobile medicine dialog stability follow-up (2026-09-26)

- Reported symptom: opening Add medicine or switching from a medicine detail to Edit medicine on a phone could briefly move the form outside the visible viewport before it snapped back.
- Confirmed source cause: the mobile native dialog used legacy `vh` sizing plus auto margins for bottom-sheet placement, while a delayed focus call could scroll the dialog after it opened. Dynamic packaging preview content could also trigger scroll anchoring.
- Fix: mobile dialogs are explicitly fixed to the bottom of the dynamic viewport, contain overscroll, and disable scroll anchoring. The medicine dialog resets its own scroll position after opening and focuses the medicine name with `preventScroll`, preserving keyboard access without moving the viewport. The expiry-date row is intentionally unchanged.
- Regression coverage: `test/mobile-medicine-dialog.test.js` asserts the mobile viewport/scroll rules, opening focus behavior, edit transition, and the intended expiry field.

## Expiry-date field follow-up (2026-09-26)

- The medicine form now has an explicitly labelled expiry date, concise help text, and an accessible **I don’t know the expiry date** checkbox. The checkbox records the existing `null` expiry value; it clears and disables the date field so the two states cannot conflict.
- Editing an existing unknown-expiry medicine initializes that state correctly; opening a new form and a confirmed package-date suggestion restore an editable date field.
- Checkbox styling is narrowly scoped so it remains a standard, touch-friendly control on mobile instead of inheriting the date input’s full-width/height styles. The Form/Unit choices and mobile dialog dynamic-viewport work are preserved.
- Regression coverage: `test/expiry-date-field.test.js` covers known/unknown state behavior, and the existing mobile-dialog test now covers the intended expiry markup and control sizing.

## Expiry-date deployment (2026-09-26)

- PR #27 (`6815df4`, “Restore accessible expiry date controls”) is merged and deployed to `medicineinventory.craftloop.ca`.
- Worker version: `144978e3-3fc7-45b0-99e0-e294c03496b7`.
- Remote D1 status reported no pending migrations; unauthenticated custom-domain verification returned the expected Cloudflare Access HTTP 302 redirect.

## Expiry-date mobile control follow-up (2026-09-26)

- The expiry field now uses a compact 44px mobile control consistent with the adjacent medicine fields. Safari’s visible native calendar indicator is hidden, while the native date input, keyboard behavior, and assistive-technology semantics remain available.
- The unknown-expiry checkbox and package-suggestion flows are unchanged. `test/mobile-medicine-dialog.test.js` guards the compact class and indicator rule.
- PR #34 was merged and deployed to `medicineinventory.craftloop.ca` as Worker version `dd57709e-00d9-4295-9c6e-b77d3b06e56e`. The remote D1 ledger reported no pending migrations, and the custom domain returned the expected Cloudflare Access HTTP 302 redirect.
- Follow-up evidence from the production iPhone showed the icon was removed but the native input remained oversized. The next patch replaces the ineffective minimum-only rule with a scoped iOS appearance reset and strict 44px physical/logical height bounds. Do not mark the incident closed until the reporter confirms the deployed field on the original device.
- PR #36 (`a0bcb34`, “Fix iPhone expiry field height regression”) was merged and deployed to `medicineinventory.craftloop.ca` as Worker version `a1505559-c94d-4767-8c87-96fa7ccb53ad`. No database migration was required. An unauthenticated production asset request reached the expected Cloudflare Access HTTP 302 boundary; final acceptance remains the reporter's signed-in check on the original iPhone.
- The reporter confirmed the field height is correct on the original iPhone. The missing calendar icon is accepted as a separate, deferred enhancement; the height regression is closed.

## Shop terminology follow-up (2026-09-26)

- User-facing product language now calls the shared inventory a **Shop** across the public UI, invitation/access flow, profile validation, and surfaced authentication, membership, and push-subscription errors.
- Database tables and fields, API routes, internal DOM hooks, migration names, and invitation payload contracts intentionally remain `household`-scoped for compatibility. `test/shop-terminology.test.js` guards the rendered copy and user-facing messages while explicitly checking those internal contracts remain unchanged.

## Shop terminology deployment (2026-09-26)

- PR #29 was conflict-resolved, reviewed, squash-merged, and deployed to `medicineinventory.craftloop.ca`; no D1 migration was required for this copy-only release.
- Cloudflare Worker version: `abdd211c-4434-4b30-a731-bc21e677cae9`.
- Full test suite passed: `npm test` — 58 passing.

## Active multi-Shop context (deployed 2026-09-26)

- Migration `0011_user_shop_preferences.sql` adds a per-user last explicitly selected Shop preference. It is advisory only: every request revalidates the selected membership.
- Authenticated `GET /api/shops` returns only the caller's Shop ids, names, and roles with the active Shop id. `X-Shop-Id` is accepted only for a current membership, persists that selection, and invalid selectors are rejected. Without it, resolution uses a valid saved preference then deterministic name/id fallback.
- All resolved Shop API/context responses are `no-store`; inventory reads and mutations remain scoped by the resolved membership. No UI switcher, role administration, ownership transfer, or invitation-flow redesign was added.
- PR #38 (`02dea4c`) was merged. Migration `0011_user_shop_preferences.sql` was applied successfully, followed by Worker version `1130cf23-51bd-4991-b096-26a138d733df`. A follow-up migration check reported no pending migrations, and the custom domain returned the expected Cloudflare Access HTTP 302 redirect.

## Shop selector design (deployed)

- The smallest selector is a **Current Shop** card at the start of **Profile & settings**, reached from the existing desktop Shop card or mobile **Profile** item. It uses a native labelled select and shows every returned option as `<Shop name> — Owner` or `<Shop name> — Member`; the active role is also visible outside the control.
- Exactly one cloud membership gets no selector: the current role is static in the existing Shop profile card and sidebar. Local mode remains the existing single-Shop experience with no fabricated role. Multi-Shop sidebar copy identifies the current role and says **Switch in Profile**.
- Returning members stay behind the access gate while `GET /api/shops` confirms an active membership. Empty, malformed, or failed context is blocking and offers **Retry** and **Sign out**; a local `404` preserves the local flow. Shop-scoped data must never load before context confirmation.
- An explicit change is confirmed by `GET /api/shops` with `X-Shop-Id`, then the app reloads to clear all old-Shop client state. The selected id is pinned on subsequent Shop-scoped requests. Unsaved Profile changes require confirmation. Busy, success, and ambiguous-failure messages use a polite live region, and focus returns to the selector after cancellation, failure, or the successful reload.
- Acceptance requires conditional one-versus-many rendering, role clarity, header propagation, dirty-form cancellation, safe loading/error states, old-state clearing, local fallback, and cross-Shop isolation tests, plus desktop/mobile checks at 320px, 200% zoom, keyboard-only, visible focus, long names, reduced motion, and screen-reader announcements. Exact copy and detailed criteria are in `ARCHITECTURE.md`.
- Out of scope: creating another Shop, admin promotion or other role changes, ownership transfer, member removal, and invitation redesign.

## Shop selector implementation (deployed 2026-09-26)

- The Profile-only selector now waits behind the access gate for a valid `GET /api/shops` response before loading any Shop-scoped screen data. It validates that `activeShopId` is one of the returned memberships, pins it as `X-Shop-Id` for page-scoped API calls, and keeps malformed, empty, and failed contexts in a retry/sign-out safe state. A local `/api/shops` 404 retains the existing single-Shop local experience.
- Multi-Shop users see a native labelled **Current Shop** selector with Owner/Member option and role copy; single-Shop cloud users retain only their static role, and local users receive no fabricated role. The sidebar identifies the active role and directs multi-Shop users to Profile.
- Switching requires confirmation when Profile is dirty, validates the selected id through `GET /api/shops` with `X-Shop-Id`, then reloads `#profile` so no prior-Shop in-memory state remains. A one-use session marker restores selector focus and announces the confirmed Shop only after the application shell is visible. Failure restores and focuses the prior option with explicit retry/reload guidance.
- Saved batch-photo views now use a header-pinned fetch and short-lived object URL rather than a direct image URL. Stale batch/Shop responses are ignored, and object URLs are revoked when the relevant dialog or preview closes. `public/sw.js` also no longer reads `/api/notifications` during a push because a service worker has no page-bound active Shop context; it shows the existing generic reminder instead. Behavioral coverage in `test/shop-selector-ui.test.js` exercises request headers, photo isolation/lifecycle and overlapping-load cleanup, dirty cancellation, switch confirmation/failure, and post-reveal focus.
- PR #41 (`63ec30f`) was merged and deployed to `medicineinventory.craftloop.ca` as Worker version `248366ef-6872-4ec2-81d7-44fd758889ca`. The read-only remote D1 ledger reported no pending migrations, and the custom domain returned the expected Cloudflare Access HTTP 302 redirect. Local single-Shop browser smoke testing confirmed that no selector is shown in local fallback mode; authenticated multi-Shop production verification remains pending with a real multi-membership account.

## Secure Shop onboarding and administration foundation (deployed 2026-09-26)

- Shop remains the visible product term; internal household tables and routes remain intact for deployed-client compatibility.
- Ordinary authenticated membership resolution is read-only. `GET /api/shop/onboarding-status` is callable before membership resolution and exposes only the caller’s membership state, pending-invitation flag, and setup eligibility; it never exposes `INITIAL_OWNER_EMAILS` or an allowlisted email.
- `POST /api/shop/onboarding` is the explicit, atomic, idempotent first-owner claim. It accepts Shop/display names, binds only the verified Cloudflare Access provider/subject, claims/backfills the singleton safely, and is never invoked on page load. The production first-owner allowlist is configured only through the `INITIAL_OWNER_EMAILS` secret.
- Additive migration `0010_access_audit.sql` records bootstrap, invitation creation, acceptance, and revocation in the same transaction as each state change where applicable. It stores actor, internal Shop id, target identifier, timestamp, and correlation ID—never Access JWTs or other secrets.
- The app gates unaffiliated authenticated users before loading inventory/cache-backed views: an eligible owner receives explicit setup; invitees receive acceptance; other users receive lock, retry, and sign-out guidance. Members see the current app and only owners see Shop access controls.
- Deliberate deferrals: ownership transfer, admin promotion, member removal, multi-Shop switching, and non-owner roster/pending-invitation visibility. The singleton bootstrap does not add a permanent one-Shop-per-user rule; the memberships schema remains suitable for a later multi-Shop design.
- Production migration `0010_access_audit.sql` was applied before deploying Worker version `afc911c5-8588-458d-b036-7fbac4f6a5bc`. The remote migration ledger then reported no pending migrations, and unauthenticated custom-domain verification returned the expected Cloudflare Access HTTP 302 redirect.

## Create another Shop — deployed 2026-09-27

- Recommend explicit **Create another Shop** for a verified cloud identity with a current membership, whether Owner or Member. The caller becomes sole owner of a new empty Shop; their displayed Shop and saved preference stay unchanged. No-membership users retain the existing setup/invitation gate.
- `ARCHITECTURE.md` specifies the POST `/api/shops` contract, same-origin checks, account-scoped operation receipts, transaction guards, owner cap of five and rolling one-creation-per-24-hours limit, fresh settings, `shop_created` audit, uncertain-retry UI, tests, and rollout. Migration 0012 creates receipts and preserves/rebuilds the existing audit table to widen its event CHECK.
- Preserve bootstrap and legacy records; never copy existing Shop inventory/settings/photos/push data. Creation does not switch context. Refresh the selector after confirmed success, then use its existing explicit switch flow when the user chooses the new Shop.
- Existing-member invitation acceptance still rejects any existing membership. Additional invitation joins, admin promotion/schema, ownership transfer, member removal, no-membership self-service creation, and Shop deletion remain separate future slices. Existing owner-only invitation management supplies administration of a newly created Shop for now.
- Remaining verification: authenticated create/retry/switch testing, plus real-browser responsive and screen-reader checks with a multi-membership production account.
- Senior review amendments: POST creation must route before `resolveTenant` in JWT → migration guard → route validation → account authorization/replay/transaction order and ignore every `X-Shop-Id` without preference writes. GET adds the existing opaque `users.id` as non-authorizing `accountContextKey`; save the operation/key/payload before dispatch, resume only after matching server context, and preserve unmatched account intents privately. Acceptance coverage now includes header behavior for success/failure/replay, storage failure, account switching, reload during an in-flight request, and missing/mismatched keys.
- Review follow-up: SQLite-backed D1-compatible tests now synchronize two requests after both miss the receipt and before serialized atomic batches. They prove one creation for duplicate operations, owner-cap contention and rolling-window contention, without extra households/receipts/audits or broken relationships. Route coverage compares all preference rows byte-for-byte after validation/quota rejection, success and replay; absent receipts fails closed, and absent audit rolls back an otherwise eligible creation.
- The complete creation dialog controller is bound by `app.js` and exercised through form/button events in a DOM test harness: saved intent before dispatch, duplicate-submit guard including close/reopen, reload-in-flight resume, uncertain retry, definitive validation reset, dirty Profile preservation, focus/status, and confirmed-success refresh failure/mismatch. Refresh failure retains the safe current Shop and a persistent status on the creation card. Native dialog/mobile sheet semantics have source-contract coverage; these tests do not substitute for real browser layout, screen-reader or authenticated production checks.
- Verification: `npm test` passes 85/85 (temporary loopback test servers require sandbox escalation); app/controller/Worker syntax and `git diff --check` pass. PR #44 (`52d12ff`) was merged, migration `0012_shop_creation.sql` was applied successfully, and Worker version `9b86f23f-ba08-4d96-8dc6-f7d9b5b72f2c` was deployed. The read-only D1 ledger reported no pending migrations and the custom domain returned the expected Cloudflare Access HTTP 302 boundary.

## Additional Shop invitation joins — server/data deployed (2026-09-28)

- `ARCHITECTURE.md` defines explicit acceptance by an already enrolled verified identity, reusing its `users.id` and adding only Member access to the invited Shop. Acceptance never changes the active Shop preference; the existing owner cap does not limit Member joins. This local server implementation replaces the old any-membership rejection; production remains unchanged.
- Server/data slice adds `0014_additional_shop_invitation_joins.sql`: durable `(invitation_id,user_id)` acceptance receipts plus expiring hashed route-throttle events. Pending invitations are explicitly allowlisted and bounded to 20. Cursors are documented as untrusted continuation hints, not signed authorization tokens: strict shape/canonical parsing rejects malformed values and the public email hash detects accidental account mismatch. Deliberate hash/position forgery only revisits/skips the caller's own valid invitations because SQL independently binds verified email, expiry, role and LIMIT 21. No new signing secret is needed.
- PR #52 merged as `decc81d9defc30465d87d3269c20ab810caf0924`. Production migration `0014_additional_shop_invitation_joins.sql` was applied successfully, the D1 ledger reports no pending migrations, and Worker version `39fb307f-3ade-4e69-a6cc-e6358b922655` is live behind the expected Cloudflare Access 302 boundary. No Access, DNS, or secret changes were required.
- The Profile UI for discovering and accepting additional-Shop invitations remains the next separate chunk; this release supplies and verifies the server/data foundation only.
- Acceptance remains pre-resolution, ignores every `X-Shop-Id`, checks same-origin JSON, rechecks identity in the atomic batch, supports receipt replay without switching, and guards membership/receipt/consumption/audit dependencies against partial commits. Synchronized duplicate losers resolve the winning receipt; only narrow expected constraints enter recovery and unexplained failures propagate. Revoke audits now require a successful DELETE, yielding one event in either race order. Creation and joining both guard 50 current memberships. Read-only over-cap preflight SQL is recorded in `ARCHITECTURE.md` and must be run before rollout.
- Verification: full `npm test` passes **146/146**; 34 focused additional-join tests include real Worker duplicate races, SQLite synchronization in both revoke/accept and join/create orders, rollback of aborting/ignored writes, caps/replay/preference snapshots, pagination/forgery privacy, principal/IP 429 and Retry-After, schema/limiter 503, request validation/no-store, and local loopback compatibility. Syntax and `git diff --check` pass; Wrangler dry-run builds at **113.13 KiB / gzip 23.84 KiB**. Temporary loopback servers were permitted. No remote changes occurred.
- Remaining bounded work: cloud-only Profile **Shop invitations** card with separate explicit switch, consolidated review, and authenticated/browser accessibility/responsive acceptance checks described in `ARCHITECTURE.md`.
- Profile UI, deployment, and real authenticated join/replay/switch verification are still pending. Deploy migration first, then Worker/UI; no commit, push, migration application, or deployment was performed locally.
- The smallest Profile UI is now implementation-specified in `ARCHITECTURE.md`: a cloud-only **Shop invitations** card sits between Current Shop and Create another Shop, uses bounded explicit pagination and a native confirmation dialog, persists an account-keyed invitation intent for receipt-backed ambiguous retry, and never sends `X-Shop-Id`, auto-accepts, polls, or switches during acceptance. Confirmed joins merge only the refreshed membership list while keeping the tab's current Shop and dirty Profile fields intact; **Switch to <Shop>** is a separate action through the existing dirty-confirmation/full-reload selector path. The specification includes safe 404/409/429/503/cap/replay copy, context/account suppression, local/older-server fallback, focus/live-region behavior, 320px/200% reflow, reduced motion, and exact client acceptance coverage. This is design documentation only; application code, tests, commit, push, and deployment remain pending.
- Senior design follow-up fixes the client decoder contracts to the deployed wire shapes. Pending discovery must accept exactly `{ invitations, nextCursor, member }` and validate boolean `member`, while the enrolled Profile card never renders, stores, or trusts it; the unchanged unaffiliated gate remains compatible. Acceptance treats 200 as success only for exact `{ householdId, role, accepted }`, a canonical UUID, `role:'member'`, boolean `accepted`, and the still-matching invitation/account intent. Any malformed or stale success remains retryable safe non-success and cannot clear intent, change the selector, or offer Switch. Required tests now use real fresh/replay/pending payload fixtures and reject missing, extra, mistyped, and context-mismatched variants. Docs only; implementation remains pending.

## Online change feed (implemented, branch cursor/batch-change-feed-9887)
- Migration `0015_batch_change_feed.sql`, `lib/batch-changes.js`, `GET /api/changes`, `public/change-feed-client.js`, 15-minute cron pruning (30-day retention of feed rows and mutation receipts). Full suite 197/197.
- Deploy: apply 0015 to remote D1 BEFORE deploying the Worker. Not yet applied or deployed unless a later entry says so.
- Lessons: D1 `meta.changes` counts trigger rows (no triggers); two asset allowlists must both list new modules.
- Browser-verified against the real Worker code (local harness, real asset allowlist): a medicine added from another client appeared on Inventory within about a minute with the "Inventory updated." toast; an update made while the medicine dialog was open refreshed the list, left the dialog open, and showed the "updated elsewhere" notice.

## Change feed released
- PR #58 merged as `736928a`. Remote migration `0015_batch_change_feed.sql` applied (verified: `batch_changes` empty, floor 0, throttle table accepts route `changes`), then Worker deployed: version `eaf1e219-54bc-40a5-a4ca-81cf34efc171`.
- Unauthenticated curl only shows the Access 302, so it does not prove assets are served (allowlist covered by `test/worker-assets.test.js`). Authenticated check pending: open the app signed in, confirm it loads, and that a change made on another device appears on Inventory within about a minute.

## Member removal designed; change feed follow-ups (2026-09-29)
- `ARCHITECTURE.md` now has "Design: remove a member (not implemented)": Owner removes a Member only, migration 0016 (receipt table + `member_removed` audit), route `POST /api/household/members/:userId/remove`, same-batch cleanup of the target's push subscriptions and preference, client handling of 403 from the change feed. Awaiting review before implementation.
- Added a change-feed test for a medicine deleted from another device; ARCHITECTURE change-feed section and deferred list no longer say "not implemented".

## Member removal implemented (branch cursor/member-removal)
- Migration `0016_shop_member_removal.sql` (receipt table with eligibility trigger; `access_audit` rebuilt with `member_removed`), `removeHouseholdMember` in `lib/household-access.js`, route `POST /api/household/members/:userId/remove`, `public/member-removal-client.js`, Remove button + dialog, and change-feed `onAccessLost` (403 stops polling, toast, reload).
- Tests: `test/member-removal.test.js` (13), `test/member-removal-ui.test.js` (6), route test in `worker-invitations.test.js`, 403 test in `change-feed-client.test.js`. Full suite passes.
- Verified against real Worker code with curl (member 403 after removal, replay no-op, roster updated). NOT verified in a real browser (no browser tool in that session): check the Remove button layout on a phone-width Profile and the dialog flow.
- Deploy order: apply 0016 to remote D1, then deploy Worker/UI. New module is in both asset allowlists.

## Member removal released
- PR #61 merged as `d51173a`. Remote migration `0016_shop_member_removal.sql` applied (receipt table and guard trigger present, audit history preserved), then Worker deployed: version `9095cb11-1917-452f-957f-ec9c6f163574`.
- Still to check signed in: Remove button layout on a phone-width Profile and the confirmation flow (browser not checked).

## Demotion/leave designed; platform admin needs decisions (2026-09-29)
- Owner promotion and member removal were both verified by the user with real accounts (Remove button/dialog on phone width; second-account promotion).
- `ARCHITECTURE.md` has "Design: owner demotion and leaving a Shop (not implemented)" awaiting review.
- Requested but undesigned: a company-only platform admin (local login or `/admin`) that can see and change backend data. Open decisions: how it authenticates (separate Cloudflare Access application and policy for `/admin*` is the recommended default, never the customer Access app), read-only first versus writes, which data it may see (medicine/photos are customer data), audit logging of every admin action, and whether changes go through existing store functions or raw SQL.

## Demotion and leave implemented (branch cursor/demotion-leave)
- Migration `0017_shop_demotion_leave.sql`; `demoteHouseholdOwner` / `leaveHousehold` in `lib/household-access.js`; routes `POST /api/household/members/:userId/demote` and `POST /api/household/leave`; `public/owner-demotion-client.js`, `public/shop-leave-client.js` (both in the two asset allowlists); "Make member" on other Owner rows and "Leave this Shop" in the Current Shop card (disabled with a reason for the last Owner). Leave reloads into another Shop or the invitation gate.
- Tests: `test/demotion-leave.test.js` (14 incl. last-owner races), `test/demotion-leave-ui.test.js` (7), route test in `worker-invitations.test.js`. Full suite 241 passing.
- Not browser-verified. Deploy order: apply 0017 to remote D1, then deploy the Worker.
- The platform-admin questions above are still open for the morning.

## Demotion and leave released
- PR #64 merged as `1d2576c`. Remote migration `0017_shop_demotion_leave.sql` applied (both receipt tables and guard triggers present, 6 audit rows preserved, `member_left` allowed), then Worker deployed: version `f1887e97-b031-46be-95ef-991bbadde181`.
- Signed-in check pending: Make member on another Owner, Leave this Shop as a Member, and the disabled Leave with a reason for the last Owner. Platform-admin decisions still open.

## Platform admin: design and setup (2026-09-29)
- Decisions (user): use the recommended defaults; admin email `kaushik.majumder@craftloop.ca`. Design is in `ARCHITECTURE.md` ("company-only platform admin console, read-only v1"): separate Access app for `/admin*`, Worker checks AUD plus email allowlist, metadata only, every request audited, no writes.
- Tooling finding: the agent cannot create the Access application. Wrangler's OAuth token only has account/zone read plus Workers/D1-type scopes, and the Cloudflare MCP servers (bindings, builds, docs, observability) do not manage Zero Trust Access. Owner steps: Zero Trust, Access, Applications, Add, Self-hosted; domain `medicineinventory.craftloop.ca`, path `admin`; policy Allow, email equals `kaushik.majumder@craftloop.ca`; copy the Application Audience (AUD) tag.

## Platform admin implemented (branch cursor/admin-console-design)
- `lib/admin.js`, `handleAdmin` in `worker/index.js`, `public/admin/{index.html,admin.js,admin.css}` (served only after admin authorization; not in `publicAssetPaths`), migration `0018_admin_audit.sql`, `test/admin-console.test.js` (11). Full suite passes.
- The Access application for `/admin*` exists (owner-created); its AUD tag was given in chat and is deliberately not committed. Rollout: apply 0018, `wrangler secret put ADMIN_ACCESS_AUD` and `ADMIN_EMAILS` (`kaushik.majumder@craftloop.ca`), deploy, then verify signed in at `/admin`. Until both secrets exist the console returns 503.
- If the path-scoped Access app causes sign-in loops, move to a dedicated admin hostname; code is unchanged.

## Platform admin released
- PR #66 merged as `3053399`. Remote migration `0018_admin_audit.sql` applied, Worker secrets `ADMIN_ACCESS_AUD` and `ADMIN_EMAILS` set, Worker deployed: version `a28a24c7-58f3-4f29-a77a-60b557db6cdc`.
- Unauthenticated requests to `/admin*` redirect to Access using the admin application's AUD, so the path-scoped app takes precedence over the customer app. Signed-in check pending: open `/admin` as `kaushik.majumder@craftloop.ca`, confirm each tab loads and that the Admin log shows the visits.
