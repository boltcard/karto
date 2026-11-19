// The one ServerWatch, for the app's life, and
// what a card held to the phone opens. The wallet and Settings call
// useWatcher(): while one of them is in front the watch runs its checks and
// refresh. The provider holds the NFC slot's base claim for the app's life:
// a card held to the phone on any screen that doesn't claim the slot itself
// opens its account page (one of the person's ready cards) or the tap sheet,
// so no tap reaches Android's own handling. Nothing runs before onboarding is
// done. useCardDeps() gives every screen the watch's cardd client once it
// holds one.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect, useGlobalSearchParams, usePathname } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { openSnapshot, removeKeptBackups } from '../backup/files';
import { loadBackups } from '../backup/panel';
import { registerBackupTask, unregisterBackupTask } from '../backup/task';
import { CarddClient } from '../cardd/client';
import { serverStatus } from '../cardd/status';
import { checkTap, type TapCheck } from '../cards/check';
import type { CardDeps } from '../cards/deps';
import { identify, NO_CARD } from '../cards/identify';
import { readTap, tapOpens, tapSheet, tapWaits, type Tap, type TapEvent } from '../cards/tap';
import { getVmOrNull, LnvpsClient } from '../lnvps/client';
import { availableMsat } from '../money/format';
import type { Tag } from '../native/nfc';
import { nativeSsh } from '../native/ssh';
import { Ntag424 } from '../ntag424/card';
import { oldVmsToWatch, retireOldServer, verifyHostKey } from '../onboarding/machine';
import { carryOn } from '../onboarding/phrase';
import { removeWallet } from '../onboarding/removeWallet';
import { SshDropped } from '../onboarding/ssh';
import { updateServer } from '../onboarding/update';
import { AmountViewProvider } from '../ui/amountViewProvider';
import { TapSheet } from '../ui/TapSheet';
import { Button, ErrorText, Sheet } from '../ui/ui';
import { colourOf } from '../wallet/colours';
import { ServerWatch, type LnvpsAnswer, type WatchDeps, type WatchSnapshot } from './serverWatch';
import { phoneCardKeeper } from '../phoneCard/keep';
import { cardDeps, fetchFn, phoneCardDeps, syncHostingIfDue, useServices, walletFiles, walletStore, type Services } from './services';

/** Update server keeps the phone awake under this tag: the upload can take minutes on a weak network. */
const KEEP_AWAKE = 'update-server';

/**
 * Out of the foreground: 'background', and iOS's 'inactive' (the app
 * switcher, a call), where the server page's refresh skipped its ticks too.
 * Anything else ('active', or a state RN can't say) leaves the watch running.
 */
const inBackground = (st: AppStateStatus | null | undefined) => st === 'background' || st === 'inactive';

/**
 * The watch's world: the app's services, its clients and the phone. What it writes goes through the wallet's
 * epoch, taken as each piece of work starts: work begun for a wallet since taken off the phone, or begun while
 * one is being taken off, writes nothing (walletEpoch.ts).
 */
