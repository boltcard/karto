import { describe, expect, it, vi } from 'vitest';
import { SshDropped } from '../onboarding/ssh';
import { CarddError, type CardInfo, type HostingStatus, type SaleDay, type Wallet } from '../cardd/client';
import type { ServerStatus } from '../cardd/status';
import type { CardDeps } from '../cards/deps';
import { dayStart, resumeNotice } from '../money/format';
import type { MoneyRequest } from '../money/requests';
import type { NfcState } from '../native/nfc';
import { INSTALL_STEPS, type InstallStep, type UploadProgress } from '../onboarding/install';
import type { OnboardingState, ServerHost } from '../onboarding/machine';
import type { BackupsView } from '../backup/panel';
import { phoneCardId } from '../phoneCard/id';
import type { CachedCard, CachedPhoto, RemovedPhoneCard } from '../store/store';
import { photoUri } from '../wallet/photos';
import { RATE_STALE_MS, ServerWatch, type LnvpsView, type WatchDeps, type WatchSnapshot } from './serverWatch';

const T0 = 1_790_000_000_000;
const HOST = 'vm-1001.lnvps.cloud';
const NEW_HOST = 'vm-1003.lnvps.cloud';
const PHRASE = 'phrase one';
const MINUTE = 60_000;

const server = (hostname: string, o: Partial<ServerHost> = {}): ServerHost => ({
  ipv4: '45.67.89.10', hostname, user: 'root', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3Nza' }, keySource: 'lnvps', ...o,
});
const saved = (o: Partial<OnboardingState> = {}): OnboardingState => ({ step: 'done', payDays: 30, installed: [], vmId: 1001, host: server(HOST), ...o });
const card = (id: string, created: number): CardInfo => ({ id, version: 1, state: 'active', counter: 3, name: id, created, updated: created, host: HOST });
const account = { balanceMsat: 0, heldMsat: 0, address: 'pool@vm-1001.lnvps.cloud' };
const WALLET: Wallet = { cards: [], pool: account, hosting: account, paused: false, pausedReason: '', liquidity: null, restore: null };
const HOSTING: HostingStatus = {
  synced: true, expires: T0 / 1000 + 40 * 86400, syncedAt: T0 / 1000, daysLeft: 40, msatPerDay: 221_387, fundingDays: 100, vatOk: true, willRenew: true,
  problem: '', problemAt: 0,
};
const OK: ServerStatus = { kind: 'ok', version: '0.7.0', updateAvailable: false };
/** LNVPS's answers: this server's VM gone from its list, no old one to watch. */
const LNVPS: LnvpsView = { vm: null, old: [], lnvpsNowMs: T0, unreachableSince: null };
/** The VM's expiry as LNVPS gives it (seconds). */
const EXPIRES = T0 / 1000 + 30 * 86400;
const KEPT = { lines: ['No backup on this phone yet'], warnings: [] };
const BACKUPS: BackupsView = { lines: ['1 kept on this phone'], warnings: [], unreachable: false, noApi: false, failure: null, revoked: false, lastFetch: null, checking: false };
const UPLOAD: UploadProgress = { path: 'cardd', sent: 4_000_000, total: 9_000_000 };
const offline = () => new Error(`fetch failed: no answer from ${HOST} in 30 s`);

/** Lets every answer a fake has already given arrive (the fakes never wait on a real timer). */
const settle = () => new Promise<void>((r) => setImmediate(r));
/** The phone as a card, on a phone that is none and with no phone's card listed. */
const NO_PHONE_CARD = { supported: false, record: null, ids: [], own: null, removed: [] };

