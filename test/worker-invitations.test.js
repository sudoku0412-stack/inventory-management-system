import { deletionReadSchema, invitationRoleSchema, outboxSchema } from './deletion-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { deliverScheduledPushes, handleRequest } from '../worker/index.js';
import { createVapidKeys } from '../lib/shared.js';
import { createHouseholdInvitation } from '../lib/household-access.js';
import { createAdditionalShop, setupInitialShop } from '../lib/tenants.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'invite-key', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
function jwt({ subject, email, ...claims }) {
  const header = b64({ alg: 'RS256', kid: 'invite-key', typ: 'JWT' });
  const payload = b64({ iss: 'https://team.cloudflareaccess.com', aud: 'medicine-audience', exp: Math.floor(Date.now() / 1000) + 60, sub: subject, email, ...claims });
  const data = `${header}.${payload}`;
  return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
}
function d1(sqlite) {
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  // D1 serializes entire transactional batches: no other request may observe a
  // partially applied batch. Reads still yield, allowing stale preflight races.
  return { prepare: statement, batch: async statements => { sqlite.exec('BEGIN'); try { const out=statements.map(item => item.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
}
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0003_profile_settings.sql', '0004_household_tenants.sql', '0005_household_invitations.sql', '0006_household_invitation_expiration.sql', '0007_sync_mutation_foundation.sql', '0008_household_display_name_source.sql', '0009_seed_legacy_household_display_names.sql', '0010_access_audit.sql', '0011_user_shop_preferences.sql', '0012_shop_creation.sql', '0013_shop_owner_promotion.sql', '0014_additional_shop_invitation_joins.sql', '0015_batch_change_feed.sql', '0016_shop_member_removal.sql', '0017_shop_demotion_leave.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  sqlite.exec(deletionReadSchema);
  sqlite.exec(outboxSchema);
  sqlite.exec(invitationRoleSchema);
  return { sqlite, db: d1(sqlite) };
}
function preCreationDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0003_profile_settings.sql', '0004_household_tenants.sql', '0005_household_invitations.sql', '0006_household_invitation_expiration.sql', '0007_sync_mutation_foundation.sql', '0008_household_display_name_source.sql', '0009_seed_legacy_household_display_names.sql', '0010_access_audit.sql', '0011_user_shop_preferences.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  return sqlite;
}
function request(path, token, method = 'GET') { return new Request(`https://medicineinventory.craftloop.ca${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': token, ...(method === 'POST' ? { 'content-type': 'application/json', Origin: 'https://medicineinventory.craftloop.ca' } : {}) }, body: method === 'POST' ? '{}' : undefined }); }
function shopRequest(path, token, { method = 'GET', shopId, body } = {}) {
  return new Request(`https://medicineinventory.craftloop.ca${path}`, {
    method,
    headers: { 'Cf-Access-Jwt-Assertion': token, ...(shopId ? { 'X-Shop-Id': shopId } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('promotion route authenticates, validates, isolates, replays and never resolves or writes preferences', async () => {
  const { sqlite, db } = database(), originalFetch = globalThis.fetch;
  try {
    const actor = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'promotion-owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' }, { displayName: 'Owner', shopName: 'Shop A' });
    const shopB = uuid(101), member = uuid(102), foreign = uuid(103), missing = uuid(104), operationId = uuid(105);
    sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shopB, 'Shop B', 'before');
    for (const [id, subject, shop, role] of [[member, 'promotion-member', actor.householdId, 'member'], [foreign, 'promotion-foreign', shopB, 'owner']]) {
      sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
      sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', subject, id, `${subject}@example.test`, 'before');
      sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 'before');
    }
    sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shopB, actor.userId, 'member', 'before');
    sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(actor.userId, shopB, 'unchanged actor preference');
    sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(member, actor.householdId, 'unchanged member preference');
    const preferences = () => Buffer.from(JSON.stringify(sqlite.prepare('SELECT * FROM user_shop_preferences ORDER BY user_id').all()));
    const before = preferences(), queries = [];
    const env = { DB: { ...db, prepare(sql) { queries.push(sql); return db.prepare(sql); } }, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' };
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const run = async ({ method = 'POST', target = member, headers = {}, body = { operationId }, raw, subject = 'promotion-owner', expected = 400 } = {}) => {
      const response = await handleRequest(new Request(`https://medicineinventory.craftloop.ca/api/household/members/${target}/promote`, {
        method, headers: { 'Cf-Access-Jwt-Assertion': jwt({ subject, email: 'owner@example.test' }), Origin: 'https://medicineinventory.craftloop.ca', 'Content-Type': 'application/json', 'X-Shop-Id': actor.householdId, ...headers },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: raw ?? JSON.stringify(body) })
      }), env, { waitUntil() {} });
      assert.equal(response.status, expected, `${method} ${target}: ${JSON.stringify(headers)}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(preferences(), before);
      assert.ok(!queries.some(sql => /user_shop_preferences/.test(sql)), 'route must not call preference-writing resolveTenant, even on errors');
      return response.json();
    };
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) await run({ method, expected: 404 });
    await run({ headers: { 'Cf-Access-Jwt-Assertion': '', 'Cf-Access-Authenticated-User-Email': 'owner@example.test' }, expected: 401 });
    await run({ headers: { 'Cf-Access-Jwt-Assertion': jwt({ subject: 'promotion-owner', email: 'owner@example.test', exp: 1 }) }, expected: 401 });
    for (const Origin of ['', 'https://evil.example']) await run({ headers: { Origin }, expected: 403 });
    await run({ headers: { 'Sec-Fetch-Site': 'cross-site' }, expected: 403 });
    await run({ headers: { 'Content-Type': 'text/plain' } });
    for (const selector of ['', 'a'.repeat(36), '-'.repeat(36), '123e4567-e89b-02d3-a456-426614174000', '123e4567-e89b-42d3-0456-426614174000']) await run({ headers: { 'X-Shop-Id': selector } });
    await run({ headers: { 'X-Shop-Id': uuid(999) }, expected: 403 });
    await run({ raw: '{' }); await run({ raw: '[]' }); await run({ raw: 'null' });
    await run({ raw: JSON.stringify({ operationId, padding: 'x'.repeat(3 * 1024 * 1024) }), expected: 413 });
    for (const field of ['email', 'role', 'actor', 'householdId', 'userId']) await run({ body: { operationId, [field]: actor.userId } });
    await run({ body: { operationId: 'a'.repeat(36) } });
    await run({ target: 'not-a-uuid', expected: 404 });
    await run({ target: foreign, expected: 404 }); await run({ target: missing, expected: 404 });
    await run({ subject: 'promotion-member', target: missing, expected: 403 });
    await run({ headers: { 'X-Shop-Id': shopB }, target: foreign, expected: 403 });
    // Matching email never substitutes for a verified identity binding.
    await run({ subject: 'different-subject-same-email', expected: 403 });
    sqlite.exec("CREATE TABLE migration_runs (singleton INTEGER PRIMARY KEY,state TEXT); INSERT INTO migration_runs VALUES (1,'active');");
    await run({ expected: 503 }); sqlite.exec('DROP TABLE migration_runs');
    assert.deepEqual(await run({ expected: 200 }), { member: { user_id: member, role: 'owner' }, changed: true });
    assert.equal((await run({ expected: 200 })).changed, false);
    assert.equal((await run({ body: { operationId: uuid(106) }, expected: 200 })).changed, false);
    assert.equal((await run({ target: actor.userId, body: { operationId: uuid(107) }, expected: 200 })).changed, false);
    await run({ target: actor.userId, expected: 409 });
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM access_audit WHERE event='member_promoted'").get().n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM shop_owner_promotion_receipts').get().n, 1);
    assert.equal(sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(shopB, actor.userId).role, 'member');
    sqlite.prepare("UPDATE memberships SET role='member' WHERE household_id=? AND user_id=?").run(actor.householdId, actor.userId);
    await run({ expected: 403 });
    sqlite.prepare("UPDATE memberships SET role='owner' WHERE household_id=? AND user_id=?").run(actor.householdId, actor.userId);
    sqlite.exec('DROP TABLE access_audit'); await run({ expected: 503 });
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('promotion route missing receipt schema fails closed with 503 and no-store', async () => {
  const { sqlite, db } = database(), originalFetch = globalThis.fetch;
  try {
    const actor = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'schema-owner', email: 'schema@example.test' }, { INITIAL_OWNER_EMAILS: 'schema@example.test' }, { displayName: 'Owner', shopName: 'A' });
    sqlite.exec('DROP TABLE shop_owner_promotion_receipts');
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const response = await handleRequest(new Request(`https://medicineinventory.craftloop.ca/api/household/members/${actor.userId}/promote`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt({ subject: 'schema-owner', email: 'schema@example.test' }), Origin: 'https://medicineinventory.craftloop.ca', 'Content-Type': 'application/json', 'X-Shop-Id': actor.householdId }, body: JSON.stringify({ operationId: uuid(108) }) }), { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' }, {});
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('real scheduled handler delivers once per Shop endpoint with three owners and deletes only the expired nonselected-owner subscription', async () => {
  const { sqlite, db } = database(), originalFetch = globalThis.fetch, calls = [], queries = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const shop of ['shop-a', 'shop-b', 'ownerless']) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, shop, 'before');
    for (const [id, shop, role] of [['a-owner-1','shop-a','owner'],['a-owner-2','shop-a','owner'],['a-owner-3','shop-a','owner'],['a-member','shop-a','member'],['b-owner','shop-b','owner'],['b-member','shop-b','member'],['orphan-member','ownerless','member']]) {
      sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
      sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 'before');
      sqlite.prepare('INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?)').run(`https://push.example.test/${id}`, 'test-key', 'test-auth', 'before', shop, id);
    }
    // Two pending notifications per Shop exercise the existing generic push:
    // one send per endpoint signals all pending rows for that Shop.
    for (const shop of ['shop-a', 'shop-b', 'ownerless']) for (const n of [1, 2]) {
      const id = `${shop}-${n}`;
      sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,expiry_date,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?,?)').run(id, id, 'Tablets', 2, 'tablets', today, 'before', 'before', shop);
      sqlite.prepare('INSERT INTO notifications (id,batch_id,kind,trigger_date,created_at,household_id) VALUES (?,?,?,?,?,?)').run(`notice-${id}`, id, 'expiry_30', today, 'before', shop);
    }
    const subscriptionsBefore = sqlite.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint').all();
    globalThis.fetch = async (endpoint, options) => {
      calls.push({ endpoint, options });
      return new Response(null, { status: endpoint.endsWith('/a-owner-2') ? 410 : 201 });
    };
    let pending;
    await worker.scheduled({}, { DB: { ...db, prepare(sql) { queries.push(sql); return db.prepare(sql); } }, PHOTOS: {}, VAPID_JSON: JSON.stringify(createVapidKeys()), PUSH_CONTACT: 'mailto:test@example.test' }, { waitUntil(promise) { assert.equal(pending, undefined); pending = promise; } });
    assert.ok(pending); await pending;
    assert.deepEqual(calls.map(call => call.endpoint).sort(), subscriptionsBefore.filter(sub => sub.household_id !== 'ownerless').map(sub => sub.endpoint).sort());
    assert.equal(new Set(calls.map(call => call.endpoint)).size, 6);
    assert.ok(calls.every(call => call.options.method === 'POST' && /^vapid t=/.test(call.options.headers.Authorization)));
    assert.equal(queries.filter(sql => sql === 'SELECT endpoint,user_id FROM push_subscriptions WHERE household_id=?').length, 2, 'default store delivery runs once per Shop');
    for (const row of sqlite.prepare('SELECT * FROM notifications').all()) assert.equal(Boolean(row.pushed_at), row.household_id !== 'ownerless');
    assert.deepEqual(sqlite.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint').all(), subscriptionsBefore.filter(sub => !sub.endpoint.endsWith('/a-owner-2')));
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM batches').get().n, 6);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('scheduler delivers each distinct Shop once with its stable minimum owner context', async () => {
  const calls = [];
  const env = { DB: { prepare(sql) { assert.match(sql, /MIN\(user_id\).*GROUP BY household_id/); return { all: async () => ({ results: [
    { household_id: 'shop-a', user_id: 'owner-a' }, { household_id: 'shop-b', user_id: 'owner-b' }
  ] }) }; } }, PHOTOS: {}, KV: {}, PUSH_CONTACT: 'mailto:test@example.test' };
  await deliverScheduledPushes(env, { loadKeys: async () => ({ publicKey: 'vapid' }), storeFactory: (_db, _photos, vapid, context) => ({
    async deliverPushes(options) { calls.push({ context, vapid, options }); return { sent: 3, gone: 1 }; }
  }) });
  assert.deepEqual(calls.map(call => call.context), [{ householdId: 'shop-a', userId: 'owner-a' }, { householdId: 'shop-b', userId: 'owner-b' }]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.contact === 'mailto:test@example.test'));
});

test('Shop onboarding status is read-only and explicit setup creates the verified owner', async () => {
  const { sqlite, db } = database();
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience', INITIAL_OWNER_EMAILS: 'kmaz285@gmail.com', KV: { get: async () => null, put: async () => {} }, PHOTOS: {} };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    const token = jwt({ subject: 'first-owner', email: 'kmaz285@gmail.com' });
    const status = await handleRequest(request('/api/shop/onboarding-status', token), env, { waitUntil() {} });
    assert.deepEqual(await status.json(), { membership: null, pendingInvitation: false, setupEligible: true });
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM tenant_bootstrap').get().n, 0);
    const setupRequest = new Request('https://medicineinventory.craftloop.ca/api/shop/onboarding', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token, 'content-type': 'application/json', 'cf-ray': 'test-correlation' }, body: JSON.stringify({ shopName: 'Mendicie', displayName: 'Kaushik' }) });
    const setup = await handleRequest(setupRequest, env, { waitUntil() {} });
    assert.equal(setup.status, 201);
    assert.equal((await setup.json()).role, 'owner');
    assert.equal(sqlite.prepare("SELECT request_id FROM access_audit WHERE event='bootstrap'").get().request_id, 'test-correlation');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('pending and accept API routes run before membership resolution but retain signed JWT enforcement', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' }, { displayName: 'Owner', shopName: 'Test Shop' });
  const invitation = await createHouseholdInvitation(db, owner, { email: 'invitee@example.test' });
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience', INITIAL_OWNER_EMAILS: 'owner@example.test', KV: { get: async () => null, put: async () => {} }, PHOTOS: {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    const unaffiliated = jwt({ subject: 'invitee', email: 'invitee@example.test' });
    const pending = await handleRequest(request('/api/household/invitations/pending', unaffiliated), env, { waitUntil() {} });
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).invitations[0].id, invitation.id);
    const accepted = await handleRequest(request(`/api/household/invitations/${invitation.id}/accept`, unaffiliated, 'POST'), env, { waitUntil() {} });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).role, 'member');
    const normal = await handleRequest(request('/api/settings', unaffiliated), env, { waitUntil() {} });
    assert.equal(normal.status, 200);
    // A member may receive an unrelated invitation from another household, but
    // the pre-tenant discovery route must tell the browser to open the normal
    // app rather than showing an acceptance gate.
    sqlite.exec("INSERT INTO households VALUES ('other','Other','now'); INSERT INTO users VALUES ('other-owner','now'); INSERT INTO identities VALUES ('cloudflare_access','other-owner','other-owner','other@example.test','now'); INSERT INTO memberships VALUES ('other','other-owner','owner','now');");
    await createHouseholdInvitation(db, { householdId: 'other', userId: 'other-owner' }, { email: 'invitee@example.test' });
    const memberPending = await handleRequest(request('/api/household/invitations/pending', unaffiliated), env, { waitUntil() {} });
    const memberPayload = await memberPending.json();
    assert.equal(memberPayload.member, true);
    assert.equal(memberPayload.invitations.length, 1);
    const forged = await handleRequest(request('/api/household/invitations/pending', `${unaffiliated}.forged`), env, { waitUntil() {} });
    assert.equal(forged.status, 401);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('Shop context lists only caller memberships, enforces the selected membership, and persists a valid preference', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'shared-user', email: 'shared@example.test' }, { INITIAL_OWNER_EMAILS: 'shared@example.test' }, { displayName: 'Shared', shopName: 'Zeta Shop' });
  sqlite.exec("INSERT INTO households VALUES ('alpha','Alpha Shop','now'); INSERT INTO memberships VALUES ('alpha','" + owner.userId + "','member','now'); INSERT INTO users VALUES ('outsider','now'); INSERT INTO identities VALUES ('cloudflare_access','outsider-subject','outsider','outsider@example.test','now'); INSERT INTO memberships VALUES ('alpha','outsider','owner','now');");
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience', KV: { get: async () => JSON.stringify({ publicKey: 'test' }), put: async () => {} }, PHOTOS: { put: async () => {}, delete: async () => {} } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    const token = jwt({ subject: 'shared-user', email: 'shared@example.test' });
    const defaultContext = await handleRequest(shopRequest('/api/shops', token), env, { waitUntil() {} });
    assert.equal(defaultContext.status, 200);
    assert.equal(defaultContext.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await defaultContext.json()).shops, [
      { id: 'alpha', name: 'Alpha Shop', role: 'member' },
      { id: owner.householdId, name: 'Zeta Shop', role: 'owner' }
    ]);
    const selectOwner = await handleRequest(shopRequest('/api/shops', token, { shopId: owner.householdId }), env, { waitUntil() {} });
    assert.equal((await selectOwner.json()).activeShopId, owner.householdId);
    assert.equal(sqlite.prepare('SELECT household_id FROM user_shop_preferences WHERE user_id=?').get(owner.userId).household_id, owner.householdId);
    const preferredContext = await handleRequest(shopRequest('/api/shops', token), env, { waitUntil() {} });
    assert.equal((await preferredContext.json()).activeShopId, owner.householdId);
    const rejected = await handleRequest(shopRequest('/api/batches', token, { shopId: 'not-a-membership' }), env, { waitUntil() {} });
    assert.equal(rejected.status, 403);
    const createInAlpha = await handleRequest(shopRequest('/api/batches', token, { method: 'POST', shopId: 'alpha', body: { name: 'Alpha-only', form: 'Tablets', quantity: 2, unit: 'tablets', low_stock_threshold: 1 } }), env, { waitUntil() {} });
    assert.equal(createInAlpha.status, 201);
    const ownerBatches = await handleRequest(shopRequest('/api/batches', token, { shopId: owner.householdId }), env, { waitUntil() {} });
    assert.deepEqual(await ownerBatches.json(), []);
    const alphaBatches = await handleRequest(shopRequest('/api/batches', token, { shopId: 'alpha' }), env, { waitUntil() {} });
    assert.equal((await alphaBatches.json())[0].name, 'Alpha-only');
    sqlite.prepare('UPDATE user_shop_preferences SET household_id=? WHERE user_id=?').run('alpha', owner.userId);
    sqlite.prepare('DELETE FROM memberships WHERE household_id=? AND user_id=?').run('alpha', owner.userId);
    const fallback = await handleRequest(shopRequest('/api/shops', token), env, { waitUntil() {} });
    assert.equal((await fallback.json()).activeShopId, owner.householdId);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('additional Shop creation is account-scoped, replay-safe, and never changes the active preference', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'creator', email: 'creator@example.test' }, { INITIAL_OWNER_EMAILS: 'creator@example.test' }, { displayName: 'Creator', shopName: 'Current Shop' });
  const preferenceBefore = sqlite.prepare('SELECT household_id FROM user_shop_preferences WHERE user_id=?').get(owner.userId);
  const principal = { provider: 'cloudflare_access', subject: 'creator', email: 'creator@example.test' };
  const payload = { operationId: '123e4567-e89b-42d3-a456-426614174000', shopName: '  New   Shop ', displayName: ' Ada  Owner ' };
  const created = await createAdditionalShop(db, principal, payload, { now: () => '2026-02-01T00:00:00.000Z', requestId: 'creation-test' });
  assert.equal(created.created, true);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM batches WHERE household_id=?').get(created.shop.id).count, 0);
  assert.deepEqual({ ...sqlite.prepare('SELECT display_name,household_name,default_storage_location,display_name_source FROM household_settings WHERE household_id=?').get(created.shop.id) }, { display_name: 'Ada Owner', household_name: 'New Shop', default_storage_location: 'Medicine cabinet', display_name_source: 'user' });
  assert.deepEqual(sqlite.prepare('SELECT household_id FROM user_shop_preferences WHERE user_id=?').get(owner.userId), preferenceBefore);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM access_audit WHERE event='shop_created'").get().count, 1);
  const replay = await createAdditionalShop(db, principal, payload, { now: () => '2026-02-01T00:01:00.000Z' });
  assert.deepEqual(replay, { shop: created.shop, created: false });
  await assert.rejects(() => createAdditionalShop(db, principal, { ...payload, shopName: 'Different' }), { status: 409 });
  sqlite.prepare('DELETE FROM memberships WHERE household_id=? AND user_id=?').run(created.shop.id, owner.userId);
  await assert.rejects(() => createAdditionalShop(db, principal, payload), { status: 403 });
  sqlite.close();
});

