// What the card screens say: the tap sheet and errors. (The hold screen's steps are cards/hold.ts's.)
import type { Rated } from '../money/fiat';
import { viewText, type View } from '../money/view';
import { satText } from '../money/words';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { CarddError } from '../cardd/client';
import { CardError, TagLostError } from '../ntag424/apdu';
import type { TapCheck } from './check';
import { isTimeout } from '../lightning/lightning';
import { CardFlowError, isNetworkFailure } from './deps';
import type { Identity } from './identify';

/** The sheet's one button for a card held to the phone. (A wipe is its red row, not a button.) */
export type SheetAction = 'add' | 'finish-add' | 'finish-wipe' | 'repoint' | 'adopt';

export const ACTION_LABELS: Record<SheetAction, string> = {
  add: 'Add card',
  'finish-add': 'Finish setup',
  'finish-wipe': 'Finish wipe',
  repoint: 'Re-point',
  adopt: 'Add back to this server',
};

/**
 * The sheet for a card held to the phone, one shape for every
 * card. face: the card's own face, a blank card's outline, or none. body: one line under the title. warning: drawn
 * in an amber panel. main: the one thing to do, a button. wipe: the red Wipe the card row stands under it (its line
 * is wallet/accountView.ts's wipeLine). foot: the state and version, small.
 */
export type SheetView = { face: 'card' | 'outline' | 'none'; title: string; body?: string; warning?: string; main?: SheetAction; wipe: boolean; foot?: string };

/**
 * A tag read as a plain one: shown, with nothing to do to it.
 * An ID that begins 00 is a phone's (phoneCard/id.ts).
 */
function plainSheet(i: Identity): SheetView | null {
  const phone = i.uid?.[0] === 0x00;
  if (i.kind === 'ours') {
    return {
      face: 'card',
      title: i.known?.name || 'Your card',
      ...(i.serverDown && { body: "Your server can't be reached, so this is what the phone remembers." }),
      wipe: false,
      foot: `${i.known?.state === 'frozen' ? 'Frozen' : 'Active'} · ${phone ? 'a phone' : `card version ${i.version}`}`,
    };
  }
  if (i.kind === 'unknown-ours') {
    return { face: 'none', title: phone ? 'A phone that was one of your cards' : "One of your cards that this wallet can't change", body: "Your server doesn't list it, so it can't pay.", wipe: false };
  }
  return null;
}

export function sheetFor(i: Identity): SheetView {
  const name = i.known?.name;
  const plain = i.plain ? plainSheet(i) : null;
  if (plain) return plain;
  switch (i.kind) {
    case 'ours': {
      // Re-point isn't offered while the server can't be reached: the hold screen refused it at once.
      const repoint = i.needsRepoint && !i.serverDown;
      return {
        face: 'card',
        title: name || 'Your card',
        ...(i.serverDown && { body: "Your server can't be reached, so this is what the phone remembers." }),
        // The cards to re-point must stand out.
        ...(i.needsRepoint && {
          warning: i.serverDown
            ? 'This card still points at another server. Re-point it once your server can be reached.'
            : 'This card still points at another server. Re-point it to pay through this one.',
        }),
        ...(repoint && { main: 'repoint' as const }),
        wipe: true,
        foot: `${i.known?.state === 'frozen' ? 'Frozen' : 'Active'} · card version ${i.version}`,
      };
    }
    case 'blank':
      return { face: 'outline', title: 'A blank card', body: "It can be added to your server. You'll give it a name, then hold it once more.", main: 'add', wipe: false };
    case 'half-added':
      return { face: 'none', title: name ? `${name}, part-way through being added` : 'A card part-way through being added', body: 'Finish setting it up, or wipe it.', main: 'finish-add', wipe: true };
    case 'half-wiped':
      return { face: 'none', title: name ? `${name}, part-way through a wipe` : 'A card part-way through a wipe', body: 'Finish the wipe to make it blank again.', main: 'finish-wipe', wipe: false };
    case 'unknown-ours': {
      // After a rebuild from the phrase alone, or a backup older than the card. Keys part-way through a wipe can only be wiped.
      const whole = i.read?.versions.every((v) => v === 1) ?? false;
      return {
        face: 'none',
        title: "One of your cards, but your server doesn't know it",
        body: `It was set up with your recovery phrase. ${whole ? 'Add it back to this server, or wipe it.' : 'Wipe it to add it again.'}`,
        ...(whole && { main: 'adopt' as const }),
        wipe: true,
        foot: `Card version ${i.version ?? 'unknown'}`,
      };
    }
    case 'foreign':
      return { face: 'none', title: 'A card from another service', body: "Karto Wallet can't use it, and won't change it.", wipe: false };
    case 'not-a-card':
      return { face: 'none', title: 'Not a Bolt Card', body: 'Karto Wallet found nothing on it that it can read.', wipe: false };
  }
}

