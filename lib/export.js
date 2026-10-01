const failure = (message, status) => Object.assign(new Error(message), { status });

export const EXPORT_ROW_LIMIT = 50000;
const COLUMNS = ['name', 'strength', 'form', 'quantity', 'unit', 'expiry_date', 'location', 'notes', 'low_stock_threshold', 'status', 'has_photo', 'created_at', 'updated_at', 'discarded_at'];

/** RFC 4180 quoting plus a guard against spreadsheet formula injection (=, +, -, @, tab, CR at the start of a cell). */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const slug = value => String(value || 'shop').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';

/**
 * CSV of every medicine in the pinned Shop, including discarded ones (status column). Photos are not
 * included. The caller must hold a live, non-deleted membership (Owner or Member), read server-side, never from the client.
 */
export async function exportInventoryCsv(db, tenant, now = () => new Date().toISOString()) {
  if (!tenant?.householdId || !tenant?.userId) throw failure('A shop membership is required.', 403);
  const member = await db.prepare('SELECT role FROM active_memberships WHERE household_id=? AND user_id=?').bind(tenant.householdId, tenant.userId).first();
  if (!member) throw failure('Only members of this Shop can export inventory.', 403);
  const shop = await db.prepare('SELECT name FROM households WHERE id=?').bind(tenant.householdId).first();
  const { results } = await db.prepare(`SELECT name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at,discarded_at
    FROM batches WHERE household_id=? ORDER BY LOWER(name), expiry_date IS NULL, expiry_date, id LIMIT ?`).bind(tenant.householdId, EXPORT_ROW_LIMIT + 1).all();
  if ((results || []).length > EXPORT_ROW_LIMIT) throw failure(`This Shop has more than ${EXPORT_ROW_LIMIT} items; contact support to export it.`, 413);
  const lines = [COLUMNS.join(',')];
  for (const row of results || []) {
    lines.push(COLUMNS.map(column => csvCell(column === 'status' ? (row.discarded_at ? 'discarded' : 'active') : column === 'has_photo' ? (row.photo_path ? 'yes' : 'no') : row[column])).join(','));
  }
  // The BOM makes Excel read the file as UTF-8.
  return { filename: `${slug(shop?.name)}-inventory-${now().slice(0, 10)}.csv`, csv: `﻿${lines.join('\r\n')}\r\n`, rows: (results || []).length };
}
