# Medicine Inventory Tracker architecture

This document is the durable technical map of the deployed system. It records decisions that are already in use and clearly separates them from planned work. Update it when an architectural decision is finalized or a planned design becomes deployed.

## Product boundary

Medicine Inventory Tracker is a responsive web application for managing medicine batches, expiry dates, stock levels, locations, reminders, and optional packaging photos. The product is protected by Cloudflare Access in production. User-facing language calls the shared space a **Shop**; existing database and API identifiers remain `household`-scoped for compatibility.

## Runtime layout

```text
Browser (plain HTML, CSS, JavaScript)
        |
        | HTTPS + Cloudflare Access session
        v
Cloudflare Worker
  |-- static assets from Workers Assets
  |-- API and scheduled push delivery
  |-- verifies Cloudflare Access JWT for production API calls
  |-- D1: inventory, users, memberships, settings, invitations, receipts
  |-- R2: packaging photos
  `-- KV: web-push configuration

Local development
  `-- Node HTTP server + SQLite + local photo files
```

## Clients and presentation

- Static client: `public/index.html`, `public/app.js`, `public/styles.css`; no client-side OAuth credentials are stored.
- The browser calls same-origin APIs with the Cloudflare Access session and renders server-authorized data only.
- Static HTML and bootstrap assets use fresh-cache policies so deploys do not leave an authenticated user on an old shell. Image assets use immutable caching.
- The app has responsive inventory, reminder, profile, access-management, invitation-acceptance, and sign-out flows. The sign-out action sends the user to Cloudflare Access’s same-origin logout endpoint.

## Identity and authorization

- Production endpoints validate a Cloudflare Access JWT signature, issuer, audience, and expiry. Browser-supplied identity, role, and email fields are never authority.
- A verified identity is bound to its provider and subject. Email may support invitation matching, but never account linking or ownership takeover.
- D1 stores `users`, `identities`, `households`, `memberships`, `household_settings`, and a permanent singleton bootstrap marker.
- Roles currently are `owner` and `member`. Owners manage invitations; members can use Shop inventory according to existing server checks.
- Invitations are addressed to a normalized verified email, expire after seven days, and grant membership only through explicit acceptance by the matching authenticated identity.
- Existing tables, routes, payload fields, DOM hooks, and migration names retain the internal `household` term. Do not rename them without a separately approved compatibility migration.

## Data and sync model

- Local mode is loopback-only and uses SQLite as a single-user Shop.
- Cloud mode uses D1 as the source of truth. Inventory and push data are tenant-scoped by internal household ID.
- Each cloud batch has a revision. Browser mutations carry an operation ID and base revision; duplicate operations replay safely and stale changes return a conflict for user review.
- No offline mutation queue, bidirectional change feed, background reconciliation, or cross-device conflict UI exists yet.
- Packaging images live in R2. Optional Gemini suggestions are server-side, require a configured secret, and are never saved until the user confirms the medicine form.

## Deployment and operations

- Production target: `https://medicineinventory.craftloop.ca`.
- The Worker configuration and deployment notes live in `deploy/cloudflare-workers.md`.
- D1 migrations are additive and applied before a Worker that depends on them. Verify the migration ledger and production route after every deployment.
- Secrets remain in Cloudflare/Wrangler or ignored local files. Never commit Access, Apple, Google, Gemini, VAPID, database, or photo credentials.
- `HANDOVER.md` records delivery and deployment checkpoints; `BUGFIX_PLAN.md` records the evidence-first triage process.

## Finalized design: Shop terminology

- UI, live-region, and returned error copy use **Shop**.
- Internal compatibility contracts intentionally remain household-scoped.
- No data migration was needed for the terminology release.

## Deployed: active multi-Shop context