function gate() {
  let open = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** The watch's clock: timers run only when advance() passes their time. */
function fakeClock() {
  let now = T0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimeout: (t: unknown) => void timers.delete(t as number),
    pending: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

/** One server's cardd: every call is recorded, waits while hold is set and throws fail while it is set. */
function fakeServer() {
  const s = {
    calls: [] as string[],
    status: OK,
    cards: [card('c1', 1), card('c2', 2)],
    wallet: WALLET,
    /** The paid sales by day as GET /pos/sales/days answers them, and what that read alone throws. */
    days: [] as SaleDay[],
    daysFail: null as unknown,
    /** Each card's photo as GET /cards/{id}/photo answers it. */
    photos: {} as Record<string, { jpeg: string; photo: string }>,
    /** While set, a photo's answer waits for it (after the call is recorded). */
    photoHold: null as Promise<void> | null,
    fail: null as unknown,
    booksFail: null as unknown,
    hold: null as Promise<void> | null,
    /** The held reads of the wallet asked for (call 'held'), and what each waits for before it answers: the books changing, or the wait's end. */
    heldAsks: [] as { since: string; wait: number }[],
    heldHold: null as Promise<void> | null,
    /** What a held read fails with, while set (hold and fail are every call's). */
    heldFail: null as unknown,
    /** While set, hosting's answer waits for it. */
    hostingHold: null as Promise<void> | null,
    count: (call: string) => s.calls.filter((c) => c === call).length,
    answer: async <T>(call: string, value: () => T): Promise<T> => {
      s.calls.push(call);
      await s.hold;
      if (s.fail) throw s.fail;
      return value();
    },
  };
  const books = (call: string) => () =>
    s.answer(call, () => {
      if (s.booksFail) throw s.booksFail;
      return { bookedMsat: 0 };
    });
  const cardd = {
    cards: () => s.answer('cards', () => s.cards),
    wallet: async (held?: { since: string; wait: number }) => {
      if (!held) return s.answer('wallet', () => s.wallet);
      s.heldAsks.push(held);
      s.calls.push('held');
      await s.heldHold;
      if (s.heldFail) throw s.heldFail;
      return s.wallet;
    },
    hosting: () => s.answer('hosting', () => HOSTING).then(async (h) => (await s.hostingHold, h)),
    reconcileBooks: books('reconcileBooks'), restoreBooks: books('restoreBooks'),
    salesDays: (offsetMin: number, limit?: number) =>
      s.answer(`salesDays ${offsetMin} ${limit}`, () => {
        if (s.daysFail) throw s.daysFail;
        return s.days;
      }),
    cardPhoto: (id: string) =>
      s.answer(`photo ${id}`, () => {
        const p = s.photos[id];
        if (!p) throw new CarddError(404, 'not_found', 'store: not found');
        return p;
      }).then(async (p) => (await s.photoHold, p)),
  };
  return Object.assign(s, { cardd: cardd as unknown as CardDeps['cardd'] });
}

/** The phone's cache of cards and its saved moves and sends. */
function fakeCache() {
  const c = {
    rows: {} as Record<string, CachedCard>,
    photoRows: {} as Record<string, CachedPhoto>,
    photoReads: 0,
    pending: [] as MoneyRequest[],
    asked: 0,
    cards: async () => ({ ...c.rows }),
    saveCard: async (row: CachedCard, o: { unlessPending?: boolean } = {}) => void (o.unlessPending && c.rows[row.id]?.pending ? null : (c.rows[row.id] = row)),
    pendingRequests: async () => (c.asked++, [...c.pending]),
    savePending: async (r: MoneyRequest) => void c.pending.push(r),
    dropPending: async (id: string) => void (c.pending = c.pending.filter((r) => r.id !== id)),
    photos: async () => (c.photoReads++, { ...c.photoRows }),
    savePhoto: async (id: string, p: CachedPhoto) => void (c.photoRows[id] = p),
    dropPhoto: async (id: string) => void delete c.photoRows[id],
    removed: [] as RemovedPhoneCard[],
    removedPhoneCards: async () => [...c.removed],
    noteRemovedPhoneCard: async (r: RemovedPhoneCard) => void c.removed.push(r),
    dismissRemovedPhoneCards: async () => void (c.removed = []),
  };
  return c;
}

function world(state: OnboardingState = saved()) {
  const clock = fakeClock();
  const servers = new Map<string, ReturnType<typeof fakeServer>>();
  const at = (host: string) => servers.get(host) ?? servers.set(host, fakeServer()).get(host)!;
  const w = {
    clock,
    at,
    cache: fakeCache(),
    saved: { phrase: PHRASE as string | null, state: state as OnboardingState | null },
    /** A read of the saved state that fails (a database connection gone, a phone not unlocked). */
    readFault: null as Error | null,
    made: [] as string[][],
    noted: [] as [boolean, number][],
    keyChecks: [] as number[],
    /** What LNVPS's key check makes of the state. */
    keyAnswer: (s: OnboardingState): OnboardingState => s,
    savedStates: [] as OnboardingState[],
    /** The order of the slower checks: 'noted' (a status answer noted), 'lnvps', 'retire <id>'. */
    log: [] as string[],
    lnvps: LNVPS as LnvpsView | null,
    lnvpsHold: null as Promise<void> | null,
    lnvpsAsked: [] as [OnboardingState, string][],
    expires: EXPIRES as number | null,
    syncs: 0,
    syncHold: null as Promise<void> | null,
    backupLoads: 0,
    backupHold: null as Promise<void> | null,
    backups: BACKUPS,
    /** Update server's run over SSH: by default it ticks off the upload and ends. */
    update: async (onStep: (step: InstallStep) => void, onUpload: (p: UploadProgress) => void, onStart?: (step: InstallStep) => void): Promise<void> => {
      onUpload(UPLOAD);
      onStep('upload');
    },
    /** The CARDAPP-INSTALL lines the update wrote. */
    installLog: [] as string[],
    updates: 0,
    /** The steps each run of the update was told are done. */
    updateDone: [] as InstallStep[][],
    awake: [] as boolean[],
    retireHold: null as Promise<void> | null,
    retire: (s: OnboardingState, vmId: number): OnboardingState => ({ ...s, retiredVms: [vmId] }),
    /**
     * The phone as a card: whether this phone can be one, its record, and the keeping-in-step job, which here
     * only says it ran (with the list it was given) and answers what the test set.
     */
    phone: {
      supported: false,
      record: null as { n: number; removing: boolean } | null,
      kept: [] as string[][],
      keep: async (_cards: CardInfo[]): Promise<{ changed: boolean } | null> => ({ changed: false }),
    },
  };
  const deps: WatchDeps = {
    phoneCard: {
      supported: async () => w.phone.supported,
      record: async () => w.phone.record,
      keep: (_deps, cards) => {
        w.phone.kept.push(cards.map((c) => c.id));
        return w.phone.keep(cards);
      },
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    loadSaved: async () => {
      if (w.readFault) throw w.readFault;
      return { ...w.saved };
    },
    makeDeps: (s, phrase) => {
      w.made.push([s.host!.hostname, phrase]);
      const cardd = at(s.host!.hostname).cardd;
      return { issuer: new Uint8Array(16), cardd, held: cardd, cache: w.cache, host: s.host!.hostname };
    },
    // As serverStatus() does: a failure is its 'unreachable' answer.
    serverStatus: (d) =>
      at(d.host)
        .answer('status', () => at(d.host).status)
        .catch((e: Error): ServerStatus => ({ kind: 'unreachable', message: e.message })),
    noteCarddAnswered: async (answered, nowMs) => {
      w.noted.push([answered, nowMs]);
      w.log.push('noted');
    },
    nfcState: async (): Promise<NfcState> => 'on',
    hostKeyCheck: async (s) => {
      w.keyChecks.push(clock.now());
      return w.keyAnswer(s);
    },
    saveState: async (s) => {
      w.savedStates.push(s);
      w.saved.state = s;
    },
    lnvpsAnswers: async (s, phrase) => {
      w.log.push('lnvps');
      w.lnvpsAsked.push([s, phrase]);
      await w.lnvpsHold;
      return w.lnvps;
    },
    syncHosting: async () => {
      w.syncs++;
      await w.syncHold;
      return w.expires;
    },
    backups: async (_s, _phrase, _deps, show) => {
      w.backupLoads++;
      show({ ...KEPT, checking: true });
      await w.backupHold;
      show(w.backups);
    },
    runUpdate: (_s, _phrase, done, onStep, onUpload, onStart) => {
      w.updates++;
      w.updateDone.push([...done]);
      return w.update(onStep, onUpload, onStart);
    },
    log: (line) => void w.installLog.push(line),
    keepAwake: (on) => void w.awake.push(on),
    retireOld: async (s, _phrase, vmId) => {
      w.log.push(`retire ${vmId}`);
      await w.retireHold;
      return w.retire(s, vmId);
    },
  };
  return { w, deps, watch: new ServerWatch(deps) };
}

describe('ServerWatch', () => {
  it('does nothing until onboarding is done', async () => {
    const { w, watch } = world(saved({ step: 'email' }));
    const release = watch.watch();
    await w.clock.advance(10 * MINUTE);
    expect([w.made, w.at(HOST).calls, w.keyChecks, w.clock.pending()]).toEqual([[], [], [], 0]);
    expect(watch.snapshot()).toMatchObject({ state: null, deps: null, status: null, cards: null });
    release();
    w.saved.state = saved();
    watch.watch();
    await settle();
    expect(w.made).toEqual([[HOST, PHRASE]]);
  });

  it("on a watch, asks for the server's status, its cards, the wallet and hosting, and the NFC state", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    expect(watch.snapshot()).toEqual({
      state: saved(), deps: expect.objectContaining({ host: HOST }), status: OK, unreachable: false,
      cards: srv.cards, cardsDown: false, cardsError: null, wallet: WALLET, hosting: HOSTING, nfc: 'on', notices: [], gaveUp: [], keyCheckedAt: T0,
      lnvps: LNVPS, lnvpsExpires: EXPIRES, backups: BACKUPS, update: null, retire: { running: false }, photos: {}, salesToday: null, hadShop: false,
      phoneCard: NO_PHONE_CARD, cantRead: false,
    });
    expect(w.noted).toEqual([[true, T0]]); // as the server page noted each status answer
    expect(w.keyChecks).toEqual([]); // the key is LNVPS's: nothing to check
  });

  // A wake that couldn't read the saved state said nothing, and the wallet went on showing old balances.
  it("says when it can't read the saved state, refreshes nothing meanwhile, and clears it once a read works", async () => {
    const { w, watch } = world();
    watch.watch()();
    await settle();
    expect(watch.snapshot().cantRead).toBe(false);
    w.readFault = new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.");
    const release = watch.watch();
    await settle();
    expect(watch.snapshot().cantRead).toBe(true);
    const asked = w.at(HOST).calls.length;
    await w.clock.advance(10 * MINUTE);
    expect(w.at(HOST).calls.length).toBe(asked);
    await expect(watch.readAgain()).rejects.toThrow('NativeDatabase.prepareAsync');
    expect(watch.snapshot().cantRead).toBe(true);
    w.readFault = null;
    await watch.readAgain(); // the wallet's Try again, once the store has its connection back
    expect(watch.snapshot().cantRead).toBe(false);
    expect(w.at(HOST).calls.length).toBeGreaterThan(asked);
    release();
  });

  it('keeps what it holds for the same server, and drops it when the host or the phrase changes', async () => {
    const { w, watch } = world();
    watch.watch()();
    await settle();
    const held = watch.snapshot();
    const wait = gate();
    w.at(HOST).hold = wait.promise;
    watch.watch()();
    await settle();
    expect(w.made).toHaveLength(1);
    expect(watch.snapshot()).toMatchObject({ deps: held.deps, status: OK, cards: held.cards, wallet: WALLET, hosting: HOSTING });
    w.at(HOST).hold = null;
    wait.open();
    await settle();

    // A rebuild finished: the saved state names a new server.
    const rebuilt = gate();
    w.at(NEW_HOST).hold = rebuilt.promise;
    w.at(NEW_HOST).cards = [card('n1', 5)];
    w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
    watch.watch();
    await settle();
    expect(w.made).toEqual([[HOST, PHRASE], [NEW_HOST, PHRASE]]);
    expect(watch.snapshot()).toMatchObject({ state: w.saved.state, deps: { host: NEW_HOST }, status: null, cards: null, wallet: null, hosting: null });
    rebuilt.open();
    await settle();
    expect(watch.snapshot()).toMatchObject({ status: OK, cards: [card('n1', 5)], wallet: WALLET });

    w.saved.phrase = 'phrase two';
    watch.watch();
    await settle();
    expect(w.made.at(-1)).toEqual([NEW_HOST, 'phrase two']);
  });

  // The retired server's late answers must not show over the new one's.
  it('drops the answers of a server it has moved on from', async () => {
    const { w, watch } = world();
    const old = w.at(HOST);
    const late = gate();
    old.hold = late.promise;
    watch.watch()();
    await settle();
    w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
    w.at(NEW_HOST).cards = [card('n1', 5)];
    watch.watch();
    await settle();
    const fresh = watch.snapshot();
    old.fail = offline();
    late.open();
    await settle();
    expect(watch.snapshot()).toBe(fresh);
    expect(fresh).toMatchObject({ status: OK, unreachable: false, cards: [card('n1', 5)], cardsDown: false });
    expect(w.noted).toEqual([[true, T0]]); // only the new server's answer
  });

  // A wallet taken off the phone, or a rebuild finished, while work for the old server is on its way: what that
  // work read before must not be saved over what the phone holds now (a removed wallet's state would come back).
  it('saves nothing from a key check still on its way when it forgets', async () => {
    const { w, watch } = world(saved({ host: server(HOST, { keySource: 'first_use' }) }));
    const asked = gate();
    w.keyAnswer = ((s: OnboardingState) => asked.promise.then(() => ({ ...s, host: { ...s.host!, keySource: 'lnvps' } }))) as unknown as typeof w.keyAnswer;
    watch.watch();
    await settle();
    expect(w.keyChecks).toEqual([T0]);
    watch.forget();
    w.saved.state = null;
    asked.open();
    await settle();
    expect([w.savedStates, w.saved.state, watch.snapshot().state]).toEqual([[], null, null]);
  });

  it('remembers no card list that arrives after it forgets', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    srv.cards = [card('n1', 5)];
    watch.watch()();
    await settle();
    expect(Object.keys(w.cache.rows)).toEqual(['n1']);
    // The list is asked for again, and the wallet goes while cardd is still answering.
    w.cache.rows = {};
    const answering = gate();
    srv.hold = answering.promise;
    const asked = watch.reloadCards();
    await settle();
    watch.forget();
    answering.open();
    await asked;
    expect(w.cache.rows).toEqual({});
  });

  it('saves nothing from a Retire VM still on its way when it forgets', async () => {
    const { w, watch } = world();
    watch.watch()();
    await settle();
    const retiring = gate();
    w.retireHold = retiring.promise;
    const run = watch.retireOld(1013);
    await settle();
    watch.forget();
    w.saved.state = null;
    retiring.open();
    await run;
    expect([w.savedStates, w.saved.state, watch.snapshot().state]).toEqual([[], null, null]);
  });

  // After a rebuild or onboarding the wallet mustn't draw the old server while the saved state is read.
  it('forgets what it held when a rebuild or onboarding finishes, and the next watch makes new clients, even for the same host', async () => {
    const { w, watch } = world();
    watch.watch()();
    await settle();
    await watch.update();
    await watch.retireOld(1013);
    const old = watch.snapshot();
    expect(old).toMatchObject({ update: { outcome: { ok: true } }, retire: { outcome: { ok: true } } });
    watch.forget();
    expect(watch.snapshot()).toEqual({
      state: null, deps: null, status: null, unreachable: false, cards: null, cardsDown: false, cardsError: null, wallet: null, hosting: null,
      nfc: 'on', notices: [], gaveUp: [], keyCheckedAt: T0, lnvps: null, lnvpsExpires: null, backups: null, update: null, retire: { running: false },
      photos: {}, // the phone's, kept: the next answered list brings them up to date
      salesToday: null, hadShop: false, phoneCard: NO_PHONE_CARD, cantRead: false,
    });

    // The saved server is the same host (a cancelled rebuild ends at done too).
    watch.watch();
    await settle();
    expect(w.made).toEqual([[HOST, PHRASE], [HOST, PHRASE]]);
    expect(watch.snapshot().deps).not.toBe(old.deps);
    expect(watch.snapshot()).toMatchObject({ state: w.saved.state, status: OK, cards: old.cards, wallet: WALLET, lnvps: LNVPS, backups: BACKUPS });
  });

  it('drops the answers, and a read of the saved state, still on their way from before it forgot', async () => {
    const { w, watch } = world();
    const late = gate();
    w.at(HOST).hold = late.promise;
    watch.watch()();
    await settle();
    watch.forget();
    const forgotten = watch.snapshot();
    late.open();
    await settle();
    expect(watch.snapshot()).toBe(forgotten);
    expect([w.noted, w.lnvpsAsked]).toEqual([[], []]);

    // The saved state was read for the old server, then the rebuild's new one was saved and the watch told.
    watch.watch();
    w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
    watch.forget();
    await settle();
    expect(w.made).toEqual([[HOST, PHRASE], [NEW_HOST, PHRASE]]);
    expect(watch.snapshot()).toMatchObject({ state: w.saved.state, deps: { host: NEW_HOST }, status: OK });
  });

  // The wallet's Shop tile says today's sales.
  describe("today's sales", () => {
    const OFFSET = -new Date(T0).getTimezoneOffset();
    const TODAY = dayStart(T0 / 1000, OFFSET);
    const shop = (sales: number): Wallet => ({ ...WALLET, shop: { balanceMsat: 12_400_000, heldMsat: 0, address: '', phones: 1, sales } });
    const reads = (srv: { calls: string[] }) => srv.calls.filter((c) => c.startsWith('salesDays')).length;

    it("reads them with the wallet: the newest day, in the phone's offset", async () => {
      const { w, watch } = world();
      const srv = w.at(HOST);
      srv.wallet = shop(9);
      srv.days = [{ day: TODAY, count: 5, totalMsat: 12_400_000 }];
      watch.watch();
      await settle();
      expect(watch.snapshot()).toMatchObject({ wallet: srv.wallet, salesToday: 5 });
      expect(srv.calls).toContain(`salesDays ${OFFSET} 1`);
    });

    it('reads them again only when a sale was paid or the day turned', async () => {
      const { w, watch } = world();
      const srv = w.at(HOST);
      srv.wallet = shop(9);
      srv.days = [{ day: TODAY, count: 5, totalMsat: 12_400_000 }];
      watch.watch();
      await settle();
      await w.clock.advance(15_000);
      expect([srv.count('wallet'), reads(srv)]).toEqual([4, 1]);
      srv.wallet = shop(10);
      srv.days = [{ day: TODAY, count: 6, totalMsat: 14_400_000 }];
      await w.clock.advance(5_000);
      expect([watch.snapshot().salesToday, reads(srv)]).toEqual([6, 2]);
      // Past midnight the newest day is yesterday's: none today.
      await w.clock.advance(86_400_000);
      expect([watch.snapshot().salesToday, reads(srv)]).toEqual([0, 3]);
    });

    it('asks nothing of a server with no shop, or with nothing of one', async () => {
      const { w, watch } = world();
      const srv = w.at(HOST);
      watch.watch();
      await settle();
      srv.wallet = { ...WALLET, shop: { balanceMsat: 0, heldMsat: 0, address: '', phones: 0, sales: 0 } };
      await w.clock.advance(5_000);
      expect([watch.snapshot().salesToday, reads(srv)]).toEqual([null, 0]);
    });

    it("has none while the count can't be read, and reads it at the next refresh", async () => {
      const { w, watch } = world();
      const srv = w.at(HOST);
      srv.wallet = shop(9);
      srv.days = [{ day: TODAY, count: 5, totalMsat: 12_400_000 }];
      srv.daysFail = new CarddError(404, 'bad_response', 'GET /api/v1/pos/sales/days → HTTP 404: 404 page not found');
      watch.watch();
      await settle();
      expect(watch.snapshot()).toMatchObject({ wallet: srv.wallet, salesToday: null, unreachable: false });
      srv.daysFail = null;
      await w.clock.advance(5_000);
      expect(watch.snapshot().salesToday).toBe(5);
    });

    // The wallet's Shop tile stays, as Pool's does, while the wallet can't be read.
    it("remembers that the server had a shop while its wallet can't be read, and forgets with the server", async () => {
      const { w, watch } = world();
      const srv = w.at(HOST);
      watch.watch();
      await settle();
      expect(watch.snapshot().hadShop).toBe(false);
      srv.wallet = shop(9);
      srv.days = [{ day: TODAY, count: 5, totalMsat: 12_400_000 }];
      await w.clock.advance(5_000);
      expect(watch.snapshot()).toMatchObject({ wallet: srv.wallet, hadShop: true });
      srv.fail = offline();
      await w.clock.advance(5_000);
      expect(watch.snapshot()).toMatchObject({ wallet: null, hadShop: true });
      // A wallet that answers with nothing of a shop is believed.
      srv.fail = null;
      srv.wallet = WALLET;
      await w.clock.advance(5_000);
      expect(watch.snapshot()).toMatchObject({ wallet: WALLET, hadShop: false });
      srv.wallet = shop(9);
      await w.clock.advance(5_000);
      w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
      const rebuilt = gate();
      w.at(NEW_HOST).hold = rebuilt.promise;
      watch.watch();
      await settle();
      expect(watch.snapshot()).toMatchObject({ wallet: null, hadShop: false });
      rebuilt.open();
      await settle();
    });

    it('forgets them with the server', async () => {
      const { w, watch } = world();
      w.at(HOST).wallet = shop(9);
      w.at(HOST).days = [{ day: TODAY, count: 5, totalMsat: 12_400_000 }];
      watch.watch();
      await settle();
      w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
      const rebuilt = gate();
      w.at(NEW_HOST).hold = rebuilt.promise;
      watch.watch();
      await settle();
      expect(watch.snapshot()).toMatchObject({ wallet: null, salesToday: null });
      rebuilt.open();
      await settle();
    });
  });

  it('refreshes the wallet and hosting every 5 seconds while watched and in the foreground, and only then', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    const wallets = () => srv.count('wallet');
    const one = watch.watch();
    await settle();
    expect(wallets()).toBe(1);
    await w.clock.advance(5_000);
    expect([wallets(), srv.count('hosting')]).toEqual([2, 2]);
    const two = watch.watch(); // Settings over the wallet: loads at once, but one refresh still
    await settle();
    expect(wallets()).toBe(3);
    await w.clock.advance(5_000);
    expect(wallets()).toBe(4);
    one();
    await w.clock.advance(5_000);
    expect(wallets()).toBe(5);
    two();
    await w.clock.advance(MINUTE);
    expect([wallets(), w.clock.pending()]).toEqual([5, 0]); // the last release stops it

    const three = watch.watch();
    await settle();
    await w.clock.advance(5_000);
    expect(wallets()).toBe(7);
    watch.background();
    await w.clock.advance(MINUTE);
    expect(wallets()).toBe(7);
    watch.foreground(); // at once, then every 5 s again
    await settle();
    expect(wallets()).toBe(8);
    await w.clock.advance(5_000);
    expect(wallets()).toBe(9);
    expect(srv.count('status')).toBe(4); // each watch and the return to the foreground
    expect(srv.count('cards')).toBe(3); // each watch: not the return to the foreground (the card list is asked for on focus)

    three();
    watch.background();
    watch.foreground(); // nothing watching: nothing to ask
    await w.clock.advance(MINUTE);
    expect([wallets(), srv.count('status')]).toEqual([9, 4]);
  });

  it('runs one refresh at a time, the next 5 seconds after the last ends, and a load asked for meanwhile after it', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    const slow = gate();
    srv.hold = slow.promise;
    await w.clock.advance(MINUTE);
    expect(srv.count('wallet')).toBe(2);
    void watch.reloadCards(); // the tap sheet closed
    await settle();
    expect(srv.count('wallet')).toBe(2);
    srv.hold = null;
    slow.open();
    await settle();
    expect(srv.count('wallet')).toBe(3);
    await w.clock.advance(4_999);
    expect(srv.count('wallet')).toBe(3);
    await w.clock.advance(1);
    expect(srv.count('wallet')).toBe(4);
  });

  it.each([
    ['a network failure', offline(), true],
    ['a gateway error', new CarddError(502, 'http', 'HTTP 502'), true],
    ["a gateway's page that isn't JSON", new CarddError(503, 'bad_response', 'GET /api/v1/wallet → HTTP 503: <html>'), true],
    ["cardd's own refusal", new CarddError(409, 'paused', 'payments are paused'), false],
    ["cardd's own 401", new CarddError(401, 'unauthorized', 'unknown or revoked device'), false],
    ["cardd's own JSON 5xx", new CarddError(500, 'internal', 'database is locked'), false],
  ])('a refresh failing with %s: unreachable %s, until the next that succeeds', async (_, error, unreachable) => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    srv.fail = error;
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ unreachable, wallet: null, hosting: null });
    srv.fail = null;
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: WALLET });
  });

  it('is unreachable when the status check says so, and reachable again when cardd answers', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    srv.status = { kind: 'unreachable', message: offline().message };
    await watch.checkAgain();
    expect(watch.snapshot()).toMatchObject({ status: srv.status, unreachable: true });
    srv.status = { kind: 'not_paired', message: "The server does not accept this phone's key: unknown or revoked device" };
    await watch.checkAgain();
    expect(watch.snapshot()).toMatchObject({ status: srv.status, unreachable: false });
    expect(w.noted.map(([answered]) => answered)).toEqual([true, false, true]);
  });

  it("takes the account page's refresh results for the flag", () => {
    const { watch } = world();
    watch.reportRefresh({ ok: false, error: offline() });
    expect(watch.snapshot().unreachable).toBe(true);
    watch.reportRefresh({ ok: true });
    expect(watch.snapshot().unreachable).toBe(false);
    watch.reportRefresh({ ok: false, error: new CarddError(502, 'http', 'HTTP 502') });
    expect(watch.snapshot().unreachable).toBe(true);
    watch.reportRefresh({ ok: false, error: new CarddError(409, 'frozen', 'the card is frozen') }); // cardd answered
    expect(watch.snapshot().unreachable).toBe(false);
    watch.reportRefresh({ ok: false, error: new TypeError("Cannot read properties of undefined (reading 'id')") }); // says nothing
    expect(watch.snapshot().unreachable).toBe(false);
  });

  // cardd restarts during Update server; the check when it ends counts.
  it("isn't made unreachable by failures while the server updates, and the status check after it counts", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    const restart = gate();
    w.update = () => restart.promise;
    const run = watch.update();
    await settle();
    srv.fail = offline();
    await w.clock.advance(5_000);
    await watch.checkAgain();
    watch.reportRefresh({ ok: false, error: offline() });
    expect(watch.snapshot()).toMatchObject({ status: OK, unreachable: false, wallet: null });
    restart.open();
    await run;
    expect(watch.snapshot()).toMatchObject({
      unreachable: true,
      update: { running: false, outcome: { ok: false, text: `The update ran, but the server can't be checked: ${offline().message}` } },
    });
  });

  // A backups check made while cardd restarted met Caddy's 502; the one after the update replaces it.
  it('checks the backups again once an update ends', async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    const before = w.backupLoads;
    await watch.update();
    await settle();
    expect(w.backupLoads).toBe(before + 1);
  });

  // Settings › Server stays calm while cardd restarts: no red "Can't reach the server" and no Check again.
  it('keeps the last status while the server updates when a check reaches nothing, and the check after it records what it finds', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    const restart = gate();
    w.update = () => restart.promise;
    const run = watch.update();
    await settle();
    srv.fail = offline();
    await watch.checkAgain();
    const mid = watch.snapshot();
    expect(mid).toMatchObject({ status: OK, unreachable: false });
    // What Settings draws its red line and Check again from.
    expect(mid.status?.kind === 'unreachable' || mid.unreachable).toBe(false);
    expect(w.noted).toEqual([[true, T0]]); // the failure isn't noted either
    srv.fail = null;
    srv.status = { kind: 'ok', version: '0.8.0', updateAvailable: false };
    restart.open();
    await run;
    expect(watch.snapshot()).toMatchObject({ status: srv.status, unreachable: false, update: { outcome: { ok: true, text: 'Updated to cardd 0.8.0.' } } });
    expect(w.noted).toEqual([[true, T0], [true, T0]]);
  });

  it('keeps the last status until a new check answers', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    const slow = gate();
    srv.hold = slow.promise;
    srv.status = { kind: 'unreachable', message: offline().message };
    const again = watch.checkAgain();
    await settle();
    expect(watch.snapshot()).toMatchObject({ status: OK, unreachable: false });
    slow.open();
    await again;
    expect(watch.snapshot()).toMatchObject({ status: srv.status, unreachable: true });
    expect(w.noted).toEqual([[true, T0], [false, T0]]);
  });

  it("lists the cards, or the phone's cache while the server can't be reached", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    w.cache.rows = { c1: { id: 'c1', version: 1, name: 'Coffee', state: 'active' } };
    srv.fail = offline();
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({
      cards: [w.cache.rows.c1], cardsDown: true, cardsError: "Can't reach your server, so this is what the phone remembers. Adding a card needs the server.",
    });
    srv.fail = null;
    await watch.reloadCards();
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null });
    expect(w.cache.rows.c2).toEqual({ id: 'c2', version: 1, name: 'c2', state: 'active' }); // remembered for next time
    srv.fail = new CarddError(500, 'internal', 'database is locked');
    await watch.reloadCards();
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: true, cardsError: "Your server couldn't list the cards: database is locked" });
  });

  // The phone's copy is a convenience (the list while the server can't be reached): failing to keep it doesn't hide the
  // list the server sent. The next list keeps it again. It leaves a line in the log for the next report from a phone.
  it("shows the server's list when the phone can't keep its copy, and keeps it at the next list", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    const kept = w.cache.saveCard;
    w.cache.saveCard = async () => {
      throw new Error('database is locked');
    };
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      watch.watch();
      await settle();
      expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null });
      expect(logged).toHaveBeenCalledWith('CARDAPP-CARDS', JSON.stringify({ kept: 'database is locked' }));
    } finally {
      logged.mockRestore();
    }
    w.cache.saveCard = kept;
    await watch.reloadCards();
    expect(w.cache.rows.c2).toEqual({ id: 'c2', version: 1, name: 'c2', state: 'active' });
  });

  // The list is shown as soon as the server sends it; saving the phone's copy (a write per card, each flushed to disk:
  // 85-190 ms on the 9a) comes after, not between the answer and the page.
  it("shows the server's list before the phone's copy is saved", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    const kept = w.cache.saveCard;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    w.cache.saveCard = async (...a) => {
      await held;
      return kept(...a);
    };
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null });
    expect(w.cache.rows.c2).toBeUndefined();
    expect(w.cache.photoReads).toBe(2); // the wake's, then the photo sync's: it doesn't wait for the copy either
    release();
    await settle();
    expect(w.cache.rows.c2).toEqual({ id: 'c2', version: 1, name: 'c2', state: 'active' });
  });

  // Back in front after a list that failed: asked for again, not left until the person leaves the page and returns.
  it('asks for the cards again on the return to the front when the last list failed', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    srv.fail = new CarddError(500, 'internal', 'database is locked');
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({ cardsDown: true, cardsError: "Your server couldn't list the cards: database is locked" });
    srv.fail = null;
    watch.background();
    watch.foreground();
    await settle();
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null });
  });

  it("asks for the cards again by itself once the server is back in reach", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    w.cache.rows = { c1: { id: 'c1', version: 1, name: 'Coffee', state: 'active' } };
    srv.fail = offline();
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({ cards: [w.cache.rows.c1], cardsDown: true });
    // Still out of reach at the next refresh: the list is not asked for while nothing answers.
    const asked = srv.count('cards');
    await w.clock.advance(5_000);
    expect(srv.count('cards')).toBe(asked);
    expect(watch.snapshot()).toMatchObject({ cardsDown: true, unreachable: true });
    // The network is back: the refresh that reaches the server asks for the list too, with nobody leaving the screen.
    srv.fail = null;
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null, unreachable: false });
    // Once it has the list, the refresh leaves it alone.
    const after = srv.count('cards');
    await w.clock.advance(15_000);
    expect(srv.count('cards')).toBe(after);
  });

  it("asks for the cards again once the server is back from a restart (the proxy's 502 in between is not the server refusing)", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    // cardd restarting: Caddy answers for it with a page of its own.
    srv.fail = new CarddError(502, 'bad_response', 'GET /cards → HTTP 502: <html>');
    await watch.reloadCards();
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ cardsDown: true, unreachable: true });
    srv.fail = null;
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null, unreachable: false });
  });

  it('does not ask every five seconds for a list the server itself refused', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    srv.fail = new CarddError(500, 'internal', 'database is locked');
    await watch.reloadCards();
    expect(watch.snapshot()).toMatchObject({ cardsDown: true, cardsError: "Your server couldn't list the cards: database is locked" });
    srv.fail = null;
    const asked = srv.count('cards');
    await w.clock.advance(15_000);
    expect(srv.count('cards')).toBe(asked);
    expect(watch.snapshot()).toMatchObject({ cardsDown: true });
  });

  it('asks the saved moves and sends again once in its life, after the first card list that loads', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    const send: MoneyRequest = { kind: 'send', id: 'r1', to: 'alice@example.com', amountMsat: 5_000_000, started: T0 - MINUTE };
    w.cache.pending = [send];
    srv.fail = offline();
    watch.watch()();
    await settle();
    expect(w.cache.asked).toBe(0);
    srv.fail = null;
    await watch.reloadCards();
    await settle();
    const notices = resumeNotice([{ req: send, outcome: { at: 'dropped' } }]);
    expect([w.cache.asked, w.cache.pending, watch.snapshot().notices]).toEqual([1, [], notices]);
    await watch.reloadCards();
    watch.watch()();
    w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
    watch.watch();
    await settle();
    expect([w.cache.asked, watch.snapshot().notices]).toEqual([1, notices]); // notices outlive a new server
  });

  it("checks a key trusted on first use on the first watch, then every 5 minutes in the foreground, whatever is in front", async () => {
    const { w, watch } = world(saved({ host: server(HOST, { keySource: 'first_use', trustedAt: T0 }) }));
    watch.watch()();
    await settle();
    expect([w.keyChecks, watch.snapshot().keyCheckedAt]).toEqual([[T0], T0]);
    await w.clock.advance(5 * MINUTE);
    expect([w.keyChecks, watch.snapshot().keyCheckedAt]).toEqual([[T0, T0 + 5 * MINUTE], T0 + 5 * MINUTE]);
    watch.background();
    await w.clock.advance(30 * MINUTE);
    expect(w.keyChecks).toHaveLength(2);
    watch.foreground(); // the 5 minutes count in the foreground only
    await w.clock.advance(5 * MINUTE - 1);
    expect(w.keyChecks).toHaveLength(2);
    await w.clock.advance(1);
    expect(w.keyChecks).toHaveLength(3);

    w.keyAnswer = () => {
      throw offline(); // LNVPS didn't answer: asked again in 5 minutes
    };
    await w.clock.advance(5 * MINUTE);
    expect([w.keyChecks.length, w.savedStates, watch.snapshot().keyCheckedAt]).toEqual([4, [], T0 + 45 * MINUTE]);

    // LNVPS publishes the same key: confirmed, saved, and no more checks.
    w.keyAnswer = (s) => ({ ...s, host: { ...s.host!, keySource: 'lnvps' } });
    await w.clock.advance(5 * MINUTE);
    expect(w.savedStates).toEqual([saved({ host: server(HOST, { trustedAt: T0 }) })]);
    expect(watch.snapshot().state).toEqual(w.savedStates[0]);
    await w.clock.advance(60 * MINUTE);
    expect([w.keyChecks.length, w.clock.pending()]).toEqual([5, 0]);
  });

  it('a key LNVPS contradicts is saved as a mismatch, and checked no more', async () => {
    const { w, watch } = world(saved({ host: server(HOST, { keySource: 'first_use' }) }));
    w.keyAnswer = (s) => ({ ...s, hostKeyMismatch: 'LNVPS published SHA256:abc, but the server this app trusted presented a different key' });
    watch.watch();
    await settle();
    expect(watch.snapshot().state?.hostKeyMismatch).toMatch(/^LNVPS published/);
    expect(w.saved.state).toBe(watch.snapshot().state);
    await w.clock.advance(60 * MINUTE);
    expect(w.keyChecks).toEqual([T0]);
  });

  it('checks the status, or loads the card list, again at once when asked', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    await watch.checkAgain(); // nothing yet to check
    expect(srv.calls).toEqual([]);
    watch.watch();
    await settle();
    await watch.checkAgain();
    expect([srv.count('status'), srv.count('cards'), srv.count('wallet')]).toEqual([2, 1, 1]);
    await watch.reloadCards();
    expect([srv.count('status'), srv.count('cards'), srv.count('wallet')]).toEqual([2, 2, 2]);
  });

  it('gives its subscribers a new snapshot on every change, and none when nothing changed', async () => {
    const { w, watch } = world();
    const first = watch.snapshot();
    const seen: WatchSnapshot[] = [];
    const stop = watch.subscribe((s) => seen.push(s));
    watch.watch();
    await settle();
    expect(seen.length).toBeGreaterThan(1);
    seen.forEach((s, i) => expect(s).not.toBe(i === 0 ? first : seen[i - 1]));
    expect(first).toMatchObject({ state: null, status: null, cards: null }); // never changed in place
    expect(watch.snapshot()).toBe(seen.at(-1));
    const n = seen.length;
    watch.reportRefresh({ ok: true });
    expect(seen).toHaveLength(n);
    stop();
    w.at(HOST).status = { kind: 'unreachable', message: offline().message };
    await watch.checkAgain();
    expect(seen).toHaveLength(n);
    expect(watch.snapshot().unreachable).toBe(true);
  });
});

