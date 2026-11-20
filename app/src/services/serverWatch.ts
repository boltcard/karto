// What the wallet and Settings both need from the server, kept for the app's
// life: the server page's background work moved
// out of the screens, doing what it did. A plain class, as HostingSyncer is:
// everything platform-bound is injected, so it runs in node with a fake clock.
import { NO_BACKUPS, type BackupsView } from '../backup/panel';
import { CarddError, revBehind, type CardInfo, type HostingStatus, type Wallet } from '../cardd/client';
import { HELD_WAIT_S, heldLoop, type Asked } from '../cards/poll';
import { updateOutcome, type ServerStatus } from '../cardd/status';
import { catchUp, rememberCards } from '../cards/catchUp';
import { isNetworkFailure, type CardDeps } from '../cards/deps';
import { listError } from '../cards/labels';
import type { Vm } from '../lnvps/client';
import { dayStart, resumeNotice } from '../money/format';
import { isGatewayError, resumePending } from '../money/requests';
import type { NfcState } from '../native/nfc';
import type { InstallStep, UploadProgress } from '../onboarding/install';
import { installLogLine } from '../onboarding/progress';
import { DROPS_WAITED, type OnboardingState } from '../onboarding/machine';
import { RECONNECT_MS } from '../onboarding/runner';
import { SshDropped } from '../onboarding/ssh';
import type { CachedPhoto, RemovedPhoneCard } from '../store/store';
import type { GaveUp } from '../wallet/accountView';
import { phonesAmong } from '../wallet/phoneCardView';
import { photoUri, syncPhotos } from '../wallet/photos';
import { hasShop, salesToday } from '../wallet/shop';
import type { Row } from '../wallet/stack';

/** The wallet and hosting, while the wallet or Settings is in front (as the server page's card list did). */
const REFRESH_MS = 5_000;
/** A key trusted on first use is checked against LNVPS's this often (LNVPS publishes it within minutes of the server starting, sometimes up to an hour). */
const KEY_CHECK_MS = 5 * 60_000;
/** While the backups view carries a warning or its check failed, it is checked again this often. */
const BACKUPS_RECHECK_MS = 60_000;
/**
 * The wallet (and its rate) is read again once it is this old, while the app is in front and no watcher's refresh
 * runs: the server refreshes its own rate every 5 minutes (server/internal/rates). Old counts from the last
 * read, taken or failed, so an unreachable server is asked once in this time.
 */
export const RATE_STALE_MS = 5 * 60_000;
/** How often the slow re-read looks at how old the wallet is. */
export const RATE_CHECK_MS = 60_000;

/** Whether two answers' rates differ: what an account page's wallet must bring to be published. */
const sameFiat = (a: Wallet['fiat'], b: Wallet['fiat']) => a?.currency === b?.currency && a?.price === b?.price && a?.time === b?.time;

export type WatchDeps = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** The phrase and onboarding's state as saved now. */
  loadSaved(): Promise<{ phrase: string | null; state: OnboardingState | null }>;
  /** cardDeps(): this server's clients, the ones useCardDeps() gives the screens. */
  makeDeps(state: OnboardingState, phrase: string): CardDeps;
  /** serverStatus() with a CarddClient for deps.host and the app's bundle. */
  serverStatus(deps: CardDeps): Promise<ServerStatus>;
  /** AppStore.noteCarddAnswered: the background job's record of cardd answering. */
  noteCarddAnswered(answered: boolean, nowMs: number): Promise<void>;
  nfcState(): Promise<NfcState>;
  /** verifyHostKey() with an LNVPS client for the phrase: the state, changed if LNVPS settled the key. */
  hostKeyCheck(state: OnboardingState, phrase: string): Promise<OnboardingState>;
  saveState(state: OnboardingState): Promise<void>;
  /** The server page's checkLnvps: LNVPS's answers for this server's VM and a rebuild's old ones; null when it can't ask. */
  lnvpsAnswers(state: OnboardingState, phrase: string): Promise<LnvpsView | null>;
  /** syncHostingIfDue(): the VM's expiry from LNVPS to cardd, at most every 10 minutes; LNVPS's expiry. */
  syncHosting(): Promise<number | null>;
  /** loadBackups() (backup/panel.ts) with the phone's files, the background job and sv.keys(phrase). */
  backups(state: OnboardingState, phrase: string, deps: CardDeps, show: (patch: Partial<BackupsView>) => void): Promise<void>;
  /** updateServer() over the phone's SSH with the app's bundle. */
  /** done: the steps an earlier run of this update finished before its connection dropped. */
  runUpdate(
    state: OnboardingState, phrase: string, done: readonly InstallStep[], onStep: (step: InstallStep) => void, onUpload: (p: UploadProgress) => void,
    onStart?: (step: InstallStep) => void,
  ): Promise<void>;
  /** A line for adb logcat (no secrets): each Update server step's time. */
  log?: (line: string) => void;
  /** expo-keep-awake, for Update server's life: the upload can take minutes on a weak network. */
  keepAwake(on: boolean): void;
  /** retireOldServer() over the phone's SSH and LNVPS: the state, to be saved. */
  retireOld(state: OnboardingState, phrase: string, vmId: number): Promise<OnboardingState>;
  /** The phone as a card. */
  phoneCard: {
    /** Whether this phone can be one: Android with host card emulation, in Karto Wallet's build. */
    supported(): Promise<boolean>;
    /** This phone's record of its own card: its number, and whether it is being removed. Null for none, or one that can't be read. */
    record(): Promise<{ n: number; removing: boolean } | null>;
    /**
     * The keeping-in-step job (phoneCard/keep.ts), with the server's own list. Null for a run that was not made;
     * changed: it asked the server to change something, so the list is out of date.
     */
    keep(deps: CardDeps, cards: CardInfo[]): Promise<{ changed: boolean } | null>;
  };
};

