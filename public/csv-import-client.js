// Import items from a CSV file. The browser reads and tidies the file; the server checks every row and saves all or none.
// Columns can be in any order. The export file's columns work as they are, so an export can be edited and imported back.
export const IMPORT_COLUMNS = ['name', 'strength', 'form', 'quantity', 'unit', 'expiry_date', 'location', 'notes', 'low_stock_threshold'];
export const IMPORT_ROW_LIMIT = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const ALIASES = {
  name: ['name', 'item', 'item name', 'product'], strength: ['strength'], form: ['form', 'category', 'type', 'kind', 'group'],
  quantity: ['quantity', 'qty', 'count', 'amount'], unit: ['unit', 'units'], expiry_date: ['expiry date', 'expiry', 'expires', 'expiration date', 'expiration', 'expiry_date'],
  location: ['location', 'storage location', 'storage'], notes: ['notes', 'note'], low_stock_threshold: ['low stock alert', 'low-stock alert', 'low stock threshold', 'low stock', 'low_stock_threshold', 'alert']
};
const keyOf = header => { const clean = String(header).replace(/^﻿/, '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '); return Object.keys(ALIASES).find(key => ALIASES[key].some(alias => alias.replace(/[_-]+/g, ' ') === clean)) || null; };

/** RFC 4180 parser: quoted cells, doubled quotes, CRLF or LF, and a comma, semicolon or tab separator. */
export function parseCsv(text) {
  const source = String(text).replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].map(char => [char, firstLine.split(char).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === sep) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(items => items.some(value => value.trim() !== ''));
}

// The export prefixes a quote to cells that start with = + - @ so spreadsheets do not run them; take it back off.
const unguard = value => /^'[=+\-@]/.test(value) ? value.slice(1) : value;

/** Rows as objects keyed by import column. Throws a plain message when the file cannot be used. */
export function rowsFromCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error('The file is empty.');
  const columns = table[0].map(keyOf);
  const missing = ['name', 'quantity', 'form', 'unit'].filter(key => !columns.includes(key));
  if (missing.length) throw new Error(`The first row needs these column names: ${missing.join(', ')}. Download the template to see the layout.`);
  const rows = table.slice(1).map(cells => { const row = {}; columns.forEach((key, index) => { if (key && !(key in row)) row[key] = unguard((cells[index] ?? '').trim()); }); return row; });
  if (rows.length === 0) throw new Error('The file has a header row but no items.');
  if (rows.length > IMPORT_ROW_LIMIT) throw new Error(`Import up to ${IMPORT_ROW_LIMIT} items at a time. This file has ${rows.length}; split it into smaller files.`);
  return rows;
}

export const templateCsv = () => `${IMPORT_COLUMNS.join(',')}\r\nParacetamol,500 mg,Tablets,24,tablet,2027-03-31,Medicine cabinet,Half a box left,6\r\n`;

export function bindCsvImport({ document, getContext, api, onImported, toast, readFile = file => file.text(), createObjectURL = value => URL.createObjectURL(value), revokeObjectURL = value => URL.revokeObjectURL(value) }) {
  const node = id => document.querySelector(`#${id}`);
  const section = node('importInventorySection'), button = node('importInventoryButton'), input = node('importInventoryFile');
  const template = node('importInventoryTemplate'), statusNode = node('importInventoryStatus'), problemsNode = node('importInventoryProblems');
  if (!section || !button || !input) return { refresh() {} };
  let busy = false;
  const status = (message, error = false) => { statusNode.textContent = message; statusNode.classList.toggle('error', error); };
  const showProblems = (problems = [], more = 0) => {
    problemsNode.replaceChildren(...problems.map(item => Object.assign(document.createElement('li'), { textContent: `Row ${item.row}: ${item.message}` })),
      ...(more > 0 ? [Object.assign(document.createElement('li'), { textContent: `…and ${more} more.` })] : []));
    problemsNode.hidden = problems.length === 0;
  };
  const refresh = () => { const context = getContext(); section.hidden = !(context?.accountContextKey && context.active); if (section.hidden) { status(''); showProblems(); } };

  button.addEventListener('click', () => { if (!busy) input.click(); });
  template?.addEventListener('click', () => {
    const url = createObjectURL(new Blob([templateCsv()], { type: 'text/csv' })), link = document.createElement('a');
    link.href = url; link.download = 'inventory-import-template.csv'; link.rel = 'noopener';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => revokeObjectURL(url), 0);
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    showProblems();
    if (file.size > MAX_FILE_BYTES) { status('That file is larger than 1 MB. Split it into smaller files.', true); return; }
    let rows;
    try { rows = rowsFromCsv(await readFile(file)); } catch (error) { status(error.message || 'That file could not be read.', true); return; }
    const context = getContext();
    busy = true; button.disabled = true; status(`Importing ${rows.length} ${rows.length === 1 ? 'item' : 'items'}…`);
    try {
      const result = await api('/api/batches/import', { method: 'POST', body: JSON.stringify({ rows }) });
      status(`Imported ${result.imported} ${result.imported === 1 ? 'item' : 'items'}.`);
      toast?.(`Imported ${result.imported} ${result.imported === 1 ? 'item' : 'items'}`);
      await onImported?.(result);
    } catch (error) {
      if (getContext()?.activeShopId !== context?.activeShopId) return;
      status(error.status === 0 || error.message === 'Failed to fetch' ? 'Importing needs a connection.' : error.message, true);
      showProblems(error.problems, error.moreProblems);
    } finally { busy = false; button.disabled = false; }
  });
  return { refresh };
}
