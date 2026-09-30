// Profile switches for Shop change emails (deletion, ownership transfer) and the weekly summary. Account-scoped; invitations are always sent.
export function bindEmailPreferences({ document, getContext, request }) {
  const node = id => document.querySelector(`#${id}`);
  const card = node('emailPreferencesCard'), statusNode = node('emailPreferencesStatus');
  const toggles = { noticesEnabled: node('emailNoticesToggle'), digestEnabled: node('emailDigestToggle') };
  const labels = { noticesEnabled: 'Shop change emails', digestEnabled: 'Weekly summary' };
  let loadedFor = null, busy = false;
  const status = (message, error = false) => { statusNode.textContent = message; statusNode.classList.toggle('error', error); };
  const accountKey = () => getContext()?.accountContextKey || null;
  const show = data => { for (const key of Object.keys(toggles)) if (typeof data?.[key] === 'boolean') toggles[key].checked = data[key]; };

  async function refresh(force = false) {
    const key = accountKey();
    if (!key || (!force && loadedFor === key)) return;
    try {
      const data = await request('/api/email-preferences');
      if (accountKey() !== key || typeof data?.noticesEnabled !== 'boolean') return;
      show(data);
      loadedFor = key;
      card.hidden = false;
    } catch { /* the card stays hidden when settings are unavailable */ }
  }

  for (const [key, toggle] of Object.entries(toggles)) toggle.addEventListener('change', async () => {
    if (busy) { toggle.checked = !toggle.checked; return; }
    const wanted = toggle.checked;
    busy = true; for (const other of Object.values(toggles)) other.disabled = true; status('Saving…');
    try {
      const data = await request('/api/email-preferences', { method: 'PUT', body: JSON.stringify({ [key]: wanted }) });
      show(data);
      status(`${labels[key]} ${toggle.checked ? 'on' : 'off'}.`);
    } catch {
      toggle.checked = !wanted;
      status('We couldn’t save that. Try again.', true);
    } finally { busy = false; for (const other of Object.values(toggles)) other.disabled = false; }
  });
  return { refresh };
}