test('POST /api/shops runs before tenant resolution, validates browser provenance, and ignores X-Shop-Id', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'api-creator', email: 'api@example.test' }, { INITIAL_OWNER_EMAILS: 'api@example.test' }, { displayName: 'API', shopName: 'Current Shop' });
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience', KV: { get: async () => null, put: async () => {} }, PHOTOS: {} };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const post = (body, headers = {}) => new Request('https://medicineinventory.craftloop.ca/api/shops', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt({ subject: 'api-creator', email: 'api@example.test' }), Origin: 'https://medicineinventory.craftloop.ca', 'content-type': 'application/json', 'X-Shop-Id': 'foreign-or-malformed', ...headers }, body: JSON.stringify(body) });
  try {
    const missingOrigin = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174001', shopName: 'No', displayName: 'Origin' }, { Origin: '' }), env, { waitUntil() {} });
    assert.equal(missingOrigin.status, 403);
    const foreignOrigin = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174015', shopName: 'No', displayName: 'Origin' }, { Origin: 'https://evil.example' }), env, { waitUntil() {} });
    assert.equal(foreignOrigin.status, 403);
    const crossSite = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174016', shopName: 'No', displayName: 'Origin' }, { 'Sec-Fetch-Site': 'cross-site' }), env, { waitUntil() {} });
    assert.equal(crossSite.status, 403);
    const badType = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174017', shopName: 'No', displayName: 'Type' }, { 'content-type': 'text/plain' }), env, { waitUntil() {} });
    assert.equal(badType.status, 400);
    const unexpected = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174018', shopName: 'No', displayName: 'Fields', role: 'owner' }), env, { waitUntil() {} });
    assert.equal(unexpected.status, 400);
    sqlite.exec("CREATE TABLE migration_runs (singleton INTEGER PRIMARY KEY,state TEXT); INSERT INTO migration_runs VALUES (1,'active');");
    const locked = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174019', shopName: 'Locked', displayName: 'Creator' }), env, { waitUntil() {} });
    assert.equal(locked.status, 503);
    sqlite.exec('DROP TABLE migration_runs');
    const created = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174002', shopName: 'API Shop', displayName: 'API Person' }), env, { waitUntil() {} });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal(sqlite.prepare('SELECT household_id FROM user_shop_preferences WHERE user_id=?').get(owner.userId), undefined);
    const replay = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174002', shopName: 'API Shop', displayName: 'API Person' }, { 'X-Shop-Id': owner.householdId }), env, { waitUntil() {} });
    assert.equal(replay.status, 200);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM access_audit WHERE event='shop_created'").get().count, 1);
    const createdId = (await replay.json()).shop.id;
    sqlite.prepare('DELETE FROM memberships WHERE household_id=? AND user_id=?').run(createdId, owner.userId);
    const removedReplay = await handleRequest(post({ operationId: '123e4567-e89b-42d3-a456-426614174002', shopName: 'API Shop', displayName: 'API Person' }), env, { waitUntil() {} });
    assert.equal(removedReplay.status, 403);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('0012 preserves audit rows, relationships, index and rejects invalid events', () => {
  const sqlite = preCreationDatabase();
  sqlite.exec("INSERT INTO users VALUES ('user','now'); INSERT INTO households VALUES ('shop','Shop','now'); INSERT INTO memberships VALUES ('shop','user','owner','now'); INSERT INTO access_audit VALUES ('audit','bootstrap','shop','user','cloudflare_access:subject','now','request');");
  const before = sqlite.prepare('SELECT count(*) AS count FROM access_audit').get().count;
  sqlite.exec(readFileSync(new URL('../migrations/0012_shop_creation.sql', import.meta.url), 'utf8'));
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM access_audit').get().count, before);
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM access_audit WHERE id=?').get('audit') }, { id: 'audit', event: 'bootstrap', household_id: 'shop', actor_user_id: 'user', target_identifier: 'cloudflare_access:subject', created_at: 'now', request_id: 'request' });
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM pragma_foreign_key_check").get().count, 0);
  assert.ok(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='access_audit_household_created_at'").get().sql);
  assert.match(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='access_audit'").get().sql, /shop_created/);
  assert.throws(() => sqlite.prepare("INSERT INTO access_audit VALUES ('bad','not_an_event','shop','user','x','now','r')").run(), /CHECK/);
  sqlite.close();
});

test('creation checks membership, schemas, cross-user ids, limits and rollback without preference writes', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'limit-owner', email: 'limit@example.test' }, { INITIAL_OWNER_EMAILS: 'limit@example.test' }, { displayName: 'Owner', shopName: 'Base' });
  const principal = { provider: 'cloudflare_access', subject: 'limit-owner', email: 'limit@example.test' }, now = () => '2026-04-01T00:00:00.000Z';
  sqlite.prepare("INSERT INTO user_shop_preferences VALUES (?,?,?)").run(owner.userId, owner.householdId, 'before');
  const before = { ...sqlite.prepare('SELECT * FROM user_shop_preferences WHERE user_id=?').get(owner.userId) };
  await assert.rejects(() => createAdditionalShop(db, { provider: 'cloudflare_access', subject: 'nobody', email: 'nobody@example.test' }, { operationId: '123e4567-e89b-42d3-a456-426614174010', shopName: 'No', displayName: 'One' }), { status: 403 });
  const first = await createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-426614174011', shopName: 'One', displayName: 'Owner' }, { now });
  assert.equal(first.created, true);
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM user_shop_preferences WHERE user_id=?').get(owner.userId) }, before);
  await assert.rejects(() => createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-426614174012', shopName: 'Two', displayName: 'Owner' }, { now }), { status: 429 });
  sqlite.prepare("UPDATE shop_creation_receipts SET created_at='2026-03-01T00:00:00.000Z' WHERE user_id=?").run(owner.userId);
  for (let n=0;n<3;n++) { const id=`owned-${n}`; sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id,id,'now'); sqlite.prepare("INSERT INTO memberships VALUES (?,?,'owner',?)").run(id,owner.userId,'now'); }
  await assert.rejects(() => createAdditionalShop(db, principal, { operationId: '123e4567-e89b-42d3-a456-426614174013', shopName: 'Cap', displayName: 'Owner' }, { now }), { status: 409 });
  const otherId='other-user'; sqlite.prepare('INSERT INTO users VALUES (?,?)').run(otherId,'now'); sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access','other-subject',otherId,'other@example.test','now'); sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(owner.householdId,otherId,'member','now');
  const cross = await createAdditionalShop(db, { provider: 'cloudflare_access', subject: 'other-subject', email: 'other@example.test' }, { operationId: '123e4567-e89b-42d3-a456-426614174011', shopName: 'Other', displayName: 'Other' }, { now });
  assert.equal(cross.created, true);
  const countBeforeFailure = sqlite.prepare('SELECT count(*) AS count FROM households').get().count;
  sqlite.exec('DROP TABLE access_audit');
  // Past the rolling window: writes are eligible, so missing audit must roll
  // back the new household, owner membership, settings and receipt.
  const receiptsBeforeFailure = sqlite.prepare('SELECT count(*) AS count FROM shop_creation_receipts').get().count;
  await assert.rejects(() => createAdditionalShop(db, { provider: 'cloudflare_access', subject: 'other-subject', email: 'other@example.test' }, { operationId: '123e4567-e89b-42d3-a456-426614174014', shopName: 'Fail', displayName: 'Other' }, { now: () => '2026-04-03T00:00:00.000Z' }));
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM households').get().count, countBeforeFailure);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM shop_creation_receipts').get().count, receiptsBeforeFailure);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM household_settings WHERE household_id NOT IN (SELECT id FROM households)').get().count, 0);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM memberships WHERE household_id NOT IN (SELECT id FROM households)').get().count, 0);
  sqlite.close();
});

