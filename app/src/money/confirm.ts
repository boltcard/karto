// Watching a payment out of one of the person's own accounts until cardd settles it (Send out, Renew now).
import type { CarddClient } from '../cardd/client';

export type Outcome = { kind: 'paid'; cardMsat: number; feeMsat: number } | { kind: 'failed' } | { kind: 'unconfirmed' };

/**
 * Watches the card's own server until the payment of paymentHash is settled
 * (the card's history shows "paid <hash>": cardMsat is what the card paid,
 * amount plus fee) or released (nothing held, nothing paid).
 */
export async function confirmPayment(
  cardd: Pick<CarddClient, 'wallet' | 'history'>,
  account: string, // a card's id, 'pool' or 'hosting'
  paymentHash: string,
  o: { everyMs?: number; timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Outcome> {
  const everyMs = o.everyMs ?? 1000;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (o.timeoutMs ?? 60_000);
  while (now() < until) {
    try {
      // The wallet first: a hold settles in the same transaction that writes the
      // history, so once nothing is held the history already has the payment.
      const w = await cardd.wallet();
      const held = (account === 'pool' ? w.pool : account === 'hosting' ? w.hosting : w.cards.find((c) => c.id === account))?.heldMsat ?? 0;
      const paid = (await cardd.history(account)).find((t) => t.note === `paid ${paymentHash}`);
      if (paid) return { kind: 'paid', cardMsat: -paid.amountMsat, feeMsat: paid.feeMsat };
      if (held === 0) return { kind: 'failed' };
    } catch {
      // Offline for a moment: ask again.
    }
    await sleep(everyMs);
  }
  return { kind: 'unconfirmed' };
}