describe("ServerWatch's slower checks and actions", () => {
  it("asks LNVPS about the VMs after the status answer is noted, on each watch and back in the foreground", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    const slow = gate();
    srv.hold = slow.promise;
    watch.watch();
    await settle();
    expect(w.log).toEqual([]); // the suggestion reads the record of cardd failing: current first
    srv.hold = null;
    slow.open();
    await settle();
    expect([w.log, w.lnvpsAsked, watch.snapshot().lnvps]).toEqual([['noted', 'lnvps'], [[saved(), PHRASE]], LNVPS]);
    watch.background();
    watch.foreground();
    await settle();
    expect(w.log).toEqual(['noted', 'lnvps', 'noted', 'lnvps']);

    // LNVPS couldn't be asked: the last answers stay.
    w.lnvps = null;
    await watch.checkAgain();
    expect([w.log.at(-1), watch.snapshot().lnvps]).toEqual(['lnvps', LNVPS]);
  });

  it('asks LNVPS one check at a time, and once more for one asked meanwhile', async () => {
    const { w, watch } = world();
    const slow = gate();
    w.lnvpsHold = slow.promise;
    watch.watch();
    await settle();
    void watch.checkAgain();
    void watch.checkAgain();
    await settle();
    expect(w.lnvpsAsked).toHaveLength(1);
    w.lnvpsHold = null;
    slow.open();
    await settle();
    expect(w.lnvpsAsked).toHaveLength(2);
  });

  it("syncs hosting with LNVPS on each watch, one at a time, holding LNVPS's expiry", async () => {
    const { w, watch } = world();
    const slow = gate();
    w.syncHold = slow.promise;
    watch.watch();
    watch.watch();
    await settle();
    expect([w.syncs, watch.snapshot().lnvpsExpires]).toEqual([1, null]);
    w.syncHold = null;
    slow.open();
    await settle();
    expect(watch.snapshot().lnvpsExpires).toBe(EXPIRES);
    w.expires = EXPIRES + 30 * 86400; // renewed
    watch.background();
    watch.foreground();
    await settle();
    expect([w.syncs, watch.snapshot().lnvpsExpires]).toEqual([2, EXPIRES + 30 * 86400]);
  });

  it("loads the backups on each watch, one load at a time, showing what the phone keeps first and replacing the view", async () => {
    const { w, watch } = world();
    const slow = gate();
    w.backupHold = slow.promise;
    watch.watch();
    await settle();
    const kept = { lines: KEPT.lines, warnings: [], revoked: false, failure: null, unreachable: false, noApi: false, lastFetch: null, checking: true };
    expect(watch.snapshot().backups).toEqual(kept);
    watch.watch();
    watch.background();
    watch.foreground();
    await settle();
    expect(w.backupLoads).toBe(1); // two must not fetch and write the same snapshot together
    w.backupHold = null;
    slow.open();
    await settle();
    expect(watch.snapshot().backups).toEqual(BACKUPS);
    w.backups = { ...BACKUPS, warnings: ["The latest backup on this phone can't be opened with your recovery phrase."] };
    watch.watch();
    await settle();
    expect([w.backupLoads, watch.snapshot().backups]).toEqual([2, w.backups]);
  });

  // Seen on a brand-new server (2026-10-11): its first check met the server a moment before its first backup, and
  // "can't make backups" stood on the wallet for six minutes, until the next visit to a page checked again.
  it('checks the backups again each minute while they carry a warning, and no more once it clears', async () => {
    const { w, watch } = world();
    w.backups = { ...BACKUPS, warnings: ["Your server can't make backups: no backup key yet."] };
    watch.watch();
    await settle();
    expect([w.backupLoads, watch.snapshot().backups!.warnings]).toEqual([1, w.backups.warnings]);
    await w.clock.advance(MINUTE);
    expect(w.backupLoads).toBe(2); // still warned: asked again
    w.backups = BACKUPS;
    await w.clock.advance(MINUTE);
    expect([w.backupLoads, watch.snapshot().backups]).toEqual([3, BACKUPS]);
    await w.clock.advance(10 * MINUTE);
    expect(w.backupLoads).toBe(3); // nothing to clear: no more checks by the clock
  });

  it("checks again for a check that failed too, but not in the background, and not for a phone another phone's restore unpaired", async () => {
    const { w, watch } = world();
    w.backups = { ...BACKUPS, failure: "Couldn't check backups: timed out." };
    watch.watch();
    await settle();
    await w.clock.advance(MINUTE);
    expect(w.backupLoads).toBe(2);
    watch.background();
    await w.clock.advance(5 * MINUTE);
    expect(w.backupLoads).toBe(2); // in the background nothing is asked
    w.backups = { ...BACKUPS, revoked: true, warnings: ['x'] };
    watch.foreground();
    await settle();
    expect(w.backupLoads).toBe(3);
    await w.clock.advance(5 * MINUTE);
    expect(w.backupLoads).toBe(3); // unpaired for good: asking again changes nothing
  });

  // Hops between Settings and its pages re-run the check; the last answer
  // stays until the next one comes, so the Backups row doesn't go back to Checking… and a warning doesn't blink off.
  it('keeps the last backups view while a later check runs, until its own answer', async () => {
    const { w, watch } = world();
    w.backups = { ...BACKUPS, warnings: ['No phone checked for backups for over a day. Android may be holding the app back: open it now and then.'] };
    watch.watch();
    await settle();
    expect(watch.snapshot().backups).toEqual(w.backups);
    const slow = gate();
    w.backupHold = slow.promise;
    w.backups = BACKUPS;
    watch.watch();
    await settle();
    expect(watch.snapshot().backups!.warnings).toHaveLength(1); // still the last answer, not the phone's files alone
    expect(watch.snapshot().backups!.checking).toBe(false);
    slow.open();
    await settle();
    expect(watch.snapshot().backups).toEqual(BACKUPS);
  });

  it("drops LNVPS's answers, the expiry, the backups and the outcomes for a new server, keeping a running update", async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    await watch.update();
    await watch.retireOld(1013);
    expect(watch.snapshot()).toMatchObject({ lnvps: LNVPS, lnvpsExpires: EXPIRES, backups: BACKUPS, update: { outcome: { ok: true } }, retire: { outcome: { ok: true } } });

    const held = gate();
    w.at(NEW_HOST).hold = w.syncHold = w.backupHold = held.promise;
    w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({ lnvps: null, lnvpsExpires: null, backups: { lines: KEPT.lines }, update: null });
    expect(watch.snapshot().retire).toEqual({ running: false });

    const running = gate();
    w.update = () => running.promise;
    w.at(NEW_HOST).hold = null;
    held.open();
    await settle();
    const run = watch.update();
    await settle();
    w.saved.state = saved({ vmId: 1007, host: server('vm-1007.lnvps.cloud') });
    watch.watch();
    await settle();
    expect(watch.snapshot().update).toEqual({ done: [], upload: null, startedAt: T0, running: true });
    running.open();
    await run;
  });

  it('keeps a running update when it forgets, and the update ends with its outcome from the server read again', async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    const running = gate();
    w.update = async (onStep) => {
      onStep('upload');
      await running.promise;
    };
    const run = watch.update();
    await settle();
    watch.forget();
    expect(watch.snapshot()).toMatchObject({ deps: null, update: { done: ['upload'], running: true } });
    void watch.update(); // still one at a time
    watch.watch();
    await settle();
    expect([w.updates, w.awake, watch.snapshot().update]).toEqual([1, [true], { done: ['upload'], upload: null, startedAt: T0, running: true }]);
    running.open();
    await run;
    expect(watch.snapshot().update).toMatchObject({ running: false, outcome: { ok: true, text: 'Updated to cardd 0.7.0.' } });
    expect(w.awake).toEqual([true, false]);
  });

  it('Update server: its steps and upload as they come, keep-awake for its life, then the status, the outcome and the card list', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    srv.status = { ...OK, updateAvailable: true };
    watch.watch();
    await settle();
    const installed = gate();
    w.update = async (onStep, onUpload) => {
      onUpload(UPLOAD);
      await settle();
      onStep('upload');
      await installed.promise;
      onStep('first-boot');
    };
    const run = watch.update();
    await settle();
    expect([w.awake, watch.snapshot().update]).toEqual([[true], { done: ['upload'], upload: UPLOAD, startedAt: T0, running: true }]);
    await w.clock.advance(MINUTE + 5_000);

    srv.status = { kind: 'ok', version: '0.8.0', updateAvailable: false };
    srv.cards = [card('c1', 1)];
    srv.calls = [];
    const seen: WatchSnapshot[] = [];
    watch.subscribe((s) => seen.push(s));
    installed.open();
    await run;
    const outcome = { ok: true, text: 'Updated to cardd 0.8.0.' };
    expect(watch.snapshot().update).toEqual({
      done: ['upload', 'first-boot'], upload: UPLOAD, startedAt: T0, endedAt: T0 + MINUTE + 5_000, running: false, outcome,
    });
    expect(w.awake).toEqual([true, false]);
    expect(srv.calls[0]).toBe('status');
    expect(srv.calls.slice(1).sort()).toEqual(['cards', 'hosting', 'wallet']);
    // The outcome shows before the card list from the new cardd.
    const first = seen.find((s) => s.update?.outcome);
    expect(first?.cards).toHaveLength(2);
    expect(watch.snapshot().cards).toEqual([card('c1', 1)]);
  });

  it("a stopped update says why and lets the phone sleep again; the next one can run", async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    w.update = async (onStep) => {
      onStep('upload');
      await w.clock.advance(20_000);
      throw new Error('ssh: connection reset by peer');
    };
    await watch.update();
    expect(watch.snapshot().update).toEqual({
      done: ['upload'], upload: null, startedAt: T0, endedAt: T0 + 20_000, running: false, error: 'The update stopped: ssh: connection reset by peer',
    });
    expect(w.awake).toEqual([true, false]);
    w.update = async () => {};
    await watch.update();
    expect([w.updates, w.awake, watch.snapshot().update?.error]).toEqual([2, [true, false, true, false], undefined]);
  });

  it('a stopped update checks the status again, so Settings does not keep the one from before it', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    expect(watch.snapshot().status).toEqual(OK);
    w.update = async () => {
      srv.status = { kind: 'unreachable', message: offline().message };
      throw new Error('ssh: connection reset by peer');
    };
    await watch.update();
    expect(watch.snapshot()).toMatchObject({ status: srv.status, unreachable: true, update: { running: false, error: expect.stringContaining('The update stopped') } });
  });

  // Each load after it catches its own failures today; one that throws mustn't say the update stopped.
  it("keeps a finished update's outcome when a load after it throws", async () => {
    const { w, deps, watch } = world();
    watch.watch();
    await settle();
    deps.lnvpsAnswers = () => {
      throw new Error('lnvps: bad answer');
    };
    await watch.update();
    expect(watch.snapshot().update).toEqual({
      done: ['upload'], upload: UPLOAD, startedAt: T0, endedAt: T0, running: false, outcome: { ok: true, text: 'Updated to cardd 0.7.0.' },
    });
    expect([w.awake, w.at(HOST).count('cards')]).toEqual([[true, false], 2]);
  });

  it('Update server goes on when every watcher leaves and the app goes to the background; one at a time', async () => {
    const { w, watch } = world();
    const release = watch.watch();
    await settle();
    const installed = gate();
    w.update = async (onStep) => {
      await installed.promise;
      onStep('meta');
    };
    const run = watch.update();
    void watch.update();
    await watch.retireOld(1013); // over SSH too: not beside the update
    expect([w.updates, w.awake, w.log.filter((l) => l.startsWith('retire'))]).toEqual([1, [true], []]);
    release();
    watch.background();
    await w.clock.advance(10 * MINUTE);
    expect([watch.snapshot().update?.running, w.awake]).toEqual([true, [true]]);
    installed.open();
    await run;
    expect(watch.snapshot().update).toMatchObject({ done: ['meta'], running: false, outcome: { ok: true, text: 'Updated to cardd 0.7.0.' } });
    expect(w.awake).toEqual([true, false]);
  });

  it('does nothing for Update server or Retire before it holds a server', async () => {
    const { w, watch } = world(saved({ step: 'email' }));
    await watch.update();
    await watch.retireOld(1013);
    expect([w.updates, w.awake, w.log, watch.snapshot().update]).toEqual([0, [], [], null]);
  });

  it('Retire VM: retires from the saved state, saves what it returns, says so, then asks LNVPS again', async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    w.log = [];
    const retiring = gate();
    w.retireHold = retiring.promise;
    const run = watch.retireOld(1013);
    void watch.retireOld(1013);
    await settle();
    expect(watch.snapshot().retire).toEqual({ running: true });
    retiring.open();
    await run;
    const next = saved({ retiredVms: [1013] });
    expect([w.savedStates, watch.snapshot().state]).toEqual([[next], next]);
    expect(watch.snapshot().retire).toEqual({ running: false, outcome: { ok: true, text: "The old server (VM 1013) is retired: it can't start again." } });
    expect([w.log, w.lnvpsAsked.at(-1)]).toEqual([['retire 1013', 'lnvps'], [next, PHRASE]]);
  });

  // Retire VM does not carry on by itself; it says the connection dropped.
  it('Retire VM cut by a dropped connection says so in words of its own, and offers its button again', async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    w.retire = () => {
      throw new SshDropped('command', 'NIOSSHError error 1');
    };
    await watch.retireOld(1013);
    expect([w.savedStates, watch.snapshot().retire]).toEqual([
      [], { running: false, outcome: { ok: false, text: "Couldn't retire the old server: the connection to it dropped. Try again." } },
    ]);
    w.retire = (s, vmId) => ({ ...s, retiredVms: [vmId] });
    await watch.retireOld(1013);
    expect(watch.snapshot().retire).toMatchObject({ running: false, outcome: { ok: true } });
  });

  it("Retire VM failing says why, and the next try starts afresh", async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    w.retire = () => {
      throw new Error('ssh: host key mismatch');
    };
    await watch.retireOld(1013);
    expect([w.savedStates, watch.snapshot().retire]).toEqual([[], { running: false, outcome: { ok: false, text: "Couldn't retire the old server: ssh: host key mismatch" } }]);
    const retiring = gate();
    w.retireHold = retiring.promise;
    const run = watch.retireOld(1013);
    await settle();
    expect(watch.snapshot().retire).toEqual({ running: true });
    retiring.open();
    await run;
  });

  it("Set the books asks cardd, then loads the card list and the wallet; a refusal says why", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    srv.calls = [];
    await watch.setBooks();
    expect([srv.calls[0], srv.calls.slice(1).sort()]).toEqual(['reconcileBooks', ['cards', 'hosting', 'wallet']]);
    srv.calls = [];
    await watch.restoreBooks();
    expect([srv.calls[0], srv.calls.slice(1).sort()]).toEqual(['restoreBooks', ['cards', 'hosting', 'wallet']]);
    srv.calls = [];
    srv.booksFail = new CarddError(409, 'restore_pending', "a restore's own setting of the books is pending");
    await watch.setBooks();
    expect([srv.calls, watch.snapshot().cardsError]).toEqual([['reconcileBooks'], "Couldn't set the books: a restore's own setting of the books is pending"]);
    await watch.reloadCards();
    expect(watch.snapshot().cardsError).toBeNull();
  });
});

