// Owner-only download of the current Shop's inventory as CSV. The file is built by the server for the pinned Shop
// (`X-Shop-Id`), so the browser fetches it and saves the blob instead of navigating.
export function exportFileName(shopName, date = new Date()) {
  const slug = String(shopName || 'shop').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
  return `${slug}-inventory-${date.toISOString().slice(0, 10)}.csv`;
}

export function bindInventoryExport({ document, getContext, request, createObjectURL = value => URL.createObjectURL(value), revokeObjectURL = value => URL.revokeObjectURL(value), now = () => new Date() }) {
  const node = id => document.querySelector(`#${id}`);
  const section = node('exportInventorySection'), button = node('exportInventoryButton'), statusNode = node('exportInventoryStatus');
  let inFlight = false;
  const status = (message, error = false) => { statusNode.textContent = message; statusNode.classList.toggle('error', error); };
  function refresh() {
    const context = getContext();
    section.hidden = !(context?.accountContextKey && context.active?.role === 'owner');
    if (section.hidden) status('');
  }
  button.addEventListener('click', async () => {
    const context = getContext();
    if (inFlight || !context?.accountContextKey || context.active?.role !== 'owner') return;
    const shopId = context.activeShopId, accountKey = context.accountContextKey, shopName = context.active.name;
    inFlight = true; button.disabled = true; status('Preparing your export…');
    try {
      const blob = await request('/api/household/export', { response: 'blob', headers: { 'X-Shop-Id': shopId } });
      const current = getContext();
      if (current?.activeShopId !== shopId || current?.accountContextKey !== accountKey) return;
      const url = createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = exportFileName(shopName, now()); link.rel = 'noopener';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => revokeObjectURL(url), 0);
      status('Your export was downloaded. It lists every medicine, including discarded ones. Photos are not included.');
    } catch (error) {
      const current = getContext();
      if (current?.activeShopId !== shopId) return;
      status(error.status === 403 ? 'Only a Shop owner can export inventory.' : error.status === 413 ? error.message : 'We couldn’t prepare the export. Try again.', true);
    } finally {
      inFlight = false; button.disabled = false;
    }
  });
  return { refresh };
}
