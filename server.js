import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_JSON_BYTES,
  MAX_PHOTO_BYTES,
  addCalendarDays,
  createVapidKeys,
  endpointAllowed,
  normalizeBatch,
  parseDataUrl,
  publicAssetPaths,
  publicBatch,
  photoTypes,
  statusFor,
  suggestFromPhoto,
  text,
  todayISO,
  visionConfig as visionConfigFromEnv,
  accessConfig,
  requireCloudflareAccess,
  sendPush
} from './lib/shared.js';

export * from './lib/shared.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const DEFAULT_SETTINGS = Object.freeze({ display_name: 'Kaushik', household_name: 'Kaushik’s home', default_storage_location: 'Medicine cabinet' });
const storageLocations = new Set(['Medicine cabinet', 'Bathroom cabinet', 'Kitchen drawer', 'Refrigerator', 'First aid kit']);

function profileText(value, label, max) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (cleaned.length < 1 || cleaned.length > max) throw Object.assign(new Error(`${label} must be between 1 and ${max} characters.`), { status: 400 });
  return cleaned;
}

function normalizeSettings(data) {
  const display_name = profileText(data.display_name, 'Display name', 60);
  const household_name = profileText(data.household_name, 'Shop name', 80);
  const default_storage_location = typeof data.default_storage_location === 'string' ? data.default_storage_location.trim() : '';
  if (!storageLocations.has(default_storage_location)) throw Object.assign(new Error('Choose a valid default storage location.'), { status: 400 });
  return { display_name, household_name, default_storage_location };
}

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function fileSecrets() {
  const out = {};
  const envFile = join(root, '.env');
  const keyFile = join(root, 'data', 'gemini.key');
  if (existsSync(envFile)) Object.assign(out, parseEnvFile(envFile));
  if (existsSync(keyFile)) {
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (raw && !raw.includes('\n') && !raw.includes('=')) out.GEMINI_API_KEY = raw;
    else Object.assign(out, parseEnvFile(keyFile));
  }
  return out;
}

export function visionConfig(env = process.env) {
  const merged = env === process.env ? { ...fileSecrets(), ...env } : { ...env };
  return visionConfigFromEnv(merged);
}

function loadVapidKeys(file) {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.privateJwk && saved?.publicJwk && saved?.publicKey) return saved;
  }
  const keys = createVapidKeys();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys));
  return keys;
}

