// Stock history: what changed in an item's quantity and when. Shown in the item dialog and as a Shop-wide
// "Recent activity" list. History is online-only; when it cannot load, the sections stay hidden.
const amount = (value, unit) => `${Math.abs(value)} ${unit}`.trim();

/** One plain sentence for a history row. */
export function describeEvent(event, { withName = false } = {}) {
  const what = { added: `Added ${amount(event.change, event.unit)}`, used: `Used ${amount(event.change, event.unit)}`,
    discarded: `Discarded ${amount(event.change, event.unit)}`, adjusted: `Quantity ${event.change > 0 ? 'raised' : 'lowered'} by ${amount(event.change, event.unit)}` }[event.kind] || 'Changed';
  const left = event.kind === 'discarded' ? '' : ` · ${event.quantity_after} ${event.unit} now`.replace(/ +$/, '');
  return `${withName ? `${event.item_name}: ` : ''}${what}${left}`;
}

export function whenText(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today, ${time}` : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

export function bindStockHistory({ document, api, now = () => new Date() }) {
  const node = id => document.querySelector(`#${id}`);
  const item = { section: node('batchHistory'), usage: node('batchUsage'), list: node('batchHistoryList') };
  const shop = { section: node('shopHistory'), list: node('shopHistoryList'), usage: node('shopHistoryUsage') };
  let itemToken = 0, shopToken = 0;

  function fill(target, data, withName) {
    target.list.replaceChildren(...data.events.map(event => {
      const row = document.createElement('li');
      const text = document.createElement('span'), time = document.createElement('small');
      text.textContent = describeEvent(event, { withName }); time.textContent = whenText(event.created_at, now());
      row.className = `history-row ${event.kind}`;
      row.append(text, time);
      return row;
    }));
    const empty = data.events.length === 0;
    if (target.usage) target.usage.textContent = empty ? 'No changes recorded yet. From now on, every time stock is added, used or discarded it shows here.' : data.usedLast30Days ? `Used ${data.usedLast30Days} in the last 30 days.` : '';
    target.list.hidden = empty;
    target.section.hidden = false;
  }

  return {
    async showItem(batchId) {
      if (!item.section) return;
      const token = ++itemToken;
      item.section.hidden = true;
      try {
        const data = await api(`/api/stock-events?batch=${encodeURIComponent(batchId)}&limit=20`);
        if (token === itemToken) fill(item, data, false);
      } catch { if (token === itemToken) item.section.hidden = true; }
    },
    async showShop() {
      if (!shop.section) return;
      const token = ++shopToken;
      try {
        const data = await api('/api/stock-events?limit=50');
        if (token === shopToken) fill(shop, data, true);
      } catch { if (token === shopToken) shop.section.hidden = true; }
    }
  };
}