/** A tap check's result, in the same words on the tap sheet and on the card's account page. */
export function tapCheckText(check: TapCheck): string {
  return check.ok ? `✓ Your server checked this tap (tap ${check.card.counter}).` : `✗ ${check.reason}`;
}

/** again: holding the card again carries on (a lifted card, a server that was briefly unreachable). */
export function describeError(e: unknown): { text: string; again: boolean } {
  if (e instanceof TagLostError) return { text: 'The card moved away. Hold it again to carry on.', again: true };
  if (isTimeout(e)) return { text: "Your server didn't answer in time. Hold the card again to carry on.", again: true };
  if (isNetworkFailure(e)) return { text: "Can't reach your server. Hold the card again once it's back.", again: true };
  if (e instanceof CardFlowError) return { text: e.message, again: false };
  if (e instanceof CardError) return { text: `The card refused: ${e.message}`, again: false };
  if (e instanceof CarddError) return { text: `Your server refused: ${e.message}`, again: false };
  return { text: e instanceof Error ? e.message : String(e), again: false };
}

const LIST_UNREACHABLE = "Can't reach your server, so this is what the phone remembers. Adding a card needs the server.";

/** Why the card list on the server page couldn't be loaded; only a network failure falls back to the phone's cache. */
export function listError(e: unknown): string {
  if (isNetworkFailure(e)) return LIST_UNREACHABLE;
  if (e instanceof CarddError) return `Your server couldn't list the cards: ${e.message}`;
  return `Couldn't load your cards: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * The line over the wallet's cards when the list failed. Under the red
 * "Can't reach your server" banner (unreachable: it shows) the server being
 * out of reach is said once: the line only says what the cards are, muted.
 * Any other failure (cardd refused the list, or Set the books) stays red.
 */
export function cardsLine(cardsError: string | null, unreachable: boolean): { text: string; muted: boolean } | null {
  if (cardsError === null) return null;
  if (unreachable && cardsError === LIST_UNREACHABLE) return { text: 'These are the cards this phone remembers. Adding a card needs the server.', muted: true };
  return { text: cardsError, muted: false };
}

export { satText } from '../money/words';

/** A URL as LUD-01 bech32, upper case for a denser QR code: "LNURL1…". */
export function lnurlEncode(url: string): string {
  return bech32.encode('lnurl', bech32.toWords(utf8ToBytes(url)), false).toUpperCase();
}

/** A Lightning address (name@host) as the LNURL of its LUD-16 payRequest, for a top-up QR code. */
export function lnurlFor(address: string): string {
  const [name, host] = address.split('@');
  return lnurlEncode(`https://${host}/.well-known/lnurlp/${name}`);
}

/** phoenixd's fee credit: a top-up too small for its first channel. Empty when there is none. */
export function feeCreditText(sat: number, v: View = 'sat', r: Rated | null = null): string {
  return sat > 0 ? `Fee credit: ${viewText(sat * 1000, v, r)} (not spendable; it pays toward the server's first channel)` : '';
}

/** Why spending stopped (GET /api/v1/wallet's pausedReason), for the server page. */
export function pausedText(reason: string): string {
  return `Spending is paused: the server's books and its Lightning balance don't agree (${reason}).`;
}
