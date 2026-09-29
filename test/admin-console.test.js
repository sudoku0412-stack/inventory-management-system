import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handleRequest } from '../worker/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'admin-key', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const ADMIN = 'admin-audience', CUSTOMER = 'customer-audience', EMAIL = 'kaushik.majumder@craftloop.ca';
function jwt({ aud = ADMIN, email = EMAIL, exp = Math.floor(Date.now() / 1000) + 60, iss = 'https://team.cloudflareaccess.com' } = {}) {
  const data = `${b64({ alg: 'RS256', kid: 'admin-key', typ: 'JWT' })}.${b64({ iss, aud, exp, sub: `sub-${email}`, email })}`;
  return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
}
const uuid = n => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;

function fixture({ withAuditTable = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (let i = 1; i <= 3; i += 1) {
    const shop = uuid(10 + i), user = uuid(20 + i);
    sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(shop, `Shop ${i}`, `2026-01-0${i}T00:00:00.000Z`);
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(user, 'now');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('cloudflare_access', `s${i}`, user, `owner${i}@example.test`, 'now');
    sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, user, 'owner', '2026-01-01T00:00:00.000Z');
    sqlite.prepare("INSERT INTO access_audit VALUES (?,?,?,?,?,?,?)").run(`audit-${i}`, 'shop_created', shop, user, `user:${user}`, `2026-01-0${i}T01:00:00.000Z`, 'r');
  }
  sqlite.prepare('INSERT INTO batches (id,name,form,quantity,unit,photo_path,notes,created_at,updated_at,household_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('b1', 'SECRET-MEDICINE', 'Tablets', 3, 'tablets', 'photos/SECRET-PHOTO.jpg', 'SECRET-NOTE', 'now', 'now', uuid(11));
  sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)').run('https://push.example/SECRET-ENDPOINT', 'SECRET-P256', 'SECRET-AUTH', uuid(11), uuid(21), 'now');
  sqlite.prepare('INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run('inv-1', uuid(11), 'invitee@example.test', 'member', uuid(21), 'now', '2999-01-01T00:00:00.000Z');
  if (!withAuditTable) sqlite.exec('DROP TABLE admin_audit');
  const statement = (sql, values = []) => ({ bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }) });
  const served = [];
  const env = {
    DB: { prepare: statement, batch: async items => { const out = []; for (const item of items) out.push(await item.run()); return out; } },
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: CUSTOMER, ADMIN_ACCESS_AUD: ADMIN, ADMIN_EMAILS: `${EMAIL}, Other@Craftloop.ca`,
    ASSETS: { fetch: async url => { served.push(new URL(url).pathname); return new Response(`asset:${new URL(url).pathname}`, { headers: { 'content-type': 'text/plain' } }); } }
  };
  const call = (path, { method = 'GET', token = jwt(), headers = {}, body } = {}) => handleRequest(new Request(`https://medicineinventory.craftloop.ca${path}`, { method, headers: { ...(token === null ? {} : { 'Cf-Access-Jwt-Assertion': token }), ...headers }, body }), env, { waitUntil() {} });
  const audit = () => sqlite.prepare('SELECT admin_email,action,target FROM admin_audit ORDER BY created_at,rowid').all().map(row => ({ ...row }));
  return { sqlite, env, call, served, audit };
}
const withFetch = async run => { const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] })); try { return await run(); } finally { globalThis.fetch = original; } };

test('admin routes reject missing, forged, expired, wrong-audience, customer-audience and unlisted-email tokens', () => withFetch(async () => {
  const f = fixture();
  for (const [name, options, expected] of [
    ['no token', { token: null }, 401], ['garbage', { token: 'a.b.c' }, 401], ['expired', { token: jwt({ exp: 1 }) }, 401],
    ['customer audience', { token: jwt({ aud: CUSTOMER }) }, 401], ['wrong issuer', { token: jwt({ iss: 'https://evil.cloudflareaccess.com' }) }, 401],
    ['unlisted email', { token: jwt({ email: 'stranger@example.test' }) }, 403]
  ]) {
    for (const path of ['/admin/api/overview', '/admin', '/admin/admin.js']) assert.equal((await f.call(path, options)).status, expected, `${name} ${path}`);
  }
  assert.deepEqual(f.served, [], 'no admin asset is served without authorization');
  assert.deepEqual(f.audit(), [], 'rejected attempts never write to D1');
}));

