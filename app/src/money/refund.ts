// The rules of a refund of a till sale in Karto Wallet: which amount
// (the sale's own unit first), from which account (Shop, else all of it from Pool), and what the sale's page offers.
import type { ReturnAddress, Tx } from '../cardd/client';
import { fiatText, isCode, minorText, minorToMsat, type Rated } from './fiat';
import { feeBudgetMsat } from './send';
import { thousands } from './words';

type TxSale = NonNullable<Tx['sale']>;

/** One amount the owner may give back: msat, the choice's title, and the line under it. */
export type RefundChoice = { msat: number; title: string; line: string };

const sat = (msat: number) => `${thousands(Math.floor(msat / 1000))} sat`;

/**
 * The amounts a refund may give back, the first chosen. A sale priced in a currency: its price at today's rate, then
 * the sats it took; with no rate in that currency, the sats alone, saying why. A sale rung up in sat: its sats.
 */
export function refundChoices(sale: TxSale, r: Rated | null): RefundChoice[] {
  const took = sale.priceMsat;
  const p = sale.price && isCode(sale.price.currency) ? sale.price : null;
  if (!p) return [{ msat: took, title: sat(took), line: '' }];
  if (!r || r.currency !== p.currency) return [{ msat: took, title: sat(took), line: `No rate today: the refund is the ${sat(took)} the sale took.` }];
  const now = minorToMsat(p.minor, r);
  return [
    { msat: now, title: minorText(p.minor, p.currency), line: `${sat(now)} at today's rate. The price as it was rung up.` },
    { msat: took, title: sat(took), line: `What the sale took. ${fiatText(took, r)} at today's rate.` },
  ];
}

/**
 * Which account pays: Shop when its available balance covers the amount and, for a Lightning payment, the fee
 * budget; otherwise all of it from Pool, with the warning; neither, and the refund can't be made.
 */
export function refundFrom(shopAvailMsat: number, poolAvailMsat: number, msat: number, withFee: boolean): { from: 'shop' | 'pool'; warning: string | null } | { short: string } {
  const need = msat + (withFee ? feeBudgetMsat(msat) : 0);
  if (shopAvailMsat >= need) return { from: 'shop', warning: null };
  if (poolAvailMsat >= need) return { from: 'pool', warning: `From Pool: Shop has only ${sat(shopAvailMsat)}.` };
  return { short: 'Not enough in Shop or Pool for this refund.' };
}

/** What the sale's page offers: the button and its line, Refunding… while one is on its way, Refunded, or the line for an older server. */
export type RefundOffer = { kind: 'button'; line: string } | { kind: 'pending' } | { kind: 'refunded'; at: number } | { kind: 'old-server' };

export function refundButton(sale: TxSale): RefundOffer {
  if (sale.refund === undefined) return { kind: 'old-server' };
  if (sale.refund?.state === 'paid') return { kind: 'refunded', at: sale.refund.at ?? 0 };
  if (sale.refund?.state === 'pending') return { kind: 'pending' };
  const to = sale.returnAddress ? 'to the card they paid with' : 'to an invoice or Lightning address they show you';
  return { kind: 'button', line: `Gives the customer the whole sale back, ${to}.` };
}

/** The sale page's "Return address": another server's host, or this wallet's own card by name. */
export function returnAddressText(a: ReturnAddress): string {
  return 'card' in a && a.card ? `${a.card.name}, on this wallet` : `The card's, from ${(a as { host: string }).host}`;
}

/** Check's To for a return address: the card it was paid with and its server, or this wallet's card. */
export function returnAddressTo(a: ReturnAddress): string {
  return 'card' in a && a.card ? `${a.card.name}, on this wallet` : `The card it was paid with, through ${(a as { host: string }).host}`;
}
