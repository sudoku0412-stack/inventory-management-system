const failure = (message, status) => Object.assign(new Error(message), { status });

async function userOf(db, principal) {
  if (!principal?.provider || !principal?.subject) throw failure('Sign in to change email settings.', 403);
  const row = await db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?').bind(principal.provider, principal.subject).first();
  if (!row) throw failure('Sign in to change email settings.', 403);
  return row.user_id;
}

const unavailable = error => { if (/no such (?:table|column)/i.test(String(error?.message || ''))) throw failure('Email settings are temporarily unavailable.', 503); throw error; };

/** Whether this account gets Shop deletion and ownership-transfer emails. Default on. */
export async function getEmailPreferences(db, principal) {
  const userId = await userOf(db, principal);
  try {
    const row = await db.prepare('SELECT notices_enabled, digest_enabled FROM user_email_preferences WHERE user_id=?').bind(userId).first();
    return { noticesEnabled: row ? Boolean(row.notices_enabled) : true, digestEnabled: row ? Boolean(row.digest_enabled) : true };
  } catch (error) { return unavailable(error); }
}

const KEYS = ['noticesEnabled', 'digestEnabled'];
export function validateEmailPreferences(data) {
  const keys = data && typeof data === 'object' ? Object.keys(data) : [];
  if (!keys.length || keys.some(key => !KEYS.includes(key) || typeof data[key] !== 'boolean')) throw failure('Unexpected email setting.', 400);
  return data;
}

export async function setEmailPreferences(db, principal, data, now = () => new Date().toISOString()) {
  const changes = validateEmailPreferences(data);
  const userId = await userOf(db, principal);
  const next = { ...(await getEmailPreferences(db, principal)), ...changes };
  try {
    await db.prepare(`INSERT INTO user_email_preferences (user_id,notices_enabled,digest_enabled,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET notices_enabled=excluded.notices_enabled, digest_enabled=excluded.digest_enabled, updated_at=excluded.updated_at`).bind(userId, next.noticesEnabled ? 1 : 0, next.digestEnabled ? 1 : 0, now()).run();
  } catch (error) { unavailable(error); }
  return next;
}
