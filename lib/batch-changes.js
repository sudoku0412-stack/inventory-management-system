import { publicBatch, todayISO } from './shared.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_CHANGE_LIMIT = 100;
export const MAX_CHANGE_LIMIT = 200;

const failure = (message, status) => Object.assign(new Error(message), { status });
const schemaUnavailable = error => (error?.status ? error : failure('Inventory changes are temporarily unavailable.', 503));

/** Strict query parsing. `after` is optional: omitting it asks for a starting cursor. */
export function parseChangeQuery(params) {
  const rawAfter = params.get('after');
  const rawLimit = params.get('limit');
  if (rawAfter !== null && !/^\d{1,15}$/.test(rawAfter)) throw failure('Invalid change cursor.', 400);
  if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) throw failure('Invalid change limit.', 400);
  const limit = rawLimit === null ? DEFAULT_CHANGE_LIMIT : Number(rawLimit);
  if (limit < 1 || limit > MAX_CHANGE_LIMIT) throw failure('Invalid change limit.', 400);
  return { after: rawAfter === null ? null : Number(rawAfter), limit };
}

async function floorSeq(db) {
  const row = await db.prepare('SELECT seq FROM batch_change_floor WHERE id=1').first();
  return Number(row?.seq ?? 0);
}

/**
 * Highest sequence a client may safely start from: this Shop's newest change,
 * or the pruning floor if nothing newer survives. Read it BEFORE the list.
 */
export async function currentChangeCursor(db, householdId) {
  try {
    const row = await db.prepare('SELECT MAX(COALESCE((SELECT MAX(seq) FROM batch_changes WHERE household_id=?),0),(SELECT seq FROM batch_change_floor WHERE id=1)) AS seq').bind(householdId).first();
    return Number(row?.seq ?? 0);
  } catch (error) { throw schemaUnavailable(error); }
}

/**
 * Read-only page of this Shop's changes. Every query is bound to `householdId`,
 * so a forged cursor can only skip or repeat the caller's own changes.
 */
export async function listBatchChanges(db, householdId, { after, limit }, clock = () => new Date()) {
  try {
    if (after === null) return { changes: [], nextAfter: await currentChangeCursor(db, householdId), more: false, reset: false };
    if (after < await floorSeq(db)) return { changes: [], nextAfter: after, more: false, reset: true };
    const { results } = await db.prepare(
      `SELECT b.*, c.seq AS change_seq FROM batch_changes c
       LEFT JOIN batches b ON b.id=c.batch_id AND b.household_id=c.household_id
       WHERE c.household_id=? AND c.seq>? ORDER BY c.seq LIMIT ?`
    ).bind(householdId, after, limit + 1).all();
    const rows = results || [];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const today = todayISO(clock());
    const latest = new Map();
    for (const row of page) {
      const key = row.id ?? `missing:${row.change_seq}`;
      latest.delete(key);
      latest.set(key, row);
    }
    const changes = [...latest.values()].map(row => {
      const gone = !row.id || row.discarded_at || row.quantity <= 0;
      const { change_seq: _seq, ...current } = row;
      const batch = gone ? null : publicBatch(current, today);
      return { seq: row.change_seq, id: row.id, kind: gone ? 'remove' : 'upsert', revision: row.revision, batch };
    });
    return { changes, nextAfter: page.length ? page.at(-1).change_seq : after, more, reset: false };
  } catch (error) { throw schemaUnavailable(error); }
}

/** Drops feed rows and mutation receipts past retention, recording the floor so old cursors reset. */
export async function pruneBatchChanges(db, now = () => new Date()) {
  const cutoff = new Date(now().getTime() - RETENTION_MS).toISOString();
  await db.batch([
    db.prepare('UPDATE batch_change_floor SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM batch_changes WHERE created_at<?),0)) WHERE id=1').bind(cutoff),
    db.prepare('DELETE FROM batch_changes WHERE created_at<?').bind(cutoff),
    db.prepare('DELETE FROM mutation_receipts WHERE created_at<?').bind(cutoff)
  ]);
}
