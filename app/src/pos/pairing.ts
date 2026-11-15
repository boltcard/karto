// Pairing Karto PoS with a shop: the screen's words, what pairing does, and unpairing.
// The screens in pos-app/ hold only state and calls.
import { CarddError } from '../cardd/error';
import { settingsPlace } from '../native/camera';
import { isNetworkFailure, type FetchFn } from '../lightning/lightning';
import type { DeviceKey } from '../native/deviceKey';
import { pairPhone } from './client';
import type { Paired, PosStore } from './settings';

/** How long an old shop is given to forget this phone before the phone moves on. */
export const FORGET_WAIT_MS = 5_000;

export const PAIR_WORDS = {
  title: 'Karto PoS',
  heading: 'Pair this phone to take payments',
  how: 'In Karto Wallet, open Shop, then Add a PoS phone, and scan the code it shows.',
  scan: 'Scan the code',
  /** The scanner's foot. */
  scanFoot: 'Point at the code in Karto Wallet.',
  limits: "Once paired, this phone can take payments and see the sales it took. It can't move money, and it never sees the cards or the recovery phrase.",
  pairing: 'Pairing…',
} as const;

/**
 * The scanner's words when the camera is refused, naming the phone's own settings,
 * and whether to offer them: once only Settings can allow it (an iPhone's refusal, or Android's "don't ask again").
 */
export const scanRefusal = (camera: 'refused' | 'refused_for_good', ios: boolean): { text: string; settings: boolean } => ({
  text: `The camera isn't allowed for this app. Allow it in ${settingsPlace(ios)} to scan the code in Karto Wallet.`,
  settings: camera === 'refused_for_good',
});

/** A pairing code given to a phone that is already paired: what it says, whose the new code is, and its two buttons. */
export const alreadyPaired = (p: Paired, host: string) =>
  ({
    line: p.wallet ? `This phone is already paired with ${p.wallet} (${p.host}) as ${p.name}.` : `This phone is already paired with ${p.host} as ${p.name}.`,
    to: host === p.host ? 'The new code is for the same shop.' : `The new code is for ${host}.`,
    pair: 'Pair with the new shop',
    keep: 'Keep this shop',
  }) as const;

/**
 * A pairing link that came from outside the app (Karto Wallet on this phone, the phone's own camera, but also any
 * web page or app that cares to send one) on a phone that isn't paired: the question put before anything is done.
 */
export const linkQuestion = (host: string) =>
  ({
    line: `Pair this phone with ${host}?`,
    why: 'Only if you opened this from Karto Wallet, or scanned its code, just now. This phone will take payments for that server.',
    pair: 'Pair',
    no: 'Not now',
  }) as const;

/**
 * A pairing code in hand, and whether this app's own scanner read it (the person pointed the phone at it just
 * now). answered: a link the person answered before (PosStore.answered), which Android has handed over again.
 */
export type Given = { link: { host: string; code: string }; scanned: boolean; answered?: boolean };

type Code = { host: string; code: string };

/**
 * A code in hand as one string, of everything a question about it shows (where it came from, its server, the
 * code): what the screen has used, and what the second's wait is for, are known by it. '' for none.
 */
export const codeKey = (g: Given | null): string => (g ? `${g.scanned ? 'scan' : 'link'} ${g.link.host} ${g.link.code}` : '');

/** How long a question shows before it can be answered. */
export const ANSWER_AFTER_MS = 1000;

/**
 * Whether the question for the code `key` may be answered now. A link can arrive at any moment and put a question
 * where something else was, or another server's question where this one was: a tap already on its way must not
 * answer it. shown: the question on screen and since when it has been there to see (the screen in front, the app
 * open): a question that waited behind another screen, or in an app that wasn't showing, starts its second when
 * it comes to the front.
 */
export function canAnswer(shown: { key: string; sinceMs: number } | null, key: string, nowMs: number): boolean {
  return shown !== null && shown.key === key && nowMs - shown.sinceMs >= ANSWER_AFTER_MS;
}

/**
 * The code the Pair screen acts on: a link's if there is one, else the scanner's. A link can come while the screen
 * is already in front (the router then opens no new screen: it hands the link to the one showing), so this is
 * asked on every render and not once when the screen opens.
 */
export function codeInHand(scanned: Code | null, linked: Code | null): Given | null {
  if (linked) return { link: linked, scanned: false };
  return scanned ? { link: scanned, scanned: true } : null;
}

/**
 * What the Pair screen does with a code: 'pair' at once only for one its own scanner read on a phone that isn't
 * paired; 'ask' for a link from outside; 'choose' (the old shop or the new) on a paired phone, wherever the code
 * came from; 'plain' with none, or once the code was used or turned down; 'stale' for a link answered before,
 * which opens the app as its icon does; 'in-sale' for a link that comes while a sale is open: nobody pairs a till
 * in the middle of a sale, so it is answered for good and the sale stays in front.
 */