function watchDeps(sv: Services): WatchDeps {
  const lnvps = (phrase: string) => new LnvpsClient({ fetch: fetchFn, nostrSecretKey: sv.keys(phrase).nostrPrivateKey });
  // One keeper to a server's clients: it lets one run through at a time.
  const keepers = new WeakMap<CardDeps, ReturnType<typeof phoneCardKeeper>>();
  const keeper = (deps: CardDeps) => keepers.get(deps) ?? keepers.set(deps, phoneCardKeeper(phoneCardDeps(sv, deps))).get(deps)!;
  return {
    phoneCard: {
      supported: () => sv.phoneCard.supported(),
      record: async () => {
        const read = await sv.phoneCardRecord.read();
        return read.ok && read.record ? { n: read.record.n, removing: !!read.record.removing } : null;
      },
      keep: (deps, cards) => keeper(deps)(cards),
    },
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    loadSaved: async () => {
      const [phrase, state] = await Promise.all([sv.phrase.get(), sv.store.onboarding()]);
      return { phrase, state };
    },
    makeDeps: (state, phrase) => cardDeps(sv, state, phrase),
    serverStatus: (deps) => serverStatus(new CarddClient({ fetch: fetchFn, host: deps.host, key: sv.deviceKey }), sv.bundleSha),
    noteCarddAnswered: (answered, nowMs) => walletStore(sv).noteCarddAnswered(answered, nowMs),
    nfcState: () => sv.nfc.state(),
    hostKeyCheck: (state, phrase) => verifyHostKey(state, lnvps(phrase)),
    saveState: (state) => walletStore(sv).saveOnboarding(state),
    lnvpsAnswers: async (state, phrase) => {
      if (state.vmId === undefined) return null;
      const client = lnvps(phrase);
      const ask = (id: number): Promise<LnvpsAnswer> => getVmOrNull(client, id).catch(() => 'unreachable' as const);
      const [vm, ...old] = await Promise.all([ask(state.vmId), ...oldVmsToWatch(state).map(ask)]);
      return { vm, old, lnvpsNowMs: client.serverTime(), unreachableSince: await sv.store.carddUnreachableSince() };
    },
    syncHosting: () => syncHostingIfDue(sv),
    backups: (state, phrase, deps, show) => {
      // The background job too: a check that ends after its wallet has gone does not register it again.
      const live = sv.wallet.live();
      return loadBackups(
        {
          store: walletStore(sv),
          files: walletFiles(sv),
          openDb: openSnapshot,
          registerTask: async () => void (live() && (await registerBackupTask())),
          unregisterTask: unregisterBackupTask,
          now: Date.now,
        },
        { state, keys: sv.keys(phrase), cardd: deps.cardd },
        show,
      );
    },
    runUpdate: (state, phrase, done, onStep, onUpload, onStart) =>
      updateServer(state, { ssh: nativeSsh(sv.native), keys: sv.keys(phrase), bundle: sv.bundle }, onStep, onUpload, done, onStart).catch((e: unknown) => {
        // For adb logcat during a real run: how a run of the update ended, and whether it was a drop; no secrets.
        const error = e instanceof Error ? e.message : String(e);
        console.log('CARDAPP-UPDATE', JSON.stringify({ done: done.length, dropped: e instanceof SshDropped ? e.during : undefined, error }));
        throw e;
      }),
    log: (line) => console.log(line),
    keepAwake: (on) => void (on ? activateKeepAwakeAsync(KEEP_AWAKE) : deactivateKeepAwake(KEEP_AWAKE)).catch(() => {}),
    retireOld: (state, phrase, vmId) =>
      retireOldServer(
        state,
        { ssh: nativeSsh(sv.native), keys: sv.keys(phrase), lnvps: lnvps(phrase), fetch: fetchFn, now: Date.now, bundle: async () => sv.bundle },
        vmId,
      ),
  };
}

/** The tap check of a card held to the phone that opened its account page, until the person leaves that page. */
type Checked = { id: string; check: TapCheck };
/** The Wallet's Read a card, where cards are read in a session (an iPhone): whether it can be pressed now, and the press. */
export type ReadCard = { on: boolean; press(): void };
type Server = { snap: WatchSnapshot; watch: ServerWatch; checked: Checked | null; leftPage(id: string): void; read: ReadCard | null };

