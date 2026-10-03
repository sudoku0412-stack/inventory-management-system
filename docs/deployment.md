# Deploy to https://inventory-management.craftloop.ca (always on, no Mac, no tunnel)

This app runs on **Cloudflare Workers** with **D1** (inventory), **R2** (packaging photos), and **KV** (VAPID keys). Your phone opens the domain over HTTPS and can use **Take photo** for scanning.

Local `npm start` still works for development (SQLite in `data/`). Production data lives in Cloudflare, not on your laptop.

## Before you publish

1. **Cloudflare Access** on `inventory-management.craftloop.ca` (Zero Trust → Access → self-hosted app). Configure Google and/or Apple identity providers and allow only intended household accounts. Apple requires an Apple Developer Service ID, configured return URL and domain association in Apple’s portal, then the provider configuration in Cloudflare; keep all Apple credentials in the respective consoles.
2. **Gemini key** as a Worker secret for packaging scan.

## One-time Cloudflare setup

1. Install Wrangler and log in:

```sh
npm install
npx wrangler login
```

2. **Enable R2** in the Cloudflare dashboard (same account as Workers): open **R2** in the left sidebar and accept setup (Workers Free includes a small R2 allowance; billing may ask for a payment method even if usage stays free). Error `10042` means R2 is not enabled yet.

3. Create resources (once):

```sh
npx wrangler d1 create medicine-inventory
npx wrangler r2 bucket create medicine-inventory-photos
npx wrangler kv namespace create medicine-inventory-kv
```

You already created D1 and KV. After R2 is enabled, run only:

```sh
npx wrangler r2 bucket create medicine-inventory-photos
```

4. Confirm `wrangler.toml` has your **D1 database_id** and **KV id** (this repo pins the ids from your account).

5. Apply the schema:

```sh
npx wrangler d1 migrations apply medicine-inventory --remote
```

6. Set secrets:

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
npx wrangler secret put INITIAL_OWNER_EMAILS
```

Use your Access team URL (for example `https://<team>.cloudflareaccess.com`) and the application **Audience** tag from the Access app for this hostname. `INITIAL_OWNER_EMAILS` is a comma-separated, one-time bootstrap allowlist. Enter it directly into the secret prompt; do not add real addresses to `wrangler.toml`, source, or documentation.

For the tenant migration, apply migrations first, set these three Access/bootstrap secrets, then deploy. A verified allowlisted account must explicitly submit the Shop setup screen to atomically create the first Shop and backfill existing unassigned batches, notifications, settings, and push subscriptions. Page loads never create access. Unknown users are denied; a second allowlisted account is not auto-added. Confirm that first setup before enabling Access policies for additional people.

### Feature flags

These are optional Worker secrets; a feature is off unless the value is exactly `true`:

```sh
echo true | npx wrangler secret put ADMIN_WRITES_ENABLED   # /admin: revoke invitation, restore Shop, extend deadline
echo true | npx wrangler secret put SHOP_DELETION_ENABLED  # owners can delete a Shop (7 to 30 day keep period)
echo true | npx wrangler secret put SHOP_PURGE_ENABLED     # cron permanently purges Shops after their keep period
```

Enable admin changes first so a deleted Shop can be restored. These secrets are global defaults; staff can override `SHOP_DELETION_ENABLED` and `SHOP_PURGE_ENABLED` for a single Shop in `/admin` (migration 0023), and an override wins immediately. Without `SHOP_PURGE_ENABLED` the 15-minute cron only logs what it would purge. Turn a flag off with `npx wrangler secret delete NAME`; the change takes effect immediately.

7. Attach the custom domain in the Cloudflare dashboard if Wrangler has not already linked `inventory-management.craftloop.ca`.

## Deploy

```sh
npm run deploy
```

Open **https://inventory-management.craftloop.ca** on your phone, sign in with Access, then **Add item → Take photo**.

## Public landing page (optional)

`/welcome` is a branded page anyone can open, with a **Sign in** button that goes to the app root (which Access protects). The Worker
serves only `/welcome`, `/welcome/` and `/welcome/landing.css` this way. To let signed-out visitors see it, add one more Access
application in Zero Trust:

