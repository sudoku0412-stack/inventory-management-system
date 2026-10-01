# Inventory Management System — handover

> Older release notes (everything dated before 2026-09-30, plus the early phase write-ups) live in [`docs/history/handover-archive.md`](docs/history/handover-archive.md). This file keeps the current state, the working agreement and the most recent release entries. When it grows past about 250 lines, move the oldest dated entries to the archive.

## Start here

- Product: Inventory Management System (responsive web) for any kind of stock; it began as a household medicine inventory. Not a commercial store product.
- Repository: https://github.com/sudoku0412-stack/inventory-management-system (public; renamed from medicine-inventory-tracker on 2026-10-02, GitHub redirects the old URL).
- **Production:** https://inventory-management.craftloop.ca (the old address medicineinventory.craftloop.ca redirects). Cloudflare Worker + D1 + R2 + KV behind **Cloudflare Access**. Deploy steps: [`docs/deployment.md`](docs/deployment.md).
- **Local dev:** Node 26+, `npm start` on http://127.0.0.1:3000, SQLite under `data/`. Run `npm test`.
- **Secrets (never commit):** local `data/gemini.key`, `data/vapid.json`, `.env`; cloud Wrangler secrets (`GEMINI_API_KEY`, `ACCESS_*`, `ADMIN_*`).
- **Architecture:** [`ARCHITECTURE.md`](ARCHITECTURE.md) and `docs/architecture/` describe the system as built; `docs/architecture/adding-a-feature.md` is the checklist for new work.

### Working agreement
- Every new feature ships with unit tests. Keep `npm test` green before a PR.
- Apply new D1 migrations first, then `npm run deploy`. Applying a migration or deploying to production needs the owner's OK.
- A new browser module under `public/` goes in `publicAssetPaths` (`lib/shared.js`), `bootstrapAssetPaths` (`worker/index.js`) and `PRECACHE` (`public/sw.js`); `test/worker-assets.test.js` checks the first two.
- Infrastructure names keep the old `medicine-inventory` name on purpose (Worker, D1 database, R2 bucket, KV, npm package). Do not rename them without a data migration plan.
- One agent at a time; no several background agents working on the same files.
- Update this file when a decision or completion status changes, and move the oldest dated entries to the archive when it passes about 250 lines.

## Follow-ups from the cleanup review (2026-10-02)
- `HANDOVER.md` split: everything dated before 2026-09-30 and the early phase write-ups moved unchanged to `docs/history/handover-archive.md`; this file now starts with "Start here" (state and working agreement).
- `deploy/` folded into `docs/`: the guide is `docs/deployment.md`. All links updated.
- Service worker cache renamed from `medicine-shell-v1` to `inventory-shell-v1`. `activate` removes caches with either prefix, so phones drop the old one when the new worker takes over. App shell is still network first, so nothing stale is served.
- `migration_runs` confirmed intentional: an operator-created read-only switch, absent means off. Commands are in `docs/deployment.md` ("Maintenance switch").
- New tests (suite 494): `email-outbox`, `weekly-digest`, `email-preferences`, `offline-queue` (queue, replay and offline store), `service-worker`, plus the shared helper `test/db-fixture.js`.

## Repository cleanup and architecture documents (2026-10-02)
- Documents only, no code, migration or behaviour change. `ARCHITECTURE.md` is now a short index; its old contents moved (with history) to `docs/architecture/design-records.md`. New as-built pages with Mermaid diagrams in `docs/architecture/`: overview, modules, request-lifecycle, data-model, flows, security, testing, adding-a-feature. `docs/README.md` lists every document.
- Moved: `BUGFIX_PLAN.md` to `docs/bugfix-plan.md`; the finished offline plans and spec from `docs/superpowers/` to `docs/history/`. Older entries below that name `ARCHITECTURE.md` sections now refer to `docs/architecture/design-records.md`.
- README has a repository layout section and the three asset lists (`publicAssetPaths`, `bootstrapAssetPaths`, `PRECACHE`).