/**
 * The phone as a card, for the screens: whether this phone can be one, its record, which of the cards are phones'
 * (ids) and which is this phone's own, and the other phones' cards the wallet removed that the person has not yet
 * been told of.
 */
export type PhoneCardSnapshot = {
  supported: boolean; record: { n: number; removing: boolean } | null; ids: string[]; own: string | null; removed: RemovedPhoneCard[];
};
const NO_PHONE_CARD: PhoneCardSnapshot = { supported: false, record: null, ids: [], own: null, removed: [] };

/** What LNVPS said of a VM: its record, null when it no longer lists it, or 'unreachable' when it didn't answer. */
export type LnvpsAnswer = Vm | null | 'unreachable';
export type LnvpsView = { vm: LnvpsAnswer; old: LnvpsAnswer[]; lnvpsNowMs: number; unreachableSince: number | null };
export type Outcome = { ok: boolean; text: string };
/** Update server: the steps done, kept after it ends so a failure shows the step it stopped at. */
export type UpdateView = {
  done: InstallStep[];
  upload: UploadProgress | null;
  startedAt: number;
  endedAt?: number;
  running: boolean;
  outcome?: Outcome;
  error?: string;
  /** Waiting to connect again after the connection dropped, and during what it dropped; gone once a step finishes. */
  dropped?: SshDropped['during'];
  /** The step running and when it began (ms), kept across a drop. */
  stepStartedAt?: { step: InstallStep; at: number };
  /** Each step finished in this press, its time in ms. */
  stepMs?: Partial<Record<InstallStep, number>>;
};

/** How Update server ends at the drop after DROPS_WAITED in a row, after "The update stopped: ". */
export const UPDATE_KEEPS_DROPPING =
  'Karto Wallet can’t keep a connection to your server. Check this phone’s internet; if that is fine, your server may be down. Then try Update server again.';

export type WatchSnapshot = {
  /** The saved state, once onboarding is done. */
  state: OnboardingState | null;
  deps: CardDeps | null;
  /** The last status answer, kept while a new check runs. */
  status: ServerStatus | null;
  /** The last status check or refresh reached nothing (a network failure or a gateway error). */
  unreachable: boolean;
  /** cardd's list, or while it can't be reached the phone's cache; null before the first answer. */
  cards: Row[] | null;
  /** The last list failed: what the cards show is the cache, or older. */
  cardsDown: boolean;
  cardsError: string | null;
  wallet: Wallet | null;
  hosting: HostingStatus | null;
  nfc: NfcState | null;
  /** What became of the moves and sends left from before (once per app open). */
  notices: string[];
  /** The cards given up on their pages, for the Wallet page's line until the person has read it. */
  gaveUp: GaveUp[];
  /** When the host key was last checked: the time the key notice is judged at. */
  keyCheckedAt: number;
  /** LNVPS's answers about the VMs, for the rebuild suggestion and the old server's warning. */
  lnvps: LnvpsView | null;
  /** LNVPS's own expiry from the last hosting sync, for the paid-until banner while cardd can't say. */
  lnvpsExpires: number | null;
  /** null until the first check shows something. */
  backups: BackupsView | null;
  update: UpdateView | null;
  /** Retire VM <id>. */
  retire: { running: boolean; outcome?: Outcome };
  /**
   * Each card's photo as a data: URI, by card id: the phone's
   * cache, read at the first wake and kept across a server change (the same
   * phrase gives the same card ids); each list cardd answers brings it up to date.
   */
  photos: Record<string, string>;
  /** Today's paid sales, for the wallet's Shop tile; null with no shop, and while the count can't be read. */
  salesToday: number | null;
  /** The last wallet this server answered had something of a shop: the wallet's Shop tile stays while cardd can't be read. */
  hadShop: boolean;
  /** Read each time the cards are: from cardd's list after the keeping-in-step job has run on it, or from the phone's cache. */
  phoneCard: PhoneCardSnapshot;
  /**
   * The last wake couldn't read the saved state (the phone's database or keystore didn't answer): nothing is
   * refreshed until a read works, and the wallet says so rather than showing what it last had.
   */
  cantRead: boolean;
};

/** Whether cardd answered (its own refusals included), nothing reached it (false), or the error says neither (null). */
function answered(error: unknown): boolean | null {
  if (isNetworkFailure(error) || isGatewayError(error)) return false;
  return error instanceof CarddError ? true : null;
}

const keyPending = (s: OnboardingState) => s.host?.keySource === 'first_use' && !s.hostKeyMismatch;

