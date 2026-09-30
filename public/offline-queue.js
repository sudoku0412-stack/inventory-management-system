// Offline change queue: pure rules, no DOM and no storage.
// One entry per medicine; later changes collapse into it. Replay applies the "later timestamp wins" rule using the 409's current batch.
const FIELDS = ['name', 'strength', 'form', 'quantity', 'unit', 'low_stock_threshold', 'location', 'notes', 'expiry_date'];
const isoDay = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');

// Form values arrive as strings; the list and status rules need numbers.
const numeric = fields => { const out = { ...fields }; for (const key of ['quantity', 'low_stock_threshold']) if (out[key] !== undefined && out[key] !== '') out[key] = Number(out[key]); return out; };

export const pickFields = batch => Object.fromEntries(FIELDS.filter(key => batch && batch[key] !== undefined).map(key => [key, batch[key]]));

export function statusFor(batch, day = isoDay(new Date())) {
  if (!batch.expiry_date) return 'unknown';
  const end = new Date(`${day}T00:00:00`); end.setDate(end.getDate() + 30);
  if (batch.expiry_date < day) return 'expired';
  if (batch.expiry_date <= isoDay(end)) return 'expiring';
  return batch.quantity <= batch.low_stock_threshold ? 'low' : 'healthy';
}

/** Builds a queue entry from a batch mutation request, or null when the request is not a queueable batch mutation. */
export function entryFromRequest({ method, path, body, list, now = Date.now() }) {
  const match = /^\/api\/batches(?:\/([^/]+)(?:\/(consume|discard))?)?$/.exec(path);
  if (!match || !body) return null;
  const { operationId, baseRevision, ...rest } = body;
  const [, id, action] = match;
  if (method === 'POST' && !id) return { kind: 'create', batchId: `pending-${operationId}`, fields: rest, operationId, baseRevision: 0, editedAt: now };
  const current = id ? list.find(item => item.id === id) : null;
  if (!current) return null;
  if (method === 'PATCH' && !action) return { kind: 'update', batchId: id, fields: rest, operationId, baseRevision, editedAt: now };
  if (method === 'POST' && action === 'consume') return { kind: 'consume', batchId: id, amount: Number(rest.amount), quantityAfter: Math.max(0, current.quantity - Number(rest.amount)), operationId, baseRevision, editedAt: now };
  if (method === 'POST' && action === 'discard') return { kind: 'discard', batchId: id, operationId, baseRevision, editedAt: now };
  return null;
}

/** Collapses a new entry into the queue: one entry per medicine, the earliest baseRevision kept. */
export function enqueue(queue, entry) {
  const index = queue.findIndex(item => item.batchId === entry.batchId);
  if (index < 0) return [...queue, entry];
  const old = queue[index];
  const put = next => next ? [...queue.slice(0, index), next, ...queue.slice(index + 1)] : [...queue.slice(0, index), ...queue.slice(index + 1)];
  if (entry.kind === 'discard') return old.kind === 'create' ? put(null) : put({ ...entry, baseRevision: old.baseRevision });
  if (old.kind === 'create') {
    if (entry.kind === 'update') return put({ ...old, fields: { ...old.fields, ...entry.fields }, editedAt: entry.editedAt });
    if (entry.kind === 'consume') {
      const quantity = Number(old.fields.quantity) - entry.amount;
      return quantity < 1 ? put(null) : put({ ...old, fields: { ...old.fields, quantity }, editedAt: entry.editedAt });
    }
  }
  if (old.kind === 'update') {
    if (entry.kind === 'update') return put({ ...old, fields: { ...old.fields, ...entry.fields }, editedAt: entry.editedAt });
    if (entry.kind === 'consume') return put({ ...old, fields: { ...old.fields, quantity: entry.quantityAfter }, editedAt: entry.editedAt });
  }
  if (old.kind === 'consume') {
    if (entry.kind === 'consume') return put({ ...old, amount: old.amount + entry.amount, quantityAfter: entry.quantityAfter, editedAt: entry.editedAt });
    if (entry.kind === 'update') return put({ ...entry, baseRevision: old.baseRevision });
  }
  return put(entry);
}