## Admin console is responsive (2026-10-02)
- Client-only (`public/admin/admin.css`, `admin.js`, `index.html`), no migration, no behaviour change. On phones (<=720px) each table row is a labelled card (`data-label` on every cell, `td::before`); wide screens keep a table with sticky headers inside `.scroll`. Tabs are one scrolling, sticky row with pill styling, and the active tab scrolls into view. Header: title and Sign out on one row, then the notice and the signed-in email. Controls are 44px tall; Load more and action buttons go full width on phones.
- Empty tables now say "Nothing to show yet." Shop detail shows its type in a small box. The static notice says "item contents". Checked every tab at 375px (no horizontal scroll) and the Shops tab at desktop width against a mock; real admin data was not viewed. Tests in `test/admin-responsive.test.js` (suite 440).

## Old host redirects to the new one (2026-10-02)
- `legacyRedirect` in `worker/index.js` runs first in `handleRequest`: requests for `LEGACY_HOST` (`medicineinventory.craftloop.ca`, set in `wrangler.toml`) get a 301 (308 for non-GET/HEAD) to `APP_URL` with the same path and query, cached for a day. The target host comes only from `APP_URL`. No `LEGACY_HOST` means no redirect (local runs, tests). Tests in `test/legacy-redirect.test.js` (suite 433).
- The old host is still listed in the Access applications, so a signed-out visitor sees the Access login for the old host before the redirect. Remove the old host from both Access applications and from `routes` in `wrangler.toml` only once nobody uses it any more; the redirect then stops working for it.

## New domain and repo name (2026-10-02)
- Repo renamed to `sudoku0412-stack/inventory-management-system` (GitHub redirects the old URL; the local `origin` was updated). The npm package name, Worker, D1 database and R2 bucket keep `medicine-inventory`.
- New hostname `inventory-management.craftloop.ca` is added to `wrangler.toml` routes NEXT TO the old `medicineinventory.craftloop.ca`. `APP_URL` is still the OLD host on purpose: until Cloudflare Access covers the new host, emails must keep linking to the working one.
- Owner steps in the Cloudflare dashboard (the agent cannot edit Access): Zero Trust → Access → Applications → add `inventory-management.craftloop.ca` as a destination of BOTH the customer application and the `/admin*` application (same applications, so `ACCESS_AUD` and `ADMIN_ACCESS_AUD` do not change).
- Update (same day): the owner added the new host to both Access applications (verified: `/`, `/admin` and `/api/*` on the new host now redirect to Access login). `APP_URL`, README, ARCHITECTURE, `docs/deployment.md` and the Open Facts user agent now use the new host. The old host still serves; its redirect to the new host is NOT done yet and waits for the owner to confirm a real sign-in on the new host. Historical release notes below keep the old host name.
- Was next, after the owner confirms the new URL signs in: set `APP_URL` to the new host, update README, ARCHITECTURE, deploy docs and the Open Facts user agent, and redirect the old host to the new one (sessions are per host, so people sign in once more). The craftloop.ca website is handled in a separate repo.

## Admin sees Shop types; purge now removes list and barcode data (2026-10-02)
- Admin console (read-only, metadata only): Shops list has a **Type** column; Shop detail shows the type name, who made it (custom types), Strength shown or hidden, Form label and the lists the Shop currently offers; new **Shop types** tab (`GET /admin/api/shop-types`, audited as `shop-types.view`) lists every Owner-made type with owner email, started-as, Shop count and lists. No admin editing of types.
- Fixes the purge gap found in review: `lib/shop-purge.js` now also deletes `batch_barcodes`, `shop_options` and `shop_types` rows for the purged Shop (other Shops untouched). Shops purged BEFORE this deploy may still have such rows; not backfilled. Tests in `test/admin-console.test.js` and `test/shop-deletion.test.js` (suite 426).

