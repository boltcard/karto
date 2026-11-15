// Adding back a card this server has no record of:
// cardd checks the tap at the version identify found by trying c, and
// adds it at the tap's counter with no host; the same hold then re-points it,
// and its check sets the host. A hold lost after the adopt leaves a card cardd
// knows, listed to re-point, so holding it again re-points it.
import { CarddError, type CardInfo } from '../cardd/client';
import type { Ntag424 } from '../ntag424/card';
import { CardFlowError, type CardDeps } from './deps';
import { identify, refusePlain } from './identify';
import { finishRepoint, type RepointStep } from './repoint';

export type AdoptStep = 'check' | 'adopt' | Exclude<RepointStep, 'check'>;
export const ADOPT_STEPS: AdoptStep[] = ['check', 'adopt', 'url', 'settings', 'confirm'];

const REFUSALS: Record<string, string> = {
  bad_mac: "This card's version couldn't be found, so it can't be added back.",
  conflict: 'This server already knows this card.',
  not_ours: "This card belongs to another service, so it can't be added back.",
};

export async function adoptCard(card: Ntag424, d: CardDeps, o: { name: string; onStep?: (s: AdoptStep) => void }): Promise<CardInfo> {
  const step = (s: AdoptStep) => o.onStep?.(s);
  const i = await identify(card, d);
  refusePlain(i);
  if (i.serverDown) throw new CardFlowError("Can't reach your server. Adding a card back needs it.");
  if (i.kind === 'ours' && i.needsRepoint) {
    step('check');
    step('adopt');
    return finishRepoint(card, i, d, step);
  }
  if (i.kind === 'ours') throw new CardFlowError(REFUSALS.conflict);
  if (i.kind === 'foreign') throw new CardFlowError(REFUSALS.not_ours);
  if (i.kind !== 'unknown-ours') throw new CardFlowError("Only a card set up with your recovery phrase that this server doesn't know can be added back.");
  // Part-way through a wipe, p or c is under a zero key that cardd's check won't take.
  if (!i.read!.versions.every((v) => v === 1) || !i.read!.sun) {
    throw new CardFlowError('This card is part-way through a wipe, so it can only be wiped: then add it again.');
  }
  step('check');

  let info: CardInfo;
  try {
    info = await d.held.adoptCard({ version: i.version!, name: o.name, ...i.read!.sun });
  } catch (e) {
    if (e instanceof CarddError && REFUSALS[e.code]) throw new CardFlowError(REFUSALS[e.code]);
    throw e;
  }
  await d.cache.saveCard({ id: info.id, version: info.version, name: info.name, state: info.state });
  step('adopt');
  return finishRepoint(card, i, d, step);
}
