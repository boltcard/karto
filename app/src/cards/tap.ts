// A card held to the phone while no screen claims NFC for its own handling
// (the app's base claim): what it is and, for one
// of the person's, a tap check with cardd. Reading the card and asking cardd
// take time (up to the fetch timeout), and meanwhile the person may open a
// screen that claims the slot (a card flow); the tap is then
// dropped, so nothing opens over it.
import type { SheetCall } from '../native/nfc';
import { TagLostError } from '../ntag424/apdu';
import { describeError, sheetFor } from './labels';
import type { TapCheck } from './check';
import type { Identity } from './identify';

/** What a card held to the phone turned out to be, or why it couldn't be read (lost: the card moved away). */
export type Tap = { identity: Identity; check: TapCheck | null } | { error: string; lost: boolean };

export type TapIo = {
  identify(): Promise<Identity>;
  checkTap(identity: Identity): Promise<TapCheck>;
  /** Whether the base claim still gets the taps (no screen claimed the slot over it meanwhile). */
  held(): boolean;
};

/** The tap to show, or null when no screen wants it any more. */
export async function readTap(io: TapIo): Promise<Tap | null> {
  try {
    const identity = await io.identify();
    if (!io.held()) return null;
    const check = identity.kind === 'ours' ? await io.checkTap(identity) : null;
    return io.held() ? { identity, check } : null;
  } catch (e) {
    return io.held() ? { error: describeError(e).text, lost: e instanceof TagLostError } : null;
  }
}

/**
 * What the Wallet's Read a card tells Apple's sheet, where cards are read in a session.
 * press: the button. card: one arrived and is being read.
 * read: how the read ended, null for a card let go unread or a read no one wants any more.
 */
export type TapEvent = { on: 'press' } | { on: 'card' } | { on: 'read'; tap: Tap | null };

export function tapSheet(e: TapEvent): SheetCall {
  if (e.on === 'press') return { call: 'open', line: 'Hold any card against the top of the back of the phone.' };
  if (e.on === 'card') return { call: 'say', line: 'Reading the card…' };
  if (!e.tap) return { call: 'close' };
  if ('identity' in e.tap) return { call: 'done', line: sheetFor(e.tap.identity).title };
  return e.tap.lost ? { call: 'again', line: 'The card moved away. Hold it against the top of the back of the phone again.' } : { call: 'fail', line: e.tap.error };
}

/**
 * Whether a card held to the phone waits for the open sheet to close: a
 * card's sheet stays until the person closes it, but a read error (which
 * often says to hold the card again) gives way to the next tap.
 */
export const tapWaits = (open: Tap | null): boolean => open !== null && 'identity' in open;

/**
 * Where a card held to the phone goes: one of the person's ready cards (cardd
 * lists it, active or frozen, at this server) opens its account page with the
 * tap check's result; anything else opens the tap sheet, with what fits it.
 * identify() asked cardd itself, so serverDown means what it knows is the
 * phone's cache, and the sheet says so.
 */
export function tapOpens(i: Identity): 'account' | 'sheet' {
  const ready = i.known?.state === 'active' || i.known?.state === 'frozen';
  return i.kind === 'ours' && !!i.id && ready && !i.needsRepoint && !i.serverDown ? 'account' : 'sheet';
}