## Custom Shop types (2026-10-02)
- Migration `0032_custom_shop_types.sql` (NOT yet applied to production): `custom_shop_types` (owner, name unique per owner, base type, `uses_strength`, `form_label`), `custom_type_options` (the four lists per type), and `shop_types.custom_type_id`. `shop_types.shop_type` still holds the BASE type ('medicine' or 'goods') for every Shop, so old code paths work; `custom_type_id` overrides lists and labels.
- An Owner makes types privately (max 10, names unique per Owner and never a built-in name). A new type copies the lists, Strength and Form label of Medicine, General goods or one of their own types, all editable. Types are only usable for the creator's own Shops. A type in use cannot be deleted. Shop-level add/hide (Manage lists) still layers on top of a type's lists.
- Code: `lib/shop-types.js` (create, update, list edits, delete, `customTypeForCreation`, `userIdFor`), `lib/options.js` (`shopTypeRef`, `isShopTypeKey`, `setShopType` accepting `custom:<id>`, `restoreShopType`, `typeInfo` in `/api/options`), `lib/tenants.js` (Shop creation with a custom type uses its first storage location). Routes `GET/POST /api/shop-types`, `/update`, `/options`, `/delete` run before `resolveTenant` (account scoped, same-origin JSON required).
- `settings.shop_type` is now the type KEY ('medicine', 'goods' or 'custom:<id>') plus `shop_type_info`, so it matches the Shop type select; the select keeps the Shop's current type listed even if it is another Owner's. Client: `public/shop-types-client.js` (Profile → Shop → "Manage Shop types" dialog, selects in Profile and Create Shop), `options-client.js` uses type info for the Strength field and Form label. Overview shows the type name.
- Not covered: platform admin cannot see or edit custom types; no rename of a built-in type. Tests in `test/shop-types.test.js` and `test/shop-types-routes.test.js` (suite 421).

## Generic wording across the app (2026-10-02)
- Client and message text only, no migration. Every visible "medicine" became "item" for all Shops (Add item, Total items, Item name, Item details, No items found, Search items, Inventory instead of "medicine cabinet", and the matching toasts, errors, export note and admin labels). The Gemini photo prompt now says product, and the Open Facts user agent is `InventoryManagementSystem/1.0`.
- Kept on purpose: the Shop type choice "Medicine", the "Medicine cabinet" storage location (a data value for Medicine Shops), CSS classes and element ids. The old `data-wording` reword for General goods Shops still exists but now has almost nothing to change; Form/Category and the hidden Strength still depend on Shop type.
- Open: custom domain (user will move off `medicineinventory.craftloop.ca` once wording is final; needs Cloudflare Access, `ACCESS_AUD`, redirect and `appUrl` changes). `test/generic-wording.test.js` guards the page text (suite 394).

## Renamed to Inventory Management System (2026-10-02)
- User-facing name only: page title, header brand, admin title, push notification text, invitation, deletion, ownership and weekly emails (`lib/email-outbox.js`), `EMAIL_FROM`, server log, README and ARCHITECTURE. Infrastructure names are deliberately unchanged (Worker, D1 database and R2 bucket `medicine-inventory`, repo, `package.json` name, production URL), because renaming them means migrating live data.
- The weekly email now reads "weekly inventory check". Medicine Shops still use medicine wording inside the app (`data-wording` handling); only the product name is generic.

## Fix: Overview "Show items" showed nothing on phones (2026-10-02)
- Cause: the Overview item list reuses `.table-wrap`, which the phone stylesheet hides (Inventory has a separate card list there). The filter worked; the list was invisible. Client-only, no migration.
- Now on phones (<=760px) each Overview row is a labelled card (`data-label` on every cell, `#overviewTable td::before`), and Show items scrolls to the list. Tests in `test/overview-mobile.test.js` (suite 387).

## Profile page split into Account / Shop / People tabs (2026-10-01)
- Client-only, no migration. Cause of the "overlapping" cards: several Profile cards had no margin, so they touched. `#profileView > .profile-card` now has one margin rule.
- New `public/profile-tabs.js` (in all three allowlists). Each card carries `data-tabs="account|shop|people"` (the Save row has `account shop`); the module toggles a `tab-off` class (`display: none !important`), so cards stay in the DOM and their own scripts and the `hidden` attribute keep working. The last tab is kept in `sessionStorage`; arrow keys, Home and End move between tabs.
- Account: Profile, Email notices (moved inside `#profileSettingsForm`), Device alerts, Sign out. Shop: Current Shop (selector, export, leave, delete), Shop name and type, defaults, Overview link, Create another Shop, Recently deleted Shops. People: Shop invitations (sent to you) and Shop access.
- One Save button still saves the whole form, shown on the Account and Shop tabs. Added `.check-row` styles for the email checkboxes. Gap: a pending-invitation signal on the People tab, and focus calls aimed at a card on another tab do nothing. Tests in `test/profile-tabs.test.js` (suite 384).

