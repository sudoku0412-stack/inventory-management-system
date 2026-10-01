# Key flows

Each diagram follows the code paths named under it. Route handlers are in `worker/index.js`.

## 1. Sign-in and Shop selection

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser (app.js)
  participant A as Cloudflare Access
  participant W as Worker
  participant D as D1
  B->>A: Open the app
  A-->>B: Login (Google, Apple, ...) then CF_Authorization cookie
  B->>W: GET /api/shop/onboarding-status
  W->>D: Membership? Pending invitation? Bootstrap done?
  W-->>B: { membership, pendingInvitation, setupEligible }
  alt Has a membership
    B->>W: GET /api/shops (with saved X-Shop-Id if any)
    W->>D: resolveTenant, then list memberships
    W-->>B: { accountContextKey, shops, activeShopId }
    B->>B: Save context to IndexedDB, show the app
  else First owner (setupEligible)
    B->>W: POST /api/shop/onboarding { displayName, shopName }
    W->>D: One batch: user, identity, Shop, tenant_bootstrap, owner membership, settings, audit
    B->>B: Reload
  else Invited
    B->>W: GET /api/household/invitations/pending (throttled)
    B->>W: POST /api/household/invitations/:id/accept
  else Nothing
    B->>B: "No Shop invitation found"
  end
```

- Switching Shops: the browser confirms the new Shop with `GET /api/shops` and `X-Shop-Id` (which saves the preference), then reloads so no state from the old Shop remains (`shop-client.js`, `app.js`).
- If `/api/shop/onboarding-status` answers 404, the app runs in local single-household mode.
- If the network fails at start-up, `offlineBoot` shows the last saved snapshot of the Shop from IndexedDB.

## 2. Add or edit an item, with the offline queue

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant B as Browser (app.js)
  participant Q as IndexedDB queue (offline-queue.js)
  participant W as Worker (store-d1.js)
  participant D as D1
  U->>B: Save item
  B->>W: POST /api/batches or PATCH /api/batches/:id<br/>{ ...fields, operationId, baseRevision }
  alt Online
    W->>D: Receipt for operationId? (replay if found)
    W->>W: Validate against the Shop's lists (allowedFor)
    W->>D: One batch: write batch (revision + 1, only if revision = baseRevision),<br/>mutation receipt, batch_changes row
    alt Revision changed meanwhile
      W-->>B: 409 { current }
    else Saved
      W-->>B: Batch
    end
  else Offline or network error
    B->>Q: enqueue (collapses with earlier entries for the same item)
    B->>B: Optimistic list, "Waiting to sync" mark
    Note over B,Q: Later: "Sync now", coming back online, or start-up
    B->>W: Probe /api/shop/onboarding-status (redirect: manual)
    B->>W: Replay entries in order (replayQueue)
    alt 409 and the local edit is newer than current.updated_at
      B->>W: Rebase on current and resend (up to 3 tries)
    else 409 and the server copy is newer, or it was discarded
      B->>Q: Drop the entry (counted as replaced)
    else 401, 403 or an Access redirect
      B->>B: "Session expired" banner, entries stay queued
    end
  end
```

- New photos are written to R2 first; if the database write fails, the photo is removed.
- After a create that carries `barcode`, `rememberBarcode` saves the name and fields for that code in `batch_barcodes`.
- Other devices see the change through the change feed: `change-feed-client.js` polls `GET /api/changes?after=<seq>` about once a minute (with backoff and a full reload every 10 minutes as a safety net).

## 3. Barcode scan and lookup order

