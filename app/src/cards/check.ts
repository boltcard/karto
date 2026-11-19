// Tap to check: cardd verifies the tap's p and c and moves the counter on.
// After a restore it is also the owner's check that lets the card pay again (cardd's needsCheck), and that check
// moves cardd's counter past every tap recorded since the backup. A tap's p and c can be copied to any tag, or
// played back by a phone pretending to be the card; the card's key 0 can't. So for a card that needs the check,
// the card must first prove it holds key 0 (AuthenticateEV2First, as a wipe's first step), and a tag read as a
// plain one never gives it.
import { deriveCardKeys } from '../boltcard/cardkeys';
import { CarddError, type CardInfo } from '../cardd/client';
import { TagLostError } from '../ntag424/apdu';
import type { Ntag424 } from '../ntag424/card';
import { isNetworkFailure, type CardDeps } from './deps';
import type { Identity } from './identify';

export type TapCheck = { ok: true; card: CardInfo } | { ok: false; reason: string };

const REASONS: Record<string, string> = {
  replayed: 'This tap was seen before: the card may have been copied.',
  bad_mac: "The card's code doesn't verify.",
  not_active: "This card isn't set up yet.",
  card_reset: 'This card has been wiped.',
  unknown_card: "Your server doesn't know this card.",
  // The card needs the check after a restore, and this check didn't say it was proved: the wallet's list was out of date.
  needs_check: 'This card must be checked by an up-to-date Karto Wallet.',
};

/** A tag that carries a card's link but isn't the card, held for the check after a restore. */
export const NOT_THE_CARD = "After the restore, only the card itself can be checked, and this tag couldn't prove it is the card. Hold the card to the phone.";

/** card: the tag the identity was read from, in the same session, for the proof a card needing the check gives. */
export async function checkTap(i: Identity, d: Pick<CardDeps, 'held' | 'issuer'>, card: Pick<Ntag424, 'authenticate'>): Promise<TapCheck> {
  if (i.serverDown) return { ok: false, reason: "Can't reach your server to check this tap." };
  // A tag read as a plain one (a phone that is a card) carries its tap itself.
  const sun = i.read?.sun ?? i.sun;
  if (i.kind !== 'ours' || !sun) return { ok: false, reason: 'Only a card that is set up can be checked.' };
  const proved = !!i.known?.needsCheck;
  if (proved) {
    if (i.plain || !i.uid || i.version === undefined) return { ok: false, reason: NOT_THE_CARD };
    try {
      await card.authenticate(0, deriveCardKeys(d.issuer, i.uid, i.version).k0);
    } catch (e) {
      if (e instanceof TagLostError) throw e;
      return { ok: false, reason: NOT_THE_CARD };
    }
  }
  try {
    return { ok: true, card: await d.held.checkCard(sun, { proved }) };
  } catch (e) {
    if (isNetworkFailure(e)) return { ok: false, reason: "Can't reach your server to check this tap." };
    if (e instanceof CarddError) return { ok: false, reason: REASONS[e.code] ?? e.message };
    throw e;
  }
}
