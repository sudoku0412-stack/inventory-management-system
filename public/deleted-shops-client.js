// Recently deleted Shops this account owns, with owner restore. The list is account-scoped (deleted Shops are hidden
// from ordinary Shop lookups). A restore intent keeps its operation id across dismissal so Retry replays the same request.
export function bindDeletedShops({ document, getContext, request, operationId, reload = () => location.reload() }) {
  const node = id => document.querySelector(`#${id}`);
  const card = node('deletedShopsCard'), list = node('deletedShopsList'), statusNode = node('deletedShopsStatus');
  const modal = node('restoreShopModal'), form = node('restoreShopForm'), submit = node('confirmRestoreShop');
  let shops = [], intent = null, inFlight = false, loadedFor = null, trigger = null;
  const day = value => new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const status = (message, error = false) => { statusNode.textContent = message; statusNode.classList.toggle('error', error); };
  const accountKey = () => getContext()?.accountContextKey || null;

  function render() {
    card.hidden = shops.length === 0;
    list.replaceChildren(...shops.map(shop => {
      const item = document.createElement('li'), text = document.createElement('span'), name = document.createElement('strong'), meta = document.createElement('span'), button = document.createElement('button');
      name.className = 'access-email'; name.textContent = shop.name;
      meta.className = 'access-meta'; meta.textContent = `Deleted ${day(shop.deleted_at)} · permanently removed after ${day(shop.purge_after)}`;
      text.append(name, document.createElement('br'), meta);
      button.type = 'button'; button.className = 'button secondary'; button.dataset.restoreShop = shop.id;
      button.setAttribute('aria-label', `Restore ${shop.name}`); button.textContent = intent?.shopId === shop.id && intent.retry ? 'Retry restore' : 'Restore';
      item.append(text, button);
      return item;
    }));
  }

  async function refresh(force = false) {
    const key = accountKey();
    if (!key || (!force && loadedFor === key)) return;
    try {
      const data = await request('/api/shops/deleted');
      if (accountKey() !== key || !Array.isArray(data?.shops)) return;
      shops = data.shops.filter(shop => shop && typeof shop.id === 'string' && typeof shop.name === 'string' && typeof shop.deleted_at === 'string' && typeof shop.purge_after === 'string');
      loadedFor = key;
      render();
    } catch { /* an unavailable list simply stays hidden; nothing here blocks the app */ }
  }

  function close() { if (modal.open) modal.close(); }
  modal.addEventListener('close', () => { if (!inFlight) (trigger?.isConnected ? trigger : card).focus?.({ preventScroll: true }); });
  node('cancelRestoreShop').addEventListener('click', close);
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-restore-shop]');
    const shop = button && shops.find(item => item.id === button.dataset.restoreShop);
    if (!shop || inFlight) return;
    trigger = button;
    if (intent?.shopId !== shop.id) intent = { shopId: shop.id, name: shop.name, operationId: operationId() };
    node('restoreShopTitle').textContent = `Restore ${shop.name}?`;
    node('restoreShopStatus').textContent = intent.retry ? 'We couldn’t confirm the restore. Retry, or reload to check your Shops.' : '';
    submit.disabled = false; submit.textContent = intent.retry ? 'Retry' : 'Restore Shop';
    modal.showModal(); node('cancelRestoreShop').focus({ preventScroll: true });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (inFlight || !intent) return;
    const value = intent;
    inFlight = true; form.setAttribute('aria-busy', 'true'); submit.disabled = true; submit.textContent = 'Restoring…';
    node('restoreShopStatus').textContent = 'Restoring…';
    try {
      await request(`/api/shops/${encodeURIComponent(value.shopId)}/restore`, { method: 'POST', body: JSON.stringify({ operationId: value.operationId }) });
      intent = null; close();
      reload();
      return;
    } catch (error) {
      if (!error.status || error.status === 408 || error.status === 429 || error.status >= 500) {
        value.retry = true; submit.disabled = false; submit.textContent = 'Retry';
        node('restoreShopStatus').textContent = 'We couldn’t confirm the restore. Retry, or reload to check your Shops.';
      } else {
        intent = null; close();
        status(error.status === 404 ? 'That Shop is no longer available to restore.' : error.message || 'This Shop can’t be restored right now.', true);
        await refresh(true);
      }
    } finally {
      inFlight = false; form.removeAttribute('aria-busy');
    }
  });
  return { refresh, decode: () => shops };
}