export function pairStep(paired: Paired | null, given: Given | null, used: boolean, inSale = false): 'pair' | 'ask' | 'choose' | 'plain' | 'stale' | 'in-sale' {
  if (!given || used) return 'plain';
  if (inSale && !given.scanned) return 'in-sale';
  if (!given.scanned && given.answered) return 'stale';
  if (paired) return 'choose';
  return given.scanned ? 'pair' : 'ask';
}

/** In place of whatever was in front, once the shop answers 401 "unknown or revoked device". */
export const removedWords = {
  line: "This phone was removed from the shop. It can't take payments until it is paired again in Karto Wallet.",
  again: 'Pair again',
} as const;

/** Why pairing didn't happen, in a sentence over Scan the code. */
export function pairError(e: unknown): string {
  if (e instanceof CarddError) {
    if (e.code === 'bad_code') return "That code didn't work: it may have run out. Ask for a new one in Karto Wallet.";
    if (e.code === 'key_known') return 'This phone is already a PoS phone of that shop under another name. Remove it in Karto Wallet first.';
    // A cardd from before the point of sale has no pairing route: its router's plain 404.
    if (e.status === 404 && e.code === 'bad_response') return 'That server has no point of sale yet: update it in Karto Wallet.';
    // Something answered, and not as cardd does: its words aren't shown.
    if (e.code === 'not_a_shop' || e.code === 'bad_response') return "That server didn't answer as a shop does.";
    // Any other refusal. The server is whichever one the code named, and no shop of the person's yet: none of its
    // own words are shown, and its code only when that is a plain word, as cardd's are.
    return /^[a-z_]{1,32}$/.test(e.code) ? `That server refused to pair this phone (${e.code}).` : 'That server refused to pair this phone.';
  }
  if (isNetworkFailure(e)) return "Can't reach that server.";
  return `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
}

/** Waits for a call for ms at most; whether it ends, fails or is still on its way, the caller goes on. */
async function atMost(call: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((done) => (timer = setTimeout(done, ms)));
  await Promise.race([call().then(() => undefined, () => undefined), late]).finally(() => clearTimeout(timer));
}

/**
 * Pairs this phone with a shop by a code's host and code: the key is made if the phone has none, the shop is
 * asked, and its host and the name it gave are kept. Nothing is kept, and nothing is lost, when the shop refuses.
 *
 * old: the shop a paired phone has now. It is asked to forget this phone (waited for FORGET_WAIT_MS at most) only
 * once the new shop has taken it, so the old shop isn't left listing a phone that will never sell again, and a
 * code that doesn't work costs the phone nothing. When the code is for the same shop: if that shop removed the
 * phone it pairs again and there is nothing to forget; if it still knows the key it answers key_known, which it
 * does only for a code it found good and leaves open, so it is asked to forget the phone and the code is used again.
 * (Should the forget arrive and the second pairing then fail, on the network say, the phone is removed at its shop
 * while still paired here: its next call opens Removed, and the code stays good for the rest of its 10 minutes.)
 */
export async function pairWith(
  d: {
    fetch: FetchFn; key: Pick<DeviceKey, 'create'>; store: Pick<PosStore, 'savePaired'>;
    old?: { host: string; forget: () => Promise<unknown> }; forgetWaitMs?: number;
  },
  link: { host: string; code: string },
): Promise<{ ok: true; name: string; wallet: string } | { ok: false; text: string }> {
  const wait = d.forgetWaitMs ?? FORGET_WAIT_MS;
  try {
    const publicKey = await d.key.create();
    const pair = () => pairPhone(d.fetch, link.host, link.code, publicKey);
    const sameShop = d.old?.host === link.host;
    const { name, wallet } = await pair().catch(async (e) => {
      if (!(d.old && sameShop && e instanceof CarddError && e.code === 'key_known')) throw e;
      await atMost(d.old.forget, wait);
      return pair();
    });
    await d.store.savePaired({ host: link.host, name, wallet });
    if (d.old && !sameShop) await atMost(d.old.forget, wait);
    return { ok: true, name, wallet };
  } catch (e) {
    return { ok: false, text: pairError(e) };
  }
}

/**
 * Unpair this phone: the shop is asked to forget it (waited for FORGET_WAIT_MS at most), then the host and the
 * name are forgotten here whatever the shop said. The key stays, so pairing again with the same shop is the same phone.
 */
export async function unpair(d: { store: Pick<PosStore, 'forget'>; forget: () => Promise<unknown>; waitMs?: number }): Promise<void> {
  await atMost(d.forget, d.waitMs ?? FORGET_WAIT_MS);
  await d.store.forget();
}
