# Medicine Inventory Tracker

A responsive household medicine inventory application. It tracks medicine batches, calculates expiry and low-stock status, and shows persistent 30-day expiry reminders. It runs two ways: a single-household local app on SQLite (`npm start`), and the production cloud app on Cloudflare Workers with D1, R2 and KV, where people share one or more Shops under Cloudflare Access.

Project documents: `ARCHITECTURE.md` (designs and as-built decisions), `HANDOVER.md` (current status, release log, open work), `deploy/cloudflare-workers.md` (deployment steps).

## Run

Requires Node.js 26 or later. No package installation is needed.

```sh
npm start
```

Open `http://127.0.0.1:3000`. Set `PORT` to change the port. The server binds to loopback by default; set `HOST` only for an intentional trusted-network deployment.

## Test

```sh
npm test
```

## Storage and deployment

The SQLite database is created at `data/inventory.sqlite`; it is deliberately excluded from Git. Packaging photos are stored under `data/photos/`. VAPID keys for web push are stored at `data/vapid.json`. Both are excluded. This application is designed for one local household, has no authentication, and must not be exposed publicly.

Binding `HOST` to a non-loopback address exposes an unauthenticated application and is unsafe unless access controls are provided externally.

## Profile and household settings

Profile & settings stores one local household profile: display name, household name, and the default storage location for new medicine batches. The defaults are **Kaushik**, **Kaushik’s home**, and **Medicine cabinet**. Settings are stored alongside the inventory in SQLite locally and in D1 in production; updating them never changes existing medicine records. On Cloudflare, apply the D1 migrations before deploying the Worker.

## Packaging photos

Add or edit a batch with an optional JPEG, PNG, or WebP photo (2 MB max). Take photo opens the device camera in the browser on localhost or HTTPS (Chrome will ask for permission). Desktop Chrome does not open the camera from a file-picker `capture` attribute, so this uses a live preview instead. Upload photo still uses the file picker. The photo is kept only after you save the batch. Manual name, quantity, and expiry entry always remain available.

If `GEMINI_API_KEY` or `VISION_API_KEY` is set, or `data/gemini.key` exists, one Gemini vision request can suggest a medicine name and a complete `YYYY-MM-DD` expiry. Incomplete or unreadable dates are left blank so you type them. Suggestions never create a batch on their own; saving the form is the confirmation step.

Put the Gemini key in `data/gemini.key` (gitignored) or in the environment. Do not commit the key.

Optional environment variables:

- `GEMINI_API_KEY` or `VISION_API_KEY` — enables suggestions
- `VISION_MODEL` — default `gemini-flash-latest`
- `VISION_PROVIDER` — `gemini` (default) or `openai`
- `VISION_API_URL` — override the provider URL

Without a key, photos still save locally and the form asks you to type name and expiry.

## Expiry alerts when the app is closed

In-app reminders still appear in the Notifications view. To also get a system notification while the tab is closed:

1. Keep `npm start` running.
2. Open the app on localhost or HTTPS.
3. On Notifications, choose **Enable expiry alerts** and allow the browser permission.

The server generates a local VAPID key pair (no third-party push service account). It pings subscribed browsers when a new 30-day expiry reminder is created, and retries about every 15 minutes (`PUSH_INTERVAL_MS`). Optional `PUSH_CONTACT` is the VAPID `mailto:` subject (default `mailto:household@localhost`).

This is not email. Alerts require this computer’s Node process and a browser that still has the push subscription when running locally. On Cloudflare, a scheduled Worker delivers pushes without your Mac.

## Phone access on your domain (Cloudflare, no Mac)

Production URL: **https://medicineinventory.craftloop.ca**

Deploy with **Cloudflare Workers + D1 + R2** (always on). No tunnel and no `npm start` on your laptop for phone use. Step-by-step: **`deploy/cloudflare-workers.md`**.

Requires **Cloudflare Access** on that hostname and `GEMINI_API_KEY` as a Worker secret. The production Worker validates the signed Access JWT (issuer, audience, expiry, and signature) itself; it never treats an incoming email header as proof of identity. Local dev remains a loopback-only, single-household SQLite workflow at `npm start` → http://127.0.0.1:3000.

## Cloud Shops, roles and access

Cloud data is isolated by server-side **Shop** membership; the browser pins a Shop with the `X-Shop-Id` header and every request rechecks membership. A person can belong to several Shops.