// The photos the faces draw, from the phone's
// cache, brought up to date by each card list cardd answers.
describe("ServerWatch's card photos", () => {
  const withPhoto = (id: string, created: number, photo: string): CardInfo => ({ ...card(id, created), photo });

  it('shows the cached photos from its first wake, before any list answers', async () => {
    const { w, watch } = world();
    w.cache.photoRows = { c1: { tag: '1111111111111111', jpeg: 'C1' } };
    const wait = gate();
    w.at(HOST).hold = wait.promise;
    watch.watch()();
    await settle();
    expect(watch.snapshot().photos).toEqual({ c1: photoUri('C1') });
    expect(w.cache.photoReads).toBe(1);
    wait.open();
    await settle();
    watch.watch()();
    await settle();
    expect(watch.snapshot().photos).toEqual({ c1: photoUri('C1') }); // the list says nothing of photos (an older cardd)
  });

  it('fetches a changed photo after a list cardd answered, and drops a removed one', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    w.cache.photoRows = { c2: { tag: '2222222222222222', jpeg: 'C2' } };
    srv.cards = [withPhoto('c1', 1, '1111111111111111'), withPhoto('c2', 2, '')];
    srv.photos.c1 = { jpeg: 'C1', photo: '1111111111111111' };
    watch.watch();
    await settle();
    expect(watch.snapshot().photos).toEqual({ c1: photoUri('C1') });
    expect(w.cache.photoRows).toEqual({ c1: { tag: '1111111111111111', jpeg: 'C1' } });
    expect(srv.count('photo c1')).toBe(1);
    await watch.reloadCards();
    expect(srv.count('photo c1')).toBe(1); // the same tag: not fetched again
  });

  // The cache the provider shows while cardd can't be reached has no tags: syncing to it would drop every photo.
  it("doesn't sync to the phone's cache of cards, and the photos still show", async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    w.cache.photoRows = { c1: { tag: '1111111111111111', jpeg: 'C1' } };
    // c9's photo is cached, but its card is not in the phone's cache of cards (which has no tags): syncing to that list would drop it.
    w.cache.photoRows.c9 = { tag: '9999999999999999', jpeg: 'C9' };
    w.cache.rows = { c1: { id: 'c1', version: 1, name: 'Coffee', state: 'active' } };
    srv.fail = offline();
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({ cardsDown: true, photos: { c1: photoUri('C1'), c9: photoUri('C9') } });
    expect(w.cache.photoRows).toEqual({ c1: { tag: '1111111111111111', jpeg: 'C1' }, c9: { tag: '9999999999999999', jpeg: 'C9' } });
    expect(srv.calls.filter((c) => c.startsWith('photo '))).toEqual([]);
  });

  it('keeps the photos across a changed server, and the next list it answers brings them up to date', async () => {
    const { w, watch } = world();
    w.cache.photoRows = { c1: { tag: '1111111111111111', jpeg: 'C1' }, c2: { tag: '2222222222222222', jpeg: 'C2' } };
    w.at(HOST).cards = [withPhoto('c1', 1, '1111111111111111'), withPhoto('c2', 2, '2222222222222222')];
    watch.watch()();
    await settle();
    const rebuilt = gate();
    w.at(NEW_HOST).hold = rebuilt.promise;
    w.at(NEW_HOST).cards = [withPhoto('c1', 1, '1111111111111111')];
    w.saved.state = saved({ vmId: 1003, host: server(NEW_HOST) });
    watch.watch();
    await settle();
    expect(watch.snapshot()).toMatchObject({ deps: { host: NEW_HOST }, cards: null, photos: { c1: photoUri('C1'), c2: photoUri('C2') } });
    rebuilt.open();
    await settle();
    expect(watch.snapshot().photos).toEqual({ c1: photoUri('C1') });
  });

  it('takes a photo the person just saved or removed at once, into the cache and the snapshot', async () => {
    const { w, watch } = world();
    watch.watch();
    await settle();
    await watch.photoSaved('c1', { tag: '1111111111111111', jpeg: 'C1' });
    expect(watch.snapshot().photos).toEqual({ c1: photoUri('C1') });
    expect(w.cache.photoRows.c1).toEqual({ tag: '1111111111111111', jpeg: 'C1' });
    await watch.photoRemoved('c1');
    expect(watch.snapshot().photos).toEqual({});
    expect(w.cache.photoRows).toEqual({});
  });

  it('syncs one list at a time, and the newest list once more after it', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    srv.cards = [withPhoto('c1', 1, '1111111111111111')];
    srv.photos.c1 = { jpeg: 'C1', photo: '1111111111111111' };
    watch.watch();
    await settle();
    expect(srv.count('photo c1')).toBe(1);
    // The first list's fetch is on its way (held) when a second list arrives.
    const wait = gate();
    srv.photoHold = wait.promise;
    srv.cards = [withPhoto('c1', 1, '1111111111111112')];
    srv.photos.c1 = { jpeg: 'C1b', photo: '1111111111111112' };
    const first = watch.reloadCards();
    await settle();
    expect(srv.count('photo c1')).toBe(2);
    srv.cards = [withPhoto('c1', 1, '1111111111111113')];
    srv.photos.c1 = { jpeg: 'C1c', photo: '1111111111111113' };
    const second = watch.reloadCards();
    await settle();
    // The second sync waits for the first to return.
    expect(srv.count('photo c1')).toBe(2);
    srv.photoHold = null;
    wait.open();
    await Promise.all([first, second]);
    await settle();
    expect(srv.count('photo c1')).toBe(3);
    expect(watch.snapshot().photos).toEqual({ c1: photoUri('C1c') });
    expect(w.cache.photoRows.c1).toEqual({ tag: '1111111111111113', jpeg: 'C1c' });
  });
});

