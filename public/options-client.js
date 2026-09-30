// Shop-specific dropdown lists (Form, Unit, Storage location), the Shop type wording, and the Owner list editor.
// The static <option>s in index.html stay as the offline fallback until the Shop's lists load.
const LIST_LABELS = { form: 'Form / category', unit: 'Unit', location: 'Storage location' };
const SKIP = new Set(['SCRIPT', 'STYLE', 'OPTION', 'SELECT', 'TEXTAREA', 'INPUT']);
const ATTRIBUTES = ['placeholder', 'aria-label', 'title'];

/** Wording for General goods Shops. Medicine text is the source of truth in the page. */
export function goodsWording(text) {
  return String(text)
    .replace(/\ba medicine\b/g, 'an item').replace(/\bA medicine\b/g, 'An item')
    .replace(/MEDICINE CABINET/g, 'INVENTORY')
    .replace(/medicine cabinet/gi, match => match[0] === 'M' ? 'Inventory' : 'inventory')
    .replace(/Medicines/g, 'Items').replace(/medicines/g, 'items')
    .replace(/Medicine(?! (?:Inventory )?Tracker)/g, 'Item').replace(/medicine(?! (?:inventory )?tracker)/g, 'item');
}

const label = value => value.charAt(0).toUpperCase() + value.slice(1);

