// What a tapped card is, read from the card
// itself so any phone with the phrase can finish an add or a wipe. Never writes.
import { bytesToHex } from '@noble/hashes/utils.js';
import { cardId, deriveCardKeys, k1For } from '../boltcard/cardkeys';
import { decryptPicc, parseSun, verifySun, type Picc } from '../boltcard/sun';
import type { CardState, Sun } from '../cardd/client';
import { CardError } from '../ntag424/apdu';
import type { Ntag424 } from '../ntag424/card';
import { equalBytes, ZERO_KEY } from '../ntag424/crypto';
import { offsetsMatch, sunOfUrl, urlHost, urlOf } from '../ntag424/ndef';
import { CardFlowError, isNetworkFailure, type CardDeps } from './deps';
import { readCard, type CardRead } from './read';

/** not-a-card: a tag with no Bolt Card's link on it. */
export type Kind = 'blank' | 'ours' | 'half-added' | 'half-wiped' | 'unknown-ours' | 'foreign' | 'not-a-card';
/**
 * host: the server cardd records the card's URL at (cardd only: the cache has none). needsCheck: cardd's, after a
 * restore: the card pays again only once checked, with the card's proof (check.ts).
 */
export type Known = { state: CardState; version: number; name: string; host?: string; needsCheck?: boolean };

export type Identity = {
  kind: Kind;
  /** Null when the tag refused an NTAG 424's questions: it was then read as a plain tag, or not at all. */
  read: CardRead | null;
  /**
   * The tag is not an NTAG 424, or would not answer as one: a phone that is a card, another chip, or no Bolt Card.
   * What it is was read from its link alone. It is shown, and no card job takes it (refusePlain).
   */
  plain?: true;
  /** A plain tag's tap (an NTAG 424's is read.sun). */
  sun?: Sun;
  uid?: Uint8Array;
  id?: string;
  /** The version its keys were derived at: cardd's, the cache's, or found by trying c. */
  version?: number;
  known?: Known;
  /** cardd couldn't be reached: known came from the phone's cache. */
  serverDown: boolean;
  /** One of the person's cards whose URL points at another server, or whose SUN offsets don't match its URL, or that cardd records at another server. */
  needsRepoint: boolean;
};

const MAX_VERSION = 31;

/** The resume table. versions: key versions 0–4; sdm: SUN on; state: what cardd (or the cache) says. */
export function classify(versions: number[], sdm: boolean, state: CardState | null): Kind {
  const changed = versions.slice(1).filter((v) => v !== 0).length;
  if (versions[0] === 0) {
    if (state === 'wiping' || state === 'active' || state === 'frozen') return 'half-wiped';
    return changed === 0 && !sdm ? 'blank' : 'half-added';
  }
  if (state === null) return 'unknown-ours';
  if (changed === 4 && state === 'programming') return 'half-added';
  if (changed === 4 && (state === 'active' || state === 'frozen')) return 'ours';
  return 'half-wiped';
}

/** A wipe's last resort: the version whose K2 verifies c. */
export function versionSearch(issuer: Uint8Array, uid: Uint8Array, picc: Picc, c: Uint8Array): number | null {
  for (let v = 0; v <= MAX_VERSION; v++) if (verifySun(deriveCardKeys(issuer, uid, v).k2, picc, c)) return v;
  return null;
}

async function lookup(d: CardDeps, id: string): Promise<{ known?: Known; serverDown: boolean }> {
  const pick = (c?: Known) => (c ? { state: c.state, version: c.version, name: c.name, host: c.host, ...(c.needsCheck && { needsCheck: true }) } : undefined);
  try {
    return { known: pick((await d.held.cards()).find((c) => c.id === id)), serverDown: false };
  } catch (e) {
    if (!isNetworkFailure(e)) throw e;
    return { known: pick((await d.cache.cards())[id]), serverDown: true };
  }
}

/** The card's URL names this server, with p and c where its SUN settings put them. */
export function pointsAt(read: CardRead, host: string): boolean {
  return urlHost(read.url ?? '') === host && offsetsMatch(read.file, read.settings);
}

/** A tag with nothing of a Bolt Card on it that could be read: one the phone can't talk to is this too. */
export const NO_CARD: Identity = { kind: 'not-a-card', read: null, plain: true, serverDown: false, needsRepoint: false };
export const NOT_A_CARD = "This isn't a Bolt Card.";
export const PLAIN_REFUSAL = "Karto Wallet can't change this card: it isn't the kind of chip it sets up.";

/** Every card job's first refusal: a tag read as a plain one is never written to, whoever's it is. */
export function refusePlain(i: Identity): void {
  if (i.kind === 'not-a-card') throw new CardFlowError(NOT_A_CARD);
  if (i.plain) throw new CardFlowError(PLAIN_REFUSAL);
}