// The keeping-in-step job runs each time the wallet has
// the server's own list of cards, and the screens are told what they need of the phone as a card.
describe('ServerWatch and the phone as a card', () => {
  // The world's issuer key: sixteen zero bytes.
  const pid = (n: number) => phoneCardId(new Uint8Array(16), n);

  it("runs the job on the server's list each time the cards load, then says which cards are phones' and which is this phone's", async () => {
    const { w, watch } = world();
    w.at(HOST).cards = [card('c1', 1), card(pid(0), 2), card(pid(1), 3)];
    w.phone.supported = true;
    w.phone.record = { n: 1, removing: false };
    w.cache.removed = [{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }];
    watch.watch();
    await settle();
    expect(w.phone.kept).toEqual([['c1', pid(0), pid(1)]]);
    expect(watch.snapshot().phoneCard).toEqual({
      supported: true, record: { n: 1, removing: false }, ids: [pid(0), pid(1)], own: pid(1), removed: [{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }],
    });
    await watch.reloadCards();
    await settle();
    expect(w.phone.kept).toHaveLength(2);
  });

  it('loads the cards and the money again after a run that changed something on the server; the run after it finds nothing and ends it', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    let runs = 0;
    w.phone.keep = async () => ({ changed: ++runs === 1 });
    watch.watch();
    await settle();
    await settle();
    expect(runs).toBe(2);
    expect(srv.count('cards')).toBe(2);
    expect(srv.count('wallet')).toBeGreaterThanOrEqual(2);
  });

  it('asks for the list again once after a run the server refused, and not after each one in a row', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    let runs = 0;
    w.phone.keep = async () => {
      runs++;
      throw new CarddError(500, 'internal', 'store: disk full');
    };
    watch.watch();
    await settle();
    await settle();
    expect([runs, srv.count('cards')]).toEqual([2, 2]);
    // The person is told, over the cards: a card left part-way in the sleeve has its reason.
    expect(watch.snapshot().cardsError).toBe("Your server refused a change to a phone's card: store: disk full");
    await watch.reloadCards();
    await settle();
    expect([runs, srv.count('cards')]).toEqual([3, 3]);
    expect(watch.snapshot().cardsError).toBe("Your server refused a change to a phone's card: store: disk full");
    // A run that goes through is a fresh start, and the line goes with the next list.
    w.phone.keep = async () => ({ changed: false });
    await watch.reloadCards();
    await settle();
    expect(srv.count('cards')).toBe(4);
    expect(watch.snapshot().cardsError).toBeNull();
  });

  it('leaves what it showed as it was for a run that was not made: the phone is armed as a card', async () => {
    const { w, watch } = world();
    w.phone.supported = true;
    w.phone.keep = async () => null;
    watch.watch();
    await settle();
    expect(w.phone.kept).toHaveLength(1);
    expect(watch.snapshot().phoneCard).toEqual(NO_PHONE_CARD);
    expect(w.at(HOST).count('cards')).toBe(1);
  });

  it("does not run the job while the server can't be reached, and still tells this phone's card from what the phone remembers", async () => {
    const { w, watch } = world();
    w.cache.rows = { [pid(0)]: { id: pid(0), version: 0, name: 'Pixel 8 Pro', state: 'active' }, c1: { id: 'c1', version: 1, name: 'Daily', state: 'active' } };
    w.phone.supported = true;
    w.phone.record = { n: 0, removing: false };
    w.at(HOST).fail = offline();
    watch.watch();
    await settle();
    expect(w.phone.kept).toEqual([]);
    expect(watch.snapshot()).toMatchObject({ cardsDown: true, phoneCard: { supported: true, record: { n: 0, removing: false }, ids: [pid(0)], own: pid(0), removed: [] } });
  });

  // A card given up on its page: the Wallet page says so until the person has read it.
  it('keeps the cards given up for the Wallet page until the person has read it', async () => {
    const { watch } = world();
    watch.watch();
    await settle();
    expect(watch.snapshot().gaveUp).toEqual([]);
    watch.noteGaveUp({ name: 'Daily', amountMsat: 5_000_000, pending: false });
    watch.noteGaveUp({ name: 'Old', amountMsat: 0, pending: true });
    expect(watch.snapshot().gaveUp).toEqual([
      { name: 'Daily', amountMsat: 5_000_000, pending: false },
      { name: 'Old', amountMsat: 0, pending: true },
    ]);
    watch.dismissGaveUp();
    expect(watch.snapshot().gaveUp).toEqual([]);
  });

  it('empties the notice of removed cards when the person has read it, on the phone too', async () => {
    const { w, watch } = world();
    w.cache.removed = [{ name: 'Pixel 8 Pro', amountMsat: null }];
    watch.watch();
    await settle();
    expect(watch.snapshot().phoneCard.removed).toHaveLength(1);
    await watch.dismissRemovedPhoneCards();
    expect(watch.snapshot().phoneCard.removed).toEqual([]);
    expect(w.cache.removed).toEqual([]);
  });

  it('shows nothing of it once the server is forgotten', async () => {
    const { w, watch } = world();
    w.phone.supported = true;
    w.phone.record = { n: 0, removing: false };
    w.at(HOST).cards = [card(pid(0), 1)];
    watch.watch();
    await settle();
    expect(watch.snapshot().phoneCard.own).toBe(pid(0));
    watch.forget();
    expect(watch.snapshot().phoneCard).toEqual(NO_PHONE_CARD);
  });
});

