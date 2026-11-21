import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { AppStore, STORE_WRITES } from './store';
import { phraseStore } from './secrets';
import { initialState, type OnboardingState } from '../onboarding/machine';
import { expoLikeSqlite, nodeSqlite } from '../testing/nodeSqlite';
import { vectors } from '../testing/vectors';

describe('AppStore', () => {
  it('has no onboarding state until one is saved', async () => {
    const store = await AppStore.open(nodeSqlite());
    expect(await store.onboarding()).toBeNull();
  });

  // The whole point: the app can be killed at any moment and pick up where it was.
  it('keeps the onboarding state across a reopen of the database', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    const db = nodeSqlite(path);
    const store = await AppStore.open(db);
    const s = { ...initialState('GBR'), step: 'install' as const, vmId: 1001, installed: ['upload' as const] };
    await store.saveOnboarding(s);
    // A step's start and the steps' times survive a closed app.
    const timed = { ...s, installed: ['upload' as const, 'first-boot' as const], stepStartedAt: { step: 'swap' as const, at: 5 }, stepMs: { upload: 3000 } };
    await store.saveOnboarding(timed);
    db.close();
    const again = await AppStore.open(nodeSqlite(path));
    expect(await again.onboarding()).toEqual(timed);
  });

  it("reads an install saved by an older app: 'system' is the four steps that replaced it", async () => {
    const store = await AppStore.open(nodeSqlite());
    const s = { ...initialState('GBR'), step: 'install' as const, vmId: 1001 };
    const old = { ...s, installed: ['upload', 'system'], rebuild: { before: { step: 'done', installed: ['upload', 'system', 'prepare', 'gone'] } } };
    await store.saveOnboarding(old as unknown as OnboardingState);
    const back = await store.onboarding();
    expect(back!.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup']);
    expect(back!.rebuild!.before!.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare']);
  });

  // A connection expo-sqlite had destroyed stayed dead until the app was stopped; Try again opens a new one.
  describe('reconnect', () => {
    /** A connection that can be made to fail every call, as expo-sqlite's did once its native binding was gone. */
    const killable = (path: string) => {
      const db = nodeSqlite(path);
      const c = { dead: false, hang: false, closed: 0 };
      const live = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A) =>
        c.hang
          ? new Promise<R>(() => {})
          : c.dead
            ? Promise.reject(new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected."))
            : f(...a);
      return Object.assign(c, {
        execAsync: live(db.execAsync),
        runAsync: live(db.runAsync),
        getFirstAsync: live(db.getFirstAsync) as typeof db.getFirstAsync,
        getAllAsync: live(db.getAllAsync) as typeof db.getAllAsync,
        closeAsync: async () => {
          c.closed++;
          if (c.dead) throw new Error('java.lang.NullPointerException');
          db.close();
        },
      });
    };
    const file = () => join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');

    it('keeps a connection that still answers, and opens nothing', async () => {
      const first = killable(file());
      const store = await AppStore.open(first);
      let opened = 0;
      expect(await store.reconnect(async () => (opened++, killable(file())))).toBe(false);
      expect([opened, first.closed]).toEqual([0, 0]);
    });

    it('reads and writes through a new connection once the old one is dead, and lets the old one go', async () => {
      const path = file();
      const first = killable(path);
      const store = await AppStore.open(first);
      const s = { ...initialState('GBR'), step: 'done' as const, vmId: 1001 };
      await store.saveOnboarding(s);
      first.dead = true;
      await expect(store.onboarding()).rejects.toThrow('NativeDatabase.prepareAsync');
      const second = killable(path);
      expect(await store.reconnect(async () => second)).toBe(true);
      expect(first.closed).toBe(1); // tried, its failure swallowed
      expect(await store.onboarding()).toEqual(s);
      await store.saveOnboarding({ ...s, vmId: 1002 });
      expect(await AppStore.open(nodeSqlite(path)).then((a) => a.onboarding())).toMatchObject({ vmId: 1002 });
      expect(await second.getFirstAsync('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
    });

    // Two presses of Try again at once: the second must not open another and close the first's new connection under it.
    it('gives a second caller the reconnect already running', async () => {
      const path = file();
      const first = killable(path);
      const store = await AppStore.open(first);
      first.dead = true;
      const opened: ReturnType<typeof killable>[] = [];
      const open = async () => {
        const c = killable(path);
        opened.push(c);
        return c;
      };
      expect(await Promise.all([store.reconnect(open), store.reconnect(open)])).toEqual([true, true]);
      expect(opened).toHaveLength(1);
      expect(opened[0].closed).toBe(0);
      expect(await store.reconnect(open)).toBe(false); // done, and the new one answers
    });

    // The store's steps on a connection run one at a time (store.ts step): a failed one doesn't stop the next.
    it('goes on to the next step after one that failed', async () => {
      const first = killable(file());
      const store = await AppStore.open(first);
      first.dead = true;
      await expect(store.cards()).rejects.toThrow('NativeDatabase.prepareAsync');
      first.dead = false;
      expect(await store.cards()).toEqual({});
    });

    // A step that never ends holds up the steps after it on its connection, but not Try again nor the new connection.
    it("reads through the new connection while a step on the old one never ends", async () => {
      const path = file();
      const first = killable(path);
      const store = await AppStore.open(first);
      await store.saveCard({ id: 'c1', version: 1, name: 'Daily', state: 'active' });
      first.hang = true;
      void store.cards();
      await new Promise((r) => setTimeout(r, 0)); // the step has begun, and won't end
      first.hang = false;
      first.dead = true;
      expect(await store.reconnect(async () => killable(path))).toBe(true);
      expect(Object.keys(await store.cards())).toEqual(['c1']);
    });

    it('keeps the old connection, and throws, when the new one fails', async () => {
      const first = killable(file());
      const store = await AppStore.open(first);
      first.dead = true;
      await expect(store.reconnect(async () => Promise.reject(new Error('no file')))).rejects.toThrow('no file');
      expect(first.closed).toBe(0);
    });
  });

  // The background job writes on a connection of its own (backup/jobDb.ts): a write that meets the
  // other's waits for it rather than failing at once with "database is locked".
  it('waits up to 5 s for a write the other connection holds', async () => {
    const db = nodeSqlite();
    await AppStore.open(db);
    expect(await db.getFirstAsync('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
  });
});

// Each card's photo, the cache the faces draw from.
describe('AppStore photos', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  it('keeps each card\'s photo by its tag, lists them all and drops one', async () => {
    const store = await AppStore.open(nodeSqlite());
    expect(await store.photos()).toEqual({});
    await store.savePhoto(A, { tag: '0123456789abcdef', jpeg: 'AAAA' });
    await store.savePhoto(B, { tag: 'fedcba9876543210', jpeg: 'BBBB' });
    await store.savePhoto(A, { tag: '1111111111111111', jpeg: 'CCCC' });
    expect(await store.photos()).toEqual({ [A]: { tag: '1111111111111111', jpeg: 'CCCC' }, [B]: { tag: 'fedcba9876543210', jpeg: 'BBBB' } });
    await store.dropPhoto(B);
    await store.dropPhoto(B);
    expect(await store.photos()).toEqual({ [A]: { tag: '1111111111111111', jpeg: 'CCCC' } });
  });

  it('keeps the photos apart from the rest of the app\'s state', async () => {
    const store = await AppStore.open(nodeSqlite());
    await store.saveCard({ id: A, version: 0, name: 'Daily', state: 'active' });
    await store.savePhoto(A, { tag: '0123456789abcdef', jpeg: 'AAAA' });
    expect(Object.keys(await store.cards())).toEqual([A]);
    expect(Object.keys(await store.photos())).toEqual([A]);
  });

  // One damaged row must not take the other cards' photos with it.
  it('skips a cached photo that is not {tag, jpeg} strings, and lists the rest', async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await store.savePhoto(A, { tag: '0123456789abcdef', jpeg: 'AAAA' });
    for (const [id, value] of [['c', '{not json'], ['d', '{"tag":1,"jpeg":"x"}'], ['e', 'null'], ['f', '{"tag":"t"}']]) {
      await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?)', `photo.${id.repeat(32)}`, value);
    }
    expect(await store.photos()).toEqual({ [A]: { tag: '0123456789abcdef', jpeg: 'AAAA' } });
  });
});

// A wallet removed from the phone leaves nothing in the file.
describe('AppStore.clear', () => {
  const MARK = 'A card name no other test writes';
  /** Every byte the database has on disk: its file and, in WAL mode, the log beside it. */
  const onDisk = (path: string) => [path, `${path}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f).toString('latin1')).join('');

  it('forgets everything it held', async () => {
    const store = await AppStore.open(nodeSqlite());
    await store.saveOnboarding({ ...initialState('GBR'), step: 'done' });
    await store.saveCard({ id: 'ab'.repeat(16), version: 0, name: MARK, state: 'active' });
    await store.setRevoked(true);
    await store.clear();
    expect(await store.onboarding()).toBeNull();
    expect(await store.cards()).toEqual({});
    expect(await store.revoked()).toBe(false);
  });

  it('leaves none of it in the file: deleted rows are overwritten, not only unlisted', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    await store.saveOnboarding({ ...initialState('GBR'), step: 'done' });
    await store.saveCard({ id: 'ab'.repeat(16), version: 0, name: MARK, state: 'active' });
    expect(onDisk(path)).toContain(MARK);
    await store.clear();
    expect(onDisk(path)).not.toContain(MARK);
  });

  // A second connection (another process; the app's own job shares the app's): while it reads, the log can't be
  // folded into the file, and the pages the rows were on are still there.
  it('fails, and does not call the file clean, while another connection keeps the old pages in use', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    await store.saveCard({ id: 'ab'.repeat(16), version: 0, name: MARK, state: 'active' });
    const reader = new DatabaseSync(path);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM kv').get();
    await expect(store.clear()).rejects.toThrow(/still/);
    reader.exec('COMMIT');
    reader.close();
    await store.clear();
    expect(onDisk(path)).not.toContain(MARK);
  });

  it('fails if a row is written while it clears: nothing is called gone that is there', async () => {
    const db = nodeSqlite();
    const late = { ...db, execAsync: async (sql: string) => (await db.execAsync(sql), void (await db.runAsync("INSERT OR REPLACE INTO kv (key, value) VALUES ('late', '1')"))) };
    const store = await AppStore.open(late);
    await expect(store.clear()).rejects.toThrow('the app\'s database still holds 1 row');
  });

  it('can be written to again afterwards, by the same open connection', async () => {
    const store = await AppStore.open(nodeSqlite());
    await store.saveOnboarding(initialState('GBR'));
    await store.clear();
    await store.saveOnboarding(initialState('IRL'));
    expect(await store.onboarding()).toEqual(initialState('IRL'));
  });
});

// What work still on its way must not do once its wallet is off the phone (services/walletEpoch.ts) is every write.
describe('STORE_WRITES', () => {
  it('names every method of the store that writes: a new method is listed as a write here, or as a read in this test', () => {
    const READS = [
      'onboarding', 'cards', 'pendingRequests', 'backupRecipient', 'revoked', 'serverLatest', 'carddUnreachableSince', 'posRestoreChecked', 'photos', 'removedPhoneCards',
      'amountUnit', 'amountsHidden', 'typingUnit', 'alertsOffered', 'alertsSent',
    ];
    // clear is the removal's own, reconnect Try again's; get, put, update and step are the store's private four.
    const OWN = ['constructor', 'clear', 'reconnect', 'get', 'put', 'update', 'step'];
    const methods = Object.getOwnPropertyNames(AppStore.prototype).filter((m) => !OWN.includes(m));
    expect([...methods].sort()).toEqual([...READS, ...STORE_WRITES].sort());
  });
});

describe('phraseStore', () => {
  const secure = () => {
    const m = new Map<string, string>();
    return {
      m,
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
      getItemAsync: async (k: string) => m.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => void m.set(k, v),
      deleteItemAsync: async (k: string) => void m.delete(k),
    };
  };

  it('stores a valid phrase, normalised', async () => {
    const ss = secure();
    const p = phraseStore(ss);
    expect(await p.get()).toBeNull();
    await p.set(`  ${vectors.phrase.phrase.toUpperCase()} `);
    expect(await p.get()).toBe(vectors.phrase.phrase);
  });

  // A deep link to the phrase screen must never be able to swap the phrase that owns the server.
  it('refuses to replace a stored phrase', async () => {
    const p = phraseStore(secure());
    await p.set(vectors.phrase.phrase);
    await expect(p.set('legal winner thank year wave sausage worth useful legal winner thank yellow')).rejects.toThrow('already has a recovery phrase');
    expect(await p.get()).toBe(vectors.phrase.phrase);
  });

  it('refuses an invalid phrase', async () => {
    const p = phraseStore(secure());
    await expect(p.set('abandon abandon abandon')).rejects.toThrow('not a valid recovery phrase');
    expect(await p.get()).toBeNull();
  });
});

describe('the card cache', () => {
  // A wipe must work without the VM: the phone keeps each card's version.
  it('keeps each card by id across a reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    const db = nodeSqlite(path);
    const store = await AppStore.open(db);
    expect(await store.cards()).toEqual({});
    await store.saveCard({ id: 'a'.repeat(32), version: 0, name: 'Daily', state: 'programming' });
    await store.saveCard({ id: 'a'.repeat(32), version: 0, name: 'Daily', state: 'active' });
    await store.saveCard({ id: 'b'.repeat(32), version: 2, name: '', state: 'reset', pending: 'wiped' });
    db.close();
    const again = await AppStore.open(nodeSqlite(path));
    expect(await again.cards()).toEqual({
      ['a'.repeat(32)]: { id: 'a'.repeat(32), version: 0, name: 'Daily', state: 'active' },
      ['b'.repeat(32)]: { id: 'b'.repeat(32), version: 2, name: '', state: 'reset', pending: 'wiped' },
    });
  });
});

// The background backup job runs without the phrase: the app keeps the
// phrase's backup recipient (a public key), and whether another phone revoked this one.
describe('backup state', () => {
  it('keeps the backup recipient and the revoked flag across a reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    expect(await store.backupRecipient()).toBeNull();
    expect(await store.revoked()).toBe(false);
    await store.saveBackupRecipient(vectors.phrase.backupAgeRecipient);
    await store.setRevoked(true);
    const again = await AppStore.open(nodeSqlite(path));
    expect(await again.backupRecipient()).toBe(vectors.phrase.backupAgeRecipient);
    expect(await again.revoked()).toBe(true);
  });

  // The PoS phones page's note after a restore stays away once I've checked is pressed.
  it('keeps the restore the person checked the PoS phones after, across a reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    expect(await store.posRestoreChecked()).toBeNull();
    await store.savePosRestoreChecked(1_790_000_030);
    expect(await (await AppStore.open(nodeSqlite(path))).posRestoreChecked()).toBe(1_790_000_030);
  });

  // The Wallet page says once, until dismissed, which phones'
  // cards the wallet removed; the notice outlives the app's closing.
  it("keeps the removed phones' cards to tell the person of, in order, across a reopen, until dismissed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    expect(await store.removedPhoneCards()).toEqual([]);
    await store.noteRemovedPhoneCard({ name: 'Pixel 8 Pro', amountMsat: 6_000_000 });
    await store.noteRemovedPhoneCard({ name: 'Old phone', amountMsat: null });
    const again = await AppStore.open(nodeSqlite(path));
    expect(await again.removedPhoneCards()).toEqual([{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }, { name: 'Old phone', amountMsat: null }]);
    await again.dismissRemovedPhoneCards();
    expect(await (await AppStore.open(nodeSqlite(path))).removedPhoneCards()).toEqual([]);
  });

  // A damaged notice must not stop the next removed card being told of.
  it("notes a removed phone's card over a notice that isn't JSON", async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await store.noteRemovedPhoneCard({ name: 'Pixel 8 Pro', amountMsat: 6_000_000 });
    await db.runAsync('UPDATE kv SET value = ? WHERE value LIKE ?', '{not json', '%Pixel 8 Pro%');
    await store.noteRemovedPhoneCard({ name: 'Old phone', amountMsat: null });
    expect(await store.removedPhoneCards()).toEqual([{ name: 'Old phone', amountMsat: null }]);
  });

  // A rebuild warns when the server last reported a newer snapshot than the one chosen.
  it("keeps the server's latest snapshot as last reported, across a reopen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    expect(await store.serverLatest()).toBeNull();
    await store.saveServerLatest({ installId: 'ab'.repeat(16), version: 3, created: 1_790_000_000 });
    await store.saveServerLatest({ installId: 'ab'.repeat(16), version: 4, created: 1_790_003_600 });
    const again = await AppStore.open(nodeSqlite(path));
    expect(await again.serverLatest()).toEqual({ installId: 'ab'.repeat(16), version: 4, created: 1_790_003_600 });
  });

  // The server page suggests a rebuild once cardd has failed for over an hour.
  it('keeps when cardd first failed to answer, until it answers again', async () => {
    const store = await AppStore.open(nodeSqlite());
    expect(await store.carddUnreachableSince()).toBeNull();
    await store.noteCarddAnswered(false, 1000);
    await store.noteCarddAnswered(false, 5000);
    expect(await store.carddUnreachableSince()).toBe(1000);
    await store.noteCarddAnswered(true, 9000);
    expect(await store.carddUnreachableSince()).toBeNull();
    await store.noteCarddAnswered(false, 12000);
    expect(await store.carddUnreachableSince()).toBe(12000);
  });
});

// The phone keeps the unit amounts are shown in, whether they are hidden, and the unit typed in.
describe('the amounts view', () => {
  it('starts on sat, shown, typing in the currency, and keeps each across a reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    expect([await store.amountUnit(), await store.amountsHidden(), await store.typingUnit()]).toEqual(['sat', false, 'fiat']);
    await store.setAmountUnit('msat');
    await store.setAmountsHidden(true);
    await store.setTypingUnit('sat');
    const again = await AppStore.open(nodeSqlite(path));
    expect([await again.amountUnit(), await again.amountsHidden(), await again.typingUnit()]).toEqual(['msat', true, 'sat']);
  });

  it('reads anything kept that is not a unit as sat', async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await db.runAsync("INSERT INTO kv (key, value) VALUES ('view.amount', '\"pounds\"')");
    expect(await store.amountUnit()).toBe('sat');
  });

  // Before Settings held the view, one value kept it: 'fiat', 'sat', 'msat' or 'hidden'.
  it('opens a phone that kept msat on msat, shown', async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await db.runAsync("INSERT INTO kv (key, value) VALUES ('view.amount', '\"msat\"')");
    expect([await store.amountUnit(), await store.amountsHidden()]).toEqual(['msat', false]);
  });

  it('opens a phone that kept hidden hidden, on sat; showing them again is kept', async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await db.runAsync("INSERT INTO kv (key, value) VALUES ('view.amount', '\"hidden\"')");
    expect([await store.amountUnit(), await store.amountsHidden()]).toEqual(['sat', true]);
    await store.setAmountsHidden(false);
    expect(await store.amountsHidden()).toBe(false);
  });

  it("writes no hidden row when a unit is chosen on a phone that wasn't hidden, so an eye press then is never undone", async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await db.runAsync("INSERT INTO kv (key, value) VALUES ('view.amount', '\"sat\"')");
    await store.setAmountUnit('fiat');
    expect(await db.getFirstAsync("SELECT value FROM kv WHERE key = 'view.hidden'")).toBeNull();
    expect([await store.amountUnit(), await store.amountsHidden()]).toEqual(['fiat', false]);
  });

  it('keeps an old hidden phone hidden when a unit is chosen on it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const db = nodeSqlite(path);
    const store = await AppStore.open(db);
    await db.runAsync("INSERT INTO kv (key, value) VALUES ('view.amount', '\"hidden\"')");
    await store.setAmountUnit('fiat');
    const again = await AppStore.open(nodeSqlite(path));
    expect([await again.amountUnit(), await again.amountsHidden()]).toEqual(['fiat', true]);
  });
});

// Alerts with the app closed: the one offer, and what was last handed the server.
describe('alerts', () => {
  it('has made no offer and sent nothing on a new phone, and keeps both across a reopen', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'store-')), 'app.db');
    const store = await AppStore.open(nodeSqlite(path));
    expect([await store.alertsOffered(), await store.alertsSent()]).toEqual([false, null]);
    const sent = { endpoint: 'https://vm-1.lnvps.cloud:8443/upAbC?up=1', createdAt: 1_790_000_000, vapid: 'BEl6' };
    await store.setAlertsOffered();
    await store.saveAlertsSent(sent);
    const again = await AppStore.open(nodeSqlite(path));
    expect([await again.alertsOffered(), await again.alertsSent()]).toEqual([true, sent]);
    await again.saveAlertsSent(null);
    expect(await again.alertsSent()).toBeNull();
  });

  it('reads anything kept that is not a sent endpoint as none', async () => {
    const db = nodeSqlite();
    const store = await AppStore.open(db);
    await db.runAsync("INSERT INTO kv (key, value) VALUES ('alerts.sent', '{\"endpoint\":3}')");
    expect(await store.alertsSent()).toBeNull();
  });
});

// The background job writes on a connection of its own (backup/jobDb.ts). A read of the app's still open on its
// connection (expo-sqlite finalizes after it has stepped) makes SQLite refuse the app's next write at once once the
// job has written, whatever busy_timeout says (SQLITE_BUSY_SNAPSHOT): the store runs one statement at a time.
describe("AppStore beside the background job's connection", () => {
  it("saves while one of its own reads is under way, after the job's connection wrote", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    let job: DatabaseSync | null = null;
    const app = expoLikeSqlite(path, {
      afterStep: () => {
        job?.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('job', '1')");
        job = null;
      },
    });
    const store = await AppStore.open(app);
    await store.saveCard({ id: 'c1', version: 1, name: 'Daily', state: 'active' });
    await store.noteRemovedPhoneCard({ name: 'Old phone', amountMsat: null });
    job = new DatabaseSync(path);
    job.exec('PRAGMA busy_timeout = 5000');
    await Promise.all([store.cards(), store.dismissRemovedPhoneCards()]);
    expect(await store.removedPhoneCards()).toEqual([]);
  });

  // The job part-way through its write (its lock held, not yet committed): the app's write waits for it.
  it("waits for the job's connection part-way through a write while one of its own reads is under way", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    const store = await AppStore.open(expoLikeSqlite(path));
    await store.saveCard({ id: 'c1', version: 1, name: 'Daily', state: 'active' });
    await store.noteRemovedPhoneCard({ name: 'Old phone', amountMsat: null });
    // On a thread of its own, as the job's writes are to the app's (the app's wait blocks its own thread).
    const job = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.path);
       db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; INSERT OR REPLACE INTO kv (key, value) VALUES ('job', '1')");
       parentPort.postMessage('holding');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { path } },
    );
    try {
      await new Promise((ok, fail) => {
        job.once('message', ok);
        job.once('error', fail);
      });
      await Promise.all([store.cards(), store.dismissRemovedPhoneCards()]);
      expect(await store.removedPhoneCards()).toEqual([]);
    } finally {
      await job.terminate();
    }
  });

  // A save that changes nothing writes nothing: no commit for the job's connection to wait on, every failed status check.
  it('writes nothing when a save changes nothing', async () => {
    const db = nodeSqlite();
    let writes = 0;
    const counted = { ...db, runAsync: (sql: string, ...p: (string | number | null)[]) => (writes++, db.runAsync(sql, ...p)) };
    const store = await AppStore.open(counted);
    await store.noteCarddAnswered(false, 1);
    await store.saveCard({ id: 'c1', version: 1, name: 'Daily', state: 'wiping', pending: 'wipe' });
    const before = writes;
    await store.noteCarddAnswered(false, 2);
    await store.saveCard({ id: 'c1', version: 1, name: 'Daily', state: 'active' }, { unlessPending: true });
    expect(writes).toBe(before);
    expect(await store.carddUnreachableSince()).toBe(1);
    expect((await store.cards()).c1?.pending).toBe('wipe');
  });

  // ifStill (catchUp's saves): written only over the record that was read, the same version and pending wipe; not over
  // a newer one, and not back into a cache emptied meanwhile (the wallet removed).
  it('saves a card ifStill only over the record that was read', async () => {
    const store = await AppStore.open(nodeSqlite());
    const seen = { id: 'c1', version: 1, name: 'Daily', state: 'wiping' as const, pending: 'wipe' as const };
    const told = { id: 'c1', version: 1, name: 'Daily', state: 'wiping' as const };
    await store.saveCard(seen);
    await store.saveCard(told, { ifStill: seen });
    expect((await store.cards()).c1).toEqual(told);
    for (const now of [{ ...seen, pending: 'wiped' as const, state: 'reset' as const }, { ...seen, version: 2 }]) {
      await store.saveCard(now);
      await store.saveCard(told, { ifStill: seen });
      expect((await store.cards()).c1).toEqual(now);
    }
    await store.clear();
    await store.saveCard(told, { ifStill: seen });
    expect((await store.cards()).c1).toBeUndefined();
  });

  // The wait first (the switch to WAL then waits for the job's connection too), deleted data overwritten (photos,
  // notes, old card lists don't linger in free pages), and on an iPhone each commit flushed past the drive's cache.
  it('opens each connection waiting first, in WAL, overwriting what it deletes and flushing fully', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cardapp-')), 'app.db');
    const db = nodeSqlite(path);
    const sent: string[] = [];
    await AppStore.open({ ...db, execAsync: (sql: string) => (sent.push(sql), db.execAsync(sql)) });
    const first = sent.join('\n');
    expect(first.indexOf('busy_timeout')).toBeGreaterThanOrEqual(0);
    expect(first.indexOf('busy_timeout')).toBeLessThan(first.indexOf('journal_mode'));
    expect(await db.getFirstAsync('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(await db.getFirstAsync('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
    expect(await db.getFirstAsync('PRAGMA secure_delete')).toEqual({ secure_delete: 1 });
    expect(await db.getFirstAsync('PRAGMA fullfsync')).toEqual({ fullfsync: 1 });
  });

  // A read and the write after it are one step: two saves at once keep both.
  it('keeps both of two cards saved at once', async () => {
    const store = await AppStore.open(nodeSqlite());
    await Promise.all([
      store.saveCard({ id: 'c1', version: 1, name: 'Daily', state: 'active' }),
      store.saveCard({ id: 'c2', version: 1, name: 'Kids', state: 'active' }),
    ]);
    expect(Object.keys(await store.cards()).sort()).toEqual(['c1', 'c2']);
  });
});
