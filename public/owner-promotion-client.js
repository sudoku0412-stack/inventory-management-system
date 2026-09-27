// In-memory intents survive dialog dismissal, but never cross account/Shop context.
export function bindOwnerPromotion({ document, getContext, getAccess, renderAccess, renderContext, request, operationId }) {
  const node = id => document.querySelector(`#${id}`);
  const modal = node('promoteMemberModal'), form = node('promoteMemberForm'), submit = node('confirmPromoteMember');
  let intent = null, inFlight = false, trigger = null, restoringFocus = true;
  const matches = value => value && value.shopId === getContext()?.activeShopId && value.accountKey === getContext()?.accountContextKey;
  function status(message, error = false) {
    node('householdAccessStatus').textContent = message;
    node('householdAccessStatus').classList.toggle('error', error);
  }
  function focusOwner(value) {
    const label = [...node('householdMembers').querySelectorAll('[data-owner-member]')].find(item => item.dataset.ownerMember === value.targetId);
    (label || node('householdAccessTitle')).focus({ preventScroll: true });
  }
  function close(restore = true) { restoringFocus = restore; if (modal.open) modal.close(); }
  modal.addEventListener('close', () => {
    if (restoringFocus) (trigger?.isConnected ? trigger : node('householdAccessTitle')).focus({ preventScroll: true });
    restoringFocus = true;
  });
  node('cancelPromoteMember').addEventListener('click', () => close());
  function markConfirmed(value) {
    const access = getAccess();
    if (access) renderAccess({ ...access, members: access.members.map(member => member.user_id === value.targetId ? { ...member, role: 'owner' } : member) });
  }
  // Both reads reject on failure. Startup helpers deliberately handle their own
  // errors and reload settings, so they cannot be used for this in-place refresh.
  async function refresh(value) {
    const options = { headers: { 'X-Shop-Id': value.shopId } };
    const results = await Promise.allSettled([request('/api/household/access', options), request('/api/shops', options)]);
    if (!matches(value)) return false;
    const [access, context] = results;
    if (access.status === 'fulfilled') renderAccess(access.value);
    let contextValid = false;
    if (context.status === 'fulfilled') {
      const next = context.value;
      contextValid = next.accountContextKey === value.accountKey && next.activeShopId === value.shopId && next.shops?.some(shop => shop.id === value.shopId);
      if (contextValid) renderContext(next);
    }
    if (access.status === 'rejected' || !contextValid) throw Error('Shop access refresh failed.');
    return true;
  }
  async function presentConfirmed(value, message) {
    status(message);
    try {
      if (!await refresh(value)) return;
      status(message); focusOwner(value);
    } catch {
      if (!matches(value)) return;
      markConfirmed(value);
      status(`${message} Reload Shop access to refresh the list.`);
      const reload = document.createElement('button');
      reload.type = 'button'; reload.className = 'button secondary'; reload.textContent = 'Reload Shop access';
      reload.addEventListener('click', async () => {
        if (!matches(value)) return;
        reload.disabled = true;
        await presentConfirmed(value, message);
      });
      node('householdAccessStatus').append(' ', reload); reload.focus({ preventScroll: true });
    }
  }
  node('householdMembers').addEventListener('click', event => {
    const button = event.target.closest('[data-promote-member]'), context = getContext();
    if (!button || !context?.accountContextKey || context.active?.role !== 'owner') return;
    const member = getAccess()?.members.find(item => item.user_id === button.dataset.promoteMember && item.role === 'member');
    if (!member || (inFlight && (!matches(intent) || intent.targetId !== member.user_id))) return;
    trigger = button;
    if (!matches(intent) || intent.targetId !== member.user_id) intent = { targetId: member.user_id, email: member.email, shopName: context.active.name, shopId: context.activeShopId, accountKey: context.accountContextKey, operationId: operationId() };
    node('promoteMemberTitle').textContent = `Make ${intent.email} an owner?`;
    node('promoteMemberShop').textContent = `Shop: ${intent.shopName}`;
    submit.disabled = inFlight; submit.textContent = inFlight ? 'Making owner…' : intent.retry ? 'Retry' : 'Make owner';
    node('promoteMemberStatus').textContent = inFlight ? `Making ${intent.email} an owner…` : intent.retry ? 'We couldn’t confirm the change. Retry, or reload Shop access to check their role.' : '';
    modal.showModal(); node('cancelPromoteMember').focus({ preventScroll: true });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (inFlight) return;
    const value = intent;
    if (!matches(value)) return close();
    inFlight = true; form.setAttribute('aria-busy', 'true'); submit.disabled = true; node('shopSelector').disabled = true;
    submit.textContent = 'Making owner…'; node('promoteMemberStatus').textContent = `Making ${value.email} an owner…`;
    try {
      const result = await request(`/api/household/members/${encodeURIComponent(value.targetId)}/promote`, { method: 'POST', headers: { 'X-Shop-Id': value.shopId }, body: JSON.stringify({ operationId: value.operationId }) });
      if (!matches(value)) return;
      intent = null; close(false); markConfirmed(value);
      await presentConfirmed(value, result.changed ? `${value.email} is now an owner of ${value.shopName}.` : `${value.email} is already an owner.`);
    } catch (error) {
      if (!matches(value)) return;
      if (!error.status || error.status === 408 || error.status === 429 || error.status >= 500) {
        value.retry = true; submit.disabled = false; submit.textContent = 'Retry';
        const message = 'We couldn’t confirm the change. Retry, or reload Shop access to check their role.';
        node('promoteMemberStatus').textContent = message; status(message); renderAccess(getAccess());
      } else {
        intent = null;
        try { await refresh(value); } catch { /* Keep definitive guidance available even when refresh fails. */ }
        if (!matches(value)) return;
        close();
        status(error.status === 403 ? 'You no longer have permission to manage this Shop.' : error.status === 404 ? `${value.email} is no longer a member of this Shop.` : error.status === 409 && error.message === 'This member already owns 5 Shops.' ? error.message : error.status === 409 ? 'This change can’t be completed right now. Reload Shop access and try again.' : 'Owner promotion is not available. Reload Shop access and try again.', true);
      }
    } finally {
      inFlight = false;
      if (matches(value)) { form.removeAttribute('aria-busy'); node('shopSelector').disabled = false; }
    }
  });
  return { retryTarget: () => matches(intent) && intent.retry ? intent.targetId : null };
}
