import { deletionReadSchema, outboxSchema } from './deletion-stub.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootstrapEmails, onboardingStatus, resolveTenant as lookupTenant, setupInitialShop } from '../lib/tenants.js';
import { createD1Store } from '../lib/store-d1.js';
import { createVapidKeys } from '../lib/shared.js';
import { acceptHouseholdInvitation, createHouseholdInvitation, listHouseholdAccess, pendingHouseholdInvitations, promoteHouseholdMember, revokeHouseholdInvitation } from '../lib/household-access.js';

// Older tenant tests need a member fixture; production membership lookup stays
// read-only and setup is always made explicit by this test helper.
async function resolveTenant(db, principal, env, now) {
  const result = await setupInitialShop(db, principal, env, { displayName: 'Test Owner', shopName: 'Test Shop' }, now ? { now } : undefined);
  const { created, ...tenant } = result;
  return tenant;
}

function d1(sqlite) {
  const statement = sql => {
    const execute = values => ({
      first: async () => sqlite.prepare(sql).get(...values),
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } })
    });
    return { ...execute([]), bind: (...values) => execute(values) };
  };
  return { prepare: statement, batch: async rows => {
    sqlite.exec('BEGIN');
    try { const results = []; for (const row of rows) results.push(await row.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

function tenantDatabase(displayName = 'Legacy', { compatibilityMigration = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_profile_settings.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_household_tenants.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0005_household_invitations.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0006_household_invitation_expiration.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0007_sync_mutation_foundation.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0008_household_display_name_source.sql', import.meta.url), 'utf8'));
  if (compatibilityMigration) sqlite.exec(readFileSync(new URL('../migrations/0009_seed_legacy_household_display_names.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0010_access_audit.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0011_user_shop_preferences.sql', import.meta.url), 'utf8'));
  sqlite.exec(deletionReadSchema);
  sqlite.exec(outboxSchema);
  sqlite.exec(readFileSync(new URL('../migrations/0014_additional_shop_invitation_joins.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0015_batch_change_feed.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO profile_settings VALUES (1,?,?,?,?)').run(displayName, 'Legacy house', 'Medicine cabinet', '2026-01-01T00:00:00.000Z');
  sqlite.prepare("INSERT INTO batches (id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,created_at,updated_at) VALUES ('legacy','Medicine','','Tablets',2,'tablets',NULL,'','',1,'2026-01-01','2026-01-01')").run();
  return { sqlite, db: d1(sqlite) };
}

test('only an explicit configured owner can bootstrap legacy rows', async () => {
  const { sqlite, db } = tenantDatabase();
  const env = { INITIAL_OWNER_EMAILS: 'owner@example.test' };
  await assert.rejects(() => resolveTenant(db, { provider: 'cloudflare_access', subject: 'other', email: 'other@example.test' }, env), { status: 403 });
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner-subject', email: 'owner@example.test' }, env, () => '2026-01-02T00:00:00.000Z');
  assert.equal(sqlite.prepare("SELECT household_id FROM batches WHERE id='legacy'").get().household_id, owner.householdId);
  assert.equal(sqlite.prepare('SELECT household_id FROM household_settings').get().household_id, owner.householdId);
  assert.equal(sqlite.prepare('SELECT display_name FROM household_settings').get().display_name, 'Test Owner');
  const repeat = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner-subject', email: 'owner@example.test' }, env);
  assert.deepEqual(repeat, owner);
  await assert.rejects(() => resolveTenant(db, { provider: 'cloudflare_access', subject: 'second', email: 'owner@example.test' }, env), { status: 403 });
  sqlite.close();
});

test('onboarding status is read-only and explicit setup binds the verified identity with an audit record', async () => {
  const { sqlite, db } = tenantDatabase();
  const principal = { provider: 'cloudflare_access', subject: 'verified-subject', email: 'KMAZ285@gmail.com' };
  const env = { INITIAL_OWNER_EMAILS: 'kmaz285@gmail.com' };
  assert.deepEqual(await onboardingStatus(db, principal, env), { membership: null, pendingInvitation: false, setupEligible: true });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM tenant_bootstrap').get().n, 0);
  const setup = await setupInitialShop(db, principal, env, { displayName: 'Kaushik', shopName: 'Mendicie' }, { requestId: 'req-setup', now: () => '2026-09-26T00:00:00.000Z' });
  assert.equal(setup.role, 'owner');
  assert.equal(sqlite.prepare('SELECT email FROM identities WHERE user_id=?').get(setup.userId).email, 'kmaz285@gmail.com');
  const audit = sqlite.prepare('SELECT event,actor_user_id,target_identifier,request_id FROM access_audit').get();
  assert.equal(audit.event, 'bootstrap'); assert.equal(audit.actor_user_id, setup.userId); assert.equal(audit.target_identifier, 'cloudflare_access:verified-subject'); assert.equal(audit.request_id, 'req-setup');
  assert.deepEqual(await onboardingStatus(db, principal, env), { membership: { role: 'owner' }, pendingInvitation: false, setupEligible: false });
  assert.equal((await setupInitialShop(db, principal, env, { displayName: 'Ignored', shopName: 'Ignored' })).created, false);
  await assert.rejects(() => lookupTenant(db, { provider: 'cloudflare_access', subject: 'outsider', email: 'outsider@example.test' }), { status: 403 });
  sqlite.close();
});

test('verified identity display names seed legacy settings, preserve user edits including Kaushik, and remain household-scoped', async () => {
  const { sqlite, db } = tenantDatabase('Sudoku');
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const photos = { put: async () => {}, delete: async () => {} };
  const ownerStore = createD1Store(db, photos, { publicKey: 'test' }, { ...owner, displayName: 'Owner Name' });
  assert.equal((await ownerStore.settings()).display_name, 'Test Owner');
  assert.equal(sqlite.prepare('SELECT display_name_source FROM household_settings WHERE household_id=?').get(owner.householdId).display_name_source, 'user');
  await ownerStore.updateSettings({ display_name: 'Kaushik', household_name: 'Legacy house', default_storage_location: 'Medicine cabinet' });
  assert.equal(sqlite.prepare('SELECT display_name_source FROM household_settings WHERE household_id=?').get(owner.householdId).display_name_source, 'user');

  sqlite.prepare("INSERT INTO users VALUES ('other-user','now')").run();
  sqlite.prepare("INSERT INTO households VALUES ('other-household','Other','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other-household','other-user','owner','now')").run();
  const otherStore = createD1Store(db, photos, { publicKey: 'test' }, { householdId: 'other-household', userId: 'other-user', displayName: 'Other Person' });
  assert.equal((await otherStore.settings()).display_name, 'Other Person');
  assert.equal(sqlite.prepare('SELECT display_name_source FROM household_settings WHERE household_id=?').get('other-household').display_name_source, 'identity_seed');
  assert.equal((await ownerStore.settings()).display_name, 'Kaushik');
  sqlite.close();
});

test('0009 reclassifies legacy markers globally, seeds Sudoku once, preserves later edits, and isolates household reads', async () => {
  const { sqlite, db } = tenantDatabase('Sudoku', { compatibilityMigration: false });
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'kmaz-subject', email: 'kmaz285@gmail.com' }, { INITIAL_OWNER_EMAILS: 'kmaz285@gmail.com' });
  // Emulate an owner who bootstrapped before this fix, when 0008 recorded
  // every inherited profile value as user-owned.
  sqlite.prepare("UPDATE household_settings SET display_name_source='user' WHERE household_id=?").run(owner.householdId);
  sqlite.prepare("INSERT INTO users VALUES ('other-user','now')").run();
  sqlite.prepare("INSERT INTO households VALUES ('other-household','Other','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other-household','other-user','owner','now')").run();
  sqlite.prepare("INSERT INTO household_settings (household_id,display_name,household_name,default_storage_location,updated_at,display_name_source) VALUES ('other-household','Chosen Name','Other','Medicine cabinet','now','user')").run();
  sqlite.exec(readFileSync(new URL('../migrations/0009_seed_legacy_household_display_names.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0010_access_audit.sql', import.meta.url), 'utf8'));
  assert.equal(sqlite.prepare('SELECT display_name_source FROM household_settings WHERE household_id=?').get(owner.householdId).display_name_source, 'default');
  const otherBeforeSeed = sqlite.prepare("SELECT display_name,display_name_source FROM household_settings WHERE household_id='other-household'").get();
  assert.equal(otherBeforeSeed.display_name, 'Chosen Name');
  assert.equal(otherBeforeSeed.display_name_source, 'default');

  const photos = { put: async () => {}, delete: async () => {} };
  const ownerStore = createD1Store(db, photos, { publicKey: 'test' }, { ...owner, displayName: 'Kaushik Sudesna' });
  assert.equal((await ownerStore.settings()).display_name, 'Kaushik Sudesna');
  assert.equal(sqlite.prepare('SELECT display_name_source FROM household_settings WHERE household_id=?').get(owner.householdId).display_name_source, 'identity_seed');
  assert.equal(sqlite.prepare("SELECT display_name FROM household_settings WHERE household_id='other-household'").get().display_name, 'Chosen Name');
  assert.equal(sqlite.prepare("SELECT display_name_source FROM household_settings WHERE household_id='other-household'").get().display_name_source, 'default');

  await ownerStore.updateSettings({ display_name: 'My Chosen Name', household_name: 'Legacy house', default_storage_location: 'Medicine cabinet' });
  const laterPrincipalStore = createD1Store(db, photos, { publicKey: 'test' }, { ...owner, displayName: 'Different Verified Name' });
  assert.equal((await laterPrincipalStore.settings()).display_name, 'My Chosen Name');
  assert.equal(sqlite.prepare('SELECT display_name_source FROM household_settings WHERE household_id=?').get(owner.householdId).display_name_source, 'user');
  sqlite.close();
});

test('a losing bootstrap contention becomes a denial without issuing partial rows', async () => {
  let markerReads = 0;
  let batches = 0;
  const db = {
    prepare(sql) {
      return {
        bind: () => ({ first: async () => sql.includes('tenant_bootstrap') && ++markerReads > 1 ? { household_id: 'winner' } : undefined }),
        first: async () => sql.includes('tenant_bootstrap') && ++markerReads > 1 ? { household_id: 'winner' } : undefined
      };
    },
    batch: async statements => { batches += 1; assert.equal(statements.length, 10); throw new Error('UNIQUE constraint failed: tenant_bootstrap.singleton'); }
  };
  await assert.rejects(() => resolveTenant(db, { provider: 'cloudflare_access', subject: 'loser', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' }), { status: 403 });
  assert.equal(batches, 1);
});

test('a household-scoped D1 store cannot list another household’s batches', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  sqlite.prepare("INSERT INTO users VALUES ('member','now')").run();
  sqlite.prepare("INSERT INTO households VALUES ('other','Other','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other','member','member','now')").run();
  const store = createD1Store(db, { put: async () => {}, delete: async () => {} }, { publicKey: 'test' }, { householdId: 'other', userId: 'member' });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get('legacy'), undefined);
  assert.equal(await store.photoMeta('legacy'), null);
  await assert.rejects(() => store.update('legacy', { name: 'No access' }), { status: 404 });
  assert.equal((await createD1Store(db, { put: async () => {}, delete: async () => {} }, { publicKey: 'test' }, owner).list()).length, 1);
  sqlite.close();
});

test('sync migration adds revisions and tenant-scoped operation receipts', () => {
  const { sqlite } = tenantDatabase();
  assert.equal(sqlite.prepare("SELECT revision FROM batches WHERE id='legacy'").get().revision, 1);
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(mutation_receipts)').all().map(column => column.name), ['household_id', 'operation_id', 'batch_id', 'operation', 'response_status', 'response_body', 'created_at']);
  sqlite.close();
});

test('sync mutations replay duplicate operation IDs and reject stale revisions with the current batch', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const store = createD1Store(db, { put: async () => {}, delete: async () => {} }, { publicKey: 'test' }, owner, () => new Date('2026-02-02T00:00:00.000Z'));
  const createPayload = { name: 'Sync medicine', form: 'Tablets', quantity: 8, unit: 'tablets', operationId: '11111111-1111-4111-8111-111111111111', baseRevision: 0 };
  const created = await store.create(createPayload);
  const replayedCreate = await store.create(createPayload);
  assert.equal(replayedCreate.id, created.id);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM batches WHERE name='Sync medicine'").get().n, 1);
  assert.equal(created.revision, 1);

  const updatePayload = { name: 'Updated sync medicine', operationId: '22222222-2222-4222-8222-222222222222', baseRevision: 1 };
  const updated = await store.update(created.id, updatePayload);
  assert.equal(updated.revision, 2);
  assert.equal((await store.update(created.id, updatePayload)).revision, 2);
  assert.equal(sqlite.prepare('SELECT revision,name FROM batches WHERE id=?').get(created.id).name, 'Updated sync medicine');
  await assert.rejects(() => store.consume(created.id, { amount: 1, operationId: '33333333-3333-4333-8333-333333333333', baseRevision: 1 }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.current.id, created.id);
    assert.equal(error.current.revision, 2);
    return true;
  });
  sqlite.close();
});

test('a concurrent duplicate create removes the losing uploaded photo after receipt replay', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const uploaded = [], deleted = [];
  let arrivals = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const photos = {
    put: async key => { uploaded.push(key); if (++arrivals === 2) release(); await ready; },
    delete: async key => { deleted.push(key); }
  };
  const store = createD1Store(db, photos, { publicKey: 'test' }, owner);
  const payload = { name: 'Photo race', form: 'Tablets', quantity: 2, unit: 'tablets', photo: 'data:image/jpeg;base64,/9j/', operationId: '55555555-5555-4555-8555-555555555555', baseRevision: 0 };
  const [first, second] = await Promise.all([store.create(payload), store.create(payload)]);
  assert.equal(first.id, second.id);
  assert.equal(uploaded.length, 2);
  assert.equal(deleted.length, 1);
  assert.notEqual(deleted[0], sqlite.prepare('SELECT photo_path FROM batches WHERE id=?').get(first.id).photo_path);
  sqlite.close();
});

test('sync receipts and mutations remain isolated between households', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  sqlite.prepare("INSERT INTO users VALUES ('other-user','now')").run();
  sqlite.prepare("INSERT INTO households VALUES ('other-household','Other','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other-household','other-user','member','now')").run();
  const photos = { put: async () => {}, delete: async () => {} };
  const ownerStore = createD1Store(db, photos, { publicKey: 'test' }, owner);
  const otherStore = createD1Store(db, photos, { publicKey: 'test' }, { householdId: 'other-household', userId: 'other-user' });
  const operationId = '44444444-4444-4444-8444-444444444444';
  const payload = { name: 'Household item', form: 'Tablets', quantity: 2, unit: 'tablets', operationId, baseRevision: 0 };
  const ownerBatch = await ownerStore.create(payload);
  const otherBatch = await otherStore.create(payload);
  assert.notEqual(ownerBatch.id, otherBatch.id);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM mutation_receipts WHERE operation_id=?').get(operationId).n, 2);
  assert.equal(await otherStore.get(ownerBatch.id), undefined);
  sqlite.close();
});

test('push endpoint ownership cannot move across households and expired member subscriptions are removed', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  sqlite.prepare("INSERT INTO users VALUES ('member','now')").run();
  sqlite.prepare("INSERT INTO households VALUES ('other','Other','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other','member','member','now')").run();
  const photos = { put: async () => {}, delete: async () => {} };
  const ownerStore = createD1Store(db, photos, createVapidKeys(), owner);
  await ownerStore.savePushSubscription({ endpoint: 'https://push.example.test/a', keys: { p256dh: 'key', auth: 'auth' } });
  const otherStore = createD1Store(db, photos, { publicKey: 'test' }, { householdId: 'other', userId: 'member' });
  await assert.rejects(() => otherStore.savePushSubscription({ endpoint: 'https://push.example.test/a', keys: { p256dh: 'key', auth: 'auth' } }), { status: 409 });

  sqlite.prepare("INSERT INTO users VALUES ('member-in-owner','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES (?,?,?,?)").run(owner.householdId, 'member-in-owner', 'member', 'now');
  sqlite.prepare("INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?)").run('https://push.example.test/gone', 'key', 'auth', owner.householdId, 'member-in-owner', 'now');
  sqlite.prepare("INSERT INTO notifications (id,batch_id,household_id,kind,trigger_date,created_at) VALUES ('pending','legacy',?,'test','2026-01-01','now')").run(owner.householdId);
  await ownerStore.deliverPushes({ fetchImpl: async () => ({ status: 410, ok: false }) });
  assert.equal(sqlite.prepare("SELECT endpoint FROM push_subscriptions WHERE endpoint='https://push.example.test/gone'").get(), undefined);
  sqlite.close();
});

test('bootstrap email parsing is case-insensitive and ignores malformed values', () => {
  assert.deepEqual([...bootstrapEmails({ INITIAL_OWNER_EMAILS: ' Owner@Example.test, invalid,SECOND@example.test ' })], ['owner@example.test', 'second@example.test']);
});

test('only owners can list, create, and revoke household invitations', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  sqlite.prepare("INSERT INTO users VALUES ('member','now')").run();
  sqlite.prepare("INSERT INTO identities VALUES ('cloudflare_access','member-subject','member','member@example.test','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES (?,?,?,?)").run(owner.householdId, 'member', 'member', 'now');
  const member = { householdId: owner.householdId, userId: 'member' };
  await assert.rejects(() => listHouseholdAccess(db, member), { status: 403 });
  await assert.rejects(() => createHouseholdInvitation(db, member, { email: 'new@example.test' }), { status: 403 });
  const created = await createHouseholdInvitation(db, owner, { email: '  New@Example.test ' }, () => '2026-10-03T00:00:00.000Z');
  assert.deepEqual({ email: created.email, role: created.role, created_at: created.created_at }, { email: 'new@example.test', role: 'member', created_at: '2026-10-03T00:00:00.000Z' });
  const access = await listHouseholdAccess(db, owner);
  assert.deepEqual(access.members, [{ user_id: owner.userId, email: 'owner@example.test', role: 'owner', is_you: true }, { user_id: 'member', email: 'member@example.test', role: 'member', is_you: false }]);
  assert.equal(access.invitations.length, 1);
  await assert.rejects(() => revokeHouseholdInvitation(db, member, created.id), { status: 403 });
  await revokeHouseholdInvitation(db, owner, created.id);
  assert.equal((await listHouseholdAccess(db, owner)).invitations.length, 0);
  assert.deepEqual(sqlite.prepare("SELECT event,target_identifier FROM access_audit WHERE event LIKE 'invite_%'").all().map(row => ({ ...row })).sort((a,b) => a.event.localeCompare(b.event)), [
    { event: 'invite_created', target_identifier: 'new@example.test' },
    { event: 'invite_revoked', target_identifier: 'new@example.test' }
  ]);
  sqlite.close();
});

