// Restock list: medicines that need replacing (expired, expiring within 30 days, low stock).
// A medicine (same name, strength, form and unit) is left off when any of its batches is healthy or has no expiry date.
const RANK = { expired: 0, expiring: 1, low: 2 };
const norm = value => String(value || '').trim().toLowerCase();
const dayNumber = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };

export function restockItems(list, today = new Date()) {
  const groups = new Map();
  for (const batch of list) {
    if (batch.discarded_at) continue;
    const key = [batch.name, batch.strength, batch.form, batch.unit].map(norm).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(batch);
  }
  const todayNumber = dayNumber(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
  const items = [];
  for (const batches of groups.values()) {
    if (batches.some(batch => batch.status === 'healthy' || batch.status === 'unknown')) continue;
    const ranked = batches.filter(batch => batch.status in RANK);
    if (!ranked.length) continue;
    const worst = ranked.reduce((a, b) => RANK[b.status] < RANK[a.status] ? b : a);
    const quantity = batches.reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
    const days = worst.expiry_date ? dayNumber(worst.expiry_date) - todayNumber : null;
    const reason = worst.status === 'expired' ? 'Expired' : worst.status === 'expiring' ? (days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`) : `Low: ${quantity} left`;
    items.push({ status: worst.status, reason, name: worst.name, strength: worst.strength || '', form: worst.form, unit: worst.unit, location: worst.location || '', expiry_date: worst.expiry_date || null, quantity });
  }
  return items.sort((a, b) => RANK[a.status] - RANK[b.status] || String(a.expiry_date || '').localeCompare(String(b.expiry_date || '')) || a.name.localeCompare(b.name));
}

export const itemLabel = item => `${item.name}${item.strength ? ` ${item.strength}` : ''} ${String(item.form || '').toLowerCase()}`.trim();

export function restockText(items, today = new Date()) {
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return [`Restock list (${date})`, ...items.map(item => `- ${itemLabel(item)} (${item.reason.toLowerCase()})`)].join('\n');
}

export function bindRestock({ document, getMedicines, addStock, toast, nav = globalThis.navigator }) {
  const node = id => document.querySelector(`#${id}`);
  const modal = node('restockModal'), list = node('restockList'), empty = node('restockEmpty'), share = node('restockShare'), copy = node('restockCopy');
  let items = [];
  share.hidden = !nav?.share;

  function refresh() {
    items = restockItems(getMedicines());
    for (const badge of document.querySelectorAll('[data-restock-count]')) badge.textContent = String(items.length);
    if (modal.open) render();
  }
  function render() {
    empty.hidden = items.length > 0;
    copy.disabled = share.disabled = !items.length;
    list.replaceChildren(...items.map((item, index) => {
      const row = document.createElement('li'), text = document.createElement('span'), name = document.createElement('strong'), meta = document.createElement('span'), button = document.createElement('button');
      name.className = 'access-email'; name.textContent = itemLabel(item);
      meta.className = 'access-meta'; meta.textContent = [item.reason, item.location].filter(Boolean).join(' · ');
      text.append(name, document.createElement('br'), meta);
      button.type = 'button'; button.className = 'button secondary'; button.dataset.restockAdd = String(index);
      button.setAttribute('aria-label', `Add stock for ${itemLabel(item)}`); button.textContent = 'Add stock';
      row.append(text, button);
      return row;
    }));
  }
  for (const opener of document.querySelectorAll('[data-open-restock]')) opener.addEventListener('click', () => { refresh(); render(); modal.showModal(); node('restockClose').focus({ preventScroll: true }); });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-restock-add]');
    const item = button && items[Number(button.dataset.restockAdd)];
    if (!item) return;
    modal.close();
    addStock(item);
  });
  copy.addEventListener('click', async () => {
    try { await nav.clipboard.writeText(restockText(items)); toast('Restock list copied'); }
    catch { toast('Couldn’t copy. Use Share or select the list.'); }
  });
  share.addEventListener('click', async () => {
    try { await nav.share({ title: 'Restock list', text: restockText(items) }); } catch { /* cancelled */ }
  });
  return { refresh };
}
