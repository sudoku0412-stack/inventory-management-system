// Barcode lookup: this Shop's own earlier scans first, then free public databases (no API key).
// A miss is normal, not an error: the caller falls back to manual entry.
const TIMEOUT_MS = 4000;
const USER_AGENT = 'MedicineInventoryTracker/1.0 (+https://medicineinventory.craftloop.ca)';

/** Digits only, 8 to 14 long (EAN-8, UPC-E/A, EAN-13, GTIN-14). Returns null when it is not a plausible barcode. */
export function normalizeBarcode(value) {
  const digits = typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

const clean = (value, max) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

async function fetchJson(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function fromShop(db, householdId, code) {
  try {
    const row = await db.prepare('SELECT name,strength,form,unit,location FROM batch_barcodes WHERE household_id=? AND barcode=?').bind(householdId, code).first();
    return row ? { source: 'shop', name: row.name, strength: row.strength, form: row.form, unit: row.unit, location: row.location } : null;
  } catch { return null; }
}

async function fromOpenFacts(fetchImpl, code) {
  // The general "world" host answers for food; the sister databases cover cosmetics and other products.
  for (const host of ['world.openfoodfacts.org', 'world.openbeautyfacts.org', 'world.openproductsfacts.org']) {
    const data = await fetchJson(fetchImpl, `https://${host}/api/v2/product/${code}.json?fields=product_name,brands,quantity`);
    const name = clean(data?.product?.product_name, 120);
    if (data?.status === 1 && name) {
      const brand = clean(data.product.brands?.split(',')[0], 60);
      return { source: 'openfacts', name, brand, strength: '' };
    }
  }
  return null;
}

async function fromOpenFda(fetchImpl, code) {
  const data = await fetchJson(fetchImpl, `https://api.fda.gov/drug/label.json?search=openfda.upc:%22${code}%22&limit=1`);
  const openfda = data?.results?.[0]?.openfda;
  const name = clean(openfda?.brand_name?.[0] || openfda?.generic_name?.[0], 120);
  return name ? { source: 'openfda', name, brand: '', strength: '' } : null;
}

/** Returns { code, found: false } or { code, found: true, source, name, ... }. */
export async function lookupBarcode(db, householdId, rawCode, fetchImpl = fetch) {
  const code = normalizeBarcode(rawCode);
  if (!code) throw Object.assign(new Error('Enter a barcode of 8 to 14 digits.'), { status: 400 });
  const found = await fromShop(db, householdId, code) || await fromOpenFda(fetchImpl, code) || await fromOpenFacts(fetchImpl, code);
  return found ? { code, found: true, ...found } : { code, found: false };
}

/** Best effort: remember what the Shop saved for a scanned code. Never fails the save that triggered it. */
export async function rememberBarcode(db, householdId, rawCode, batch, now = () => new Date().toISOString()) {
  const code = normalizeBarcode(rawCode);
  if (!code || !batch?.name) return false;
  try {
    await db.prepare(`INSERT INTO batch_barcodes (household_id,barcode,name,strength,form,unit,location,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(household_id,barcode) DO UPDATE SET name=excluded.name,strength=excluded.strength,form=excluded.form,unit=excluded.unit,location=excluded.location,updated_at=excluded.updated_at`)
      .bind(householdId, code, batch.name, batch.strength || '', batch.form || '', batch.unit || '', batch.location || '', now()).run();
    return true;
  } catch { return false; }
}
