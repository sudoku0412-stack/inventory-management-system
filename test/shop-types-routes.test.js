import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handleRequest } from '../worker/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'types-key', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(subject, email) {
  const data = `${b64({ alg: 'RS256', kid: 'types-key', typ: 'JWT' })}.${b64({ iss: 'https://team.cloudflareaccess.com', aud: 'medicine-audience', exp: Math.floor(Date.now() / 1000) + 60, sub: subject, email })}`;
  return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
}
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const statement = (sql, values = []) => ({ sql, values, bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const db = { prepare: sql => statement(sql), batch: async statements => { sqlite.exec('BEGIN'); try { const out = statements.map(s => ({ meta: { changes: sqlite.prepare(s.sql).run(...s.values).changes } })); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  for (const [id, subject, email, shop, role] of [['u1', 'owner-sub', 'owner@example.test', 'h1', 'owner'], ['u2', 'other-sub', 'other@example.test', 'h2', 'owner'], ['u3', 'member-sub', 'member@example.test', 'h1', 'member']]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 't');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', subject, id, email, 't');
    sqlite.prepare('INSERT OR IGNORE INTO households VALUES (?,?,?)').run(shop, shop, 't');
    sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, id, role, 't');
  }
  return { sqlite, db };
}

const ORIGIN = 'https://medicineinventory.craftloop.ca';
async function call(env, { path = '/api/shop-types', method = 'GET', subject = 'owner-sub', email = 'owner@example.test', body, headers = {}, token } = {}) {
  const response = await handleRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(token === null ? {} : { 'Cf-Access-Jwt-Assertion': token || jwt(subject, email) }), ...(body ? { 'content-type': 'application/json', origin: ORIGIN } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  }), env, { waitUntil() {} });
  return { status: response.status, json: await response.json().catch(() => null) };
}

test('the Shop type routes: create, list, update, edit lists and delete as an Owner', async () => {
  const { db } = database(), originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' };
    assert.deepEqual((await call(env)).json.custom, []);
    const created = await call(env, { method: 'POST', body: { name: 'Pantry', startFrom: 'goods' } });
    assert.equal(created.status, 201);
    const type = created.json.custom[0];
    assert.equal(type.name, 'Pantry');
    const listed = await call(env);
    assert.equal(listed.json.custom.length, 1);
    const updated = await call(env, { path: '/api/shop-types/update', method: 'POST', body: { id: type.id, name: 'Larder' } });
    assert.equal(updated.json.custom[0].name, 'Larder');
    const added = await call(env, { path: '/api/shop-types/options', method: 'POST', body: { id: type.id, list: 'unit', value: 'tin', action: 'add' } });
    assert.ok(added.json.custom[0].lists.unit.includes('tin'));
    const removed = await call(env, { path: '/api/shop-types/delete', method: 'POST', body: { id: type.id } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.custom, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('the routes keep types private and refuse members, anonymous callers, cross-site and unknown requests', async () => {
  const { db } = database(), originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const env = { DB: db, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'medicine-audience' };
    const made = await call(env, { method: 'POST', body: { name: 'Mine' } });
    const id = made.json.custom[0].id;
    assert.deepEqual((await call(env, { subject: 'other-sub', email: 'other@example.test' })).json.custom, []);
    assert.equal((await call(env, { subject: 'other-sub', email: 'other@example.test', path: '/api/shop-types/delete', method: 'POST', body: { id } })).status, 404);
    assert.equal((await call(env, { subject: 'member-sub', email: 'member@example.test' })).status, 403);
    assert.equal((await call(env, { subject: 'member-sub', email: 'member@example.test', method: 'POST', body: { name: 'Sneaky' } })).status, 403);
    assert.notEqual((await call(env, { token: null })).status, 200);
    assert.equal((await call(env, { method: 'POST', body: { name: 'Cross' }, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call(env, { path: '/api/shop-types/bogus', method: 'POST', body: { name: 'x' } })).status, 404);
    assert.equal((await call(env, { path: '/api/shop-types/update', method: 'GET' })).status, 404);
    assert.equal((await call(env, { method: 'POST', body: { name: 'Mine' } })).status, 409);
  } finally { globalThis.fetch = originalFetch; }
});