test('owner promotion is pinned, replay-safe, audited, and preserves the acting owner', async () => {
  const { sqlite, db } = tenantDatabase();
  sqlite.exec(readFileSync(new URL('../migrations/0012_shop_creation.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0013_shop_owner_promotion.sql', import.meta.url), 'utf8'));
  const principal = { provider: 'cloudflare_access', subject: 'owner-promotion', email: 'owner@example.test' };
  const owner = await resolveTenant(db, principal, { INITIAL_OWNER_EMAILS: principal.email });
  const target = '11111111-1111-4111-8111-111111111111', operationId = '22222222-2222-4222-8222-222222222222';
  sqlite.prepare('INSERT INTO users VALUES (?,?)').run(target, 'now');
  sqlite.prepare("INSERT INTO memberships VALUES (?,?,'member',?)").run(owner.householdId, target, 'now');
  const promoted = await promoteHouseholdMember(db, principal, owner, target, { operationId }, 'request-promotion');
  assert.deepEqual(promoted, { member: { user_id: target, role: 'owner' }, changed: true });
  assert.equal(sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(owner.householdId, owner.userId).role, 'owner');
  assert.equal(sqlite.prepare('SELECT event,target_identifier FROM access_audit WHERE event=?').get('member_promoted').target_identifier, `user:${target}`);
  assert.equal((await promoteHouseholdMember(db, principal, owner, target, { operationId })).changed, false);
  assert.equal((await promoteHouseholdMember(db, principal, owner, target, { operationId: '33333333-3333-4333-8333-333333333333' })).changed, false);
  sqlite.close();
});

