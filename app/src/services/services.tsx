// What every screen shares, opened once when the app starts: local storage,
// the recovery phrase, the device key, the server bundle in the APK.
import { hexToBytes } from '@noble/hashes/utils.js';
import * as Device from 'expo-device';
import { Directory, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { router } from 'expo-router';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import CardNative from '../../modules/card-native';
import { alertsSupported, checkOnOpen } from '../alerts/register';
import { isPlayBuild } from '../alerts/store';
import { FILE_WRITES, type BackupFiles } from '../backup/backups';
import { inspectSnapshot, phoneFiles } from '../backup/files';
import { inspectKept } from '../backup/summary';
import { CarddClient } from '../cardd/client';
import { heldFetch, type CardDeps } from '../cards/deps';
import { NfcSlot } from '../cards/nfcSlot';
import { bundleFromManifest, bundleSha, loadBuildInfo, loadManifest, type BuildInfo } from '../deploy/bundle';
import { deriveKeys, type DerivedKeys } from '../keys/derive';
import { withDownloadTimeout, withTimeout, type FetchFn } from '../lightning/lightning';
import { LnvpsClient } from '../lnvps/client';
import { hostingSyncer, syncHosting } from '../money/hosting';
import { MailTmClient } from '../mailtm/client';
import { deviceKey, type DeviceKey } from '../native/deviceKey';
import { deviceName } from '../native/deviceName';
import { nativeNfc, type Nfc } from '../native/nfc';
import { nativePhoneCard, type PhoneCard } from '../native/phoneCard';
import { nativeScanHostKey, nativeSsh } from '../native/ssh';
import type { BundleFile, UploadProgress } from '../onboarding/install';
import { reconcileDevice, type Deps, type OnboardingState } from '../onboarding/machine';
import { settleKeyWatch } from '../onboarding/keyWatchTask';
import { OnboardingRunner, RunnerSlot } from '../onboarding/runner';
import type { KeepDeps } from '../phoneCard/keep';
import { noPhoneCardRecord, phoneCardRecord, type PhoneCardRecordStore } from '../phoneCard/record';
import { phraseStore } from '../store/secrets';
import { STORE_WRITES, type AppStore } from '../store/store';
import { guardFrom, type RouteContext, type Screen as ScreenName } from './startRoute';
import { openOnce, openRetrying, openStore } from './startup';
import { walletEpoch, type WalletEpoch } from './walletEpoch';
import { Body, Button, Screen } from '../ui/ui';
import { newInstallLogLines } from '../onboarding/progress';

export type Services = {
  /** The database, as the screens' own acts use it. Work that can outlast its wallet takes walletStore(sv) instead. */
  store: AppStore;
  /** Which wallet this run works for: ended by forget(), closed while a removal runs (walletEpoch.ts). */
  wallet: WalletEpoch;
  phrase: ReturnType<typeof phraseStore>;
  native: typeof CardNative;
  deviceKey: DeviceKey;
  bundle: BundleFile[];
  bundleSha: string;
  /** The app's own build, for the server page; null if the APK carries none. */
  build: BuildInfo | null;
  /** The one onboarding runner, shared by every onboarding screen. */
  onboarding: RunnerSlot;
  nfc: Nfc;
  /** The one owner of NFC taps: the card screen in front. */
  nfcSlot: NfcSlot;
  /**
   * The phone as a card: the card service; this phone's record of its own
   * card, which an iPhone never has (its secure store is not asked); and whether the pay screen has the phone
   * armed, while which the keeping-in-step job does not run.
   */
  phoneCard: PhoneCard;
  phoneCardRecord: PhoneCardRecordStore;
  phoneCardArmed: { on: boolean };
  /** Every key from the phrase; deriving takes a moment, so it is done once. */
  keys(phrase: string): DerivedKeys;
  /**
   * Lets go of what this run holds for the wallet: its epoch ends, so work still on its way for it writes no
   * more, and the keys worked out from its phrase and the onboarding runner go (the database's connection stays:
   * see startup.ts). For a wallet removed or carried on; the server watch is let go beside it (usePhoneWallet).
   */
  forget(): void;
};

/** Every request the app makes gives up after 30 s (see withTimeout). */
export const fetchFn: FetchFn = withTimeout((url, init) => fetch(url, init), 30_000);
/** For POST /send, which may take cardd's whole 25 s deadline before answering. */
export const slowFetchFn: FetchFn = withTimeout((url, init) => fetch(url, init), 40_000);
/** Snapshot downloads: five minutes for headers and body, unbuffered so the cap streams. */
export const downloadFetchFn: FetchFn = withDownloadTimeout((url, init) => fetch(url, init), 300_000);

/**
 * A new connection to the app's database, for Try again (the start screen's and the Wallet page's, and the
 * connection probe's) when the one the services opened no longer answers (AppStore.reconnect): opened the
 * plain way, expo-sqlite would hand back the dead one it has.
 */
export const reopenAppDb = () => SQLite.openDatabaseAsync('card-app.db', { useNewConnection: true });

async function openServices(): Promise<Services> {
  const store = await openStore(await SQLite.openDatabaseAsync('card-app.db'));
  // An older app's camera and cropper, killed in the middle of a photo, left a full-size crop with the camera's
  // EXIF in these folders; the card camera writes no file, so this only clears what an older app left.
  for (const name of ['ImagePicker', 'ImageManipulator']) {
    try {
      const d = new Directory(Paths.cache, name);
      if (d.exists) d.delete();
    } catch {
      // the next start tries again
    }
  }
  const derived = new Map<string, DerivedKeys>();
  const manifest = await loadManifest(CardNative);
  const nfc = nativeNfc(CardNative);
  const onboarding = new RunnerSlot();
  const wallet = walletEpoch;
  return {
    store,
    wallet,
    // An iPhone's Keychain keeps the phrase when the app is deleted.
    phrase: phraseStore(SecureStore, { outlivesApp: Platform.OS === 'ios' }),
    native: CardNative,
    deviceKey: deviceKey(CardNative),
    bundle: bundleFromManifest(manifest),
    bundleSha: bundleSha(manifest),
    build: await loadBuildInfo(CardNative),
    onboarding,
    nfc,
    nfcSlot: new NfcSlot(nfc),
    phoneCard: nativePhoneCard(CardNative),
    phoneCardRecord: Platform.OS === 'android' ? phoneCardRecord(SecureStore) : noPhoneCardRecord,
    phoneCardArmed: { on: false },
    keys: (phrase) => {
      if (!derived.has(phrase)) derived.set(phrase, deriveKeys(phrase));
      return derived.get(phrase)!;
    },
    forget: () => {
      wallet.end();
      derived.clear();
      onboarding.reset();
    },
  };
}

/**
 * The database and the kept backups for work that can outlast its wallet (a request on its way, a check, the
 * onboarding runner): once the wallet current now is off the phone, their writes do nothing (walletEpoch.ts).
 */
export const walletStore = (sv: Services): AppStore => sv.wallet.bind(sv.store, STORE_WRITES);
export const walletFiles = (sv: Services): BackupFiles => sv.wallet.bind(phoneFiles(), FILE_WRITES);

/** What onboarding's state machine needs, wired to the real world. */
export function onboardingDeps(sv: Services, keys: DerivedKeys, publicKeyHex: string): Omit<Deps, 'checkpoint'> {
  const files = walletFiles(sv);
  const store = walletStore(sv);
  return {
    keys,
    lnvps: new LnvpsClient({ fetch: fetchFn, nostrSecretKey: keys.nostrPrivateKey }),
    mailtm: new MailTmClient({ fetch: fetchFn }),
    fetch: fetchFn,
    ssh: nativeSsh(sv.native),
    scanHostKey: nativeScanHostKey(sv.native),
    bundle: async () => sv.bundle,
    device: { publicKeyHex, name: deviceName(Device.modelName) },
    backups: { ...files, inspect: (name) => inspectKept({ files, identity: keys.backupAgeIdentity, open: inspectSnapshot }, name) },
    serverLatest: () => store.serverLatest(),
    oldCardd: (host) => new CarddClient({ fetch: fetchFn, download: downloadFetchFn, host, key: sv.deviceKey }),
    now: Date.now,
  };
}

/** What the card flows need, for this phrase's server. */
export function cardDeps(sv: Services, state: OnboardingState, phrase: string): CardDeps {
  const host = state.host!.hostname;
  return {
    issuer: hexToBytes(sv.keys(phrase).issuerKey),
    cardd: new CarddClient({ fetch: fetchFn, slowFetch: slowFetchFn, download: downloadFetchFn, host, key: sv.deviceKey }),
    held: new CarddClient({ fetch: heldFetch(fetchFn), host, key: sv.deviceKey }),
    cache: walletStore(sv),
    host,
  };
}

/**
 * What the phone's card's jobs need (keeping it in step, setting it up, removing it), for this wallet's server.
 * The name a forgotten card is registered under again is the one the phone remembers for it, else the phone's own.
 */
export function phoneCardDeps(sv: Services, deps: CardDeps): KeepDeps & { cardd: CardDeps['cardd']; armed(): boolean } {
  return {
    issuer: deps.issuer,
    host: deps.host,
    cardd: deps.cardd,
    record: sv.phoneCardRecord,
    rememberedName: async (id) => (await deps.cache.cards())[id]?.name || undefined,
    phoneName: deviceName(Device.modelName),
    now: Date.now,
    noteRemoved: (removed) => deps.cache.noteRemovedPhoneCard(removed),
    armed: () => sv.phoneCardArmed.on,
  };
}

/**
 * Syncs the VM's expiry from LNVPS to cardd when it is due:
 * on a cold start, back in the foreground 10 minutes after the last sync, for
 * another VM than the last sync's, or forced (after a Renew now, and as
 * onboarding or a rebuild finishes). state: the one to sync for, when the
 * runner has handed it to the screen before saving it (else the saved one).
 * Returns LNVPS's expiry from the last sync that reached it, or null.
 */
export async function syncHostingIfDue(sv: Services, o: { force?: boolean; state?: OnboardingState } = {}): Promise<number | null> {
  const [phrase, state] = await Promise.all([sv.phrase.get(), o.state ?? sv.store.onboarding()]);
  if (!phrase || !state?.host || !state.vmId || state.step !== 'done') return hostingSyncer.lnvpsExpires;
  const vmId = state.vmId;
  const lnvps = new LnvpsClient({ fetch: fetchFn, nostrSecretKey: sv.keys(phrase).nostrPrivateKey });
  const cardd = new CarddClient({ fetch: fetchFn, host: state.host.hostname, key: sv.deviceKey });
  await hostingSyncer.maybe(Date.now(), vmId, () => syncHosting({ lnvps, cardd }, vmId), { force: o.force }).catch(() => null);
  return hostingSyncer.lnvpsExpires;
}

/** A client for alerts' calls to this wallet's server: GET, PUT and DELETE /api/v1/push and its test. */
export const alertsClient = (sv: Services, host: string) => new CarddClient({ fetch: fetchFn, host, key: sv.deviceKey });

/**
 * Alerts' check on each open: once the wallet is set up, and only
 * where alerts were turned on, the server is given the phone's endpoint again if it doesn't have it. Why it couldn't
 * goes to adb logcat, with no endpoint (its path is a secret) and no detail.
 */
export async function checkAlertsOnOpen(sv: Services): Promise<void> {
  const native = sv.native;
  if (!alertsSupported(native)) return;
  const ctx = await routeContext(sv);
  const host = ctx.state?.host?.hostname;
  if (ctx.diagnostics || !ctx.hasPhrase || ctx.state?.step !== 'done' || !host) return;
  const r = await checkOnOpen({ native, cardd: alertsClient(sv, host), store: walletStore(sv), play: isPlayBuild });
  if (typeof r === 'object' && !r.ok) console.log('CARDAPP-ALERTS', JSON.stringify({ check: r.why }));
}

/** Progress for adb logcat during a real run (deploy/README.md); no secrets. Each finished install step's time too. */
// The first state logged is the baseline (an app reopened mid-install doesn't log its saved steps again).
let lastLogged: OnboardingState | undefined;
const logOnboarding = (s: OnboardingState) => {
  console.log('CARDAPP-ONBOARDING', JSON.stringify({ step: s.step, waiting: s.waiting, installed: s.installed.length, vmId: s.vmId, hostKeyTypes: s.hostKeyTypes, error: s.error, drops: s.drops }));
  if (lastLogged) for (const line of newInstallLogLines(lastLogged, s)) console.log(line);
  lastLogged = s;
};

/**
 * The one onboarding runner, running for a screen that shows it (onboarding, and Rebuild
 * server), once `enabled`. begin: where to start from the saved state (a rebuild from a
 * finished setup); a runner an earlier screen left at done is given that state too.
 * upload: the install's upload as it goes (the last figure heard), held here and never saved.
 */
export function useOnboardingRunner(enabled: boolean, begin?: (saved: OnboardingState) => OnboardingState) {
  const sv = useServices();
  const [runner, setRunner] = useState<OnboardingRunner | null>(null);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let off = () => {};
    let offUpload = () => {};
    let sub: { remove(): void } | undefined;
    (async () => {
      const phrase = await sv.phrase.get();
      const saved = await sv.store.onboarding();
      if (!phrase || !saved) return router.replace('/');
      // Before pairing, a missing key is simply made; pairing then registers it.
      const pub = await sv.deviceKey.create();
      const initial = reconcileDevice(saved, pub);
      const deps = onboardingDeps(sv, sv.keys(phrase), pub);
      // Bound to this wallet when the runner is made: a step that ends after the wallet has gone saves nothing.
      const store = walletStore(sv);
      const r = sv.onboarding.get(() => new OnboardingRunner({ initial: begin ? begin(initial) : initial, deps, save: (x) => store.saveOnboarding(x), log: logOnboarding }));
      if (begin && r.state.step === 'done') await r.update(() => begin(initial));
      setRunner(r);
      setState(r.state);
      settleKeyWatch(r.state);
      // An upload's figure is its own attempt's: off the install step, once the step fails, or while it waits to
      // connect again after a drop, it is dropped, so the next try says "Connecting to the server…" and not where
      // the last attempt stopped.
      off = r.subscribe((x) => {
        setState(x);
        settleKeyWatch(x); // the watch over the wait for LNVPS ends once the setup is past it
        if (x.step !== 'install' || x.error || x.waiting === 'reconnect') setUpload(null);
      });
      offUpload = r.subscribeUpload(setUpload);
      // Poll only in the foreground; on return (e.g. from the wallet app) ask again at once,
      // retrying a retryable error such as a network blip.
      sub = AppState.addEventListener('change', (st) => (st === 'active' ? r.resume() : r.pause()));
      r.start();
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Not paused on unmount: another onboarding screen may still show this runner.
    // AppState pauses it in the background.
    return () => {
      off();
      offUpload();
      sub?.remove();
    };
  }, [sv, enabled, begin]);
  return { runner, state, error, upload };
}

const Ctx = createContext<Services | null>(null);

/** Each failed try at opening, for adb logcat; no secrets. */
const logStart = (attempt: number, e: unknown) =>
  console.log('CARDAPP-START', JSON.stringify({ attempt, error: e instanceof Error ? e.message : String(e) }));

/** Once per JS run: a screen Android makes again in the same process mounts with the same services. */
const sharedServices = openOnce(() => openRetrying(openServices, { log: logStart }));

export function ServicesProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Try again, which opens everything afresh.
  const [opening, setOpening] = useState(0);
  useEffect(() => {
    sharedServices().then(setServices, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [opening]);
  if (error)
    return (
      <Screen>
        <Body>The app could not start: {error}</Body>
        <Button title="Try again" onPress={() => { setError(null); setOpening((n) => n + 1); }} />
      </Screen>
    );
  if (!services) return <Screen busy />;
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const sv = useContext(Ctx);
  if (!sv) throw new Error('useServices outside ServicesProvider');
  return sv;
}

export async function routeContext(sv: Services): Promise<RouteContext> {
  const [phrase, state] = await Promise.all([sv.phrase.get(), sv.store.onboarding()]);
  const diag =
    process.env.EXPO_PUBLIC_DIAG_SSH || process.env.EXPO_PUBLIC_DIAG_CARD || process.env.EXPO_PUBLIC_DIAG_BACKUP || process.env.EXPO_PUBLIC_DIAG_RECOVERY ||
    process.env.EXPO_PUBLIC_DIAG_PHOTO || process.env.EXPO_PUBLIC_DIAG_CONNECTION;
  return { diagnostics: !!diag, hasPhrase: !!phrase, state, outlivesApp: sv.phrase.outlivesApp };
}

/**
 * Every screen can be opened by a karto:// deep link. A screen calls this
 * first and renders nothing until it returns true; in any other state the app
 * goes where startRoute says instead, and to the start, which says why, if
 * the phone can't be read.
 */
export function useRouteGuard(screen: ScreenName): boolean {
  const sv = useServices();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    guardFrom(screen, () => routeContext(sv)).then((g) => (g.allowed ? setAllowed(true) : router.replace(g.go)));
  }, [sv, screen]);
  return allowed;
}
