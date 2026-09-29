import { randomUUID } from 'node:crypto';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Normalize only the address used for an invitation lookup/storage. */
export function normalizeInvitationEmail(value) {
  const email = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw failure('Enter a valid email address.');
  }
  return email;
}

async function ownerHousehold(db, tenant) {
  if (!tenant?.householdId || !tenant?.userId) throw failure('A shop membership is required.', 403);
  const membership = await db.prepare("SELECT role FROM memberships WHERE household_id=? AND user_id=?").bind(tenant.householdId, tenant.userId).first();
  if (membership?.role !== 'owner') throw failure('Only a shop owner can manage access.', 403);
  return tenant.householdId;
}

export async function listHouseholdAccess(db, tenant) {
  const householdId = await ownerHousehold(db, tenant);
  const members = await db.prepare(`SELECT m.user_id, m.role, MIN(LOWER(i.email)) AS email
    FROM memberships m JOIN identities i ON i.user_id=m.user_id
    WHERE m.household_id=? GROUP BY m.user_id,m.role ORDER BY m.role='owner' DESC, email`).bind(householdId).all();
  const invitations = await db.prepare("SELECT id,email,role,created_at,expires_at FROM household_invitations WHERE household_id=? AND expires_at IS NOT NULL AND expires_at > ? ORDER BY created_at DESC, email").bind(householdId, new Date().toISOString()).all();
  return {
    members: (members.results || []).map(member => ({ user_id: member.user_id, email: member.email, role: member.role, is_you: member.user_id === tenant.userId })),
    invitations: invitations.results || []
  };
}

export function validateOwnerPromotion(targetId, data = {}) {
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== 'operationId') throw failure('Unexpected owner promotion field.');
  if (typeof data.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.operationId)) throw failure('Enter a valid operation id.');
  promotionTarget(targetId);
  return data.operationId;
}

function promotionTarget(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure('Member not found.', 404);
  return value;
}

/**
 * Promote an already accepted member in an explicitly pinned Shop.  This
 * deliberately takes a read-only tenant context; it must never write a Shop
 * preference like resolveTenant does.
 */
