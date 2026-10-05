import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

// These are the choices offered for new or changed medicines. Keep legacy values
// below so existing records can still be read and saved without a data migration.
export const forms = new Set(['Tablets', 'Capsules', 'Liquid', 'Cream', 'Inhaler', 'Drops', 'Other', 'Syrup']);
export const units = new Set([
  'bottle', 'sachet', 'tube', 'pack', 'tablet', 'capsule', 'dose', 'piece',
  'tablets', 'capsules', 'bottles', 'tubes', 'sachets', 'ml', 'units'
]);
const photoMimes = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export function looksLikeImage(buffer, mime) {
  if (mime === 'image/jpeg') return buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.length > 7 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  if (mime === 'image/webp') return buffer.length > 11 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 3 * 1024 * 1024;
export const publicAssetPaths = new Set(['/', '/index.html', '/app.js', '/greeting.js', '/shop-client.js', '/shop-creation-client.js', '/owner-promotion-client.js', '/member-removal-client.js', '/owner-demotion-client.js', '/ownership-transfer-client.js', '/shop-leave-client.js', '/shop-deletion-client.js', '/deleted-shops-client.js', '/email-preferences-client.js', '/inventory-export-client.js', '/options-client.js', '/overview-client.js', '/barcode-client.js', '/info-tips.js', '/profile-tabs.js', '/shop-types-client.js', '/csv-import-client.js', '/stock-history-client.js', '/bulk-select-client.js', '/zxing-detector.js', '/expiry-text.js', '/ocr-engine.js', '/expiry-scan-client.js', '/vendor/tesseract/tesseract.min.js', '/vendor/tesseract/worker.min.js', '/vendor/tesseract/tesseract-core-simd-lstm.wasm.js', '/vendor/tesseract/tesseract-core-lstm.wasm.js', '/vendor/tesseract/eng.traineddata.gz', '/vendor/zxing-reader.iife.js', '/vendor/zxing_reader.wasm', '/shop-invitations-client.js', '/change-feed-client.js', '/offline-store.js', '/offline-queue.js', '/restock-client.js', '/styles.css', '/welcome', '/welcome/', '/welcome/landing.css', '/welcome/landing.js', '/welcome/theme.js', '/welcome/fonts/bricolage-grotesque-v1.woff2', '/welcome/fonts/instrument-sans-v1.woff2', '/welcome/logo-v1.png', '/welcome/icon-v1.png', '/sw.js']);

export const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const dateOK = value => value === null || value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
export const todayISO = (now = new Date()) => [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
export const addCalendarDays = (date, days) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };

export function statusFor(batch, today = todayISO()) {
  if (!batch.expiry_date) return 'unknown';
  const end = new Date(`${today}T00:00:00`); end.setDate(end.getDate() + 30);
  const endISO = [end.getFullYear(), String(end.getMonth() + 1).padStart(2, '0'), String(end.getDate()).padStart(2, '0')].join('-');
  if (batch.expiry_date < today) return 'expired';
  if (batch.expiry_date <= endISO) return 'expiring';
  return batch.quantity <= batch.low_stock_threshold ? 'low' : 'healthy';
}

export function publicBatch(batch, today) {
  if (!batch) return batch;
  const { photo_path, ...rest } = batch;
  return { ...rest, has_photo: Boolean(photo_path), status: statusFor(batch, today) };
}

export function normalizeBatch(data, creating = false, allowed = { forms, units }) {
  const name = text(data.name, 120);
  const quantity = Number(data.quantity);
  const form = text(data.form, 30);
  const unit = text(data.unit, 20);
  const expiry_date = text(data.expiry_date ?? data.expiry, 10) || null;
  const threshold = data.low_stock_threshold === undefined || data.low_stock_threshold === '' ? 4 : Number(data.low_stock_threshold);
  if (!name || !Number.isInteger(quantity) || quantity < (creating ? 1 : 0) || !allowed.forms.has(form) || !allowed.units.has(unit) || !dateOK(expiry_date) || !Number.isInteger(threshold) || threshold < 0 || threshold > 1000000) {
    throw Object.assign(new Error('Invalid item details.'), { status: 400 });
  }
  return { name, quantity, form, unit, expiry_date, low_stock_threshold: threshold, strength: text(data.strength, 80), location: text(data.location, 100), notes: text(data.notes, 1000) };
}

export function jwkToUncompressedBase64Url(jwk) {
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.length !== 32 || y.length !== 32) throw new Error('Invalid P-256 public key.');
  return Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url');
}

export function createVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  return { publicJwk, privateJwk, publicKey: jwkToUncompressedBase64Url(publicJwk) };
}

