import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { acceptHouseholdInvitation, revokeHouseholdInvitation, throttleInvitationRoute } from '../lib/household-access.js';
import { createAdditionalShop } from '../lib/tenants.js';
import { handleRequest } from '../worker/index.js';
import { app, createStore } from '../server.js';
import { MAX_JSON_BYTES } from '../lib/shared.js';

const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const user = uuid(1), owner = uuid(2), home = uuid(3), destination = uuid(4), invitation = uuid(5);
const principal = { provider: 'cloudflare_access', subject: 'invitee', email: 'invitee@example.test' };
const stamp = '2026-09-28T12:00:00.000Z';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'joins', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(p = principal) {
  const data = `${encode({ alg: 'RS256', kid: 'joins' })}.${encode({ iss: 'https://team.cloudflareaccess.com', aud: 'medicine', exp: Math.floor(Date.now() / 1000) + 600, sub: p.subject, email: p.email })}`;
  return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
}
function fixture({ fresh = false, count = 1 } = {}) {
  const sqlite = new DatabaseSync(':memory:'), queries = [];
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, folder), 'utf8'));
  sqlite.prepare('INSERT INTO users VALUES (?,?)').run(owner, 'before');
  sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(destination, 'Destination', 'before');
  sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(destination, owner, 'owner', 'before');
  if (!fresh) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(user, 'before');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run(principal.provider, principal.subject, user, principal.email, 'before');
    for (let n = 0; n < count; n++) {
      const id = n ? uuid(100 + n) : home;
      sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, `Home ${n}`, 'before');
      sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, user, 'member', 'before');
    }
    if (count) sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(user, home, 'unchanged');
  }
  sqlite.prepare('INSERT INTO user_shop_preferences VALUES (?,?,?)').run(owner, destination, 'unchanged owner');
  const invite = (id = invitation, shop = destination, email = principal.email, expiry = '2099-01-01T00:00:00.000Z') => sqlite.prepare('INSERT INTO household_invitations VALUES (?,?,?,?,?,?,?)').run(id, shop, email, 'member', owner, 'before', expiry);
  invite();
  const statement = (sql, values = []) => ({ sql, bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare(sql) { queries.push(sql); return statement(sql); }, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const result = statements.map(row => row.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const rows = table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const preferences = () => Buffer.from(JSON.stringify(rows('user_shop_preferences')));
  const snapshot = () => JSON.stringify(['users', 'identities', 'memberships', 'household_invitations', 'household_invitation_acceptance_receipts', 'access_audit', 'user_shop_preferences'].map(rows));
  const accept = (database = db, id = invitation, p = principal) => acceptHouseholdInvitation(database, p, id, () => stamp, 'test-request');
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine' };
  const request = (path = `/api/household/invitations/${invitation}/accept`, { method = 'POST', headers = {}, raw = '{}', p = principal } = {}) => new Request(`https://medicine.test${path}`, {
    method, headers: { 'Cf-Access-Jwt-Assertion': token(p), Origin: 'https://medicine.test', 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: raw })
  });
  const run = (path, options, database = db) => handleRequest(request(path, options), { ...env, DB: database }, { waitUntil() {} });
  return { sqlite, db, rows, preferences, snapshot, accept, invite, queries, run };
}
// Hold both complete preflights until both arrive at the actual transaction
// boundary, then execute whole SQLite transactions in a chosen order.
function barrier(db, reverse = false) {
  const pending = [];
  return { ...db, arrivals: () => pending.length, batch: statements => new Promise((resolve, reject) => {
    pending.push({ statements, resolve, reject });
    if (pending.length === 2) for (const entry of reverse ? [...pending].reverse() : pending) db.batch(entry.statements).then(entry.resolve, entry.reject);
  }) };
}
function counts(f, joined = 1, revoked = 0) {
  assert.equal(f.rows('household_invitation_acceptance_receipts').length, joined);
  assert.equal(f.rows('memberships').filter(row => row.household_id === destination && row.user_id !== owner).length, joined);
  assert.equal(f.rows('access_audit').filter(row => row.event === 'invite_accepted').length, joined);
  assert.equal(f.rows('access_audit').filter(row => row.event === 'invite_revoked').length, revoked);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
}

for (const fresh of [false, true]) test(`actual Worker synchronized duplicate acceptance returns two 200s, fresh=${fresh}`, async () => {
  const f = fixture({ fresh }), original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  try {
    const racing = barrier(f.db), before = f.preferences();
    const database = { ...f.db, batch: statements => statements.some(row => /INSERT INTO memberships/.test(row.sql)) ? racing.batch(statements) : f.db.batch(statements) };
    const responses = await Promise.all([f.run(undefined, undefined, database), f.run(undefined, undefined, database)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.ok(responses.every(response => response.headers.get('cache-control') === 'no-store'));
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(bodies.map(body => body.accepted).sort(), [false, true]);
    assert.equal(racing.arrivals(), 2); counts(f); assert.deepEqual(f.preferences(), before);
  } finally { globalThis.fetch = original; f.sqlite.close(); }
});

for (const fresh of [false, true]) test(`synchronized duplicate acceptance (${fresh ? 'new identity' : 'existing user'}) commits once and replays`, async () => {
  const f = fixture({ fresh });
  try {
    const racing = barrier(f.db), before = f.preferences();
    const outcomes = await Promise.all([f.accept(racing), f.accept(racing)]);
    assert.equal(racing.arrivals(), 2);
    assert.deepEqual(outcomes.map(row => row.accepted).sort(), [false, true]);
    assert.ok(outcomes.every(row => row.householdId === destination && row.role === 'member'));
    counts(f); assert.equal(f.rows('identities').length, 1); assert.equal(f.rows('users').length, 2);
    assert.deepEqual(f.preferences(), before);
  } finally { f.sqlite.close(); }
});

for (const reverse of [false, true]) test(`synchronized revoke/accept has one serialized winner (reverse=${reverse})`, async () => {
  const f = fixture();
  try {
    const racing = barrier(f.db, reverse), before = f.preferences();
    const result = await Promise.allSettled([f.accept(racing), revokeHouseholdInvitation(racing, { householdId: destination, userId: owner }, invitation)]);
    assert.equal(racing.arrivals(), 2);
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(result.find(row => row.status === 'rejected').reason.status, 404);
    const joined = Number(result[0].status === 'fulfilled');
    counts(f, joined, 1 - joined);
    assert.equal(f.rows('household_invitations').length, 0); assert.deepEqual(f.preferences(), before);
  } finally { f.sqlite.close(); }
});

for (const reverse of [false, true]) test(`synchronized join/create contention cannot exceed 50 (reverse=${reverse})`, async () => {
  const f = fixture({ count: 49 });
  try {
    const racing = barrier(f.db, reverse), before = f.preferences();
    const result = await Promise.allSettled([f.accept(racing), createAdditionalShop(racing, principal, { operationId: uuid(20), shopName: 'Created', displayName: 'Person' }, { now: () => stamp })]);
    assert.equal(racing.arrivals(), 2); assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(result.find(row => row.status === 'rejected').reason.status, 409);
    assert.equal(f.rows('memberships').filter(row => row.user_id === user).length, 50);
    assert.equal(f.rows('shop_creation_receipts').length + f.rows('household_invitation_acceptance_receipts').length, 1);
    assert.equal(f.rows('access_audit').length, 1); assert.deepEqual(f.preferences(), before);
  } finally { f.sqlite.close(); }
});

for (const fresh of [false, true]) for (const failure of ['membership', 'receipt', 'delete', 'audit', 'ignored membership', 'ignored receipt', 'ignored delete', 'ignored audit']) test(`acceptance rollback: ${failure}, fresh=${fresh}`, async () => {
  const f = fixture({ fresh });
  try {
    const kind = failure.replace('ignored ', '');
    const action = kind === 'delete' ? 'DELETE ON household_invitations' : `INSERT ON ${{ membership: 'memberships', receipt: 'household_invitation_acceptance_receipts', audit: 'access_audit' }[kind]}`;
    f.sqlite.exec(`CREATE TRIGGER fail_accept BEFORE ${action} BEGIN SELECT RAISE(${failure.startsWith('ignored') ? 'IGNORE' : "ABORT,'forced storage failure'"}); END;`);
    const before = f.snapshot();
    await assert.rejects(() => f.accept(), failure.startsWith('ignored') ? /NOT NULL constraint failed/ : /forced storage failure/);
    assert.equal(f.snapshot(), before);
  } finally { f.sqlite.close(); }
});

test('49→50, replay at cap, 50→51 rejection, over-cap refusal, and removed-member replay never change preferences', async () => {
  const f = fixture({ count: 49 });
  try {
    const before = f.preferences();
    assert.equal((await f.accept()).accepted, true); assert.equal((await f.accept()).accepted, false);
    const extra = uuid(700); f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(extra, 'Extra', 'before'); f.invite(uuid(701), extra);
    await assert.rejects(() => f.accept(f.db, uuid(701)), { status: 409 });
    f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(extra, user, 'member', 'before');
    await assert.rejects(() => createAdditionalShop(f.db, principal, { operationId: uuid(702), shopName: 'Over cap', displayName: 'Person' }), { status: 409 });
    assert.equal(f.sqlite.prepare('SELECT user_id,count(*) AS count FROM memberships GROUP BY user_id HAVING count(*)>50').get().count, 51);
    f.sqlite.prepare('DELETE FROM memberships WHERE household_id=? AND user_id=?').run(destination, user);
    await assert.rejects(() => f.accept(), { status: 404 });
    assert.equal(f.rows('access_audit').length, 1); assert.deepEqual(f.preferences(), before);
  } finally { f.sqlite.close(); }
});

test('unexpected database errors propagate even when their text mentions receipt or uniqueness', async () => {
  const f = fixture();
  try {
    for (const message of ['household_invitation_acceptance_receipts disk failure', 'UNIQUE constraint failed: access_audit.id']) {
      const broken = { ...f.db, batch: async () => { throw new Error(message); } };
      await assert.rejects(() => f.accept(broken), error => error.message === message && !error.status);
    }
  } finally { f.sqlite.close(); }
});

test('Worker pending serialization, keyset boundaries and tampered continuation hints remain email-scoped and bounded', async () => {
  const f = fixture(), original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  try {
    for (let n = 0; n < 22; n++) {
      const shop = uuid(800 + n); f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, `Page ${n}`, 'before'); f.invite(uuid(900 + n), shop);
    }
    f.invite(uuid(999), home, 'foreign@example.test');
    const before = f.preferences(), path = '/api/household/invitations/pending';
    const page = async (cursor, p) => {
      const response = await f.run(path + (cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`), { method: 'GET', p, headers: { 'X-Shop-Id': 'malformed' } });
      assert.equal(response.headers.get('cache-control'), 'no-store'); return { response, body: await response.json() };
    };
    const first = await page(); assert.equal(first.response.status, 200); assert.equal(first.body.invitations.length, 20);
    assert.deepEqual(Object.keys(first.body).sort(), ['invitations', 'member', 'nextCursor']);
    for (const item of first.body.invitations) assert.deepEqual(Object.keys(item).sort(), ['expires_at', 'household_name', 'id', 'role']);
    const second = await page(first.body.nextCursor); assert.equal(second.body.invitations.length, 3); assert.equal(second.body.nextCursor, null);
    assert.equal(new Set([...first.body.invitations, ...second.body.invitations].map(row => row.id)).size, 23);
    const value = JSON.parse(Buffer.from(first.body.nextCursor, 'base64url'));
    for (const bad of ['', '%%%', 'a'.repeat(513), encode({ ...value, i: '-'.repeat(36) }), encode({ ...value, x: 'Jan 1 2099' }), encode({ ...value, extra: true })]) assert.equal((await page(bad)).response.status, 400);
    const foreign = { ...principal, subject: 'foreign', email: 'foreign@example.test' };
    assert.equal((await page(first.body.nextCursor, foreign)).response.status, 400);
    // An attacker can recompute this public hash and move the position. Neither
    // changes the verified-email WHERE predicate, expiry filter or LIMIT 21.
    const forged = encode({ ...value, e: createHash('sha256').update(foreign.email).digest('base64url'), x: '2000-01-01T00:00:00.000Z', i: uuid(0) });
    const tampered = await page(forged, foreign); assert.equal(tampered.response.status, 200);
    assert.deepEqual(tampered.body.invitations.map(row => row.id), [uuid(999)]);
    const rewind = await page(encode({ ...value, x: '2000-01-01T00:00:00.000Z', i: uuid(0) }));
    assert.equal(rewind.body.invitations.length, 20); assert.ok(!rewind.body.invitations.some(row => row.id === uuid(999)));
    assert.ok(f.queries.filter(sql => /SELECT i.id,/.test(sql)).every(sql => /LIMIT 21/.test(sql)));
    assert.ok(!f.queries.some(sql => /user_shop_preferences/.test(sql))); assert.deepEqual(f.preferences(), before);
  } finally { globalThis.fetch = original; f.sqlite.close(); }
});

test('Worker acceptance validates provenance, UUID, exact empty object, schema and ignored selectors with no-store', async () => {
  const f = fixture(), original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  try {
    const before = f.preferences();
    const check = async (options, status, path, db) => {
      const response = await f.run(path, options, db); assert.equal(response.status, status, JSON.stringify(options));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(f.preferences(), before); return response;
    };
    await check({ headers: { 'Cf-Access-Jwt-Assertion': '', 'Cf-Access-Authenticated-User-Email': principal.email } }, 401);
    for (const method of ['GET', 'PUT', 'DELETE']) await check({ method, headers: { 'X-Shop-Id': home } }, 404);
    for (const headers of [{ Origin: '' }, { Origin: 'https://foreign.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) await check({ headers }, 403);
    for (const headers of [{ 'Content-Type': '' }, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/jsonp' }]) await check({ headers }, 400);
    for (const raw of ['', 'null', '[]', '1', '{', '{"role":"owner"}', '{"email":"foreign@example.test"}', '{"userId":"forged"}']) await check({ raw }, 400);
    await check({ raw: ' '.repeat(MAX_JSON_BYTES + 1) }, 413);
    await check({}, 404, `/api/household/invitations/${'-'.repeat(36)}/accept`);
    await check({ p: { ...principal, email: 'wrong@example.test' } }, 404);
    f.sqlite.exec("CREATE TABLE migration_runs (singleton INTEGER PRIMARY KEY,state TEXT); INSERT INTO migration_runs VALUES (1,'active');");
    await check({}, 503); f.sqlite.exec('DROP TABLE migration_runs');
    for (const table of ['household_invitation_acceptance_receipts', 'access_audit']) {
      f.sqlite.exec(`ALTER TABLE ${table} RENAME TO missing_${table}`);
      await check({}, 503); f.sqlite.exec(`ALTER TABLE missing_${table} RENAME TO ${table}`);
    }
    for (const selector of [home, uuid(99999), 'not-a-uuid']) {
      const response = await check({ headers: { 'X-Shop-Id': selector } }, 200);
      assert.equal((await response.json()).householdId, destination);
    }
    assert.ok(!f.queries.some(sql => /user_shop_preferences/.test(sql))); counts(f);
  } finally { globalThis.fetch = original; f.sqlite.close(); }
});

for (const route of ['pending', 'accept']) for (const kind of ['principal', 'IP']) test(`Worker ${route} ${kind} limiter returns 429/Retry-After before discovery/mutation`, async () => {
  const f = fixture({ fresh: true }), original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  try {
    const limit = route === 'pending' ? 30 : 10, before = f.snapshot();
    const path = route === 'pending' ? '/api/household/invitations/pending' : `/api/household/invitations/${uuid(99999)}/accept`;
    const options = n => ({ method: route === 'pending' ? 'GET' : 'POST', p: kind === 'IP' ? { ...principal, subject: `caller-${n}` } : principal, headers: { 'CF-Connecting-IP': kind === 'IP' ? '192.0.2.1' : `192.0.2.${n + 1}` } });
    for (let n = 0; n < limit; n++) assert.equal((await f.run(path, options(n))).status, route === 'pending' ? 200 : 404);
    f.queries.length = 0;
    const limited = await f.run(path, options(limit)); assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1 && Number(limited.headers.get('retry-after')) <= 60);
    assert.equal(limited.headers.get('cache-control'), 'no-store'); assert.equal(f.snapshot(), before);
    assert.ok(!f.queries.some(sql => /FROM household_invitations|FROM identities|acceptance_receipts/.test(sql)));
    assert.ok(f.rows('household_invitation_route_throttle_events').every(row => !JSON.stringify(row).includes(principal.subject) && !JSON.stringify(row).includes('192.0.2.')));
  } finally { globalThis.fetch = original; f.sqlite.close(); }
});

test('limiter missing or failed is 503, and expired events are removed with deterministic Retry-After', async () => {
  const f = fixture(), original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  try {
    const req = new Request('https://medicine.test');
    for (let n = 0; n < 10; n++) await throttleInvitationRoute(f.db, principal, req, 'accept', () => new Date(stamp));
    await assert.rejects(() => throttleInvitationRoute(f.db, principal, req, 'accept', () => new Date(stamp)), { status: 429, retryAfter: 60 });
    await throttleInvitationRoute(f.db, principal, req, 'accept', () => new Date(Date.parse(stamp) + 60_001));
    assert.equal(f.rows('household_invitation_route_throttle_events').length, 1);
    const before = f.snapshot();
    for (const route of ['pending', 'accept']) {
      const path = route === 'pending' ? '/api/household/invitations/pending' : undefined;
      const options = { method: route === 'pending' ? 'GET' : 'POST' };
      for (const database of [{ ...f.db, batch: async () => { throw new Error('storage unavailable'); } }, { ...f.db, batch: undefined }]) {
        const response = await f.run(path, options, database); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    }
    f.sqlite.exec('DROP TABLE household_invitation_route_throttle_events');
    for (const method of ['GET', 'POST']) assert.equal((await f.run(method === 'GET' ? '/api/household/invitations/pending' : undefined, { method })).status, 503);
    assert.equal(f.snapshot(), before);
  } finally { globalThis.fetch = original; f.sqlite.close(); }
});

test('local singleton API keeps invitations unsupported and settings unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'join-local-')), store = createStore(join(dir, 'db.sqlite')), server = app(store, { env: {} });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = await fetch(`${base}/api/settings`).then(r => r.text());
    assert.equal((await fetch(`${base}/api/household/invitations/pending`)).status, 404);
    assert.equal((await fetch(`${base}/api/household/invitations/${invitation}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal(await fetch(`${base}/api/settings`).then(r => r.text()), before);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true }); }
});
