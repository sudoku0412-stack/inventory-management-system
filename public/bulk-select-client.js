// Select several inventory items and move them to another storage location or discard them in one step.
// Selecting is a mode: while it is on, tapping a row ticks it instead of opening the item. Needs a connection.
export const BULK_LIMIT = 100;

export function bindBulkSelect({ document, api, getRecords, getLocations, getForms = () => [], getFormLabel = () => 'Form', getShops = () => [], onDone, toast }) {
  const node = id => document.querySelector(`#${id}`);
  const view = node('inventoryView'), toggle = node('bulkToggle'), bar = node('bulkBar'), count = node('bulkCount');
  const all = node('bulkAll'), move = node('bulkMove'), discard = node('bulkDiscard'), cancel = node('bulkCancel');
  const form = node('bulkForm'), formModal = node('bulkFormModal'), formSelect = node('bulkFormValue'), formConfirm = node('bulkFormConfirm'), formStatus = node('bulkFormStatus'), formText = node('bulkFormText');
  const copy = node('bulkCopy'), copyModal = node('bulkCopyModal'), copySelect = node('bulkCopyShop'), copyConfirm = node('bulkCopyConfirm'), copyStatus = node('bulkCopyStatus'), copyText = node('bulkCopyText'), copyProblems = node('bulkCopyProblems');
  const moveModal = node('bulkMoveModal'), moveSelect = node('bulkMoveLocation'), moveConfirm = node('bulkMoveConfirm'), moveStatus = node('bulkMoveStatus');
  const discardModal = node('bulkDiscardModal'), discardText = node('bulkDiscardText'), discardConfirm = node('bulkDiscardConfirm'), discardStatus = node('bulkDiscardStatus');
  if (!view || !toggle || !bar) return { refresh() {}, get active() { return false; } };
  let active = false, busy = false;
  const selected = new Set();
  const plural = n => `${n} ${n === 1 ? 'item' : 'items'}`;

  function refresh() {
    const known = new Set(getRecords().map(item => item.id));
    for (const id of [...selected]) if (!known.has(id)) selected.delete(id);
    view.classList.toggle('bulk-mode', active);
    toggle.setAttribute('aria-pressed', String(active));
    toggle.textContent = active ? 'Done selecting' : 'Select items';
    bar.hidden = !active;
    for (const row of view.querySelectorAll('[data-batch-id]')) {
      const on = selected.has(row.dataset.batchId);
      row.classList.toggle('selected', active && on);
      if (active) row.setAttribute('aria-selected', String(on)); else row.removeAttribute('aria-selected');
    }
    count.textContent = selected.size ? `${plural(selected.size)} selected` : 'Tap items to select them';
    for (const button of [move, discard, form, copy]) if (button) button.disabled = busy || selected.size === 0;
    if (form) form.textContent = `Change ${getFormLabel().toLowerCase()}…`;
    if (copy) copy.hidden = getShops().length === 0;
    all.textContent = selected.size && selected.size === getRecords().length ? 'Clear selection' : 'Select all shown';
  }

  function setActive(on) { active = on; if (!on) selected.clear(); refresh(); }
  function flip(id) {
    if (selected.has(id)) selected.delete(id);
    else if (selected.size >= BULK_LIMIT) { toast?.(`You can change up to ${BULK_LIMIT} items at a time.`); return; }
    else selected.add(id);
    refresh();
  }

  toggle.addEventListener('click', () => setActive(!active));
  cancel?.addEventListener('click', () => setActive(false));
  all.addEventListener('click', () => {
    const shown = getRecords().map(item => item.id);
    if (selected.size === shown.length) selected.clear(); else for (const id of shown.slice(0, BULK_LIMIT)) selected.add(id);
    refresh();
  });

  // Runs before the page's own row handler so a tap ticks the row instead of opening it.
  function interceptClick(event) {
    if (!active) return;
    const row = event.target.closest?.('#inventoryTableBody [data-batch-id], #mobileInventory [data-batch-id]');
    if (!row) return;
    event.preventDefault(); event.stopPropagation();
    flip(row.dataset.batchId);
  }
  function interceptKey(event) {
    if (!active || (event.key !== 'Enter' && event.key !== ' ')) return;
    const row = event.target.closest?.('#inventoryTableBody [data-batch-id]');
    if (!row) return;
    event.preventDefault(); event.stopPropagation();
    flip(row.dataset.batchId);
  }
  document.addEventListener('click', interceptClick, true);
  document.addEventListener('keydown', interceptKey, true);

  async function send(body, statusNode, confirmButton, doneText, { path = '/api/batches/bulk', modal = null, problemsNode = null } = {}) {
    if (busy) return;
    busy = true; confirmButton.disabled = true; statusNode.textContent = 'Working…'; if (problemsNode) problemsNode.replaceChildren(); refresh();
    try {
      const result = await api(path, { method: 'POST', body: JSON.stringify(body) });
      const message = `${doneText(result.changed)}${result.skipped ? ` Skipped ${result.skipped} that no longer ${result.skipped === 1 ? 'exists' : 'exist'}.` : ''}`;
      statusNode.textContent = '';
      toast?.(message);
      (modal || (body.action === 'move' ? moveModal : discardModal))?.close?.();
      setActive(false);
      await onDone?.(result);
    } catch (error) {
      statusNode.textContent = error.status === 0 || error.message === 'Failed to fetch' ? 'This needs a connection. Try again when you are online.' : error.message;
      if (problemsNode) problemsNode.replaceChildren(...(error.problems || []).map(item => Object.assign(document.createElement('li'), { textContent: `${item.name || `Row ${item.row}`}: ${item.message}` })));
    } finally { busy = false; confirmButton.disabled = false; refresh(); }
  }

  move.addEventListener('click', () => {
    if (!selected.size || busy) return;
    const locations = getLocations();
    moveSelect.replaceChildren(...locations.map(value => Object.assign(document.createElement('option'), { value, textContent: value })));
    moveStatus.textContent = locations.length ? '' : 'Add a storage location under Manage lists first.';
    moveConfirm.disabled = !locations.length;
    node('bulkMoveText').textContent = `Move ${plural(selected.size)} to:`;
    if (moveModal && !moveModal.open) moveModal.showModal();
  });
  moveConfirm.addEventListener('click', () => send({ action: 'move', ids: [...selected], location: moveSelect.value }, moveStatus, moveConfirm, n => `Moved ${plural(n)} to ${moveSelect.value}.`));

  discard.addEventListener('click', () => {
    if (!selected.size || busy) return;
    discardText.textContent = `Discard ${plural(selected.size)}? They leave your inventory and their reminders stop. This cannot be undone.`;
    discardStatus.textContent = '';
    if (discardModal && !discardModal.open) discardModal.showModal();
  });
  discardConfirm.addEventListener('click', () => send({ action: 'discard', ids: [...selected] }, discardStatus, discardConfirm, n => `Discarded ${plural(n)}.`));

  form?.addEventListener('click', () => {
    if (!selected.size || busy) return;
    const forms = getForms(), label = getFormLabel();
    formSelect.replaceChildren(...forms.map(value => Object.assign(document.createElement('option'), { value, textContent: value })));
    formStatus.textContent = forms.length ? '' : `Add a ${label.toLowerCase()} under Manage lists first.`;
    formConfirm.disabled = !forms.length;
    formText.textContent = `Set the ${label.toLowerCase()} of ${plural(selected.size)} to:`;
    if (formModal && !formModal.open) formModal.showModal();
  });
  formConfirm?.addEventListener('click', () => send({ action: 'form', ids: [...selected], form: formSelect.value }, formStatus, formConfirm, n => `Changed the ${getFormLabel().toLowerCase()} of ${plural(n)} to ${formSelect.value}.`, { modal: formModal }));

  copy?.addEventListener('click', () => {
    if (!selected.size || busy) return;
    const shops = getShops();
    copySelect.replaceChildren(...shops.map(shop => Object.assign(document.createElement('option'), { value: shop.id, textContent: shop.name })));
    copyStatus.textContent = shops.length ? '' : 'You need another Shop to copy to.';
    copyProblems?.replaceChildren();
    copyConfirm.disabled = !shops.length;
    copyText.textContent = `Copy ${plural(selected.size)} to:`;
    if (copyModal && !copyModal.open) copyModal.showModal();
  });
  copyConfirm?.addEventListener('click', () => {
    const shop = getShops().find(item => item.id === copySelect.value);
    send({ ids: [...selected], targetShopId: copySelect.value }, copyStatus, copyConfirm, n => `Copied ${plural(n)} to ${shop?.name || 'the other Shop'}. The originals stay here.`, { path: '/api/batches/copy', modal: copyModal, problemsNode: copyProblems });
  });

  return { refresh, get active() { return active; }, get selected() { return [...selected]; } };
}