/** The medicine list as it will look once the queue is applied. */
export function applyQueue(list, queue, day = isoDay(new Date())) {
  const out = list.map(item => ({ ...item }));
  for (const entry of queue) {
    const index = out.findIndex(item => item.id === entry.batchId);
    if (entry.kind === 'create') {
      const stamp = new Date(entry.editedAt).toISOString();
      const batch = { id: entry.batchId, strength: '', location: '', notes: '', low_stock_threshold: 4, expiry_date: null, ...numeric(entry.fields), has_photo: false, revision: 0, discarded_at: null, created_at: stamp, updated_at: stamp, pending: true };
      batch.status = statusFor(batch, day);
      out.push(batch);
    } else if (index < 0) continue;
    else if (entry.kind === 'discard' || (entry.kind === 'consume' && entry.quantityAfter < 1)) out.splice(index, 1);
    else {
      const batch = { ...out[index], ...(entry.kind === 'update' ? numeric(entry.fields) : { quantity: entry.quantityAfter }) };
      batch.status = statusFor(batch, day);
      batch.pending = true;
      out[index] = batch;
    }
  }
  return out;
}

/** The HTTP request that sends an entry. */
export function requestFor(entry) {
  const sync = { operationId: entry.operationId, baseRevision: entry.baseRevision };
  if (entry.kind === 'create') return { method: 'POST', path: '/api/batches', body: { ...entry.fields, ...sync } };
  if (entry.kind === 'update') return { method: 'PATCH', path: `/api/batches/${entry.batchId}`, body: { ...entry.fields, ...sync } };
  if (entry.kind === 'consume') return { method: 'POST', path: `/api/batches/${entry.batchId}/consume`, body: { amount: entry.amount, ...sync } };
  return { method: 'POST', path: `/api/batches/${entry.batchId}/discard`, body: sync };
}

/** The entry re-based onto the server's current batch, with a new operationId (its old one was tied to a stale revision). */
function rebase(entry, current, newId) {
  const sync = { operationId: newId(), baseRevision: current.revision };
  if (entry.kind === 'discard') return { ...entry, ...sync };
  if (entry.kind === 'consume' && entry.quantityAfter < 1) return { ...entry, amount: current.quantity, ...sync };
  if (entry.kind === 'consume') return { ...entry, kind: 'update', fields: { ...pickFields(current), quantity: entry.quantityAfter }, ...sync };
  return { ...entry, fields: { ...pickFields(current), ...entry.fields }, ...sync };
}

/**
 * Sends entries in order. `send(entry)` resolves or rejects with an error carrying `status` (and `current` on a 409).
 * `correct(ms)` maps a device time to server time. `persist(queue)` saves progress after each entry leaves the queue.
 */
export async function replayQueue({ queue, send, persist, correct, newId, maxTries = 3 }) {
  let pending = [...queue], replaced = 0, skipped = 0, state = 'done';
  const leave = async entry => { pending = pending.filter(item => item !== entry); await persist(pending); };
  for (const entry of queue) {
    let working = entry, tries = 0;
    for (;;) {
      try { await send(working); await leave(entry); break; }
      catch (error) {
        const status = error?.status;
        if (status === 409 && error.current) {
          const later = correct(entry.editedAt) > Date.parse(error.current.updated_at);
          if (!later || error.current.discarded_at) { replaced += 1; await leave(entry); break; }
          if (++tries > maxTries) { state = 'retry'; break; }
          working = rebase(entry, error.current, newId);
          continue;
        }
        if (status === 401 || status === 403) return { queue: pending, replaced, skipped, state: 'auth' };
        if (status === 404 || (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429)) { skipped += 1; await leave(entry); break; }
        return { queue: pending, replaced, skipped, state: 'offline' };
      }
    }
  }
  return { queue: pending, replaced, skipped, state };
}