for (const scenario of ['same operation', 'owner cap', 'rolling 24h cap']) {
  test(`concurrent Shop creation: ${scenario} permits exactly one atomic creation`, async () => {
    const { sqlite, db } = database();
    try {
      const principal = { provider: 'cloudflare_access', subject: 'race-owner', email: 'race@example.test' };
      const owner = await setupInitialShop(db, principal, { INITIAL_OWNER_EMAILS: principal.email }, { displayName: 'Race', shopName: 'Original' });
      if (scenario === 'owner cap') for (let n = 0; n < 3; n++) {
        sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(`owned-${n}`, `Owned ${n}`, 'before');
        sqlite.prepare("INSERT INTO memberships VALUES (?,?,'owner',?)").run(`owned-${n}`, owner.userId, 'before');
      }
      sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(owner.userId, owner.householdId, 'unchanged');
      const before = JSON.stringify(sqlite.prepare('SELECT * FROM user_shop_preferences ORDER BY user_id').all());
      const baseline = sqlite.prepare('SELECT count(*) AS n FROM households').get().n;
      let arrivals = 0, release;
      const barrier = new Promise(resolve => { release = resolve; });
      const racingDb = { ...db, batch: async statements => {
        arrivals++;
        if (arrivals === 2) release();
        await barrier; // Both callers have missed the receipt before either writes.
        return db.batch(statements);
      } };
      const first = { operationId: '123e4567-e89b-42d3-a456-426614174080', shopName: 'Created', displayName: 'Owner' };
      const second = scenario === 'same operation' ? first : { ...first, operationId: '123e4567-e89b-42d3-a456-426614174081', shopName: 'Competing' };
      // Separate clocks at the owner limit make the rolling quota ineligible
      // to mask a broken owner guard; both still miss preflight concurrently.
      const outcomes = await Promise.allSettled([first, second].map((payload, index) => createAdditionalShop(racingDb, principal, payload, { now: () => scenario === 'owner cap' && index === 1 ? '2026-09-29T12:00:00.000Z' : '2026-09-27T12:00:00.000Z' })));
      assert.equal(arrivals, 2);
      const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled').map(outcome => outcome.value);
      if (scenario === 'same operation') {
        assert.deepEqual(fulfilled.map(result => result.created).sort(), [false, true]);
        assert.equal(fulfilled[0].shop.id, fulfilled[1].shop.id);
      } else {
        assert.equal(fulfilled.length, 1);
        assert.equal(fulfilled[0].created, true);
        const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.status, scenario === 'owner cap' ? 409 : 429);
      }
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM households').get().n, baseline + 1);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM shop_creation_receipts').get().n, 1);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM access_audit WHERE event='shop_created'").get().n, 1);
      const createdId = fulfilled[0].shop.id;
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM household_settings WHERE household_id=?').get(createdId).n, 1);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memberships WHERE household_id=? AND user_id=? AND role='owner'").get(createdId, owner.userId).n, 1);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memberships WHERE user_id=? AND role='owner'").get(owner.userId).n, scenario === 'owner cap' ? 5 : 2);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM pragma_foreign_key_check').get().n, 0);
      assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM user_shop_preferences ORDER BY user_id').all()), before);
    } finally { sqlite.close(); }
  });
}

