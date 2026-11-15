// What every screen of Karto PoS shares: the shop it is paired
// with and the client for it, the phone's key, the NFC slot under its base claim, the ended sales still watched,
// the Paid buzz and chime, and the two things that open over whatever is in front: a watched sale paid after all,
// and the phone removed from the shop. The words and the states are decided in pos/*.ts; this holds state and calls.
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, Vibration } from 'react-native';
import CardNative from '../../modules/card-native';
import { CarddError, isRevoked } from '../cardd/error';
import { NfcSlot } from '../cards/nfcSlot';
import { withTimeout, type FetchFn } from '../lightning/lightning';
import { deviceKey, type DeviceKey } from '../native/deviceKey';
import type { Fiat } from '../money/fiat';
import { nativeNfc, type Nfc } from '../native/nfc';
import { PosClient, type PosSale } from './client';
import { IOS_AUDIO_MODE, refusedBuzz } from './feel';
import { refreshPaired } from './names';
import { claimBase } from './nfc';
import { readsNow, watched, type PaidHow, type Watched } from './sale';
import { PosStore, type Paired } from './settings';
import { useShopClient } from './useShopClient';

/** Calls to the shop's server give up after 10 s: the sale screen asks again each second anyway. */
const shopFetch: FetchFn = withTimeout((url, init) => fetch(url, init), 10_000);
/** Calls to a card's server: chargeCard sets its own limit, and needs the response's own address. */
const cardFetch: FetchFn = (url, init) => fetch(url, init);

/** How often an ended sale is read again. */
const WATCH_MS = 5_000;

// Made once for the app's life: there is one NFC reader and one key.
const nfc = nativeNfc(CardNative);
const slot = new NfcSlot(nfc);
const key = deviceKey(CardNative);
const store = new PosStore(SecureStore);

export type Pos = {
  /** The shop this phone is paired with; null when it isn't; undefined until the phone's store has answered. */
  paired: Paired | null | undefined;
  setPaired(p: Paired | null): void;
  key: DeviceKey;
  store: PosStore;
  slot: NfcSlot;
  /** The reader: its mode, and on an iPhone the session Apple's sheet is (the sale screen's Pay by card). */
  nfc: Nfc;
  /** The card-native module, for the scanner's camera question (askCamera), here so screen tests can stand in for it. */
  native: typeof CardNative;
  fetch: FetchFn;
  cardFetch: FetchFn;
  /** A call on the shop's server. A 401 "unknown or revoked device" opens the removed panel; the error is thrown on either way. */
  ask<T>(call: (c: PosClient) => Promise<T>): Promise<T>;
  /** The shop removed this phone: the panel is over whatever is in front until Pair again. */
  removed: boolean;
  pairAgain(): Promise<void>;
  /** Keeps reading a sale that ended unpaid, or was left open, until 15 seconds past its end. */
  watch(w: Watched): void;
  /** A watched sale was paid after all: the Paid page is over whatever is in front until New sale. */
  paid: { sale: PosSale; how: PaidHow } | null;
  clearPaid(): void;
  /** Paid: one buzz, and the chime unless the sound is off. */
  celebrate(): void;
  /** A card's server refused: two short buzzes. */
  buzzRefused(): void;
  sound: boolean;
  setSound(on: boolean): void;
  /** The sale the till just made, for the sale screen. */
  sale: PosSale | null;
  setSale(s: PosSale | null): void;
  /**
   * The shop's currency and its rate, as GET /api/v1/pos/fiat last answered (null until it has, and for a new shop):
   * the till types in it. Read by readFiat, which the till calls as it shows and every 5 minutes while in front;
   * never on the way to a sale.
   */
  fiat: Fiat | null;
  readFiat(): Promise<void>;
  /** Reads who this phone is and whose (GET /api/v1/pos/me), keeping a renamed till or wallet; called with readFiat. */
  readMe(): Promise<void>;
  /**
   * The pairing code the scanner just read, for the Pair screen: handed over here, in memory, and never as a
   * route's parameters, which a link from outside the app fills just as well. Pair takes it once.
   */
  scanned: { current: { host: string; code: string } | null };
};

const Ctx = createContext<Pos | null>(null);

export function usePos(): Pos {
  const pos = useContext(Ctx);
  if (!pos) throw new Error('usePos outside PosProvider');
  return pos;
}

