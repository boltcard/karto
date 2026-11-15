// The phone's side of backups: fetch the server's
// latest snapshot when it isn't held, keep the last 24 and one a day for 7
// days, check each opens with the phrase's backup key into a database of this
// phrase's servers, and say how it is going. Storage, SQLite and the background job
// are behind small interfaces (src/backup/files.ts and the screens), so this
// is tested in Node.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CarddError, isRevoked, type BackupStatus, type CarddClient } from '../cardd/client';
import { whenText } from '../money/format';
import { isNetworkFailure } from '../lightning/lightning';
import { isGatewayError } from '../money/requests';
import { AgeError, ageDecrypt } from './age';

/**
 * A check's outcome: ok, a database of this phrase's servers; unreadable, it
 * doesn't decrypt with the phrase or isn't a database; other, it opens but names none of them.
 */
export type CheckResult = 'ok' | 'unreadable' | 'other';

/** A kept snapshot: its file's name and what the name says, its size, and checked once opened. */
export type Kept = { name: string; installId: string; version: number; created: number; size?: number; checked?: CheckResult };

/** Where the encrypted snapshots live on the phone. */
/** BackupFiles' methods that write: stopped, as the store's are, for a wallet that is off the phone (services/walletEpoch.ts). */
export const FILE_WRITES = ['write', 'remove', 'mark'] as const satisfies readonly (keyof BackupFiles)[];

