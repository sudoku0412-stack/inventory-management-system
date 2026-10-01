// Owner overview: per-Shop summary cards, one combined item list with a Shop filter, a printable report
// (opened in its own window; the browser's Print dialog saves it as a PDF) and a combined CSV download.
const STATUS_LABELS = { expired: 'Expired', expiring: 'Expiring soon', low: 'Low stock', healthy: 'Healthy', unknown: 'No expiry date' };
const COLUMN_LABELS = ['Shop', 'Item', 'Quantity', 'Expiry', 'Location', 'Status'];
const COUNT_LABELS = [['total', 'Items'], ['expired', 'Expired'], ['expiring', 'Expiring soon'], ['low', 'Low stock']];

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function reportHtml(overview) {
  const generated = new Date(overview.generatedAt).toLocaleString();
  const sections = overview.shops.map(shop => {
    const rows = overview.items.filter(item => item.shopId === shop.id);
    const counts = COUNT_LABELS.map(([key, name]) => `<span>${escapeHtml(name)}: <strong>${shop.counts[key]}</strong></span>`).join('');
    const body = rows.length ? rows.map(item => `<tr><td>${escapeHtml(item.name)}${item.strength ? ` <small>${escapeHtml(item.strength)}</small>` : ''}</td><td>${escapeHtml(`${item.quantity} ${item.unit}`)}</td><td>${escapeHtml(item.expiry_date || '—')}</td><td>${escapeHtml(item.location || '—')}</td><td class="s-${escapeHtml(item.status)}">${escapeHtml(STATUS_LABELS[item.status] || item.status)}</td></tr>`).join('') : '<tr><td colspan="5">No items in stock.</td></tr>';
    return `<section><h2>${escapeHtml(shop.name)}</h2><p class="counts">${counts}</p>${shop.truncated ? '<p class="note">Showing the first items only; download the CSV for more.</p>' : ''}<table><thead><tr><th>Item</th><th>Quantity</th><th>Expiry</th><th>Location</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></section>`;
  }).join('');
  const total = overview.shops.reduce((sum, shop) => sum + shop.counts.total, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Inventory report</title><style>
body{font:14px/1.45 system-ui,sans-serif;color:#18312f;margin:24px auto;max-width:900px;padding:0 16px}h1{margin:0 0 4px}h2{margin:28px 0 6px;break-after:avoid}.meta,.note{color:#5d716e}.counts span{margin-right:16px}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border-bottom:1px solid #d9e2e0;padding:6px 8px;text-align:left}th{background:#f2f6f5;font-size:12px}tr{break-inside:avoid}small{color:#5d716e}
.s-expired{color:#a3352f;font-weight:600}.s-expiring{color:#a5620b;font-weight:600}.s-low{color:#8a6d00;font-weight:600}button{margin:12px 0;padding:10px 16px;font:inherit;cursor:pointer}@media print{button{display:none}body{margin:0}}
</style></head><body><h1>Inventory report</h1><p class="meta">Generated ${escapeHtml(generated)} · ${overview.shops.length} ${overview.shops.length === 1 ? 'Shop' : 'Shops'} · ${total} items</p><button id="printReport" type="button">Print or save as PDF</button>${sections}</body></html>`;
}

export function bindOverview({ document, api, request, getContext, toast, openWindow = () => globalThis.open('', '_blank'), createObjectURL = value => URL.createObjectURL(value), revokeObjectURL = value => URL.revokeObjectURL(value), now = () => new Date() }) {
  const $ = id => document.querySelector(`#${id}`);
  let data = null, loading = false;
  const status = (message, error = false) => { const node = $('overviewMessage'); node.textContent = message; node.classList.toggle('error', error); };

  function isOwner() { return Boolean(getContext()?.shops?.some(shop => shop.role === 'owner')); }

  function refresh() {
    const owner = isOwner();
    for (const node of document.querySelectorAll('[data-owner-overview]')) node.hidden = !owner;
  }

  function renderCards() {
    const host = $('overviewCards');
    host.replaceChildren(...data.shops.map(shop => {
      const card = document.createElement('article');
      card.className = 'overview-card';
      const title = document.createElement('h3');
      title.textContent = shop.name;
      const type = document.createElement('p');
      type.className = 'overview-type';
      type.textContent = shop.shopTypeName || (shop.shopType === 'goods' ? 'General goods' : 'Medicine');
      const grid = document.createElement('dl');
      for (const [key, name] of COUNT_LABELS) {
        const cell = document.createElement('div');
        const term = document.createElement('dt'), value = document.createElement('dd');
        term.textContent = name; value.textContent = String(shop.counts[key]);
        if (key !== 'total' && shop.counts[key] > 0) value.className = `attention ${key}`;
        cell.append(term, value); grid.append(cell);
      }
      const view = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: 'Show items' });
      view.setAttribute('aria-label', `Show items for ${shop.name}`);
      view.addEventListener('click', () => { $('overviewShop').value = shop.id; renderTable(); $('overviewTable').closest?.('.inventory-surface')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); });
      card.append(title, type, grid, view);
      return card;
    }));
  }

  function renderShopFilter() {
    const select = $('overviewShop'), keep = select.value;
    select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'All Shops' }), ...data.shops.map(shop => Object.assign(document.createElement('option'), { value: shop.id, textContent: shop.name })));
    select.value = data.shops.some(shop => shop.id === keep) ? keep : '';
    select.hidden = data.shops.length < 2;
    $('overviewShopLabel').hidden = select.hidden;
  }

  function renderTable() {
    const shopId = $('overviewShop').value, statusFilter = $('overviewStatusFilter').value || '', query = $('overviewSearch').value.trim().toLowerCase();
    const rows = data.items.filter(item => (!shopId || item.shopId === shopId) && (!statusFilter || item.status === statusFilter) && (!query || `${item.name} ${item.location} ${item.form}`.toLowerCase().includes(query)));
    const body = $('overviewRows');
    body.replaceChildren(...rows.map(item => {
      const tr = document.createElement('tr');
      const cells = [item.shopName, item.strength ? `${item.name} (${item.strength})` : item.name, `${item.quantity} ${item.unit}`, item.expiry_date || '—', item.location || '—'];
      // data-label lets phones show each cell as "Label: value" instead of a wide table column.
      cells.forEach((text, index) => { const cell = Object.assign(document.createElement('td'), { textContent: text }); cell.dataset.label = COLUMN_LABELS[index]; tr.append(cell); });
      const pill = document.createElement('td');
      pill.dataset.label = COLUMN_LABELS[5];
      pill.append(Object.assign(document.createElement('span'), { className: `status-pill ${item.status}`, textContent: STATUS_LABELS[item.status] || item.status }));
      tr.append(pill);
      return tr;
    }));
    $('overviewEmpty').hidden = rows.length > 0;
    $('overviewCount').textContent = `${rows.length} of ${data.items.length} items`;
    document.querySelector('#overviewTable').hidden = rows.length === 0;
  }

  async function opened() {
    if (loading || !isOwner()) return;
    loading = true; status('Loading…');
    try {
      data = await api('/api/owner/overview');
      renderCards(); renderShopFilter(); renderTable();
      $('overviewTruncated').hidden = !data.shops.some(shop => shop.truncated);
      status('');
    } catch (error) {
      status(error.status === 403 ? 'Only Shop Owners can open the overview.' : error.status === 0 || error.message === 'Failed to fetch' ? 'The overview needs a connection.' : error.message, true);
    } finally { loading = false; }
  }

  $('overviewShop').addEventListener('change', renderTable);
  $('overviewStatusFilter').addEventListener('change', renderTable);
  $('overviewSearch').addEventListener('input', renderTable);

  $('overviewReport').addEventListener('click', () => {
    if (!data) return;
    const target = openWindow();
    if (!target) { status('Allow pop-ups to open the report, then try again.', true); return; }
    target.document.open(); target.document.write(reportHtml(data)); target.document.close();
    target.document.getElementById('printReport')?.addEventListener('click', () => target.print());
  });

  $('overviewCsv').addEventListener('click', async () => {
    const button = $('overviewCsv');
    button.disabled = true; status('Preparing your download…');
    try {
      const blob = await request('/api/owner/export', { response: 'blob' });
      const url = createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `all-shops-inventory-${now().toISOString().slice(0, 10)}.csv`; link.rel = 'noopener';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => revokeObjectURL(url), 0);
      status('Downloaded. It lists every item in stock across your Shops.');
    } catch (error) {
      status(error.status === 403 ? 'Only Shop Owners can download this.' : 'We couldn’t prepare the download. Try again.', true);
      toast?.('Download failed');
    } finally { button.disabled = false; }
  });

  return { refresh, opened };
}
