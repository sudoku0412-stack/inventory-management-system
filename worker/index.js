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
import { listBatchChanges, parseChangeQuery, pruneBatchChanges } from '../lib/batch-changes.js';
import { createAdditionalShop, listShops, onboardingStatus, pinnedTenant, resolveTenant, setupInitialShop, shopContext } from '../lib/tenants.js';
import { acceptHouseholdInvitation, createHouseholdInvitation, listHouseholdAccess, pendingHouseholdInvitations, promoteHouseholdMember, removeHouseholdMember, revokeHouseholdInvitation, validateMemberRemoval, validateOwnerPromotion, throttleInvitationRoute } from '../lib/household-access.js';

const jwksCache = { at: 0, keys: null };

const bootstrapAssetPaths = new Set(['/index.html', '/app.js', '/greeting.js', '/shop-client.js', '/shop-creation-client.js', '/owner-promotion-client.js', '/member-removal-client.js', '/shop-invitations-client.js', '/change-feed-client.js', '/styles.css', '/sw.js']);

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

async function ensureAccess(request, env) {
  const access = accessConfig(env);
  if (!access) throw Object.assign(new Error('Cloudflare Access JWT validation is not configured.'), { status: 503 });
  let keys = jwksCache.keys;
  if (!keys || Date.now() - jwksCache.at > 60 * 60 * 1000) {
    const certs = await fetch(access.certs);
    if (!certs.ok) throw Object.assign(new Error('Could not verify Cloudflare Access.'), { status: 503 });
    keys = (await certs.json()).keys || [];
    jwksCache.keys = keys;
    jwksCache.at = Date.now();
  }
  return requireCloudflareAccess(request, { env, now: Date.now, keys });
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

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
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
      if (request.method === 'GET' && url.pathname === '/api/household/access') return json(await listHouseholdAccess(env.DB, tenant));
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
      if (request.method === 'PATCH' && url.pathname === '/api/settings') return json(await store.updateSettings(await readJson(request)));
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
      return json({ error: error.message || 'Server error', ...(Object.hasOwn(error, 'current') ? { current: error.current } : {}) }, error.status || 500, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
    }
  }

  if (request.method !== 'GET' || !publicAssetPaths.has(url.pathname)) return new Response('Not found', { status: 404 });
  const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
  return fetchAsset(request, env, assetPath);
}

export async function deliverScheduledPushes(env, { storeFactory = createD1Store, loadKeys = loadVapid } = {}) {
  const memberships = await env.DB.prepare("SELECT household_id,MIN(user_id) AS user_id FROM memberships WHERE role='owner' GROUP BY household_id").all();
  const vapid = await loadKeys(env.KV, env);
  await Promise.all((memberships.results || []).map(({ household_id, user_id }) =>
    storeFactory(env.DB, env.PHOTOS, vapid, { householdId: household_id, userId: user_id }).deliverPushes({ contact: env.PUSH_CONTACT })));
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([deliverScheduledPushes(env), pruneBatchChanges(env.DB).catch(() => {})]));
  }
};
