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

function table(caption, columns, rows) {
  const head = el('tr', {}, ...columns.map(column => el('th', { scope: 'col' }, column.label)));
  const body = rows.map(row => el('tr', {}, ...columns.map(column => {
    const cell = el('td');
    const value = column.render ? column.render(row) : text(row[column.key]);
    cell.append(value);
    return cell;
  })));
  return el('div', { class: 'scroll' }, el('table', {}, el('caption', { class: 'sr' }, caption), el('thead', {}, head), el('tbody', {}, ...body)));
}

const auditColumns = [
  { label: 'When', render: row => when(row.created_at) }, { label: 'Event', key: 'event' },
  { label: 'Shop', key: 'household_id' }, { label: 'Actor', key: 'actor_user_id' }, { label: 'Target', key: 'target_identifier' }
];

const views = {
  async overview() {
    const data = await get('/admin/api/overview');
    $('who').textContent = `Signed in as ${data.admin}`;
    const labels = [['shops', 'Shops'], ['users', 'Users'], ['memberships', 'Memberships'], ['owners', 'Owner seats'], ['pendingInvitations', 'Pending invitations'], ['medicines', 'Medicines (count only)'], ['changeFeedRows', 'Change-feed rows'], ['auditEventsLast24h', 'Audit events, 24h'], ['appliedMigrations', 'Applied migrations'], ['migrationState', 'Migration state']];
    content.replaceChildren(el('dl', { class: 'grid' }, ...labels.map(([key, label]) => el('div', {}, el('dt', {}, label), el('dd', {}, text(data[key]))))));
    return null;
  },
  async shops(after) {
    const data = await get(`/admin/api/shops${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
    const view = table('Shops', [
      { label: 'Name', render: row => { const link = el('a', { href: `#shop/${row.id}` }, text(row.name)); return link; } },
      { label: 'Owners', key: 'owner_count' }, { label: 'Members', key: 'member_count' }, { label: 'Medicines', key: 'medicine_count' },
      { label: 'Created', render: row => when(row.created_at) }, { label: 'Last audit', render: row => when(row.last_audit_at) }
    ], data.shops);
    after ? content.append(view) : content.replaceChildren(view);
    return data.nextCursor;
  },
  async shop(_after, id) {
    const data = await get(`/admin/api/shops/${encodeURIComponent(id)}`);
    content.replaceChildren(
      el('h2', {}, text(data.shop.name)),
      el('p', {}, `ID ${data.shop.id} · created ${when(data.shop.created_at)} · ${data.shop.medicine_count} medicines (count only)`),
      el('h2', {}, 'Members'),
      table('Members', [{ label: 'Email', key: 'email' }, { label: 'Role', key: 'role' }, { label: 'Joined', render: row => when(row.joined_at) }, { label: 'User ID', key: 'user_id' }], data.members),
      el('h2', {}, 'Invitations'),
      table('Invitations', [{ label: 'Email', key: 'email' }, { label: 'Created', render: row => when(row.created_at) }, { label: 'Expires', render: row => when(row.expires_at) }, { label: 'Pending', render: row => row.pending ? 'Yes' : 'No' }], data.invitations),
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
    if (link.dataset.tab === (tab === 'shop' ? 'shops' : tab)) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  cursor = null; loader = () => run(tab, cursor, arg);
  run(tab, null, arg);
  $('main').focus({ preventScroll: true });
}

more.addEventListener('click', () => { if (cursor) loader(); });
window.addEventListener('hashchange', route);
route();