// Update server carries on by itself after a dropped connection.
describe('ServerWatch, Update server and a connection that drops', () => {
  const STOPPED =
    'The update stopped: Karto Wallet can’t keep a connection to your server. Check this phone’s internet; if that is fine, your server may be down. Then try Update server again.';
  /** An update whose runs each do as told: the steps they finish, then a drop or the end. */
  function updating(runs: { steps: InstallStep[]; drop?: SshDropped['during'] }[]) {
    const x = world();
    x.w.update = async (onStep) => {
      const run = runs.shift() ?? { steps: [] };
      for (const step of run.steps) onStep(step);
      if (run.drop) throw new SshDropped(run.drop, 'Broken pipe');
    };
    return x;
  }
  const start = async (x: ReturnType<typeof updating>) => {
    x.watch.watch();
    await settle();
    const run = x.watch.update();
    await settle();
    // In an object: an async function that returned the promise itself would wait for the whole update.
    return { run };
  };

  it('keeps the steps done, says the connection dropped, waits, and carries on from the step that was cut', async () => {
    const x = await updating([{ steps: ['upload'], drop: 'command' }, { steps: ['first-boot', 'prepare'] }]);
    const { run } = await start(x);
    expect(x.watch.snapshot().update).toEqual({ done: ['upload'], upload: null, startedAt: T0, running: true, dropped: 'command' });
    expect([x.w.updates, x.w.awake]).toEqual([1, [true]]);
    await x.w.clock.advance(1_999);
    expect(x.w.updates).toBe(1);
    await x.w.clock.advance(1);
    await run;
    expect(x.w.updateDone).toEqual([[], ['upload']]);
    const u = x.watch.snapshot().update!;
    expect(u).toMatchObject({ done: ['upload', 'first-boot', 'prepare'], running: false, outcome: { ok: true } });
    expect([u.dropped, u.error, x.w.awake]).toEqual([undefined, undefined, [true, false]]);
  });

  // Each step's time, a step's start kept across a drop, and a log line for each step finished.
  it("times Update server's steps, a step's start kept across a drop, and logs each", async () => {
    const x = world();
    const { w, watch } = x;
    let runs = 0;
    w.update = async (onStep, _onUpload, onStart) => {
      if (runs++ === 0) {
        // The upload takes 3 s; the wait for the first boot is cut by a drop just after it starts.
        onStart!('upload');
        await w.clock.advance(3_000);
        onStep('upload');
        onStart!('first-boot');
        throw new SshDropped('command', 'Broken pipe');
      }
      for (const step of INSTALL_STEPS.slice(1)) {
        onStart!(step);
        onStep(step);
      }
    };
    const { run } = await start(x);
    expect(watch.snapshot().update).toEqual({
      done: ['upload'], upload: null, startedAt: T0, running: true, dropped: 'command',
      stepMs: { upload: 3_000 }, stepStartedAt: { step: 'first-boot', at: T0 + 3_000 },
    });
    expect(w.installLog).toEqual(['CARDAPP-INSTALL {"run":"update","step":"upload","ms":3000}']);
    await w.clock.advance(2_000); // the wait before the connection is tried again
    await run;
    const u = watch.snapshot().update!;
    expect(u).toMatchObject({ done: [...INSTALL_STEPS], running: false, outcome: { ok: true } });
    // The first boot's time runs from its first start, through the wait for the connection: not from the retry's start.
    expect(u.stepMs).toEqual(Object.fromEntries(INSTALL_STEPS.map((step) => [step, step === 'upload' ? 3_000 : step === 'first-boot' ? 2_000 : 0])));
    expect(u.stepStartedAt).toBeUndefined();
    expect(w.installLog).toEqual(INSTALL_STEPS.map((step) => `CARDAPP-INSTALL {"run":"update","step":"${step}","ms":${u.stepMs![step]}}`));
  });

  it('waits 2, 5, then 10 seconds, and at the fourth drop in a row ends as an update that stopped', async () => {
    const drop = { steps: [], drop: 'connect' as const };
    const x = await updating([drop, drop, drop, drop]);
    const { run } = await start(x);
    expect(x.watch.snapshot().update).toMatchObject({ running: true, dropped: 'connect' });
    for (const [ms, runs] of [[2_000, 2], [5_000, 3], [10_000, 4]] as const) {
      await x.w.clock.advance(ms - 1);
      expect(x.w.updates).toBe(runs - 1);
      await x.w.clock.advance(1);
      await settle();
      expect(x.w.updates).toBe(runs);
    }
    await run;
    expect(x.watch.snapshot().update).toMatchObject({ running: false, error: STOPPED, endedAt: T0 + 17_000 });
    expect(x.watch.snapshot().update!.dropped).toBeUndefined();
    expect(x.w.awake).toEqual([true, false]);
  });

  it('starts the count again when a step is finished', async () => {
    const cut = (steps: InstallStep[]) => ({ steps, drop: 'command' as const });
    const x = await updating([cut([]), cut([]), cut(['upload']), cut([]), cut([]), cut(['first-boot']), { steps: ['prepare'] }]);
    const { run } = await start(x);
    await x.w.clock.advance(60_000);
    await run;
    expect(x.w.updates).toBe(7);
    expect(x.w.updateDone.at(-1)).toEqual(['upload', 'first-boot']);
    expect(x.watch.snapshot().update).toMatchObject({ done: ['upload', 'first-boot', 'prepare'], running: false, outcome: { ok: true } });
  });

  it('ends at once on a failure that is not a drop, as before', async () => {
    const x = updating([]);
    x.w.update = async () => {
      throw new Error('install.sh up failed (exit 1): dependency failed to start');
    };
    await (await start(x)).run;
    expect(x.watch.snapshot().update).toMatchObject({ running: false, error: 'The update stopped: install.sh up failed (exit 1): dependency failed to start' });
    expect(x.w.updates).toBe(1);
  });

  // The wallet removed, or a rebuild finished: the phone has let go of that server.
  it('does not connect again after it was told to forget the server: the drop ends the update', async () => {
    const x = await updating([{ steps: ['upload'], drop: 'command' }, { steps: ['first-boot'] }]);
    const held = gate();
    const first = x.w.update;
    x.w.update = async (onStep, onUpload) => {
      await held.promise;
      return first(onStep, onUpload);
    };
    const { run } = await start(x);
    x.watch.forget();
    held.open();
    await run;
    await x.w.clock.advance(60_000);
    expect(x.w.updates).toBe(1);
    expect(x.watch.snapshot().update).toMatchObject({ running: false, error: 'The update stopped: Broken pipe' });
    expect(x.w.awake).toEqual([true, false]);
  });

  it('gives up its wait if it is told to forget while waiting', async () => {
    const x = await updating([{ steps: [], drop: 'command' }, { steps: ['upload'] }]);
    const { run } = await start(x);
    x.watch.forget();
    await x.w.clock.advance(60_000);
    await run;
    expect(x.w.updates).toBe(1);
    expect(x.watch.snapshot().update).toMatchObject({ running: false, error: 'The update stopped: Broken pipe' });
  });
});

