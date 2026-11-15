// Tap to check: cardd verifies the tap's p and c and moves the counter on.
import { CarddError, type CardInfo } from '../cardd/client';
import { isNetworkFailure, type CardDeps } from './deps';
import type { Identity } from './identify';

export type TapCheck = { ok: true; card: CardInfo } | { ok: false; reason: string };

const REASONS: Record<string, string> = {
  replayed: 'This tap was seen before: the card may have been copied.',
  bad_mac: "The card's code doesn't verify.",
  not_active: "This card isn't set up yet.",
  card_reset: 'This card has been wiped.',
  unknown_card: "Your server doesn't know this card.",
};

export async function checkTap(i: Identity, d: Pick<CardDeps, 'held'>): Promise<TapCheck> {
  if (i.serverDown) return { ok: false, reason: "Can't reach your server to check this tap." };
  // A tag read as a plain one (a phone that is a card) carries its tap itself.
  const sun = i.read?.sun ?? i.sun;
  if (i.kind !== 'ours' || !sun) return { ok: false, reason: 'Only a card that is set up can be checked.' };
  try {
    return { ok: true, card: await d.held.checkCard(sun) };
  } catch (e) {
    if (isNetworkFailure(e)) return { ok: false, reason: "Can't reach your server to check this tap." };
    if (e instanceof CarddError) return { ok: false, reason: REASONS[e.code] ?? e.message };
    throw e;
  }
}
