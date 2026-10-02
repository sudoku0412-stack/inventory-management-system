import {
  MAX_JSON_BYTES,
  accessConfig,
  photoTypes,
  publicAssetPaths,
  requireCloudflareAccess,
  suggestFromPhoto,
  visionConfig
} from '../lib/shared.js';
import { createD1Store, loadVapid } from '../lib/store-d1.js';
import { adminShopTypes, adminActivity, adminAudit, adminEmailOutbox, adminOverview, adminShopDetail, adminShops, adminExtendShop, adminRestoreShop, adminRevokeInvitation, adminSetShopFlag, authorizeAdmin, writeAdminAudit } from '../lib/admin.js';
import { listBatchChanges, parseChangeQuery, pruneBatchChanges } from '../lib/batch-changes.js';
import { purgeDeletedShops } from '../lib/shop-purge.js';
import { effectiveFlag } from '../lib/feature-flags.js';
import { pruneReceipts, retentionDays } from '../lib/retention.js';
import { dispatchOutbox, pruneOutbox } from '../lib/email-outbox.js';
import { enqueueWeeklyDigests } from '../lib/digest.js';
import { exportInventoryCsv } from '../lib/export.js';
import { lookupBarcode } from '../lib/barcode.js';
import { ownerOverview, ownerOverviewCsv } from '../lib/overview.js';
import { addDefaultOption, addShopOption, isShopTypeKey, restoreShopType, shopTypeRef, listDefaultOptions, removeDefaultOption, removeShopOption, setShopOptionHidden, setShopType, shopOptions, shopTypeOf } from '../lib/options.js';
import { getEmailPreferences, setEmailPreferences } from '../lib/email-preferences.js';
import { listDeletedShops, restoreOwnDeletedShop, validateOwnRestore } from '../lib/deleted-shops.js';
import { changeTypeOption, createShopType, deleteShopType, listShopTypes, updateShopType, userIdFor } from '../lib/shop-types.js';
import { createAdditionalShop, listShops, onboardingStatus, pinnedTenant, resolveTenant, setupInitialShop, shopContext } from '../lib/tenants.js';
import { acceptHouseholdInvitation, createHouseholdInvitation, listHouseholdAccess, pendingHouseholdInvitations, demoteHouseholdOwner, leaveHousehold, promoteHouseholdMember, removeHouseholdMember, revokeHouseholdInvitation, transferHouseholdOwnership, validateOwnershipTransfer, deleteHousehold, validateShopDeletion, validateMemberRemoval, validateOwnerDemotion, validateOwnerPromotion, validateShopLeave, throttleInvitationRoute } from '../lib/household-access.js';

const jwksCache = { at: 0, keys: null };

const bootstrapAssetPaths = new Set(['/index.html', '/app.js', '/greeting.js', '/shop-client.js', '/shop-creation-client.js', '/owner-promotion-client.js', '/member-removal-client.js', '/owner-demotion-client.js', '/ownership-transfer-client.js', '/shop-leave-client.js', '/shop-deletion-client.js', '/deleted-shops-client.js', '/email-preferences-client.js', '/inventory-export-client.js', '/options-client.js', '/overview-client.js', '/barcode-client.js', '/info-tips.js', '/profile-tabs.js', '/shop-types-client.js', '/csv-import-client.js', '/stock-history-client.js', '/bulk-select-client.js', '/zxing-detector.js', '/vendor/zxing-reader.iife.js', '/vendor/zxing_reader.wasm', '/shop-invitations-client.js', '/change-feed-client.js', '/offline-store.js', '/offline-queue.js', '/restock-client.js', '/styles.css', '/sw.js']);

export function assetCacheControl(path) {
  if (path === '/index.html') return 'no-store';
  if (bootstrapAssetPaths.has(path)) return 'no-cache, must-revalidate';
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(path)) return 'public, max-age=31536000, immutable';
  return null;
}