/**
 * A tag that refused an NTAG 424's questions, read as the plain NDEF tag a reader of any Bolt Card sees:
 * whose it is comes from its link's p and c alone.
 */
async function identifyPlain(card: Ntag424, d: CardDeps): Promise<Identity> {
  let url: string | null;
  try {
    url = urlOf(await card.readNdefFile());
  } catch (e) {
    if (e instanceof CardError) return NO_CARD;
    throw e;
  }
  const sun = sunOfUrl(url);
  if (!sun) return NO_CARD;
  const foreign: Identity = { kind: 'foreign', read: null, plain: true, serverDown: false, needsRepoint: false };
  const parsed = parseSun(sun.p, sun.c)!;
  const picc = decryptPicc(k1For(d.issuer), parsed.p);
  if (!picc) return foreign;
  const id = bytesToHex(cardId(d.issuer, picc.uid));
  const { known, serverDown } = await lookup(d, id);
  // p opening to C7 is 1 in 256 by chance: c must verify too, at cardd's version or one found by trying.
  const fits = (v?: number) => v !== undefined && verifySun(deriveCardKeys(d.issuer, picc.uid, v).k2, picc, parsed.c);
  const version = fits(known?.version) ? known!.version : (versionSearch(d.issuer, picc.uid, picc, parsed.c) ?? undefined);
  if (version === undefined) return foreign;
  const ready = known?.state === 'active' || known?.state === 'frozen';
  return { kind: ready ? 'ours' : 'unknown-ours', read: null, plain: true, sun, uid: picc.uid, id, version, known, serverDown, needsRepoint: false };
}

export async function identify(card: Ntag424, d: CardDeps): Promise<Identity> {
  const foreign = (read: CardRead | null): Identity => ({ kind: 'foreign', read, serverDown: false, needsRepoint: false });
  let read: CardRead;
  try {
    read = await readCard(card);
  } catch (e) {
    if (!(e instanceof CardError)) throw e;
    // A tag that has no NTAG 424 in it refuses the first of its questions. One that answers those and then
    // refuses is an NTAG 424 that went wrong part-way: it is not read as a plain tag, and says what it said before.
    return e.command === 'SelectApplication' || e.command === 'GetKeyVersion' ? identifyPlain(card, d) : foreign(null);
  }
  let uid: Uint8Array | null = null;
  let tap: { picc: Picc; c: Uint8Array } | null = null;
  if (read.versions[0] === 0) {
    try {
      await card.authenticate(0, ZERO_KEY);
      uid = await card.getCardUid();
    } catch (e) {
      if (!(e instanceof CardError)) throw e;
    }
    // Keys changed while K0 is still zero are only ours if they prove it: an add changes
    // K1 up to K4 in order, and p must name this UID and c verify (below), as it would
    // under this issuer's keys. Otherwise they are someone else's, and nothing is written.
    const changed = read.versions.slice(1).map((v) => v !== 0);
    if (uid && changed.some(Boolean)) {
      const inOrder = changed.every((c, k) => c || !changed.slice(k).some(Boolean));
      const parsed = read.sun && parseSun(read.sun.p, read.sun.c);
      const picc = parsed && decryptPicc(read.versions[1] === 0 ? ZERO_KEY : k1For(d.issuer), parsed.p);
      if (!inOrder || !parsed || !picc || !equalBytes(picc.uid, uid)) return foreign(read);
      tap = { picc, c: parsed.c };
    }
  } else if (read.sun) {
    // Key 1's version says which K1 p is under: this issuer's, or (mid-wipe) zero again.
    const parsed = parseSun(read.sun.p, read.sun.c)!;
    const picc = decryptPicc(read.versions[1] === 0 ? ZERO_KEY : k1For(d.issuer), parsed.p);
    if (picc) {
      uid = picc.uid;
      tap = { picc, c: parsed.c };
    }
  }
  if (!uid) return foreign(read);
  const id = bytesToHex(cardId(d.issuer, uid));
  const { known, serverDown } = await lookup(d, id);
  let version = known?.version;
  if (tap) {
    // p decrypting to C7 is 1 in 256 by chance: c must verify too.
    if (read.versions[2] === 0) {
      if (!verifySun(ZERO_KEY, tap.picc, tap.c)) return foreign(read);
    } else {
      const fits = (v?: number) => v !== undefined && verifySun(deriveCardKeys(d.issuer, uid!, v).k2, tap!.picc, tap!.c);
      if (!fits(version)) version = versionSearch(d.issuer, uid, tap.picc, tap.c) ?? undefined;
      if (version === undefined) return foreign(read);
    }
  }
  const kind = classify(read.versions, read.settings.sdm, known?.state ?? null);
  // cardd's host is what puts a card on the server page's list to re-point.
  const needsRepoint = kind === 'ours' && (!pointsAt(read, d.host) || (known?.host !== undefined && known.host !== d.host));
  return { kind, read, uid, id, version, known, serverDown, needsRepoint };
}
