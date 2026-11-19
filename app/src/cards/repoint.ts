// Re-pointing a card at this server:
// the same keys and version, a new URL, then the new SUN offsets. A cut
// between the two leaves p and c at the old offsets, where readCard still finds them.
import { deriveCardKeys } from '../boltcard/cardkeys';
import type { CardInfo } from '../cardd/client';
import { TagLostError } from '../ntag424/apdu';
import type { Ntag424 } from '../ntag424/card';
import { cardUrl, lnurlwFor, ndefFile, sunFileSettings } from '../ntag424/ndef';
import { NOT_THE_CARD } from './check';
import { CardFlowError, type CardDeps } from './deps';
import { identify, pointsAt, refusePlain, type Identity } from './identify';
import { readCard } from './read';

export type RepointStep = 'check' | 'url' | 'settings' | 'confirm';
export const REPOINT_STEPS: RepointStep[] = ['check', 'url', 'settings', 'confirm'];

export async function repointCard(card: Ntag424, d: CardDeps, o: { onStep?: (s: RepointStep) => void } = {}): Promise<CardInfo> {
  const step = (s: RepointStep) => o.onStep?.(s);
  const i = await identify(card, d);
  refusePlain(i);
  if (i.kind !== 'ours') throw new CardFlowError('Only a card that is set up and known to this server can be re-pointed.');
  if (i.serverDown) throw new CardFlowError("Can't reach your server. Re-pointing checks the card with it afterwards.");
  step('check');
  return finishRepoint(card, i, d, step);
}

/** The re-point of a card cardd knows, from the URL on (an adopt's too): writes only what isn't this server's yet. */
export async function finishRepoint(card: Ntag424, i: Identity, d: CardDeps, step: (s: RepointStep) => void): Promise<CardInfo> {
  const keys = deriveCardKeys(d.issuer, i.uid!, i.version!);
  if (!pointsAt(i.read!, d.host)) {
    const n = ndefFile(cardUrl(lnurlwFor(d.host)));
    await card.authenticate(0, keys.k0);
    await card.writeNdef(n.file);
    step('url');
    await card.changeFileSettings(sunFileSettings(n.piccOffset, n.macOffset));
  } else {
    step('url');
  }
  step('settings');
  const after = await readCard(card);
  if (!after.sun) throw new CardFlowError('The card gave nothing to check after the re-point. Hold it again to try once more.');
  // The tap just read came from the card itself: it proves key 0, as the URL's write did. The check moves cardd's
  // counter on, and after a restore lets the card pay again (proved), so a copy of a tap must never give it (check.ts).
  try {
    await card.authenticate(0, keys.k0);
  } catch (e) {
    if (e instanceof TagLostError) throw e;
    throw new CardFlowError(NOT_THE_CARD);
  }
  const info = await d.held.checkCard(after.sun, { proved: !!i.known?.needsCheck });
  // Once the check passes, cardd records the host and the card leaves the list to re-point.
  const set = info.host === d.host ? info : await d.held.setCardHost(info.id, d.host);
  step('confirm');
  return set;
}