export function createStore(path = join(root, 'data', 'inventory.sqlite'), clock = () => new Date()) {
  const dataDir = dirname(path);
  const photoDir = join(dataDir, 'photos');
  mkdirSync(dataDir, { recursive: true });
  const vapid = loadVapidKeys(join(dataDir, 'vapid.json'));
  const db = new DatabaseSync(path); db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY,name TEXT NOT NULL,strength TEXT NOT NULL DEFAULT '',form TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity >= 0),unit TEXT NOT NULL,expiry_date TEXT,location TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',low_stock_threshold INTEGER NOT NULL DEFAULT 4 CHECK(low_stock_threshold >= 0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,discarded_at TEXT,photo_path TEXT);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),kind TEXT NOT NULL,trigger_date TEXT NOT NULL,read_at TEXT,created_at TEXT NOT NULL,pushed_at TEXT,UNIQUE(batch_id,kind,trigger_date));
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),display_name TEXT NOT NULL,household_name TEXT NOT NULL,default_storage_location TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  const columns = db.prepare('PRAGMA table_info(batches)').all().map(c => c.name);
  if (!columns.includes('photo_path')) db.exec('ALTER TABLE batches ADD COLUMN photo_path TEXT');
  const noteCols = db.prepare('PRAGMA table_info(notifications)').all().map(c => c.name);
  if (!noteCols.includes('pushed_at')) db.exec('ALTER TABLE notifications ADD COLUMN pushed_at TEXT');
  const now = () => clock().toISOString();
  db.prepare('INSERT OR IGNORE INTO profile_settings (singleton,display_name,household_name,default_storage_location,updated_at) VALUES (1,?,?,?,?)').run(DEFAULT_SETTINGS.display_name, DEFAULT_SETTINGS.household_name, DEFAULT_SETTINGS.default_storage_location, now());
  function reminders() {
    const today = todayISO(clock());
    const end = addCalendarDays(today, 30);
    const due = db.prepare('SELECT * FROM batches WHERE discarded_at IS NULL AND quantity > 0 AND expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?').all(today, end);
    db.prepare(`DELETE FROM notifications WHERE kind = 'expiry_30' AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id=notifications.batch_id AND b.discarded_at IS NULL AND b.quantity > 0 AND b.expiry_date=notifications.trigger_date AND b.expiry_date >= ? AND b.expiry_date <= ? )`).run(today, end);
    const add = db.prepare('INSERT OR IGNORE INTO notifications (id,batch_id,kind,trigger_date,created_at) VALUES (?,?,?,?,?)');
    due.forEach(b => add.run(randomUUID(), b.id, 'expiry_30', b.expiry_date, now()));
  }
  async function writePhoto(dataUrl) {
    if (!dataUrl) return null;
    const { buffer, ext } = parseDataUrl(dataUrl);
    await mkdir(photoDir, { recursive: true });
    const rel = join('photos', `${randomUUID()}${ext}`);
    await writeFile(join(dataDir, rel), buffer);
    return rel;
  }
  async function removePhoto(rel) {
    if (!rel) return;
    const abs = resolve(dataDir, rel);
    if (!abs.startsWith(resolve(dataDir) + '/') && abs !== resolve(dataDir)) return;
    try { await unlink(abs); } catch { /* already gone */ }
  }
  return {
    db,
    dataDir,
    vapid,
    close: () => db.close(),
    settings() {
      const saved = db.prepare('SELECT display_name,household_name,default_storage_location FROM profile_settings WHERE singleton=1').get();
      return saved ? { ...saved } : { ...DEFAULT_SETTINGS };
    },
    updateSettings(data) {
      const settings = normalizeSettings(data);
      db.prepare('UPDATE profile_settings SET display_name=?,household_name=?,default_storage_location=?,updated_at=? WHERE singleton=1').run(settings.display_name, settings.household_name, settings.default_storage_location, now());
      return this.settings();
    },
    list() {
      reminders();
      return db.prepare('SELECT * FROM batches WHERE discarded_at IS NULL AND quantity > 0 ORDER BY expiry_date IS NULL, expiry_date, name').all().map(b => publicBatch(b, todayISO(clock())));
    },
    async create(data) {
      const b = normalizeBatch(data, true);
      const id = randomUUID();
      const stamp = now();
      const photo_path = await writePhoto(data.photo);
      db.prepare('INSERT INTO batches (id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, photo_path, stamp, stamp);
      reminders();
      return this.get(id);
    },
    get(id) {
      const b = db.prepare('SELECT * FROM batches WHERE id=? AND discarded_at IS NULL').get(id);
      return publicBatch(b, todayISO(clock()));
    },
    photoFile(id) {
      const b = db.prepare('SELECT photo_path FROM batches WHERE id=? AND discarded_at IS NULL').get(id);
      if (!b?.photo_path) return null;
      const abs = resolve(dataDir, b.photo_path);
      if (!abs.startsWith(resolve(dataDir) + '/') && abs !== resolve(dataDir)) return null;
      if (!existsSync(abs)) return null;
      return abs;
    },
    async update(id, data) {
      const old = db.prepare('SELECT * FROM batches WHERE id=? AND discarded_at IS NULL').get(id);
      if (!old) throw Object.assign(new Error('Batch not found.'), { status: 404 });
      const b = normalizeBatch({ ...old, ...data });
      let photo_path = old.photo_path;
      if (data.photo === null) {
        await removePhoto(photo_path);
        photo_path = null;
      } else if (data.photo) {
        const next = await writePhoto(data.photo);
        await removePhoto(photo_path);
        photo_path = next;
      }
      db.prepare('UPDATE batches SET name=?,strength=?,form=?,quantity=?,unit=?,expiry_date=?,location=?,notes=?,low_stock_threshold=?,photo_path=?,updated_at=? WHERE id=?').run(b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, photo_path, now(), id);
      reminders();
      return this.get(id);
    },
    consume(id, amount) {
      if (!Number.isInteger(Number(amount)) || Number(amount) < 1) throw Object.assign(new Error('Amount must be a positive whole number.'), { status: 400 });
      const result = db.prepare('UPDATE batches SET quantity = quantity - ?, updated_at=? WHERE id=? AND discarded_at IS NULL AND quantity >= ?').run(Number(amount), now(), id, Number(amount));
      if (!result.changes) throw Object.assign(new Error('Not enough stock or batch not found.'), { status: 400 });
      reminders();
      return this.get(id) || { id, quantity: 0, has_photo: false };
    },
    async discard(id) {
      const row = db.prepare('SELECT photo_path FROM batches WHERE id=? AND discarded_at IS NULL').get(id);
      db.exec('BEGIN');
      try {
        const r = db.prepare('UPDATE batches SET discarded_at=?,updated_at=? WHERE id=? AND discarded_at IS NULL').run(now(), now(), id);
        if (!r.changes) throw Object.assign(new Error('Batch not found.'), { status: 404 });
        db.prepare('DELETE FROM notifications WHERE batch_id=?').run(id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      await removePhoto(row?.photo_path);
    },
    notifications() {
      reminders();
      return db.prepare(`SELECT n.*, b.name, b.location, b.expiry_date FROM notifications n JOIN batches b ON b.id=n.batch_id WHERE b.discarded_at IS NULL ORDER BY n.created_at DESC`).all();
    },
    readAll() { db.prepare('UPDATE notifications SET read_at=? WHERE read_at IS NULL').run(now()); },
    read(id) {
      const r = db.prepare('UPDATE notifications SET read_at=? WHERE id=?').run(now(), id);
      if (!r.changes) throw Object.assign(new Error('Notification not found.'), { status: 404 });
    },
    savePushSubscription(data) {
      const endpoint = text(data.endpoint, 2000);
      const p256dh = text(data.keys?.p256dh || data.p256dh, 200);
      const auth = text(data.keys?.auth || data.auth, 200);
      if (!endpointAllowed(endpoint) || !p256dh || !auth) throw Object.assign(new Error('Invalid push subscription.'), { status: 400 });
      db.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth').run(endpoint, p256dh, auth, now());
      return { endpoint };
    },
    removePushSubscription(endpoint) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(text(endpoint, 2000));
    },
    async deliverPushes({ fetchImpl = fetch, contact = process.env.PUSH_CONTACT || 'mailto:household@localhost' } = {}) {
      reminders();
      const pending = db.prepare('SELECT id FROM notifications WHERE pushed_at IS NULL').all();
      const subs = db.prepare('SELECT endpoint FROM push_subscriptions').all();
      if (!pending.length || !subs.length) return { sent: 0, gone: 0 };
      let sent = 0, gone = 0;
      for (const sub of subs) {
        try {
          const res = await sendPush(sub.endpoint, vapid, { fetchImpl, contact });
          if (res.status === 404 || res.status === 410) {
            this.removePushSubscription(sub.endpoint);
            gone += 1;
            continue;
          }
          if (!res.ok) continue;
          sent += 1;
        } catch {
          continue;
        }
      }
      if (sent) {
        const stamp = now();
        const mark = db.prepare('UPDATE notifications SET pushed_at=? WHERE id=? AND pushed_at IS NULL');
        pending.forEach(n => mark.run(stamp, n.id));
      }
      return { sent, gone };
    }
  };
}

const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(data === undefined ? '' : JSON.stringify(data)); };

