// A decrypted snapshot's summary (src/backup/summary.ts) read with Node's
// SQLite, the same way (readContents, quick check first) as inspectSnapshot reads it on the phone with expo-sqlite.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readContents, SnapshotUnreadable, type SnapshotContents } from '../backup/summary';

export async function nodeInspectSnapshot(plain: Uint8Array): Promise<SnapshotContents | null> {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'));
  let db: DatabaseSync;
  try {
    writeFileSync(join(dir, 'cardd.db'), plain);
    db = new DatabaseSync(join(dir, 'cardd.db'), { readOnly: true });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new SnapshotUnreadable(e instanceof Error ? e.message : String(e));
  }
  try {
    return await readContents({ get: async (sql) => db.prepare(sql).get() });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