test('the allow-list is case-insensitive and admin tokens do not work on customer routes', () => withFetch(async () => {
  const f = fixture();
  assert.equal((await f.call('/admin/api/overview', { token: jwt({ email: 'OTHER@craftloop.ca' }) })).status, 200);
  assert.equal((await f.call('/api/shops', { token: jwt({ aud: ADMIN }) })).status, 401);
}));

test('missing configuration fails closed as 503', () => withFetch(async () => {
  for (const patch of [{ ADMIN_ACCESS_AUD: '' }, { ADMIN_EMAILS: '' }, { ADMIN_EMAILS: 'not-an-email' }, { ACCESS_TEAM_DOMAIN: '' }]) {
    const f = fixture(); Object.assign(f.env, patch);
    assert.equal((await f.call('/admin/api/overview')).status, 503, JSON.stringify(patch));
  }
}));

test('admin is read-only, hardened, and never caches', () => withFetch(async () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await f.call('/admin/api/shops', { method, body: '{}', headers: { 'content-type': 'application/json', origin: 'https://medicineinventory.craftloop.ca' } });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  assert.equal((await f.call('/admin/api/nope')).status, 404);
  assert.equal((await f.call('/admin/unknown.txt')).status, 404);
  const page = await f.call('/admin');
  assert.equal(page.status, 200);
  for (const [name, value] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer']]) assert.equal(page.headers.get(name), value);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.deepEqual(f.served, ['/admin/index.html']);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM households').get().n, 3);
}));

test('overview, shops, detail and audit return only allow-listed metadata, never inventory content', () => withFetch(async () => {
  const f = fixture();
  const bodies = [];
  const read = async path => { const response = await f.call(path); assert.equal(response.status, 200, path); const text = await response.text(); bodies.push(text); return JSON.parse(text); };
  const overview = await read('/admin/api/overview');
  assert.equal(overview.shops, 3); assert.equal(overview.users, 3); assert.equal(overview.medicines, 1); assert.equal(overview.owners, 3); assert.equal(overview.pendingInvitations, 1); assert.equal(overview.admin, EMAIL);
  const shops = await read('/admin/api/shops');
  assert.deepEqual(shops.shops.map(s => [s.name, s.owner_count, s.member_count, s.medicine_count]), [['Shop 1', 1, 1, 1], ['Shop 2', 1, 1, 0], ['Shop 3', 1, 1, 0]]);
  assert.deepEqual(Object.keys(shops.shops[0]), ['id', 'name', 'created_at', 'owner_count', 'member_count', 'medicine_count', 'last_audit_at']);
  const detail = await read(`/admin/api/shops/${uuid(11)}`);
  assert.deepEqual(detail.members.map(m => [m.email, m.role]), [['owner1@example.test', 'owner']]);
  assert.deepEqual(detail.invitations.map(i => [i.email, i.pending]), [['invitee@example.test', true]]);
  assert.equal(detail.shop.medicine_count, 1);
  assert.equal(detail.audit.length, 1);
  await read('/admin/api/audit'); await read('/admin/api/admin-audit');
  for (const secret of ['SECRET-MEDICINE', 'SECRET-NOTE', 'SECRET-PHOTO', 'SECRET-ENDPOINT', 'SECRET-P256', 'SECRET-AUTH', 'photo_path']) assert.ok(!bodies.some(body => body.includes(secret)), secret);
}));