const Ctx = createContext<Server | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const sv = useServices();
  const [watch] = useState(() => new ServerWatch(watchDeps(sv)));
  const [snap, setSnap] = useState(() => watch.snapshot());
  const [tap, setTap] = useState<Tap | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const tapBusy = useRef(false);
  // Apple's sheet for Read a card, where cards are read in a session;
  // null on Android, where the base claim reads any card held to the phone.
  const session = sv.nfc.session;
  const [sheet, setSheet] = useState(() => session?.state() ?? null);
  // Every session's end is heard here, the hold screen's too, so the Wallet's button knows when one is still going.
  useEffect(() => {
    if (!session) return;
    const stop = session.onEnd(() => setSheet(session.state()));
    setSheet(session.state());
    return stop;
  }, [session]);
  /** Tells the sheet how a read is going. A press while a sheet is up or still going asks for nothing. */
  const tell = (e: TapEvent) => {
    if (!session) return;
    const c = tapSheet(e);
    if (c.call === 'close') session.close();
    else if (c.call !== 'open') session[c.call](c.line);
    else if (session.state() === 'none') {
      session.open(c.line).catch((err) => {
        setSheet(session.state());
        setTap({ error: err instanceof Error ? err.message : String(err), lost: false });
      });
    }
    setSheet(session.state());
  };
  const telling = useRef(tell);
  telling.current = tell;
  // The screen in front, read when a tap opens a card's account page: one already in front isn't pushed again.
  const pathname = usePathname();
  const { id: frontId } = useGlobalSearchParams<{ id?: string }>();
  const front = useRef({ pathname, frontId });
  front.current = { pathname, frontId };

  useEffect(() => {
    setSnap(watch.snapshot());
    return watch.subscribe(setSnap);
  }, [watch]);

  // The wallet's rate kept fresh on every screen, not only where a watcher runs.
  useEffect(() => watch.keepRate(), [watch]);

  useEffect(() => {
    if (inBackground(AppState.currentState)) watch.background();
    else watch.foreground(); // also after a StrictMode cleanup's background()
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') watch.foreground();
      else if (inBackground(st)) watch.background();
    });
    return () => {
      sub.remove();
      watch.background();
    };
  }, [watch]);

  // A card held to the phone: what it is (and, for one of the person's, a tap check with cardd). Before
  // onboarding is done (no clients yet) it is closed unread.
  const onTag = async (tag: Tag) => {
    const deps = watch.snapshot().deps;
    if (tapBusy.current || !deps || tapWaits(tap)) {
      tell({ on: 'read', tap: null });
      return void tag.close();
    }
    if (!tag.transceive) {
      // A tag the phone can't talk ISO-DEP to has no Bolt Card's link to give.
      const none: Tap = { identity: NO_CARD, check: null };
      setTap(none);
      tell({ on: 'read', tap: none });
      return;
    }
    const card = new Ntag424(tag.transceive);
    tapBusy.current = true;
    tell({ on: 'card' });
    try {
      const read = await readTap({
        identify: () => identify(card, deps),
        checkTap: (identity) => checkTap(identity, deps, card),
        held: () => !sv.nfcSlot.screenClaimed(),
      });
      tell({ on: 'read', tap: read });
      if (read && 'identity' in read && read.check && read.identity.id && tapOpens(read.identity) === 'account') openAccount(read.identity.id, read.check);
      // An error in a session was said by Apple's sheet, which stays up for a card that moved away: no sheet of ours for it.
      else if (read && !('error' in read && session)) setTap(read);
    } finally {
      tapBusy.current = false;
      await tag.close();
    }
  };
  // One of the person's ready cards: its account page shows the check; the page in front isn't pushed again.
  const openAccount = (id: string, check: TapCheck) => {
    setTap(null); // a read error's sheet, left open, gives way
    setChecked({ id, check });
    watch.reloadCards().catch(() => {}); // the tap check moved the counter on
    const { pathname, frontId } = front.current;
    if (pathname !== '/account' || frontId !== id) router.push({ pathname: '/account', params: { id } });
  };
  const tagHandler = useRef(onTag);
  tagHandler.current = onTag;
  // The base claim, for the provider's life: the card flows claim over it while in front.
  useEffect(() => sv.nfcSlot.claimBase((t) => void tagHandler.current(t)), [sv]);
  const leftPage = useCallback((id: string) => setChecked((c) => (c?.id === id ? null : c)), []);

  const close = () => {
    setTap(null);
    watch.reloadCards().catch(() => {}); // a tap check moved the counter on
  };
  // The session's own state too: one the hold screen opened is not this provider's to have seen begin.
  const canRead = sheet === 'none' && session?.state() === 'none' && !!snap.deps;
  const read = useMemo<ReadCard | null>(() => (session ? { on: canRead, press: () => telling.current({ on: 'press' }) } : null), [session, canRead]);
  const server = useMemo(() => ({ snap, watch, checked, leftPage, read }), [snap, watch, checked, leftPage, read]);
  const card = tap && 'identity' in tap && tap.identity.id ? snap.wallet?.cards.find((c) => c.id === tap.identity.id) : undefined;

  return (
    <Ctx.Provider value={server}>
      {/* The view's provider reads the wallet from this context, and covers the tap sheet drawn beside the screens. */}
      <AmountViewProvider>
        {children}
        {tap && 'identity' in tap && (
          <TapSheet
            identity={tap.identity}
            check={tap.check}
            colour={colourOf(snap.cards ?? [], tap.identity.id ?? '')}
            balanceMsat={card && availableMsat(card)}
            card={card}
            photo={tap.identity.id ? snap.photos[tap.identity.id] : undefined}
            onClose={close}
          />
        )}
        {tap && 'error' in tap && (
          <Sheet visible solid onClose={close}>
            <ErrorText>{tap.error}</ErrorText>
            <Button title="Close" kind="secondary" onPress={close} />
          </Sheet>
        )}
      </AmountViewProvider>
    </Ctx.Provider>
  );
}

