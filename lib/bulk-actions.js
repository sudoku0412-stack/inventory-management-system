// Bulk actions on several items at once: move them to another storage location, or discard them.
// Validation lives here so it can be tested without a database; the store applies the result in one D1 batch.
export const BULK_LIMIT = 100;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

/** A clean `{ action, ids, location }` or a 400. Duplicate ids are dropped; ids must be short strings. */
export function parseBulk(data) {
  const action = data?.action;
  if (action !== 'move' && action !== 'discard') throw failure('Choose move or discard.');
  if (!Array.isArray(data.ids) || data.ids.length === 0) throw failure('Select at least one item.');
  const ids = [...new Set(data.ids)];
  if (ids.some(id => typeof id !== 'string' || id.length < 1 || id.length > 64)) throw failure('Those items could not be read.');
  if (ids.length > BULK_LIMIT) throw failure(`Change up to ${BULK_LIMIT} items at a time. You selected ${ids.length}.`, 413);
  if (action === 'discard') return { action, ids };
  const location = typeof data.location === 'string' ? data.location.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (location.length < 1 || location.length > 100 || /[\u0000-\u001f]/.test(location)) throw failure('Choose where to move the items (1–100 characters).');
  return { action, ids, location };
}