test('invitations remain isolated and never auto-enrol an existing identity', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  sqlite.prepare("INSERT INTO households VALUES ('other','Other','now')").run();
  sqlite.prepare("INSERT INTO users VALUES ('other-owner','now')").run();
  sqlite.prepare("INSERT INTO identities VALUES ('cloudflare_access','other-owner','other-owner','other@example.test','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other','other-owner','owner','now')").run();
  await createHouseholdInvitation(db, owner, { email: 'other@example.test' });
  assert.equal(sqlite.prepare("SELECT user_id FROM memberships WHERE household_id=? AND user_id='other-owner'").get(owner.householdId), undefined);
  await assert.rejects(() => createHouseholdInvitation(db, owner, { email: 'OWNER@example.test' }), { status: 409 });
  await assert.rejects(() => createHouseholdInvitation(db, owner, { email: 'other@example.test' }), { status: 409 });
  const otherOwner = { householdId: 'other', userId: 'other-owner' };
  const visibleElsewhere = await listHouseholdAccess(db, otherOwner);
  assert.equal(visibleElsewhere.invitations.length, 0);
  sqlite.close();
});

test('a verified unaffiliated identity can explicitly accept its matching unexpired invitation once', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const invitation = await createHouseholdInvitation(db, owner, { email: 'invitee@example.test' }, () => '2026-02-01T00:00:00.000Z');
  const principal = { provider: 'cloudflare_access', subject: 'invitee-subject', email: 'INVITEE@example.test' };
  const pending = await pendingHouseholdInvitations(db, principal, () => '2026-02-02T00:00:00.000Z');
  assert.deepEqual(pending.invitations, [{ id: invitation.id, household_name: 'Test Shop', role: 'member', expires_at: '2026-02-08T00:00:00.000Z' }]);
  const accepted = await acceptHouseholdInvitation(db, principal, invitation.id, () => '2026-02-02T00:00:00.000Z');
  assert.equal(accepted.householdId, owner.householdId);
  const identity = sqlite.prepare("SELECT user_id,email FROM identities WHERE provider='cloudflare_access' AND subject='invitee-subject'").get();
  assert.equal(identity.email, 'invitee@example.test');
  assert.equal(sqlite.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').get(owner.householdId, identity.user_id).role, 'member');
  assert.equal(sqlite.prepare('SELECT id FROM household_invitations WHERE id=?').get(invitation.id), undefined);
  assert.equal(sqlite.prepare("SELECT event FROM access_audit WHERE event='invite_accepted'").get().event, 'invite_accepted');
  assert.equal((await acceptHouseholdInvitation(db, principal, invitation.id)).accepted, false);
  sqlite.close();
});