async function fetchAsset(request, env, assetPath) {
  const response = await env.ASSETS.fetch(new URL(assetPath, request.url));
  const cacheControl = assetCacheControl(assetPath);
  if (!cacheControl) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders }
  });
}

function noContent() { return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }); }

async function readJson(request, requireBody = false) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) throw Object.assign(new Error('Request body too large.'), { status: 413 });
  try {
    if (requireBody && !raw) throw new Error();
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { status: 400 });
  }
}

async function accessKeys(access) {
  let keys = jwksCache.keys;
  if (!keys || Date.now() - jwksCache.at > 60 * 60 * 1000) {
    const certs = await fetch(access.certs);
    if (!certs.ok) throw Object.assign(new Error('Could not verify Cloudflare Access.'), { status: 503 });
    keys = (await certs.json()).keys || [];
    jwksCache.keys = keys;
    jwksCache.at = Date.now();
  }
  return keys;
}

async function ensureAccess(request, env) {
  const access = accessConfig(env);
  if (!access) throw Object.assign(new Error('Cloudflare Access JWT validation is not configured.'), { status: 503 });
  return requireCloudflareAccess(request, { env, now: Date.now, keys: await accessKeys(access) });
}

const adminAssets = new Map([['/admin', '/admin/index.html'], ['/admin/', '/admin/index.html'], ['/admin/admin.js', '/admin/admin.js'], ['/admin/admin.css', '/admin/admin.css']]);
const adminHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
};

async function handleAdmin(request, env, url) {
  const requestId = requestCorrelationId(request);
  const api = url.pathname.startsWith('/admin/api/');
  try {
    const access = accessConfig({ ...env, ACCESS_AUD: env.ADMIN_ACCESS_AUD });
    const admin = await authorizeAdmin(request, env, access ? await accessKeys(access) : undefined);
    if (request.method === 'POST' && url.pathname === '/admin/api/option-defaults') {
      if (env.ADMIN_WRITES_ENABLED !== 'true') return json({ error: 'Admin changes are not enabled.' }, 403, adminHeaders);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ error: 'Content-Type must be application/json.' }, 400, adminHeaders);
      if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('x-admin-action') !== '1') return json({ error: 'This admin change must come from the console.' }, 403, adminHeaders);
      const body = await readJson(request);
      if (body.action !== 'add' && body.action !== 'remove') return json({ error: 'Choose add or remove.' }, 400, adminHeaders);
      await writeAdminAudit(env.DB, { email: admin.email, action: `option-default.${body.action}`, target: `${body.shopType}/${body.list}/${String(body.value).slice(0, 30)}`, requestId });
      return json(await (body.action === 'add' ? addDefaultOption : removeDefaultOption)(env.DB, body), 200, adminHeaders);
    }
    const writeRoute = request.method === 'POST' && api ? url.pathname.match(/^\/admin\/api\/shops\/([^/]+)\/(?:invitations\/([^/]+)\/revoke|restore|extend|flags)$/) : null;
    if (request.method !== 'GET' && request.method !== 'HEAD' && !writeRoute) return json({ error: 'Not found' }, 405, { ...adminHeaders, allow: 'GET, HEAD' });
    const writesEnabled = env.ADMIN_WRITES_ENABLED === 'true';
    if (writeRoute) {
      if (!writesEnabled) return json({ error: 'Admin changes are not enabled.' }, 403, adminHeaders);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ error: 'Content-Type must be application/json.' }, 400, adminHeaders);
      if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('x-admin-action') !== '1') return json({ error: 'This admin change must come from the console.' }, 403, adminHeaders);
      const body = await readJson(request);
      const done = writeRoute[2]
        ? await adminRevokeInvitation(env.DB, admin, { shopId: writeRoute[1], invitationId: writeRoute[2] }, body, { requestId })
        : url.pathname.endsWith('/extend')
          ? await adminExtendShop(env.DB, admin, writeRoute[1], body, { requestId })
          : url.pathname.endsWith('/flags')
            ? await adminSetShopFlag(env.DB, admin, writeRoute[1], body, { requestId })
            : await adminRestoreShop(env.DB, admin, writeRoute[1], body, { requestId });
      return json(done, 200, adminHeaders);
    }
    const params = url.searchParams, db = env.DB;
    const audited = async (action, target, load) => { await writeAdminAudit(db, { email: admin.email, action, target, requestId }); return json(await load(), 200, adminHeaders); };
    if (api) {
      if (url.pathname === '/admin/api/overview') return await audited('overview.view', null, async () => ({ ...await adminOverview(db), admin: admin.email, writesEnabled }));
      if (url.pathname === '/admin/api/shops') return await audited('shops.list', null, () => adminShops(db, params));
      const detail = url.pathname.match(/^\/admin\/api\/shops\/([^/]+)$/);
      if (detail) return await audited('shop.view', detail[1], async () => ({ ...await adminShopDetail(db, detail[1], undefined, env), writesEnabled }));
      if (url.pathname === '/admin/api/shop-types') return await audited('shop-types.view', null, () => adminShopTypes(db, params));
      if (url.pathname === '/admin/api/audit') return await audited('audit.view', params.get('shop'), () => adminAudit(db, params));
      if (url.pathname === '/admin/api/option-defaults') return await audited('option-defaults.view', null, async () => ({ ...await listDefaultOptions(db), writesEnabled }));
      if (url.pathname === '/admin/api/email-outbox') return await audited('email-outbox.view', null, () => adminEmailOutbox(db, params));
      if (url.pathname === '/admin/api/admin-audit') return await audited('admin-audit.view', null, () => adminActivity(db, params));
      return json({ error: 'Not found' }, 404, adminHeaders);
    }
    const assetPath = adminAssets.get(url.pathname);
    if (!assetPath) return new Response('Not found', { status: 404, headers: adminHeaders });
    if (assetPath === '/admin/index.html') await writeAdminAudit(db, { email: admin.email, action: 'console.open', requestId });
    const asset = await env.ASSETS.fetch(new URL(assetPath, request.url));
    return new Response(asset.body, { status: asset.status, headers: { ...adminHeaders, 'content-type': asset.headers.get('content-type') || 'application/octet-stream' } });
  } catch (error) {
    return json({ error: error.message || 'Server error' }, error.status || 500, adminHeaders);
  }
}