export async function promoteHouseholdMember(db, principal, tenant, targetId, data, requestId = randomUUID(), now = () => new Date().toISOString()) {
  const operationId = validateOwnerPromotion(targetId, data);
  if (!principal?.provider || !principal?.subject || !tenant?.householdId || !tenant?.userId) throw failure('Only a shop owner can manage access.', 403);
  const actor = await db.prepare(`SELECT i.user_id,m.role FROM identities i JOIN memberships m ON m.user_id=i.user_id
    WHERE i.provider=? AND i.subject=? AND i.user_id=? AND m.household_id=? LIMIT 1`).bind(principal.provider, principal.subject, tenant.userId, tenant.householdId).first();
  if (actor?.role !== 'owner') throw failure('Only a shop owner can manage access.', 403);
  let receipt;
  try {
    await db.prepare('SELECT id FROM access_audit LIMIT 1').first();
    receipt = await db.prepare('SELECT target_user_id FROM shop_owner_promotion_receipts WHERE household_id=? AND actor_user_id=? AND operation_id=?').bind(tenant.householdId, tenant.userId, operationId).first();
  }
  catch (error) { if (/no such table|shop_owner_promotion_receipts/i.test(String(error?.message || ''))) throw failure('Owner promotion is temporarily unavailable.', 503); throw error; }
  if (receipt) {
    if (receipt.target_user_id !== targetId) throw failure('This operation id was already used for a different member.', 409);
    const owner = await db.prepare("SELECT 1 FROM memberships WHERE household_id=? AND user_id=? AND role='owner'").bind(tenant.householdId, targetId).first();
    if (!owner) throw failure('Member not found.', 404);
    return { member: { user_id: targetId, role: 'owner' }, changed: false };
  }
  const existing = await db.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').bind(tenant.householdId, targetId).first();
  if (!existing) throw failure('Member not found.', 404);
  if (existing.role === 'owner') return { member: { user_id: targetId, role: 'owner' }, changed: false };
  const stamp = now();
  let batchFailure;
  try {
    const result = await db.batch([
      db.prepare(`INSERT INTO shop_owner_promotion_receipts (household_id,actor_user_id,operation_id,target_user_id,created_at)
        VALUES (?,?,?,?,?)`).bind(tenant.householdId, tenant.userId, operationId, targetId, stamp),
      db.prepare(`UPDATE memberships SET role='owner' WHERE household_id=? AND user_id=? AND role='member'
        AND EXISTS (SELECT 1 FROM shop_owner_promotion_receipts WHERE household_id=? AND actor_user_id=? AND operation_id=? AND target_user_id=?)
        AND EXISTS (SELECT 1 FROM identities WHERE provider=? AND subject=? AND user_id=?)
        AND EXISTS (SELECT 1 FROM memberships WHERE household_id=? AND user_id=? AND role='owner')
        AND (SELECT count(*) FROM memberships WHERE user_id=? AND role='owner') < 5`).bind(tenant.householdId, targetId, tenant.householdId, tenant.userId, operationId, targetId, principal.provider, principal.subject, tenant.userId, tenant.householdId, tenant.userId, targetId),
      // A zero-row guarded transition MUST abort the entire batch. The audit's
      // NOT NULL constraint is a transaction guard, not a post-commit check.
      db.prepare(`INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
        VALUES (?,'member_promoted',?,?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)`).bind(randomUUID(), tenant.householdId, tenant.userId, `user:${targetId}`, stamp, requestId)
    ]);
    if (result[1]?.meta?.changes) return { member: { user_id: targetId, role: 'owner' }, changed: true };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) throw failure('Owner promotion is temporarily unavailable.', 503);
    if (!/unique|constraint|eligible|primary key/i.test(String(error?.message || ''))) throw error;
    batchFailure = error;
  }
  const authorized = await db.prepare(`SELECT 1 FROM identities i JOIN memberships m ON m.user_id=i.user_id
    WHERE i.provider=? AND i.subject=? AND i.user_id=? AND m.household_id=? AND m.role='owner'`).bind(principal.provider, principal.subject, tenant.userId, tenant.householdId).first();
  if (!authorized) throw failure('Only a shop owner can manage access.', 403);
  const replay = await db.prepare('SELECT target_user_id FROM shop_owner_promotion_receipts WHERE household_id=? AND actor_user_id=? AND operation_id=?').bind(tenant.householdId, tenant.userId, operationId).first();
  if (replay) {
    if (replay.target_user_id !== targetId) throw failure('This operation id was already used for a different member.', 409);
    const owner = await db.prepare("SELECT 1 FROM memberships WHERE household_id=? AND user_id=? AND role='owner'").bind(tenant.householdId, targetId).first();
    if (owner) return { member: { user_id: targetId, role: 'owner' }, changed: false };
  }
  const current = await db.prepare('SELECT role FROM memberships WHERE household_id=? AND user_id=?').bind(tenant.householdId, targetId).first();
  if (!current) throw failure('Member not found.', 404);
  if (current.role === 'owner') return { member: { user_id: targetId, role: 'owner' }, changed: false };
  const owned = await db.prepare("SELECT count(*) AS count FROM memberships WHERE user_id=? AND role='owner'").bind(targetId).first();
  if (Number(owned?.count) >= 5) throw failure('This member already owns 5 Shops.', 409);
  // Only observed authorization/cap/race outcomes are definitive. Unexpected
  // database constraints remain retryable server failures after full rollback.
  if (batchFailure) throw batchFailure;
  throw failure('This change can’t be completed right now.', 409);
}