test('acceptance rejects wrong email/id, expiry, revocation, and other-household identities without partial enrollment', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const invitation = await createHouseholdInvitation(db, owner, { email: 'invitee@example.test' }, () => '2026-02-01T00:00:00.000Z');
  const wrong = { provider: 'cloudflare_access', subject: 'wrong', email: 'wrong@example.test' };
  await assert.rejects(() => acceptHouseholdInvitation(db, wrong, invitation.id, () => '2026-02-02T00:00:00.000Z'), { status: 404 });
  assert.equal(sqlite.prepare("SELECT 1 FROM identities WHERE subject='wrong'").get(), undefined);
  await assert.rejects(() => acceptHouseholdInvitation(db, { ...wrong, email: 'invitee@example.test' }, '00000000-0000-0000-0000-000000000000'), { status: 404 });
  await assert.rejects(() => acceptHouseholdInvitation(db, { provider: 'cloudflare_access', subject: 'expired', email: 'invitee@example.test' }, invitation.id, () => '2026-02-09T00:00:00.000Z'), { status: 404 });
  assert.equal(sqlite.prepare("SELECT 1 FROM users WHERE id NOT IN (SELECT owner_user_id FROM tenant_bootstrap)").get(), undefined);
  await revokeHouseholdInvitation(db, owner, invitation.id);
  await assert.rejects(() => acceptHouseholdInvitation(db, { provider: 'cloudflare_access', subject: 'revoked', email: 'invitee@example.test' }, invitation.id), { status: 404 });
  sqlite.prepare("INSERT INTO households VALUES ('other','Other','now')").run();
  sqlite.prepare("INSERT INTO users VALUES ('other-user','now')").run();
  sqlite.prepare("INSERT INTO identities VALUES ('cloudflare_access','other-subject','other-user','invitee@example.test','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other','other-user','member','now')").run();
  const newInvitation = await createHouseholdInvitation(db, owner, { email: 'invitee@example.test' });
  const joined = await acceptHouseholdInvitation(db, { provider: 'cloudflare_access', subject: 'other-subject', email: 'invitee@example.test' }, newInvitation.id);
  assert.equal(joined.role, 'member');
  assert.equal(sqlite.prepare('SELECT id FROM household_invitations WHERE id=?').get(newInvitation.id), undefined);
  sqlite.close();
});