- Type: self-hosted. Destination: `inventory-management.craftloop.ca` with path `/welcome*`.
- Policy: action **Bypass**, include **Everyone**.

The more specific path wins over the main application, so the rest of the site stays behind Access. Share
`https://inventory-management.craftloop.ca/welcome` as the public address. Without the bypass the page still works, but visitors sign in first.

## Maintenance switch (optional, during risky migrations)

The Worker has a read-only switch for the moments when a migration must not race with writes. It is deliberately **not** created by a migration: if the table `migration_runs` does not exist, the app behaves normally. When the table exists and its single row has `state = 'active'`, every write route answers 503 ("Inventory is temporarily read-only while a migration is in progress") and the admin Overview shows the state. Reads keep working.

```sh
# Turn read-only mode ON before the migration
npx wrangler d1 execute DB --remote --command "CREATE TABLE IF NOT EXISTS migration_runs (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state TEXT NOT NULL); INSERT OR REPLACE INTO migration_runs (singleton, state) VALUES (1, 'active');"

# Turn it OFF after the migration and the deploy
npx wrangler d1 execute DB --remote --command "DROP TABLE IF EXISTS migration_runs;"
```

Do not leave it on: nobody can save changes while it is active. The additive migrations used so far (new tables and columns) did not need it.

## What runs where

| Piece | Cloudflare | Your Mac |
| --- | --- | --- |
| HTML / CSS / JS | Worker assets (`public/`) | optional `npm start` for dev |
| Inventory API + SQLite logic | Worker + D1 | local SQLite when developing |
| Photos | R2 | `data/photos/` locally |
| Expiry push cron | Worker scheduled (every 15 min) | local timer when using `npm start` |
| Gemini scan | Worker → Google API | same when local |

## Local dev vs cloud

- **Local:** `npm start` → http://127.0.0.1:3000 (unchanged workflow).
- **Cloud:** `npm run deploy` → D1/R2/KV; does not copy your local `data/inventory.sqlite`. Use the one-time import below to migrate an existing cabinet.

## One-time import of a local cabinet

`tools/export-local-to-d1.js` works offline and never contacts Cloudflare. It reads `data/inventory.sqlite` read-only and writes a SQL file and an R2 upload script. Push subscriptions, settings and secrets are not exported. Discarded and zero-quantity batches are skipped, and rows are validated with the same rules as the API.

1. Sign in once so the target Shop exists, then find its id (`households.id`): `npx wrangler d1 execute medicine-inventory --remote --command "SELECT id,name FROM households"`.
2. Dry run (prints the summary, writes nothing): `node tools/export-local-to-d1.js --shop-id <uuid> --dry-run`
3. Generate the files: `node tools/export-local-to-d1.js --shop-id <uuid>` (options: `--db`, `--out`, `--photos-out`; defaults `data/inventory.sqlite`, `data/d1-import.sql`, `data/d1-import-photos.sh`).
4. Import rows: `npx wrangler d1 execute medicine-inventory --remote --file data/d1-import.sql`
5. Upload photos: `sh data/d1-import-photos.sh` (runs `wrangler r2 object put ... --remote`).

Re-running is safe: batches use their local ids with `INSERT OR IGNORE`, and photo keys are `photos/<batch id>.<ext>`. Import rows before uploading photos or in either order; a row whose photo is missing simply shows no photo.

## Troubleshooting

- **401 Sign in through Cloudflare Access:** confirm the signed assertion comes from the configured team domain and matches the application audience. The Worker validates this JWT and does not trust `Cf-Access-Authenticated-User-Email`. A missing or wrong audience causes API 401 while the HTML still loads.
- **403 This account is not a member:** set `INITIAL_OWNER_EMAILS` before the first post-migration sign-in, then sign in once with one configured address. Existing invitations are pending records, not access grants, until a future acceptance flow is deployed.
- **Unable to load inventory / empty dashboard:** run `npx wrangler d1 migrations apply medicine-inventory --remote`, then check DevTools → Network → `/api/batches` (401 = Access secrets; 500 = D1/migrations).
- **Vision false / no Gemini suggestions:** set `GEMINI_API_KEY` secret and redeploy.
- **R2 error 10042:** enable R2 in the Cloudflare dashboard first, then create the bucket again.