export async function createHouseholdInvitation(db, tenant, data, now = () => new Date().toISOString(), requestId = randomUUID()) {
  const householdId = await ownerHousehold(db, tenant);
  const email = normalizeInvitationEmail(data?.email);
  const member = await db.prepare(`SELECT 1 FROM memberships m JOIN identities i ON i.user_id=m.user_id
    WHERE m.household_id=? AND LOWER(i.email)=? LIMIT 1`).bind(householdId, email).first();
  if (member) throw failure('This email already belongs to a shop member.', 409);
  const created_at = now();
  const expires_at = new Date(new Date(created_at).getTime() + INVITATION_LIFETIME_MS).toISOString();
  const invitation = { id: randomUUID(), email, role: 'member', created_at, expires_at };
  const existing = await db.prepare('SELECT id,expires_at FROM household_invitations WHERE household_id=? AND email=?').bind(householdId, email).first();
  if (existing && (!existing.expires_at || existing.expires_at > created_at)) throw failure('An invitation is already pending for this email.', 409);
  try {
    // Replacement is one D1 transaction. The DELETE is narrowly scoped to the
    // expired row observed for this household/email; a concurrent active invite
    // wins through the table's unique constraint and is reported as a 409.
    await db.batch([
      db.prepare('DELETE FROM household_invitations WHERE id=? AND household_id=? AND email=? AND expires_at IS NOT NULL AND expires_at <= ?')
        .bind(existing?.id || '', householdId, email, created_at),
      db.prepare("INSERT INTO household_invitations (id,household_id,email,role,created_by_user_id,created_at,expires_at) VALUES (?,? ,?,'member',?,?,?)")
        .bind(invitation.id, householdId, email, tenant.userId, invitation.created_at, invitation.expires_at),
      db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) VALUES (?,'invite_created',?,?,?,?,?)")
        .bind(randomUUID(), householdId, tenant.userId, email, invitation.created_at, requestId)
    ]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw failure('An invitation is already pending for this email.', 409);
    throw error;
  }
  return invitation;
}

function invitationId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure('Invitation not found.', 404);
  return value;
}

function principalEmail(principal) {
  try { return normalizeInvitationEmail(principal?.email); } catch { throw failure('Invitation not found.', 404); }
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(bytes).toString('base64url');
}

function throttleFailure(error) {
  if (error?.status === 429) return error;
  return failure('Invitation access is temporarily unavailable.', 503);
}

/** A durable rolling-minute principal plus Cloudflare-IP backstop limiter. */
export async function throttleInvitationRoute(db, principal, request, route, now = () => new Date()) {
  if (!principal?.provider || !principal?.subject) throw failure('Invitation not found.', 404);
  const stamp = now(); const iso = stamp.toISOString(); const expiry = new Date(stamp.getTime() + 60_000).toISOString();
  const limit = { pending: 30, accept: 10, changes: 60 }[route];
  const keys = [await sha256(`${principal.provider}:${principal.subject}`)];
  const ip = route === 'changes' ? null : request?.headers?.get('cf-connecting-ip');
  if (ip) keys.push(await sha256(`ip:${ip}`));
  try {
    for (const key of keys) {
      const result = await db.batch([
        db.prepare('DELETE FROM household_invitation_route_throttle_events WHERE expires_at <= ?').bind(iso),
        db.prepare(`INSERT INTO household_invitation_route_throttle_events (id,principal_hash,route,created_at,expires_at)
          SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM household_invitation_route_throttle_events WHERE principal_hash=? AND route=? AND created_at > ?) < ?`)
          .bind(randomUUID(), key, route, iso, expiry, key, route, new Date(stamp.getTime() - 60_000).toISOString(), limit)
      ]);
      if (!batchChanges(result, 1)) {
        const oldest = await db.prepare('SELECT created_at FROM household_invitation_route_throttle_events WHERE principal_hash=? AND route=? ORDER BY created_at ASC LIMIT 1').bind(key, route).first();
        const retryAfter = Math.max(1, Math.ceil((Date.parse(oldest?.created_at || iso) + 60_000 - stamp.getTime()) / 1000));
        throw Object.assign(failure(route === 'changes' ? 'Too many update checks. Try again shortly.' : 'Too many invitation requests. Try again later.', 429), { retryAfter });
      }
    }
  } catch (error) { throw throttleFailure(error); }
}

async function cursorFor(email, row) {
  return Buffer.from(JSON.stringify({ e: await sha256(email), x: row.expires_at, i: row.id })).toString('base64url');
}

async function parseCursor(email, cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw failure('Invalid invitation cursor.');
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    // This is an untrusted continuation hint, NOT an authorization token or MAC.
    // The email hash detects accidental cross-account reuse; the query below
    // always independently enforces verified email, expiry and the row bound.
    if (!value || Object.keys(value).sort().join(',') !== 'e,i,x' || value.e !== await sha256(email)
      || typeof value.x !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.x)
      || new Date(value.x).toISOString() !== value.x) throw new Error();
    invitationId(value.i);
    return value;
  } catch { throw failure('Invalid invitation cursor.'); }
}

