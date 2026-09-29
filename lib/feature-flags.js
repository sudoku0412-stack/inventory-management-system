// Registry of flags staff can switch per Shop. The `env` variable is the global default a Shop follows
// until an explicit override row exists; an override (on or off) always wins, and is read on every request.
export const FLAGS = Object.freeze({
  shop_deletion: { label: 'Shop deletion', env: 'SHOP_DELETION_ENABLED', help: 'Owners of this Shop can delete it.' },
  shop_purge: { label: 'Automatic purge', env: 'SHOP_PURGE_ENABLED', help: 'A deleted Shop is permanently purged when its keep period ends. Off holds its data.' }
});

export const isFlag = name => Object.hasOwn(FLAGS, name);
const globalOn = (env, name) => env?.[FLAGS[name].env] === 'true';

/** Overrides for one Shop as { flagName: boolean }. A missing table (older database) means no overrides. */
export async function shopOverrides(db, householdId) {
  try {
    const { results } = await db.prepare('SELECT flag, enabled FROM shop_feature_flags WHERE household_id=?').bind(householdId).all();
    return Object.fromEntries((results || []).filter(row => isFlag(row.flag)).map(row => [row.flag, Boolean(row.enabled)]));
  } catch { return {}; }
}

export async function effectiveFlag(db, env, householdId, name) {
  const overrides = await shopOverrides(db, householdId);
  return Object.hasOwn(overrides, name) ? overrides[name] : globalOn(env, name);
}

/** The admin view of every flag for a Shop. `override` is true, false, or null (follow global). */
export async function shopFlagStates(db, env, householdId) {
  const overrides = await shopOverrides(db, householdId);
  return Object.entries(FLAGS).map(([flag, meta]) => {
    const override = Object.hasOwn(overrides, flag) ? overrides[flag] : null;
    return { flag, label: meta.label, help: meta.help, global: globalOn(env, flag), override, effective: override ?? globalOn(env, flag) };
  });
}