- A caller may have memberships in more than one Shop. `GET /api/shops` returns only that caller's Shop ids, names, and roles, plus the resolved active Shop id; it never returns another member's information.
- The Worker resolves a membership context for every authenticated Shop-scoped request. An `X-Shop-Id` selector is accepted only for a current membership and is persisted as the caller's last explicit selection in `user_shop_preferences` (migration `0011_user_shop_preferences.sql`).
- With no selector, resolution uses a still-valid saved selection, then a deterministic `LOWER(name), id` membership fallback. A stale preference is ignored rather than granting access.
- Inventory, settings, notifications, push subscriptions, photos, and Shop access routes use that resolved context, so an id from another Shop cannot be read or mutated. Context and Shop API responses use `Cache-Control: no-store`.
- This slice deliberately does not add a browser switcher, role changes, ownership transfer, or a redesign of invitation enrollment.

## Deployed: Shop selector

### Placement and responsive presentation

- Shop switching lives in **Profile & settings**, immediately before the existing profile form. This reuses the desktop sidebar Shop card and the mobile **Profile** navigation item as the entry point instead of adding another primary-navigation destination.
- When the caller has two or more memberships, show a card headed **Current Shop** with the description **Choose the Shop whose inventory and settings you want to use.** Its native select is labelled **Shop**. Each option is rendered as `<Shop name> — Owner` or `<Shop name> — Member`, in the order returned by `GET /api/shops`. Below it, repeat the active role as static text: **Your role: Owner** or **Your role: Member**.
- The desktop sidebar card continues to show the active Shop name. Its second line becomes **Owner · Switch in Profile** or **Member · Switch in Profile**, and its accessible name includes the full active Shop name and role. Long names truncate visually only. On screens up to 760px, the sidebar remains hidden and the selector card is full width with a minimum 44px select target; users reach it through the existing bottom **Profile** item.
- With exactly one membership, do not render a selector or switching card. Keep the sidebar card as a Profile link, use **Owner** or **Member** as its second line, and show the same role as non-interactive text in the existing **Shop** profile card. Local single-Shop mode remains unchanged and does not invent an owner/member role.

### Loading, empty, and error copy

- After onboarding confirms a membership, resolve Shop context before loading any Shop-scoped settings, inventory, notifications, access, push, or photo data. While resolving, keep the existing access gate visible with **Opening your Shop** and **Loading your Shop access…**; do not reveal stale Shop data underneath it.
- A successful response must contain the declared `activeShopId` in `shops`. A missing/empty list or unmatched active id is a blocking safe state: **No Shop access found** / **This signed-in account does not currently belong to a Shop. Ask a Shop owner for an invitation, then try again.** Actions are **Retry** and **Sign out**.
- A load failure is also blocking: **We couldn’t load your Shops** / **Your inventory has not been opened because the active Shop could not be confirmed.** Actions are **Retry** and **Sign out**. A local `404` from `/api/shops` retains the existing local single-Shop flow rather than showing this cloud-only error.

### Switching behavior and accessibility

- Changing the select is an explicit switch. If Profile has unsaved changes, first ask **Switch Shops and discard your unsaved profile changes?** Cancel restores the active option and focus to the select without making a request.
- During a switch, disable the select, set its container `aria-busy="true"`, and announce **Switching to <Shop name>…** in a dedicated polite status region. Send `GET /api/shops` with `X-Shop-Id: <selected id>`; the returned `activeShopId` must equal the selection before treating it as confirmed.
- On confirmation, reload the application to clear every prior Shop's in-memory inventory, notification, settings, access, modal, filter, and mutation-intent state. Preserve the `#profile` destination. After reload, focus the Shop select and announce **Switched to <Shop name>. Showing its inventory.** A session-scoped, one-use marker may carry only the focus/announcement intent and Shop name; it is not authority for the active id.
- If the switch cannot be confirmed, restore the prior option, re-enable and focus the select, and announce **We couldn’t confirm the switch. Retry, or reload to check your active Shop.** Do not claim that the server preference is unchanged after an ambiguous network failure.
- After initial resolution, keep the resolved id in memory and add `X-Shop-Id` to every Shop-scoped API request for the life of that page. Do not add it to pre-membership onboarding or invitation-discovery requests. This pins an open tab to its displayed Shop even if another tab changes the saved preference.
- Use the native select's keyboard and assistive-technology behavior; do not build a custom menu. The visible label, role text, busy state, status region, and focus behavior must work at 200% zoom and with reduced motion.