// With a server that says its books' rev, the refresh is a
// read the server holds until the books change. The tests above are a server from before, which has no rev.
describe('the held refresh of the wallet', () => {
  const REV = (n: number) => `fa4eca4d-${n}`;
  const walletAt = (n: number, poolMsat = 0): Wallet => ({ ...WALLET, pool: { ...account, balanceMsat: poolMsat }, rev: REV(n) });
  /** A watched wallet whose server holds: the first held ask is under way, waiting on the gate returned. */
  async function holding() {
    const x = world();
    const srv = x.w.at(HOST);
    srv.wallet = walletAt(1);
    let held = gate();
    srv.heldHold = held.promise;
    const release = x.watch.watch();
    await settle();
    /** The server answers the held ask under way; the next one asked will wait on a new gate. */
    const answer = async () => {
      const was = held;
      held = gate();
      srv.heldHold = held.promise;
      was.open();
      await settle();
    };
    return { ...x, srv, release, answer };
  }

  it('asks the server to hold a read from the rev it shows, as soon as it has one, and shows money the moment the answer comes', async () => {
    const { w, watch, srv, answer } = await holding();
    // The wallet on opening is a plain read; the held one follows it at once, not 5 seconds on.
    expect([srv.count('wallet'), srv.heldAsks]).toEqual([1, [{ since: REV(1), wait: 5 }]]);
    await w.clock.advance(MINUTE);
    expect([srv.count('wallet'), srv.heldAsks.length]).toEqual([1, 1]); // held: nothing else is asked meanwhile
    srv.wallet = walletAt(2, 3_000_000); // a top-up: the server answers the held read
    await answer();
    expect(watch.snapshot().wallet).toEqual(walletAt(2, 3_000_000));
    await w.clock.advance(250);
    expect(srv.heldAsks).toEqual([{ since: REV(1), wait: 5 }, { since: REV(2), wait: 5 }]);
    expect(srv.count('wallet')).toBe(1);
  });

  it('shows the wallet before hosting has answered, and hosting when it does', async () => {
    const { watch, srv, answer } = await holding();
    const slow = gate();
    srv.hostingHold = slow.promise;
    const hostings = srv.count('hosting');
    srv.wallet = walletAt(2, 3_000_000);
    await answer();
    expect(watch.snapshot().wallet).toEqual(walletAt(2, 3_000_000));
    expect(srv.count('hosting')).toBe(hostings + 1); // asked beside it
    slow.open();
    await settle();
    expect(watch.snapshot()).toMatchObject({ hosting: HOSTING, unreachable: false });
  });

  it("never queues the app's own load behind a held read, and goes on holding from what that load brought", async () => {
    const { w, watch, srv, answer } = await holding();
    srv.wallet = walletAt(3, 5_000_000); // a move the person just made
    await watch.reloadCards();
    expect([srv.count('wallet'), watch.snapshot().wallet]).toEqual([2, walletAt(3, 5_000_000)]);
    // The held read asked before it comes back with what it had: older than what is shown, and not shown.
    srv.wallet = walletAt(2, 3_000_000);
    await answer();
    expect(watch.snapshot().wallet).toEqual(walletAt(3, 5_000_000));
    await w.clock.advance(250);
    expect(srv.heldAsks.at(-1)).toEqual({ since: REV(3), wait: 5 });
  });

  // A held read is open nearly all the time, where the refresh it replaced was open for a moment every 5 seconds:
  // every brief drop of the phone's connection lands on one. By itself it says nothing of the server.
  it('changes nothing on the screen when a held read drops: the plain read 5 seconds on says whether the server can be reached', async () => {
    const { w, watch, srv, answer } = await holding();
    srv.heldFail = offline(); // the phone changed networks
    await answer();
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: walletAt(1) });
    srv.heldFail = null;
    await w.clock.advance(5_000);
    expect([srv.count('wallet'), srv.heldAsks.length]).toEqual([2, 1]); // a plain read, not a held one
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: walletAt(1) });
    await w.clock.advance(250);
    expect(srv.heldAsks).toHaveLength(2); // it answered: holding goes on
  });

  // The iPhone run's fix (a list the network kept from the phone is asked for again by the refresh), carried into
  // the held refresh: a held read left open through the outage can be the first thing the server answers.
  it('asks for a card list the network kept from the phone again when a held read is the first thing the server answers', async () => {
    const { watch, srv, answer } = await holding();
    srv.fail = offline();
    await watch.reloadCards();
    expect(watch.snapshot()).toMatchObject({ cardsDown: true });
    srv.fail = null; // the network is back; the held read asked before it went is still open
    const asked = srv.count('cards');
    await answer();
    expect(srv.count('cards')).toBe(asked + 1);
    expect(watch.snapshot()).toMatchObject({ cards: srv.cards, cardsDown: false, cardsError: null, unreachable: false });
  });

  it("is plain reads every 5 seconds while the server can't be reached, and holds again from the first that answers", async () => {
    const { w, watch, srv, answer } = await holding();
    srv.heldFail = offline();
    await answer();
    srv.fail = offline();
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ unreachable: true, wallet: null }); // the plain read failed too
    await w.clock.advance(5_000);
    expect([srv.count('wallet'), srv.heldAsks.length]).toEqual([3, 1]); // two plain reads, 5 seconds apart; nothing held
    srv.fail = srv.heldFail = null;
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: walletAt(1) });
    await w.clock.advance(250);
    expect([srv.count('wallet'), srv.heldAsks.length]).toEqual([4, 2]); // and the held read follows it, not 5 seconds on
  });

  it("a refusal from cardd is an answer: not unreachable, and no wallet once the plain read has it too", async () => {
    const { w, watch, srv, answer } = await holding();
    srv.heldFail = new CarddError(401, 'unauthorized', 'unknown or revoked device');
    await answer();
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: walletAt(1) });
    srv.fail = srv.heldFail;
    await w.clock.advance(5_000);
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: null });
  });

  it('shows a held answer that comes after the page was left, and asks no more', async () => {
    const { w, watch, srv, release, answer } = await holding();
    release();
    srv.wallet = walletAt(2, 3_000_000);
    await answer();
    expect(watch.snapshot().wallet).toEqual(walletAt(2, 3_000_000));
    await w.clock.advance(MINUTE);
    expect([srv.heldAsks.length, srv.count('wallet'), w.clock.pending()]).toEqual([1, 1, 0]);
  });

  it.each([
    ['the page was left', (x: { release: () => void; watch: ServerWatch }) => x.release()],
    ['the app went behind', (x: { release: () => void; watch: ServerWatch }) => x.watch.background()],
  ])("a held read that fails after %s doesn't touch the flag or the wallet shown", async (_, leave) => {
    const x = await holding();
    leave(x);
    x.srv.heldFail = offline();
    await x.answer();
    expect(x.watch.snapshot()).toMatchObject({ unreachable: false, wallet: walletAt(1) });
  });

  it("reads today's sales after a held wallet whose count of sales changed", async () => {
    const { watch, srv, answer } = await holding();
    const shop = { ...account, address: '', phones: 1, sales: 1 };
    srv.days = [{ day: 0, count: 1, totalMsat: 2_500_000 }];
    srv.wallet = { ...walletAt(2), shop };
    await answer();
    expect(watch.snapshot().wallet?.shop).toEqual(shop);
    expect(srv.calls.filter((c) => c.startsWith('salesDays'))).toHaveLength(1);
  });

  it('shows nothing a held read brings from a server it has forgotten, and holds from the new one', async () => {
    const { w, watch, srv, release, answer } = await holding();
    release();
    watch.forget(); // a rebuild finished: the saved server is another
    w.saved.state = saved({ host: server(NEW_HOST) });
    srv.wallet = walletAt(2, 3_000_000);
    await answer(); // the old server's answer, on its way since before
    expect(watch.snapshot()).toMatchObject({ wallet: null, unreachable: false });
    const fresh = w.at(NEW_HOST);
    fresh.wallet = walletAt(7, 9_000_000);
    fresh.heldHold = gate().promise;
    watch.watch();
    await settle();
    expect(watch.snapshot().wallet).toEqual(walletAt(7, 9_000_000));
    expect([fresh.heldAsks, srv.heldAsks.length]).toEqual([[{ since: REV(7), wait: 5 }], 1]);
  });

  it('has one refresh after the app went behind and came back with a held read under way, and shows what that read brings', async () => {
    const { w, watch, srv, answer } = await holding();
    watch.background();
    watch.foreground();
    await settle();
    expect(srv.heldAsks).toHaveLength(2); // the read from before, still under way, and the new refresh's
    srv.wallet = walletAt(2, 3_000_000);
    await answer();
    expect(watch.snapshot().wallet).toEqual(walletAt(2, 3_000_000));
    await w.clock.advance(250);
    // One refresh goes on from it: two would each have asked again.
    expect(srv.heldAsks.slice(2)).toEqual([{ since: REV(2), wait: 5 }]);
  });

  it("isn't made unreachable by a held read that fails while the server updates", async () => {
    const { w, watch, srv, answer } = await holding();
    const restart = gate();
    w.update = () => restart.promise;
    const run = watch.update();
    await settle();
    srv.heldFail = srv.fail = offline(); // cardd restarts
    await answer();
    await w.clock.advance(5_000); // and the plain read after it fails too
    expect(watch.snapshot()).toMatchObject({ unreachable: false, wallet: null });
    srv.fail = null;
    srv.heldFail = null;
    restart.open();
    await run;
  });

  it('holds nothing from a server from before: it has no rev', async () => {
    const { w, watch } = world();
    const srv = w.at(HOST);
    watch.watch();
    await settle();
    await w.clock.advance(MINUTE);
    expect([srv.heldAsks.length, srv.count('wallet')]).toEqual([0, 13]);
  });
});