test('pagination is keyset-based and validates cursors, limits and ids', () => withFetch(async () => {
  const f = fixture();
  const one = await (await f.call('/admin/api/shops?limit=2')).json();
  assert.equal(one.shops.length, 2); assert.ok(one.nextCursor);
  const two = await (await f.call(`/admin/api/shops?limit=2&cursor=${one.nextCursor}`)).json();
  assert.deepEqual(two.shops.map(s => s.name), ['Shop 3']); assert.equal(two.nextCursor, null);
  const events = await (await f.call('/admin/api/audit?limit=2')).json();
  assert.deepEqual(events.events.map(e => e.id), ['audit-3', 'audit-2']);
  const rest = await (await f.call(`/admin/api/audit?limit=2&cursor=${encodeURIComponent(events.nextCursor)}`)).json();
  assert.deepEqual(rest.events.map(e => e.id), ['audit-1']);
  const scoped = await (await f.call(`/admin/api/audit?shop=${uuid(12)}`)).json();
  assert.deepEqual(scoped.events.map(e => e.id), ['audit-2']);
  for (const path of ['/admin/api/shops?limit=0', '/admin/api/shops?limit=101', '/admin/api/shops?limit=abc', '/admin/api/shops?cursor=x', '/admin/api/audit?cursor=DROP', '/admin/api/audit?shop=x', '/admin/api/admin-audit?cursor=;']) assert.equal((await f.call(path)).status, 400, path);
  assert.equal((await f.call('/admin/api/shops/not-a-uuid')).status, 404);
  assert.equal((await f.call(`/admin/api/shops/${uuid(999)}`)).status, 404);
}));

test('every authorized request writes exactly one audit row first, and the log itself is readable', () => withFetch(async () => {
  const f = fixture();
  await f.call('/admin'); await f.call('/admin/admin.js'); await f.call('/admin/api/overview'); await f.call('/admin/api/shops'); await f.call(`/admin/api/shops/${uuid(11)}`); await f.call('/admin/api/audit'); await f.call(`/admin/api/audit?shop=${uuid(12)}`);
  assert.deepEqual(f.audit(), [
    { admin_email: EMAIL, action: 'console.open', target: null }, { admin_email: EMAIL, action: 'overview.view', target: null }, { admin_email: EMAIL, action: 'shops.list', target: null },
    { admin_email: EMAIL, action: 'shop.view', target: uuid(11) }, { admin_email: EMAIL, action: 'audit.view', target: null }, { admin_email: EMAIL, action: 'audit.view', target: uuid(12) }
  ]);
  const log = await (await f.call('/admin/api/admin-audit?limit=100')).json();
  assert.equal(log.events.length, 7, 'the read of the log is itself logged before it returns');
  assert.equal(log.events.at(-1).action, 'console.open');
}));

test('a failing or missing audit write refuses the request and returns no data', () => withFetch(async () => {
  const missing = fixture({ withAuditTable: false });
  for (const path of ['/admin/api/overview', '/admin/api/shops', '/admin']) {
    const response = await missing.call(path);
    assert.equal(response.status, 503, path);
    assert.ok(!(await response.text()).includes('Shop 1'));
  }
  assert.deepEqual(missing.served, []);
  const blocked = fixture();
  blocked.sqlite.exec("CREATE TRIGGER block BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  assert.equal((await blocked.call('/admin/api/shops')).status, 503);
}));

test('admin files are not part of the customer public asset allow-list', async () => {
  const { publicAssetPaths } = await import('../lib/shared.js');
  for (const path of ['/admin', '/admin/', '/admin/index.html', '/admin/admin.js', '/admin/admin.css']) assert.equal(publicAssetPaths.has(path), false, path);
});

test('the admin page renders with textContent only and loads no third-party script', () => {
  const script = readFileSync(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script));
  assert.ok(!/<script(?![^>]*src="\/admin\/admin\.js")/.test(html) && !/https?:\/\//.test(html));
});

test('migration 0018 creates the audit table and index', () => {
  const f = fixture();
  assert.ok(f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='admin_audit_created_at'").get());
});