### Implementation acceptance criteria

1. One-Shop cloud users and local users see no switching control; multi-Shop users see only their server-returned memberships and a clear Owner/Member label.
2. No Shop-scoped request starts until `/api/shops` establishes a valid active membership, and subsequent scoped requests carry that active `X-Shop-Id`.
3. A confirmed switch persists through the deployed API contract, clears old-Shop client state by reloading, and opens the selected Shop's Profile with focus and a polite announcement.
4. Unsaved Profile edits cannot be discarded without confirmation; cancel and all failure paths leave a usable, focused control with explicit status text.
5. Loading, malformed/empty, authorization, network, and retry states never expose inventory from an unconfirmed Shop. Automated coverage verifies header propagation, single-versus-multiple rendering, role copy, switch success/failure, dirty-form cancellation, local fallback, and cross-Shop data isolation.
6. Desktop and mobile browser checks cover long Shop names, 320px width, 200% zoom, keyboard-only operation, visible focus, and screen-reader announcements.

This chunk does not create another Shop, promote an admin, change roles, transfer ownership, remove members, or redesign invitations.

The implementation keeps the access gate visible until `GET /api/shops` validates that the declared active Shop is among the signed-in caller's memberships. It pins that id into subsequent page requests with `X-Shop-Id`; local `/api/shops` 404 responses retain the single-Shop local flow. Saved packaging photos are fetched through that pinned request path and displayed with revocable object URLs, so native image loads cannot resolve against a changed Shop context. A service-worker push is deliberately generic because it has no page-bound context and therefore must not issue an unpinned notification request.

## Deployed: secure Shop administration onboarding

- The current product has one active Shop bootstrap singleton; its internal `households`, `memberships`, and household-scoped routes remain compatibility contracts, not a permanent one-Shop-per-user restriction. The memberships model supports a future multi-Shop design without migrating existing identities or inventory.
- Cloudflare Access JWT verification produces the only identity accepted by the Shop access layer. Ordinary membership resolution is read-only.
- Before membership resolution, `GET /api/shop/onboarding-status` returns only the caller’s membership state, pending-invitation flag, and setup eligibility. It never returns the configured allowlist or an allowlisted email.
- `POST /api/shop/onboarding` is the sole explicit, atomic, idempotent initial-owner claim. It accepts Shop and display names, binds only the verified provider/subject, checks the normalized configured initial-owner allowlist, claims/backfills the singleton, and is never invoked on page load.
- Migration `0010_access_audit.sql` records append-only bootstrap, invitation creation, acceptance, and revocation events in the corresponding state-change transaction. Events include the internal Shop identifier, actor, target identifier, timestamp, and request correlation ID; they deliberately exclude JWTs and secrets.
- The browser gates unaffiliated authenticated users before loading inventory or cache-backed views: eligible owners receive explicit setup, invitees receive acceptance, and other users receive lock, retry, and sign-out guidance. Members see the current application; only owners see Shop-access controls.
- Recheck owner authorization and same-origin protections on every administration mutation. Coverage includes concurrent setup, forged identity input, invitation expiry/revocation, cross-Shop isolation, and audit rollback.

## Finalized design, implemented locally but not deployed: create another Shop

### Scope and authority

The next lifecycle slice is explicit **Create another Shop** for an authenticated cloud user who already has at least one current membership. Both owners and members may create an independent Shop and become its sole owner; being a member elsewhere grants no authority over that Shop. This supplies a supported way to exercise the deployed multi-Shop selector without changing enrollment or role semantics. A user with no Shop continues through the existing initial-owner setup or invitation gate. This is deliberately a first expansion, not general self-service onboarding.