describe('the rate kept fresh', () => {
  const SECOND = 1_000;
  /** A watch that has woken once on a watcher and been left: what an account page or Send out sees. */
  async function left() {
    const { w, watch } = world();
    const srv = w.at(HOST);
    const release = watch.watch();
    await settle();
    release();
    const keep = watch.keepRate();
    return { w, watch, srv, keep, wallets: () => srv.count('wallet') };
  }
  const rated = (rev: string, time: number): Wallet => ({ ...WALLET, rev, fiat: { currency: 'GBP', price: 80_000, time } });

  it('no extra read before 5 minutes, one after', async () => {
    const { w, wallets } = await left();
    const before = wallets();
    await w.clock.advance(RATE_STALE_MS - SECOND);
    expect(wallets()).toBe(before);
    await w.clock.advance(61 * SECOND);
    expect(wallets()).toBe(before + 1);
  });

  it('none while a watcher is in front', async () => {
    const { w, watch, srv } = await left();
    const held = watch.watch();
    await settle();
    const before = srv.count('wallet');
    await w.clock.advance(11 * MINUTE);
    // Only the refresh's own reads, every 5 seconds: none of the slow re-read's on top.
    expect(srv.count('wallet') - before).toBe((11 * MINUTE) / 5_000);
    held();
  });

  it('none while the app is behind; one at once on foreground after 5 minutes', async () => {
    const { w, watch, wallets } = await left();
    const before = wallets();
    watch.background();
    await w.clock.advance(10 * MINUTE);
    expect([wallets(), w.clock.pending()]).toEqual([before, 0]);
    watch.foreground();
    await settle();
    expect(wallets()).toBe(before + 1);
  });

  it('an unreachable server is asked again only 5 minutes after each attempt', async () => {
    const { w, srv, wallets } = await left();
    srv.fail = offline();
    const before = wallets();
    await w.clock.advance(RATE_STALE_MS);
    expect(wallets()).toBe(before + 1);
    await w.clock.advance(10 * MINUTE);
    expect(wallets()).toBe(before + 3);
  });

  it('seenWallet takes a newer wallet or a new rate, drops one behind or for another server', async () => {
    const { watch } = await left();
    const deps = watch.snapshot().deps!;
    let published = 0;
    watch.subscribe(() => published++);
    watch.seenWallet(deps, rated('0a0b0c0d-5', 100));
    expect(watch.snapshot().wallet?.fiat?.time).toBe(100);
    watch.seenWallet(deps, rated('0a0b0c0d-5', 200)); // the same books, a new rate
    expect(watch.snapshot().wallet?.fiat?.time).toBe(200);
    watch.seenWallet(deps, rated('0a0b0c0d-4', 300)); // behind
    expect(watch.snapshot().wallet?.fiat?.time).toBe(200);
    watch.seenWallet({ ...deps } as CardDeps, rated('0a0b0c0d-6', 400)); // another server's clients
    expect(watch.snapshot().wallet?.fiat?.time).toBe(200);
    const now = published;
    watch.seenWallet(deps, rated('0a0b0c0d-5', 200)); // nothing new
    expect(published).toBe(now);
    watch.forget();
    watch.seenWallet(deps, rated('0a0b0c0d-7', 500)); // a server forgotten
    expect(watch.snapshot().wallet).toBeNull();
  });

  it('seenWallet pushes the slow read back', async () => {
    const { w, watch, wallets } = await left();
    const before = wallets();
    await w.clock.advance(4 * MINUTE);
    watch.seenWallet(watch.snapshot().deps!, rated('0a0b0c0d-5', 100));
    await w.clock.advance(2 * MINUTE);
    expect(wallets()).toBe(before);
  });

  it('release stops it', async () => {
    const { w, keep, wallets } = await left();
    const before = wallets();
    keep();
    await w.clock.advance(20 * MINUTE);
    expect([wallets(), w.clock.pending()]).toEqual([before, 0]);
  });
});

