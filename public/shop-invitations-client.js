import { validAccountContextKey } from './shop-creation-client.js';

export const joinIntentStorageKey = 'shop-invitation-join-intents';
export const pendingInvitationsPath = '/api/household/invitations/pending';
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const cursorShape = /^[A-Za-z0-9_-]{1,512}$/;
const capMessage = 'You can belong to up to 50 Shops.';
const copy = {
  loading: 'Loading Shop invitations…',
  empty: 'No Shop invitations for this account.',
  loadError: 'We couldn’t load Shop invitations. Check your connection and try again.',
  unavailable: 'Shop invitations are temporarily unavailable. Try again later.',
  moreError: 'We couldn’t load more invitations. Try again.',
  gone: 'This invitation expired, was revoked, or is no longer available.',
  cap: 'You can belong to up to 50 Shops. You can’t join another Shop right now.',
  member: 'You already belong to this Shop.',
  rejected: 'Shop joining isn’t available for this account. Reload and try again.',
  storage: 'Safe retry storage is unavailable. You haven’t joined this Shop.'
};

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const malformed = message => Object.assign(Error(message), { malformed: true });

/** Exact deployed pending-discovery shape. The legacy `member` flag is validated and then dropped. */
export function decodePendingPage(data) {
  if (!hasExactKeys(data, ['invitations', 'nextCursor', 'member']) || typeof data.member !== 'boolean' || !Array.isArray(data.invitations) || data.invitations.length > 20) throw malformed('Invitation list was not recognized.');
  if (data.nextCursor !== null && !(typeof data.nextCursor === 'string' && cursorShape.test(data.nextCursor))) throw malformed('Invitation list was not recognized.');
  const seen = new Set();
  const invitations = data.invitations.map(item => {
    if (!hasExactKeys(item, ['id', 'household_name', 'role', 'expires_at']) || typeof item.id !== 'string' || !opaqueId.test(item.id) || seen.has(item.id)
      || typeof item.household_name !== 'string' || !item.household_name.trim() || item.household_name.length > 200
      || !inviteRoles.has(item.role) || typeof item.expires_at !== 'string' || item.expires_at.length > 64 || Number.isNaN(Date.parse(item.expires_at))) throw malformed('Invitation list was not recognized.');
    seen.add(item.id);
    return { id: item.id, household_name: item.household_name, role: item.role, expires_at: item.expires_at };
  });
  return { invitations, nextCursor: data.nextCursor };
}

/** HTTP 200 counts as a confirmed join only for exactly this payload. */
export function decodeAcceptance(data) {
  if (!hasExactKeys(data, ['householdId', 'role', 'accepted']) || typeof data.householdId !== 'string' || !canonicalUuid.test(data.householdId) || !inviteRoles.has(data.role) || typeof data.accepted !== 'boolean') throw malformed('Join response was not recognized.');
  return { householdId: data.householdId, role: data.role, accepted: data.accepted };
}

