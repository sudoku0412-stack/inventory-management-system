// The intent (and its operation id) survives dialog dismissal so a retry replays the same removal,
// but never crosses account or Shop context.
export function bindMemberRemoval({ document, getContext, getAccess, renderAccess, request, operationId }) {
  const node = id => document.querySelector(`#${id}`);
  const modal = node('removeMemberModal'), form = node('removeMemberForm'), submit = node('confirmRemoveMember');
  let intent = null, inFlight = false, trigger = null, restoringFocus = true;
  const matches = value => value && value.shopId === getContext()?.activeShopId && value.accountKey === getContext()?.accountContextKey;
  function status(message, error = false) {
    node('householdAccessStatus').textContent = message;
    node('householdAccessStatus').classList.toggle('error', error);
  }
  function close(restore = true) { restoringFocus = restore; if (modal.open) modal.close(); }
  modal.addEventListener('close', () => {
    if (restoringFocus) (trigger?.isConnected ? trigger : node('householdAccessTitle')).focus({ preventScroll: true });
    restoringFocus = true;
  });
  node('cancelRemoveMember').addEventListener('click', () => close());
  async function refresh(value) {
    try {
      const access = await request('/api/household/access', { headers: { 'X-Shop-Id': value.shopId } });
      if (matches(value)) renderAccess(access);
    } catch {
      if (matches(value)) renderAccess({ ...getAccess(), members: getAccess().members.filter(member => member.user_id !== value.targetId) });
    }
  }
  node('householdMembers').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-member]'), context = getContext();
    if (!button || !context?.accountContextKey || context.active?.role !== 'owner') return;
    const member = getAccess()?.members.find(item => item.user_id === button.dataset.removeMember && item.role === 'member');
    if (!member || (inFlight && (!matches(intent) || intent.targetId !== member.user_id))) return;
    trigger = button;
    if (!matches(intent) || intent.targetId !== member.user_id) intent = { targetId: member.user_id, email: member.email, shopName: context.active.name, shopId: context.activeShopId, accountKey: context.accountContextKey, operationId: operationId() };
    node('removeMemberTitle').textContent = `Remove ${intent.email} from ${intent.shopName}?`;
    node('removeMemberShop').textContent = `Shop: ${intent.shopName}`;
    submit.disabled = inFlight; submit.textContent = inFlight ? 'Removing…' : intent.retry ? 'Retry' : 'Remove';
    node('removeMemberStatus').textContent = inFlight ? `Removing ${intent.email}…` : intent.retry ? 'We couldn’t confirm the change. Retry, or reload Shop access to check the member list.' : '';
    modal.showModal(); node('cancelRemoveMember').focus({ preventScroll: true });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (inFlight) return;
    const value = intent;
    if (!matches(value)) return close();
    inFlight = true; form.setAttribute('aria-busy', 'true'); submit.disabled = true; node('shopSelector').disabled = true;
    submit.textContent = 'Removing…'; node('removeMemberStatus').textContent = `Removing ${value.email}…`;
    try {
      await request(`/api/household/members/${encodeURIComponent(value.targetId)}/remove`, { method: 'POST', headers: { 'X-Shop-Id': value.shopId }, body: JSON.stringify({ operationId: value.operationId }) });
      if (!matches(value)) return;
      intent = null; close(false);
      await refresh(value);
      if (!matches(value)) return;
      status(`${value.email} was removed from ${value.shopName}.`);
      node('householdAccessTitle').focus({ preventScroll: true });
    } catch (error) {
      if (!matches(value)) return;
      if (!error.status || error.status === 408 || error.status === 429 || error.status >= 500) {
        value.retry = true; submit.disabled = false; submit.textContent = 'Retry';
        const message = 'We couldn’t confirm the change. Retry, or reload Shop access to check the member list.';
        node('removeMemberStatus').textContent = message; status(message); renderAccess(getAccess());
      } else {
        intent = null;
        await refresh(value);
        if (!matches(value)) return;
        close();
        status(error.status === 403 ? 'You no longer have permission to manage this Shop.' : error.status === 404 ? `${value.email} is no longer a member of this Shop.` : error.status === 409 && /Owners/.test(error.message) ? error.message : error.status === 409 ? 'This change can’t be completed right now. Reload Shop access and try again.' : 'Member removal is not available. Reload Shop access and try again.', true);
      }
    } finally {
      inFlight = false;
      if (matches(value)) { form.removeAttribute('aria-busy'); node('shopSelector').disabled = false; }
    }
  });
}
