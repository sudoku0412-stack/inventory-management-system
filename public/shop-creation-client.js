export const creationStorageKey = 'shop-creation-intents';

export function validAccountContextKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
}

export function readCreationIntents(storage) {
  try {
    const value = JSON.parse(storage.getItem(creationStorageKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Persists before callers dispatch; separate account keys keep intents private. */
export function persistCreationIntent(storage, intent) {
  const intents = readCreationIntents(storage);
  try { storage.setItem(creationStorageKey, JSON.stringify({ ...intents, [intent.accountContextKey]: intent })); return true; } catch { return false; }
}

export function removeCreationIntent(storage, accountContextKey) {
  const intents = readCreationIntents(storage);
  delete intents[accountContextKey];
  try { storage.setItem(creationStorageKey, JSON.stringify(intents)); } catch {}
}

export function intentForAccount(storage, accountContextKey) {
  return validAccountContextKey(accountContextKey) ? readCreationIntents(storage)[accountContextKey] || null : null;
}

export function isCurrentCreationResponse(intent, confirmedAccountContextKey) {
  return Boolean(intent && intent.accountContextKey === confirmedAccountContextKey);
}

/** The complete creation dialog flow. Dependencies are the same page services used by app.js. */
const RETRY_MESSAGE = 'We couldn’t confirm creation. Retry to check the same request.';

/**
 * A definitive refusal drops the saved intent and shows the server's reason. The rolling one-Shop-per-24-hours
 * limit is a 429 with an explicit message: it is a refusal, not an unconfirmed request, so say so.
 */
export function creationFailure(error) {
  const status = error?.status, text = String(error?.message || '');
  if (status === 429 && /every 24 hours/i.test(text)) return { definitive: true, message: text };
  const definitive = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { definitive, message: definitive ? text : RETRY_MESSAGE };
}

export function bindShopCreation({ document, storage, getContext, getDisplayName, operationId, request, renderContext, schedule = requestAnimationFrame }) {
  const find = id => document.querySelector(`#${id}`);
  const form = find('createShopForm'), modal = find('createShopModal'), button = find('submitCreateShop');
  const trigger = find('createShopButton'), status = find('createShopStatus'), notice = find('createShopUnavailable');
  let busy = false;
  const currentIntent = () => intentForAccount(storage, getContext()?.accountContextKey);
  const message = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  function contextChanged() {
    const available = validAccountContextKey(getContext()?.accountContextKey);
    trigger.disabled = !available;
    trigger.textContent = !available ? 'Shop creation is not available yet.' : currentIntent() ? 'Resume Shop creation' : 'Create another Shop';
    notice.hidden = available;
    notice.textContent = available ? '' : 'Shop creation is not available yet.';
  }
  function open() {
    if (!validAccountContextKey(getContext()?.accountContextKey)) return;
    const intent = currentIntent();
    button.disabled = busy;
    button.textContent = busy ? 'Creating…' : intent ? 'Retry creation' : 'Create Shop';
    if (intent?.payload) {
      form.elements.shopName.value = intent.payload.shopName;
      form.elements.displayName.value = intent.payload.displayName;
      if (form.elements.shopType && intent.payload.shopType) form.elements.shopType.value = intent.payload.shopType;
      message(busy ? 'Creating your Shop…' : 'A previous request needs confirmation. Retry creation to check the same request.');
    } else {
      form.reset();
      form.elements.displayName.value = getDisplayName() || '';
      message('');
    }
    modal.showModal();
    modal.scrollTop = 0;
    schedule(() => { if (modal.open) { modal.scrollTop = 0; form.elements.shopName.focus({ preventScroll: true }); } });
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !validAccountContextKey(getContext()?.accountContextKey)) return;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const payload = Object.fromEntries(['shopName', 'displayName'].map(key => [key, form.elements[key].value.normalize('NFKC').trim().replace(/\s+/g, ' ')]));
    if (form.elements.shopType?.value === 'goods') payload.shopType = 'goods';
    let intent = currentIntent();
    if (intent && (intent.payload.shopName !== payload.shopName || intent.payload.displayName !== payload.displayName || intent.payload.shopType !== payload.shopType)) {
      message('Retry the saved request before changing these details.', true);
      return;
    }
    if (!intent) {
      intent = { operationId: operationId(), accountContextKey: getContext().accountContextKey, payload };
      if (!persistCreationIntent(storage, intent)) { message('Safe retry storage is unavailable. Your Shop was not created.', true); return; }
    }
    const previousShopId = getContext().activeShopId;
    busy = true;
    button.disabled = true;
    button.textContent = 'Creating…';
    form.setAttribute('aria-busy', 'true');
    message('Creating your Shop…');
    contextChanged();
    try {
      const result = await request('/api/shops', { method: 'POST', body: JSON.stringify({ ...intent.payload, operationId: intent.operationId }) });
      if (!isCurrentCreationResponse(intent, getContext()?.accountContextKey)) return;
      removeCreationIntent(storage, intent.accountContextKey);
      modal.close();
      contextChanged();
      try {
        const context = await request('/api/shops', { headers: { 'X-Shop-Id': previousShopId } });
        if (!isCurrentCreationResponse(intent, getContext()?.accountContextKey)) return;
        if (context.accountContextKey !== intent.accountContextKey || context.activeShopId !== previousShopId || !context.shops?.some(shop => shop.id === previousShopId)) throw Error('Shop context changed');
        renderContext(context);
      } catch {
        if (!isCurrentCreationResponse(intent, getContext()?.accountContextKey)) return;
        notice.hidden = false;
        notice.textContent = 'Your Shop was created. Your current Shop is still open. Reload to update your Shop list.';
        trigger.focus();
        return;
      }
      find('shopSwitchStatus').textContent = `Created ${result.shop.name}. Your current Shop is still open. Choose it under Current Shop when you’re ready.`;
      find('shopSelector').focus();
    } catch (error) {
      if (!isCurrentCreationResponse(intent, getContext()?.accountContextKey)) return;
      const failure = creationFailure(error);
      if (failure.definitive) removeCreationIntent(storage, intent.accountContextKey);
      message(failure.message, true);
      button.textContent = failure.definitive ? 'Create Shop' : 'Retry creation';
      contextChanged();
      if (modal.open) button.focus();
    } finally {
      busy = false;
      button.disabled = false;
      form.removeAttribute('aria-busy');
    }
  }
  trigger.addEventListener('click', open);
  form.addEventListener('submit', submit);
  modal.addEventListener('close', () => trigger.focus());
  return { contextChanged };
}