/** Returns only invitations addressed to the verified Access email. */
export async function pendingHouseholdInvitations(db, principal, cursor = null, now = () => new Date().toISOString()) {
  // Kept solely for direct server-call compatibility with the old
  // (db, principal, now) helper signature.
  if (typeof cursor === 'function') { now = cursor; cursor = null; }
  const email = principalEmail(principal);
  const after = await parseCursor(email, cursor);
  const rows = await db.prepare(`SELECT i.id, i.household_id, h.name AS household_name, i.role, i.expires_at
    FROM household_invitations i JOIN households h ON h.id=i.household_id
    WHERE i.email=? AND i.role='member' AND i.expires_at IS NOT NULL AND i.expires_at > ?
      AND (? IS NULL OR i.expires_at > ? OR (i.expires_at=? AND i.id>?))
    ORDER BY i.expires_at ASC, i.id ASC LIMIT 21`).bind(email, now(), after?.x || null, after?.x || '', after?.x || '', after?.i || '').all();
  // The UI needs only a boolean to avoid ever hiding the normal app from an
  // already enrolled identity that happens to have an unrelated invitation.
  const membership = principal?.provider && principal?.subject
    ? await db.prepare(`SELECT 1 FROM identities i JOIN memberships m ON m.user_id=i.user_id
      WHERE i.provider=? AND i.subject=? LIMIT 1`).bind(principal.provider, principal.subject).first()
    : undefined;
  const visible = (rows.results || []).slice(0, 20);
  const invitations = visible.map(row => ({ id: row.id, household_name: row.household_name, role: 'member', expires_at: row.expires_at }));
  return { invitations, nextCursor: (rows.results || []).length > 20 ? await cursorFor(email, visible.at(-1)) : null, member: Boolean(membership) };
}

function batchChanges(result, index) {
  return Number(result?.[index]?.meta?.changes || 0);
}

function expectedAcceptanceRace(error) {
  return /NOT NULL constraint failed: access_audit\.household_id\b|UNIQUE constraint failed: (?:memberships\.household_id, memberships\.user_id|identities\.provider, identities\.subject|household_invitation_acceptance_receipts\.invitation_id, household_invitation_acceptance_receipts\.user_id)\b/i.test(String(error?.message || ''));
}

async function resolveAcceptanceOutcome(db, principal, email, invitationId, stamp, originalError) {
  const identity = await db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?').bind(principal.provider, principal.subject).first();
  const receipt = identity && await db.prepare(`SELECT r.household_id,r.invitation_email FROM household_invitation_acceptance_receipts r
    WHERE r.invitation_id=? AND r.user_id=?`).bind(invitationId, identity.user_id).first();
  if (receipt?.invitation_email === email) {
    const membership = await db.prepare("SELECT 1 FROM memberships WHERE household_id=? AND user_id=? AND role='member'").bind(receipt.household_id, identity.user_id).first();
    if (membership) return { householdId: receipt.household_id, role: 'member', accepted: false };
    throw failure('Invitation not found or is no longer available.', 404);
  }
  const invitation = await db.prepare('SELECT household_id FROM household_invitations WHERE id=? AND email=? AND role=\'member\' AND expires_at>?').bind(invitationId, email, stamp).first();
  if (!invitation) throw failure('Invitation not found or is no longer available.', 404);
  if (!identity) throw originalError || failure('Invitation not found or is no longer available.', 404);
  const target = await db.prepare('SELECT 1 FROM memberships WHERE household_id=? AND user_id=?').bind(invitation.household_id, identity.user_id).first();
  if (target) throw failure('This account already belongs to this Shop.', 409);
  const count = await db.prepare('SELECT count(*) AS count FROM memberships WHERE user_id=?').bind(identity.user_id).first();
  if (Number(count?.count) >= 50) throw failure('You can belong to up to 50 Shops.', 409);
  // The invitation is still eligible: this was not an observed race outcome.
  // Preserve unexpected/forced DB failures rather than disguise them as 404.
  throw originalError || failure('Invitation acceptance could not complete. Try again.', 503);
}

function acceptanceAudit(db, userId, id, principal, stamp, requestId) {
  // Scalar SELECT forces a recognizable NOT NULL failure on a zero-row
  // predecessor, including new-identity losers, and rolls the whole batch back.
  return db.prepare(`INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id)
    VALUES (?,'invite_accepted',(SELECT household_id FROM household_invitation_acceptance_receipts
      WHERE invitation_id=? AND user_id=? AND changes()=1),?,?,?,?)`)
    .bind(randomUUID(), id, userId, userId, `${principal.provider}:${principal.subject}`, stamp, requestId);
}

