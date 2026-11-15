// The app's own state on the phone.
// One small key-value table of
// JSON documents; the recovery phrase lives in secrets.ts, never here.
import type { ServerLatest } from '../backup/backups';
import type { CardState } from '../cardd/client';
import type { MoneyRequest } from '../money/requests';
import { isView, type View } from '../money/view';
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
/** The view every amount is drawn in: 'fiat', 'sat', 'msat' or 'hidden'. */
const AMOUNT_VIEW = 'view.amount';
/** Settings' Show msat amounts, off on a new phone. */
const SHOW_MSAT = 'view.show_msat';
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
  'setAmountView', 'setShowMsat', 'setTypingUnit', 'setAlertsOffered', 'saveAlertsSent',
] as const satisfies readonly (keyof AppStore)[];

export class AppStore {
  /** A reconnect on its way, handed to a second caller (two presses of Try again). */
  private reconnecting: Promise<boolean> | null = null;

  private constructor(private db: SqlDb) {}

  static async open(db: SqlDb): Promise<AppStore> {
    await AppStore.prepare(db);
    return new AppStore(db);
  }

  private static async prepare(db: SqlDb): Promise<void> {
    // busy_timeout: the background job writes on a connection of its own (backup/jobDb.ts), and a write that meets
    // the other connection's waits for it, up to 5 s, rather than failing at once with "database is locked".
    await db.execAsync(`PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
        await this.db.getFirstAsync('SELECT 1');
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
      const old = this.db as SqlDb & { closeAsync?(): Promise<void> };
      this.db = fresh;
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
  async clear(): Promise<void> {
    await this.db.execAsync(`PRAGMA secure_delete = ON;
      DELETE FROM kv;
      VACUUM;`);
    const left = (await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM kv'))?.n;
    if (left !== 0) throw new Error(`the app's database still holds ${left ?? 'some'} ${left === 1 ? 'row' : 'rows'}`);
    // busy: the checkpoint did not run to its end. Not an error to SQLite, so it is read here.
    const folded = await this.db.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
    if (!folded || folded.busy !== 0) throw new Error("the app's database is in use, and what it held is still in its file");
  }

  private async get<T>(key: string): Promise<T | null> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value));
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

  async saveCard(c: CachedCard): Promise<void> {
    const all = await this.cards();
    all[c.id] = c;
    await this.put(CARDS, all);
  }

  async pendingRequests(): Promise<MoneyRequest[]> {
    return Object.values((await this.get<Record<string, MoneyRequest>>(REQUESTS)) ?? {});
  }

  async savePending(r: MoneyRequest): Promise<void> {
    const all = (await this.get<Record<string, MoneyRequest>>(REQUESTS)) ?? {};
    all[r.id] = r;
    await this.put(REQUESTS, all);
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
  async noteCarddAnswered(answered: boolean, nowMs: number): Promise<void> {
    if (answered) return this.put(UNREACHABLE_SINCE, null);
    if ((await this.carddUnreachableSince()) === null) await this.put(UNREACHABLE_SINCE, nowMs);
  }

  posRestoreChecked(): Promise<number | null> {
    return this.get(POS_RESTORE_CHECKED);
  }

  savePosRestoreChecked(restored: number): Promise<void> {
    return this.put(POS_RESTORE_CHECKED, restored);
  }

  /** Every card's cached photo, by card id. */
  async photos(): Promise<Record<string, CachedPhoto>> {
    const rows = await this.db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv WHERE key LIKE ?', `${PHOTO}%`);
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
    await this.db.runAsync('DELETE FROM kv WHERE key = ?', PHOTO + id);
  }

  /** The removed cards the person has not yet been told of, oldest first. Anything that is not one is left out. */
  async removedPhoneCards(): Promise<RemovedPhoneCard[]> {
    const rows = (await this.get<unknown>(REMOVED_PHONE_CARDS).catch(() => null)) ?? [];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is RemovedPhoneCard => typeof r?.name === 'string' && (r.amountMsat === null || typeof r.amountMsat === 'number'))
      .map((r) => ({ name: r.name, amountMsat: r.amountMsat }));
  }

  async noteRemovedPhoneCard(removed: RemovedPhoneCard): Promise<void> {
    await this.put(REMOVED_PHONE_CARDS, [...(await this.removedPhoneCards()), { name: removed.name, amountMsat: removed.amountMsat }]);
  }

  /** The person has read the notice. */
  dismissRemovedPhoneCards(): Promise<void> {
    return this.put(REMOVED_PHONE_CARDS, []);
  }

  /** The view every amount is drawn in: sat on a new phone, and for anything kept that isn't a view. */
  async amountView(): Promise<View> {
    const v = await this.get<unknown>(AMOUNT_VIEW).catch(() => null);
    return isView(v) ? v : 'sat';
  }

  setAmountView(view: View): Promise<void> {
    return this.put(AMOUNT_VIEW, view);
  }

  /** Whether Show msat amounts is on: off on a new phone. */
  async showMsat(): Promise<boolean> {
    return (await this.get<unknown>(SHOW_MSAT).catch(() => null)) === true;
  }

  setShowMsat(on: boolean): Promise<void> {
    return this.put(SHOW_MSAT, on);
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

  async dropPending(id: string): Promise<void> {
    const all = (await this.get<Record<string, MoneyRequest>>(REQUESTS)) ?? {};
    delete all[id];
    await this.put(REQUESTS, all);
  }
}