## Inventory header buttons: even grid and theme colours (2026-10-01)
- CSS and class names only. On phones (<=760px) Add medicine spans the full width on top, with Manage lists and Scan barcode side by side below (Scan takes the full row when Manage lists is hidden for non-Owners). Scan barcode is mint (`.action-scan`), Manage lists is white with a teal border (`.action-lists`). Test in `test/mobile-medicine-dialog.test.js` (suite 375).

## Dropdown lists moved out of Profile (2026-10-01)
- Client-only, no migration. The Owner list editor is now a dialog (`#optionsModal`) opened by a "Manage lists" button (`#openOptions`) in the Inventory header actions. The button is hidden unless the active Shop role is owner (`options-client.js` `renderManager`). The Profile card `#optionsCard` is gone. Tests in `test/stock-alert-strength.test.js` (suite 374).

## Strength suggestions and visible low-stock alert (2026-10-01)
- Migration `0031_strength_suggestions.sql` (NOT yet applied to production): rebuilds `option_defaults` and `shop_options` so `list` accepts `strength`, copies all rows, seeds six medicine defaults (100/200/250/500/1000 mg, 5 mg/5 mL). Goods Shops have none.
- Strength is a fourth list in `OPTION_LISTS` but stays FREE TEXT: it only feeds a `<datalist id="strengthOptions">` on the Add/Edit field. It is not validated, and `OPTIONAL_LISTS` in `lib/options.js` lets it be emptied (the other lists must keep one option). The Owner list editor and admin Lists tab show it for medicine Shops only.
- The per-item low-stock alert already existed (`low_stock_threshold`, default 4). It now shows in lists: the desktop quantity cell ("Alert at 4"), the mobile row ("8 tablets · alert at 4"). Restock reasons read "Low: 1 left (alert at 10)" and low items sort by shortfall (threshold minus quantity), biggest first. Expired and expiring items still come first. Helper `alertNote` in `public/restock-client.js`.
- Follow-up: the native datalist was too easy to miss (phones show it only while typing), so the same values also render as tap-to-fill chips under the Strength field (`#strengthChips`, hidden when the list is empty). Tapping a chip fills the field and fires `input`.
- Tests in `test/stock-alert-strength.test.js` (suite 372). Not done: a Shop-wide default threshold (new items still start at 4).

## Field info tips (2026-09-30)
- Client-only, no migration. `public/info-tips.js` adds a small "i" button to 18 fields (Add/Edit item form, Profile, Create Shop, Invite). Hover, focus or tap shows a one-line tip; tap pins it, Escape or a tap elsewhere closes. All tip text is in `FIELD_TIPS` in that file (one place to edit). The tip opens inside the open dialog (so it is not hidden behind it) and is placed by measuring where `left:0/top:0` lands, because the mobile dialog is a containing block for fixed elements. Tips avoid the word "medicine" so they fit General goods Shops.
- `options-client.js` renames the Form label to Category by changing only the label text node (a `textContent` assignment wiped the info button).
- New module `/info-tips.js` is in both allowlists and `PRECACHE`. Tests in `test/info-tips.test.js`. Not covered: fields added later need an entry in `FIELD_TIPS`.

## Fix: tapping a field in Edit reopened the batch details (2026-09-30)
- Cause: the Edit form carries `data-batch-id` (set by `edit()`), and the page-wide click handler opens the batch details for any `closest('[data-batch-id]')`, so every click inside the form reopened the details dialog on top. Fix: the handler uses `[data-batch-id]:not(form)`. Reproduced and verified in the in-app browser; source-pattern test added to `test/mobile-medicine-dialog.test.js`.

## Barcode lookup: short-form codes and brand names (2026-09-30)
- Bug: the Nestle jar scanned but nothing filled. Open Food Facts stores that product under the SHORT UPC-E code (`05525504`), not the UPC-A or EAN-13 forms the scanner now reports. `lookupBarcode` now tries every form in parallel: as scanned, leading-zero EAN-13, UPC-A and UPC-E (`upcaToUpce`, round-trip checked). Stored and returned `code` is still the canonical UPC-A.
- Open Facts names now get the brand in front unless the name already has it ("Nescafe Cafe"). Strength stays empty for goods; Open Facts quantity (e.g. "400 g") is not used yet.
- A product missing from every free database still opens a blank Add with the code attached; saving it teaches the Shop's own lookup.

