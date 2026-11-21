// The app's own state on the phone.
// One small key-value table of
// JSON documents; the recovery phrase lives in secrets.ts, never here.
import type { ServerLatest } from '../backup/backups';
import type { CardState } from '../cardd/client';
import type { MoneyRequest } from '../money/requests';
import { isUnit, type Unit } from '../money/view';
import type { OnboardingState } from '../onboarding/machine';
import { savedSteps } from '../onboarding/install';

type Param = string | number | null;

/** The part of expo-sqlite's SQLiteDatabase this module uses. */
export type SqlDb = {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Param[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Param[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Param[]): Promise<T[]>;
};

const ONBOARDING = 'onboarding';

/**
 * What the phone remembers about a card, so a wipe works without the VM
 *. pending: 'wipe' — the server wasn't told a wipe started;
 * 'wiped' — the card is wiped and the server hasn't heard it finish.
 */
export type CachedCard = { id: string; version: number; name: string; state: CardState; pending?: 'wipe' | 'wiped' };

const CARDS = 'cards';
/** Moves and sends not yet answered, by request id (src/money/requests.ts). */
const REQUESTS = 'requests';
/** The phrase's backup recipient (a public key), for the background job, which never reads the phrase. */
const BACKUP_RECIPIENT = 'backup.recipient';
/** cardd said this phone's key is unknown or revoked: another phone restored the server. */
const REVOKED = 'device.revoked';
/** The server's latest snapshot as it last reported it, which a rebuild compares its backup with. */
const SERVER_LATEST = 'backup.server_latest';
/** When cardd first failed to answer (ms), cleared once it answers: the server page suggests a rebuild after an hour. */
const UNREACHABLE_SINCE = 'cardd.unreachable_since';
/** The restore (cardd's time for it, unix seconds) the person checked the PoS phones after: the page's note stays away until another. */
const POS_RESTORE_CHECKED = 'pos.restore_checked';
/** Each card's photo, one row per card: PHOTO + the card's id. */
const PHOTO = 'photo.';
/** The cards of other phones that the wallet removed, until the person has been told. */
const REMOVED_PHONE_CARDS = 'phone_card.removed';
/**
 * The unit every amount is shown in: 'fiat', 'sat' or 'msat'. Before Settings held the view this one value kept it,
 * 'hidden' too: a phone that kept 'hidden' reads as sat, hidden.
 */
const AMOUNT_VIEW = 'view.amount';
/** Whether amounts are hidden (Settings' Hide amounts, the Wallet page's eye); absent on a phone from before it. */
const AMOUNTS_HIDDEN = 'view.hidden';
/** The unit every amount field types in: 'fiat' or 'sat'. */
const TYPING_UNIT = 'view.typing_unit';
/** The offer to turn alerts on has been made: it is made once. */
const ALERTS_OFFERED = 'alerts.offered';
/** What the phone last handed the server for its alerts (AlertsSent); none while alerts are off. */
const ALERTS_SENT = 'alerts.sent';

/** A card removed because it was another phone's: its name and what moved to Pool (null: the server wouldn't say). */
export type RemovedPhoneCard = { name: string; amountMsat: number | null };

/**
 * The endpoint the phone last handed cardd for its alerts (alerts/register.ts): its URL, cardd's createdAt for it
 * (unix seconds) and the server's VAPID public key it was registered with, so the check on each open sees a new
 * endpoint, a server that lost or replaced it, and a server with a new key.
 */
export type AlertsSent = { endpoint: string; createdAt: number; vapid: string };

/** A card's photo as the phone keeps it: cardd's tag for it, and the JPEG in base64. */
export type CachedPhoto = { tag: string; jpeg: string };

/**
 * Every method below that writes. Work for a wallet is given the store through the wallet's epoch
 * (services/walletEpoch.ts), which stops these once that wallet is off the phone. The store's test holds the list
 * to the class: a new method must be named here or there.
 */
export const STORE_WRITES = [
  'saveOnboarding', 'saveCard', 'savePending', 'dropPending', 'saveBackupRecipient', 'setRevoked', 'saveServerLatest', 'noteCarddAnswered',
  'savePosRestoreChecked', 'savePhoto', 'dropPhoto', 'noteRemovedPhoneCard', 'dismissRemovedPhoneCards',
  'setAmountUnit', 'setAmountsHidden', 'setTypingUnit', 'setAlertsOffered', 'saveAlertsSent',
] as const satisfies readonly (keyof AppStore)[];

/** A connection and the end of the queue of the store's calls on it. */
type Line = { db: SqlDb & { closeAsync?(): Promise<void> }; tail: Promise<void> };

export class AppStore {
  /** A reconnect on its way, handed to a second caller (two presses of Try again). */
  private reconnecting: Promise<boolean> | null = null;
  private line: Line;

  private constructor(db: SqlDb) {
    this.line = { db, tail: Promise.resolve() };
  }

  /**
   * One step on the connection, after every step asked for before it has ended. expo-sqlite runs a statement as
   * separate native calls (prepare, execute, finalize) and a SELECT that found a row holds its read open until it is
   * finalized; a write of this connection's made meanwhile is refused at once if the job's connection
   * (backup/jobDb.ts) has written or is writing (SQLITE_BUSY_SNAPSHOT or SQLITE_BUSY), whatever busy_timeout says. One
   * step at a time, a write never meets a read of its own, and waits for the job's as busy_timeout intends. A step
   * reads and writes on the db it is handed only, never through the store: it would wait for itself. A failed step
   * doesn't stop the next. A step that never ends would hold up every later one: expo-sqlite rejects at once on a
   * dead connection, and nothing else is known to hang. Each connection has its own queue: after a reconnect,
   * what was asked of the old one ends there.
   */
  private step<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
    const line = this.line;
    const run = line.tail.then(() => fn(line.db));
    line.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  static async open(db: SqlDb): Promise<AppStore> {
    await AppStore.prepare(db);
    return new AppStore(db);
  }

  private static async prepare(db: SqlDb): Promise<void> {
    // busy_timeout: the background job writes on a connection of its own (backup/jobDb.ts), and a write that meets
    // the other connection's waits for it, up to 5 s, rather than failing at once with "database is locked". First,
    // so the switch to WAL waits too (the other connection closing holds the file for its last checkpoint).
    // secure_delete: what is deleted or replaced (a dropped photo, an old card list, a note) is overwritten, not left
    // in the file's free pages. fullfsync: on an iPhone each commit is flushed past the drive's cache, so a pending
    // wipe's record outlives a power cut (Android ignores it).
    await db.execAsync(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      PRAGMA fullfsync = ON;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`);
  }

  /**
   * Try again after a read failed: a connection that still answers is kept and nothing is opened; one
   * that doesn't (expo-sqlite had destroyed its native binding, and every call failed until the app was stopped)
   * is replaced by the one open() gives, and let go of, a failure to close it swallowed. Whether it was replaced.
   * open() must give a new connection, not expo-sqlite's cached dead one (services.tsx, reopenAppDb). A second
   * call while one runs gets the same answer: two would each open one, and the second close the first's new
   * connection under whatever was reading through it.
   */
  reconnect(open: () => Promise<SqlDb & { closeAsync(): Promise<void> }>): Promise<boolean> {
    this.reconnecting ??= (async () => {
      try {
        // On the connection itself, not after the queue: a stuck step must not hold up Try again.
        await this.line.db.getFirstAsync('SELECT 1');
        return false;
      } catch {
        // dead: replaced below
      }
      const fresh = await open();
      try {
        await AppStore.prepare(fresh);
      } catch (e) {
        await fresh.closeAsync().catch(() => {});
        throw e;
      }
      const old = this.line.db;
      this.line = { db: fresh, tail: Promise.resolve() };
      await old.closeAsync?.().catch(() => {});
      return true;
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  /**
   * Forgets everything: the wallet is being removed from the phone.
   * The rows are overwritten as they go and the file is rebuilt and its log emptied, so nothing of
   * them stays in the file's free pages. On the connection that is open: the app opens its database once per run
   * (services/startup.ts), so the file is not deleted and opened again.
   * It checks its own work and throws if any of it is still there: a row written meanwhile, or a log that could
   * not be folded into the file because another connection was reading, which leaves the old pages in place: the
   * background job's, which has a connection of its own (backup/jobDb.ts), or a statement of this one's
   * still running, which makes SQLite refuse the rebuild and throws here too. Run again, it finishes.
   * What this cannot do: the file's dropped tail and its log are cut off, not written over, so their blocks stay
   * on the phone's storage until it reuses them, readable only beneath the file system.
   */
  clear(): Promise<void> {
    return this.step(async (db) => {
      await db.execAsync(`PRAGMA secure_delete = ON;
        DELETE FROM kv;
        VACUUM;`);
      const left = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM kv'))?.n;
      if (left !== 0) throw new Error(`the app's database still holds ${left ?? 'some'} ${left === 1 ? 'row' : 'rows'}`);
      // busy: the checkpoint did not run to its end. Not an error to SQLite, so it is read here.
      const folded = await db.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
      if (!folded || folded.busy !== 0) throw new Error("the app's database is in use, and what it held is still in its file");
    });
  }

  private get<T>(key: string): Promise<T | null> {
    return this.step((db) => read<T>(db, key));
  }

  private put(key: string, value: unknown): Promise<void> {
    return this.step((db) => write(db, key, value));
  }

  /**
   * A value read and its new value written as one step: two on this store at once each see the other's write (the
   * job's store, on its own connection, is not in this queue). next giving back what it was handed writes nothing.
   */
  /** damagedAsNone: a value that isn't JSON reads as none, for a key whose value is only ever added to. */
  private update<T>(key: string, next: (old: T | null) => unknown, o: { damagedAsNone?: boolean } = {}): Promise<void> {
    return this.step(async (db) => {
      const old = await read<T>(db, key).catch((e) => {
        if (o.damagedAsNone && e instanceof SyntaxError) return null;
        throw e;
      });
      const value = next(old);
      if (value !== old) await write(db, key, value);
    });
  }

  /** The saved setup, its finished steps read as this app knows them (savedSteps: an older app's 'system'). */
  async onboarding(): Promise<OnboardingState | null> {
    const s = await this.get<OnboardingState>(ONBOARDING);
    if (!s) return null;
    const before = s.rebuild?.before;
    return {
      ...s,
      installed: savedSteps(s.installed ?? []),
      ...(before?.installed && { rebuild: { ...s.rebuild!, before: { ...before, installed: savedSteps(before.installed) } } }),
    };
  }

  saveOnboarding(s: OnboardingState): Promise<void> {
    return this.put(ONBOARDING, s);
  }

  async cards(): Promise<Record<string, CachedCard>> {
    return (await this.get<Record<string, CachedCard>>(CARDS)) ?? {};
  }

  /**
   * Read in the same step as the write: unlessPending keeps the record as it is if it has a wipe cardd hasn't heard
   * of; ifPending writes only while the record still has that pending wipe (a wipe that moved on meanwhile stays).
   */
  saveCard(c: CachedCard, o: { unlessPending?: boolean; ifPending?: CachedCard['pending'] } = {}): Promise<void> {
    return this.update<Record<string, CachedCard>>(CARDS, (all) => {
      const was = all?.[c.id]?.pending;
      if (o.unlessPending && was) return all;
      if (o.ifPending && was !== o.ifPending) return all;
      return { ...all, [c.id]: c };
    });
  }

  async pendingRequests(): Promise<MoneyRequest[]> {
    return Object.values((await this.get<Record<string, MoneyRequest>>(REQUESTS)) ?? {});
  }

  savePending(r: MoneyRequest): Promise<void> {
    return this.update<Record<string, MoneyRequest>>(REQUESTS, (all) => ({ ...all, [r.id]: r }));
  }

  backupRecipient(): Promise<string | null> {
    return this.get(BACKUP_RECIPIENT);
  }

  saveBackupRecipient(recipient: string): Promise<void> {
    return this.put(BACKUP_RECIPIENT, recipient);
  }

  async revoked(): Promise<boolean> {
    return (await this.get<boolean>(REVOKED)) ?? false;
  }

  setRevoked(revoked: boolean): Promise<void> {
    return this.put(REVOKED, revoked);
  }

  serverLatest(): Promise<ServerLatest | null> {
    return this.get(SERVER_LATEST);
  }

  saveServerLatest(latest: ServerLatest): Promise<void> {
    return this.put(SERVER_LATEST, latest);
  }

  carddUnreachableSince(): Promise<number | null> {
    return this.get(UNREACHABLE_SINCE);
  }

  /** The background job and the server page: whether cardd answered at nowMs. The first failure's time is kept. */
  noteCarddAnswered(answered: boolean, nowMs: number): Promise<void> {
    if (answered) return this.put(UNREACHABLE_SINCE, null);
    return this.update<number>(UNREACHABLE_SINCE, (since) => since ?? nowMs);
  }

  posRestoreChecked(): Promise<number | null> {
    return this.get(POS_RESTORE_CHECKED);
  }

  savePosRestoreChecked(restored: number): Promise<void> {
    return this.put(POS_RESTORE_CHECKED, restored);
  }

  /** Every card's cached photo, by card id. */
  async photos(): Promise<Record<string, CachedPhoto>> {
    const rows = await this.step((db) => db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv WHERE key LIKE ?', `${PHOTO}%`));
    const out: Record<string, CachedPhoto> = {};
    for (const r of rows) {
      // One damaged row is skipped: it must not hide the other cards' photos.
      try {
        const p = JSON.parse(r.value) as Partial<CachedPhoto> | null;
        if (typeof p?.tag === 'string' && typeof p.jpeg === 'string') out[r.key.slice(PHOTO.length)] = { tag: p.tag, jpeg: p.jpeg };
      } catch {
        // not JSON
      }
    }
    return out;
  }

  savePhoto(id: string, photo: CachedPhoto): Promise<void> {
    return this.put(PHOTO + id, photo);
  }

  async dropPhoto(id: string): Promise<void> {
    await this.step((db) => db.runAsync('DELETE FROM kv WHERE key = ?', PHOTO + id));
  }

  /** The removed cards the person has not yet been told of, oldest first. Anything that is not one is left out. */
  async removedPhoneCards(): Promise<RemovedPhoneCard[]> {
    return removedOf(await this.get<unknown>(REMOVED_PHONE_CARDS).catch(() => null));
  }

  async noteRemovedPhoneCard(removed: RemovedPhoneCard): Promise<void> {
    await this.update<unknown>(REMOVED_PHONE_CARDS, (rows) => [...removedOf(rows), { name: removed.name, amountMsat: removed.amountMsat }], { damagedAsNone: true });
  }

  /** The person has read the notice. */
  dismissRemovedPhoneCards(): Promise<void> {
    return this.put(REMOVED_PHONE_CARDS, []);
  }

  /** The unit every amount is shown in: sat on a new phone, and for anything kept that isn't a unit ('hidden' too). */
  async amountUnit(): Promise<Unit> {
    const v = await this.get<unknown>(AMOUNT_VIEW).catch(() => null);
    return isUnit(v) ? v : 'sat';
  }

  /**
   * The unit is written over the old one value, so a phone from before that kept 'hidden' keeps it in its own row
   * first. Only true is ever written here: an eye press landing between these steps can't be undone by a stale false.
   */
  async setAmountUnit(unit: Unit): Promise<void> {
    const kept = await this.get<unknown>(AMOUNT_VIEW).catch(() => null);
    if (kept === 'hidden' && typeof (await this.get<unknown>(AMOUNTS_HIDDEN).catch(() => null)) !== 'boolean') await this.put(AMOUNTS_HIDDEN, true);
    await this.put(AMOUNT_VIEW, unit);
  }

  /** Whether amounts are hidden: not on a new phone; on a phone from before, whether it kept 'hidden'. */
  async amountsHidden(): Promise<boolean> {
    const h = await this.get<unknown>(AMOUNTS_HIDDEN).catch(() => null);
    if (typeof h === 'boolean') return h;
    return (await this.get<unknown>(AMOUNT_VIEW).catch(() => null)) === 'hidden';
  }

  setAmountsHidden(on: boolean): Promise<void> {
    return this.put(AMOUNTS_HIDDEN, on);
  }

  /** The unit amounts are typed in: the currency on a new phone (a field with no rate types sat whatever this says). */
  async typingUnit(): Promise<'fiat' | 'sat'> {
    return (await this.get<unknown>(TYPING_UNIT).catch(() => null)) === 'sat' ? 'sat' : 'fiat';
  }

  setTypingUnit(unit: 'fiat' | 'sat'): Promise<void> {
    return this.put(TYPING_UNIT, unit);
  }

  async alertsOffered(): Promise<boolean> {
    return (await this.get<unknown>(ALERTS_OFFERED).catch(() => null)) === true;
  }

  setAlertsOffered(): Promise<void> {
    return this.put(ALERTS_OFFERED, true);
  }

  /** What was last handed cardd for alerts; null while they are off, and for anything kept that isn't one. */
  async alertsSent(): Promise<AlertsSent | null> {
    const v = await this.get<Partial<AlertsSent>>(ALERTS_SENT).catch(() => null);
    return typeof v?.endpoint === 'string' && typeof v.createdAt === 'number' && typeof v.vapid === 'string'
      ? { endpoint: v.endpoint, createdAt: v.createdAt, vapid: v.vapid }
      : null;
  }

  saveAlertsSent(sent: AlertsSent | null): Promise<void> {
    return this.put(ALERTS_SENT, sent);
  }

  dropPending(id: string): Promise<void> {
    return this.update<Record<string, MoneyRequest>>(REQUESTS, (all) => {
      const left = { ...all };
      delete left[id];
      return left;
    });
  }
}

async function read<T>(db: SqlDb, key: string): Promise<T | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : null;
}

async function write(db: SqlDb, key: string, value: unknown): Promise<void> {
  await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

/** The removed phones' cards kept: anything that is not one is left out. */
function removedOf(rows: unknown): RemovedPhoneCard[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is RemovedPhoneCard => typeof r?.name === 'string' && (r.amountMsat === null || typeof r.amountMsat === 'number'))
    .map((r) => ({ name: r.name, amountMsat: r.amountMsat }));
}