function acceptanceAuditGuard(db, userId, id) {
  // A suppressed audit INSERT must also abort, never leave an unaudited join.
  return db.prepare(`UPDATE household_invitation_acceptance_receipts
    SET accepted_at=CASE WHEN changes()=1 THEN accepted_at ELSE NULL END
    WHERE invitation_id=? AND user_id=?`).bind(id, userId);
}

/**
 * Atomically consumes a specific, unexpired invitation for the verified
 * provider/subject/email. Each INSERT is guarded by the same invitation
 * predicate and the last statement consumes it only after the membership is
 * present. D1 batch statements are one transaction: a uniqueness race rolls
 * back all prior statements, so no orphan user or identity survives.
 */
export async function acceptHouseholdInvitation(db, principal, id, now = () => new Date().toISOString(), requestId = randomUUID()) {
  invitationId(id);
  const email = principalEmail(principal);
  const stamp = now();
  if (!principal?.provider || !principal?.subject) throw failure('Invitation not found.', 404);
  const identity = await db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?')
    .bind(principal.provider, principal.subject).first();
  // Probe both required durable tables before either existing- or new-account
  // mutation paths so a partially applied migration fails closed consistently.
  try {
    await db.prepare('SELECT invitation_id FROM household_invitation_acceptance_receipts LIMIT 1').first();
    await db.prepare('SELECT id FROM access_audit LIMIT 1').first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) throw failure('Invitation acceptance is temporarily unavailable.', 503);
    throw error;
  }

  if (identity) {
    let receipt;
    try { receipt = await db.prepare('SELECT household_id,invitation_email FROM household_invitation_acceptance_receipts WHERE invitation_id=? AND user_id=?').bind(id, identity.user_id).first(); }
    catch (error) { if (/no such table/i.test(String(error?.message || ''))) throw failure('Invitation acceptance is temporarily unavailable.', 503); throw error; }
    if (receipt) {
      if (receipt.invitation_email !== email) throw failure('Invitation not found or is no longer available.', 404);
      const member = await db.prepare("SELECT 1 FROM memberships WHERE household_id=? AND user_id=? AND role='member'").bind(receipt.household_id, identity.user_id).first();
      if (!member) throw failure('Invitation not found or is no longer available.', 404);
      return { householdId: receipt.household_id, role: 'member', accepted: false };
    }
    const existingTarget = await db.prepare("SELECT 1 FROM memberships m JOIN household_invitations i ON i.household_id=m.household_id WHERE m.user_id=? AND i.id=? AND i.email=? AND i.role='member' AND i.expires_at>?").bind(identity.user_id, id, email, stamp).first();
    if (existingTarget) throw failure('This account already belongs to this Shop.', 409);
    let result;
    try { result = await db.batch([
      db.prepare(`INSERT INTO memberships (household_id,user_id,role,created_at)
        SELECT household_id, ?, 'member', ? FROM household_invitations
        WHERE id=? AND email=? AND role='member' AND expires_at IS NOT NULL AND expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=household_invitations.household_id AND user_id=?)
          AND (SELECT count(*) FROM memberships WHERE user_id=?) < 50
          AND EXISTS (SELECT 1 FROM identities WHERE provider=? AND subject=? AND user_id=?)`).bind(identity.user_id, stamp, id, email, stamp, identity.user_id, identity.user_id, principal.provider, principal.subject, identity.user_id),
      db.prepare(`INSERT INTO household_invitation_acceptance_receipts (invitation_id,user_id,household_id,invitation_email,accepted_at)
        SELECT ?,?,household_id,?,? FROM household_invitations WHERE id=? AND changes()=1`).bind(id, identity.user_id, email, stamp, id),
      db.prepare(`DELETE FROM household_invitations
        WHERE id=? AND email=? AND expires_at IS NOT NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM household_invitation_acceptance_receipts r WHERE r.invitation_id=id AND r.user_id=?)`).bind(id, email, stamp, identity.user_id),
      acceptanceAudit(db, identity.user_id, id, principal, stamp, requestId),
      acceptanceAuditGuard(db, identity.user_id, id)
    ]); } catch (error) {
      if (!expectedAcceptanceRace(error)) throw error;
      return resolveAcceptanceOutcome(db, principal, email, id, stamp, error);
    }
    if (batchChanges(result, 2)) return { householdId: (await db.prepare('SELECT household_id FROM household_invitation_acceptance_receipts WHERE invitation_id=? AND user_id=?').bind(id, identity.user_id).first()).household_id, role: 'member', accepted: true };
  } else {
    const userId = randomUUID();
    let result;
    try { result = await db.batch([
      db.prepare(`INSERT INTO users (id,created_at)
        SELECT ?, ? WHERE EXISTS (SELECT 1 FROM household_invitations WHERE id=? AND email=? AND role='member' AND expires_at IS NOT NULL AND expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM identities WHERE provider=? AND subject=?)`)
        .bind(userId, stamp, id, email, stamp, principal.provider, principal.subject),
      db.prepare(`INSERT INTO identities (provider,subject,user_id,email,created_at)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id=?)
          AND NOT EXISTS (SELECT 1 FROM identities WHERE provider=? AND subject=?)`)
        .bind(principal.provider, principal.subject, userId, email, stamp, userId, principal.provider, principal.subject),
      db.prepare(`INSERT INTO memberships (household_id,user_id,role,created_at)
        SELECT household_id, ?, 'member', ? FROM household_invitations
        WHERE id=? AND email=? AND role='member' AND expires_at IS NOT NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM identities WHERE provider=? AND subject=? AND user_id=?)
          AND NOT EXISTS (SELECT 1 FROM memberships WHERE household_id=household_invitations.household_id AND user_id=?)
          AND (SELECT count(*) FROM memberships WHERE user_id=?) < 50`)
        .bind(userId, stamp, id, email, stamp, principal.provider, principal.subject, userId, userId, userId),
      db.prepare(`INSERT INTO household_invitation_acceptance_receipts (invitation_id,user_id,household_id,invitation_email,accepted_at)
        SELECT ?,?,household_id,?,? FROM household_invitations WHERE id=? AND changes()=1`).bind(id, userId, email, stamp, id),
      db.prepare(`DELETE FROM household_invitations
        WHERE id=? AND email=? AND expires_at IS NOT NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM household_invitation_acceptance_receipts r WHERE r.invitation_id=id AND r.user_id=?)`).bind(id, email, stamp, userId),
      acceptanceAudit(db, userId, id, principal, stamp, requestId),
      acceptanceAuditGuard(db, userId, id)
    ]); } catch (error) {
      if (!expectedAcceptanceRace(error)) throw error;
      return resolveAcceptanceOutcome(db, principal, email, id, stamp, error);
    }
    if (batchChanges(result, 4)) return { householdId: (await db.prepare('SELECT household_id FROM household_invitation_acceptance_receipts WHERE invitation_id=? AND user_id=?').bind(id, userId).first()).household_id, role: 'member', accepted: true };
  }

  // A competing transaction may have attached this identity while ours was
  // serialized. It is a conflict, never an implicit cross-household join.
  return resolveAcceptanceOutcome(db, principal, email, id, stamp);
}

export async function revokeHouseholdInvitation(db, tenant, invitationId, requestId = randomUUID(), now = () => new Date().toISOString()) {
  const householdId = await ownerHousehold(db, tenant);
  invitationId = invitationId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId) ? invitationId : null;
  if (!invitationId) throw failure('Invitation not found.', 404);
  const invitation = await db.prepare('SELECT email FROM household_invitations WHERE id=? AND household_id=?').bind(invitationId, householdId).first();
  if (!invitation) throw failure('Invitation not found.', 404);
  const result = await db.batch([
    db.prepare('DELETE FROM household_invitations WHERE id=? AND household_id=?').bind(invitationId, householdId),
    db.prepare("INSERT INTO access_audit (id,event,household_id,actor_user_id,target_identifier,created_at,request_id) SELECT ?,'invite_revoked',?,?,?,?,? WHERE changes()=1")
      .bind(randomUUID(), householdId, tenant.userId, invitation.email, now(), requestId)
  ]);
  if (!batchChanges(result, 0)) throw failure('Invitation not found.', 404);
}
