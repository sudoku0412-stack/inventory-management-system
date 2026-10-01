const RESEND_URL = 'https://api.resend.com/emails';
const LEASE_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Statement that queues an invitation notice. Add it to the same D1 batch as the invitation insert. */
export function invitationNoticeStatement(db, { id, householdId, email, role, createdAt }) {
  return db.prepare(`INSERT OR IGNORE INTO notification_outbox
    (id,kind,dedupe_key,recipient_email,household_id,invitation_id,role,next_attempt_at,created_at)
    VALUES (?,'invitation_created',?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), `invitation_created:${id}`, email, householdId, id, role, createdAt, createdAt);
}

/** Queues a deletion notice for every other member (one address per member). Runs after the guarded deletion insert in the same batch. */
export function deletionNoticeStatements(db, { householdId, actorUserId, deletedAt, purgeAfter }) {
  return db.prepare(`INSERT OR IGNORE INTO notification_outbox
    (id,kind,dedupe_key,recipient_email,household_id,deadline,next_attempt_at,created_at)
    SELECT lower(hex(randomblob(16))),'shop_deleted','shop_deleted:'||?1||':'||?2||':'||m.user_id,MIN(i.email),?1,?3,?2,?2
    FROM memberships m JOIN identities i ON i.user_id=m.user_id
    WHERE m.household_id=?1 AND m.user_id!=?4 AND i.email IS NOT NULL AND i.email!=''
      AND NOT EXISTS (SELECT 1 FROM user_email_preferences p WHERE p.user_id=m.user_id AND p.notices_enabled=0)
    GROUP BY m.user_id`).bind(householdId, deletedAt, purgeAfter, actorUserId);
}

/** Queues the new Owner's notice. Runs after the audit insert, which aborts the batch when the transfer did not apply. */
export function transferNoticeStatement(db, { householdId, targetUserId, operationId, createdAt }) {
  return db.prepare(`INSERT OR IGNORE INTO notification_outbox
    (id,kind,dedupe_key,recipient_email,household_id,role,next_attempt_at,created_at)
    SELECT lower(hex(randomblob(16))),'ownership_transferred',?,MIN(email),?,'owner',?,?
    FROM identities WHERE user_id=? AND email IS NOT NULL AND email!=''
      AND NOT EXISTS (SELECT 1 FROM user_email_preferences p WHERE p.user_id=identities.user_id AND p.notices_enabled=0)
    HAVING count(*)>0`).bind(`ownership_transferred:${householdId}:${operationId}:${targetUserId}`, householdId, createdAt, createdAt, targetUserId);
}

/** Delivery needs all three settings; without them the sender stays off and rows wait. */
export function emailConfig(env = {}) {
  const apiKey = String(env.RESEND_API_KEY || '');
  const from = String(env.EMAIL_FROM || '');
  const appUrl = String(env.APP_URL || '').replace(/\/+$/, '');
  return apiKey && from && /^https:\/\//.test(appUrl) ? { apiKey, from, appUrl } : null;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dateOf = value => String(value || '').slice(0, 10);

export function renderNotice(row, appUrl) {
  let subject, text, html;
  if (row.kind === 'invitation_created') {
    const owner = row.role === 'owner';
    const what = owner ? 'an Owner, which lets you manage the Shop\'s members and access' : 'a Member';
    subject = 'You have been invited to a Shop on the Inventory Management System';
    text = `You have been invited to join a Shop on the Inventory Management System as ${what}.\n\nOpen ${appUrl} and sign in with this email address to accept. The invitation expires in 7 days.\n\nIf you did not expect this, ignore this email.\n`;
    html = `<p>You have been invited to join a Shop on the Inventory Management System as ${escapeHtml(what)}.</p><p><a href="${escapeHtml(appUrl)}">Open the Inventory Management System</a> and sign in with this email address to accept. The invitation expires in 7 days.</p><p>If you did not expect this, ignore this email.</p>`;
  } else if (row.kind === 'shop_deleted') {
    const date = dateOf(row.deadline);
    subject = 'A Shop you belong to was deleted';
    text = `An Owner deleted a Shop you belong to on the Inventory Management System.\n\nAn Owner can restore it until ${date}. After that it is removed permanently.\n\nOpen ${appUrl} to continue.\n`;
    html = `<p>An Owner deleted a Shop you belong to on the Inventory Management System.</p><p>An Owner can restore it until ${escapeHtml(date)}. After that it is removed permanently.</p><p><a href="${escapeHtml(appUrl)}">Open the Inventory Management System</a></p>`;
  } else if (row.kind === 'ownership_transferred') {
    subject = 'You are now an Owner of a Shop';
    text = `An Owner transferred ownership of a Shop on the Inventory Management System to you. You can now manage its members and access.\n\nOpen ${appUrl} to review it.\n`;
    html = `<p>An Owner transferred ownership of a Shop on the Inventory Management System to you. You can now manage its members and access.</p><p><a href="${escapeHtml(appUrl)}">Open the Inventory Management System</a> to review it.</p>`;
  } else if (row.kind === 'weekly_digest') {
    const shops = JSON.parse(row.payload || '{"shops":[]}').shops || [];
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const lines = shop => [shop.expired && `${plural(shop.expired, 'pack expired', 'packs expired')}`, shop.expiring && `${plural(shop.expiring, 'pack expires', 'packs expire')} within 30 days`, shop.low && `${plural(shop.low, 'pack is running low', 'packs are running low')}`].filter(Boolean);
    subject = 'Your weekly inventory check';
    const off = 'You get this email on Mondays when something needs attention. To turn it off, open Profile > Email notices and switch off "Weekly summary".';
    text = `Here is your weekly inventory check.\n\n${shops.map(shop => `${shop.name}\n${lines(shop).map(line => `- ${line}`).join('\n')}`).join('\n\n')}\n\nOpen ${appUrl} to review your items.\n\n${off}\n`;
    html = `<p>Here is your weekly inventory check.</p>${shops.map(shop => `<p><strong>${escapeHtml(shop.name)}</strong></p><ul>${lines(shop).map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`).join('')}<p><a href="${escapeHtml(appUrl)}">Open the app</a> to review your items.</p><p>${escapeHtml(off)}</p>`;
  } else throw new Error(`Unknown notice kind: ${row.kind}`);
  return { subject, text, html };
}

// A notice is dropped at send time too, so turning notices off also stops emails that are already queued.
const optedOut = (db, email) => db.prepare(`SELECT 1 FROM identities i JOIN user_email_preferences p ON p.user_id=i.user_id
  WHERE lower(i.email)=lower(?) AND p.notices_enabled=0 LIMIT 1`).bind(email).first();

const digestOptedOut = (db, email) => db.prepare(`SELECT 1 FROM identities i JOIN user_email_preferences p ON p.user_id=i.user_id
  WHERE lower(i.email)=lower(?) AND p.digest_enabled=0 LIMIT 1`).bind(email).first();

async function stillNeeded(db, row, now) {
  if (row.kind === 'weekly_digest') {
    // A digest that missed its week is out of date, and opting out also stops one that is already queued.
    if (Date.parse(now) - Date.parse(row.created_at) > 2 * 24 * 60 * 60 * 1000) return false;
    return !(await digestOptedOut(db, row.recipient_email));
  }
  if (row.kind !== 'invitation_created' && await optedOut(db, row.recipient_email)) return false;
  if (row.kind === 'invitation_created') {
    return Boolean(await db.prepare(`SELECT 1 FROM household_invitations i WHERE i.id=? AND i.email=? AND (i.expires_at IS NULL OR i.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM household_deletions d WHERE d.household_id=i.household_id)`).bind(row.invitation_id, row.recipient_email, now).first());
  }
  if (row.kind === 'shop_deleted') {
    // A restore removes the deletion row, so an undone or purged deletion is not announced.
    return Boolean(await db.prepare('SELECT 1 FROM household_deletions WHERE household_id=? AND purged_at IS NULL AND purge_after > ?').bind(row.household_id, now).first());
  }
  if (row.kind === 'ownership_transferred') {
    return Boolean(await db.prepare('SELECT 1 FROM households h WHERE h.id=? AND NOT EXISTS (SELECT 1 FROM household_deletions d WHERE d.household_id=h.id)').bind(row.household_id).first());
  }
  return false;
}

const finish = (db, id, status, error, sentAt = null) =>
  db.prepare('UPDATE notification_outbox SET status=?, last_error=?, sent_at=?, lease_until=NULL WHERE id=?').bind(status, error, sentAt, id).run();

/** Leases due rows, sends them through Resend and records the outcome. Returns counts per outcome. */
export async function dispatchOutbox(env, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const config = emailConfig(env);
  const counts = {};
  if (!config) return counts;
  const db = env.DB;
  const stamp = now().toISOString();
  const { results = [] } = await db.prepare(`SELECT * FROM notification_outbox
    WHERE (status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<?)
    ORDER BY next_attempt_at LIMIT ?`).bind(stamp, stamp, BATCH_SIZE).all();
  for (const row of results) {
    const leaseUntil = new Date(now().getTime() + LEASE_MS).toISOString();
    const lease = await db.prepare(`UPDATE notification_outbox SET status='sending', lease_until=?, attempts=attempts+1
      WHERE id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<?))`).bind(leaseUntil, row.id, stamp, stamp).run();
    if (Number(lease?.meta?.changes ?? 0) !== 1) continue;
    const attempts = row.attempts + 1;
    let outcome;
    try {
      if (!await stillNeeded(db, row, stamp)) { await finish(db, row.id, 'cancelled', null); outcome = 'cancelled'; }
      else {
        const { subject, text, html } = renderNotice(row, config.appUrl);
        const response = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'idempotency-key': row.dedupe_key },
          body: JSON.stringify({ from: config.from, to: [row.recipient_email], subject, text, html })
        });
        if (response.ok) { await finish(db, row.id, 'sent', null, now().toISOString()); outcome = 'sent'; }
        else if (response.status === 429 || response.status >= 500 || response.status === 409) throw Object.assign(new Error(`HTTP ${response.status}`), { retry: true });
        else { await finish(db, row.id, 'failed', `HTTP ${response.status}`); outcome = 'failed'; }
      }
    } catch (error) {
      const age = now().getTime() - new Date(row.created_at).getTime();
      if (row.attempts > 0 && age >= RETRY_WINDOW_MS) { await finish(db, row.id, 'uncertain', String(error?.message || error).slice(0, 200)); outcome = 'uncertain'; }
      else {
        const delay = Math.min(15 * 60 * 1000 * 2 ** (attempts - 1), 4 * 60 * 60 * 1000);
        await db.prepare("UPDATE notification_outbox SET status='pending', lease_until=NULL, last_error=?, next_attempt_at=? WHERE id=?")
          .bind(String(error?.message || error).slice(0, 200), new Date(now().getTime() + delay).toISOString(), row.id).run();
        outcome = 'retry';
      }
    }
    counts[outcome] = (counts[outcome] || 0) + 1;
  }
  return counts;
}

/** Removes finished and never-attempted rows after 30 days (invitations expire in 7). Failed and uncertain rows stay until someone reviews them. */
export async function pruneOutbox(db, now = () => new Date()) {
  const cutoff = new Date(now().getTime() - PRUNE_AFTER_MS).toISOString();
  await db.prepare("DELETE FROM notification_outbox WHERE (status IN ('sent','cancelled') OR (status='pending' AND attempts=0)) AND created_at < ?").bind(cutoff).run();
}
