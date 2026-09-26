# Medicine Inventory Tracker — handover

## Current state

- Product: household medicine inventory (responsive web). Long-term: optional native clients; not a commercial store product.
- Repository: https://github.com/sudoku0412-stack/medicine-inventory-tracker (public).
- **Production:** https://medicineinventory.craftloop.ca — Cloudflare Worker + D1 + R2 + KV, protected by **Cloudflare Access**. Deploy: `deploy/cloudflare-workers.md`, `npm run deploy`.
- **Local dev:** Node 26+, `npm start` → http://127.0.0.1:3000, SQLite under `data/`. Static UI in `public/`. Run `npm test`.
- **Secrets (never commit):** local `data/gemini.key`, `data/vapid.json`, `.env`; cloud Wrangler secrets (`GEMINI_API_KEY`, optional `ACCESS_*`).

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

## Working agreement

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
- Living bug process: see `BUGFIX_PLAN.md` for the evidence-first triage checklist, incident log template, communication expectations, and the invitation overlay incident record.

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

## Architecture reference (2026-09-26)

- `ARCHITECTURE.md` is the living system-design reference. It distinguishes deployed architecture from finalized-but-not-yet-deployed decisions and should be updated whenever a material architecture decision is finalized.
- It records the finalized, pending-deployment secure Shop-administration onboarding foundation and future multi-Shop direction.

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
