import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindOverview } from '../public/overview-client.js';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function fakeDom() {
  const make = () => ({ children: [], dataset: {}, hidden: false, value: '', textContent: '', listeners: {}, classList: { toggle() {} },
    replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); },
    addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute() {}, scrolled: false });
  const ids = ['overviewMessage', 'overviewCards', 'overviewShop', 'overviewShopLabel', 'overviewStatusFilter', 'overviewSearch', 'overviewRows', 'overviewEmpty', 'overviewCount', 'overviewTable', 'overviewTruncated', 'overviewReport', 'overviewCsv'];
  const nodes = Object.fromEntries(ids.map(id => [`#${id}`, make()]));
  nodes['#overviewTable'].closest = () => ({ scrollIntoView() { nodes['#overviewTable'].scrolled = true; } });
  const document = { querySelector: selector => nodes[selector], querySelectorAll: () => [], createElement: () => make(), body: make() };
  return { document, nodes };
}
const data = {
  generatedAt: '2026-10-01T00:00:00Z',
  shops: [{ id: 'a', name: 'Alpha', shopType: 'medicine', counts: { total: 1, expired: 0, expiring: 0, low: 1 } }, { id: 'b', name: 'Beta', shopType: 'goods', counts: { total: 1, expired: 0, expiring: 0, low: 0 } }],
  items: [{ shopId: 'a', shopName: 'Alpha', name: 'Aspirin', strength: '500 mg', quantity: 2, unit: 'tablet', expiry_date: '2030-01-01', location: 'Shelf', form: 'Tablets', status: 'low' }, { shopId: 'b', shopName: 'Beta', name: 'Bleach', strength: '', quantity: 9, unit: 'bottle', expiry_date: null, location: '', form: 'Cleaning', status: 'healthy' }]
};

async function opened() {
  const { document, nodes } = fakeDom();
  const overview = bindOverview({ document, api: async () => data, request: async () => null, getContext: () => ({ shops: [{ role: 'owner' }] }), toast() {} });
  await overview.opened();
  return nodes;
}

test('Show items filters the list to that Shop and scrolls to it', async () => {
  const nodes = await opened();
  assert.equal(nodes['#overviewRows'].children.length, 2);
  const card = nodes['#overviewCards'].children[1];
  const button = card.children.at(-1);
  button.listeners.click();
  assert.equal(nodes['#overviewShop'].value, 'b');
  assert.equal(nodes['#overviewRows'].children.length, 1);
  assert.equal(nodes['#overviewRows'].children[0].children[1].textContent, 'Bleach');
  assert.equal(nodes['#overviewCount'].textContent, '1 of 2 items');
  assert.equal(nodes['#overviewTable'].scrolled, true);
});

test('every overview cell is labelled so phones can show it as Label: value', async () => {
  const nodes = await opened();
  const labels = nodes['#overviewRows'].children[0].children.map(cell => cell.dataset.label);
  assert.deepEqual(labels, ['Shop', 'Item', 'Quantity', 'Expiry', 'Location', 'Status']);
});

test('on phones the overview rows are shown as cards instead of the hidden table', () => {
  assert.match(css, /#overviewView \.table-wrap \{ display: block; overflow: visible; \}/);
  assert.match(css, /#overviewTable td::before \{ content: attr\(data-label\)/);
  assert.match(css, /#overviewTable thead \{ display: none; \}/);
});