Add `POST /api/shops` alongside the existing collection GET, routing it entirely before `resolveTenant`. The exact order is signed Access JWT verification → migration read-only guard → route-specific same-origin/content/body validation → account identity/current-membership check → receipt replay lookup → guarded atomic creation. Resolve the existing internal user solely by provider/subject. Do not invoke bootstrap, link accounts by email, trust client roles/user ids, or require ownership of the currently displayed Shop. Ignore `X-Shop-Id` entirely on this route, including malformed or foreign values; never call the preference-writing resolver or write `user_shop_preferences` on success, failure, or replay. Recheck membership inside the creation transaction; a preflight read alone is insufficient. Return 403 if the caller has no membership.

Require `Content-Type: application/json`, an exact same-origin `Origin` matching the request URL, and reject `Sec-Fetch-Site: cross-site` when present. Missing or foreign Origin is 403 for this browser-only route. Keep the existing JSON size ceiling and validate an allowlist of `{ operationId, shopName, displayName }`; reject unexpected identity, role, household, or import fields. Require a UUID operation id, trim/collapse whitespace, and enforce the existing 1–80 Shop-name and 1–60 display-name limits. Render all names as text. Duplicate Shop names are allowed; ids provide identity and the selector should include a short id suffix only when names/roles would otherwise be indistinguishable.

### Transaction, replay, and limits

Add migration `0012_shop_creation.sql` containing an account-scoped `shop_creation_receipts` table: `user_id` FK, `operation_id`, canonical validated request payload, `household_id` FK, `created_at`; primary key `(user_id, operation_id)` and index `(user_id, created_at)`. Store the canonical non-secret names for exact replay comparison rather than relying on an unstable JSON serialization or unkeyed client input. Retain receipts indefinitely in this slice; they are small and bounded by creation limits. Existing tenant-scoped inventory receipts cannot represent creation because the destination tenant does not exist yet.

In the same migration, rebuild `access_audit` with its existing columns, foreign keys, index, and event constraint extended by `shop_created`. Copy every existing row unchanged and replace the old table inside the migration transaction; verify counts and foreign-key integrity. Do not edit already-applied 0010. No role CHECK, existing tenant table, or legacy row needs a data rewrite.

Use one D1 batch transaction with server-generated destination UUID, timestamp, and audit id. A conditional household insert must recheck verified identity-to-user binding, current membership, absence of this receipt, fewer than **five currently owned Shops**, and fewer than **one successful creation in the preceding rolling 24 hours**. Subsequent owner membership, fresh settings, creation receipt, and `shop_created` audit inserts must depend on that new household row. A zero-row eligibility insert must produce zero related writes; a failed statement rolls back all writes. Recheck outcomes, then resolve a concurrent winning receipt or report the current membership/limit failure. The unique receipt key is the replay lock: a concurrent duplicate that reaches the receipt insert must roll its whole losing transaction back. Concurrent different operation ids must still enforce both caps through the transaction's guarded insert, not application preflight counts. Demonstrate these behaviors against real SQLite-backed batch semantics before accepting implementation.

Before a new transaction, look up the caller's receipt. The same operation and canonical payload returns the same `{ shop: { id, name, role: 'owner' }, created: false }` with 200; mismatched payload is 409. First success returns that shape with `created: true` and 201. Replay must verify current membership in the recorded destination and return 403 rather than exposing a Shop after future removal. Check replay before creation limits so a timeout retry remains valid. Validation is 400; owner cap is 409 with **You can own up to 5 Shops.**; rolling creation cap is 429 with **You can create one Shop every 24 hours. Try again later.** and `Retry-After`. Identity and membership failures expose no other account details. All responses are `no-store`.

The new settings row uses only submitted names, default location **Medicine cabinet**, and `display_name_source='user'`. It has no batches, photos, notifications, push subscriptions, or invitations. Never copy current-Shop settings or legacy NULL-tenant records. Never touch `tenant_bootstrap`. The transaction appends exactly one `shop_created` event, with actor user id, new internal household id, verified provider/subject target, server timestamp, and request correlation id. Replays append no event. JWTs and secrets never enter receipts or audit rows. Security failures may use ordinary operational logs without creating a success audit event.