export function createVapidJwt(privateJwk, { aud, sub, now = Date.now() } = {}) {
  if (!aud || !sub) throw new Error('VAPID token needs audience and subject.');
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub })).toString('base64url');
  const data = `${header}.${payload}`;
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

export function verifyVapidJwt(token, publicJwk) {
  const [header, payload, signature] = String(token || '').split('.');
  if (!header || !payload || !signature) return false;
  const key = createPublicKey({ key: publicJwk, format: 'jwk' });
  return verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
}

export function endpointAllowed(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

export function accessConfig(env = {}) {
  const raw = text(env.ACCESS_TEAM_DOMAIN, 200).replace(/\/$/, '');
  const aud = text(env.ACCESS_AUD, 200);
  if (!raw || !aud) return null;
  const issuer = raw.startsWith('https://') ? raw : `https://${raw}`;
  return { issuer, aud, certs: `${issuer}/cdn-cgi/access/certs` };
}

export function accessTokenFromRequest(source) {
  const headers = source?.headers;
  if (!headers) return '';
  const direct = typeof headers.get === 'function'
    ? headers.get('Cf-Access-Jwt-Assertion') || headers.get('cf-access-jwt-assertion')
    : headers['cf-access-jwt-assertion'];
  if (direct) return String(Array.isArray(direct) ? direct[0] : direct);
  const cookie = typeof headers.get === 'function'
    ? headers.get('Cookie') || ''
    : (Array.isArray(headers.cookie) ? headers.cookie.join('; ') : String(headers.cookie || ''));
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : '';
}

export function displayNameFromAccessClaims({ name, common_name: commonName, email } = {}) {
  const claimed = [name, commonName]
    .map(value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '')
    .find(value => value && value.length <= 60);
  if (claimed) return claimed;
  const localPart = typeof email === 'string' ? email.trim().split('@')[0] : '';
  const fallback = localPart.replace(/[^\p{L}\p{N} ._'’-]/gu, ' ').trim().replace(/\s+/g, ' ');
  return fallback && fallback.length <= 60 ? fallback : 'Kaushik';
}

export async function requireCloudflareAccess(source, { env = {}, fetchImpl = fetch, now = Date.now(), keys } = {}) {
  const cfg = accessConfig(env);
  if (!cfg) return;
  const denied = Object.assign(new Error('Sign in through Cloudflare Access to open this shop tracker.'), { status: 401 });
  const token = accessTokenFromRequest(source);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw denied;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw denied; }
  if (header.alg !== 'RS256') throw denied;
  let jwks = keys;
  if (!jwks) {
    const res = await fetchImpl(cfg.certs);
    if (!res.ok) throw Object.assign(new Error('Could not verify Cloudflare Access.'), { status: 503 });
    jwks = (await res.json()).keys || [];
  }
  const jwk = jwks.find(k => k.kid && k.kid === header.kid) || (jwks.length === 1 ? jwks[0] : null);
  if (!jwk) throw denied;
  const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const iss = String(payload.iss || '').replace(/\/$/, '');
  if (!ok || iss !== cfg.issuer || !auds.includes(cfg.aud) || !payload.exp || payload.exp * 1000 < now()) throw denied;
  const subject = text(payload.sub, 500);
  const email = text(payload.email, 320).toLowerCase();
  if (!subject || !email || !email.includes('@')) throw denied;
  // The returned principal is derived only from the verified JWT. Callers must
  // not substitute an edge identity header for it.
  return { provider: 'cloudflare_access', subject, email, displayName: displayNameFromAccessClaims({ name: payload.name, common_name: payload.common_name, email }) };
}

export async function sendPush(endpoint, vapid, { fetchImpl = fetch, contact = 'mailto:household@localhost' } = {}) {
  if (!endpointAllowed(endpoint)) throw Object.assign(new Error('Push endpoint must be HTTPS (or localhost).'), { status: 400 });
  const url = new URL(endpoint);
  const jwt = createVapidJwt(vapid.privateJwk, { aud: `${url.protocol}//${url.host}`, sub: contact });
  return fetchImpl(endpoint, {
    method: 'POST',
    headers: { TTL: '86400', Authorization: `vapid t=${jwt}, k=${vapid.publicKey}` }
  });
}

export function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || '').replace(/\s/g, ''));
  if (!match) throw Object.assign(new Error('Upload a JPEG, PNG, or WebP packaging photo.'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw Object.assign(new Error('Photo data was empty.'), { status: 400 });
  if (buffer.length > MAX_PHOTO_BYTES) throw Object.assign(new Error('Packaging photos must be 2 MB or smaller.'), { status: 413 });
  if (!looksLikeImage(buffer, match[1])) throw Object.assign(new Error('Upload a JPEG, PNG, or WebP packaging photo.'), { status: 400 });
  return { mime: match[1], buffer, ext: photoMimes[match[1]] };
}

export function parseModelJson(textValue) {
  const blob = String(textValue || '').match(/\{[\s\S]*\}/);
  if (!blob) return null;
  try {
    const value = JSON.parse(blob[0]);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function suggestionFromModel(payload, visionConfigured) {
  const name = text(payload?.name, 120) || null;
  let expiry_date = text(payload?.expiry_date, 10) || null;
  const ambiguous = Boolean(payload?.expiry_ambiguous);
  if (!expiry_date || !dateOK(expiry_date)) expiry_date = null;
  if (ambiguous) expiry_date = null;
  const name_source = name ? 'suggested' : 'manual';
  const expiry_source = expiry_date ? 'suggested' : 'manual';
  let message;
  if (!visionConfigured) message = 'Enter the name and expiry yourself. AI suggestions need a Gemini API key.';
  else if (name && expiry_date) message = 'Confirm the suggested name and expiry before saving. Edit anything that looks wrong.';
  else if (name && ambiguous) message = 'Confirm the name. The expiry was incomplete or unclear — enter it manually.';
  else if (name) message = 'Confirm the name. Enter the expiry date yourself.';
  else if (expiry_date) message = 'Confirm the expiry. Enter the item name yourself.';
  else message = 'The packaging could not be read clearly. Enter the name and expiry yourself.';
  return { name, expiry_date, name_source, expiry_source, needs_manual: !name || !expiry_date, vision: Boolean(visionConfigured), message };
}

export function visionConfig(env = {}) {
  const key = text(env.GEMINI_API_KEY, 500) || text(env.VISION_API_KEY, 500);
  if (!key) return null;
  const provider = (text(env.VISION_PROVIDER, 20) || 'gemini').toLowerCase();
  const model = text(env.VISION_MODEL, 80) || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-flash-latest');
  const url = text(env.VISION_API_URL, 400) || (provider === 'openai'
    ? 'https://api.openai.com/v1/chat/completions'
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  return { provider: provider === 'openai' ? 'openai' : 'gemini', key, url, model };
}

const PACKAGING_PROMPT = 'Read this product packaging photo. Reply with JSON only: {"name": string or null, "expiry_date": "YYYY-MM-DD" or null, "expiry_ambiguous": boolean}. name is the printed product name. expiry_date only if a complete calendar day is readable. If only month/year or any digit is unclear, set expiry_date to null and expiry_ambiguous to true. Do not guess missing values.';

export function visionResponseText(body, provider) {
  if (provider === 'openai') return body?.choices?.[0]?.message?.content || '';
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => part?.text || '').join('');
}

function visionRequest(config, dataUrl) {
  if (config.provider === 'openai') {
    return {
      url: config.url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
      body: {
        model: config.model,
        max_tokens: 200,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: PACKAGING_PROMPT }, { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }] }]
      }
    };
  }
  const photo = parseDataUrl(dataUrl);
  return {
    url: config.url,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.key },
    body: {
      contents: [{ role: 'user', parts: [{ text: PACKAGING_PROMPT }, { inlineData: { mimeType: photo.mime, data: photo.buffer.toString('base64') } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' }
    }
  };
}

export async function suggestFromPhoto(dataUrl, { env = {}, fetchImpl = fetch } = {}) {
  parseDataUrl(dataUrl);
  const config = visionConfig(env);
  if (!config) return suggestionFromModel({}, false);
  const request = visionRequest(config, dataUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      signal: controller.signal,
      body: JSON.stringify(request.body)
    });
    if (!response.ok) {
      if (response.status === 503) throw Object.assign(new Error('Gemini is busy. Try the photo again or enter the details yourself.'), { status: 503 });
      throw Object.assign(new Error('Vision provider rejected the request.'), { status: 502 });
    }
    const body = await response.json();
    const parsed = parseModelJson(visionResponseText(body, config.provider));
    if (!parsed) return suggestionFromModel({ expiry_ambiguous: true }, true);
    return suggestionFromModel(parsed, true);
  } catch (error) {
    if (error.status) throw error;
    if (error.name === 'AbortError') throw Object.assign(new Error('Vision suggestion timed out. Enter the details yourself.'), { status: 504 });
    throw Object.assign(new Error('Vision suggestion failed. Enter the details yourself.'), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

export const photoTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
