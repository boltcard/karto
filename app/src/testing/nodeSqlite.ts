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