test('concurrent/duplicate acceptance consumes one invitation and cannot leave partial identity rows on a constraint race', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const invitation = await createHouseholdInvitation(db, owner, { email: 'race@example.test' });
  const principal = { provider: 'cloudflare_access', subject: 'race-subject', email: 'race@example.test' };
  const outcomes = await Promise.allSettled([acceptHouseholdInvitation(db, principal, invitation.id), acceptHouseholdInvitation(db, principal, invitation.id)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM identities WHERE subject='race-subject'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memberships WHERE user_id=(SELECT user_id FROM identities WHERE subject='race-subject')").get().n, 1);
  assert.equal(sqlite.prepare('SELECT id FROM household_invitations WHERE id=?').get(invitation.id), undefined);
  sqlite.close();
});

test('an existing identity without a membership is reused, and a D1 batch failure rolls back all new enrollment rows', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  sqlite.prepare("INSERT INTO users VALUES ('unaffiliated','now')").run();
  sqlite.prepare("INSERT INTO identities VALUES ('cloudflare_access','existing-subject','unaffiliated','reuse@example.test','now')").run();
  const reusable = await createHouseholdInvitation(db, owner, { email: 'reuse@example.test' });
  await acceptHouseholdInvitation(db, { provider: 'cloudflare_access', subject: 'existing-subject', email: 'reuse@example.test' }, reusable.id);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users WHERE id='unaffiliated'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memberships WHERE user_id='unaffiliated'").get().n, 1);

  const blocked = await createHouseholdInvitation(db, owner, { email: 'blocked@example.test' });
  sqlite.exec("CREATE TRIGGER reject_blocked_identity BEFORE INSERT ON identities WHEN NEW.subject='blocked-subject' BEGIN SELECT RAISE(ABORT, 'forced identity conflict'); END;");
  await assert.rejects(() => acceptHouseholdInvitation(db, { provider: 'cloudflare_access', subject: 'blocked-subject', email: 'blocked@example.test' }, blocked.id), /forced identity conflict/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users WHERE id NOT IN (SELECT user_id FROM identities)").get().n, 0);
  assert.ok(sqlite.prepare('SELECT id FROM household_invitations WHERE id=?').get(blocked.id));
  sqlite.close();
});

test('an expired invitation can be replaced only in its own household while an active invitation remains a conflict', async () => {
  const { sqlite, db } = tenantDatabase();
  const owner = await resolveTenant(db, { provider: 'cloudflare_access', subject: 'owner', email: 'owner@example.test' }, { INITIAL_OWNER_EMAILS: 'owner@example.test' });
  const expired = await createHouseholdInvitation(db, owner, { email: 'again@example.test' }, () => '2026-01-01T00:00:00.000Z');
  const replacement = await createHouseholdInvitation(db, owner, { email: 'again@example.test' }, () => '2026-01-09T00:00:00.000Z');
  assert.notEqual(replacement.id, expired.id);
  assert.equal(sqlite.prepare('SELECT id FROM household_invitations WHERE id=?').get(expired.id), undefined);
  assert.equal(sqlite.prepare('SELECT id FROM household_invitations WHERE id=?').get(replacement.id).id, replacement.id);
  await assert.rejects(() => createHouseholdInvitation(db, owner, { email: 'again@example.test' }, () => '2026-01-10T00:00:00.000Z'), { status: 409 });
  sqlite.prepare("INSERT INTO households VALUES ('other','Other','now')").run();
  sqlite.prepare("INSERT INTO users VALUES ('other-owner','now')").run();
  sqlite.prepare("INSERT INTO identities VALUES ('cloudflare_access','other-owner','other-owner','other@example.test','now')").run();
  sqlite.prepare("INSERT INTO memberships VALUES ('other','other-owner','owner','now')").run();
  const otherInvite = await createHouseholdInvitation(db, { householdId: 'other', userId: 'other-owner' }, { email: 'again@example.test' }, () => '2026-01-10T00:00:00.000Z');
  assert.equal(otherInvite.id !== replacement.id, true);
  sqlite.close();
});

test('pending discovery is allowlisted, keyset-bounded, and cursor-bound to the verified email', async () => {
  const { sqlite, db } = tenantDatabase();
  const principal = { provider: 'cloudflare_access', subject: 'page-owner', email: 'page-owner@example.test' };
  const owner = await resolveTenant(db, principal, { INITIAL_OWNER_EMAILS: principal.email });
  for (let n = 1; n <= 21; n++) {
    const householdId = `123e4567-e89b-42d3-a456-${String(700 + n).padStart(12, '0')}`;
    sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(householdId, `Shop ${n}`, 'now');
    sqlite.prepare('INSERT INTO household_invitations VALUES (?,?,?,?,?,?,?)').run(`123e4567-e89b-42d3-a456-${String(800 + n).padStart(12, '0')}`, householdId, 'page@example.test', 'member', owner.userId, 'now', `2099-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`);
  }
  const page = await pendingHouseholdInvitations(db, { provider: 'cloudflare_access', subject: 'page', email: 'page@example.test' });
  assert.equal(page.invitations.length, 20); assert.ok(page.nextCursor);
  assert.deepEqual(Object.keys(page.invitations[0]).sort(), ['expires_at', 'household_name', 'id', 'role']);
  assert.deepEqual(Object.keys(page).sort(), ['invitations', 'member', 'nextCursor']);
  assert.equal((await pendingHouseholdInvitations(db, { provider: 'cloudflare_access', subject: 'page', email: 'page@example.test' }, page.nextCursor)).invitations.length, 1);
  await assert.rejects(() => pendingHouseholdInvitations(db, { provider: 'cloudflare_access', subject: 'other', email: 'other@example.test' }, page.nextCursor), { status: 400 });
  await assert.rejects(() => pendingHouseholdInvitations(db, { provider: 'cloudflare_access', subject: 'page', email: 'page@example.test' }, `${page.nextCursor}x`), { status: 400 });
  sqlite.close();
});