```mermaid
flowchart TD
  scan["Scan (BarcodeDetector, or zxing-wasm fallback)<br/>or type a code"] --> api["GET /api/barcode?code="]
  api --> parse{"parseCode"}
  parse -->|invalid| e400["400"]
  parse -->|"DIN 0224..."| shopD["Shop's saved codes<br/>(batch_barcodes)"]
  parse -->|"8 to 14 digits"| shopB["Shop's saved codes<br/>(canonical UPC-A for UPC-E)"]
  shopD -->|miss| hc["Health Canada DPD only"]
  shopB -->|miss| pub["For each code form in parallel<br/>(as scanned, EAN-13, UPC-A, UPC-E):<br/>openFDA, then Open Food, Beauty, Products Facts"]
  pub -->|"miss and code is 8 digits"| hc2["Health Canada DPD (as a DIN)"]
  shopD -->|hit| found["{ found: true, source, name, ... }"]
  shopB -->|hit| found
  pub -->|hit| found
  hc --> result["found, or { found: false }"]
  hc2 --> result
  pub -->|"miss, longer code"| miss["{ found: false }"]
```

Each external call has a 4-second timeout and no API key. A miss is not an error: the app opens a blank Add form with the code attached, and saving it teaches the Shop's own lookup.

## 4. Shop type and list resolution

```mermaid
flowchart TD
  shop["Shop"] --> st{"shop_types row?"}
  st -->|no| med["Built-in Medicine"]
  st -->|"yes, custom_type_id set"| custom["Custom type:<br/>name, uses_strength, form_label"]
  st -->|"yes, no custom type"| builtin["Built-in Medicine or General goods"]
  med --> defaults["Defaults from option_defaults (shop_type)"]
  builtin --> defaults
  custom --> cdefaults["Defaults from custom_type_options"]
  defaults --> merge["+ shop_options with is_custom = 1<br/>- shop_options with hidden = 1"]
  cdefaults --> merge
  merge --> lists["Effective lists: form, unit, location, strength"]
  lists --> ui["GET /api/options: lists, manage view, typeInfo"]
  lists --> validate["allowedFor: validates form, unit and location on save<br/>(a value the item already has stays valid;<br/>old plural units always accepted)"]
```

- Strength is suggestions only (free text) and may be emptied; the other lists must keep at least one option.
- Owners edit a Shop's lists (`POST /api/options`, `/hide`, `/remove`). Staff edit platform defaults in `/admin` (`ADMIN_WRITES_ENABLED`).
- Custom types (`lib/shop-types.js`) are private to the Owner who made them (at most 10), start as a copy of a built-in or another of their types, and cannot be deleted while a Shop uses them. Only the type's owner can assign it to a Shop; another Owner can still save the Shop's settings with the type unchanged.

## 5. Invitations and ownership

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner
  participant W as Worker (household-access.js)
  participant D as D1
  participant I as Invited person
  O->>W: POST /api/household/invitations { email, role }
  W->>D: One batch: replace an expired invite, insert invite (7 days),<br/>access_audit invite_created, outbox invitation_created
  Note over D: Cron sends the email through Resend
  I->>W: GET /api/household/invitations/pending (matched by verified email)
  I->>W: POST /api/household/invitations/:id/accept
  W->>D: One batch: user and identity if new, membership with the invited role<br/>(caps: 50 memberships, 5 owned Shops for an owner invite),<br/>acceptance receipt, delete invite, audit invite_accepted
  W-->>I: { householdId, role, accepted }
```

Owner actions on the pinned Shop (all need `X-Shop-Id`, an operation id for replay, and write an audit event):

| Action | Route | Rule |
| --- | --- | --- |
| Make owner | `POST /api/household/members/:id/promote` | Target is a Member of this Shop |
| Make member | `POST /api/household/members/:id/demote` | Target is another Owner; at least two Owners exist |
| Transfer ownership | `POST /api/household/members/:id/transfer` | Target Member becomes Owner, caller becomes Member; the new Owner gets an email |
| Remove member | `POST /api/household/members/:id/remove` | Target is a Member |
| Leave | `POST /api/household/leave` | Anyone except the last Owner |
| Revoke invitation | `DELETE /api/household/invitations/:id` | Owner of the Shop |

## 6. Shop deletion, restore and purge

```mermaid
stateDiagram-v2
  [*] --> Active
  Active --> Deleted: Owner deletes (flag on, types the name,<br/>has another Shop, keeps 7 to 30 days)
  Deleted --> Active: Owner restores, or staff restore in /admin<br/>(before purge_after)
  Deleted --> Deleted: Staff extend the keep period
  Deleted --> Purged: Cron after purge_after<br/>(shop_purge effective)
  Purged --> [*]
