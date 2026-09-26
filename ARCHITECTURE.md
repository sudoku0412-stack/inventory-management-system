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

## Finalized, pending deployment: secure Shop administration onboarding

- The current product has one active Shop bootstrap singleton; its internal `households`, `memberships`, and household-scoped routes remain compatibility contracts, not a permanent one-Shop-per-user restriction. The memberships model supports a future multi-Shop design without migrating existing identities or inventory.
- Cloudflare Access JWT verification produces the only identity accepted by the Shop access layer. Ordinary membership resolution is read-only.
- Before membership resolution, `GET /api/shop/onboarding-status` returns only the caller’s membership state, pending-invitation flag, and setup eligibility. It never returns the configured allowlist or an allowlisted email.
- `POST /api/shop/onboarding` is the sole explicit, atomic, idempotent initial-owner claim. It accepts Shop and display names, binds only the verified provider/subject, checks the normalized configured initial-owner allowlist, claims/backfills the singleton, and is never invoked on page load.
- Migration `0010_access_audit.sql` records append-only bootstrap, invitation creation, acceptance, and revocation events in the corresponding state-change transaction. Events include the internal Shop identifier, actor, target identifier, timestamp, and request correlation ID; they deliberately exclude JWTs and secrets.
- The browser gates unaffiliated authenticated users before loading inventory or cache-backed views: eligible owners receive explicit setup, invitees receive acceptance, and other users receive lock, retry, and sign-out guidance. Members see the current application; only owners see Shop-access controls.
- Recheck owner authorization and same-origin protections on every administration mutation. Coverage includes concurrent setup, forged identity input, invitation expiry/revocation, cross-Shop isolation, and audit rollback.

## Deferred architecture work

- Pull/change feed and offline synchronization reconciliation.
- Native mobile clients.
- Export, account deletion, configurable reminder windows, creating another Shop, ownership transfer, admin promotion, member removal, and non-owner roster or pending-invitation visibility.
