const $ = id => document.getElementById(id);
const content = $('content'), status = $('status'), more = $('more');
let cursor = null, loader = null, generation = 0;

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}
const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
const when = value => value ? new Date(value).toLocaleString() : '—';

async function get(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status}).`), { status: response.status });
  return body;
}

let writesEnabled = false;

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-admin-action': '1' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `Request failed (${response.status}).`), { status: response.status });
  return result;
}

const uuid = () => crypto.randomUUID();
const dialog = $('actionDialog'), form = $('actionForm'), reasonBox = $('actionReason'), nameBox = $('actionName'), submit = $('actionSubmit');
let pending = null, dialogTrigger = null;

// One intent (and operation id) per target, kept across dismissal so a retry replays the same request.
function openAction({ key, title, effect, verb, path, confirmName = null, days = false, extra = null, trigger, done }) {
  if (!pending || pending.key !== key) pending = { key, operationId: uuid(), path, done };
  pending.extra = extra;
  pending.days = days; $('actionDaysLabel').hidden = $('actionDays').hidden = !days; $('actionDays').value = '14';
  dialogTrigger = trigger;
  $('actionTitle').textContent = title; $('actionEffect').textContent = effect; submit.textContent = verb;
  $('actionNameLabel').hidden = nameBox.hidden = !confirmName;
  if (confirmName) { $('actionNameLabel').textContent = `Type ${confirmName} to confirm`; pending.confirmName = confirmName; }
  else pending.confirmName = null;
  reasonBox.value = ''; nameBox.value = ''; $('actionStatus').textContent = ''; syncAction();
  dialog.showModal(); $('actionCancel').focus();
}

function syncAction() {
  const reason = reasonBox.value.trim();
  $('actionCounter').textContent = `${reason.length} / 500`;
  const daysValue = Number($('actionDays').value), daysBad = pending?.days && !(Number.isInteger(daysValue) && daysValue >= 7 && daysValue <= 30);
  submit.disabled = reason.length < 10 || reason.length > 500 || Boolean(pending?.confirmName && nameBox.value.trim() !== pending.confirmName) || Boolean(daysBad);
}

reasonBox.addEventListener('input', syncAction);
nameBox.addEventListener('input', syncAction);
$('actionDays').addEventListener('input', syncAction);
$('actionCancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => dialogTrigger?.isConnected && dialogTrigger.focus());
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!pending || submit.disabled) return;
  const value = pending;
  submit.disabled = true; $('actionStatus').textContent = 'Working…';
  try {
    const result = await post(value.path, { operationId: value.operationId, reason: reasonBox.value.trim(), ...(value.days ? { keepDays: Number($('actionDays').value) } : {}), ...(value.extra || {}) });
    pending = null; dialog.close();
    status.textContent = result.changed === false ? 'Already done; nothing changed.' : 'Done. The change is recorded in the audit log.'; status.classList.remove('error');
    await value.done();
  } catch (error) {
    // Definitive failures drop the intent; ambiguous ones keep it so Retry replays the same operation.
    if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) pending = null;
    $('actionStatus').textContent = error.message; submit.disabled = !pending;
  }
});

// Tables are real tables on wide screens. On phones the stylesheet turns each row into a card and shows data-label before each value.
function table(caption, columns, rows) {
  const head = el('tr', {}, ...columns.map(column => el('th', { scope: 'col' }, column.label)));
  const body = rows.map(row => el('tr', {}, ...columns.map(column => {
    const cell = el('td', { 'data-label': column.label });
    const value = column.render ? column.render(row) : text(row[column.key]);
    cell.append(value);
    return cell;
  })));
  const wrap = el('div', { class: 'scroll' }, el('table', {}, el('caption', { class: 'sr' }, caption), el('thead', {}, head), el('tbody', {}, ...body)));
  return rows.length ? wrap : el('div', {}, el('h3', { class: 'table-title' }, caption), el('p', { class: 'note' }, 'Nothing to show yet.'));
}

const auditColumns = [
  { label: 'When', render: row => when(row.created_at) }, { label: 'Event', key: 'event' },
  { label: 'Shop', key: 'household_id' }, { label: 'Actor', key: 'actor_user_id' }, { label: 'Target', key: 'target_identifier' }
];

function setWrites(enabled) {
  writesEnabled = enabled === true;
  $('banner').textContent = writesEnabled ? 'Changes are audited. Metadata only; item contents are never shown.' : 'Read-only. Metadata only; item contents are never shown.';
  $('banner').classList.toggle('audited', writesEnabled);
}

const views = {
  async overview() {
    const data = await get('/admin/api/overview');
    $('who').textContent = `Signed in as ${data.admin}`;
    setWrites(data.writesEnabled);
    const labels = [['shops', 'Shops'], ['users', 'Users'], ['memberships', 'Memberships'], ['owners', 'Owner seats'], ['pendingInvitations', 'Pending invitations'], ['emailsNeedingAttention', 'Emails needing attention'], ['emailsQueued', 'Emails queued'], ['medicines', 'Items (count only)'], ['changeFeedRows', 'Change-feed rows'], ['auditEventsLast24h', 'Audit events, 24h'], ['appliedMigrations', 'Applied migrations'], ['migrationState', 'Migration state']];
    content.replaceChildren(el('dl', { class: 'grid' }, ...labels.map(([key, label]) => el('div', {}, el('dt', {}, label), el('dd', {}, text(data[key]))))));
    return null;
  },
  async shops(after) {
    const data = await get(`/admin/api/shops${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
    const view = table('Shops', [
      { label: 'Name', render: row => { const link = el('a', { href: `#shop/${row.id}` }, text(row.name)); return link; } },
      { label: 'Type', key: 'shop_type' }, { label: 'Owners', key: 'owner_count' }, { label: 'Members', key: 'member_count' }, { label: 'Items', key: 'medicine_count' },
      { label: 'Created', render: row => when(row.created_at) }, { label: 'Last audit', render: row => when(row.last_audit_at) }, { label: 'State', render: row => row.deleted_at ? 'Pending deletion' : 'Active' }
    ], data.shops);
    after ? content.append(view) : content.replaceChildren(view);
    return data.nextCursor;
  },
  async shop(_after, id) {
    const data = await get(`/admin/api/shops/${encodeURIComponent(id)}`);
    setWrites(data.writesEnabled);
    const reload = () => run('shop', null, id);
    const restorable = writesEnabled && data.deletion && !data.deletion.purged_at && data.deletion.purge_after > new Date().toISOString();
    const restoreButton = restorable ? el('button', { type: 'button', class: 'primary' }, 'Restore Shop') : null;
    const extendButton = restorable ? el('button', { type: 'button' }, 'Extend deadline') : null;
    extendButton?.addEventListener('click', () => openAction({ key: `extend:${id}`, title: `Extend the deadline for ${data.shop.name}?`, effect: 'Moves the permanent-deletion date later, counted from today. It never shortens it.', verb: 'Extend deadline', path: `/admin/api/shops/${encodeURIComponent(id)}/extend`, days: true, trigger: extendButton, done: reload }));
    restoreButton?.addEventListener('click', () => openAction({ key: `restore:${id}`, title: `Restore ${data.shop.name}?`, effect: 'Members regain their access. Invitations and push subscriptions removed at deletion are not restored.', verb: 'Restore Shop', path: `/admin/api/shops/${encodeURIComponent(id)}/restore`, confirmName: data.shop.name, trigger: restoreButton, done: reload }));
    const flagCell = row => {
      if (!writesEnabled) return '';
      const box = el('span', { class: 'flagbtns' });
      for (const [label, value, state] of [['Turn on', true, 'on'], ['Turn off', false, 'off'], ['Follow global', null, 'default']]) {
        if ((row.override === null ? null : row.override) === value) continue;
        const button = el('button', { type: 'button', class: value === false ? 'danger' : '', 'aria-label': `${label}: ${row.label}` }, label);
        button.addEventListener('click', () => openAction({ key: `flag:${id}:${row.flag}:${state}`, title: `${label}: ${row.label}?`, effect: `${row.help} This changes only ${data.shop.name}, and applies on its next request.`, verb: label, path: `/admin/api/shops/${encodeURIComponent(id)}/flags`, extra: { flag: row.flag, value }, trigger: button, done: reload }));
        box.append(button);
      }
      return box;
    };
    const revokeCell = row => {
      if (!writesEnabled || !row.pending) return '';
      const button = el('button', { type: 'button', class: 'danger', 'aria-label': `Revoke invitation for ${row.email}` }, 'Revoke');
      button.addEventListener('click', () => openAction({ key: `revoke:${row.id}`, title: `Revoke the invitation for ${row.email}?`, effect: 'They will no longer be able to join this Shop with this invitation.', verb: 'Revoke invitation', path: `/admin/api/shops/${encodeURIComponent(id)}/invitations/${encodeURIComponent(row.id)}/revoke`, trigger: button, done: reload }));
      return button;
    };
    content.replaceChildren(
      el('h2', {}, text(data.shop.name)),
      el('p', {}, `ID ${data.shop.id} · created ${when(data.shop.created_at)} · ${data.shop.medicine_count} items (count only)`),
      el('div', { class: 'typebox' },
        el('p', { class: 'typehead' }, `Shop type: ${data.shopType.name}${data.shopType.custom ? ` (made by ${data.shopType.ownerEmail || 'a former Owner'})` : ''}`),
        el('p', { class: 'note' }, `Strength ${data.shopType.usesStrength ? 'shown' : 'hidden'} · Form labelled ${data.shopType.formLabel}`),
        ...['form', 'unit', 'location', 'strength'].map(list => el('p', { class: 'note' }, `${{ form: 'Form / category', unit: 'Unit', location: 'Storage location', strength: 'Strength' }[list]}: ${data.shopType.lists[list].length ? data.shopType.lists[list].join(', ') : '—'}`))),
      ...(data.deletion ? [el('p', { class: 'note' }, data.deletion.purged_at ? `Purged ${when(data.deletion.purged_at)}.` : `Pending deletion since ${when(data.deletion.deleted_at)}; permanently purged after ${when(data.deletion.purge_after)}.`)] : []),
      ...(restoreButton ? [restoreButton, extendButton] : []),
      ...(writesEnabled || data.flags?.length ? [el('h2', {}, 'Feature flags for this Shop'), el('p', { class: 'note' }, 'A change applies on the next request. Follow global uses the Worker secret.'), table('Feature flags', [
        { label: 'Flag', render: row => row.label },
        { label: 'Now', render: row => row.effective ? 'On' : 'Off' },
        { label: 'Setting', render: row => row.override === null ? `Follow global (${row.global ? 'on' : 'off'})` : row.override ? 'Forced on' : 'Forced off' },
        { label: 'Change', render: flagCell }
      ], data.flags || [])] : []),
      el('h2', {}, 'Members'),
      table('Members', [{ label: 'Email', key: 'email' }, { label: 'Role', key: 'role' }, { label: 'Joined', render: row => when(row.joined_at) }, { label: 'User ID', key: 'user_id' }], data.members),
      el('h2', {}, 'Invitations'),
      table('Invitations', [{ label: 'Email', key: 'email' }, { label: 'Created', render: row => when(row.created_at) }, { label: 'Expires', render: row => when(row.expires_at) }, { label: 'Pending', render: row => row.pending ? 'Yes' : 'No' }, { label: 'Action', render: revokeCell }], data.invitations),
      el('h2', {}, 'Recent audit events'),
      table('Recent audit events', auditColumns, data.audit)
    );
    return null;
  },
  async audit(after) {
    const data = await get(`/admin/api/audit${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
    const view = table('Audit events', auditColumns, data.events);
    after ? content.append(view) : content.replaceChildren(view);
    return data.nextCursor;
  },
  async types(after) {
    const data = await get(`/admin/api/shop-types${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
    setWrites(data.writesEnabled);
    const names = { form: 'Form / category', unit: 'Unit', location: 'Storage location', strength: 'Strength' };
    const reload = () => run('types');
    const lists = row => el('div', {}, ...Object.keys(names).map(list => el('p', {}, el('strong', {}, `${names[list]}: `), text(row.lists[list].length ? row.lists[list].join(', ') : '—'))));
    // Staff edits: settings and list values. Each change asks for a reason and is recorded in the audit log.
    const editor = row => {
      if (!writesEnabled) return null;
      const name = el('input', { type: 'text', maxlength: '40', value: row.name, 'aria-label': `Name of ${row.name}` });
      const label = el('input', { type: 'text', maxlength: '20', value: row.form_label, 'aria-label': `Form label of ${row.name}` });
      const strength = el('input', { type: 'checkbox', 'aria-label': `Show Strength for ${row.name}` });
      strength.checked = Boolean(row.uses_strength);
      const save = el('button', { type: 'button', class: 'primary' }, 'Save settings…');
      save.addEventListener('click', () => {
        const extra = { name: name.value, usesStrength: strength.checked, formLabel: label.value };
        openAction({ key: `type:${row.id}:${JSON.stringify(extra)}`, title: `Change ${row.name}?`, effect: 'Changes this Owner’s Shop type. Shops that use it see the new name, label and Strength setting. Saved items are not changed.', verb: 'Save settings', path: `/admin/api/shop-types/${encodeURIComponent(row.id)}/update`, extra, trigger: save, done: reload });
      });
      const box = el('div', { class: 'typeedit' }, el('p', {}, el('label', {}, 'Name ', name), ' ', el('label', {}, 'Form label ', label), ' ', el('label', {}, strength, ' Show Strength'), ' ', save));
      for (const list of Object.keys(names)) {
        const line = el('p', { class: 'listrow' }, el('strong', {}, `${names[list]}: `));
        for (const value of row.lists[list]) {
          const remove = el('button', { type: 'button', class: 'danger', 'aria-label': `Remove ${value} from ${names[list]} of ${row.name}` }, `${value} ×`);
          remove.addEventListener('click', () => openAction({ key: `typeopt:${row.id}:${list}:${value}:remove`, title: `Remove “${value}”?`, effect: `Removes it from ${row.name}’s ${names[list].toLowerCase()} list for new Shops and for Shops using the type. Saved items keep their value.`, verb: 'Remove', path: `/admin/api/shop-types/${encodeURIComponent(row.id)}/options`, extra: { list, value, action: 'remove' }, trigger: remove, done: reload }));
          line.append(remove, ' ');
        }
        const input = el('input', { type: 'text', maxlength: '30', 'aria-label': `New ${names[list]} option for ${row.name}` }), add = el('button', { type: 'button', class: 'primary' }, 'Add');
        add.addEventListener('click', () => {
          if (!input.value.trim()) { status.textContent = 'Type a value to add first.'; status.classList.add('error'); return; }
          openAction({ key: `typeopt:${row.id}:${list}:${input.value}:add`, title: `Add “${input.value.trim()}”?`, effect: `Adds it to ${row.name}’s ${names[list].toLowerCase()} list.`, verb: 'Add', path: `/admin/api/shop-types/${encodeURIComponent(row.id)}/options`, extra: { list, value: input.value, action: 'add' }, trigger: add, done: reload });
        });
        line.append(input, ' ', add);
        box.append(line);
      }
      return box;
    };
    const view = el('div', {}, el('p', { class: 'note' }, writesEnabled ? 'Shop types Owners created for their own Shops: configuration only, never item contents. Changes need a reason and are audited. Built-in types are under Lists.' : 'Read-only here. Shop types Owners created for their own Shops: configuration only, never item contents. Built-in types are under Lists.'),
      table('Shop types made by Owners', [
        { label: 'Name', key: 'name' }, { label: 'Owner', key: 'owner_email' }, { label: 'Started as', render: row => row.base_type === 'goods' ? 'General goods' : 'Medicine' },
        { label: 'Strength', render: row => row.uses_strength ? 'Shown' : 'Hidden' }, { label: 'Form label', key: 'form_label' }, { label: 'Shops', key: 'shop_count' },
        { label: 'Created', render: row => when(row.created_at) }, { label: 'Lists', render: row => el('div', {}, lists(row), ...[editor(row)].filter(Boolean)) }
      ], data.types));
    after ? content.append(view) : content.replaceChildren(view);
    return data.nextCursor;
  },
  async lists() {
    const data = await get('/admin/api/option-defaults');
    setWrites(data.writesEnabled);
    const names = { medicine: 'Medicine Shops', goods: 'General goods Shops' }, listNames = { form: 'Form / category', unit: 'Unit', location: 'Storage location', strength: 'Strength suggestions' };
    const wrap = el('div', {}, el('p', { class: 'note' }, 'Defaults for new and existing Shops of each type. Shop Owners can still add or hide options in their own Shop. Removing a default never changes saved items.'));
    for (const type of ['medicine', 'goods']) {
      wrap.append(el('h2', {}, names[type]));
      for (const list of ['form', 'unit', 'location', 'strength']) {
        if (list === 'strength' && type === 'goods') continue;
        const row = el('p', { class: 'listrow' }, el('strong', {}, `${listNames[list]}: `));
        for (const value of data[type][list]) {
          const remove = el('button', { type: 'button', class: 'danger', 'aria-label': `Remove ${value} from ${names[type]} ${listNames[list]}` }, `${value} ×`);
          remove.disabled = !writesEnabled;
          remove.addEventListener('click', async () => { try { await post('/admin/api/option-defaults', { action: 'remove', shopType: type, list, value }); run('lists'); } catch (error) { status.textContent = error.message; status.classList.add('error'); } });
          row.append(remove, ' ');
        }
        const input = el('input', { type: 'text', maxlength: '30', 'aria-label': `New ${listNames[list]} option for ${names[type]}` }), add = el('button', { type: 'button', class: 'primary' }, 'Add');
        input.disabled = add.disabled = !writesEnabled;
        add.addEventListener('click', async () => { try { await post('/admin/api/option-defaults', { action: 'add', shopType: type, list, value: input.value }); run('lists'); } catch (error) { status.textContent = error.message; status.classList.add('error'); } });
        row.append(input, ' ', add);
        wrap.append(row);
      }
    }
    content.replaceChildren(wrap);
    return null;
  },
  async email(after) {
    const data = await get(`/admin/api/email-outbox${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
    const view = table('Emails not yet sent', [{ label: 'Queued', render: row => when(row.created_at) }, { label: 'Type', key: 'kind' }, { label: 'To', key: 'recipient_email' }, { label: 'Status', key: 'status' }, { label: 'Attempts', key: 'attempts' }, { label: 'Last error', render: row => row.last_error || '' }], data.emails);
    after ? content.append(view) : content.replaceChildren(view);
    return data.nextCursor;
  },
  async activity(after) {
    const data = await get(`/admin/api/admin-audit${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
    const view = table('Admin log', [{ label: 'When', render: row => when(row.created_at) }, { label: 'Admin', key: 'admin_email' }, { label: 'Action', key: 'action' }, { label: 'Target', key: 'target' }], data.events);
    after ? content.append(view) : content.replaceChildren(view);
    return data.nextCursor;
  }
};

async function run(name, after, arg) {
  const mine = ++generation;
  status.textContent = 'Loading…'; status.classList.remove('error'); more.hidden = true;
  try {
    const next = await views[name](after, arg);
    if (mine !== generation) return;
    cursor = next; status.textContent = '';
    more.hidden = !next;
  } catch (error) {
    if (mine !== generation) return;
    status.textContent = error.message; status.classList.add('error');
  }
}

function route() {
  const [name, arg] = (location.hash.slice(1) || 'overview').split('/');
  const tab = views[name] ? name : 'overview';
  for (const link of document.querySelectorAll('#tabs a')) {
    if (link.dataset.tab === (tab === 'shop' ? 'shops' : tab)) { link.setAttribute('aria-current', 'page'); link.scrollIntoView?.({ block: 'nearest', inline: 'center' }); } else link.removeAttribute('aria-current');
  }
  cursor = null; loader = () => run(tab, cursor, arg);
  run(tab, null, arg);
  $('main').focus({ preventScroll: true });
}

more.addEventListener('click', () => { if (cursor) loader(); });
window.addEventListener('hashchange', route);
route();
