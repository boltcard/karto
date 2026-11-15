// Apple's sheet at the till, on an iPhone: an iPhone reads a
// card only inside a session under Apple's sheet, so the sale screen shows its code first and opens the sheet when
// Pay by card is pressed. These say what the sheet is told and when the button is there; the screen holds the session.
import type { NfcSession, SheetCall } from '../native/nfc';
import type { SaleEvent, SaleState } from './sale';

const TOP = 'against the top of the back of the phone';

/**
 * What happened, for the sheet. press: Pay by card, with the amount as the sale shows it. card: one arrived and is
 * being read. read: how readTap ended. ended: the sale or the screen ended while the sheet may be up.
 */
export type SaleSheetEvent =
  | { on: 'press'; amount: string }
  | { on: 'card' }
  | { on: 'read'; tap: 'link' | 'not-a-card' | 'moved-away' }
  | { on: 'ended'; to: 'paid' | 'ran-out' | 'cancelled-on-shop' | 'cancel' | 'leave' };

/**
 * The sheet's call for an event. A card's link read ends it with the tick: reading needs the card, charging does
 * not. Only Paid gets the tick among the ends; a sale that did not happen gets Apple's red cross.
 */
export function saleSheet(e: SaleSheetEvent): SheetCall {
  switch (e.on) {
    case 'press':
      return { call: 'open', line: `Hold the card ${TOP}. ${e.amount}` };
    case 'card':
      return { call: 'say', line: 'Reading the card…' };
    case 'read':
      if (e.tap === 'link') return { call: 'done', line: 'Card read. You can take it away.' };
      if (e.tap === 'not-a-card') return { call: 'again', line: `That isn't a Bolt Card. Hold a Bolt Card ${TOP}.` };
      return { call: 'again', line: `The card moved away. Hold it ${TOP} again.` };
    case 'ended':
      if (e.to === 'paid') return { call: 'done', line: 'Paid' };
      if (e.to === 'ran-out') return { call: 'fail', line: 'The sale ran out.' };
      if (e.to === 'cancelled-on-shop') return { call: 'fail', line: 'The sale was cancelled.' };
      if (e.to === 'cancel') return { call: 'fail', line: 'Sale cancelled.' };
      return { call: 'close' };
  }
}

/**
 * Pay by card: there only while the sale waits, and only where cards are read in a session (session null: Android,
 * which shows its hold row instead). Off while a sheet is up or on its way out: iOS refuses a second session then.
 */
export function cardButton(s: SaleState, session: ReturnType<NfcSession['state']> | null): { on: boolean } | null {
  if (session === null || s.at !== 'waiting') return null;
  return { on: session === 'none' };
}

/**
 * The end to tell a sheet that may be up, as saleStep moves the screen from st to next for e; null when the move
 * ends nothing. A call on a sheet that isn't open does nothing (native/nfc.ts), so it is safe to tell it always.
 */
export function saleSheetEnd(st: SaleState, next: SaleState, e: SaleEvent): SaleSheetEvent | null {
  if (next.at === 'paid' && st.at !== 'paid') return { on: 'ended', to: 'paid' };
  if (next.at === 'ran-out' && st.at !== 'ran-out') return { on: 'ended', to: next.cancelled ? 'cancelled-on-shop' : 'ran-out' };
  if (e.kind === 'cancel' && (st.at === 'waiting' || st.at === 'refused')) return { on: 'ended', to: 'cancel' };
  if (e.kind === 'back') return { on: 'ended', to: 'leave' };
  return null;
}
