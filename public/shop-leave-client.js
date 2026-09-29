// The intent (and its operation id) survives dialog dismissal so Retry replays the same request,
// but never crosses account or Shop context.
export function bindShopLeave({ document, getContext, getAccess, request, operationId, reload = () => location.reload() }) {
  const node = id => document.querySelector(`#${id}`);
  const modal = node('leaveShopModal'), form = node('leaveShopForm'), submit = node('confirmLeaveShop'), button = node('leaveShopButton');
  let intent = null, inFlight = false;
  const matches = value => value && value.shopId === getContext()?.activeShopId && value.accountKey === getContext()?.accountContextKey;
  const lastOwner = () => {
    const context = getContext(), members = getAccess()?.members;
    return context?.active?.role === 'owner' && Array.isArray(members) && members.filter(member => member.role === 'owner').length < 2;
  };
  function refresh() {
    const context = getContext();
    const visible = Boolean(context?.accountContextKey && context.active);
    node('leaveShopSection').hidden = !visible;
    if (!visible) return;
    const blocked = lastOwner();
    button.disabled = blocked || inFlight;
    button.setAttribute('aria-describedby', 'leaveShopStatus');
    node('leaveShopStatus').textContent = blocked ? 'Make another member an owner before leaving this Shop.' : '';
    node('leaveShopStatus').classList.toggle('error', false);
  }
  function close() { if (modal.open) modal.close(); }
  modal.addEventListener('close', () => { if (!inFlight) button.focus({ preventScroll: true }); });
  node('cancelLeaveShop').addEventListener('click', close);
  button.addEventListener('click', () => {
    const context = getContext();
    if (!context?.accountContextKey || !context.active || lastOwner() || inFlight) return;
    if (!matches(intent)) intent = { shopId: context.activeShopId, accountKey: context.accountContextKey, shopName: context.active.name, operationId: operationId() };
    node('leaveShopTitle').textContent = `Leave ${intent.shopName}?`;
    node('leaveShopShop').textContent = `Shop: ${intent.shopName}`;
    submit.disabled = false; submit.textContent = intent.retry ? 'Retry' : 'Leave Shop';
    node('leaveShopModalStatus').textContent = intent.retry ? 'We couldn’t confirm the change. Retry, or reload to check your access.' : '';
    modal.showModal(); node('cancelLeaveShop').focus({ preventScroll: true });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (inFlight) return;
    const value = intent;
    if (!matches(value)) return close();
    inFlight = true; form.setAttribute('aria-busy', 'true'); submit.disabled = true; node('shopSelector').disabled = true;
    submit.textContent = 'Leaving…'; node('leaveShopModalStatus').textContent = 'Leaving…';
    try {
      await request('/api/household/leave', { method: 'POST', headers: { 'X-Shop-Id': value.shopId }, body: JSON.stringify({ operationId: value.operationId }) });
      intent = null;
      reload();
      return;
    } catch (error) {
      if (!matches(value)) return;
      if (!error.status || error.status === 408 || error.status === 429 || error.status >= 500) {
        value.retry = true; submit.disabled = false; submit.textContent = 'Retry';
        node('leaveShopModalStatus').textContent = 'We couldn’t confirm the change. Retry, or reload to check your access.';
      } else if (error.status === 403) {
        intent = null; reload();
        return;
      } else {
        intent = null; inFlight = false; close();
        node('leaveShopStatus').textContent = error.status === 409 && /keep at least one owner/.test(error.message) ? error.message : 'This change can’t be completed right now. Reload and try again.';
        node('leaveShopStatus').classList.toggle('error', true);
      }
    } finally {
      inFlight = false;
      if (matches(value)) { form.removeAttribute('aria-busy'); node('shopSelector').disabled = false; }
    }
  });
  return { refresh };
}
