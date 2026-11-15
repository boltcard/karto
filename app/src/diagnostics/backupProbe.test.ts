import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { probeBackup } from './backupProbe';

// Node's SQLite standing in for expo-sqlite's serialize and deserialize.
async function makeDb(rows: number, vmId: string): Promise<Uint8Array> {
  const path = join(mkdtempSync(join(tmpdir(), 'probe-')), 'x.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE filler (b BLOB);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO filler SELECT randomblob(1000) FROM n;`);
  db.prepare(`INSERT INTO meta VALUES ('vm.id', ?)`).run(vmId);
  db.close();
  return new Uint8Array(readFileSync(path));
}
async function openDb(plain: Uint8Array): Promise<string | null> {
  const path = join(mkdtempSync(join(tmpdir(), 'open-')), 'x.db');
  writeFileSync(path, plain);
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'vm.id'`).get() as { value: string } | undefined;
  db.close();
  return row?.value ?? null;
}

describe('probeBackup', () => {
  // The phone diagnostics' backup check (make phone-backup-probe): a database
  // of a few MB, encrypted as cardd does, decrypted and opened as the app does, timed.
  it('decrypts and opens a database of a few MB, reporting how long each took', async () => {
    const r = await probeBackup({ makeDb, openDb, rows: 3000, now: () => performance.now() });
    expect(r.map((x) => [x.name, x.ok])).toEqual([['make', true], ['encrypt', true], ['decrypt', true], ['open', true]]);
    expect(r[0].detail).toMatch(/^\d[\d.]* MB in \d+ ms$/);
    expect(r[2].detail).toMatch(/ms/);
  });
});
