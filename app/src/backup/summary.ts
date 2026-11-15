// What a snapshot holds, as a rebuild shows and checks it before restoring
// it. The SQL is shared: the phone runs it with
// expo-sqlite on the database opened from memory (files.ts), the tests with
// Node's SQLite on a snapshot cardd made (testvectors/snapshot.db).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import { AgeError, ageDecrypt } from './age';
import { parseName, type BackupFiles, type SnapshotSummary } from './backups';

/**
 * A decrypted snapshot's summary, less its time, which is in the kept file's
 * name; changed is the time of the database's last write (unix s).
 */
export type SnapshotContents = Omit<SnapshotSummary, 'created'> & { changed: number };

/**
 * One row: the server (meta vm.id), the schema, the cards not reset, the
 * total as cardd's OwedMsat works it out (server/internal/store/money.go,
 * copied: the personal accounts' entries less what open holds reserve), and
 * the latest time any table records. Fails on a database without cardd's tables.
 */
export const SUMMARY_SQL = `SELECT
  COALESCE((SELECT value FROM meta WHERE key = 'vm.id'), '') AS vmId,
  (SELECT user_version FROM pragma_user_version) AS userVersion,
  (SELECT COUNT(*) FROM cards WHERE state != 'reset') AS cards,
  (SELECT COALESCE(SUM(amount_msat), 0) FROM ledger_entry WHERE account IN ('pool', 'hosting', 'shop') OR account LIKE 'card:%')
    - (SELECT COALESCE(SUM(amount_msat + fee_budget_msat), 0) FROM holds WHERE state = 'open') AS totalMsat,
  (SELECT COALESCE(MAX(t), 0) FROM (
    SELECT MAX(updated_at) AS t FROM meta UNION ALL SELECT MAX(updated_at) FROM cards
    UNION ALL SELECT MAX(created_at) FROM ledger_tx UNION ALL SELECT MAX(COALESCE(resolved_at, created_at)) FROM holds
    UNION ALL SELECT MAX(COALESCE(revoked_at, created_at)) FROM devices)) AS changed`;

/**
 * Run before SUMMARY_SQL: a database with damaged pages may still answer it, and
 * must not be restored (cardd restore's integrity_check would refuse it later).
 */
export const QUICK_CHECK_SQL = 'PRAGMA quick_check';

/** Whether QUICK_CHECK_SQL's first row says the database is whole. */
export const checkedOk = (row: unknown) => (row as Record<string, unknown> | null | undefined)?.quick_check === 'ok';

/**
 * Run after the quick check, on its own: a newer cardd may have changed a column
 * SUMMARY_SQL reads, and the version is all a rebuild needs to refuse it.
 */
export const USER_VERSION_SQL = 'PRAGMA user_version';

/**
 * What a database of a newer schema than this app's reports: only its version
 * (the other fields are unread, so zero), which the rebuild refuses ("update
 * the app first"). Null if the version isn't newer, so SUMMARY_SQL should be read.
 */
export function newerContents(row: unknown): SnapshotContents | null {
  const v = (row as Record<string, unknown> | null | undefined)?.user_version;
  if (!Number.isSafeInteger(v) || (v as number) <= CARDD_SCHEMA_VERSION) return null;
  return { vmId: '', userVersion: v as number, cards: 0, totalMsat: 0, changed: 0 };
}

/** SUMMARY_SQL's row, or null if it isn't one. */
export function contentsOf(row: unknown): SnapshotContents | null {
  const r = row as Record<string, unknown> | null | undefined;
  if (!r || typeof r.vmId !== 'string') return null;
  const ints = [r.userVersion, r.cards, r.totalMsat, r.changed];
  if (!ints.every((n) => Number.isSafeInteger(n))) return null;
  const [userVersion, cards, totalMsat, changed] = ints as number[];
  return { vmId: r.vmId, userVersion, cards, totalMsat, changed };
}

/**
 * A decrypted snapshot the phone couldn't open or read (its memory, the native module): unlike a file
 * SQLite refuses, this says nothing about the backup, so a second try may open it.
 */
export class SnapshotUnreadable extends Error {
  constructor(why: string) {
    super(`The backup couldn't be opened on this phone: ${why}`);
  }
}

