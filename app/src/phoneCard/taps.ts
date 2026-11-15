// The taps a phone hands a reader as a card: the card's
// link with a fresh p and c for each counter, made with the code that checks a plastic card's, and the NDEF file
// that holds each. They are made when the pay screen opens and never written anywhere.
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { deriveCardKeys } from '../boltcard/cardkeys';
import { buildSun } from '../boltcard/sun';
import { ndefFile } from '../ntag424/ndef';
import { checkCounters, phoneCardUid } from './id';

/** How many taps are made at a time. */
export const BATCH = 16;

/** What a phone's card's taps are made from: lnurlw is lnurlw://<host>/ln for the server the wallet is paired with. */
export type TapCard = { issuer: Uint8Array; n: number; version: number; lnurlw: string };

/** The p and c of the card's tap at each counter from `first`. Throws CounterSpent, making none, past the counter's end. */
export function tapSuns(card: Omit<TapCard, 'lnurlw'>, first: number, count = BATCH, random: (n: number) => Uint8Array = randomBytes): { p: string; c: string }[] {
  checkCounters(first, count);
  const uid = phoneCardUid(card.issuer, card.n);
  const { k1, k2 } = deriveCardKeys(card.issuer, uid, card.version);
  return Array.from({ length: count }, (_, i) => buildSun(k1, k2, uid, first + i, random(5)));
}

/** The card's link for each counter from `first`, as a reader gets it. */
export const tapUrls = (card: TapCard, first: number, count = BATCH, random: (n: number) => Uint8Array = randomBytes): string[] =>
  tapSuns(card, first, count, random).map(({ p, c }) => `${card.lnurlw}?p=${p}&c=${c}`);

/** The same taps as the card service takes them: each link's NDEF file, in hex. */
export const tapFiles = (card: TapCard, first: number, count = BATCH, random: (n: number) => Uint8Array = randomBytes): string[] =>
  tapUrls(card, first, count, random).map((url) => bytesToHex(ndefFile(url).file));
