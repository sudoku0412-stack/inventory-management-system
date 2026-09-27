import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../worker/index.js';
import { createHouseholdInvitation } from '../lib/household-access.js';
import { createAdditionalShop, setupInitialShop } from '../lib/tenants.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'invite-key', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
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
  for (const migration of ['0001_initial.sql', '0003_profile_settings.sql', '0004_household_tenants.sql', '0005_household_invitations.sql', '0006_household_invitation_expiration.sql', '0007_sync_mutation_foundation.sql', '0008_household_display_name_source.sql', '0009_seed_legacy_household_display_names.sql', '0010_access_audit.sql', '0011_user_shop_preferences.sql', '0012_shop_creation.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  return { sqlite, db: d1(sqlite) };
}
function preCreationDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0003_profile_settings.sql', '0004_household_tenants.sql', '0005_household_invitations.sql', '0006_household_invitation_expiration.sql', '0007_sync_mutation_foundation.sql', '0008_household_display_name_source.sql', '0009_seed_legacy_household_display_names.sql', '0010_access_audit.sql', '0011_user_shop_preferences.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  return sqlite;
}
function request(path, token, method = 'GET') { return new Request(`https://medicineinventory.craftloop.ca${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': token, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined }); }
function shopRequest(path, token, { method = 'GET', shopId, body } = {}) {
  return new Request(`https://medicineinventory.craftloop.ca${path}`, {
    method,
    headers: { 'Cf-Access-Jwt-Assertion': token, ...(shopId ? { 'X-Shop-Id': shopId } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

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
