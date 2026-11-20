// expo-sqlite's async API (the part AppStore uses) over Node's built-in
// SQLite, so the store's SQL runs against a real database in tests.
import { DatabaseSync } from 'node:sqlite';
import type { SqlDb } from '../store/store';

export function nodeSqlite(path = ':memory:'): SqlDb & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...params) => db.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: (string | number | null)[]) => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

/**
 * nodeSqlite as expo-sqlite's native calls really go: getFirstAsync steps its statement to the first row, yields, and
 * only then finalizes it, so its connection holds a read open across other calls (expo-sqlite 57's
 * SQLiteDatabase.getFirstAsync: prepare, execute, finalize). afterStep runs once each read has stepped: where a test
 * puts the other connection's write (the background job's, backup/jobDb.ts).
 */
export function expoLikeSqlite(path: string, o: { afterStep?: () => void } = {}): SqlDb & { close(): void } {
  const db = new DatabaseSync(path);
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    execAsync: async (sql) => {
      await Promise.resolve();
      db.exec(sql);
    },
    runAsync: async (sql, ...params) => {
      const statement = db.prepare(sql);
      await Promise.resolve();
      return statement.run(...params);
    },
    getFirstAsync: async <T>(sql: string, ...params: (string | number | null)[]) => {
      const rows = db.prepare(sql).iterate(...params);
      const first = rows.next();
      o.afterStep?.();
      await tick();
      rows.return?.();
      return first.done ? null : (first.value as T);
    },
    // Its read is open from the first row (execute) to the native getAll's end, as expo-sqlite's getAllAsync.
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) => {
      const rows = db.prepare(sql).iterate(...params);
      const first = rows.next();
      if (first.done) return [];
      o.afterStep?.();
      await tick();
      return [first.value, ...rows] as T[];
    },
    close: () => db.close(),
  };
}