async function getStore(env, tenant, principal) {
  const vapid = await loadVapid(env.KV, env);
  return createD1Store(env.DB, env.PHOTOS, vapid, { ...tenant, displayName: principal?.displayName });
}

async function migrationIsActive(db) {
  try { return (await db.prepare("SELECT state FROM migration_runs WHERE singleton=1").first())?.state === 'active'; } catch { return false; }
}

function requestCorrelationId(request) {
  const supplied = request.headers.get('cf-ray') || request.headers.get('x-request-id');
  return typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function requireCreationRequest(request, url) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw Object.assign(new Error('Content-Type must be application/json.'), { status: 400 });
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw Object.assign(new Error('This Shop creation request must come from this site.'), { status: 403 });
}

function requirePromotionRequest(request, url) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw Object.assign(new Error('Content-Type must be application/json.'), { status: 400 });
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw Object.assign(new Error('This owner promotion request must come from this site.'), { status: 403 });
}

function requireInvitationAcceptanceRequest(request, url) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw Object.assign(new Error('Content-Type must be application/json.'), { status: 400 });
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw Object.assign(new Error('This invitation request must come from this site.'), { status: 403 });
}

/**
 * After a move to a new hostname: requests that reach the old hostname (LEGACY_HOST) are sent to APP_URL with the same
 * path and query. The target host always comes from APP_URL, never from the request, so this cannot redirect elsewhere.
 * Without LEGACY_HOST (local runs, tests) nothing is redirected.
 */
