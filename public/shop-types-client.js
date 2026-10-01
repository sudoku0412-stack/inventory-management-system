// Owner-defined Shop types: a dialog to create, edit and delete them, plus the Shop type selects (Profile and Create Shop).
// Types are private to the Owner who made them. Built-in types (Medicine, General goods) are always offered.
const LIST_LABELS = { form: 'Form / category', unit: 'Unit', location: 'Storage location', strength: 'Strength suggestions' };
const BUILTIN = [{ key: 'medicine', name: 'Medicine' }, { key: 'goods', name: 'General goods' }, { key: 'blank', name: 'Blank (one starter per list)' }];
const LABEL_SUGGESTIONS = ['Form', 'Category', 'Type', 'Kind', 'Group'];

export function bindShopTypes({ document, api, getContext, getCurrentKey, toast }) {
  const $ = id => document.querySelector(`#${id}`);
  const modal = $('shopTypesModal'), listHost = $('shopTypesList'), form = $('newShopTypeForm'), status = $('shopTypesStatus');
  let data = { builtin: BUILTIN, custom: [] };

  const isOwner = () => Boolean(getContext()?.shops?.some(shop => shop.role === 'owner'));
  const say = (message, error = false) => { if (status) { status.textContent = message; status.classList?.toggle('error', error); } };
  const make = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
  const errorText = error => error?.status === 0 || error?.message === 'Failed to fetch' ? 'Shop types need a connection.' : (error?.message || 'Something went wrong.');

  function fillSelect(select, keepValue) {
    if (!select) return;
    const wanted = keepValue ?? select.value;
    // The Shop's current type stays listed even when it is another Owner's type that this account cannot pick.
    for (const option of [...select.options]) if (option.dataset?.custom && option.value !== wanted) option.remove();
    for (const type of data.custom) {
      if ([...select.options].some(option => option.value === type.key)) continue;
      const option = make('option', { value: type.key, textContent: type.name });
      option.dataset.custom = 'true';
      select.append(option);
    }
    if ([...select.options].some(option => option.value === wanted)) select.value = wanted;
  }

  function renderSelects() {
    fillSelect($('shopTypeSelect'), getCurrentKey?.());
    fillSelect($('createShopType'));
    const start = $('newShopTypeStart');
    if (start) {
      const wanted = start.value;
      start.replaceChildren(...[...BUILTIN, ...data.custom.map(type => ({ key: type.key, name: type.name }))].map(type => make('option', { value: type.key, textContent: type.name })));
      if ([...start.options].some(option => option.value === wanted)) start.value = wanted;
    }
  }

  function listEditor(type, list) {
    const block = make('div', { className: 'options-list' }, make('h4', { textContent: LIST_LABELS[list] }));
    const chips = make('ul', { className: 'options-chips' });
    for (const value of type.lists[list]) {
      const remove = make('button', { type: 'button', className: 'text-button', textContent: 'Remove' });
      remove.setAttribute('aria-label', `Remove ${value} from ${LIST_LABELS[list]} in ${type.name}`);
      remove.addEventListener('click', () => change('/api/shop-types/options', { id: type.id, list, value, action: 'remove' }));
      chips.append(make('li', { className: 'option-chip' }, make('span', { textContent: value }), remove));
    }
    const input = make('input', { type: 'text', maxLength: 30, placeholder: `Add to ${LIST_LABELS[list]}` });
    input.setAttribute('aria-label', `New ${LIST_LABELS[list]} option for ${type.name}`);
    const add = make('form', { className: 'options-add' }, input, make('button', { type: 'submit', className: 'button secondary', textContent: 'Add' }));
    add.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) change('/api/shop-types/options', { id: type.id, list, value: input.value, action: 'add' }); });
    block.append(chips, add);
    return block;
  }

  function typeBlock(type) {
    const details = make('details', { className: 'shop-type' });
    details.append(make('summary', { textContent: `${type.name} · ${type.shopCount} ${type.shopCount === 1 ? 'Shop' : 'Shops'}` }));
    const name = make('input', { type: 'text', maxLength: 40, value: type.name, required: true });
    name.setAttribute('aria-label', `Name of ${type.name}`);
    const strength = make('input', { type: 'checkbox', checked: type.usesStrength });
    const label = make('input', { type: 'text', maxLength: 20, value: type.formLabel, required: true });
    label.setAttribute('list', 'formLabelOptions');
    const save = make('button', { type: 'submit', className: 'button secondary', textContent: 'Save type' });
    const settings = make('form', { className: 'shop-type-settings' },
      make('label', { className: 'form-field' }, make('span', { textContent: 'Name' }), name),
      make('label', { className: 'check-row' }, strength, make('span', { textContent: 'Show the Strength field' })),
      make('label', { className: 'form-field' }, make('span', { textContent: 'Label for Form' }), label), save);
    settings.addEventListener('submit', event => { event.preventDefault(); change('/api/shop-types/update', { id: type.id, name: name.value, usesStrength: strength.checked, formLabel: label.value }); });
    const remove = make('button', { type: 'button', className: 'button secondary danger-button', textContent: 'Delete type', disabled: type.shopCount > 0 });
    remove.setAttribute('aria-label', `Delete ${type.name}`);
    remove.addEventListener('click', () => change('/api/shop-types/delete', { id: type.id }));
    const note = make('p', { className: 'access-meta', textContent: type.shopCount ? 'Move its Shops to another type before deleting it.' : 'Deleting a type never changes saved items.' });
    details.append(settings, ...['form', 'unit', 'location', 'strength'].map(list => listEditor(type, list)), note, remove);
    return details;
  }

  function render() {
    if (!listHost) return;
    listHost.replaceChildren(...(data.custom.length ? data.custom.map(typeBlock) : [make('p', { className: 'access-meta', textContent: 'You have no Shop types of your own yet. Create one above.' })]));
    renderSelects();
  }

  function refreshButton() {
    const button = $('openShopTypes');
    if (button) button.hidden = !isOwner();
    const card = $('shopTypesCard');
    if (card) card.hidden = !isOwner();
  }

  async function load() {
    refreshButton();
    if (!isOwner()) return null;
    try {
      data = await api('/api/shop-types');
      render();
      return data;
    } catch { return null; }
  }

  async function change(path, body) {
    try {
      const open = new Set([...listHost.querySelectorAll('details[open] summary')].map(node => node.textContent.split(' · ')[0]));
      data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      render();
      for (const node of listHost.querySelectorAll('details')) if (open.has(node.firstChild?.textContent?.split(' · ')[0])) node.open = true;
      say('Saved.');
      return true;
    } catch (error) {
      say(errorText(error), true); toast?.(errorText(error));
      return false;
    }
  }

  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { say('Enter a name for the Shop type.', true); return; }
    const ok = await change('/api/shop-types', { name, startFrom: form.elements.startFrom.value, usesStrength: form.elements.usesStrength.checked, formLabel: form.elements.formLabel.value });
    if (ok) { form.elements.name.value = ''; say(`${name} created. Choose it under Profile → Shop, or when creating a Shop.`); }
  });
  // Starting from another type copies how it behaves; the choices stay editable.
  $('newShopTypeStart')?.addEventListener('change', event => {
    const source = data.custom.find(type => type.key === event.target.value);
    const usesStrength = source ? source.usesStrength : event.target.value === 'medicine';
    const formLabel = source ? source.formLabel : event.target.value === 'medicine' ? 'Form' : 'Category';
    form.elements.usesStrength.checked = usesStrength; form.elements.formLabel.value = formLabel;
  });
  // Tap-to-fill suggestions for the label; the field stays free text.
  const chips = $('formLabelChips');
  if (chips) chips.replaceChildren(...LABEL_SUGGESTIONS.map(value => {
    const chip = make('button', { type: 'button', className: 'suggest-chip', textContent: value });
    chip.addEventListener('click', () => { form.elements.formLabel.value = value; });
    return chip;
  }));
  $('openShopTypes')?.addEventListener('click', async () => { say(''); await load(); if (modal && !modal.open) modal.showModal(); });

  return { refresh: load, renderSelects, get types() { return data; } };
}