- **Roles:** Owners manage a Shop's access; Members use its inventory. A Shop always keeps at least one Owner.
- **Invitations:** Owners invite people by email in Profile. The invitee accepts after signing in through Access, either on first visit or from the **Shop invitations** card in Profile if they already belong to another Shop.
- **Owner actions:** make a Member an Owner, make another Owner a Member, transfer ownership to a Member (you become a Member), or remove a Member. Anyone can leave a Shop (the last Owner cannot). Each change is atomic and recorded in an audit table.
- **Deleting a Shop:** an Owner can delete a Shop (never their only one) by typing its name and choosing how many days to keep it (7 to 30, default 14). Everyone loses access at once; medicines and photos are permanently purged after that period. Owners see it under **Recently deleted Shops** in Profile and can restore it themselves until then; company staff can also restore or extend it from `/admin`.
- **Another Shop:** users can create additional empty Shops (capped at five owned Shops).
- **Live updates:** while a tab is open on Dashboard or Inventory, the app polls a per-Shop change feed about once a minute and applies changes made on other devices.

Initial setup: set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `INITIAL_OWNER_EMAILS` (comma-separated one-time bootstrap allowlist, kept only in Cloudflare secrets), then the verified allowed account completes Shop setup to claim the initial Shop. Page loads never create membership. Cloudflare Access can use Google and Apple as identity providers; Apple's Service ID, keys and domain association live in Cloudflare and never in this repository.

## Admin console (company use only)

`/admin` is a separate console for company staff. It shows totals, Shops with members and roles, audit events and an admin activity log. It never shows medicine names, notes, photos or push details. With `ADMIN_WRITES_ENABLED=true` it can also revoke a pending invitation, restore a deleted Shop and extend its purge deadline; each needs a written reason and is audited. Without the flag it is read-only. The header has a **Sign out** link.

- It sits behind its own Cloudflare Access application for `/admin*`, separate from the customer application.
- The Worker also checks that token's audience (`ADMIN_ACCESS_AUD`) and that the email is in `ADMIN_EMAILS` (comma-separated Worker secret). If either is missing the console returns 503.
- Every authorized request writes to `admin_audit` before any data is returned. Every change writes its `admin_audit` row in the same transaction as the change.

## Data retention

Idempotency receipts (used only to make retries safe) are pruned automatically after 90 days by the 15-minute cron; set `RECEIPT_RETENTION_DAYS` (30 or more) to change that. The change feed and mutation receipts are kept 30 days. Audit history is never pruned.

## Deploying to Cloudflare

Required Worker secrets: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `INITIAL_OWNER_EMAILS`, `ADMIN_ACCESS_AUD`, `ADMIN_EMAILS`, plus optional `GEMINI_API_KEY`.

Feature flags (Worker secrets whose value is `true`; unset means off): `ADMIN_WRITES_ENABLED` (admin changes), `SHOP_DELETION_ENABLED` (owner **Delete this Shop**), `SHOP_PURGE_ENABLED` (permanent purge; without it the cron only logs a dry run). Set with `echo true | npx wrangler secret put NAME`, turn off with `npx wrangler secret delete NAME`. Turn on admin changes before Shop deletion so a deleted Shop can be restored.

**Per-Shop flags:** `SHOP_DELETION_ENABLED` and `SHOP_PURGE_ENABLED` are only the global defaults. In `/admin`, open a Shop and use **Feature flags for this Shop** to force a flag on, force it off, or make the Shop follow the global secret again. Changes need a written reason, are audited (admin log plus the Shop's own history) and apply on the very next request, with no deploy. A per-Shop override always beats the global secret, so **Automatic purge: off** holds one Shop's data while purging continues elsewhere. `ADMIN_WRITES_ENABLED` stays global because it guards `/admin` itself.

1. Run the tests: `npm test`.
2. Apply new D1 migrations first: `npm run cf:migrate` (migrations `0001` to `0023` live in `migrations/`; list pending ones with `npx wrangler d1 migrations list medicine-inventory --remote`).
3. Deploy the Worker and UI: `npm run deploy`.

Always migrate before deploying. Any new browser module under `public/` must be added to both `publicAssetPaths` (`lib/shared.js`) and `bootstrapAssetPaths` (`worker/index.js`), or it returns 404 in production; a test enforces this. Admin files under `public/admin/` are deliberately not in the public list.