export function retryDuration(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function validRetryAfter(value) {
  return Number.isInteger(value) && value >= 1 && value <= 3600 ? value : null;
}

function readIntents(storage) {
  try {
    const value = JSON.parse(storage.getItem(joinIntentStorageKey) || '{}');
    return isPlainObject(value) ? value : {};
  } catch { return {}; }
}

const inviteRoles = new Set(['member', 'owner']);
const roleName = role => role === 'owner' ? 'Owner' : 'Member';
const roleWithArticle = role => role === 'owner' ? 'an Owner' : 'a Member';

function validIntent(value, accountContextKey) {
  return hasExactKeys(value, ['accountContextKey', 'invitationId', 'householdName', 'role', 'expiresAt', 'currentShopId'])
    && value.accountContextKey === accountContextKey && typeof value.invitationId === 'string' && opaqueId.test(value.invitationId)
    && typeof value.householdName === 'string' && value.householdName.length > 0 && inviteRoles.has(value.role)
    && typeof value.expiresAt === 'string' && typeof value.currentShopId === 'string';
}

export function joinIntentForAccount(storage, accountContextKey) {
  if (!validAccountContextKey(accountContextKey)) return null;
  const value = readIntents(storage)[accountContextKey];
  return validIntent(value, accountContextKey) ? value : null;
}

/** Called before dispatch; a false return means the request must not be sent. */
export function persistJoinIntent(storage, intent) {
  try {
    storage.setItem(joinIntentStorageKey, JSON.stringify({ ...readIntents(storage), [intent.accountContextKey]: intent }));
    return joinIntentForAccount(storage, intent.accountContextKey)?.invitationId === intent.invitationId;
  } catch { return false; }
}

export function removeJoinIntent(storage, accountContextKey) {
  const intents = readIntents(storage);
  delete intents[accountContextKey];
  try { storage.setItem(joinIntentStorageKey, JSON.stringify(intents)); } catch {}
}

function formatExpiry(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Not available' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

export function bindShopInvitations({
  document, storage, getContext, request, renderContext, switchToShop,
  schedule = callback => requestAnimationFrame(callback), now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = handle => clearTimeout(handle)
}) {
  const node = id => document.querySelector(`#${id}`);
  const card = node('shopInvitationsCard'), list = node('shopInvitationsList'), status = node('shopInvitationsStatus');
  const refresh = node('shopInvitationsRefresh'), more = node('shopInvitationsMore'), checkPrevious = node('shopInvitationsCheckPrevious');
  const switchButton = node('shopInvitationsSwitch'), reload = node('shopInvitationsReload');
  const modal = node('joinShopModal'), form = node('joinShopForm'), title = node('joinShopTitle'), help = node('joinShopHelp');
  const access = node('joinShopAccess'), dialogStatus = node('joinShopStatus'), cancel = node('cancelJoinShop'), submit = node('confirmJoinShop');
  const selector = node('shopSelector'), badge = node('peopleTabBadge');

  let key = null, epoch = 0, profileActive = false, unsupported = false;
  let invitations = [], cursor = null, seenCursors = new Set(), phase = 'idle', moreError = false, loadingMore = false, loadToken = 0;
  let discoveryBlockedUntil = 0, joinBlockedUntil = 0, rateText = '', joinRateText = '', timer = null;
  let notice = '', noticeError = false;
  let inFlight = null, capBlocked = new Set(), joined = null, dialogFor = null, skipCloseFocus = false, selectorWasDisabled = false;
  let rowButtons = new Map();

  const context = () => getContext();
  const currentShop = () => context()?.shops?.find(shop => shop.id === context()?.activeShopId);
  const isCurrent = (accountKey, generation) => key === accountKey && epoch === generation && validAccountContextKey(context()?.accountContextKey) && context().accountContextKey === accountKey;
  const pendingIntent = () => key ? joinIntentForAccount(storage, key) : null;
  const discoveryBlocked = () => discoveryBlockedUntil > now();
  const joinBlocked = () => joinBlockedUntil > now();
  const focusLater = target => schedule(() => { if (target && !target.hidden && !target.disabled) target.focus({ preventScroll: true }); });

  function armTimer() {
    if (timer) clearTimer(timer);
    timer = null;
    const t = now(), waits = [discoveryBlockedUntil, joinBlockedUntil].filter(until => until > t).map(until => until - t);
    if (!waits.length) return;
    timer = setTimer(() => { timer = null; render(); armTimer(); }, Math.min(...waits) + 20);
  }

  function derivedText() {
    if (discoveryBlocked() && rateText) return rateText;
    if (phase === 'loading' && !invitations.length) return copy.loading;
    if (phase === 'unavailable') return copy.unavailable;
    if (phase === 'error' || phase === 'rate') return copy.loadError;
    if (moreError) return copy.moreError;
    if (phase === 'ready' && !invitations.length) return copy.empty;
    return '';
  }

  /** The People tab shows how many invitations wait for this account; "9+" when more may follow. */
  function renderBadge(count) {
    if (!badge) return;
    badge.hidden = count === 0;
    if (!count) { badge.textContent = ''; badge.removeAttribute?.('aria-label'); return; }
    badge.textContent = count > 9 || (cursor && count >= 9) ? '9+' : String(count);
    badge.setAttribute('aria-label', `${count}${cursor ? ' or more' : ''} pending ${count === 1 && !cursor ? 'invitation' : 'invitations'}`);
  }

  function render() {
    const visible = Boolean(key) && !unsupported;
    card.hidden = !visible;
    renderBadge(visible && phase === 'ready' ? invitations.length : 0);
    if (!visible) return;
    const t = now(), pending = pendingIntent(), busy = Boolean(inFlight), loading = phase === 'loading' || loadingMore;
    const text = notice || derivedText();
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('error', noticeError && Boolean(notice) || (!notice && (phase === 'error' || phase === 'unavailable' || phase === 'rate' || moreError)));
    list.setAttribute('aria-busy', String(loading));

    const focusedId = document.activeElement?.dataset?.invitationId;
    rowButtons = new Map();
    list.replaceChildren(...invitations.map(invitation => {
      const isPending = pending?.invitationId === invitation.id, isFlight = inFlight?.intent.invitationId === invitation.id;
      const expired = Date.parse(invitation.expires_at) <= t;
      const row = document.createElement('li');
      row.className = 'shop-invitation-row';
      if (isFlight) row.setAttribute('aria-busy', 'true');
      const name = document.createElement('strong');
      name.textContent = invitation.household_name;
      const role = document.createElement('span');
      role.textContent = `${roleName(invitation.role)} access`;
      const expiry = document.createElement('time');
      expiry.setAttribute('datetime', invitation.expires_at);
      expiry.textContent = expired && !isPending ? `Expired ${formatExpiry(invitation.expires_at)}` : `Expires ${formatExpiry(invitation.expires_at)}`;
      row.append(name, role, expiry);
      if (expired && !isPending) {
        const label = document.createElement('span');
        label.className = 'status-pill expired';
        label.textContent = 'Expired';
        row.append(label);
        return row;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button primary';
      button.setAttribute('data-invitation-id', invitation.id);
      button.textContent = isFlight ? 'Joining…' : isPending ? 'Retry joining' : 'Join Shop';
      button.setAttribute('aria-label', `${isFlight ? 'Joining' : isPending ? 'Retry joining' : 'Join Shop'} ${invitation.household_name}`);
      button.disabled = busy || (Boolean(pending) && !isPending) || capBlocked.has(invitation.id) || (isPending && joinBlockedUntil > t);
      button.addEventListener('click', () => startJoin(invitation));
      rowButtons.set(invitation.id, button);
      row.append(button);
      return row;
    }));
    if (focusedId && rowButtons.get(focusedId) && !rowButtons.get(focusedId).disabled) rowButtons.get(focusedId).focus({ preventScroll: true });

    const failed = phase === 'error' || phase === 'unavailable' || phase === 'rate';
    refresh.hidden = phase === 'idle';
    refresh.textContent = failed && !joined?.verified ? 'Retry' : 'Refresh invitations';
    refresh.disabled = loading || discoveryBlocked();
    more.hidden = !(cursor && phase !== 'idle');
    more.textContent = moreError ? 'Retry' : 'Show more invitations';
    more.setAttribute('aria-label', moreError ? 'Retry loading more invitations' : 'Show more invitations');
    more.disabled = loading || discoveryBlocked();
    checkPrevious.hidden = !(pending && !rowButtons.has(pending.invitationId));
    checkPrevious.disabled = busy || joinBlocked();
    switchButton.hidden = !joined?.verified;
    if (joined?.verified) switchButton.textContent = `Switch to ${joined.name}`;
    switchButton.disabled = busy;
    reload.hidden = !(joined && !joined.verified);
  }

  function reset(nextKey) {
    epoch += 1;
    key = nextKey;
    invitations = []; cursor = null; seenCursors = new Set(); phase = 'idle'; moreError = false; loadingMore = false; loadToken += 1;
    discoveryBlockedUntil = 0; joinBlockedUntil = 0; rateText = ''; joinRateText = ''; notice = ''; noticeError = false;
    capBlocked = new Set(); joined = null; unsupported = false; dialogFor = null;
    if (timer) clearTimer(timer);
    timer = null;
    if (inFlight) finishBusy();
    if (modal.open) { skipCloseFocus = true; modal.close(); }
  }

  function setNotice(text, error = false) { notice = text; noticeError = error; }

  function discoveryFailure(error, next) {
    const code = error?.status;
    if (!next && (code === 404 || code === 405)) { unsupported = true; return; }
    if (code === 429) {
      const seconds = validRetryAfter(error.retryAfter);
      discoveryBlockedUntil = now() + (seconds || 60) * 1000;
      rateText = seconds ? `Too many invitation checks. Try again in about ${retryDuration(seconds)}.` : 'Too many invitation checks. Try again in a minute.';
      if (!next) phase = 'rate'; else moreError = false;
      armTimer();
      return;
    }
    if (next) { moreError = true; return; }
    phase = code === 503 ? 'unavailable' : 'error';
  }

  async function loadFirst() {
    if (!key || unsupported || discoveryBlocked()) return false;
    const accountKey = key, generation = epoch, token = ++loadToken;
    phase = 'loading'; moreError = false; loadingMore = false; rateText = '';
    render();
    try {
      const page = decodePendingPage(await request(pendingInvitationsPath));
      if (!isCurrent(accountKey, generation) || token !== loadToken) return false;
      invitations = page.invitations; cursor = page.nextCursor; seenCursors = new Set(cursor ? [cursor] : []);
      phase = 'ready';
      render();
      return true;
    } catch (error) {
      if (!isCurrent(accountKey, generation) || token !== loadToken) return false;
      discoveryFailure(error, false);
      render();
      return false;
    }
  }

  async function loadMore() {
    if (!key || !cursor || loadingMore || phase !== 'ready' || discoveryBlocked()) return;
    const accountKey = key, generation = epoch, token = loadToken, sent = cursor;
    loadingMore = true; moreError = false;
    render();
    try {
      const page = decodePendingPage(await request(`${pendingInvitationsPath}?cursor=${encodeURIComponent(sent)}`));
      if (!isCurrent(accountKey, generation) || token !== loadToken) return;
      loadingMore = false;
      const known = new Set(invitations.map(item => item.id));
      invitations = invitations.concat(page.invitations.filter(item => !known.has(item.id)));
      if (page.nextCursor && (page.nextCursor === sent || seenCursors.has(page.nextCursor))) { cursor = null; moreError = true; render(); return; }
      cursor = page.nextCursor;
      if (cursor) seenCursors.add(cursor);
      render();
    } catch (error) {
      if (!isCurrent(accountKey, generation) || token !== loadToken) return;
      loadingMore = false;
      if (error?.malformed) { cursor = null; moreError = true; } else discoveryFailure(error, true);
      render();
    }
  }

  function dialogMessage(text, error = false) {
    dialogStatus.textContent = text;
    dialogStatus.classList.toggle('error', error);
  }

  function showDialog() {
    const pending = pendingIntent(), flying = inFlight?.intent.invitationId === dialogFor.invitationId;
    title.textContent = `Join ${dialogFor.householdName}?`;
    access.textContent = `Access: ${roleName(dialogFor.role)}`;
    help.textContent = `Your current Shop, ${currentShop()?.name || 'this Shop'}, will stay open. You can switch after joining.${dialogFor.role === 'owner' ? ' As an Owner you can invite and remove people, transfer ownership and delete this Shop.' : ''}`;
    submit.textContent = flying ? 'Joining…' : pending ? 'Retry joining' : 'Join Shop';
    submit.disabled = flying || (Boolean(pending) && joinBlocked());
    if (flying) form.setAttribute('aria-busy', 'true'); else form.removeAttribute('aria-busy');
    dialogMessage(flying ? `Joining ${dialogFor.householdName} as ${roleWithArticle(dialogFor.role)}…` : pending ? (joinBlocked() ? joinRateText : 'A previous join request needs confirmation. Retry joining to check the same invitation.') : '');
    modal.showModal();
    modal.scrollTop = 0;
    schedule(() => { if (modal.open) cancel.focus({ preventScroll: true }); });
  }

  function startJoin(invitation) {
    if (!key || !isCurrent(key, epoch)) return;
    const pending = pendingIntent();
    if (inFlight && inFlight.intent.invitationId !== invitation.id) return;
    if (pending && pending.invitationId !== invitation.id) return;
    setNotice('');
    dialogFor = pending || { accountContextKey: key, invitationId: invitation.id, householdName: invitation.household_name, role: invitation.role, expiresAt: invitation.expires_at, currentShopId: context().activeShopId };
    render();
    showDialog();
  }

  function openPrevious() {
    const pending = pendingIntent();
    if (!pending || !key || inFlight) return;
    setNotice('');
    dialogFor = pending;
    render();
    showDialog();
  }

  function closeDialog(restoreFocus) {
    if (!modal.open) return;
    skipCloseFocus = !restoreFocus;
    modal.close();
  }

  function finishBusy() {
    inFlight = null;
    selector.disabled = selectorWasDisabled;
    submit.disabled = false;
    form.removeAttribute('aria-busy');
  }

  const stillFlying = token => inFlight?.token === token && isCurrent(token.accountKey, token.epoch) && context().activeShopId === token.shopId;

  function focusResult() { focusLater(status); }
  function focusRetry(invitationId) { render(); focusLater(rowButtons.get(invitationId) || (!checkPrevious.hidden ? checkPrevious : status)); }

  async function submitJoin(event) {
    event.preventDefault();
    if (inFlight || !dialogFor || !key || !isCurrent(key, epoch) || dialogFor.accountContextKey !== key || joinBlocked()) return;
    let intent = pendingIntent();
    if (intent && intent.invitationId !== dialogFor.invitationId) return;
    if (!intent) {
      intent = { ...dialogFor };
      if (!persistJoinIntent(storage, intent)) { dialogMessage(copy.storage, true); return; }
    }
    const token = { accountKey: key, epoch, shopId: context().activeShopId };
    inFlight = { intent, token };
    selectorWasDisabled = selector.disabled;
    selector.disabled = true;
    submit.disabled = true;
    submit.textContent = 'Joining…';
    form.setAttribute('aria-busy', 'true');
    dialogMessage(`Joining ${intent.householdName} as ${roleWithArticle(intent.role)}…`);
    render();
    let data;
    try {
      data = await request(`/api/household/invitations/${encodeURIComponent(intent.invitationId)}/accept`, { method: 'POST', body: '{}' });
    } catch (error) {
      if (stillFlying(token)) joinFailure(intent, error);
      return;
    }
    if (!stillFlying(token)) return;
    let accepted;
    try { accepted = decodeAcceptance(data); } catch { ambiguous(intent, true); return; }
    await confirmedJoin(intent, accepted);
  }

  function ambiguous(intent, unsafe) {
    finishBusy();
    setNotice(`We couldn’t ${unsafe ? 'safely ' : ''}confirm whether you joined ${intent.householdName}. Retry joining to check the same invitation.`, true);
    closeDialog(false);
    focusRetry(intent.invitationId);
  }

  function joinFailure(intent, error) {
    const code = error?.status;
    finishBusy();
    if (code === 429) {
      const seconds = validRetryAfter(error.retryAfter);
      joinBlockedUntil = now() + (seconds || 60) * 1000;
      joinRateText = `Too many join attempts. Retry joining in about ${retryDuration(seconds || 60)}.`;
      setNotice(joinRateText, true);
      armTimer();
      closeDialog(false);
      render();
      focusResult();
      return;
    }
    if (code === 409 && error.message === capMessage) {
      removeJoinIntent(storage, intent.accountContextKey);
      capBlocked.add(intent.invitationId);
      setNotice(copy.cap, true);
    } else if (code === 409) {
      removeJoinIntent(storage, intent.accountContextKey);
      setNotice(copy.member, true);
      refreshMemberships().then(() => loadFirst());
    } else if (code === 404) {
      removeJoinIntent(storage, intent.accountContextKey);
      setNotice(copy.gone, true);
      loadFirst();
    } else if (code >= 400 && code < 500 && code !== 408) {
      removeJoinIntent(storage, intent.accountContextKey);
      setNotice(copy.rejected, true);
    } else {
      ambiguous(intent, false);
      return;
    }
    closeDialog(false);
    render();
    focusResult();
  }

  /** Reads memberships only. The response's preference-derived active Shop is never applied to this tab. */
  async function refreshMemberships(expectedId = null, expectedRole = 'member') {
    const accountKey = key, generation = epoch;
    try {
      const next = await request('/api/shops');
      if (!isCurrent(accountKey, generation)) return null;
      const current = context();
      const valid = isPlainObject(next) && next.accountContextKey === accountKey && Array.isArray(next.shops)
        && next.shops.every(shop => isPlainObject(shop) && typeof shop.id === 'string' && typeof shop.name === 'string')
        && next.shops.some(shop => shop.id === current.activeShopId)
        && (!expectedId || next.shops.some(shop => shop.id === expectedId && shop.role === expectedRole));
      if (!valid) return false;
      renderContext({ ...current, shops: next.shops });
      return true;
    } catch { return isCurrent(accountKey, generation) ? false : null; }
  }

  async function verifyJoin() {
    const accountKey = key, generation = epoch, target = joined;
    const [shopsOk, invitationsOk] = await Promise.all([refreshMemberships(target.id, target.role), loadFirst()]);
    if (shopsOk === null || !isCurrent(accountKey, generation) || joined !== target) return;
    if (shopsOk) {
      target.verified = true;
      if (!invitationsOk && !notice.includes('couldn’t be refreshed')) notice += ' Joined, but invitations couldn’t be refreshed.';
      render();
      if (profileActive) focusLater(switchButton);
    } else {
      target.verified = false;
      setNotice('Joined. Reload to see your Shops.');
      render();
      if (profileActive) focusLater(reload);
    }
  }

  async function confirmedJoin(intent, accepted) {
    const accountKey = intent.accountContextKey;
    removeJoinIntent(storage, accountKey);
    const currentName = currentShop()?.name || 'this Shop';
    finishBusy();
    joined = { id: accepted.householdId, name: intent.householdName, role: accepted.role, verified: false };
    setNotice(`${accepted.accepted ? 'Joined' : 'You already joined'} ${intent.householdName} as ${roleWithArticle(accepted.role)}. Your current Shop is still ${currentName}.`);
    closeDialog(false);
    render();
    await verifyJoin();
  }

  async function switchNow() {
    if (!joined?.verified || inFlight) return;
    switchButton.disabled = true;
    const outcome = await switchToShop(joined.id, { fromSelector: false });
    if (outcome === 'cancelled' || outcome === 'failed') {
      if (outcome === 'failed') setNotice('We couldn’t confirm the switch. Retry, or reload to check your active Shop.', true);
      render();
      focusLater(switchButton);
    }
  }

  function explicitLoad() { setNotice(''); return loadFirst(); }

  refresh.addEventListener('click', explicitLoad);
  more.addEventListener('click', () => { setNotice(''); loadMore(); });
  checkPrevious.addEventListener('click', openPrevious);
  switchButton.addEventListener('click', switchNow);
  reload.addEventListener('click', async () => {
    if (!joined || joined.verified) return;
    reload.disabled = true;
    try { await verifyJoin(); } finally { reload.disabled = false; }
  });
  cancel.addEventListener('click', () => { closeDialog(true); });
  form.addEventListener('submit', submitJoin);
  modal.addEventListener('close', () => {
    if (skipCloseFocus) { skipCloseFocus = false; return; }
    focusLater(rowButtons.get(dialogFor?.invitationId) || (!checkPrevious.hidden ? checkPrevious : status));
  });

  return {
    contextChanged() {
      const next = validAccountContextKey(context()?.accountContextKey) ? context().accountContextKey : null;
      if (next !== key) {
        reset(next);
        if (next && profileActive) loadFirst();
      }
      render();
    },
    profileOpened() {
      if (profileActive) return;
      profileActive = true;
      if (key && !unsupported && phase !== 'loading' && !loadingMore) loadFirst();
    },
    profileClosed() { profileActive = false; }
  };
}
