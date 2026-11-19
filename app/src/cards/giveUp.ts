// Giving up a card the person no longer has (lost, broken, given away, set up elsewhere): the wipe's two server
// calls with no card in between, as phoneCard/keep.ts removes another phone's card. The start stops the card paying
// and moves its balance to Pool in one transaction; the finish resets it, so every tap of it is refused for good.
// The start must reach the server: a give-up the server hasn't heard of records nothing (a pending start would be
// made later, unattended, at a balance nobody confirmed, and its finish would wait for a hold that never comes).
// A finish that doesn't is recorded pending, and the wallet's catch-up (catchUp.ts) makes it.
import { CarddError } from '../cardd/error';
import { isNetworkFailure, type CardDeps } from './deps';

export const GIVE_UP_UNREACHABLE = "Can't reach your server: nothing was changed. Try again when it answers.";
export const GIVE_UP_BUSY = 'A payment on this card is in progress: try again once it has finished.';

/** unreachable: the start didn't reach the server, so nothing changed. busy: a payment holds some of the card's balance. */
export class GiveUpError extends Error {
  constructor(readonly why: 'unreachable' | 'busy') {
    super(why === 'unreachable' ? GIVE_UP_UNREACHABLE : GIVE_UP_BUSY);
    this.name = 'GiveUpError';
  }
}

/** finished: the server has the card reset; false: the finish is pending, for the catch-up. */
export async function giveUpCard(d: Pick<CardDeps, 'cardd' | 'cache'>, card: { id: string; version: number; name: string }): Promise<{ finished: boolean }> {
  try {
    await d.cardd.wipeCard(card.id);
  } catch (e) {
    if (isNetworkFailure(e)) throw new GiveUpError('unreachable');
    if (e instanceof CarddError && e.status === 409) {
      // A wipe is refused for a payment in progress, and for a card already reset (another phone gave it up): the
      // server's list says which.
      let listed;
      try {
        listed = (await d.cardd.cards()).find((c) => c.id === card.id);
      } catch (x) {
        if (isNetworkFailure(x)) throw new GiveUpError('unreachable');
        throw x;
      }
      if (listed && listed.state !== 'reset') throw new GiveUpError('busy');
    } else if (!(e instanceof CarddError && e.code === 'not_found')) throw e;
  }
  // Recorded before the finish, so a finish cut short by anything (the app killed, a refusal) is made by the catch-up.
  const record = { id: card.id, version: card.version, name: card.name, state: 'reset' as const };
  await d.cache.saveCard({ ...record, pending: 'wiped' });
  try {
    await d.cardd.wipedCard(card.id);
  } catch (e) {
    if (isNetworkFailure(e)) return { finished: false };
    if (!(e instanceof CarddError && e.code === 'not_found')) throw e;
  }
  await d.cache.saveCard(record);
  return { finished: true };
}