export function bindOptions({ document, api, getRole, getShopId, toast, storage = globalThis.localStorage, observe = true }) {
  const $ = selector => document.querySelector(selector);
  let data = null, type = 'medicine';
  const originals = new WeakMap(), applied = new WeakMap();

  function retextNode(node) {
    if (node.nodeType === 3) {
      if (!node.parentElement || SKIP.has(node.parentElement.tagName) || node.parentElement.closest('option,select,script,style')) return;
      if (applied.has(node) && applied.get(node) !== node.data) originals.delete(node);
      if (!originals.has(node)) originals.set(node, node.data);
      const next = type === 'goods' ? goodsWording(originals.get(node)) : originals.get(node);
      if (node.data !== next) node.data = next;
      applied.set(node, next);
    } else if (node.nodeType === 1 && !SKIP.has(node.tagName)) {
      for (const attribute of ATTRIBUTES) {
        if (!node.hasAttribute(attribute)) continue;
        const key = `orig${attribute.replace(/-/g, '')}`;
        if (node.dataset[key] === undefined || node.dataset[`${key}Applied`] !== node.getAttribute(attribute)) node.dataset[key] = node.getAttribute(attribute);
        const next = type === 'goods' ? goodsWording(node.dataset[key]) : node.dataset[key];
        node.setAttribute(attribute, next);
        node.dataset[`${key}Applied`] = next;
      }
      node.childNodes.forEach(retextNode);
    }
  }

  let scheduled = false;
  const observer = observe && typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; document.querySelectorAll('[data-wording]').forEach(retextNode); }, 0);
  }) : null;

  function applyType(next) {
    type = next === 'goods' ? 'goods' : 'medicine';
    document.documentElement.dataset.shopType = type;
    const strength = $('#addMedicineForm')?.elements?.strength?.closest('.form-field');
    if (strength) strength.hidden = type === 'goods';
    const formLabel = $('#addMedicineForm')?.elements?.form?.closest('.form-field')?.querySelector('span');
    // Change only the label text, so the field's info button stays.
    const labelText = formLabel?.firstChild;
    if (labelText?.nodeType === 3) labelText.nodeValue = type === 'goods' ? 'Category' : 'Form';
    const typeSelect = $('#shopTypeSelect');
    if (typeSelect) typeSelect.value = type;
    // Only elements marked data-wording are reworded, so Shop names and item names are never touched.
    const roots = [...document.querySelectorAll('[data-wording]')];
    roots.forEach(retextNode);
    observer?.disconnect();
    roots.forEach(root => observer?.observe(root, { childList: true, subtree: true, characterData: true }));
  }

  function fill(select, values, keep) {
    if (!select) return;
    const wanted = keep ?? select.value;
    select.replaceChildren(...values.map(value => Object.assign(document.createElement('option'), { value, textContent: select.name === 'unit' ? label(value) : value })));
    if (wanted && !values.includes(wanted)) {
      const saved = Object.assign(document.createElement('option'), { value: wanted, textContent: `${wanted} (saved value)` });
      saved.dataset.savedValue = 'true';
      select.append(saved);
    }
    if (wanted) select.value = wanted;
  }

  function renderSelects(lists, defaultLocation) {
    const form = $('#addMedicineForm');
    if (!form) return;
    fill(form.elements.form, lists.form);
    fill(form.elements.unit, lists.unit);
    fill(form.elements.location, lists.location, defaultLocation && lists.location.includes(defaultLocation) ? defaultLocation : undefined);
    fill($('#defaultStorageLocation'), lists.location, defaultLocation);
  }

  function renderManager(manage) {
    const card = $('#optionsCard'), host = $('#optionsLists');
    if (!card || !host) return;
    const owner = getRole() === 'owner';
    card.hidden = !owner;
    if (!owner) return;
    host.replaceChildren();
    for (const list of Object.keys(LIST_LABELS)) {
      const block = document.createElement('div');
      block.className = 'options-list';
      const heading = document.createElement('h3');
      heading.textContent = LIST_LABELS[list];
      const chips = document.createElement('ul');
      chips.className = 'options-chips';
      for (const item of manage[list]) {
        const row = document.createElement('li');
        row.className = item.hidden ? 'option-chip hidden-option' : 'option-chip';
        const name = document.createElement('span');
        name.textContent = item.hidden ? `${item.value} (hidden)` : item.value;
        const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: item.hidden ? 'Show' : 'Hide' });
        toggle.setAttribute('aria-label', `${item.hidden ? 'Show' : 'Hide'} ${item.value} in ${LIST_LABELS[list]}`);
        toggle.addEventListener('click', () => change('/api/options/hide', { list, value: item.value, hidden: !item.hidden }));
        row.append(name, toggle);
        if (item.source === 'custom') {
          const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: 'Remove' });
          remove.setAttribute('aria-label', `Remove ${item.value} from ${LIST_LABELS[list]}`);
          remove.addEventListener('click', () => change('/api/options/remove', { list, value: item.value }));
          row.append(remove);
        }
        chips.append(row);
      }
      const add = document.createElement('form');
      add.className = 'options-add';
      const input = Object.assign(document.createElement('input'), { type: 'text', maxLength: 30, placeholder: `Add to ${LIST_LABELS[list]}` });
      input.setAttribute('aria-label', `New ${LIST_LABELS[list]} option`);
      const button = Object.assign(document.createElement('button'), { type: 'submit', className: 'button secondary', textContent: 'Add' });
      add.append(input, button);
      add.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) change('/api/options', { list, value: input.value }); });
      block.append(heading, chips, add);
      host.append(block);
    }
  }

  async function change(path, body) {
    const status = $('#optionsStatus');
    try {
      data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      remember();
      show(data, currentDefault);
      if (status) status.textContent = 'Saved.';
    } catch (error) {
      if (status) status.textContent = error.message;
      toast?.(error.message);
    }
  }

  let currentDefault;
  function show(next, defaultLocation) {
    currentDefault = defaultLocation;
    renderSelects(next.lists, defaultLocation);
    renderManager(next.manage);
    applyType(next.shopType);
  }

  const cacheKey = () => `options:${getShopId?.() || ''}`;
  function remember() { try { storage?.setItem(cacheKey(), JSON.stringify(data)); } catch { /* storage may be unavailable */ } }
  function recall() { try { const raw = storage?.getItem(cacheKey()); return raw ? JSON.parse(raw) : null; } catch { return null; } }

  /** Load the active Shop's lists; falls back to the last copy on this device when offline. */
  async function load(settings) {
    const defaultLocation = settings?.default_storage_location;
    if (settings?.shop_type) applyType(settings.shop_type);
    try {
      data = await api('/api/options');
      remember();
    } catch {
      data = recall();
      if (!data) return null;
    }
    show(data, defaultLocation);
    return data;
  }

  return { load, applyType, goodsWording, term: text => type === 'goods' ? goodsWording(text) : text, get shopType() { return type; } };
}
