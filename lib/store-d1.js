import { randomUUID } from 'node:crypto';
import {
  addCalendarDays,
  createVapidKeys,
  endpointAllowed,
  normalizeBatch,
  parseDataUrl,
  publicBatch,
  sendPush,
  text,
  todayISO
} from './shared.js';
import { allowedFor, shopTypeRef, shopOptions } from './options.js';
import { rememberBarcode } from './barcode.js';
import { prepareImport } from './batch-import.js';
import { parseBulk, parseCopy } from './bulk-actions.js';

const DEFAULT_SETTINGS = Object.freeze({ display_name: 'Kaushik', household_name: 'Kaushik’s home', default_storage_location: 'Medicine cabinet', default_low_stock_threshold: 4 });
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function profileText(value, label, max) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (cleaned.length < 1 || cleaned.length > max) throw Object.assign(new Error(`${label} must be between 1 and ${max} characters.`), { status: 400 });
  return cleaned;
}

function normalizeSettings(data, locations, current) {
  const display_name = profileText(data.display_name, 'Display name', 60);
  const household_name = profileText(data.household_name, 'Shop name', 80);
  const default_storage_location = typeof data.default_storage_location === 'string' ? data.default_storage_location.trim() : '';
  if (!locations.has(default_storage_location)) throw Object.assign(new Error('Choose a valid default storage location.'), { status: 400 });
  const raw = data.default_low_stock_threshold;
  const threshold = raw === undefined || raw === '' ? current?.default_low_stock_threshold ?? 4 : Number(raw);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1000000) throw Object.assign(new Error('The default low-stock alert must be a whole number from 0 to 1,000,000.'), { status: 400 });
  return { display_name, household_name, default_storage_location, default_low_stock_threshold: threshold };
}

function syncRequest(data) {
  const hasOperationId = Object.hasOwn(data, 'operationId');
  const hasBaseRevision = Object.hasOwn(data, 'baseRevision');
  if (!hasOperationId && !hasBaseRevision) return null;
  if (!hasOperationId || !hasBaseRevision || !operationIdPattern.test(String(data.operationId || '')) || !Number.isInteger(data.baseRevision) || data.baseRevision < 0) {
    throw Object.assign(new Error('A valid operation ID and base revision are required.'), { status: 400 });
  }
  return { operationId: data.operationId, baseRevision: data.baseRevision };
}

function conflict(current) {
  return Object.assign(new Error('This item was changed elsewhere. Review the latest details and try again.'), { status: 409, current });
}

function changes(result, index) {
  return Number(result?.[index]?.meta?.changes || 0);
}

export async function loadVapid(kv, env) {
  if (env.VAPID_JSON) return JSON.parse(env.VAPID_JSON);
  const saved = await kv.get('vapid');
  if (saved) return JSON.parse(saved);
  const keys = createVapidKeys();
  await kv.put('vapid', JSON.stringify(keys));
  return keys;
}

