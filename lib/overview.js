import { statusFor, todayISO } from './shared.js';
import { csvCell } from './export.js';

export const OVERVIEW_ROW_LIMIT = 5000;
const MAX_SHOPS = 20;
const failure = (message, status) => Object.assign(new Error(message), { status });

async function ownedShops(db, principal) {
  if (!principal?.provider || !principal?.subject) throw failure('This account is not a member of a shop.', 403);
  const { results } = await db.prepare(`SELECT h.id,h.name FROM identities i
    JOIN active_memberships m ON m.user_id=i.user_id AND m.role='owner'
    JOIN households h ON h.id=m.household_id
    WHERE i.provider=? AND i.subject=? ORDER BY LOWER(h.name),h.id LIMIT ?`).bind(principal.provider, principal.subject, MAX_SHOPS).all();
  return results || [];
}

async function shopTypes(db, ids) {
  try {
    const { results } = await db.prepare(`SELECT st.household_id,st.shop_type,c.name FROM shop_types st LEFT JOIN custom_shop_types c ON c.id=st.custom_type_id WHERE st.household_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    return new Map((results || []).map(row => [row.household_id, { base: row.shop_type, name: row.name || null }]));
  } catch { return new Map(); }
}

/**
 * Every Shop the caller OWNS (never Shops where they are only a Member), with per-Shop counts and one combined item list.
 * One owned Shop returns just that Shop. Read server-side from the verified identity, never from a client-supplied Shop.
 */
export async function ownerOverview(db, principal, clock = () => new Date()) {
  const shops = await ownedShops(db, principal);
  if (!shops.length) throw failure('Only Shop Owners can open the overview.', 403);
  const ids = shops.map(shop => shop.id), types = await shopTypes(db, ids), today = todayISO(clock());
  const summaries = new Map(shops.map(shop => [shop.id, { id: shop.id, name: shop.name, shopType: types.get(shop.id)?.base || 'medicine', shopTypeName: types.get(shop.id)?.name || null, counts: { total: 0, expired: 0, expiring: 0, low: 0, healthy: 0, unknown: 0 }, truncated: false }]));
  const items = [];
  for (const shop of shops) {
    const { results } = await db.prepare(`SELECT id,name,strength,form,quantity,unit,expiry_date,location,low_stock_threshold
      FROM batches WHERE household_id=? AND discarded_at IS NULL AND quantity>0
      ORDER BY expiry_date IS NULL, expiry_date, LOWER(name), id LIMIT ?`).bind(shop.id, OVERVIEW_ROW_LIMIT + 1).all();
    const rows = results || [], summary = summaries.get(shop.id);
    summary.truncated = rows.length > OVERVIEW_ROW_LIMIT;
    for (const row of rows.slice(0, OVERVIEW_ROW_LIMIT)) {
      const status = statusFor(row, today);
      summary.counts.total += 1;
      summary.counts[status] += 1;
      items.push({ shopId: shop.id, shopName: shop.name, ...row, status });
    }
  }
  return { generatedAt: clock().toISOString(), today, shops: [...summaries.values()], items };
}

const COLUMNS = ['shop', 'name', 'strength', 'form', 'quantity', 'unit', 'expiry_date', 'location', 'low_stock_threshold', 'status'];

/** One CSV across every owned Shop, with the same formula-injection guard as the per-Shop export. */
export async function ownerOverviewCsv(db, principal, clock = () => new Date()) {
  const overview = await ownerOverview(db, principal, clock);
  const lines = [COLUMNS.join(',')];
  for (const item of overview.items) lines.push(COLUMNS.map(column => csvCell(column === 'shop' ? item.shopName : item[column])).join(','));
  return { filename: `all-shops-inventory-${overview.generatedAt.slice(0, 10)}.csv`, csv: `﻿${lines.join('\r\n')}\r\n`, rows: overview.items.length };
}