function useServerContext(): Server {
  const server = useContext(Ctx);
  if (!server) throw new Error('useServer outside ServerProvider');
  return server;
}

/** What the watch holds now, and its actions. */
export function useServer(): { snap: WatchSnapshot; watch: ServerWatch } {
  const { snap, watch } = useServerContext();
  return { snap, watch };
}

/**
 * A wallet whose phrase outlives the app (an iPhone): carrying it on,
 * which is also pairing the phone again, and taking it off the phone. Both let go of what this run holds for it,
 * the watch's server with the rest; the caller asks for the lock first, and goes to the start after. While either
 * runs, nothing given the store can write (walletEpoch.ts): what wakes between its steps writes nothing.
 */
export function usePhoneWallet(): { carryOn(): Promise<void>; remove(): Promise<void> } {
  const sv = useServices();
  const { watch } = useServerContext();
  return useMemo(() => {
    const forget = () => {
      sv.forget();
      watch.forget();
    };
    // Neither lets anything given the store between its steps write. The lock's prompt puts the app in the
    // background and back, which wakes the watch: it can read the state not yet replaced and make clients for it.
    // They never write, so afterwards the watch lets go once more and makes its clients again, for whatever the
    // phone holds now (after a removal that stopped, maybe the same wallet).
    return {
      // The wallet ends when carryOn lets go, after the new key is made: a failure before that leaves the page
      // and its wallet as they were. Without the hold, a backups check made between the forget and the save
      // would ask the server with the new, unpaired key and mark the wallet restored by another phone, for good.
      carryOn: () => {
        let letGo = false;
        const act = () => carryOn({ deviceKey: sv.deviceKey, store: sv.store, forget: () => ((letGo = true), forget()) });
        return sv.wallet.whileHeld(act, () => letGo && watch.forget());
      },
      remove: () =>
        sv.wallet.whileClosed(
          () =>
            removeWallet({
              job: { unregister: unregisterBackupTask },
              store: sv.store,
              backups: { removeAll: removeKeptBackups },
              deviceKey: sv.deviceKey,
              phrase: sv.phrase,
              forget,
            }),
          () => watch.forget(),
        ),
    };
  }, [sv, watch]);
}

/**
 * cardDeps for a screen: the watch's own clients when it holds them (the
 * wallet or Settings woke it), so every screen talks to cardd through one
 * client; else (a screen a link opened first, or the watch forgot the old
 * server after a rebuild and hasn't read the new one yet) its own from the
 * saved state, as before. Null until the phrase and the server are loaded.
 * Taken once, at the screen's start: a flow never changes clients part-way.
 */
export function useCardDeps(): CardDeps | null {
  const sv = useServices();
  const { watch } = useServerContext();
  const [deps, setDeps] = useState(() => watch.snapshot().deps);
  useEffect(() => {
    if (deps) return;
    Promise.all([sv.phrase.get(), sv.store.onboarding()]).then(([phrase, state]) => {
      if (phrase && state?.host) setDeps(cardDeps(sv, state, phrase));
    });
  }, [sv, deps]);
  return deps;
}

/**
 * For the wallet and Settings, once their route guard allows them: while the
 * screen is in front the watch runs (its checks, the 5-second refresh); it
 * stops when the last of them leaves the front.
 */
export function useWatcher(allowed: boolean): { snap: WatchSnapshot; watch: ServerWatch } {
  const { snap, watch } = useServerContext();
  useFocusEffect(useCallback(() => (allowed ? watch.watch() : undefined), [allowed, watch]));
  return { snap, watch };
}

/**
 * For a card's account page: the tap check of the card held to the phone that
 * opened it (or was held while it was in front), until the person leaves the page.
 */
/** The Wallet's Read a card: null where cards are read all the time, and the Wallet keeps its line. */
export function useReadCard(): ReadCard | null {
  return useServerContext().read;
}

export function useTapCheck(id: string): TapCheck | null {
  const { checked, leftPage } = useServerContext();
  useFocusEffect(useCallback(() => () => leftPage(id), [id, leftPage]));
  return checked?.id === id ? checked.check : null;
}
