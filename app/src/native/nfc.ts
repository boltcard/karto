// NFC from the card-native module (CardNativeModule.kt, NfcTags.kt), as the
// card screens use it: reader mode on and off, and each tapped tag as a
// Transceive the NTAG 424 code (src/ntag424) can talk through. On an iPhone
// cards are read only inside a session the app asks for, under Apple's own
// sheet: the module
// then names its mode and offers the session's calls.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { nativeWords } from './words';
import { TagLostError, type Transceive } from '../ntag424/apdu';

export type NfcState = 'unsupported' | 'off' | 'on';
/** A tag came into the field: its handle (-1 if Android can't talk ISO-DEP to it) and the id it showed. */
export type NfcTagEvent = { handle: number; uid: string };
/** A session ended, as iOS reports it: its own code and words, nothing worked out. */
export type NfcEndEvent = { code: number; text: string };
/** 'always': reader mode (Android). 'session': cards are read only inside a session (iPhone). */
export type NfcMode = 'always' | 'session';

export type CardNfcApi = {
  nfcState(): Promise<NfcState>;
  /** Not offered by the iPhone's module: iOS has no NFC switch to send the person to. */
  nfcSettings?(): Promise<void>;
  nfcStart(): Promise<void>;
  nfcStop(): Promise<void>;
  /** Android's module only: reader mode without (true) or with Android's tag sound, now and each time it is turned on. */
  nfcQuiet?(quiet: boolean): Promise<void>;
  /** Rejects with code ERR_TAG_LOST once the card has left the field. */
  nfcTransceive(handle: number, apduHex: string): Promise<string>;
  /** In a session it lets go of the card's handle only: the session stays open. */
  nfcClose(handle: number): Promise<void>;
  addListener(event: 'nfcTag', listener: (e: NfcTagEvent) => void): { remove(): void };
  addListener(event: 'nfcEnd', listener: (e: NfcEndEvent) => void): { remove(): void };
  /** The iPhone's module only: missing where cards are read all the time. */
  nfcMode?: 'session';
  /** Opens Apple's sheet with the line. Answers once iOS says the session is active; fails with iOS's words if iOS ends it before that. */
  nfcScan?(line: string): Promise<void>;
  nfcSay?(line: string): Promise<void>;
  /** Lets go of the card in hand and looks again; the sheet stays. */
  nfcAgain?(line: string): Promise<void>;
  /** Ends the session with Apple's tick and the line. */
  nfcDone?(line: string): Promise<void>;
  /** Ends the session with the line as its error. */
  nfcFail?(line: string): Promise<void>;
};

/** A tapped tag. transceive is null when Android can't talk ISO-DEP to it (it isn't a card this app can use). */
export type Tag = { uid: Uint8Array; transceive: Transceive | null; close(): Promise<void> };

/** Why a session ended. done, failed, closed: the app's own call. cancelled: the person's Cancel. timeout: Apple's 60 seconds. interrupted: iOS ended it (the app left the front). error: anything else, in iOS's words. */
export type SessionEnd = { why: 'done' | 'failed' | 'closed' | 'cancelled' | 'timeout' | 'interrupted' } | { why: 'error'; error: string };

/** One session at a time, for the whole app. Calls other than open do nothing unless it is open. */
export type NfcSession = {
  /** Rejects at once unless the state is 'none'; rejects with iOS's words if iOS ends the session before it is active (that session reports no end). */
  open(line: string): Promise<void>;
  say(line: string): void;
  again(line: string): void;
  done(line: string): void;
  fail(line: string): void;
  /** The screen was left: ends as fail('Card reading stopped.') does. */
  close(): void;
  /** Each end, once, when iOS reports it (the sheet has gone). Returns what stops the listening. */
  onEnd(fn: (e: SessionEnd) => void): () => void;
  /** open: from the call of open. ending: an end was asked for, or iOS ended it, and the end is not yet reported. */
  state(): 'none' | 'open' | 'ending';
};

/** What a screen tells Apple's sheet: one of the session's calls, with its line. */
export type SheetCall = { call: 'open' | 'say' | 'again' | 'done' | 'fail'; line: string } | { call: 'close' };

