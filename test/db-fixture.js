// Shared test helper (not a test): an in-memory SQLite database with every real migration applied, wrapped in the
// small subset of the D1 API the app uses (prepare/bind/first/all/run and transactional batch).
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function memoryDb() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const statement = (sql, values = []) => ({
    sql, values,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...values),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } })
  });
  const db = {
    prepare: sql => statement(sql),
    batch: async statements => {
      const out = [];
      sqlite.exec('BEGIN');
      try { for (const s of statements) out.push({ meta: { changes: sqlite.prepare(s.sql).run(...s.values).changes } }); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      return out;
    }
  };
  const rows = (sql, ...values) => sqlite.prepare(sql).all(...values).map(row => ({ ...row }));
  return { sqlite, db, rows };
}

/** People and Shops most email tests need: owner u1, member u2, outsider u3; Shops h1 (u1 owner, u2 member) and h2 (u3 owner). */
export function seedPeople(sqlite) {
  for (const [id, email] of [['u1', 'owner@example.test'], ['u2', 'member@example.test'], ['u3', 'other@example.test']]) {
    sqlite.prepare('INSERT INTO users VALUES (?,?)').run(id, 't');
    sqlite.prepare('INSERT INTO identities VALUES (?,?,?,?,?)').run('access', `sub-${id}`, id, email, 't');
  }
  for (const [id, name] of [['h1', 'Alpha'], ['h2', 'Beta']]) sqlite.prepare('INSERT INTO households VALUES (?,?,?)').run(id, name, 't');
  for (const [shop, user, role] of [['h1', 'u1', 'owner'], ['h1', 'u2', 'member'], ['h2', 'u3', 'owner']]) sqlite.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(shop, user, role, 't');
}
