# How to add a feature

A checklist for changes to this repository. Production resource names (`medicine-inventory` Worker, D1, R2, KV, the package name) stay as they are.

## 1. Decide where it lives

- **Shop-scoped** (acts on one Shop's data): add the route after `resolveTenant` in `worker/index.js` and filter every query by `tenant.householdId`.
- **Account-scoped** (no membership yet, or several Shops, or the person's own settings): add it before `resolveTenant`, and ignore `X-Shop-Id`. Add the path to the exclusions in `isShopScoped` (`public/shop-client.js`) if the browser must not send `X-Shop-Id`.
- **Membership change on a pinned Shop**: use `pinnedTenant` (requires `X-Shop-Id`, does not save a preference).
- Put the logic in a `lib/` module that takes `db` (and other bindings) as arguments, so tests can call it directly.

## 2. Server rules

- Check the role inside the `lib/` function from the database (`active_memberships`), never from the request.
- Writes that change structure: require JSON and same origin (`requirePromotionRequest` pattern), take an `operationId`, store a receipt, and write the audit row in the **same** `db.batch` as the change. Use guarded `INSERT ... SELECT ... WHERE` statements so the batch cannot half-apply.
- Return 503 while `migration_runs` is active for writes (follow the existing routes).
- Emails go through `notification_outbox` rows inserted in the same batch; never call the email provider inside a request.
- Keep user-facing text generic (say "item", not "medicine", outside Medicine Shop data) and call the shared space a Shop.

## 3. Database changes

- Add the next numbered file in `migrations/` (currently the last is `0032_custom_shop_types.sql`). Never edit or delete an applied migration.
- Keep changes additive. To widen a `CHECK`, rebuild the table with a copy and a row-count guard, like the `access_audit` rebuilds.
- Code that reads a new table should fail safely (or return 503) on an older database, because the Worker may briefly run before the migration in other environments.
- Production order: **apply migrations first** (`npm run cf:migrate`), then deploy the Worker (`npm run deploy`). Both need the owner's approval.
- If the new table holds Shop data, add it to the purge in `lib/shop-purge.js`.

## 4. New browser module

A new file under `public/` must be listed in **three places**, or it fails in production or offline:

| Where | Why |
| --- | --- |
| `publicAssetPaths` in `lib/shared.js` | The Worker serves only these paths; anything else is 404. The local server uses the same list |
| `bootstrapAssetPaths` in `worker/index.js` | Gives the file `no-cache, must-revalidate`, so a deploy is picked up at once |
| `PRECACHE` in `public/sw.js` | Lets the app shell start offline (large, rarely used files such as the barcode decoder are left out on purpose) |

`test/worker-assets.test.js` fails if an imported module is missing from the first two. Admin files under `public/admin/` are served only by the admin route and must **not** be added to these lists.

## 5. Tests and checks

- Add or update a `test/*.test.js` file when the change needs one: apply the real migrations to `node:sqlite`, and sign test JWTs for route tests.
- Run `npm test` and keep it green.
- Check important browser flows and phone and desktop layouts by hand.

## 6. Documents

- Update `HANDOVER.md` (status, migration needed, what was verified).
- Update the matching page in `docs/architecture/` if a flow, table or rule changed. For a significant design decision, add a section to [design-records.md](design-records.md).
- Update `README.md` if setup, secrets or user-visible behaviour changed.