export function app(store = createStore(), { suggest = suggestFromPhoto, env = process.env, fetchImpl = fetch } = {}) {
  const jwksCache = { at: 0, keys: null };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const access = accessConfig(env);
      if (access) {
        let keys = jwksCache.keys;
        if (!keys || Date.now() - jwksCache.at > 60 * 60 * 1000) {
          const certs = await fetchImpl(access.certs);
          if (!certs.ok) throw Object.assign(new Error('Could not verify Cloudflare Access.'), { status: 503 });
          keys = (await certs.json()).keys || [];
          jwksCache.keys = keys;
          jwksCache.at = Date.now();
        }
        await requireCloudflareAccess(req, { env, now: Date.now(), keys });
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !publicAssetPaths.has(url.pathname)) return json(res, 404, { error: 'Not found' });
      const body = async () => {
        let raw = '';
        for await (const c of req) {
          raw += c;
          if (Buffer.byteLength(raw) > MAX_JSON_BYTES) throw Object.assign(new Error('Request body too large.'), { status: 413 });
        }
        try {
          const value = raw ? JSON.parse(raw) : {};
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          return value;
        } catch {
          throw Object.assign(new Error('Invalid JSON body.'), { status: 400 });
        }
      };
      const match = url.pathname.match(new RegExp('^/api/batches/([^/]+)(?:/(consume|discard|photo))?$'));
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, store.settings());
      if (req.method === 'PATCH' && url.pathname === '/api/settings') return json(res, 200, store.updateSettings(await body()));
      if (req.method === 'GET' && url.pathname === '/api/batches') return json(res, 200, store.list());
      if (req.method === 'GET' && url.pathname === '/api/packaging/status') return json(res, 200, { vision: Boolean(visionConfig(env)) });
      if (req.method === 'POST' && url.pathname === '/api/packaging/suggest') {
        const payload = await body();
        return json(res, 200, await suggest(payload.photo, { env: { ...fileSecrets(), ...env } }));
      }
      if (req.method === 'POST' && url.pathname === '/api/batches') {
        const created = await store.create(await body());
        await store.deliverPushes({ fetchImpl });
        return json(res, 201, created);
      }
      if (match && req.method === 'PATCH' && !match[2]) {
        const updated = await store.update(match[1], await body());
        await store.deliverPushes({ fetchImpl });
        return json(res, 200, updated);
      }
      if (match && req.method === 'POST' && match[2] === 'consume') return json(res, 200, store.consume(match[1], (await body()).amount));
      if (match && req.method === 'POST' && match[2] === 'discard') { await store.discard(match[1]); return json(res, 204, {}); }
      if (match && req.method === 'GET' && match[2] === 'photo') {
        const file = store.photoFile(match[1]);
        if (!file) return json(res, 404, { error: 'Photo not found' });
        res.writeHead(200, { 'content-type': photoTypes[extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
        return res.end(await readFile(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/notifications') return json(res, 200, store.notifications());
      if (req.method === 'POST' && url.pathname === '/api/notifications/read-all') { store.readAll(); return json(res, 204, {}); }
      const n = url.pathname.match(new RegExp('^/api/notifications/([^/]+)/read$'));
      if (n && req.method === 'POST') { store.read(n[1]); return json(res, 204, {}); }
      if (req.method === 'GET' && url.pathname === '/api/push/key') return json(res, 200, { publicKey: store.vapid.publicKey });
      if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
        const saved = store.savePushSubscription(await body());
        await store.deliverPushes({ fetchImpl });
        return json(res, 201, saved);
      }
      if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
        store.removePushSubscription((await body()).endpoint);
        return json(res, 204, {});
      }
      if (req.method === 'GET') {
        const file = resolve(publicDir, url.pathname === '/' ? 'index.html' : '.' + url.pathname);
        if (!file.startsWith(publicDir)) return json(res, 404, { error: 'Not found' });
        try { await stat(file); } catch { return json(res, 404, { error: 'Not found' }); }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        res.writeHead(200, { 'content-type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8` });
        return res.end(await readFile(file));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const envFile = join(root, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const row = line.trim();
      if (!row || row.startsWith('#')) continue;
      const cut = row.indexOf('=');
      if (cut < 1) continue;
      const key = row.slice(0, cut).trim();
      let value = row.slice(cut + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || 3000;
  const store = createStore();
  const server = app(store);
  const tick = () => store.deliverPushes().catch(err => console.error('Push delivery failed:', err.message));
  server.listen(port, host, () => {
    console.log(`Inventory Management System on http://${host}:${port}`);
    const access = accessConfig();
    if (access) console.log(`Cloudflare Access required (${access.issuer})`);
    else if (host !== '127.0.0.1' && host !== 'localhost') console.warn('No login is enabled. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD before publishing this app.');
    tick();
    const ms = Number(process.env.PUSH_INTERVAL_MS) || 15 * 60 * 1000;
    setInterval(tick, ms);
  });
}