## UPC-E fix: fallback decoder replaced (2026-09-30)
- Bug: a Nestle jar (UPC-E barcode `0 552550 4`) did nothing in the scanner. The first fallback (plain-JS `@zxing/library`) cannot read UPC-E at all. Replaced with `zxing-wasm` 3.1.4 reader (MIT, zxing-cpp as WebAssembly): `public/vendor/zxing-reader.iife.js` (36 KB) + `public/vendor/zxing_reader.wasm` (954 KB), licence in `public/vendor/ZXING-WASM-LICENSE.txt`. Loaded only on first scan; `locateFile` points at the local wasm so nothing comes from a CDN. Decoded the real jar photo in the in-app browser in about 200 ms.
- Native `BarcodeDetector`: formats are now filtered through `getSupportedFormats()` (desktop Chrome lacks `upc_a` and the constructor throws on unsupported formats).
- `lib/barcode.js`: UPC-E is expanded to UPC-A (`upceToUpca`, check digit verified so EAN-8 is untouched) and one canonical 12-digit form is stored and returned (`canonicalCode`), so native (8-digit UPC-E) and wasm (13-digit) scans match the same remembered item. Public databases are tried under both the 13-digit and 12-digit forms.
- A plain 8-digit code is now tried as a product barcode first and as a DIN LAST (UPC-E codes look like DINs and would otherwise match a random drug). `DIN 02241234` with the prefix still goes to Health Canada only.
- To update the library: `npm pack zxing-wasm`, copy `dist/iife/reader/index.js` and `dist/reader/zxing_reader.wasm`.

## Safari and Firefox scanning (2026-09-30)
- No migration. Browsers without `BarcodeDetector` load a vendored ZXing build (`public/vendor/zxing-library.min.js`, `@zxing/library` 0.21.3, Apache-2.0, licence in `public/vendor/ZXING-LICENSE.txt`) on first scan, through `public/zxing-detector.js` (same `new Detector({formats}).detect(video)` shape). Library is in both allowlists, not in `PRECACHE` (336 KB; loaded only when needed). Chrome and Edge keep the native detector.
- Tests: `test/zxing-detector.test.js` decodes real EAN-13, EAN-8 and UPC-A pixel frames through the adapter, plus the loader and the scanner's fallback choice. Loaded and decoded in the in-app browser too. NOT verified: a real iPhone camera (needs Safari 14.3+ on https; video is `playsinline muted`).
- To update the library: `npm pack @zxing/library`, copy `umd/index.min.js` (drop the sourceMappingURL line).

## DIN lookup in the scanner (2026-09-30)
- No migration. `lib/barcode.js` `parseCode`: "DIN 02241234" (6-8 digits, padded) uses Health Canada's Drug Product Database only; a plain 8-digit code is tried as a DIN first, then openFDA, then Open Facts; longer codes skip Health Canada. Returns name (title-cased), strength (only when one active ingredient) and a standard Form when the dosage form maps; source `din`.
- Scanner and typed box accept both; `code_128` and `itf` formats are read. Most Canadian packs print the DIN as text, not a barcode, so typing `DIN` plus the number is the reliable route.
- Tests in `test/barcode.test.js` (13). Verified live against Health Canada's API (DIN 00559407 returns Tylenol Extra Strength, 500 mg, Tablets).

## Barcode scan (2026-09-30)
- Migration `0030_batch_barcodes.sql` (apply BEFORE deploying): `batch_barcodes` remembers what a Shop saved for a scanned code (best effort, written after a create that carries `barcode`).
- `GET /api/barcode?code=` (Shop-scoped, any member): Shop's own earlier scans, then openFDA drug label `openfda.upc`, then Open Food/Beauty/Products Facts. All free, no key, 4 s timeout each; a miss returns `{ found: false }`, never an error.
- UI: "Scan barcode" button on Dashboard and Inventory headers opens a dialog with live scanning (`BarcodeDetector`, `public/barcode-client.js`) plus a type-the-number box. Result opens Add prefilled; the code is sent with the new item.
- Limits: `BarcodeDetector` exists in Chrome and Edge only; Safari (iPhone) and Firefox get the typed box. A vendored decoder library would fix that. Free databases miss many medicines. Health Canada DPD is not used (keyed by DIN, not the barcode).
- Verified: 331 tests (new `test/barcode.test.js`), the dialog flow in the in-app browser against a mock API. Live camera not verified (blocked in the browser pane); test on an Android phone.

