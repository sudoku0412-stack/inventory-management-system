export function isShopScoped(requestPath) {
  const path = requestPath.split('?')[0];
  return path.startsWith('/api/') && ![
    '/api/shops',
    '/api/shop/onboarding-status',
    '/api/shop/onboarding',
    '/api/household/invitations/pending'
  ].includes(path) && !/^\/api\/household\/invitations\/[^/]+\/accept$/.test(path);
}

export async function requestShopApi(fetchImpl, path, options = {}, activeShopId = null) {
  const { response = 'json', headers: suppliedHeaders = {}, ...fetchOptions } = options;
  const headers = { 'content-type': 'application/json', ...suppliedHeaders };
  if (activeShopId && isShopScoped(path)) headers['X-Shop-Id'] = activeShopId;
  const result = await fetchImpl(path, { credentials: 'same-origin', ...fetchOptions, headers });
  if (!result.ok) {
    const data = await result.json().catch(() => ({}));
    const error = Error(data.error || 'Request failed.');
    error.status = result.status;
    error.current = data.current;
    error.problems = data.problems;
    error.moreProblems = data.moreProblems;
    const retryAfter = result.headers?.get?.('retry-after');
    if (typeof retryAfter === 'string' && /^\d{1,5}$/.test(retryAfter)) error.retryAfter = Number(retryAfter);
    throw error;
  }
  if (result.status === 204) return null;
  return response === 'blob' ? result.blob() : result.json();
}

export function createBatchPhotoLoader({ request, createObjectURL, revokeObjectURL }) {
  let currentObjectUrl = null;
  let loadGeneration = 0;
  function clear(image) {
    loadGeneration += 1;
    if (currentObjectUrl) revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
    image.removeAttribute('src');
  }
  async function load({ batchId, shopId, image, isCurrent }) {
    clear(image);
    const generation = loadGeneration;
    const isCurrentLoad = () => isCurrent({ batchId, shopId }) && generation === loadGeneration;
    const blob = await request(`/api/batches/${encodeURIComponent(batchId)}/photo`, { response: 'blob' });
    if (!isCurrentLoad()) return null;
    const objectUrl = createObjectURL(blob);
    if (!isCurrentLoad()) {
      revokeObjectURL(objectUrl);
      return null;
    }
    if (currentObjectUrl) revokeObjectURL(currentObjectUrl);
    currentObjectUrl = objectUrl;
    image.src = currentObjectUrl;
    return currentObjectUrl;
  }
  return { clear, load };
}

export function mayDiscardProfileChanges(isDirty, confirm) {
  return !isDirty || confirm('Switch Shops and discard your unsaved profile changes?');
}

export async function confirmShopSwitch(request, selectedId) {
  const confirmed = await request('/api/shops', { headers: { 'X-Shop-Id': selectedId } });
  if (confirmed.activeShopId !== selectedId || !confirmed.shops?.some(shop => shop.id === selectedId)) throw Error('Switch not confirmed.');
  return confirmed;
}

export function revealSwitchAnnouncement({ pending, shell, selector, announce, schedule }) {
  if (!pending) return null;
  schedule(() => {
    if (shell.hidden) return;
    selector.focus();
    announce(`Switched to ${pending.shopName}. Showing its inventory.`);
  });
  return null;
}
