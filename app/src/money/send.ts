// Send out: the amount check before the screen lock, and
// watching a send that is still on its way.
import type { CarddClient } from '../cardd/client';
import { CarddError } from '../cardd/error';
import { confirmPayment } from './confirm';
import type { Rated } from './fiat';
import { apartText, type View } from './view';

/** cardd's fee budget, what a hold sets aside (server/internal/ledger FeeBudgetMsat): 0.5% rounded up, plus 5 sat. */
export const feeBudgetMsat = (amountMsat: number) => Math.floor((amountMsat * 5 + 999) / 1000) + 5_000;
/**
 * cardd's least budget for a Send out of Pool, on a server that allows it (its wallet answer carries sendableMsat):
 * phoenixd's trampoline fee, 4 sat + 0.4% rounded down to the msat, and 1 sat (ledger.MinFeeBudgetMsat).
 */
export const minFeeBudgetMsat = (amountMsat: number) => 4_000 + Math.floor((amountMsat * 4) / 1000) + 1_000;

/** The routing fee to expect: phoenixd v0.9.2's trampoline fee, 4 sat + 0.4%, in whole sats rounded up. */
export const feeEstimateSat = (amountMsat: number) => Math.ceil((4_000 + Math.floor((amountMsat * 4_000) / 1_000_000)) / 1000);

/**
 * Why pool can't send amountMsat, or null: it must fit with its fee budget,
 * and an amount the person typed must be whole sats (an invoice's own amount
 * is paid as it is).
 */
export function sendProblem(poolAvailableMsat: number, amountMsat: number, o: { typed?: boolean; tight?: boolean } = {}, v: View = 'sat', r: Rated | null = null): string | null {
  if (!(amountMsat > 0)) return 'Enter an amount.';
  if ((o.typed ?? true) && amountMsat % 1000 !== 0) return 'Send whole sats.';
  // tight: a server whose least budget is phoenixd's fee and 1 sat (minFeeBudgetMsat).
  const need = amountMsat + (o.tight ? minFeeBudgetMsat : feeBudgetMsat)(amountMsat);
  if (need <= poolAvailableMsat) return null;
  const [has, needs] = apartText(poolAvailableMsat, need, v, r);
  return `Pool has ${has}; this needs up to ${needs} with routing fees.`;
}

/**
 * The most Pool can send out: the largest whole-sat amount (msat) whose fee budget fits beside it in
 * poolAvailableMsat, as cardd holds a send (renew.affordableSat's rule); 0 when none fits. Exact msat, as cardd checks.
 */
export function sendAllMsat(poolAvailableMsat: number): number {
  let sat = Math.floor((poolAvailableMsat - 5_000) / 1005); // 1000 msat + its 0.5% budget, plus 5 sat
  while (sat > 0 && sat * 1000 + feeBudgetMsat(sat * 1000) > poolAvailableMsat) sat--;
  return Math.max(sat, 0) * 1000;
}

/** How a send watched ended; a failure's reason is phoenixd's, in the person's words, when cardd gave one. */
export type SendOutcome = { kind: 'sent'; feeMsat: number } | { kind: 'failed'; reason?: string } | { kind: 'unconfirmed' };

/**
 * How long a send is watched: longer than cardd waits (ledger.unsentGrace,
 * 2 minutes) before releasing a payment phoenixd has no record of, so a send
 * cut off by a restart still gets its answer on screen.
 */
export const WATCH_SEND_MS = 150_000;

/** Watches pool until the send of paymentHash is settled or released (or WATCH_SEND_MS passes). */
export async function watchSend(
  cardd: Pick<CarddClient, 'wallet' | 'history'>,
  paymentHash: string,
  o?: Parameters<typeof confirmPayment>[3],
): Promise<SendOutcome> {
  const r = await confirmPayment(cardd, 'pool', paymentHash, { timeoutMs: WATCH_SEND_MS, ...o });
  return r.kind === 'paid' ? { kind: 'sent', feeMsat: r.feeMsat } : r;
}

/**
 * Follows a send cardd answered pending, by its request id: GET /send/{id} held up to 20 s at a time until
 * the send ends, or WATCH_SEND_MS passes. A server of schema 10 has it; an offer's pending send has no hash to watch.
 * cardd knowing no send by that id is no answer to wait for: unconfirmed at once (Pool's history will say).
 */
export async function followSend(
  cardd: Pick<CarddClient, 'sendState'>,
  id: string,
  o: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SendOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (o.timeoutMs ?? WATCH_SEND_MS);
  while (now() < until) {
    try {
      const a = await cardd.sendState(id, 20);
      if (a.status === 'sent') return { kind: 'sent', feeMsat: a.feeMsat ?? 0 };
      if (a.status === 'failed') return a.reason ? { kind: 'failed', reason: a.reason } : { kind: 'failed' };
    } catch (e) {
      if (e instanceof CarddError && (e.status === 404 || e.code === 'not_found')) return { kind: 'unconfirmed' };
      // Offline for a moment: ask again.
    }
    // A cardd that answered at once (a held read cut short) isn't asked again in a busy loop.
    await sleep(1000);
  }
  return { kind: 'unconfirmed' };
}
