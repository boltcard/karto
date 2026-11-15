// A phone's card: a card with no chip, whose ID is worked out
// from the issuer key and a number, so any phone that holds the phrase can tell which of the server's cards are
// phones' cards; and the counter a card's first tap carries.
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { cardId, prf } from '../boltcard/cardkeys';

const LABEL = Uint8Array.from('karto-phone-card', (ch) => ch.charCodeAt(0));

/** The 7-byte ID of the phone's card numbered n: 00, then the first 6 bytes of PRF(issuer key, label || n, little-endian). */
export function phoneCardUid(issuer: Uint8Array, n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`a phone's card has a whole number from 0, got ${n}`);
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, n, true);
  return concatBytes(Uint8Array.of(0x00), prf(issuer, concatBytes(LABEL, le)).subarray(0, 6));
}

/** No chip's ID begins 00: NXP's begin 04, and a card with its ID hidden shows 4 bytes beginning 08. */
export const isPhoneUid = (uid: Uint8Array): boolean => uid.length === 7 && uid[0] === 0x00;

/** The id the server lists the phone's card numbered n under. */
export const phoneCardId = (issuer: Uint8Array, n: number): string => bytesToHex(cardId(issuer, phoneCardUid(issuer, n)));

/**
 * The phones' cards among the server's, by number from 0, stopping at the first number the server does not list.
 * The numbers listed are always the first few: every registration takes the lowest free one, and the server keeps
 * a wiped card's row.
 */
export function phonesCards<C extends { id: string }>(issuer: Uint8Array, cards: readonly C[]): { n: number; card: C }[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const found: { n: number; card: C }[] = [];
  for (let n = 0; ; n++) {
    const card = byId.get(phoneCardId(issuer, n));
    if (!card) return found;
    found.push({ n, card });
  }
}

/** How many numbers past the first the server does not list are still looked at, when looking for cards to remove or to mark. */
export const PAST_A_GAP = 8;

/**
 * Every phone's card among the server's that a wider look finds: by number from 0, until PAST_A_GAP numbers in a
 * row are not listed. The numbers listed should always be the first few, and phonesCards rests on that; removing
 * a card that should no longer pay does not, so a card past a gap is found too.
 */
export function phonesCardsWide<C extends { id: string }>(issuer: Uint8Array, cards: readonly C[]): { n: number; card: C }[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const found: { n: number; card: C }[] = [];
  for (let n = 0, missed = 0; missed < PAST_A_GAP; n++) {
    const card = byId.get(phoneCardId(issuer, n));
    if (card) found.push({ n, card });
    missed = card ? 0 : missed + 1;
  }
  return found;
}

/** The number a new phone's card takes: the lowest whose id the server does not list. */
export const lowestFree = (issuer: Uint8Array, cards: readonly { id: string }[]): number => phonesCards(issuer, cards).length;

/** A card's counter is 24 bits. */
export const COUNTER_MAX = 0xffffff;
const START_2026 = Date.UTC(2026, 0, 1);

/** A phone's card whose counter would pass its end: by 2057 on a right clock, at once on one set years ahead. */
export class CounterSpent extends Error {
  constructor() {
    super("This phone's card has used up its counter. Check the phone's date.");
    this.name = 'CounterSpent';
  }
}

/**
 * The counter of the tap that registers a card: the higher of the record's `next` and the minutes since the start
 * of 2026 by the phone's clock. A card registered again under the same number has the same keys; this keeps its
 * counters above every tap an earlier registration handed out, even when the phone's record and the server's row
 * were both lost.
 */
export function firstCounter(next: number | undefined, nowMs: number): number {
  return Math.max(next ?? 0, Math.floor((nowMs - START_2026) / 60_000), 0);
}

/** Refuses the counters first to first + count - 1 if any is past the counter's end. */
export function checkCounters(first: number, count: number): void {
  if (first + count - 1 > COUNTER_MAX) throw new CounterSpent();
}