test('POST creation leaves every preference byte unchanged on validation, quota, success and replay; absent receipts fail closed', async () => {
  const { sqlite, db } = database();
  const originalFetch = globalThis.fetch;
  try {
    const principal = { provider: 'cloudflare_access', subject: 'preferences', email: 'preferences@example.test' };
    const owner = await setupInitialShop(db, principal, { INITIAL_OWNER_EMAILS: principal.email }, { displayName: 'Owner', shopName: 'Original' });
    sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(owner.userId, owner.householdId, '2000-01-01T00:00:00.123Z');
    sqlite.exec("INSERT INTO users VALUES ('unrelated','before');");
    sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run('unrelated', owner.householdId, 'preserve this exactly');
    const preferences = () => Buffer.from(JSON.stringify(sqlite.prepare('SELECT * FROM user_shop_preferences ORDER BY user_id').all()));
    const before = preferences();
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' };
    const payload = { operationId: '123e4567-e89b-42d3-a456-426614174090', shopName: 'Second', displayName: 'Owner' };
    const post = async (body, selector = owner.householdId) => handleRequest(new Request('https://medicineinventory.craftloop.ca/api/shops', {
      method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt(principal), Origin: 'https://medicineinventory.craftloop.ca', 'content-type': 'application/json', 'X-Shop-Id': selector }, body: JSON.stringify(body)
    }), env, { waitUntil() {} });
    for (const [body, expected, selector] of [
      [{ ...payload, shopName: '' }, 400, owner.householdId],
      [payload, 201, 'foreign-shop'],
      [payload, 200, owner.householdId],
      [{ ...payload, operationId: '123e4567-e89b-42d3-a456-426614174091' }, 429, 'malformed selector']
    ]) {
      assert.equal((await post(body, selector)).status, expected);
      assert.deepEqual(preferences(), before);
    }
    const snapshot = () => JSON.stringify(['households', 'memberships', 'household_settings', 'access_audit'].map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const stateBefore = snapshot();
    sqlite.exec('DROP TABLE shop_creation_receipts');
    assert.equal((await post({ ...payload, operationId: '123e4567-e89b-42d3-a456-426614174092' })).status, 500);
    assert.equal(snapshot(), stateBefore);
    assert.deepEqual(preferences(), before);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('GET /api/changes is Shop-scoped, strict, throttled, and reflects real mutations from the Worker', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'feed-owner', email: 'feed@example.test' }, { INITIAL_OWNER_EMAILS: 'feed@example.test' }, { displayName: 'Feed', shopName: 'Feed Shop' });
  sqlite.exec("INSERT INTO households VALUES ('other','Other Shop','now'); INSERT INTO users VALUES ('other-user','now'); INSERT INTO memberships VALUES ('other','other-user','owner','now');");
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience', KV: { get: async () => JSON.stringify({ publicKey: 'test' }), put: async () => {} }, PHOTOS: { put: async () => {}, delete: async () => {} } };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const call = (path, options = {}) => handleRequest(shopRequest(path, jwt({ subject: 'feed-owner', email: 'feed@example.test' }), { shopId: owner.householdId, ...options }), env, { waitUntil() {} });
  try {
    const start = await call('/api/changes');
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await start.json(), { changes: [], nextAfter: 0, more: false, reset: false });

    const created = await call('/api/batches', { method: 'POST', body: { name: 'Feed medicine', form: 'Tablets', quantity: 2, unit: 'tablets', low_stock_threshold: 1, operationId: uuid(101), baseRevision: 0 } });
    assert.equal(created.status, 201);
    const batch = await created.json();
    const page = await (await call('/api/changes?after=0')).json();
    assert.deepEqual(Object.keys(page).sort(), ['changes', 'more', 'nextAfter', 'reset']);
    assert.equal(page.changes.length, 1);
    assert.deepEqual(Object.keys(page.changes[0]).sort(), ['batch', 'id', 'kind', 'revision', 'seq']);
    assert.equal(page.changes[0].id, batch.id);
    assert.equal(page.changes[0].kind, 'upsert');
    assert.equal(page.changes[0].batch.name, 'Feed medicine');
    assert.equal('change_seq' in page.changes[0].batch, false);
    assert.equal(page.nextAfter, page.changes[0].seq);

    const consumed = await call(`/api/batches/${batch.id}/consume`, { method: 'POST', body: { amount: 2, operationId: uuid(102), baseRevision: 1 } });
    assert.equal(consumed.status, 200);
    const after = await (await call(`/api/changes?after=${page.nextAfter}`)).json();
    assert.equal(after.changes.length, 1);
    assert.equal(after.changes[0].kind, 'remove');
    assert.equal(after.changes[0].batch, null);

    // A member of another Shop sees nothing of this Shop, and a non-member header is refused.
    sqlite.prepare("INSERT INTO identities VALUES ('cloudflare_access','other-subject','other-user','other@example.test','now')").run();
    const otherView = await handleRequest(shopRequest('/api/changes?after=0', jwt({ subject: 'other-subject', email: 'other@example.test' }), { shopId: 'other' }), env, { waitUntil() {} });
    assert.deepEqual((await otherView.json()).changes, []);
    const foreign = await handleRequest(shopRequest('/api/changes?after=0', jwt({ subject: 'other-subject', email: 'other@example.test' }), { shopId: owner.householdId }), env, { waitUntil() {} });
    assert.equal(foreign.status, 403);

    for (const bad of ['after=-1', 'after=abc', 'after=1.5', 'after=', `after=${'9'.repeat(16)}`, 'after=0&limit=0', 'after=0&limit=201', 'after=0&limit=x']) assert.equal((await call(`/api/changes?${bad}`)).status, 400, bad);

    // Rolling-minute limiter: requests 60 and 61 within a minute.
    sqlite.exec('DELETE FROM household_invitation_route_throttle_events');
    let limited;
    for (let i = 0; i < 70 && !limited; i += 1) { const response = await call('/api/changes?after=0'); if (response.status === 429) limited = response; }
    assert.ok(limited, 'limiter must trip');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM household_invitation_route_throttle_events WHERE route='changes'").get().n, 60);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('GET /api/changes fails closed with 503 when the feed schema is missing', async () => {
  const { sqlite, db } = database();
  const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'no-feed', email: 'nofeed@example.test' }, { INITIAL_OWNER_EMAILS: 'nofeed@example.test' }, { displayName: 'No', shopName: 'No Feed' });
  sqlite.exec('DROP TABLE batch_changes');
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience', KV: { get: async () => null, put: async () => {} }, PHOTOS: {} };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    const response = await handleRequest(shopRequest('/api/changes', jwt({ subject: 'no-feed', email: 'nofeed@example.test' }), { shopId: owner.householdId }), env, { waitUntil() {} });
    assert.equal(response.status, 503);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('removal route authenticates, validates, isolates, and immediately revokes the removed member', async () => {
  const { sqlite, db } = database(), originalFetch = globalThis.fetch;
  try {
    const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'removal-owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' }, { displayName: 'Owner', shopName: 'Shop A' });
    const member = uuid(201), other = uuid(202);
    for (const [id, subject, shop, role] of [[member, 'removal-member', owner.householdId, 'member'], [other, 'removal-other', uuid(203), 'owner']]) {
      if (shop === uuid(203)) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, 'Shop B', 'before');
      sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
      sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', subject, id, `${subject}@example.test`, 'before');
      sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 'before');
    }
    const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' };
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const call = async ({ path = `/api/household/members/${member}/remove`, method = 'POST', subject = 'removal-owner', email = 'owner@example.test', headers = {}, body = { operationId: uuid(210) } } = {}) => {
      const response = await handleRequest(new Request(`https://medicineinventory.craftloop.ca${path}`, {
        method, headers: { 'Cf-Access-Jwt-Assertion': jwt({ subject, email }), Origin: 'https://medicineinventory.craftloop.ca', 'Content-Type': 'application/json', 'X-Shop-Id': owner.householdId, ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
      }), env, { waitUntil() {} });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response;
    };
    assert.equal((await call({ method: 'GET' })).status, 404);
    assert.equal((await call({ headers: { 'Cf-Access-Jwt-Assertion': '' } })).status, 401);
    assert.equal((await call({ headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call({ headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call({ body: { operationId: uuid(210), role: 'member' } })).status, 400);
    assert.equal((await call({ headers: { 'X-Shop-Id': '' } })).status, 400);
    assert.equal((await call({ subject: 'removal-member', email: 'removal-member@example.test' })).status, 403);
    assert.equal((await call({ subject: 'removal-other', email: 'removal-other@example.test' })).status, 403);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM memberships WHERE household_id=?').get(owner.householdId).n, 2);

    const before = await call({ path: '/api/changes', method: 'GET', subject: 'removal-member', email: 'removal-member@example.test' });
    assert.equal(before.status, 200);
    const removed = await call();
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    const after = await call({ path: '/api/changes', method: 'GET', subject: 'removal-member', email: 'removal-member@example.test' });
    assert.equal(after.status, 403);
    assert.equal((await call({ path: '/api/changes?after=0', method: 'GET', subject: 'removal-member', email: 'removal-member@example.test' })).status, 403);
    assert.equal((await call()).status, 200, 'replay is a no-op');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('demote and leave routes authenticate, validate, guard the last owner, and revoke access on leave', async () => {
  const { sqlite, db } = database(), originalFetch = globalThis.fetch;
  try {
    const owner = await setupInitialShop(db, { provider: 'cloudflare_access', subject: 'dl-owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' }, { displayName: 'Owner', shopName: 'Shop A' });
    const second = uuid(301), plain = uuid(302);
    for (const [id, subject, role] of [[second, 'dl-second', 'owner'], [plain, 'dl-plain', 'member']]) {
      sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 'before');
      sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', subject, id, `${subject}@example.test`, 'before');
      sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(owner.householdId, id, role, 'before');
    }
    const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' };
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const call = async (path, { method = 'POST', subject = 'dl-owner', headers = {}, body = { operationId: uuid(310) } } = {}) => {
      const response = await handleRequest(new Request(`https://medicineinventory.craftloop.ca${path}`, {
        method, headers: { 'Cf-Access-Jwt-Assertion': jwt({ subject, email: `${subject}@example.test` }), Origin: 'https://medicineinventory.craftloop.ca', 'Content-Type': 'application/json', 'X-Shop-Id': owner.householdId, ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
      }), env, { waitUntil() {} });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response;
    };
    const demote = `/api/household/members/${second}/demote`;
    assert.equal((await call(demote, { method: 'GET' })).status, 404);
    assert.equal((await call('/api/household/leave', { method: 'GET' })).status, 404);
    assert.equal((await call(demote, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/api/household/leave', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call(demote, { body: { operationId: uuid(310), role: 'member' } })).status, 400);
    assert.equal((await call('/api/household/leave', { body: {} })).status, 400);
    assert.equal((await call(demote, { headers: { 'X-Shop-Id': '' } })).status, 400);
    assert.equal((await call(demote, { subject: 'dl-plain' })).status, 403);

    const demoted = await call(demote);
    assert.equal(demoted.status, 200);
    assert.deepEqual(await demoted.json(), { member: { user_id: second, role: 'member' }, changed: true });
    const lastOwner = await call('/api/household/leave');
    assert.equal(lastOwner.status, 409);
    assert.match((await lastOwner.json()).error, /at least one owner/);

    const left = await call('/api/household/leave', { subject: 'dl-plain', body: { operationId: uuid(311) } });
    assert.equal(left.status, 200);
    assert.deepEqual(await left.json(), { left: true });
    assert.equal((await call('/api/changes', { method: 'GET', subject: 'dl-plain' })).status, 403);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});