## Configurable lists, Shop type, Owner overview (2026-09-30)
- Migration `0029_option_lists.sql` (apply BEFORE deploying): `option_defaults` (platform defaults per Shop type, seeded with today's medicine lists plus goods lists), `shop_options` (a Shop's own additions or hidden defaults), `shop_types` (no row = medicine, so every existing Shop is unchanged).
- Lists (`lib/options.js`): effective list = defaults for the Shop type, plus the Shop's custom options, minus the ones it hid. Server validation (`normalizeBatch` third argument, `allowedFor`) uses it; values an item already holds stay valid on edit, and the old plural units (`tablets`, `ml`, ...) are always accepted for older clients. Routes: `GET/POST /api/options`, `POST /api/options/hide`, `POST /api/options/remove` (writes Owner-only, same-origin). Profile "Dropdown lists" card for Owners. Admin console tab **Lists** edits platform defaults (`/admin/api/option-defaults`, needs `ADMIN_WRITES_ENABLED`, audited).
- Shop type: `medicine` or `goods`. Owners pick it when creating a Shop (`shopType`) and can change it in Profile (`PATCH /api/settings` `shop_type`). Goods hides Strength, calls Form "Category" and rewords the page. Only elements marked `data-wording` in `index.html` are reworded (never Shop or item names); strings set in JS go through `options.term()`.
- Owner overview (`lib/overview.js`): `GET /api/owner/overview` and `/api/owner/export` are account-scoped (every Shop the caller OWNS, never member-only Shops), ignore `X-Shop-Id`. UI: sidebar "Overview" (Owners only) plus a Profile card; per-Shop cards, combined table with Shop/status filters, "Print report" (opens a report window; browser Print saves a PDF) and combined CSV. Capped at 5000 items per Shop in the overview.
- New modules `/options-client.js` and `/overview-client.js` are in both allowlists and `PRECACHE`.
- Verified: existing suite 314/314, a throwaway script against the real migrations (lists, hide/add/remove, per-Shop isolation, Owner-only, validation, goods Shop creation, overview excludes member-only Shops, admin defaults) and the in-app browser against a mock API (medicine and goods wording, lists, overview, report escaping). Not verified: real phone, Print to PDF, the admin Lists tab in a browser.
- Next queued feature: barcode scan (needs decisions on data source, unknown barcodes, live camera vs photo).

## Inventory CSV export (2026-09-30)
- `lib/export.js`, `GET /api/household/export` (before tenant resolution, pinned Shop), `public/inventory-export-client.js` (both allowlists), button in Current Shop, and a nudge to export in the delete dialog. No migration, no flag, no audit row. Opened to Members as well as Owners at the user's request (2026-09-30). Tests: `test/inventory-export.test.js`.
- The user's 3-item queue (Recently deleted, receipt retention, export) is complete.

## Receipt retention cleanup (2026-09-30)
- `lib/retention.js` + cron call in `worker/index.js`: prunes creation, promotion, demotion, removal, leave, transfer, deletion and invitation-acceptance receipts older than 90 days (optional `RECEIPT_RETENTION_DAYS`, minimum 30), 500 rows per table per run, logs counts only when something was deleted. No migration, no flag. Audit tables and tombstones are never pruned. Tests: `test/receipt-retention.test.js`.

## Recently deleted Shops, owner restore (2026-09-30)
- `lib/deleted-shops.js`, routes `GET /api/shops/deleted` and `POST /api/shops/:id/restore` (before tenant resolution), Profile card `public/deleted-shops-client.js` (both allowlists). No migration. Not gated by the deletion flag. Tests: `test/deleted-shops.test.js`.
- Queue from the user (do in order, one agent, separate PRs): 1 this feature, 2 receipt retention cleanup (cron prune of old receipt tables), 3 inventory CSV export for owners.
