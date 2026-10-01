import test from 'node:test';
import assert from 'node:assert/strict';
import { deletionNoticeStatements, dispatchOutbox, emailConfig, invitationNoticeStatement, pruneOutbox, renderNotice, transferNoticeStatement } from '../lib/email-outbox.js';
import { memoryDb, seedPeople } from './db-fixture.js';

const T0 = '2026-10-05T12:00:00.000Z';
const at = ms => () => new Date(Date.parse(T0) + ms);
const ENV = (db, extra = {}) => ({ DB: db, RESEND_API_KEY: 'key-123', EMAIL_FROM: 'Inventory <notify@example.test>', APP_URL: 'https://app.example.test/', ...extra });
const ok = () => new Response('{}', { status: 200 });

function setup() {
  const f = memoryDb();
  seedPeople(f.sqlite);
  f.sqlite.prepare('INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run('inv1', 'h1', 'new@example.test', 'member', 'u1', T0, '2999-01-01T00:00:00.000Z');
  return f;
}
function queue(f, row) {
  const full = { id: row.id || `n-${Math.random().toString(16).slice(2)}`, kind: 'invitation_created', recipient_email: 'new@example.test', household_id: 'h1', invitation_id: 'inv1', role: 'member', deadline: null, payload: null, status: 'pending', attempts: 0, next_attempt_at: T0, lease_until: null, created_at: T0, ...row };
  full.dedupe_key = row.dedupe_key || `${full.kind}:${full.id}`;
  f.sqlite.prepare(`INSERT INTO notification_outbox (id,kind,dedupe_key,recipient_email,household_id,invitation_id,role,deadline,payload,status,attempts,next_attempt_at,lease_until,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(full.id, full.kind, full.dedupe_key, full.recipient_email, full.household_id, full.invitation_id, full.role, full.deadline, full.payload, full.status, full.attempts, full.next_attempt_at, full.lease_until, full.created_at);
  return full.id;
}
const row = (f, id) => f.rows('SELECT status,attempts,last_error,next_attempt_at,sent_at,lease_until FROM notification_outbox WHERE id=?', id)[0];

test('email sending needs an API key, a sender and an https app address', () => {
  assert.deepEqual(emailConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a <a@x.test>', APP_URL: 'https://x.test///' }), { apiKey: 'k', from: 'a <a@x.test>', appUrl: 'https://x.test' });
  for (const env of [{}, { RESEND_API_KEY: 'k', EMAIL_FROM: 'f' }, { RESEND_API_KEY: 'k', APP_URL: 'https://x.test' }, { EMAIL_FROM: 'f', APP_URL: 'https://x.test' }, { RESEND_API_KEY: 'k', EMAIL_FROM: 'f', APP_URL: 'http://x.test' }]) assert.equal(emailConfig(env), null);
});

test('every notice kind renders a subject, text and HTML that name the product and link to the app', () => {
  const notices = [
    { kind: 'invitation_created', role: 'member' }, { kind: 'invitation_created', role: 'owner' },
    { kind: 'shop_deleted', deadline: '2026-10-19T12:00:00.000Z' }, { kind: 'ownership_transferred' },
    { kind: 'weekly_digest', payload: JSON.stringify({ shops: [{ name: 'Alpha', expired: 1, expiring: 2, low: 0 }] }) }
  ];
  for (const notice of notices) {
    const out = renderNotice(notice, 'https://app.example.test');
    assert.ok(out.subject && out.text && out.html, notice.kind);
    assert.ok(out.text.includes('https://app.example.test'), `${notice.kind} text links to the app`);
    assert.ok(out.html.includes('href="https://app.example.test"'), `${notice.kind} html links to the app`);
  }
  assert.match(renderNotice(notices[1], 'https://a.test').text, /an Owner/);
  assert.match(renderNotice(notices[0], 'https://a.test').text, /a Member/);
  assert.match(renderNotice(notices[2], 'https://a.test').text, /restore it until 2026-10-19\./);
  assert.throws(() => renderNotice({ kind: 'mystery' }, 'https://a.test'), /Unknown notice kind/);
});

test('the weekly digest names each Shop, pluralizes counts and escapes Shop names in HTML', () => {
  const payload = JSON.stringify({ shops: [{ name: '<b>Alpha</b> & Co', expired: 1, expiring: 3, low: 2 }, { name: 'Quiet', expired: 0, expiring: 1, low: 0 }] });
  const { text, html, subject } = renderNotice({ kind: 'weekly_digest', payload }, 'https://a.test');
  assert.equal(subject, 'Your weekly inventory check');
  assert.match(text, /1 pack expired/); assert.match(text, /3 packs expire within 30 days/); assert.match(text, /2 packs are running low|2 packs? (?:is|are) running low/);
  assert.match(text, /1 pack expires within 30 days/);
  assert.ok(!html.includes('<b>Alpha</b>') && html.includes('&lt;b&gt;Alpha&lt;/b&gt; &amp; Co'));
  assert.match(text, /switch off "Weekly summary"/);
});

test('queueing helpers: one invitation notice per invitation, deletion notices only to other members who allow them, one ownership notice', async () => {
  const f = setup();
  const tell = statement => f.db.batch([statement]);
  await tell(invitationNoticeStatement(f.db, { id: 'inv1', householdId: 'h1', email: 'new@example.test', role: 'member', createdAt: T0 }));
  await tell(invitationNoticeStatement(f.db, { id: 'inv1', householdId: 'h1', email: 'new@example.test', role: 'member', createdAt: T0 }));
  assert.equal(f.rows("SELECT * FROM notification_outbox WHERE kind='invitation_created'").length, 1);

  f.sqlite.prepare('INSERT INTO users VALUES (?,?)').run('u4', 't');
  f.sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('access', 'sub-u4', 'u4', 'quiet@example.test', 't');
  f.sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run('h1', 'u4', 'member', 't');
  f.sqlite.prepare('INSERT INTO user_email_preferences (user_id,notices_enabled,updated_at) VALUES (?,0,?)').run('u4', T0);
  await tell(deletionNoticeStatements(f.db, { householdId: 'h1', actorUserId: 'u1', deletedAt: T0, purgeAfter: '2026-10-19T12:00:00.000Z' }));
  assert.deepEqual(f.rows("SELECT recipient_email FROM notification_outbox WHERE kind='shop_deleted'").map(r => r.recipient_email), ['member@example.test']);

  await tell(transferNoticeStatement(f.db, { householdId: 'h1', targetUserId: 'u2', operationId: 'op1', createdAt: T0 }));
  await tell(transferNoticeStatement(f.db, { householdId: 'h1', targetUserId: 'u2', operationId: 'op1', createdAt: T0 }));
  assert.equal(f.rows("SELECT * FROM notification_outbox WHERE kind='ownership_transferred'").length, 1);
  await tell(transferNoticeStatement(f.db, { householdId: 'h1', targetUserId: 'u4', operationId: 'op2', createdAt: T0 }));
  assert.equal(f.rows("SELECT * FROM notification_outbox WHERE kind='ownership_transferred'").length, 1, 'an account that turned notices off gets no transfer notice');
});

test('without email settings nothing is sent and rows wait', async () => {
  const f = setup(); const id = queue(f, {});
  let calls = 0;
  assert.deepEqual(await dispatchOutbox({ DB: f.db }, { fetchImpl: async () => { calls += 1; return ok(); }, now: at(0) }), {});
  assert.equal(calls, 0);
  assert.equal(row(f, id).status, 'pending');
});

test('a due notice is sent once, with the key, sender, recipient and an idempotency key, and marked sent', async () => {
  const f = setup(); const id = queue(f, {});
  const sent = [];
  const counts = await dispatchOutbox(ENV(f.db), { fetchImpl: async (url, init) => { sent.push([url, init]); return ok(); }, now: at(1000) });
  assert.deepEqual(counts, { sent: 1 });
  const [url, init] = sent[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.headers.authorization, 'Bearer key-123');
  assert.equal(init.headers['idempotency-key'], `invitation_created:${id}`);
  const body = JSON.parse(init.body);
  assert.deepEqual([body.from, body.to], ['Inventory <notify@example.test>', ['new@example.test']]);
  assert.ok(body.text.includes('https://app.example.test'), 'trailing slash on APP_URL is removed');
  assert.equal(row(f, id).status, 'sent'); assert.ok(row(f, id).sent_at); assert.equal(row(f, id).lease_until, null);
  assert.deepEqual(await dispatchOutbox(ENV(f.db), { fetchImpl: async () => { throw new Error('must not resend'); }, now: at(2000) }), {});
});

test('rows that are not due yet are left alone', async () => {
  const f = setup(); const id = queue(f, { next_attempt_at: '2026-10-06T00:00:00.000Z' });
  assert.deepEqual(await dispatchOutbox(ENV(f.db), { fetchImpl: async () => ok(), now: at(0) }), {});
  assert.equal(row(f, id).status, 'pending');
});

test('notices that no longer apply are cancelled instead of sent', async () => {
  const f = setup();
  const expiredInvite = queue(f, { id: 'a', invitation_id: 'gone' });
  const deletedOk = queue(f, { id: 'b', kind: 'shop_deleted', recipient_email: 'member@example.test', invitation_id: null, deadline: '2026-10-19T12:00:00.000Z' });
  const restored = queue(f, { id: 'c', kind: 'shop_deleted', household_id: 'h2', recipient_email: 'other@example.test', invitation_id: null });
  const transferToDeleted = queue(f, { id: 'd', kind: 'ownership_transferred', household_id: 'hx', recipient_email: 'owner@example.test', invitation_id: null });
  f.sqlite.prepare('INSERT INTO household_deletions (household_id,deleted_at,purge_after,deleted_by_user_id) VALUES (?,?,?,?)').run('h1', T0, '2026-10-19T12:00:00.000Z', 'u1');
  const sent = [];
  const counts = await dispatchOutbox(ENV(f.db), { fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body).to[0]); return ok(); }, now: at(0) });
  assert.equal(row(f, expiredInvite).status, 'cancelled');
  assert.equal(row(f, deletedOk).status, 'sent');
  assert.equal(row(f, restored).status, 'cancelled', 'a restored Shop is not announced as deleted');
  assert.equal(row(f, transferToDeleted).status, 'cancelled');
  assert.deepEqual(sent, ['member@example.test']);
  assert.deepEqual(counts, { cancelled: 3, sent: 1 });
});

test('turning notices off cancels queued notices but never invitations; turning the digest off cancels digests', async () => {
  const f = setup();
  f.sqlite.prepare('INSERT INTO user_email_preferences (user_id,notices_enabled,digest_enabled,updated_at) VALUES (?,0,0,?)').run('u2', T0);
  f.sqlite.prepare('INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run('inv2', 'h1', 'member@example.test', 'member', 'u1', T0, '2999-01-01T00:00:00.000Z');
  f.sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run('hx', 'X', 't');
  const notice = queue(f, { id: 'n1', kind: 'ownership_transferred', recipient_email: 'member@example.test', invitation_id: null });
  const invite = queue(f, { id: 'n2', recipient_email: 'member@example.test', invitation_id: 'inv2' });
  const digest = queue(f, { id: 'n3', kind: 'weekly_digest', recipient_email: 'member@example.test', household_id: '', invitation_id: null, payload: JSON.stringify({ shops: [] }) });
  await dispatchOutbox(ENV(f.db), { fetchImpl: async () => ok(), now: at(0) });
  assert.equal(row(f, notice).status, 'cancelled');
  assert.equal(row(f, invite).status, 'sent');
  assert.equal(row(f, digest).status, 'cancelled');
});

test('a weekly digest that missed its week is dropped', async () => {
  const f = setup();
  const old = queue(f, { id: 'old', kind: 'weekly_digest', recipient_email: 'owner@example.test', household_id: '', invitation_id: null, payload: JSON.stringify({ shops: [{ name: 'A', expired: 1, expiring: 0, low: 0 }] }), created_at: '2026-10-01T12:00:00.000Z' });
  const fresh = queue(f, { id: 'fresh', kind: 'weekly_digest', recipient_email: 'member@example.test', household_id: '', invitation_id: null, payload: JSON.stringify({ shops: [{ name: 'A', expired: 1, expiring: 0, low: 0 }] }) });
  await dispatchOutbox(ENV(f.db), { fetchImpl: async () => ok(), now: at(60 * 60 * 1000) });
  assert.equal(row(f, old).status, 'cancelled');
  assert.equal(row(f, fresh).status, 'sent');
});

test('rate limits and server errors retry with doubling delay that stops growing at four hours', async () => {
  const f = setup(); const id = queue(f, {});
  let now = 0;
  const run = status => dispatchOutbox(ENV(f.db), { fetchImpl: async () => new Response('', { status }), now: () => new Date(Date.parse(T0) + now) });
  assert.deepEqual(await run(429), { retry: 1 });
  assert.equal(row(f, id).status, 'pending'); assert.equal(row(f, id).attempts, 1); assert.equal(row(f, id).last_error, 'HTTP 429');
  assert.equal(Date.parse(row(f, id).next_attempt_at) - Date.parse(T0), 15 * 60 * 1000);
  now = 16 * 60 * 1000; assert.deepEqual(await run(503), { retry: 1 });
  assert.equal(Date.parse(row(f, id).next_attempt_at) - (Date.parse(T0) + now), 30 * 60 * 1000);
  now = 60 * 60 * 1000; assert.deepEqual(await run(409), { retry: 1 });
  assert.equal(Date.parse(row(f, id).next_attempt_at) - (Date.parse(T0) + now), 60 * 60 * 1000);
  f.sqlite.prepare('UPDATE notification_outbox SET attempts=9, next_attempt_at=?').run(T0);
  now = 2 * 60 * 60 * 1000; assert.deepEqual(await run(500), { retry: 1 });
  assert.equal(Date.parse(row(f, id).next_attempt_at) - (Date.parse(T0) + now), 4 * 60 * 60 * 1000);
});

test('a network failure retries, a client error fails for good, and a retry past 24 hours is marked uncertain', async () => {
  const f = setup();
  const retried = queue(f, { id: 'r' });
  assert.deepEqual(await dispatchOutbox(ENV(f.db), { fetchImpl: async () => { throw new Error('socket hang up'); }, now: at(0) }), { retry: 1 });
  assert.equal(row(f, retried).last_error, 'socket hang up');
  const rejected = queue(f, { id: 'x', dedupe_key: 'k-x' });
  await dispatchOutbox(ENV(f.db), { fetchImpl: async () => new Response('', { status: 422 }), now: at(0) });
  assert.equal(row(f, rejected).status, 'failed'); assert.equal(row(f, rejected).last_error, 'HTTP 422');
  const stale = queue(f, { id: 's', attempts: 2, created_at: '2026-10-03T00:00:00.000Z', next_attempt_at: T0 });
  await dispatchOutbox(ENV(f.db), { fetchImpl: async () => { throw new Error('timeout'); }, now: at(0) });
  assert.equal(row(f, stale).status, 'uncertain');
});

test('a row another worker is sending is skipped until its lease runs out, then picked up again', async () => {
  const f = setup();
  const busy = queue(f, { id: 'busy', status: 'sending', attempts: 1, lease_until: '2026-10-05T12:03:00.000Z' });
  let sent = 0;
  const send = async () => { sent += 1; return ok(); };
  assert.deepEqual(await dispatchOutbox(ENV(f.db), { fetchImpl: send, now: at(60 * 1000) }), {});
  assert.equal(sent, 0);
  assert.deepEqual(await dispatchOutbox(ENV(f.db), { fetchImpl: send, now: at(10 * 60 * 1000) }), { sent: 1 });
  assert.equal(row(f, busy).status, 'sent'); assert.equal(row(f, busy).attempts, 2);
});

test('a run handles at most 20 rows, oldest first', async () => {
  const f = setup();
  for (let i = 0; i < 25; i += 1) queue(f, { id: `m${String(i).padStart(2, '0')}`, invitation_id: 'inv1', next_attempt_at: `2026-10-05T11:${String(i).padStart(2, '0')}:00.000Z`, dedupe_key: `d${i}` });
  const counts = await dispatchOutbox(ENV(f.db), { fetchImpl: async () => ok(), now: at(0) });
  assert.equal(counts.sent, 20);
  assert.equal(f.rows("SELECT count(*) AS n FROM notification_outbox WHERE status='pending'")[0].n, 5);
  assert.equal(row(f, 'm00').status, 'sent'); assert.equal(row(f, 'm24').status, 'pending');
});

test('pruning removes old finished and never-attempted rows and keeps failed, uncertain and recent ones', async () => {
  const f = setup();
  const old = '2026-08-01T00:00:00.000Z';
  for (const [id, status, attempts, created] of [['sent-old', 'sent', 1, old], ['cancelled-old', 'cancelled', 1, old], ['never-old', 'pending', 0, old], ['failed-old', 'failed', 1, old], ['uncertain-old', 'uncertain', 2, old], ['pending-tried-old', 'pending', 2, old], ['sent-new', 'sent', 1, T0]]) queue(f, { id, status, attempts, created_at: created, dedupe_key: `k-${id}` });
  await pruneOutbox(f.db, at(0));
  assert.deepEqual(f.rows('SELECT id FROM notification_outbox ORDER BY id').map(r => r.id), ['failed-old', 'pending-tried-old', 'sent-new', 'uncertain-old']);
});