These persistent caps bound successful resource creation per internal user; they are not an IP rate limiter or protection against a compromised allowlisted Access population. The existing Access gate remains the perimeter. Do not add global counters, a new service, or email-based quotas. A future transfer design must revisit owned-Shop caps and receipt retention. Fail closed if the receipt/audit schema is unavailable.

### UI and context behavior

Add a compact **Create another Shop** action to cloud Profile for both single- and multiple-membership users; hide it in local mode and the no-membership gate. It opens an accessible dialog with **Shop name**, **Your display name**, help **You’ll be the owner of a new, empty Shop. Your current Shop will stay open.**, and **Create Shop** / **Cancel**. Prefill display name from the currently visible profile as editable convenience only; require a new Shop name. Keep the existing Profile form and any unsaved edits intact.

On submission disable duplicate submission and announce **Creating your Shop…**. Before dispatch, synchronously save `{ operationId, accountContextKey, payload }` to sessionStorage, where payload is the frozen canonical pair of submitted names. If that save fails, do not dispatch; explain that safe retry storage is unavailable. Keep the same operation id and payload through timeout, network, 429, and 5xx failures; **Retry creation** resends them. A definitive validation failure allows correction with a new operation id. An ambiguous failure says **We couldn’t confirm creation. Retry to check the same request.** Closing an uncertain dialog must preserve its saved pending intent. On reload, including reload while a request is in flight, first confirm authenticated `/api/shops` context; matching account keys offer explicit resume before allowing a new creation. Resume replays the saved request rather than assuming whether the original committed. Never automatically retry or create on page load.

Use the existing stable opaque `users.id` as `accountContextKey` in GET `/api/shops`; it identifies the server-bound internal account, contains no PII, stays unchanged across Shop switches, and conveys no authority. Never accept this key as server identity or authorization input. If a different account signs in, its confirmed key must not match the saved intent: do not display the saved names, replay it, or attribute any old result to that account. Keep the unmatched intent dormant so signing back into the original account can resume it, and let the new account create its own separately keyed intent. Treat missing/malformed server keys or failed context resolution as blocking for creation/resume, with retry guidance. Ignore a stale in-flight response whose captured account key no longer matches confirmed context. Remove only the matching intent after confirmed success or a definitive rejected request. Explicitly discarding an uncertain intent must say it cannot cancel a request already received by the server.

After confirmed creation, refresh `GET /api/shops` using the still-pinned current id, close the dialog, and announce **Created <Shop name>. Your current Shop is still open. Choose it under Current Shop when you’re ready.** A first creation from one membership now reveals the existing selector. Focus that selector without switching it. If refreshing the list fails, preserve confirmed creation and say **Your Shop was created. Reload to update your Shop list.** Never repeat the mutation merely to refresh. Creation does not write `user_shop_preferences`, clear old context, or load destination inventory; choosing the destination uses the deployed dirty-form confirmation and full reload. Use visible labels, polite status, focus restoration, 44px targets, and desktop/mobile/320px/200% zoom checks. Detailed visual treatment should receive the requested UI Designer pass during implementation.

### Compatibility, rollout, and acceptance

Keep GET `/api/shops`, existing household contracts, bootstrap allowlist, local server, invitation acceptance, and owner-only access controls compatible. Extend GET `/api/shops` additively with `accountContextKey: <verified caller's users.id>` for pending-intent scoping, obtained from the authenticated membership context; no new identifier schema is needed. Old clients ignore it. New clients require a valid non-empty opaque key for creation and tolerate older servers returning 404/405 for creation or omitting the key: show **Shop creation is not available yet.** without changing context. No new Access, DNS, or secret configuration is needed.