export type BackupFiles = {
  /** Oldest first. */
  list(): Promise<Kept[]>;
  /** Replaces any file of that name, and clears its check mark: new bytes are not yet checked. */
  write(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array>;
  remove(name: string): Promise<void>;
  mark(name: string, result: CheckResult): Promise<void>;
};

/**
 * What a decrypted snapshot holds, as a rebuild shows and checks it: its server
 * (meta vm.id), its schema (user_version), the cards that aren't reset, and the total of the
 * personal accounts less open holds, as cardd works it out; created is unix seconds.
 */
export type SnapshotSummary = { vmId: string; userVersion: number; cards: number; totalMsat: number; created: number };

/** The server's latest snapshot as the phone last heard of it: the note outlives the VM. */
export type ServerLatest = { installId: string; version: number; created: number };

/** Snapshots are told apart by the server's install id and version (versions restart on a new install). */
export const snapshotName = (installId: string, version: number, created: number) => `${installId}-${version}-${created}.age`;

export function parseName(name: string): Omit<Kept, 'name' | 'checked'> | null {
  const m = /^([0-9a-f]+)-([0-9]+)-([0-9]+)\.age$/.exec(name);
  return m ? { installId: m[1], version: Number(m[2]), created: Number(m[3]) } : null;
}

/** The server answered, but has no backups API (an older cardd): not a failure. */
const noBackupsApi = (e: unknown) => e instanceof CarddError && e.status === 404;

/** The most a download may be: cardd.db is a few MB. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export type FetchResult =
  | { kind: 'fetched'; name: string }
  | { kind: 'up_to_date' }
  | { kind: 'none' }
  | { kind: 'foreign_recipient' }
  | { kind: 'bad_download'; reason: string }
  | { kind: 'revoked' }
  /** A cardd from before backups: it answers its 404 to GET /api/v1/backups. Update server fixes it. */
  | { kind: 'no_backups_api' }
  /** The server couldn't be reached (foregroundBackups only). */
  | { kind: 'unreachable' }
  /** Something else failed, such as the phone's storage (foregroundBackups only). */
  | { kind: 'failed'; reason: string };

/** The most of a reason (which can carry server text) the app shows. */
export const capReason = (s: string) => s.slice(0, 200);

export type FetchDeps = {
  cardd: Pick<CarddClient, 'backups' | 'backupFile'>;
  files: BackupFiles;
  /** This phrase's backup recipient (age1…), kept by the app: the background job never reads the phrase. */
  recipient: string;
  /** For thinning: the phone's clock and time zone (minutes east of UTC). */
  now?: () => number;
  offsetMin?: number;
  /** Notes the server's latest snapshot at every answer naming one, whatever the download then does. */
  noteLatest?: (latest: ServerLatest) => Promise<void>;
  /** The kept snapshot a rebuild chose (rebuild.ts rebuildKeeps): thinning never removes it. */
  keep?: string;
};

/**
 * Asks the server (checking in) and fetches its latest snapshot if this
 * phone doesn't hold it: never one encrypted to another key, too big, or
 * not the size and hash the server described. Then thins what is kept.
 * status is the server's answer, from before any download.
 */
export async function fetchLatest(d: FetchDeps): Promise<{ status: BackupStatus | null; result: FetchResult }> {
  let status: BackupStatus;
  try {
    status = await d.cardd.backups();
  } catch (e) {
    if (isRevoked(e)) return { status: null, result: { kind: 'revoked' } };
    if (noBackupsApi(e)) return { status: null, result: { kind: 'no_backups_api' } };
    throw e;
  }
  const latest = status.latest;
  const done = (result: FetchResult) => ({ status, result });
  if (!latest) return done({ kind: 'none' });
  await d.noteLatest?.({ installId: status.installId, version: latest.version, created: latest.created });
  if (status.recipient !== d.recipient) return done({ kind: 'foreign_recipient' });
  // The file is named from the server's answer: only cardd's own shapes, never a path.
  if (!/^[0-9a-f]{32}$/.test(status.installId) || !Number.isSafeInteger(latest.version) || latest.version < 1 ||
      !Number.isSafeInteger(latest.created) || latest.created < 0) {
    return done({ kind: 'bad_download', reason: 'the server described its snapshot oddly' });
  }
  const kept = await d.files.list();
  // A file of the wrong size (a write cut short) isn't held: it is fetched again.
  const held = (k: Kept) => k.installId === status.installId && k.version === latest.version && (k.size === undefined || k.size === latest.size);
  if (kept.some(held)) return done({ kind: 'up_to_date' });
  // A checked file is never replaced: a server describing its version anew (the name is only install, version, time) changed it.
  if (kept.some((k) => k.installId === status.installId && k.version === latest.version && k.checked === 'ok')) {
    return done({ kind: 'bad_download', reason: `the server changed snapshot ${latest.version}` });
  }
  if (latest.size > MAX_SNAPSHOT_BYTES) return done({ kind: 'bad_download', reason: `snapshot ${latest.version} is too big (${latest.size} bytes)` });
  let bytes: Uint8Array;
  try {
    bytes = await d.cardd.backupFile(latest.version, MAX_SNAPSHOT_BYTES);
  } catch (e) {
    if (e instanceof CarddError && e.code === 'too_big') return done({ kind: 'bad_download', reason: e.message });
    throw e;
  }
  if (bytes.length !== latest.size || bytesToHex(sha256(bytes)) !== latest.sha256) {
    return done({ kind: 'bad_download', reason: `snapshot ${latest.version} doesn't match what the server described` });
  }
  const name = snapshotName(status.installId, latest.version, latest.created);
  await d.files.write(name, bytes);
  const nowS = Math.floor((d.now ?? Date.now)() / 1000);
  for (const old of toRemove(await d.files.list(), nowS, d.offsetMin ?? -new Date(nowS * 1000).getTimezoneOffset(), d.keep)) await d.files.remove(old);
  return done({ kind: 'fetched', name });
}

/**
 * The background job: fetchLatest, and when another phone has revoked this one, onRevoked (which
 * stops the job). noteAnswered hears whether cardd answered GET /backups at all (an error is an
 * answer; a network failure isn't), for the server page's suggestion to rebuild.
 */
export async function backupJob(d: FetchDeps & { onRevoked: () => Promise<void>; noteAnswered?: (answered: boolean) => Promise<void> }): Promise<FetchResult> {
  let answered = false;
  const cardd = {
    backupFile: d.cardd.backupFile.bind(d.cardd),
    backups: () =>
      d.cardd.backups().then(
        (status) => ((answered = true), status),
        (e: unknown) => {
          answered = !isNetworkFailure(e) && !isGatewayError(e); // a proxy's 502: cardd itself didn't answer
          throw e;
        },
      ),
  };
  try {
    const { result } = await fetchLatest({ ...d, cardd });
    if (result.kind === 'revoked') await d.onRevoked();
    return result;
  } finally {
    await d.noteAnswered?.(answered);
  }
}

const DAY = 86400;

/**
 * The kept snapshots to remove: all but the last 24, for each of the 7 days
 * before today (the phone's calendar) that day's newest, the newest that
 * passed its check (checks run only while the app is open, so a server
 * sending bad snapshots can't push out the last good one), and `chosen`, a
 * rebuild's backup.
 */
export function toRemove(kept: Kept[], nowS: number, offsetMin: number, chosen?: string): string[] {
  const newest = [...kept].sort((a, b) => b.created - a.created || b.version - a.version);
  const keep = new Set(newest.slice(0, 24).map((k) => k.name));
  if (chosen) keep.add(chosen);
  const good = newest.find((k) => k.checked === 'ok');
  if (good) keep.add(good.name);
  const dayOf = (s: number) => Math.floor((s + offsetMin * 60) / DAY);
  const today = dayOf(nowS);
  // Each of the 7 days before: its newest good copy, else its newest.
  const daily = new Map<number, Kept>();
  for (const k of newest) {
    const d = dayOf(k.created);
    if (d >= today || d < today - 7) continue;
    const had = daily.get(d);
    if (!had || (had.checked !== 'ok' && k.checked === 'ok')) daily.set(d, k);
  }
  for (const k of daily.values()) keep.add(k.name);
  return kept.filter((k) => !keep.has(k.name)).map((k) => k.name);
}

/**
 * Opens snapshots not yet checked with the phrase's backup identity and
 * checks each is an SQLite database whose meta vm.id is one of vmIds, this
 * phrase's servers (machine.ts serversOfThisPhrase): openDb answers its
 * vm.id, '' if it has none, or null if it isn't a database. Each is marked
 * ok, unreadable (no decryption, or no database) or other (another server's,
 * or none named).
 * Runs while the app is open, as it needs the phrase; decryption takes
 * seconds on the phone, so at most `limit` (3) a call, newest first (the
 * newest decides the warning); the rest wait for the next. A read or open
 * that throws (not an AgeError) leaves the file unmarked to be tried again. Returns every
 * kept snapshot, oldest first.
 */
export async function checkKept(d: {
  files: BackupFiles;
  identity: string;
  vmIds: string[];
  openDb: (plain: Uint8Array) => Promise<string | null>;
  limit?: number;
}): Promise<Kept[]> {
  const out = await d.files.list();
  let left = d.limit ?? 3;
  for (const k of [...out].reverse()) {
    if (left <= 0) break;
    if (!k.checked) {
      left--;
      let vmId: string | null;
      try {
        vmId = await d.openDb(ageDecrypt(await d.files.read(k.name), d.identity));
      } catch (e) {
        // Only a file that can't be decrypted is unreadable for good; a failed read or open may pass next visit.
        if (!(e instanceof AgeError)) continue;
        vmId = null;
      }
      k.checked = vmId === null ? 'unreadable' : d.vmIds.includes(vmId) ? 'ok' : 'other';
      await d.files.mark(k.name, k.checked);
    }
  }
  return out;
}

const HELD_BACK = 'Android may be holding the app back: open it now and then.';

/**
 * The server page's backups line and warnings, from the server's answer
 * before this phone downloaded anything (so a snapshot that waited, or a day
 * with no check-in, still shows) and what the phone keeps.
 */
export function backupView(status: BackupStatus | null, kept: Kept[], ownRecipient: string, nowS: number, offsetMin = -new Date(nowS * 1000).getTimezoneOffset(), fetchedAt?: number) {
  // status is from before this visit's download: a fetch just made shows its own time.
  const lastFetch = fetchedAt ?? status?.lastDownload;
  const lines =
    kept.length === 0
      ? ['No backup on this phone yet']
      : [...(lastFetch ? [`Last one ${whenText(lastFetch, nowS, offsetMin)}`] : []), `${kept.length} kept on this phone`];
  // The server's record of the last check-in, the background job's while the app was closed.
  if (status?.lastCheckIn) lines.push(`This phone last checked ${whenText(status.lastCheckIn, nowS, offsetMin)}`);
  const warnings: string[] = [];
  if (status) {
    const l = status.latest;
    if (l && l.created < nowS - DAY && status.lastDownload < l.created) warnings.push(`A backup waited over a day for this phone. ${HELD_BACK}`);
    if (status.lastCheckIn > 0 && status.lastCheckIn < nowS - DAY) warnings.push(`No phone checked for backups for over a day. ${HELD_BACK}`);
    if (status.problem) warnings.push(`Your server can't make backups: ${status.problem.slice(0, 200)}.`);
    if (status.recipient && status.recipient !== ownRecipient) warnings.push("Your server's backups aren't locked to your recovery phrase. Update your server to fix it.");
  }
  const newest = [...kept].sort((a, b) => b.created - a.created)[0];
  if (newest?.checked === 'unreadable') warnings.push("The latest backup on this phone can't be opened with your recovery phrase.");
  if (newest?.checked === 'other') warnings.push("The latest backup on this phone opens with your recovery phrase, but it is another server's, not this one's.");
  // The Settings row says the last fetch in its own words.
  return { lines, warnings, lastFetch: lastFetch || null };
}

export type ForegroundResult = { status: BackupStatus | null; result: FetchResult; kept: Kept[] };

/**
 * The server page opening: fetch the latest snapshot, then check what is
 * kept with the phrase (also when the server can't be reached). A revoked
 * phone stops here: onRevoked stops the background job.
 */
export async function foregroundBackups(
  d: FetchDeps & {
    identity: string;
    /** This phrase's servers (machine.ts serversOfThisPhrase), for checkKept. */
    vmIds: string[];
    openDb: (plain: Uint8Array) => Promise<string | null>;
    onRevoked: () => Promise<void>;
  },
): Promise<ForegroundResult> {
  // The server's answer is kept even when a later step fails.
  let status: BackupStatus | null = null;
  const cardd = {
    backupFile: d.cardd.backupFile.bind(d.cardd),
    backups: async () => (status = await d.cardd.backups()),
  };
  let fetched: { status: BackupStatus | null; result: FetchResult };
  try {
    fetched = await fetchLatest({ ...d, cardd });
  } catch (e) {
    // Caddy's 502, 503 or 504 (cardd restarting, as during Update server) is cardd not answering too.
    const network = isNetworkFailure(e) || isGatewayError(e) || (e instanceof Error && e.name === 'AbortError');
    fetched = { status, result: network ? { kind: 'unreachable' } : { kind: 'failed', reason: capReason(e instanceof Error ? e.message : String(e)) } };
  }
  if (fetched.result.kind === 'revoked') {
    await d.onRevoked();
    return { ...fetched, kept: [] };
  }
  return { ...fetched, kept: await checkKept(d) };
}