export class ServerWatch {
  private snap: WatchSnapshot;
  private readonly listeners = new Set<(s: WatchSnapshot) => void>();
  /** The phrase the clients were made for. */
  private phrase: string | null = null;
  private watchers = 0;
  private active = true;
  /** While Update server runs, cardd restarts: failures then don't make it unreachable. */
  private updating = false;
  private refresh: { stop(): void; kick(): void } | null = null;
  /** The last held read of the refresh dropped: the next turn is a plain read, and that one says whether the server can be reached. */
  private heldDropped = false;
  /** The card list last failed because nothing answered: the refresh asks for it again once the server does. */
  private cardsUnreached = false;
  /** The newest status check and card list asked for: an older answer is dropped. */
  private statusAsked = 0;
  private cardsAsked = 0;
  private resumed = false;
  private keyTimer: { timer: unknown } | null = null;
  private backupsTimer: { timer: unknown } | null = null;
  private keyBusy = false;
  /** The loads that run one at a time, by name, for the server they started for. */
  private readonly runs = new Map<string, { deps: CardDeps; again: boolean }>();
  /** Update server or Retire VM works over SSH: one at a time, as the server page's busy flag did. */
  private sshBusy = false;
  /** How many times it forgot: a read of the saved state made before the last is read again. */
  private forgets = 0;
  private photosRead = false;
  /** What today's sales were last read for: the server, its count of sales ever and the phone's day. */
  private salesRead: { deps: CardDeps; sales: number; day: number } | null = null;
  /** The newest card list cardd answered, for the photo sync. */
  private photoList: CardInfo[] | null = null;
  /** The same, for the keeping-in-step job of the phone as a card; and whether its last run failed. */
  private phoneList: CardInfo[] | null = null;
  private phoneFailed = false;
  /** When the wallet was last read (taken or failed), by the phone's clock; null before any. */
  private moneyAt: number | null = null;
  /** The slow re-read of the wallet: how many asked for it, and its timer while it runs. */
  private keepers = 0;
  private rateTimer: { timer: unknown } | null = null;

  constructor(private readonly d: WatchDeps) {
    this.snap = {
      state: null, deps: null, status: null, unreachable: false, cards: null, cardsDown: false, cardsError: null,
      wallet: null, hosting: null, nfc: null, notices: [], gaveUp: [], keyCheckedAt: d.now(),
      lnvps: null, lnvpsExpires: null, backups: null, update: null, retire: { running: false }, photos: {}, salesToday: null, hadShop: false,
      phoneCard: NO_PHONE_CARD, cantRead: false,
    };
  }