Implementation order: apply and verify 0012 with copied audit counts/FK checks; deploy server and UI together; check migration ledger, API authentication boundary, existing onboarding/invitation/inventory tests, and local fallback. An older Worker remains compatible with the widened audit constraint and extra table, so Worker rollback does not require reversing the migration. Mark deployed only after authenticated creation/retry/switch verification with a real account; the production multi-membership selector check currently remains pending.

Required automated coverage: forged JWT/role/user/email, no-member refusal, owner and member creation, current context retained, empty destination isolation, bootstrap unchanged, settings provenance, same-operation and different-payload replay, cross-user operation ids, ambiguous retry, concurrent duplicate and distinct-operation races at both limits, audit/receipt/membership failure rollback, migration preservation, removed-membership replay denial, foreign/missing Origin and content type/body validation, migration lock, unavailable schema, and all response cache policies. Assert current, foreign, and malformed `X-Shop-Id` are ignored and preferences remain byte-for-byte unchanged across creation success, validation failure, quota failure, and receipt replay. Assert the POST path never calls `resolveTenant`, and guard/validation order prevents later work on rejection. Browser coverage exercises single-to-many rendering, storage-before-dispatch and storage-failure refusal, reload-in-flight and matching-key explicit replay, account A → B → A switching, mismatched/missing/malformed key blocking, dormant intent privacy, stale-response suppression, duplicate submit prevention, refresh-after-success failure, unchanged dirty Profile form, eventual selector switch and photo/inventory isolation, keyboard/focus/status and responsive states.

Explicit deferrals: self-service creation by users with no memberships; existing members accepting additional invitations (today's acceptance intentionally returns 409 for any existing membership); admin role/schema changes; role changes, transfer, removal, Shop deletion, import/copy, shared user profile redesign, email sending, stronger traffic rate limiting, and receipt cleanup. Each new Shop already has its sole owner and existing owner-only invitation management; admin management is a later designed slice. Do not imply those full lifecycle requirements are delivered by this chunk.

## Deferred architecture work

- Pull/change feed and offline synchronization reconciliation.
- Native mobile clients.
- Export, account deletion, configurable reminder windows, ownership transfer, admin promotion, member removal, and non-owner roster or pending-invitation visibility.

## Create another Shop implementation status (2026-09-27, not deployed)

- Migration `0012_shop_creation.sql` adds account-scoped creation receipts and safely rebuilds `access_audit` with the additive `shop_created` event while preserving its columns, relationships, and index. The migration is intentionally forward-only; it does not alter the deployed 0010 file.
- `POST /api/shops` now executes before tenant resolution. It verifies the Access JWT, checks the migration lock, requires same-origin JSON, ignores every `X-Shop-Id`, resolves the verified provider/subject to an existing member, and performs replay/creation independently of the active-Shop preference.
- The guarded D1 batch creates only an empty destination Shop, owner membership, user-sourced settings, receipt, and one audit event. It preserves the old Shop selection and enforces the documented ownership and rolling-creation limits. It is implemented and tested locally, but has not been migrated or deployed to production.
- `GET /api/shops` additively returns the authenticated internal `users.id` as `accountContextKey`. The Profile dialog persists an account-scoped intent before mutation, exposes an explicit retry/resume path only to that same key, and never switches Shop context after success.
- `bindShopCreation` owns the actual app dialog bindings, persistence, in-flight guard, retry and success/refetch sequence. A confirmed success clears its intent; failed or mismatched context refresh leaves the current Shop intact, shows a persistent status and restores focus to the creation action. Tests execute that controller with DOM event/service doubles, preserving unsaved Profile fields; native modal/mobile semantics are checked separately against markup and CSS.
- Concurrency coverage uses a two-caller barrier before SQLite-backed D1-style atomic batches, covering duplicate replay and distinct-operation owner/rolling caps. Missing receipt schema fails closed, eligible audit failure rolls back, and route preference snapshots are byte-for-byte invariant. Full automated suite: 85 passing. Real-browser responsive/accessibility and authenticated production verification remain outstanding; no remote migration or deployment has occurred for this slice.
