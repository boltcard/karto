// Where the phone keeps its encrypted snapshots, opens one from memory, and
// exports them, and imports an exported one for a
// rebuild: the app's own files, which aren't in Android's system
// backup (the app's backup rules include its preferences only).
import { getDocumentAsync } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { StorageAccessFramework, EncodingType } from 'expo-file-system/legacy';
import { deserializeDatabaseAsync } from 'expo-sqlite';
import { base64 } from '@scure/base';
import { MAX_SNAPSHOT_BYTES, parseName, type BackupFiles, type CheckResult, type Kept } from './backups';
import { importName, keepImported, readContents, SnapshotUnreadable, type SnapshotContents } from './summary';

const dir = () => new Directory(Paths.document, 'backups');

/** A check's result, as a file beside its snapshot. */
const MARKS: readonly CheckResult[] = ['ok', 'unreadable', 'other'];
/** Every mark a snapshot can have: an older app's .bad (either of the last two) counts as unchecked, so it is checked again. */
const ALL_MARKS = [...MARKS, 'bad'];

/** The snapshots in the app's files; a check's result is a small file beside each (<name>.ok, .unreadable or .other). */
export function phoneFiles(): BackupFiles {
  const ensure = () => {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    return d;
  };
  const unmark = (d: Directory, name: string) => {
    for (const m of ALL_MARKS) {
      const f = new File(d, `${name}.${m}`);
      if (f.exists) f.delete();
    }
  };
  return {
    list: async () => {
      // No folder is made to look in: a check still on its way when a wallet is removed must not put it back.
      const d = dir();
      if (!d.exists) return [];
      const all = new Map(d.list().filter((e) => e instanceof File).map((f) => [f.name, f as File]));
      const out: Kept[] = [];
      for (const [name, f] of all) {
        const p = parseName(name);
        if (!p) continue;
        const checked = MARKS.find((m) => all.has(`${name}.${m}`));
        out.push({ name, ...p, size: f.size, checked });
      }
      return out.sort((a, b) => a.created - b.created || a.version - b.version);
    },
    // Written beside it and moved into place, so a write cut short never
    // leaves a short file under a snapshot's name. A new write clears any
    // check mark for that name.
    write: async (name, bytes) => {
      const d = ensure();
      const tmp = new File(d, `${name}.tmp`);
      if (tmp.exists) tmp.delete();
      tmp.create();
      tmp.write(bytes);
      const f = new File(d, name);
      if (f.exists) f.delete();
      await tmp.move(f);
      unmark(d, name);
    },
    read: async (name) => new File(ensure(), name).bytes(),
    remove: async (name) => {
      const d = ensure();
      const f = new File(d, name);
      if (f.exists) f.delete();
      unmark(d, name);
    },
    mark: async (name, result) => {
      const d = ensure();
      unmark(d, name);
      new File(d, `${name}.${result}`).create();
    },
  };
}

/** Removes every snapshot the phone keeps, with its folder (a wallet taken off an iPhone); throws if it is still there. */
export async function removeKeptBackups(): Promise<void> {
  const d = dir();
  if (d.exists) d.delete();
  if (dir().exists) throw new Error('the backups folder is still there');
}

/**
 * meta vm.id of a decrypted snapshot, opened from memory (the plaintext never touches the disk): '' for a
 * database without one; null only if it can't be opened or read as a cardd database.
 */
export async function openSnapshot(plain: Uint8Array): Promise<string | null> {
  let db: Awaited<ReturnType<typeof deserializeDatabaseAsync>> | null = null;
  try {
    db = await deserializeDatabaseAsync(plain);
    const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = 'vm.id'`);
    return row?.value ?? '';
  } catch {
    return null;
  } finally {
    await db?.closeAsync().catch(() => {});
  }
}

/**
 * What a decrypted snapshot holds (summary.ts), opened from memory like openSnapshot: null if it isn't a
 * whole cardd database; throws SnapshotUnreadable if the phone couldn't open it (a second try may).
 */
export async function inspectSnapshot(plain: Uint8Array): Promise<SnapshotContents | null> {
  let db: Awaited<ReturnType<typeof deserializeDatabaseAsync>>;
  try {
    db = await deserializeDatabaseAsync(plain);
  } catch (e) {
    throw new SnapshotUnreadable(e instanceof Error ? e.message : String(e));
  }
  try {
    return await readContents({ get: (sql) => db.getFirstAsync(sql) });
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

/**
 * Choose an exported backup… (a rebuild's step 1): Android's file picker,
 * then the encrypted file copied at once into the backups folder under its
 * own name, or one made from its content if the person renamed it (which
 * needs the phrase's backup identity: importName). Returns the kept name, or
 * null if the person backed out of the picker; throws for a file that is
 * too big, that the phrase can't open (whatever its name) or of a newer schema, that the phone couldn't open,
 * or if a different backup is kept under its name.
 */
export async function importExported(identity: string, files: Pick<BackupFiles, 'list' | 'read' | 'write'> = phoneFiles()): Promise<string | null> {
  const picked = await getDocumentAsync({ copyToCacheDirectory: true, type: '*/*' });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  const copy = new File(asset.uri);
  try {
    if (copy.size > MAX_SNAPSHOT_BYTES) throw new Error(`This file is too big to be a backup (${copy.size} bytes).`);
    const bytes = await copy.bytes();
    const name = await importName(asset.name, bytes, { identity, open: inspectSnapshot });
    return await keepImported(name, bytes, files);
  } finally {
    if (copy.exists) copy.delete();
  }
}

/**
 * Export backups: Android's folder picker (the Storage Access Framework,
 * through expo-file-system's legacy API: the new one has no folder picker),
 * then every kept snapshot written there, still encrypted. Returns how many,
 * or null if the person backed out of the picker.
 */
export async function exportBackups(files: BackupFiles): Promise<number | null> {
  const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!perm.granted) return null;
  const kept = await files.list();
  for (const k of kept) {
    const uri = await StorageAccessFramework.createFileAsync(perm.directoryUri, k.name, 'application/octet-stream');
    await StorageAccessFramework.writeAsStringAsync(uri, base64.encode(await files.read(k.name)), { encoding: EncodingType.Base64 });
  }
  return kept.length;
}
