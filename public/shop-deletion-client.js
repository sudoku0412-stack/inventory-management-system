// Owner-only, flag-gated (the server sets access.shop_deletion) Shop deletion. The intent and its operation id
// survive dismissal so Retry replays the same request, but never cross account or Shop context.
export function bindShopDeletion({ document, getContext, getAccess, request, operationId, reload = () => location.reload() }) {
  const node = id => document.querySelector(`#${id}`);
  const modal = node('deleteShopModal'), form = node('deleteShopForm'), submit = node('confirmDeleteShop'), button = node('deleteShopButton'), input = node('deleteShopConfirm');
  let intent = null, inFlight = false;
  const matches = value => value && value.shopId === getContext()?.activeShopId && value.accountKey === getContext()?.accountContextKey;
  const typed = () => input.value.trim() === intent?.shopName;
  function refresh() {
    const context = getContext();
    const visible = Boolean(context?.accountContextKey && context.active?.role === 'owner' && getAccess()?.shop_deletion === true);
    node('deleteShopSection').hidden = !visible;
    if (visible) button.disabled = inFlight;
  }
  function close() { if (modal.open) modal.close(); }
  function syncSubmit() { submit.disabled = inFlight || !typed(); }
  modal.addEventListener('close', () => { if (!inFlight) button.focus({ preventScroll: true }); });
  node('cancelDeleteShop').addEventListener('click', close);
  input.addEventListener('input', syncSubmit);
  button.addEventListener('click', () => {
    const context = getContext();
    if (!context?.accountContextKey || context.active?.role !== 'owner' || inFlight) return;
    if (!matches(intent)) intent = { shopId: context.activeShopId, accountKey: context.accountContextKey, shopName: context.active.name, operationId: operationId() };
    node('deleteShopTitle').textContent = `Delete ${intent.shopName}?`;
    node('deleteShopShop').textContent = `Shop: ${intent.shopName}`;
    node('deleteShopConfirmLabel').textContent = `Type ${intent.shopName} to confirm`;
    input.value = '';
    submit.textContent = intent.retry ? 'Retry' : 'Delete Shop';
    syncSubmit();
    node('deleteShopModalStatus').textContent = intent.retry ? 'We couldn’t confirm the deletion. Retry, or reload to check your access.' : '';
    modal.showModal(); node('cancelDeleteShop').focus({ preventScroll: true });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (inFlight) return;
    const value = intent;
    if (!matches(value) || !typed()) return;
    inFlight = true; form.setAttribute('aria-busy', 'true'); submit.disabled = true; input.disabled = true; node('shopSelector').disabled = true;
    submit.textContent = 'Deleting…'; node('deleteShopModalStatus').textContent = 'Deleting…';
    try {
      await request('/api/household/delete', { method: 'POST', headers: { 'X-Shop-Id': value.shopId }, body: JSON.stringify({ operationId: value.operationId, confirmName: input.value.trim() }) });
      intent = null;
      reload();
      return;
    } catch (error) {
      if (!matches(value)) return;
      if (!error.status || error.status === 408 || error.status === 429 || error.status >= 500) {
        value.retry = true; submit.textContent = 'Retry';
        node('deleteShopModalStatus').textContent = 'We couldn’t confirm the deletion. Retry, or reload to check your access.';
      } else if (error.status === 403 || error.status === 404) {
        // The Shop is already gone for this account (including a replay after success): reload into another Shop.
        intent = null; reload();
        return;
      } else {
        intent = null; inFlight = false; close();
        node('deleteShopStatus').textContent = error.status === 409 || error.status === 400 ? error.message : 'Shop deletion is not available. Reload and try again.';
        node('deleteShopStatus').classList.toggle('error', true);
      }
    } finally {
      inFlight = false; input.disabled = false;
      if (matches(value)) { form.removeAttribute('aria-busy'); node('shopSelector').disabled = false; syncSubmit(); }
    }
  });
  return { refresh };
}