export function legacyRedirect(request, env) {
  const legacy = String(env.LEGACY_HOST || '').trim().toLowerCase();
  if (!legacy || !env.APP_URL) return null;
  const url = new URL(request.url);
  if (url.hostname.toLowerCase() !== legacy) return null;
  let target;
  try { target = new URL(env.APP_URL); } catch { return null; }
  if (target.hostname.toLowerCase() === legacy) return null;
  target.pathname = url.pathname;
  target.search = url.search;
  const safe = request.method === 'GET' || request.method === 'HEAD';
  return new Response(null, { status: safe ? 301 : 308, headers: { location: target.toString(), 'cache-control': 'public, max-age=86400' } });
}

export async function handleRequest(request, env, ctx) {
  const redirected = legacyRedirect(request, env);
  if (redirected) return redirected;
  const url = new URL(request.url);
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(request, env, url);
  if (url.pathname.startsWith('/api/')) {
    try {
      const principal = await ensureAccess(request, env);
      const requestId = requestCorrelationId(request);
      // Invitation discovery/acceptance deliberately runs before resolveTenant:
      // an invited identity has no membership yet. Every other API remains
      // membership-gated below.
      const pendingInvitation = url.pathname === '/api/household/invitations/pending';
      const invitationAcceptance = url.pathname.match(/^\/api\/household\/invitations\/([^/]+)\/accept$/);
      if ((pendingInvitation && request.method !== 'GET') || (invitationAcceptance && request.method !== 'POST')) return json({ error: 'Not found' }, 404);
      // Creation is intentionally before resolveTenant: it creates a destination
      // tenant and must ignore every X-Shop-Id without changing preferences.
      if (request.method === 'POST' && url.pathname === '/api/shops') {
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requireCreationRequest(request, url);
        const created = await createAdditionalShop(env.DB, principal, await readJson(request), { requestId });
        return json(created, created.created ? 201 : 200);
      }
      if (url.pathname === '/api/email-preferences') {
        if (request.method === 'GET') return json(await getEmailPreferences(env.DB, principal));
        if (request.method !== 'PUT') return json({ error: 'Not found' }, 404);
        requirePromotionRequest(request, url);
        return json(await setEmailPreferences(env.DB, principal, await readJson(request)));
      }
      // Deleted Shops are invisible to tenant resolution, so recovery is account-scoped and ignores X-Shop-Id.
      if (url.pathname === '/api/shops/deleted') {
        if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
        return json(await listDeletedShops(env.DB, principal));
      }
      // Owner overview is account-scoped (every Shop the caller owns) and ignores X-Shop-Id.
      if (url.pathname === '/api/owner/overview' || url.pathname === '/api/owner/export') {
        if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
        if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'This request must come from this site.' }, 403);
        if (url.pathname === '/api/owner/overview') return json(await ownerOverview(env.DB, principal));
        const file = await ownerOverviewCsv(env.DB, principal);
        return new Response(file.csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file.filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      }
      // Custom Shop types belong to the signed-in Owner, not to a Shop, so this runs before resolveTenant and ignores X-Shop-Id.
      if (url.pathname === '/api/shop-types' || url.pathname.startsWith('/api/shop-types/')) {
        const userId = await userIdFor(env.DB, principal);
        const action = url.pathname.slice('/api/shop-types'.length);
        if (request.method === 'GET' && action === '') return json(await listShopTypes(env.DB, userId));
        if (request.method !== 'POST' || !['', '/update', '/options', '/delete'].includes(action)) return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        const change = { '': createShopType, '/update': updateShopType, '/options': changeTypeOption, '/delete': deleteShopType }[action];
        return json(await change(env.DB, userId, body), action === '' ? 201 : 200);
      }
      const ownRestore = url.pathname.match(/^\/api\/shops\/([^/]+)\/restore$/);
      if (ownRestore) {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateOwnRestore(body);
        return json(await restoreOwnDeletedShop(env.DB, principal, ownRestore[1], body, requestId));
      }
      const promotion = url.pathname.match(/^\/api\/household\/members\/([^/]+)\/promote$/);
      // Promotion pins the caller's explicit Shop but must never update the
      // advisory preference used by ordinary Shop-scoped requests.
      if (promotion) {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateOwnerPromotion(promotion[1], body);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        return json(await promoteHouseholdMember(env.DB, principal, tenant, promotion[1], body, requestId));
      }
      if (url.pathname === '/api/household/export') {
        if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
        if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'This export must be requested from this site.' }, 403);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        const file = await exportInventoryCsv(env.DB, tenant);
        return new Response(file.csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file.filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      }
      const removal = url.pathname.match(/^\/api\/household\/members\/([^/]+)\/remove$/);
      if (removal) {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateMemberRemoval(removal[1], body);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        return json(await removeHouseholdMember(env.DB, principal, tenant, removal[1], body, requestId));
      }
      const demotion = url.pathname.match(/^\/api\/household\/members\/([^/]+)\/demote$/);
      if (demotion) {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateOwnerDemotion(demotion[1], body);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        return json(await demoteHouseholdOwner(env.DB, principal, tenant, demotion[1], body, requestId));
      }
      const transfer = url.pathname.match(/^\/api\/household\/members\/([^/]+)\/transfer$/);
      if (transfer) {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateOwnershipTransfer(transfer[1], body);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        return json(await transferHouseholdOwnership(env.DB, principal, tenant, transfer[1], body, requestId));
      }
      if (url.pathname === '/api/household/delete') {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateShopDeletion(body);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        // Read per request, so a staff change to this Shop's flag applies immediately.
        if (!await effectiveFlag(env.DB, env, tenant.householdId, 'shop_deletion')) return json({ error: 'Not found' }, 404);
        return json(await deleteHousehold(env.DB, principal, tenant, body, requestId));
      }
      if (url.pathname === '/api/household/leave') {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        validateShopLeave(body);
        const tenant = await pinnedTenant(env.DB, principal, request.headers.get('x-shop-id'));
        return json(await leaveHousehold(env.DB, principal, tenant, body, requestId));
      }
      if (request.method === 'GET' && url.pathname === '/api/shop/onboarding-status') return json(await onboardingStatus(env.DB, principal, env));
      if (request.method === 'POST' && url.pathname === '/api/shop/onboarding') {
        const setup = await setupInitialShop(env.DB, principal, env, await readJson(request), { requestId });
        return json(setup, setup.created ? 201 : 200);
      }
      if (request.method === 'GET' && pendingInvitation) {
        await throttleInvitationRoute(env.DB, principal, request, 'pending');
        return json(await pendingHouseholdInvitations(env.DB, principal, url.searchParams.get('cursor')));
      }
      if (request.method === 'POST' && invitationAcceptance) {
        if (await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
        requireInvitationAcceptanceRequest(request, url);
        const body = await readJson(request, true);
        if (Object.keys(body).length) throw Object.assign(new Error('Unexpected invitation acceptance field.'), { status: 400 });
        await throttleInvitationRoute(env.DB, principal, request, 'accept');
        return json(await acceptHouseholdInvitation(env.DB, principal, invitationAcceptance[1], undefined, requestId));
      }
      const tenant = await resolveTenant(env.DB, principal, { shopId: request.headers.get('x-shop-id') });
      if (request.method === 'GET' && url.pathname === '/api/shops') {
        const context = await shopContext(env.DB, principal);
        return json({ ...context, activeShopId: tenant.householdId });
      }
      if (request.method !== 'GET' && await migrationIsActive(env.DB)) return json({ error: 'Inventory is temporarily read-only while a migration is in progress.' }, 503);
      const invitation = url.pathname.match(/^\/api\/household\/invitations\/([^/]+)$/);
      if (request.method === 'GET' && url.pathname === '/api/household/access') return json(await listHouseholdAccess(env.DB, tenant, { shopDeletion: await effectiveFlag(env.DB, env, tenant.householdId, 'shop_deletion') }));
      if (request.method === 'POST' && url.pathname === '/api/household/invitations') return json(await createHouseholdInvitation(env.DB, tenant, await readJson(request), undefined, requestId), 201);
      if (invitation && request.method === 'DELETE') {
        await revokeHouseholdInvitation(env.DB, tenant, invitation[1], requestId);
        return noContent();
      }
      if (request.method === 'GET' && url.pathname === '/api/changes') {
        const query = parseChangeQuery(url.searchParams);
        await throttleInvitationRoute(env.DB, principal, request, 'changes');
        return json(await listBatchChanges(env.DB, tenant.householdId, query));
      }
      const store = await getStore(env, tenant, principal);
      const match = url.pathname.match(/^\/api\/batches\/([^/]+)(?:\/(consume|discard|photo))?$/);
      if (request.method === 'GET' && url.pathname === '/api/settings') return json(await store.settings());
      if (request.method === 'PATCH' && url.pathname === '/api/settings') {
        const body = await readJson(request);
        const wantsType = body.shop_type !== undefined;
        if (wantsType && !isShopTypeKey(body.shop_type)) return json({ error: 'Choose a valid Shop type.' }, 400);
        if (wantsType && tenant.role !== 'owner') return json({ error: 'Only Owners can change the Shop type.' }, 403);
        if (!wantsType) return json(await store.updateSettings(body));
        // The default location is checked against the new type's lists, so change the type first and undo it if the rest is refused.
        const previous = await shopTypeRef(env.DB, tenant.householdId);
        await setShopType(env.DB, tenant, body.shop_type);
        try { return json(await store.updateSettings(body)); } catch (error) { await restoreShopType(env.DB, tenant.householdId, previous); throw error; }
      }
      if (request.method === 'GET' && url.pathname === '/api/barcode') return json(await lookupBarcode(env.DB, tenant.householdId, url.searchParams.get('code')));
      if (url.pathname === '/api/options') {
        if (request.method === 'GET') return json(await shopOptions(env.DB, tenant.householdId));
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        requirePromotionRequest(request, url);
        return json(await addShopOption(env.DB, tenant, await readJson(request)));
      }
      if (url.pathname === '/api/options/hide' || url.pathname === '/api/options/remove') {
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        requirePromotionRequest(request, url);
        const body = await readJson(request);
        return json(url.pathname.endsWith('/hide') ? await setShopOptionHidden(env.DB, tenant, body) : await removeShopOption(env.DB, tenant, body));
      }
      if (request.method === 'GET' && url.pathname === '/api/batches') return json(await store.list());
      if (request.method === 'GET' && url.pathname === '/api/packaging/status') return json({ vision: Boolean(visionConfig(env)) });
      if (request.method === 'POST' && url.pathname === '/api/packaging/suggest') {
        const payload = await readJson(request);
        return json(await suggestFromPhoto(payload.photo, { env }));
      }
      if (request.method === 'POST' && url.pathname === '/api/batches') {
        const created = await store.create(await readJson(request));
        ctx.waitUntil(store.deliverPushes({ contact: env.PUSH_CONTACT }));
        return json(created, 201);
      }
      if (request.method === 'GET' && url.pathname === '/api/stock-events') {
        const batch = url.searchParams.get('batch');
        const limit = Number(url.searchParams.get('limit') || 50);
        return json(await store.stockHistory({ batchId: batch && batch.length <= 64 ? batch : null, limit }));
      }
      if (request.method === 'POST' && url.pathname === '/api/batches/bulk') return json(await store.bulkChange(await readJson(request)));
      if (request.method === 'POST' && url.pathname === '/api/batches/copy') {
        const result = await store.copyToShop(await readJson(request));
        ctx.waitUntil(store.deliverPushes({ contact: env.PUSH_CONTACT }));
        return json(result, 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/batches/import') {
        const result = await store.importBatches((await readJson(request)).rows);
        ctx.waitUntil(store.deliverPushes({ contact: env.PUSH_CONTACT }));
        return json(result, 201);
      }
      if (match && request.method === 'PATCH' && !match[2]) {
        const updated = await store.update(match[1], await readJson(request));
        ctx.waitUntil(store.deliverPushes({ contact: env.PUSH_CONTACT }));
        return json(updated);
      }
      if (match && request.method === 'POST' && match[2] === 'consume') return json(await store.consume(match[1], await readJson(request)));
      if (match && request.method === 'POST' && match[2] === 'discard') {
        await store.discard(match[1], await readJson(request));
        return noContent();
      }
      if (match && request.method === 'GET' && match[2] === 'photo') {
        const key = await store.photoMeta(match[1]);
        if (!key) return json({ error: 'Photo not found' }, 404);
        const object = await env.PHOTOS.get(key);
        if (!object) return json({ error: 'Photo not found' }, 404);
        const ext = key.slice(key.lastIndexOf('.'));
        return new Response(object.body, {
          headers: {
            'content-type': photoTypes[ext] || 'application/octet-stream',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
          }
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/notifications') return json(await store.notifications());
      if (request.method === 'POST' && url.pathname === '/api/notifications/read-all') {
        await store.readAll();
        return noContent();
      }
      const n = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (n && request.method === 'POST') {
        await store.read(n[1]);
        return noContent();
      }
      if (request.method === 'GET' && url.pathname === '/api/push/key') return json({ publicKey: store.vapid.publicKey });
      if (request.method === 'POST' && url.pathname === '/api/push/subscribe') {
        const saved = await store.savePushSubscription(await readJson(request));
        ctx.waitUntil(store.deliverPushes({ contact: env.PUSH_CONTACT }));
        return json(saved, 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
        await store.removePushSubscription((await readJson(request)).endpoint);
        return noContent();
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Server error', ...(Object.hasOwn(error, 'current') ? { current: error.current } : {}), ...(Object.hasOwn(error, 'problems') ? { problems: error.problems, moreProblems: error.moreProblems } : {}) }, error.status || 500, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
    }
  }

  if (request.method !== 'GET' || !publicAssetPaths.has(url.pathname)) return new Response('Not found', { status: 404 });
  const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
  return fetchAsset(request, env, assetPath);
}

export async function deliverScheduledPushes(env, { storeFactory = createD1Store, loadKeys = loadVapid } = {}) {
  const memberships = await env.DB.prepare("SELECT household_id,MIN(user_id) AS user_id FROM active_memberships WHERE role='owner' GROUP BY household_id").all();
  const vapid = await loadKeys(env.KV, env);
  await Promise.all((memberships.results || []).map(({ household_id, user_id }) =>
    storeFactory(env.DB, env.PHOTOS, vapid, { householdId: household_id, userId: user_id }).deliverPushes({ contact: env.PUSH_CONTACT })));
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([deliverScheduledPushes(env), pruneBatchChanges(env.DB).catch(() => {}), pruneReceipts(env.DB, { days: retentionDays(env) }).then(deleted => { if (Object.keys(deleted).length) console.log(`receipt retention: ${JSON.stringify(deleted)}`); }).catch(() => {}), enqueueWeeklyDigests(env.DB).catch(() => {}), dispatchOutbox(env).then(counts => { if (Object.keys(counts).length) console.log(`email outbox: ${JSON.stringify(counts)}`); }).catch(() => {}), pruneOutbox(env.DB).catch(() => {}), purgeDeletedShops(env.DB, env.PHOTOS, { dryRun: env.SHOP_PURGE_ENABLED !== 'true', log: message => console.log(message) }).catch(() => {})]));
  }
};