```

- **Delete** (`POST /api/household/delete`): needs the effective `shop_deletion` flag (per-Shop override, else `SHOP_DELETION_ENABLED`). One batch writes the receipt, the `household_deletions` row, the audit event and `shop_deleted` emails to other members, and removes pending invitations and push subscriptions. `active_memberships` hides the Shop immediately.
- **Restore** (`POST /api/shops/:id/restore`, account-scoped): an Owner of the deleted Shop, inside the keep period, owning fewer than five active Shops. Staff use `POST /admin/api/shops/:id/restore` or `/extend` with a written reason.
- **Purge** (`purgeDeletedShops`): up to 5 Shops per run. A per-Shop `shop_purge` override wins; otherwise `SHOP_PURGE_ENABLED` decides, and without it the run only logs. Photos are deleted from R2 first; then one batch removes the Shop's rows (batches, notifications, change feed, mutation receipts, push subscriptions, invitations, settings, preferences, barcodes, lists, type, memberships), renames the Shop `(deleted Shop)`, sets `purged_at` and writes `shop_purged`.

## 7. Weekly digest and email outbox

```mermaid
sequenceDiagram
  autonumber
  participant C as Cron (every 15 min)
  participant D as D1
  participant R as Resend
  Note over C,D: Business writes insert outbox rows in the same batch<br/>(invitation, deletion, ownership transfer)
  C->>D: enqueueWeeklyDigests (Monday 14:00 to 16:00 UTC):<br/>counts per Shop, one row per person, key weekly_digest:user:date
  C->>D: dispatchOutbox: select up to 20 due rows, lease each for 5 minutes
  loop Each leased row
    C->>D: Still needed? (invite valid, deletion not undone,<br/>not opted out, digest under 2 days old)
    alt Not needed
      C->>D: status cancelled
    else Send
      C->>R: POST /emails with Idempotency-Key = dedupe_key
      alt 2xx
        C->>D: status sent
      else 429, 409 or 5xx, or network error
        C->>D: pending, backoff 15 min doubling up to 4 h<br/>(uncertain after 24 h)
      else Other 4xx
        C->>D: status failed
      end
    end
  end
  C->>D: pruneOutbox (30 days)
```

Emails contain no item names. The digest has only counts per Shop. Without `RESEND_API_KEY`, `EMAIL_FROM` and an https `APP_URL`, dispatch does nothing and rows wait. Staff see queued, failed and uncertain rows in the admin **Email** tab.

## 8. Admin console

```mermaid
sequenceDiagram
  autonumber
  participant S as Staff browser (/admin)
  participant A as Access (/admin* application)
  participant W as Worker (handleAdmin, lib/admin.js)
  participant D as D1
  S->>A: Open /admin
  A-->>S: Admin Access session
  S->>W: GET /admin/api/... (JWT with ADMIN_ACCESS_AUD)
  W->>W: authorizeAdmin: audience, email in ADMIN_EMAILS
  W->>D: INSERT admin_audit (refuse with 503 if it fails)
  W->>D: Read metadata only
  W-->>S: JSON (no-store, strict CSP)
  opt Write (ADMIN_WRITES_ENABLED)
    S->>W: POST /admin/api/shops/:id/... (revoke, restore, extend, flags)<br/>X-Admin-Action: 1, same origin, { operationId, reason, ... }
    W->>D: One batch: change + admin_audit row (only if the change applied)
  end
```

Tabs: Overview, Shops (type, members, roles, deletion state, flags, lists), Audit, Lists (platform defaults), Shop types, Email (outbox) and Admin log. Shop writes need a 10 to 500 character reason, are limited to 30 per admin per minute and replay safely by operation id. Platform list defaults are changed with `POST /admin/api/option-defaults`, which writes its `admin_audit` row before the change.