export type Nfc = {
  mode: NfcMode;
  /** null where cards are read all the time. */
  session: NfcSession | null;
  state(): Promise<NfcState>;
  openSettings(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Android's tag sound off (true) or on for each card found; nothing where the platform has no such sound to turn off. */
  quiet?(on: boolean): void;
  onTag(fn: (tag: Tag) => void): { remove(): void };
};

export function nativeNfc(native: CardNfcApi): Nfc {
  const sessions = native.nfcMode === 'session';
  // The cards in hand: a card found before the session ended, or before it was told to look again, has gone.
  const hands = { n: 0 };
  return {
    mode: sessions ? 'session' : 'always',
    session: sessions ? nativeSession(native, hands) : null,
    state: () => native.nfcState(),
    openSettings: async () => void (await native.nfcSettings?.()),
    start: () => native.nfcStart(),
    stop: () => native.nfcStop(),
    quiet: (on) => void native.nfcQuiet?.(on).catch(() => {}),
    onTag: (fn) => native.addListener('nfcTag', (e) => fn(toTag(native, e, hands))),
  };
}

// iOS's codes for a session's end (NFCReaderError): the person's Cancel and the app's own ending are both the first.
const IOS_CANCELLED = 200;
const IOS_TIMEOUT = 201;
const IOS_INTERRUPTED = 202;

function nativeSession(native: CardNfcApi, hands: { n: number }): NfcSession {
  let state: 'none' | 'open' | 'ending' = 'none';
  /** The end the app asked for: iOS cannot say which it was. */
  let asked: 'done' | 'failed' | 'closed' | null = null;
  /** iOS has said this session is up. One it ends before that fails the open and reports no end. */
  let active = false;
  /** The session's number: an answer about an earlier one is dropped. */
  let number = 0;
  const listeners = new Set<(e: SessionEnd) => void>();
  const now = () => state;
  const ended = (e: SessionEnd) => {
    state = 'none';
    asked = null;
    active = false;
    hands.n++;
    [...listeners].forEach((fn) => fn(e));
  };
  native.addListener('nfcEnd', (e) => {
    if (state === 'none' || (!active && !asked)) return;
    if (asked) return ended({ why: asked });
    if (e.code === IOS_CANCELLED) return ended({ why: 'cancelled' });
    if (e.code === IOS_TIMEOUT) return ended({ why: 'timeout' });
    if (e.code === IOS_INTERRUPTED) return ended({ why: 'interrupted' });
    ended({ why: 'error', error: e.text });
  });
  const end = (why: 'done' | 'failed' | 'closed', call: Promise<void> | undefined) => {
    asked = why;
    state = 'ending';
    hands.n++;
    call?.catch(() => {});
  };
  return {
    async open(line) {
      if (state !== 'none') throw new Error('A card is already being read.');
      const mine = ++number;
      state = 'open';
      try {
        await native.nfcScan!(line);
        if (number === mine && now() !== 'none') active = true;
      } catch (e) {
        if (number !== mine || now() === 'none') return; // its end was reported meanwhile
        if (asked) return ended({ why: asked }); // the screen ended it before it was up
        state = 'none';
        // iOS's words go on the screen: its own, not what Expo puts around them.
        throw new Error(nativeWords(e));
      }
    },
    say(line) {
      if (state === 'open') native.nfcSay!(line).catch(() => {});
    },
    again(line) {
      if (state !== 'open') return;
      hands.n++;
      native.nfcAgain!(line).catch(() => {});
    },
    done(line) {
      if (state === 'open') end('done', native.nfcDone!(line));
    },
    fail(line) {
      if (state === 'open') end('failed', native.nfcFail!(line));
    },
    close() {
      if (state === 'open') end('closed', native.nfcFail!('Card reading stopped.'));
    },
    onEnd(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    state: now,
  };
}

function toTag(native: CardNfcApi, e: NfcTagEvent, hands: { n: number }): Tag {
  const uid = hexToBytes(e.uid);
  if (e.handle < 0) return { uid, transceive: null, close: async () => {} };
  const hand = hands.n;
  return {
    uid,
    transceive: async (apdu) => {
      if (hands.n !== hand) throw new TagLostError();
      try {
        return hexToBytes(await native.nfcTransceive(e.handle, bytesToHex(apdu)));
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_TAG_LOST') throw new TagLostError();
        throw err;
      }
    },
    close: () => native.nfcClose(e.handle).catch(() => {}),
  };
}
