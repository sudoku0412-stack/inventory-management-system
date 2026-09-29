const failure = (message, status) => Object.assign(new Error(message), { status });

async function userOf(db, principal) {
  if (!principal?.provider || !principal?.subject) throw failure('Sign in to change email settings.', 403);
  const row = await db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?').bind(principal.provider, principal.subject).first();
  if (!row) throw failure('Sign in to change email settings.', 403);
  return row.user_id;
}

const unavailable = error => { if (/no such table/i.test(String(error?.message || ''))) throw failure('Email settings are temporarily unavailable.', 503); throw error; };

/** Whether this account gets Shop deletion and ownership-transfer emails. Default on. */
export async function getEmailPreferences(db, principal) {
  const userId = await userOf(db, principal);
  try {
    const row = await db.prepare('SELECT notices_enabled FROM user_email_preferences WHERE user_id=?').bind(userId).first();
    return { noticesEnabled: row ? Boolean(row.notices_enabled) : true };
  } catch (error) { return unavailable(error); }
}

export function validateEmailPreferences(data) {
  if (!data || typeof data !== 'object' || Object.keys(data).join(',') !== 'noticesEnabled' || typeof data.noticesEnabled !== 'boolean') throw failure('Unexpected email setting.', 400);
  return data.noticesEnabled;
}

export async function setEmailPreferences(db, principal, data, now = () => new Date().toISOString()) {
  const noticesEnabled = validateEmailPreferences(data);
  const userId = await userOf(db, principal);
  try {
    await db.prepare(`INSERT INTO user_email_preferences (user_id,notices_enabled,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET notices_enabled=excluded.notices_enabled, updated_at=excluded.updated_at`).bind(userId, noticesEnabled ? 1 : 0, now()).run();
  } catch (error) { unavailable(error); }
  return { noticesEnabled };
}