export function createD1Store(db, photos, vapid, { householdId, userId, displayName } = {}, clock = () => new Date()) {
  if (!householdId || !userId) throw Object.assign(new Error('A shop membership is required.'), { status: 403 });
  const identityDisplayName = displayName ? profileText(displayName, 'Display name', 60) : DEFAULT_SETTINGS.display_name;
  const displayNameSource = displayName ? 'identity_seed' : 'default';
  const now = () => clock().toISOString();
  async function reminders() {
    const today = todayISO(clock());
    const end = addCalendarDays(today, 30);
    const due = await db.prepare('SELECT * FROM batches WHERE household_id=? AND discarded_at IS NULL AND quantity > 0 AND expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?').bind(householdId, today, end).all();
    await db.prepare(`DELETE FROM notifications WHERE household_id=? AND kind = 'expiry_30' AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id=notifications.batch_id AND b.household_id=notifications.household_id AND b.discarded_at IS NULL AND b.quantity > 0 AND b.expiry_date=notifications.trigger_date AND b.expiry_date >= ? AND b.expiry_date <= ? )`).bind(householdId, today, end).run();
    const add = db.prepare('INSERT OR IGNORE INTO notifications (id,batch_id,household_id,kind,trigger_date,created_at) VALUES (?,?,?,?,?,?)');
    for (const b of due.results || []) await add.bind(randomUUID(), b.id, householdId, 'expiry_30', b.expiry_date, now()).run();
  }
  async function writePhoto(dataUrl) {
    if (!dataUrl) return null;
    const { buffer, ext, mime } = parseDataUrl(dataUrl);
    const key = `photos/${randomUUID()}${ext}`;
    await photos.put(key, buffer, { httpMetadata: { contentType: mime } });
    return key;
  }
  async function removePhoto(key) {
    if (!key) return;
    try { await photos.delete(key); } catch { /* already gone */ }
  }
  async function replay(sync) {
    if (!sync) return undefined;
    const receipt = await db.prepare('SELECT response_body FROM mutation_receipts WHERE household_id=? AND operation_id=?').bind(householdId, sync.operationId).first();
    if (!receipt) return undefined;
    return { found: true, value: JSON.parse(receipt.response_body) };
  }
  async function currentBatch(id) {
    const row = await db.prepare('SELECT * FROM batches WHERE id=? AND household_id=?').bind(id, householdId).first();
    return publicBatch(row, todayISO(clock()));
  }
  async function replayOrConflict(sync, id) {
    const prior = await replay(sync);
    if (prior) return prior;
    throw conflict(await currentBatch(id));
  }
  function receipt(operation, sync, status, value, stamp) {
    return db.prepare('INSERT INTO mutation_receipts (household_id,operation_id,batch_id,operation,response_status,response_body,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(householdId, sync.operationId, value?.id || null, operation, status, JSON.stringify(value ?? null), stamp);
  }
  // Appended in the same D1 batch as the mutation; WHERE changes()=1 ties it to the preceding write.
  // Stock history row for the preceding write, appended after feed() so changes()=1 still refers to a real change.
  // `change` is signed; the item's name, unit and new quantity are read from its row at that moment.
  function stock(id, kind, change, stamp, hid = householdId) {
    return db.prepare('INSERT INTO stock_events (household_id,batch_id,item_name,unit,kind,change,quantity_after,created_at) SELECT household_id,id,name,unit,?,?,quantity,? FROM batches WHERE id=? AND household_id=? AND changes()=1')
      .bind(kind, change, stamp, id, hid);
  }
  function stockDiscard(id, stamp) {
    return db.prepare("INSERT INTO stock_events (household_id,batch_id,item_name,unit,kind,change,quantity_after,created_at) SELECT household_id,id,name,unit,'discarded',-quantity,0,? FROM batches WHERE id=? AND household_id=? AND quantity>0 AND changes()=1")
      .bind(stamp, id, householdId);
  }
  function feed(id, kind, stamp, revision = null, hid = householdId) {
    return db.prepare('INSERT INTO batch_changes (household_id,batch_id,revision,kind,created_at) SELECT ?,?,COALESCE(?,(SELECT revision FROM batches WHERE id=? AND household_id=?)),?,? WHERE changes()=1')
      .bind(hid, id, revision, id, hid, kind, stamp);
  }
  return {
    vapid,
    async settings() {
      const ref = await shopTypeRef(db, householdId);
      // shop_type is the Shop type key ('medicine', 'goods' or 'custom:<id>'), so it matches the Shop type select.
      return { ...await this.baseSettings(), shop_type: ref.key, shop_type_info: { key: ref.key, name: ref.name, base: ref.base, usesStrength: ref.usesStrength, formLabel: ref.formLabel } };
    },
    async baseSettings() {
      const saved = await db.prepare('SELECT display_name,household_name,default_storage_location,default_low_stock_threshold,display_name_source FROM household_settings WHERE household_id=?').bind(householdId).first();
      if (saved) {
        // `default` is seed-eligible only. It is used for legacy settings and
        // is replaced exclusively by the already verified Access principal.
        // A PATCH changes the source to `user`, which this path never alters.
        if (saved.display_name_source === 'default' && displayName) {
          await db.prepare("UPDATE household_settings SET display_name=?,updated_at=?,display_name_source='identity_seed' WHERE household_id=? AND display_name_source='default'").bind(identityDisplayName, now(), householdId).run();
          return (await db.prepare('SELECT display_name,household_name,default_storage_location,default_low_stock_threshold FROM household_settings WHERE household_id=?').bind(householdId).first()) || saved;
        }
        return saved;
      }
      const settings = { ...DEFAULT_SETTINGS };
      await db.prepare('INSERT OR IGNORE INTO household_settings (household_id,display_name,household_name,default_storage_location,updated_at,display_name_source) VALUES (?,?,?,?,?,?)').bind(householdId, identityDisplayName, settings.household_name, settings.default_storage_location, now(), displayNameSource).run();
      return (await db.prepare('SELECT display_name,household_name,default_storage_location,default_low_stock_threshold FROM household_settings WHERE household_id=?').bind(householdId).first()) || settings;
    },
    async updateSettings(data) {
      const current = await this.baseSettings();
      const settings = normalizeSettings(data, new Set([...(await allowedFor(db, householdId)).locations, current.default_storage_location]), current);
      await db.prepare("UPDATE household_settings SET display_name=?,household_name=?,default_storage_location=?,default_low_stock_threshold=?,updated_at=?,display_name_source='user' WHERE household_id=?").bind(settings.display_name, settings.household_name, settings.default_storage_location, settings.default_low_stock_threshold, now(), householdId).run();
      return this.settings();
    },
    async list() {
      await reminders();
      const { results } = await db.prepare('SELECT * FROM batches WHERE household_id=? AND discarded_at IS NULL AND quantity > 0 ORDER BY expiry_date IS NULL, expiry_date, name').bind(householdId).all();
      return (results || []).map(b => publicBatch(b, todayISO(clock())));
    },
    async get(id) {
      const row = await db.prepare('SELECT * FROM batches WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(id, householdId).first();
      return publicBatch(row, todayISO(clock()));
    },
    async create(data) {
      const sync = syncRequest(data);
      const prior = await replay(sync);
      if (prior) return prior.value;
      const shopDefault = data.low_stock_threshold === undefined || data.low_stock_threshold === '' ? (await this.baseSettings()).default_low_stock_threshold : undefined;
      const b = normalizeBatch(shopDefault === undefined ? data : { ...data, low_stock_threshold: shopDefault }, true, await allowedFor(db, householdId));
      const id = randomUUID();
      const stamp = now();
      const photo_path = await writePhoto(data.photo);
      const created = publicBatch({ id, household_id: householdId, ...b, photo_path, created_at: stamp, updated_at: stamp, discarded_at: null, revision: 1 }, todayISO(clock()));
      try {
        if (sync) {
          await db.batch([
            db.prepare('INSERT INTO batches (id,household_id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, householdId, b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, photo_path, stamp, stamp, 1),
            receipt('create', sync, 201, created, stamp),
            feed(id, 'upsert', stamp, 1),
            stock(id, 'added', b.quantity, stamp)
          ]);
        } else {
          await db.batch([
            db.prepare('INSERT INTO batches (id,household_id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, householdId, b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, photo_path, stamp, stamp, 1),
            feed(id, 'upsert', stamp, 1),
            stock(id, 'added', b.quantity, stamp)
          ]);
        }
      } catch (error) {
        const replayed = await replay(sync);
        if (replayed) {
          await removePhoto(photo_path);
          return replayed.value;
        }
        await removePhoto(photo_path);
        throw error;
      }
      if (data.barcode) await rememberBarcode(db, householdId, data.barcode, b);
      await reminders();
      return sync ? created : this.get(id);
    },
    /** Add many items at once from parsed CSV rows. All rows are valid or none are saved. */
    async importBatches(rows) {
      const settings = await this.baseSettings();
      const items = prepareImport(rows, await allowedFor(db, householdId), { location: settings.default_storage_location, threshold: settings.default_low_stock_threshold });
      const stamp = now();
      const statements = [];
      for (const b of items) {
        const id = randomUUID();
        statements.push(db.prepare('INSERT INTO batches (id,household_id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, householdId, b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, null, stamp, stamp, 1), feed(id, 'upsert', stamp, 1), stock(id, 'added', b.quantity, stamp));
      }
      await db.batch(statements);
      await reminders();
      return { imported: items.length };
    },
    /**
     * Move, re-form or discard several items in one D1 batch. Items that are already gone or belong to another Shop are skipped
     * and counted, never an error. Photos of discarded items are removed afterwards, as a single discard does.
     */
    async bulkChange(data) {
      const { action, ids, location, form: wantedForm } = parseBulk(data);
      let form = null;
      if (action === 'form') {
        const known = [...(await allowedFor(db, householdId)).forms];
        form = known.find(value => value.toLowerCase() === wantedForm.toLowerCase());
        if (!form) throw Object.assign(new Error('That is not in this Shop’s list. Choose one from the list.'), { status: 400 });
      }
      const marks = ids.map(() => '?').join(',');
      const { results } = await db.prepare(`SELECT id,photo_path FROM batches WHERE household_id=? AND discarded_at IS NULL AND id IN (${marks})`).bind(householdId, ...ids).all();
      const found = results || [];
      if (!found.length) return { changed: 0, skipped: ids.length };
      const stamp = now();
      const statements = [];
      for (const { id } of found) {
        if (action === 'move') {
          statements.push(db.prepare('UPDATE batches SET location=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(location, stamp, id, householdId), feed(id, 'upsert', stamp));
        } else if (action === 'form') {
          statements.push(db.prepare('UPDATE batches SET form=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(form, stamp, id, householdId), feed(id, 'upsert', stamp));
        } else {
          statements.push(db.prepare('UPDATE batches SET discarded_at=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(stamp, stamp, id, householdId), feed(id, 'remove', stamp), stockDiscard(id, stamp),
            db.prepare('DELETE FROM notifications WHERE batch_id=? AND household_id=?').bind(id, householdId));
        }
      }
      await db.batch(statements);
      if (action === 'discard') for (const { photo_path } of found) await removePhoto(photo_path);
      await reminders();
      return { changed: found.length, skipped: ids.length - found.length };
    },
    /**
     * Copy items into another Shop the caller belongs to (any role). Copies carry name, strength, form, unit, quantity,
     * expiry, location, notes and low-stock alert, not photos or history. Form and unit must exist in the other Shop's
     * lists, so a mismatch refuses the whole copy with the items named. The originals stay where they are.
     */
    async copyToShop(data) {
      const { ids, targetShopId } = parseCopy(data);
      if (targetShopId === householdId) throw Object.assign(new Error('Choose a different Shop to copy to.'), { status: 400 });
      const member = await db.prepare('SELECT 1 AS ok FROM active_memberships WHERE household_id=? AND user_id=?').bind(targetShopId, userId).first();
      if (!member) throw Object.assign(new Error('You are not a member of that Shop.'), { status: 403 });
      const marks = ids.map(() => '?').join(',');
      const { results } = await db.prepare(`SELECT id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold FROM batches WHERE household_id=? AND discarded_at IS NULL AND id IN (${marks}) ORDER BY LOWER(name),id`).bind(householdId, ...ids).all();
      const found = results || [];
      if (!found.length) throw Object.assign(new Error('Those items could not be found.'), { status: 404 });
      const target = await db.prepare('SELECT default_storage_location,default_low_stock_threshold FROM household_settings WHERE household_id=?').bind(targetShopId).first();
      let items;
      try {
        items = prepareImport(found.map(row => ({ ...row, quantity: String(row.quantity), low_stock_threshold: String(row.low_stock_threshold) })), await allowedFor(db, targetShopId),
          { location: target?.default_storage_location || 'Medicine cabinet', threshold: target?.default_low_stock_threshold ?? 4 });
      } catch (error) {
        if (!error.problems) throw error;
        error.problems = error.problems.map(item => ({ ...item, name: found[item.row - 2]?.name, message: item.message.replace('this Shop’s', 'the other Shop’s') }));
        error.message = `Nothing was copied. ${error.problems.length} ${error.problems.length === 1 ? 'item does' : 'items do'} not fit the other Shop’s lists.`;
        throw error;
      }
      const stamp = now();
      const statements = [];
      for (const b of items) {
        const id = randomUUID();
        statements.push(db.prepare('INSERT INTO batches (id,household_id,name,strength,form,quantity,unit,expiry_date,location,notes,low_stock_threshold,photo_path,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, targetShopId, b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, null, stamp, stamp, 1), feed(id, 'upsert', stamp, 1, targetShopId), stock(id, 'added', b.quantity, stamp, targetShopId));
      }
      await db.batch(statements);
      return { copied: items.length, skipped: ids.length - found.length };
    },
    /** Recent stock changes for the Shop (or one item), newest first, with how much of the item was used in the last 30 days. */
    async stockHistory({ batchId = null, limit = 50 } = {}) {
      const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 50;
      const { results } = await db.prepare('SELECT id,batch_id,item_name,unit,kind,change,quantity_after,created_at FROM stock_events WHERE household_id=? AND (? IS NULL OR batch_id=?) ORDER BY id DESC LIMIT ?')
        .bind(householdId, batchId, batchId, size).all();
      const since = new Date(clock().getTime() - 30 * 86400000).toISOString();
      const used = await db.prepare("SELECT COALESCE(SUM(-change),0) AS n FROM stock_events WHERE household_id=? AND (? IS NULL OR batch_id=?) AND kind='used' AND created_at>=?").bind(householdId, batchId, batchId, since).first();
      return { events: results || [], usedLast30Days: Number(used?.n || 0) };
    },
    async photoMeta(id) {
      const row = await db.prepare('SELECT photo_path FROM batches WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(id, householdId).first();
      return row?.photo_path || null;
    },
    async update(id, data) {
      const sync = syncRequest(data);
      const prior = await replay(sync);
      if (prior) return prior.value;
      const old = await db.prepare('SELECT * FROM batches WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(id, householdId).first();
      if (!old) {
        if (sync) {
          const current = await currentBatch(id);
          if (current) throw conflict(current);
        }
        throw Object.assign(new Error('Batch not found.'), { status: 404 });
      }
      if (sync && old.revision !== sync.baseRevision) throw conflict(publicBatch(old, todayISO(clock())));
      const b = normalizeBatch({ ...old, ...data }, false, await allowedFor(db, householdId, old));
      let photo_path = old.photo_path;
      let replacementPhoto = null;
      if (data.photo === null) {
        photo_path = null;
      } else if (data.photo) {
        replacementPhoto = await writePhoto(data.photo);
        photo_path = replacementPhoto;
      }
      const stamp = now();
      const updated = publicBatch({ ...old, ...b, photo_path, updated_at: stamp, revision: old.revision + 1 }, todayISO(clock()));
      if (sync) {
        const result = await db.batch([
          db.prepare('UPDATE batches SET name=?,strength=?,form=?,quantity=?,unit=?,expiry_date=?,location=?,notes=?,low_stock_threshold=?,photo_path=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL AND revision=?').bind(b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, photo_path, stamp, id, householdId, sync.baseRevision),
          db.prepare('INSERT INTO mutation_receipts (household_id,operation_id,batch_id,operation,response_status,response_body,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1').bind(householdId, sync.operationId, id, 'update', 200, JSON.stringify(updated), stamp),
          feed(id, 'upsert', stamp, old.revision + 1),
          ...(b.quantity === old.quantity ? [] : [stock(id, 'adjusted', b.quantity - old.quantity, stamp)])
        ]);
        if (!changes(result, 0) || !changes(result, 1)) {
          if (replacementPhoto) await removePhoto(replacementPhoto);
          return (await replayOrConflict(sync, id)).value;
        }
      } else {
        await db.batch([
          db.prepare('UPDATE batches SET name=?,strength=?,form=?,quantity=?,unit=?,expiry_date=?,location=?,notes=?,low_stock_threshold=?,photo_path=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=?').bind(b.name, b.strength, b.form, b.quantity, b.unit, b.expiry_date, b.location, b.notes, b.low_stock_threshold, photo_path, stamp, id, householdId),
          feed(id, 'upsert', stamp),
          ...(b.quantity === old.quantity ? [] : [stock(id, 'adjusted', b.quantity - old.quantity, stamp)])
        ]);
      }
      if (old.photo_path && old.photo_path !== photo_path) await removePhoto(old.photo_path);
      await reminders();
      return sync ? updated : this.get(id);
    },
    async consume(id, amount) {
      const sync = syncRequest(amount && typeof amount === 'object' ? amount : {});
      const quantity = Number(amount && typeof amount === 'object' ? amount.amount : amount);
      const prior = await replay(sync);
      if (prior) return prior.value;
      if (!Number.isInteger(quantity) || quantity < 1) throw Object.assign(new Error('Amount must be a positive whole number.'), { status: 400 });
      if (sync) {
        const old = await db.prepare('SELECT * FROM batches WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(id, householdId).first();
        if (!old) {
          const current = await currentBatch(id);
          if (current) throw conflict(current);
          throw Object.assign(new Error('Batch not found.'), { status: 404 });
        }
        if (old.revision !== sync.baseRevision) throw conflict(publicBatch(old, todayISO(clock())));
        if (old.quantity < quantity) throw Object.assign(new Error('Not enough stock or batch not found.'), { status: 400 });
        const stamp = now();
        const consumed = old.quantity === quantity ? { id, quantity: 0, has_photo: false, revision: old.revision + 1 } : publicBatch({ ...old, quantity: old.quantity - quantity, updated_at: stamp, revision: old.revision + 1 }, todayISO(clock()));
        const result = await db.batch([
          db.prepare('UPDATE batches SET quantity=quantity-?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL AND quantity>=? AND revision=?').bind(quantity, stamp, id, householdId, quantity, sync.baseRevision),
          db.prepare('INSERT INTO mutation_receipts (household_id,operation_id,batch_id,operation,response_status,response_body,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1').bind(householdId, sync.operationId, id, 'consume', 200, JSON.stringify(consumed), stamp),
          feed(id, old.quantity === quantity ? 'remove' : 'upsert', stamp, old.revision + 1),
          stock(id, 'used', -quantity, stamp)
        ]);
        if (!changes(result, 0) || !changes(result, 1)) return (await replayOrConflict(sync, id)).value;
        await reminders();
        return consumed;
      }
      const stamp = now();
      const [result] = await db.batch([
        db.prepare('UPDATE batches SET quantity = quantity - ?, updated_at=?, revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL AND quantity >= ?').bind(quantity, stamp, id, householdId, quantity),
        feed(id, 'upsert', stamp),
        stock(id, 'used', -quantity, stamp)
      ]);
      if (!result.meta.changes) throw Object.assign(new Error('Not enough stock or batch not found.'), { status: 400 });
      await reminders();
      return this.get(id) || { id, quantity: 0, has_photo: false };
    },
    async discard(id, data = {}) {
      const sync = syncRequest(data);
      const prior = await replay(sync);
      if (prior) return prior.value;
      const row = await db.prepare('SELECT photo_path FROM batches WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(id, householdId).first();
      if (!row) {
        if (sync) {
          const current = await currentBatch(id);
          if (current) throw conflict(current);
        }
        throw Object.assign(new Error('Batch not found.'), { status: 404 });
      }
      if (sync) {
        const current = await db.prepare('SELECT revision FROM batches WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(id, householdId).first();
        if (!current || current.revision !== sync.baseRevision) throw conflict(await currentBatch(id));
        const stamp = now();
        const result = await db.batch([
          db.prepare('UPDATE batches SET discarded_at=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL AND revision=?').bind(stamp, stamp, id, householdId, sync.baseRevision),
          db.prepare('INSERT INTO mutation_receipts (household_id,operation_id,batch_id,operation,response_status,response_body,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1').bind(householdId, sync.operationId, id, 'discard', 204, 'null', stamp),
          feed(id, 'remove', stamp, sync.baseRevision + 1),
          stockDiscard(id, stamp),
          db.prepare('DELETE FROM notifications WHERE batch_id=? AND household_id=? AND EXISTS (SELECT 1 FROM mutation_receipts WHERE household_id=? AND operation_id=?)').bind(id, householdId, householdId, sync.operationId)
        ]);
        if (!changes(result, 0) || !changes(result, 1)) return (await replayOrConflict(sync, id)).value;
      } else {
        const stamp = now();
        const [result] = await db.batch([
          db.prepare('UPDATE batches SET discarded_at=?,updated_at=?,revision=revision+1 WHERE id=? AND household_id=? AND discarded_at IS NULL').bind(stamp, stamp, id, householdId),
          feed(id, 'remove', stamp),
          stockDiscard(id, stamp)
        ]);
        if (!result.meta.changes) throw Object.assign(new Error('Batch not found.'), { status: 404 });
        await db.prepare('DELETE FROM notifications WHERE batch_id=? AND household_id=?').bind(id, householdId).run();
      }
      await removePhoto(row?.photo_path);
    },
    async notifications() {
      await reminders();
      const { results } = await db.prepare(`SELECT n.*, b.name, b.location, b.expiry_date FROM notifications n JOIN batches b ON b.id=n.batch_id AND b.household_id=n.household_id WHERE n.household_id=? AND b.discarded_at IS NULL ORDER BY n.created_at DESC`).bind(householdId).all();
      return results || [];
    },
    async readAll() {
      await db.prepare('UPDATE notifications SET read_at=? WHERE household_id=? AND read_at IS NULL').bind(now(), householdId).run();
    },
    async read(id) {
      const result = await db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND household_id=?').bind(now(), id, householdId).run();
      if (!result.meta.changes) throw Object.assign(new Error('Notification not found.'), { status: 404 });
    },
    async savePushSubscription(data) {
      const endpoint = text(data.endpoint, 2000);
      const p256dh = text(data.keys?.p256dh || data.p256dh, 200);
      const auth = text(data.keys?.auth || data.auth, 200);
      if (!endpointAllowed(endpoint) || !p256dh || !auth) throw Object.assign(new Error('Invalid push subscription.'), { status: 400 });
      const existing = await db.prepare('SELECT household_id,user_id FROM push_subscriptions WHERE endpoint=?').bind(endpoint).first();
      if (existing && (existing.household_id !== householdId || existing.user_id !== userId)) throw Object.assign(new Error('This push subscription belongs to another shop.'), { status: 409 });
      const result = await db.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,household_id,user_id,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth WHERE push_subscriptions.household_id=? AND push_subscriptions.user_id=?').bind(endpoint, p256dh, auth, householdId, userId, now(), householdId, userId).run();
      if (!result.meta.changes) throw Object.assign(new Error('This push subscription belongs to another shop.'), { status: 409 });
      return { endpoint };
    },
    async removePushSubscription(endpoint, subscriptionUserId = userId) {
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND household_id=? AND user_id=?').bind(text(endpoint, 2000), householdId, subscriptionUserId).run();
    },
    async deliverPushes({ fetchImpl = fetch, contact = 'mailto:household@craftloop.ca' } = {}) {
      await reminders();
      const pending = await db.prepare('SELECT id FROM notifications WHERE household_id=? AND pushed_at IS NULL').bind(householdId).all();
      const subs = await db.prepare('SELECT endpoint,user_id FROM push_subscriptions WHERE household_id=?').bind(householdId).all();
      if (!(pending.results || []).length || !(subs.results || []).length) return { sent: 0, gone: 0 };
      let sent = 0, gone = 0;
      for (const sub of subs.results || []) {
        try {
          const res = await sendPush(sub.endpoint, vapid, { fetchImpl, contact });
          if (res.status === 404 || res.status === 410) {
            await this.removePushSubscription(sub.endpoint, sub.user_id);
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
        const mark = db.prepare('UPDATE notifications SET pushed_at=? WHERE id=? AND household_id=? AND pushed_at IS NULL');
        for (const n of pending.results || []) await mark.bind(stamp, n.id, householdId).run();
      }
      return { sent, gone };
    }
  };
}
