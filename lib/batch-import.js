// Bulk import of items from a CSV the browser has already parsed into rows. Every row is checked before anything
// is saved: one bad row means nothing is imported, so the file can be fixed and uploaded again as a whole.
import { normalizeBatch } from './shared.js';

export const IMPORT_ROW_LIMIT = 200;
const MAX_PROBLEMS = 20;

const lookup = values => new Map([...values].map(value => [String(value).toLowerCase(), value]));
const blank = value => value === undefined || value === null || String(value).trim() === '';

/**
 * Turn raw rows into valid items. `allowed` is the Shop's form/unit lists; form and unit match without regard to case
 * and are saved in the Shop's spelling. Row numbers in problems count the header as row 1, as a spreadsheet does.
 */
export function prepareImport(rows, allowed, defaults) {
  if (!Array.isArray(rows) || rows.length === 0) throw Object.assign(new Error('The file has no items to import.'), { status: 400 });
  if (rows.length > IMPORT_ROW_LIMIT) throw Object.assign(new Error(`Import up to ${IMPORT_ROW_LIMIT} items at a time. This file has ${rows.length}.`), { status: 413 });
  const forms = lookup(allowed.forms), units = lookup(allowed.units);
  const items = [], problems = [];
  rows.forEach((row, index) => {
    const line = index + 2;
    const fail = message => problems.push({ row: line, message });
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('This row could not be read.');
    const form = forms.get(String(row.form ?? '').trim().toLowerCase());
    const unit = units.get(String(row.unit ?? '').trim().toLowerCase());
    if (blank(row.name)) return fail('Name is missing.');
    if (!/^\d+$/.test(String(row.quantity ?? '').trim()) || Number(row.quantity) < 1) return fail('Quantity must be a whole number of 1 or more.');
    if (!form) return fail(`Form “${String(row.form ?? '').trim()}” is not in this Shop’s Form list.`);
    if (!unit) return fail(`Unit “${String(row.unit ?? '').trim()}” is not in this Shop’s Unit list.`);
    if (!blank(row.low_stock_threshold) && !/^\d+$/.test(String(row.low_stock_threshold).trim())) return fail('Low-stock alert must be a whole number.');
    try {
      items.push(normalizeBatch({
        name: row.name, strength: row.strength, form, unit, quantity: Number(row.quantity),
        expiry_date: blank(row.expiry_date) ? null : String(row.expiry_date).trim(),
        location: blank(row.location) ? defaults.location : row.location,
        notes: row.notes,
        low_stock_threshold: blank(row.low_stock_threshold) ? defaults.threshold : Number(row.low_stock_threshold)
      }, true, { forms: new Set([form]), units: new Set([unit]) }));
    } catch { fail('Check the expiry date (use 2027-03-31 or leave it empty) and that numbers are not too large.'); }
  });
  if (problems.length) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    const more = problems.length - shown.length;
    throw Object.assign(new Error(`Nothing was imported. ${problems.length} ${problems.length === 1 ? 'row needs' : 'rows need'} fixing.`), { status: 422, problems: shown, moreProblems: more });
  }
  return items;
}