/** Whether an error is SQLite's verdict on the file itself: not a database, damaged, or without cardd's tables. */
const refusedBySqlite = (message: string) => /not a database|malformed|no such (table|column)|unsupported file format/i.test(message);

/** A database opened from a decrypted snapshot, as either SQLite binding reads it: a query's first row. */
export type SnapshotDb = { get(sql: string): Promise<unknown> };

/**
 * What a decrypted snapshot holds, read with the summary's SQL (quick check first): null if SQLite or the
 * answers say it isn't a whole cardd database. Any other failure throws SnapshotUnreadable.
 */
export async function readContents(db: SnapshotDb): Promise<SnapshotContents | null> {
  try {
    if (!checkedOk(await db.get(QUICK_CHECK_SQL))) return null;
    const newer = newerContents(await db.get(USER_VERSION_SQL));
    if (newer) return newer;
    return contentsOf(await db.get(SUMMARY_SQL));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (refusedBySqlite(message)) return null;
    throw new SnapshotUnreadable(message);
  }
}

/** Opens a decrypted snapshot: null if it isn't a whole cardd database; throws SnapshotUnreadable if the phone couldn't open it. */
type Opener = { identity: string; open: (plain: Uint8Array) => Promise<SnapshotContents | null> };

/**
 * A kept snapshot opened with the phrase's backup identity (in memory): what
 * open reads, its time from the file's name. Null if the phrase can't open
 * it or it isn't a cardd database; a failed read throws, as does a database
 * the phone couldn't open (SnapshotUnreadable).
 */
export async function inspectKept(d: Opener & { files: Pick<BackupFiles, 'read'> }, name: string): Promise<SnapshotSummary | null> {
  const p = parseName(name);
  const x = p && (await decryptAndOpen(await d.files.read(name), d));
  return x && { vmId: x.vmId, userVersion: x.userVersion, cards: x.cards, totalMsat: x.totalMsat, created: p.created };
}

async function decryptAndOpen(file: Uint8Array, d: Opener): Promise<SnapshotContents | null> {
  let plain: Uint8Array;
  try {
    plain = ageDecrypt(file, d.identity);
  } catch (e) {
    if (e instanceof AgeError) return null;
    throw e;
  }
  return d.open(plain);
}

/**
 * The name an exported snapshot is kept under once imported, after opening it
 * with the phrase whatever its name: its own, if the person didn't rename it. Else one made from its content, as a name
 * parseName accepts: the file's hash as the install id and version 0, which
 * no snapshot fetched from a server has (cardd's versions start at 1), so it
 * never takes a real snapshot's name, and the same file imported again gets
 * the same one; the time is its database's last write (the snapshot's own
 * time was only in the name). Throws if the phrase can't open it, its schema is newer than this app's,
 * or the phone couldn't open it (SnapshotUnreadable).
 */
export async function importName(picked: string, file: Uint8Array, d: Opener): Promise<string> {
  const x = await decryptAndOpen(file, d);
  if (!x) throw new Error("This file isn't a backup your recovery phrase opens.");
  if (x.userVersion > CARDD_SCHEMA_VERSION) {
    throw new Error(`This backup was made by a newer version of the server than this app carries: update the app first (its schema is ${x.userVersion}, this app's ${CARDD_SCHEMA_VERSION}).`);
  }
  if (parseName(picked)) return picked;
  return `${bytesToHex(sha256(file)).slice(0, 32)}-0-${x.changed}.age`;
}

/**
 * Keeps an imported file under its name, never replacing a different file
 * already kept under it (which may be the good copy): the same bytes are
 * already kept, anything else is refused.
 */
export async function keepImported(name: string, bytes: Uint8Array, files: Pick<BackupFiles, 'list' | 'read' | 'write'>): Promise<string> {
  if ((await files.list()).some((k) => k.name === name)) {
    const kept = await files.read(name);
    if (kept.length === bytes.length && kept.every((b, i) => b === bytes[i])) return name;
    throw new Error('A different backup is already kept under this name, and is left as it is.');
  }
  await files.write(name, bytes);
  return name;
}