  snapshot(): WatchSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: WatchSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** A watcher (the wallet or Settings) came to the front; returns its release. */
  watch(): () => void {
    this.watchers++;
    this.stopRateCheck();
    this.wake(true).catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.watchers === 0) {
        this.stopRefresh();
        this.stopBackupsRecheck();
        this.scheduleRateCheck();
      }
    };
  }

  /**
   * The slow re-read of the wallet, for the app's life: while the app is in front and no watcher's refresh
   * runs, the wallet is read again once it is RATE_STALE_MS old, so a page that shows or converts £ (an account
   * page, Send out) never uses a rate much older than the server's. Returns its release.
   */
  keepRate(): () => void {
    this.keepers++;
    this.scheduleRateCheck();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.keepers === 0) this.stopRateCheck();
    };
  }

  /**
   * A wallet an account page read for itself: taken as the watch's own when it is for the server the watch
   * holds and not behind the one shown. Published only when its books or its rate are new, so the page's answers
   * every few seconds don't redraw every screen.
   */
  seenWallet(deps: CardDeps, wallet: Wallet): void {
    if (deps !== this.snap.deps || revBehind(wallet.rev, this.snap.wallet?.rev)) return;
    this.moneyAt = this.d.now();
    const shown = this.snap.wallet;
    if (shown && shown.rev === wallet.rev && sameFiat(shown.fiat, wallet.fiat)) return;
    this.set({ wallet, hadShop: hasShop(wallet) });
  }

  foreground(): void {
    if (this.active) return;
    this.active = true;
    this.scheduleKeyCheck();
    if (this.watchers > 0) this.wake(false).catch(() => {});
    else if (this.keepers > 0) {
      this.rateCheck();
      this.scheduleRateCheck();
    }
  }

  background(): void {
    if (!this.active) return;
    this.active = false;
    this.stopRefresh();
    this.stopKeyCheck();
    this.stopBackupsRecheck();
    this.stopRateCheck();
  }

  /** The account page's own refresh: one result, for the unreachable flag. */
  reportRefresh(r: { ok: true } | { ok: false; error: unknown }): void {
    this.set({ unreachable: this.flagAfter(r.ok || answered(r.error)) });
  }

  /** As Check again did: the status (then LNVPS's answers) and the hosting sync. */
  checkAgain(): Promise<void> {
    return Promise.all([this.checkServer(), this.syncHosting()]).then(() => {});
  }

  /** The wallet's Try again after the saved state couldn't be read (cantRead): read again, and on as a focus goes. */
  readAgain(): Promise<void> {
    return this.wake(true);
  }

  reloadCards(): Promise<void> {
    return Promise.all([this.loadCards(), this.loadMoney()]).then(() => {});
  }

  /**
   * A rebuild or onboarding finished, just before the wallet: the saved server
   * may be another, or the same host made again. Nothing held for the old one
   * is shown (the wallet waits for the next watch to read the saved state and
   * make new clients); a running update goes on. Its answers still on their
   * way are dropped, as an old server's are, and nothing they read is saved.
   * Also for a wallet taken off the phone or carried on (an iPhone).
   */
  forget(): void {
    this.forgets++;
    this.phrase = null;
    this.stopKeyCheck();
    this.set({ state: null, deps: null, ...this.dropped() });
  }

  /**
   * Update server: goes on whatever screen is in front, keeping the phone
   * awake, until it ends; then the status is checked again, for its outcome,
   * and the card list is loaded from the new cardd. A connection that drops
   * is waited out and the update run again from the step that was cut, up to
   * DROPS_WAITED times in a row with no step finished;
   * never once the watch
   * has been told to forget the server.
   */
  async update(): Promise<void> {
    const { state, deps } = this.snap;
    const phrase = this.phrase;
    if (this.sshBusy || !state || !deps || !phrase) return;
    this.sshBusy = true;
    this.updating = true;
    this.d.keepAwake(true);
    this.set({ update: { done: [], upload: null, startedAt: this.d.now(), running: true } });
    const forgets = this.forgets;
    try {
      for (let drops = 0; ; ) {
        try {
          await this.d.runUpdate(
            state,
            phrase,
            this.snap.update?.done ?? [],
            (step) => {
              drops = 0; // a step finished: the row of drops ends
              const u = this.snap.update;
              const ms = u?.stepStartedAt?.step === step ? this.d.now() - u.stepStartedAt.at : undefined;
              this.patchUpdate((v) => ({
                done: [...v.done, step], dropped: undefined, stepStartedAt: undefined,
                ...(ms !== undefined && { stepMs: { ...v.stepMs, [step]: ms } }),
              }));
              if (ms !== undefined) this.d.log?.(installLogLine('update', step, ms));
            },
            (upload) => this.patchUpdate(() => ({ upload })),
            // A step starts; a retry after a drop keeps its first start.
            (step) => this.patchUpdate((u) => (u.stepStartedAt?.step === step ? {} : { stepStartedAt: { step, at: this.d.now() } })),
          );
          break;
        } catch (e) {
          if (!(e instanceof SshDropped) || forgets !== this.forgets) throw e;
          if (++drops > DROPS_WAITED) throw new Error(UPDATE_KEEPS_DROPPING);
          // The upload's figure was that try's: the next says "Connecting to the server…".
          this.patchUpdate(() => ({ dropped: e.during, upload: null }));
          await new Promise<void>((resolve) => this.d.setTimeout(resolve, RECONNECT_MS[drops - 1]));
          if (forgets !== this.forgets) throw e;
        }
      }
      this.patchUpdate(() => ({ endedAt: this.d.now() }));
      this.updating = false;
      const status = await this.checkStatus();
      this.patchUpdate(() => ({ running: false, ...(status && { outcome: updateOutcome(status) }) }));
      // Each shows its own failure where it draws: none of them can turn the outcome into a stop. The backups
      // too: a check made while cardd restarted met the proxy's 502.
      await Promise.allSettled([this.loadCards(), this.loadMoney(), this.loadLnvps(), this.loadBackups()]);
    } catch (e) {
      this.patchUpdate(() => ({ endedAt: this.d.now(), running: false, dropped: undefined, error: `The update stopped: ${e instanceof Error ? e.message : String(e)}` }));
      // The server may have restarted or not: read it again, so Settings doesn't keep the status from before.
      this.updating = false;
      await this.checkStatus().catch(() => {});
    } finally {
      this.updating = false;
      this.d.keepAwake(false);
      this.sshBusy = false;
    }
  }

  /**
   * The old server runs again though step 4 never retired it over SSH.
   * The screen asks for the screen lock first.
   */
  async retireOld(vmId: number): Promise<void> {
    if (this.sshBusy || !this.snap.deps) return;
    this.sshBusy = true;
    this.set({ retire: { running: false } });
    const forgets = this.forgets;
    try {
      const { phrase, state } = await this.d.loadSaved();
      if (!phrase || !state) return;
      this.set({ retire: { running: true } });
      const next = await this.d.retireOld(state, phrase, vmId);
      // Forgotten meanwhile (a rebuild finished, or the wallet was taken off the phone): what was read before
      // it is not saved over what the phone holds now.
      if (forgets !== this.forgets) return;
      await this.d.saveState(next);
      const same = next.host?.hostname === this.snap.deps?.host && phrase === this.phrase;
      this.set({ ...(same && { state: next }), retire: { running: true, outcome: { ok: true, text: `The old server (VM ${vmId}) is retired: it can't start again.` } } });
      await this.loadLnvps();
    } catch (e) {
      // A dropped connection in words of its own, not the phone's (an iPhone's say nothing); the button is there again.
      const why = e instanceof SshDropped ? 'the connection to it dropped. Try again.' : e instanceof Error ? e.message : String(e);
      this.set({ retire: { running: true, outcome: { ok: false, text: `Couldn't retire the old server: ${why}` } } });
    } finally {
      if (this.snap.retire.running) this.set({ retire: { ...this.snap.retire, running: false } });
      this.sshBusy = false;
    }
  }

  /** The photo screen saved a card's photo: into the cache and the faces at once. */
  async photoSaved(id: string, photo: CachedPhoto): Promise<void> {
    const deps = this.snap.deps;
    if (!deps) return;
    await deps.cache.savePhoto(id, photo);
    this.setPhoto(id, photoUri(photo.jpeg));
  }

  /** The photo screen removed a card's photo. */
  async photoRemoved(id: string): Promise<void> {
    const deps = this.snap.deps;
    if (!deps) return;
    await deps.cache.dropPhoto(id);
    this.setPhoto(id, null);
  }

  /** The way out of a pause: the screen asks first. The difference goes to pool. */
  setBooks(): Promise<void> {
    return this.books((deps) => deps.cardd.reconcileBooks());
  }

  /** No channel back after a restore: the screen asks for the screen lock first. */
  restoreBooks(): Promise<void> {
    return this.books((deps) => deps.cardd.restoreBooks());
  }

  /**
   * On a focus (focus) or back in the foreground while watched: the saved
   * state again (a rebuild or restore may have changed the server), then the
   * status (then LNVPS's answers), the wallet, the NFC state, the hosting sync
   * and the backups check; the card list on a focus, or for a new server.
   */
  private async wake(focus: boolean): Promise<void> {
    const forgets = this.forgets;
    let saved: Awaited<ReturnType<WatchDeps['loadSaved']>>;
    try {
      saved = await this.d.loadSaved();
    } catch (e) {
      this.stopRefresh();
      this.set({ cantRead: true });
      throw e;
    }
    if (this.snap.cantRead) this.set({ cantRead: false });
    const { phrase, state } = saved;
    if (forgets !== this.forgets) return this.wake(focus); // read before forget(): maybe the old server's
    if (!phrase || state?.step !== 'done' || !state.host) return;
    const fresh = this.adopt(state, phrase);
    await this.readPhotos();
    this.startRefresh();
    if (fresh) void this.checkKey();
    else this.scheduleKeyCheck();
    await Promise.all([
      this.checkServer(),
      focus || fresh ? this.loadCards() : null,
      this.loadMoney(),
      this.readNfc(),
      this.syncHosting(),
      this.loadBackups(),
    ]);
  }

  /** Takes the saved state; for another host or phrase, new clients and nothing held from the old ones. Whether it was new. */
  private adopt(state: OnboardingState, phrase: string): boolean {
    const fresh = this.snap.deps?.host !== state.host!.hostname || phrase !== this.phrase;
    if (!fresh) {
      this.set({ state });
      return false;
    }
    this.phrase = phrase;
    this.set({ state, deps: this.d.makeDeps(state, phrase), ...this.dropped() });
    return true;
  }

  /**
   * Nothing held from a server: its answers, LNVPS's, the backups view and
   * the outcomes; a running update and retire are kept. The notices (the
   * person's moves and sends, once per app open), the NFC state and the key
   * check's time are the phone's, so they stay.
   */
  private dropped(): Partial<WatchSnapshot> {
    const { update, retire } = this.snap;
    this.moneyAt = null;
    return {
      status: null, unreachable: false, cards: null, cardsDown: false, cardsError: null, wallet: null, hosting: null,
      lnvps: null, lnvpsExpires: null, backups: null, update: update?.running ? update : null, retire: { running: retire.running },
      salesToday: null, hadShop: false, phoneCard: NO_PHONE_CARD, gaveUp: [],
    };
  }

  /** The status, then LNVPS's answers: after cardd's answer is noted, so the record of it failing is current. */
  private async checkServer(): Promise<void> {
    await this.checkStatus();
    await this.loadLnvps();
  }

  private async checkStatus(): Promise<ServerStatus | null> {
    const deps = this.snap.deps;
    if (!deps) return null;
    const asked = ++this.statusAsked;
    const status = await this.d.serverStatus(deps);
    if (deps !== this.snap.deps || asked !== this.statusAsked) return status;
    // While Update server runs, cardd restarts: reaching nothing then keeps the last
    // status, so Settings doesn't say it can't reach the server; the check after it counts.
    if (status.kind === 'unreachable' && this.updating) return status;
    this.set({ status, unreachable: this.flagAfter(status.kind !== 'unreachable') });
    await this.d.noteCarddAnswered(status.kind !== 'unreachable', this.d.now()).catch(() => {});
    return status;
  }

  /** The card list, after telling cardd about wipes done while it was down; the cache while it can't be reached. */
  private async loadCards(): Promise<void> {
    const deps = this.snap.deps;
    if (!deps) return;
    const asked = ++this.cardsAsked;
    const current = () => deps === this.snap.deps && asked === this.cardsAsked;
    try {
      await catchUp(deps).catch(() => 0);
      const list = await deps.cardd.cards();
      // Forgotten meanwhile: the cache may be a removed wallet's, emptied, and this list is not put back in it.
      if (deps !== this.snap.deps) return;
      await rememberCards(deps.cache, list);
      if (!current()) return;
      this.cardsUnreached = false;
      this.set({ cards: list, cardsDown: false, cardsError: null });
      this.photoList = list;
      void this.oneAtATime('photos', 'again', (d) => this.syncPhotos(d));
      this.phoneList = list;
      void this.oneAtATime('phoneCard', 'again', (d) => this.keepPhoneCard(d));
    } catch (e) {
      const cached = isNetworkFailure(e) ? await deps.cache.cards().catch(() => null) : null;
      // By the banner's own test: a proxy's 502 while cardd restarts is the server out of reach too, not its refusal.
      if (current()) this.cardsUnreached = answered(e) === false;
      if (current()) this.set({ cardsError: listError(e), cardsDown: true, ...(cached && { cards: Object.values(cached) }) });
      // The job needs the server's own list. What the phone remembers still says which cards are phones'.
      if (cached && current()) await this.readPhoneCard(deps, Object.values(cached));
      return;
    }
    void this.resume(deps);
  }

  /**
   * The keeping-in-step job on the newest list cardd answered (never the phone's cache), then what the screens
   * show of the phone as a card. A run that asked the server to change something has made that list out of date:
   * the cards are loaded again, and the run after it finds nothing to do.
   */
  private async keepPhoneCard(deps: CardDeps): Promise<void> {
    const list = this.phoneList;
    if (!list) return;
    let kept: { changed: boolean } | null;
    let refused: string | null = null;
    try {
      kept = await this.d.phoneCard.keep(deps, list);
      this.phoneFailed = false;
    } catch (e) {
      // A refusal the job could not get past may have left the server changed: the list is asked for again, once,
      // and not after each failure in a row, or a server that keeps refusing would be asked without end.
      kept = { changed: !this.phoneFailed };
      this.phoneFailed = true;
      refused = e instanceof Error ? e.message : String(e);
    }
    if (kept === null || deps !== this.snap.deps) return;
    await this.readPhoneCard(deps, list);
    if (kept.changed) return void (await Promise.all([this.loadCards(), this.loadMoney()]));
    // Said once the list is not about to be asked for again (which clears the line): a card left "Being set up"
    // or "Being removed" in the sleeve has its reason over the cards.
    if (refused !== null && deps === this.snap.deps) this.set({ cardsError: `Your server refused a change to a phone's card: ${refused}` });
  }

  /** Whether this phone can be a card, its record, the phones' cards among `cards`, and the removed cards not yet told of. */
  private async readPhoneCard(deps: CardDeps, cards: readonly { id: string }[]): Promise<void> {
    const [supported, record, removed] = await Promise.all([
      this.d.phoneCard.supported().catch(() => false),
      this.d.phoneCard.record().catch(() => null),
      deps.cache.removedPhoneCards().catch(() => []),
    ]);
    if (deps !== this.snap.deps) return;
    const { ids, own } = phonesAmong(deps.issuer, cards, record);
    this.set({ phoneCard: { supported, record, ids: [...ids], own, removed } });
  }

  /** A card given up on its page (account.tsx): the Wallet page says so. */
  noteGaveUp(g: GaveUp): void {
    this.set({ gaveUp: [...this.snap.gaveUp, g] });
  }

  /** The person has read the line of the cards given up. */
  dismissGaveUp(): void {
    this.set({ gaveUp: [] });
  }

  /** The person has read the notice of the removed cards. */
  async dismissRemovedPhoneCards(): Promise<void> {
    const deps = this.snap.deps;
    if (!deps) return;
    await deps.cache.dismissRemovedPhoneCards();
    if (deps === this.snap.deps) this.set({ phoneCard: { ...this.snap.phoneCard, removed: [] } });
  }

  /** The phone's cached photos, once, before the first list: shown even while cardd can't be reached. */
  private async readPhotos(): Promise<void> {
    const deps = this.snap.deps;
    if (this.photosRead || !deps) return;
    this.photosRead = true;
    const rows = await deps.cache.photos().catch(() => ({}) as Record<string, CachedPhoto>);
    const read = Object.fromEntries(Object.entries(rows).map(([id, p]) => [id, photoUri(p.jpeg)]));
    this.set({ photos: { ...read, ...this.snap.photos } });
  }

  /** The cache brought to the newest list cardd answered (never the phone's cache of cards). */
  private async syncPhotos(deps: CardDeps): Promise<void> {
    const list = this.photoList;
    if (!list) return;
    await syncPhotos(list, deps.cardd, deps.cache, (id, uri) => {
      if (deps === this.snap.deps) this.setPhoto(id, uri);
    }).catch(() => {});
  }

  private setPhoto(id: string, uri: string | null): void {
    const photos = { ...this.snap.photos };
    if (uri) photos[id] = uri;
    else delete photos[id];
    this.set({ photos });
  }

  /** Moves and sends left unanswered when the app was last closed are asked again, with their own ids, once per app open. */
  private async resume(deps: CardDeps): Promise<void> {
    if (this.resumed) return;
    this.resumed = true;
    const clock = { now: this.d.now, sleep: (ms: number) => new Promise<void>((r) => this.d.setTimeout(r, ms)) };
    const done = await resumePending({ cardd: deps.cardd, store: deps.cache }, clock).catch(() => []);
    if (done.length === 0) return;
    this.set({ notices: resumeNotice(done) });
    await this.loadMoney();
  }

  /** The wallet and hosting, one load at a time: one asked for meanwhile runs once after it. */
  private loadMoney(): Promise<void> {
    return this.oneAtATime('money', 'again', async (deps) => {
      const [wallet, hosting] = await Promise.allSettled([deps.cardd.wallet(), deps.cardd.hosting()]);
      if (deps !== this.snap.deps) return;
      this.moneyAt = this.d.now();
      const results = [wallet, hosting].map((r) => r.status === 'fulfilled' || answered(r.reason));
      // An answer behind the wallet shown (a held read brought a newer one meanwhile) doesn't put the older one back.
      const shown = wallet.status === 'fulfilled' ? (revBehind(wallet.value.rev, this.snap.wallet?.rev) ? this.snap.wallet! : wallet.value) : null;
      this.set({
        wallet: shown,
        hosting: hosting.status === 'fulfilled' ? hosting.value : null,
        ...(shown ? { hadShop: hasShop(shown) } : {}),
        unreachable: this.flagAfter(results.includes(false) ? false : results.includes(true) || null),
      });
      // A rev to ask past: the refresh holds from it now, not at its next 5 seconds, and before today's sales are read.
      if (shown?.rev) this.refresh?.kick();
      if (shown) await this.loadSalesToday(deps, shown);
    });
  }

  /**
   * One turn of the refresh. With a rev shown, a read the
   * server holds until the books change, in a lane of its own: the app's own loads are never queued behind it, and
   * its answer is shown the moment it comes, hosting's status beside it when that comes. With none (a server from
   * before held reads, or one that didn't answer the last plain read), and after a held read that dropped, the
   * refresh as it was: the wallet and hosting, every 5 seconds. Says what the turn came to (cards/poll.ts Asked): with something new to ask past, the next follows at once.
   */
  private async refreshOnce(live: () => boolean): Promise<Asked> {
    const deps = this.snap.deps;
    if (!deps) return 'plain';
    const rev = this.snap.wallet?.rev;
    if (!rev || this.heldDropped) {
      this.heldDropped = false;
      await this.loadMoney();
      await this.cardsAgain();
      return deps === this.snap.deps && this.snap.wallet?.rev ? 'moved' : 'plain';
    }
    let wallet: Wallet;
    try {
      wallet = await deps.cardd.wallet({ since: rev, wait: HELD_WAIT_S });
    } catch (e) {
      // A held read is open nearly all the time, so every brief drop of the phone's connection (a change of
      // network, a lift) lands on one: by itself it changes nothing on the screen. The next turn, 5 seconds on, is
      // a plain read, and that one says whether the server can be reached, as a failed refresh always did. A read
      // cut off by leaving the page or by the app going behind says nothing at all.
      if (deps === this.snap.deps && live() && this.active) this.heldDropped = true;
      throw e;
    }
    if (deps !== this.snap.deps) return 'plain';
    // Shown though the page was left meanwhile: it is a good wallet. Not shown when behind the one shown (the
    // app's own load brought a newer one while this was held), and then it says nothing of the flag either.
    if (!revBehind(wallet.rev, this.snap.wallet?.rev)) {
      this.moneyAt = this.d.now();
      this.set({ wallet, hadShop: hasShop(wallet), unreachable: this.flagAfter(true) });
      void this.loadHosting(deps, live);
      await this.loadSalesToday(deps, wallet);
      await this.cardsAgain();
    }
    return deps === this.snap.deps && this.snap.wallet?.rev !== rev ? 'moved' : 'held';
  }

  /**
   * A list the network kept from the phone is asked for again as soon as the server answers a turn of the refresh,
   * plain or held: the person is on the Wallet, and nothing else would ask until they left it and came back.
   */
  private async cardsAgain(): Promise<void> {
    if (this.cardsUnreached && !this.snap.unreachable) await this.loadCards();
  }

  /** Hosting's status beside a held wallet: shown when it comes, and added to the flag by the rule of the two together (the wallet answered). */
  private async loadHosting(deps: CardDeps, live: () => boolean): Promise<void> {
    try {
      const hosting = await deps.cardd.hosting();
      if (deps === this.snap.deps) this.set({ hosting });
    } catch (e) {
      if (deps !== this.snap.deps || !live() || !this.active) return;
      this.set({ hosting: null, ...(answered(e) === false ? { unreachable: this.flagAfter(false) } : {}) });
    }
  }

  /**
   * Today's paid sales, after the wallet: asked only when the wallet has something of a shop, and again only when
   * a sale was paid or the phone's day turned since. A failure leaves none, and the next refresh asks again.
   */
  private async loadSalesToday(deps: CardDeps, wallet: Wallet): Promise<void> {
    if (!hasShop(wallet)) return this.set({ salesToday: null });
    const nowS = Math.floor(this.d.now() / 1000);
    const offsetMin = -new Date(this.d.now()).getTimezoneOffset();
    const read = { deps, sales: wallet.shop!.sales, day: dayStart(nowS, offsetMin) };
    const last = this.salesRead;
    if (last && last.deps === deps && last.sales === read.sales && last.day === read.day) return;
    const days = await deps.cardd.salesDays(offsetMin, 1).catch(() => null);
    if (deps !== this.snap.deps) return;
    this.salesRead = days && read;
    this.set({ salesToday: days && salesToday(days, nowS, offsetMin) });
  }

  /** LNVPS's answers for the held state (a retire changes it: one asked for meanwhile runs after); kept when it can't ask. */
  private loadLnvps(): Promise<void> {
    return this.oneAtATime('lnvps', 'again', async (deps) => {
      const { state } = this.snap;
      if (!state || !this.phrase) return;
      const lnvps = await this.d.lnvpsAnswers(state, this.phrase).catch(() => null);
      if (lnvps && deps === this.snap.deps) this.set({ lnvps });
    });
  }

  private syncHosting(): Promise<void> {
    return this.oneAtATime('hosting-sync', 'skip', async (deps) => {
      const lnvpsExpires = await this.d.syncHosting().catch(() => null);
      if (deps === this.snap.deps) this.set({ lnvpsExpires });
    });
  }

  /**
   * What the phone keeps, then the fetch and the check; a load asked for while one runs is skipped, as BackupsPanel's
   * was. A later check keeps the last answer until its own: the phone's files alone would drop the server's warnings,
   * and every hop between Settings and its pages checks again.
   */
  private async loadBackups(): Promise<void> {
    this.stopBackupsRecheck();
    await this.oneAtATime('backups', 'skip', async (deps) => {
      const { state } = this.snap;
      if (!state || !this.phrase) return;
      await this.d.backups(state, this.phrase, deps, (patch) => {
        if (deps !== this.snap.deps) return;
        const last = this.snap.backups;
        if (patch.checking && last && !last.checking) return;
        this.set({ backups: { ...(last ?? NO_BACKUPS), ...patch } });
      });
    });
    this.scheduleBackupsRecheck();
  }

  /**
   * A warning or a failed check is asked about again a minute on, while watched and in the foreground, so it clears
   * when its cause does and not at the next visit to a page (a brand-new server's first check met it a moment before
   * its first backup: "can't make backups" then stood for minutes). Not for a phone another phone's restore
   * unpaired: nothing it asks changes that.
   */
  private scheduleBackupsRecheck(): void {
    const b = this.snap.backups;
    if (!this.active || this.watchers === 0 || this.backupsTimer || !b || b.revoked || b.checking) return;
    if (b.warnings.length === 0 && !b.failure) return;
    this.backupsTimer = {
      timer: this.d.setTimeout(() => {
        this.backupsTimer = null;
        this.loadBackups().catch(() => {});
      }, BACKUPS_RECHECK_MS),
    };
  }

  private stopBackupsRecheck(): void {
    if (!this.backupsTimer) return;
    this.d.clearTimeout(this.backupsTimer.timer);
    this.backupsTimer = null;
  }

  /** Set the books either way, then the card list and the wallet; a refusal shows where the list's error does, as CardsPanel's did. */
  private async books(ask: (deps: CardDeps) => Promise<unknown>): Promise<void> {
    const deps = this.snap.deps;
    if (!deps) return;
    try {
      await ask(deps);
    } catch (e) {
      if (deps === this.snap.deps) this.set({ cardsError: `Couldn't set the books: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    await this.reloadCards();
  }

  /**
   * One run of a load per server at a time. Asked for while it runs, it runs
   * once more after it ('again'), or not ('skip'). A new server's load starts
   * beside an old one's, whose answer is dropped.
   */
  private async oneAtATime(name: string, meanwhile: 'again' | 'skip', load: (deps: CardDeps) => Promise<void>): Promise<void> {
    const deps = this.snap.deps;
    if (!deps) return;
    const running = this.runs.get(name);
    if (running?.deps === deps) {
      if (meanwhile === 'again') running.again = true;
      return;
    }
    const run = { deps, again: false };
    this.runs.set(name, run);
    try {
      do {
        run.again = false;
        await load(deps);
      } while (run.again && deps === this.snap.deps);
    } finally {
      if (this.runs.get(name) === run) this.runs.delete(name);
    }
  }

  private patchUpdate(patch: (u: UpdateView) => Partial<UpdateView>): void {
    const u = this.snap.update;
    if (u) this.set({ update: { ...u, ...patch(u) } });
  }

  private async readNfc(): Promise<void> {
    const nfc = await this.d.nfcState().catch(() => null);
    if (nfc) this.set({ nfc });
  }

  /** The unreachable flag after a result: cardd answered, nothing reached it, or neither (null: no change). */
  private flagAfter(answer: boolean | null): boolean {
    if (answer === null || (!answer && this.updating)) return this.snap.unreachable;
    return !answer;
  }

  /**
   * While watched and in the foreground: a read of the wallet the server holds until the books change, begun as
   * soon as there is a rev to ask past; with none, every REFRESH_MS from the end of the last, as it was.
   */
  private startRefresh(): void {
    if (this.refresh || this.watchers === 0 || !this.active) return;
    const loop: { stop(): void; kick(): void } = heldLoop({
      ask: () => this.refreshOnce(() => this.refresh === loop),
      active: () => true,
      clock: this.d,
      startIn: this.snap.wallet?.rev ? 0 : REFRESH_MS,
    });
    this.refresh = loop;
  }

  /** The slow re-read's next look, while it is asked for, the app is in front and no watcher's refresh runs. */
  private scheduleRateCheck(): void {
    if (this.rateTimer || this.keepers === 0 || !this.active || this.watchers > 0) return;
    const t = { timer: null as unknown };
    t.timer = this.d.setTimeout(() => {
      if (this.rateTimer !== t) return;
      this.rateTimer = null;
      this.rateCheck();
      this.scheduleRateCheck();
    }, RATE_CHECK_MS);
    this.rateTimer = t;
  }

  private stopRateCheck(): void {
    if (!this.rateTimer) return;
    this.d.clearTimeout(this.rateTimer.timer);
    this.rateTimer = null;
  }

  /** Reads the wallet when the one held is RATE_STALE_MS old; nothing with no server held. */
  private rateCheck(): void {
    if (!this.snap.deps) return;
    if (this.moneyAt !== null && this.d.now() - this.moneyAt < RATE_STALE_MS) return;
    this.loadMoney().catch(() => {});
  }

  private stopRefresh(): void {
    if (!this.refresh) return;
    this.refresh.stop();
    this.refresh = null;
  }

  /**
   * A key trusted on first use, checked against LNVPS's: the saved state is
   * read again (so a state saved meanwhile isn't overwritten), and a changed
   * one saved. A new server is taken by the next wake, not here.
   */
  private async checkKey(): Promise<void> {
    if (this.keyBusy) return;
    this.keyBusy = true;
    this.stopKeyCheck();
    const forgets = this.forgets;
    try {
      const { phrase, state } = await this.d.loadSaved();
      if (!phrase || state?.step !== 'done' || !state.host || !keyPending(state)) return;
      const next = await this.d.hostKeyCheck(state, phrase).catch(() => state);
      // As Retire VM's: nothing read before a forget is saved after it.
      if (forgets !== this.forgets) return;
      if (next !== state) await this.d.saveState(next);
      const same = next.host!.hostname === this.snap.deps?.host && phrase === this.phrase;
      this.set({ ...(same && { state: next }), keyCheckedAt: this.d.now() });
    } finally {
      this.keyBusy = false;
      this.scheduleKeyCheck();
    }
  }

  /** Counts only in the foreground, from the first watch on (the held state), while its key is pending. */
  private scheduleKeyCheck(): void {
    const s = this.snap.state;
    if (!this.active || this.keyTimer || this.keyBusy || !s || !keyPending(s)) return;
    this.keyTimer = { timer: this.d.setTimeout(() => void this.checkKey(), KEY_CHECK_MS) };
  }

  private stopKeyCheck(): void {
    if (!this.keyTimer) return;
    this.d.clearTimeout(this.keyTimer.timer);
    this.keyTimer = null;
  }

  /** A new snapshot for subscribers, only when something in it changed. */
  private set(patch: Partial<WatchSnapshot>): void {
    if ((Object.keys(patch) as (keyof WatchSnapshot)[]).every((k) => patch[k] === this.snap[k])) return;
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }
}