export function PosProvider({ children }: { children: ReactNode }) {
  const [paired, setPairedState] = useState<Paired | null | undefined>(undefined);
  // The pairing now, for an answer that lands after a render (readMe).
  const pairedRef = useRef(paired);
  pairedRef.current = paired;
  const [removed, setRemoved] = useState(false);
  const [paid, setPaid] = useState<Pos['paid']>(null);
  const [sound, setSoundState] = useState(true);
  const [sale, setSale] = useState<PosSale | null>(null);
  const [fiat, setFiat] = useState<Fiat | null>(null);
  const list = useRef<Watched[]>([]);
  const scanned = useRef<{ host: string; code: string } | null>(null);
  const soundOn = useRef(true);
  const chime = useAudioPlayer(require('../../assets/pos/paid.wav'));

  useEffect(() => {
    store.paired().then(setPairedState, () => setPairedState(null));
    store.sound().then((on) => {
      soundOn.current = on;
      setSoundState(on);
    }, () => undefined);
  }, []);

  // The base claim, for the app's life: every tap on a screen that doesn't read cards is closed unread.
  useEffect(() => claimBase(slot), []);

  // On an iPhone the Paid chime plays with the silent switch on, alongside other apps' audio (pos/feel.ts).
  useEffect(() => {
    if (Platform.OS === 'ios') setAudioModeAsync(IOS_AUDIO_MODE).catch(() => undefined);
  }, []);

  // Made once per server: a pairing renamed by a read of /pos/me keeps it.
  const host = paired?.host;
  const client = useShopClient(host, (h) => new PosClient({ fetch: shopFetch, host: h, key }));
  // Another shop (or none) has its own currency: the last one's isn't kept.
  useEffect(() => setFiat(null), [client]);
  // A failure keeps what the till had: an old rate is still used, with its age shown.
  const readFiat = useCallback(async () => {
    if (!client) return;
    try {
      setFiat(await client.fiat());
    } catch (e) {
      if (isRevoked(e)) setRemoved(true);
    }
  }, [client]);
  // Who this phone is, and whose: read with the currency; a change is kept. A failure keeps what it had.
  const readMe = useCallback(async () => {
    if (!client) return;
    try {
      const me = await client.me();
      const now = pairedRef.current;
      const next = now && now.host === host ? refreshPaired(now, me) : null;
      if (!next) return;
      setPairedState(next);
      await store.savePaired(next).catch(() => undefined);
    } catch (e) {
      if (isRevoked(e)) setRemoved(true);
    }
  }, [client, host]);

  const ask = useCallback(
    async <T,>(call: (c: PosClient) => Promise<T>): Promise<T> => {
      if (!client) throw new CarddError(0, 'not_paired', 'This phone is not paired with a shop.');
      try {
        return await call(client);
      } catch (e) {
        if (isRevoked(e)) setRemoved(true);
        throw e;
      }
    },
    [client],
  );

  const celebrate = useCallback(() => {
    Vibration.vibrate(200);
    if (!soundOn.current) return;
    // No sound is no reason to lose the Paid page.
    chime.seekTo(0).then(() => chime.play(), () => undefined);
  }, [chime]);

  // The ended sales still watched: each is read every 5 seconds, whatever screen is in front, until 15 seconds
  // past its end, so a second sale isn't made for a customer who has paid the first after all.
  useEffect(() => {
    if (!client || !host) return;
    // A watched sale of any other shop is dropped before the reads: a sale's id is never asked of another server.
    const timer = setInterval(() => {
      // Under Apple's sheet the app may be 'inactive', and a watched sale's payment must still show.
      if (!readsNow(AppState.currentState, (nfc.session?.state() ?? 'none') !== 'none')) return;
      list.current = watched(list.current, { kind: 'tick', nowS: Date.now() / 1000, host }).list;
      for (const w of list.current) {
        client.sale(w.id).then(
          (s) => {
            const out = watched(list.current, { kind: 'read', sale: s });
            list.current = out.list;
            if (out.paid) {
              setPaid(out.paid);
              celebrate();
            }
          },
          (e) => {
            if (isRevoked(e)) setRemoved(true);
            else if (e instanceof CarddError && e.status === 404) list.current = watched(list.current, { kind: 'gone', id: w.id }).list;
          },
        );
      }
    }, WATCH_MS);
    return () => clearInterval(timer);
  }, [client, host, celebrate]);

  const pos = useMemo<Pos>(
    () => ({
      paired,
      setPaired: (p) => {
        if (!p) list.current = watched(list.current, { kind: 'clear' }).list;
        setRemoved(false);
        setPairedState(p);
      },
      key, store, slot, nfc, native: CardNative, fetch: shopFetch, cardFetch,
      ask,
      removed,
      pairAgain: async () => {
        list.current = watched(list.current, { kind: 'clear' }).list;
        await store.forget().catch(() => undefined);
        setSale(null);
        setPaid(null);
        setRemoved(false);
        setPairedState(null);
      },
      watch: (w) => void (list.current = watched(list.current, { kind: 'add', sale: w }).list),
      paid,
      clearPaid: () => setPaid(null),
      celebrate,
      buzzRefused: () => Vibration.vibrate(refusedBuzz(Platform.OS === 'ios')),
      sound,
      setSound: (on) => {
        soundOn.current = on;
        setSoundState(on);
        void store.setSound(on).catch(() => undefined);
      },
      sale,
      setSale,
      fiat,
      readFiat,
      readMe,
      scanned,
    }),
    [paired, ask, removed, paid, celebrate, sound, sale, fiat, readFiat, readMe],
  );
  return <Ctx.Provider value={pos}>{children}</Ctx.Provider>;
}
