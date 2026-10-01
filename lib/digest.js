// Weekly inventory check email: counts of packs that are expired, expiring within 30 days, or low, per Shop, one email per person.
// Queued by the 15-minute cron on Monday 14:00-16:00 UTC; a per-person, per-week key means repeats in the window add nothing.
const DAY = 24 * 60 * 60 * 1000;
const MAX_SHOPS = 20;

export const inDigestWindow = now => now.getUTCDay() === 1 && now.getUTCHours() >= 14 && now.getUTCHours() < 16;
const isoDay = date => date.toISOString().slice(0, 10);

/** Counts per Shop id: { expired, expiring, low } over active (not discarded) packs with an expiry date. */
async function shopCounts(db, today, soon) {
  const { results } = await db.prepare(`SELECT b.household_id AS id,
      SUM(b.expiry_date < ?1) AS expired,
      SUM(b.expiry_date >= ?1 AND b.expiry_date <= ?2) AS expiring,
      SUM(b.expiry_date > ?2 AND b.quantity <= b.low_stock_threshold) AS low
    FROM batches b
    WHERE b.discarded_at IS NULL AND b.expiry_date IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM household_deletions d WHERE d.household_id=b.household_id)
    GROUP BY b.household_id`).bind(today, soon).all();
  return new Map((results || []).map(row => [row.id, { expired: Number(row.expired) || 0, expiring: Number(row.expiring) || 0, low: Number(row.low) || 0 }]));
}

/** Queues this week's digests. Returns how many rows it tried to add (already-queued ones are ignored). */
export async function enqueueWeeklyDigests(db, now = new Date()) {
  if (!inDigestWindow(now)) return 0;
  const today = isoDay(now), soon = isoDay(new Date(now.getTime() + 30 * DAY));
  const counts = await shopCounts(db, today, soon);
  if (![...counts.values()].some(c => c.expired || c.expiring || c.low)) return 0;
  const { results } = await db.prepare(`SELECT m.user_id, m.household_id, h.name AS shop_name, MIN(i.email) AS email
    FROM active_memberships m JOIN households h ON h.id=m.household_id JOIN identities i ON i.user_id=m.user_id
    WHERE i.email IS NOT NULL AND i.email!=''
      AND NOT EXISTS (SELECT 1 FROM user_email_preferences p WHERE p.user_id=m.user_id AND p.digest_enabled=0)
    GROUP BY m.user_id, m.household_id ORDER BY m.user_id, lower(h.name)`).all();
  const people = new Map();
  for (const row of results || []) {
    const c = counts.get(row.household_id);
    if (!c || !(c.expired || c.expiring || c.low)) continue;
    if (!people.has(row.user_id)) people.set(row.user_id, { email: row.email, shops: [] });
    const person = people.get(row.user_id);
    if (row.email < person.email) person.email = row.email;
    if (person.shops.length < MAX_SHOPS) person.shops.push({ name: String(row.shop_name || '').slice(0, 80), ...c });
  }
  const stamp = now.toISOString(), week = today;
  const statements = [...people].map(([userId, person]) => db.prepare(`INSERT OR IGNORE INTO notification_outbox
    (id,kind,dedupe_key,recipient_email,household_id,payload,next_attempt_at,created_at) VALUES (?,'weekly_digest',?,?,'',?,?,?)`)
    .bind(crypto.randomUUID(), `weekly_digest:${userId}:${week}`, person.email, JSON.stringify({ shops: person.shops }), stamp, stamp));
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return statements.length;
}
