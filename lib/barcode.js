// Barcode lookup: this Shop's own earlier scans first, then free public databases (no API key): Health Canada (DIN), openFDA, Open Facts.
// A miss is normal, not an error: the caller falls back to manual entry.
const TIMEOUT_MS = 4000;
const USER_AGENT = 'MedicineInventoryTracker/1.0 (+https://medicineinventory.craftloop.ca)';

/**
 * A barcode is 8 to 14 digits (EAN-8, UPC, EAN-13, GTIN-14). A Canadian DIN is written "DIN 02241234": with the DIN prefix
 * 6 to 8 digits are accepted and padded to 8, and the lookup uses Health Canada only. Returns { code, dinOnly } or null.
 */
export function parseCode(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const din = /^din[\s:-]*(\d[\d\s-]*)$/i.exec(text);
  if (din) {
    const digits = din[1].replace(/[\s-]/g, '');
    return /^\d{6,8}$/.test(digits) ? { code: digits.padStart(8, '0'), dinOnly: true } : null;
  }
  const digits = text.replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(digits) ? { code: digits, dinOnly: false } : null;
}

export const normalizeBarcode = value => parseCode(value)?.code ?? null;

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

const DPD = 'https://health-products.canada.ca/api/drug';
// Health Canada dosage form names mapped to the app's standard Form options; anything else is left for the user.
const FORM_MAP = [[/tablet/i, 'Tablets'], [/capsule/i, 'Capsules'], [/syrup/i, 'Syrup'], [/drop/i, 'Drops'], [/cream|ointment|gel|lotion/i, 'Cream'], [/inhal|aerosol|powder.*inhal/i, 'Inhaler'], [/solution|suspension|liquid|elixir/i, 'Liquid']];

async function fromHealthCanada(fetchImpl, din) {
  const products = await fetchJson(fetchImpl, `${DPD}/drugproduct/?din=${din}&lang=en&type=json`);
  const product = Array.isArray(products) ? products[0] : null;
  const name = clean(product?.brand_name, 120);
  if (!name) return null;
  const [ingredients, forms] = await Promise.all([
    fetchJson(fetchImpl, `${DPD}/activeingredient/?id=${product.drug_code}&lang=en&type=json`),
    fetchJson(fetchImpl, `${DPD}/form/?id=${product.drug_code}&lang=en&type=json`)
  ]);
  const only = Array.isArray(ingredients) && ingredients.length === 1 ? ingredients[0] : null;
  const strength = only && only.strength ? clean(`${only.strength} ${String(only.strength_unit || '').toLowerCase()}`, 80) : '';
  const formName = Array.isArray(forms) ? forms[0]?.pharmaceutical_form_name || '' : '';
  const form = FORM_MAP.find(([pattern]) => pattern.test(formName))?.[1] || '';
  return { source: 'din', name: titleCase(name), brand: '', strength, form, din };
}

const titleCase = value => value === value.toUpperCase() ? value.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, lead, char) => lead + char.toUpperCase()) : value;

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

/** Returns { code, found: false } or { code, found: true, source, name, ... }. 8-digit codes may be a DIN, so Health Canada is tried first. */
export async function lookupBarcode(db, householdId, rawCode, fetchImpl = fetch) {
  const parsed = parseCode(rawCode);
  if (!parsed) throw Object.assign(new Error('Enter a barcode of 8 to 14 digits, or a DIN.'), { status: 400 });
  const { code, dinOnly } = parsed;
  const maybeDin = dinOnly || code.length === 8;
  const found = await fromShop(db, householdId, code)
    || (maybeDin ? await fromHealthCanada(fetchImpl, code) : null)
    || (dinOnly ? null : await fromOpenFda(fetchImpl, code) || await fromOpenFacts(fetchImpl, code));
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
