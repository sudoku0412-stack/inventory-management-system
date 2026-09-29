// Profile switch for Shop deletion and ownership-transfer emails. Account-scoped; invitations are always sent.
export function bindEmailPreferences({ document, getContext, request }) {
  const node = id => document.querySelector(`#${id}`);
  const card = node('emailPreferencesCard'), toggle = node('emailNoticesToggle'), statusNode = node('emailPreferencesStatus');
  let loadedFor = null, busy = false;
  const status = (message, error = false) => { statusNode.textContent = message; statusNode.classList.toggle('error', error); };
  const accountKey = () => getContext()?.accountContextKey || null;

  async function refresh(force = false) {
    const key = accountKey();
    if (!key || (!force && loadedFor === key)) return;
    try {
      const data = await request('/api/email-preferences');
      if (accountKey() !== key || typeof data?.noticesEnabled !== 'boolean') return;
      toggle.checked = data.noticesEnabled;
      loadedFor = key;
      card.hidden = false;
    } catch { /* the card stays hidden when settings are unavailable */ }
  }

  toggle.addEventListener('change', async () => {
    if (busy) { toggle.checked = !toggle.checked; return; }
    const wanted = toggle.checked;
    busy = true; toggle.disabled = true; status('Saving…');
    try {
      const data = await request('/api/email-preferences', { method: 'PUT', body: JSON.stringify({ noticesEnabled: wanted }) });
      toggle.checked = data?.noticesEnabled === true;
      status(toggle.checked ? 'Shop change emails are on.' : 'Shop change emails are off.');
    } catch {
      toggle.checked = !wanted;
      status('We couldn’t save that. Try again.', true);
    } finally { busy = false; toggle.disabled = false; }
  });
  return { refresh };
}
