// Karto PoS's own client: it knows only cardd's
// /api/v1/pos/ routes and the pairing call, and signs as Karto Wallet's does (cardd/signed.ts). It has no call
// that reads a balance, a card or a key, because a PoS phone takes payments and nothing more.
import { hexToBytes } from '@noble/hashes/utils.js';
import { keyId } from '../cardd/deviceauth';
import { CarddError } from '../cardd/error';
import { isName } from '../cardd/names';
import { readJson, refusal, SignedCalls } from '../cardd/signed';
import type { FetchFn } from '../lightning/lightning';
import type { CurrencyCode, Fiat } from '../money/fiat';
import type { DeviceKey } from '../native/deviceKey';

/**
 * A sale as cardd answers it to a PoS phone (server/internal/api saleJSON): amountMsat is its price; invoice
 * while it is open; paidAt and txId (its place in the ledger, which the list's next page is asked before) once it
 * is paid. method is '' until then, 'card' when a card was read for it, else 'qr'. Never what the shop received.
 */
export type PosSale = {
  id: string; amountMsat: number; state: 'open' | 'paid' | 'expired' | 'cancelled'; method: '' | 'card' | 'qr';
  device: { keyId: string; name: string }; created: number; expires: number;
  invoice?: string; paidAt?: number; txId?: number;
  /** The price it was rung up at, in the shop's currency then; absent for a sale typed in sats. */
  price?: { currency: CurrencyCode; minor: number };
  /** Its refund from Karto Wallet: null for none, absent from a cardd with no refunds. */
  refund?: null | { state: 'pending' | 'paid'; txId?: number; at?: number; amountMsat?: number };
};
/** One local day's paid sales: day is its first second (unix), totalMsat their prices. */
export type PosDay = { day: number; count: number; totalMsat: number };

/**
 * Pairs this phone with a shop: the one call made before it is a device of the server, unsigned, the code its
 * only credential. publicKey: the phone's device key, uncompressed, in hex. Refused: bad_code (unknown, used or
 * run out, all alike), key_known (this key is already a device there). The server is whichever one the link
 * named, so its answer is taken only if it is a shop's: this phone's own key id, and a name cardd could have
 * given; any other is a not_a_shop error, and nothing of it goes further. wallet: the wallet's name, '' when
 * it has none, the server is older, or what it sent isn't a name: it is only shown, so it never fails the pairing.
 */
export async function pairPhone(fetchFn: FetchFn, host: string, code: string, publicKey: string): Promise<{ keyId: string; name: string; wallet: string }> {
  const res = await fetchFn(`https://${host}/pos/pair`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ code, publicKey }),
  });
  const parsed = await readJson(res, 'POST', '/pos/pair');
  if (!res.ok) throw refusal(res, parsed);
  const answer = (parsed ?? {}) as { keyId?: unknown; name?: unknown; wallet?: unknown };
  if (answer.keyId !== keyId(hexToBytes(publicKey)) || !isName(answer.name)) {
    throw new CarddError(res.status, 'not_a_shop', "POST /pos/pair: the answer isn't a shop's");
  }
  return { keyId: answer.keyId, name: answer.name, wallet: isName(answer.wallet) ? answer.wallet : '' };
}

export class PosClient {
  private readonly signed: SignedCalls;

  constructor(o: { fetch: FetchFn; host: string; key: Pick<DeviceKey, 'authorize'>; now?: () => number }) {
    this.signed = new SignedCalls(o);
  }

  /**
   * What this phone is to the server: its name in the shop, and the wallet's name ('' when it has none; absent
   * from an older cardd). Both as the server sent them: the caller checks them (pos/names.ts refreshPaired). A 401
   * "unknown or revoked device" (isRevoked) means it was removed.
   */
  me(): Promise<{ keyId: string; name: string; role: string; wallet?: string }> {
    return this.signed.call('GET', '/api/v1/pos/me');
  }

  /** Unpair this phone: the server refuses its key from then on. */
  async forget(): Promise<void> {
    await this.signed.call('DELETE', '/api/v1/pos/me');
  }

  /**
   * Makes a sale once per id (a UUID this phone made), in whole sats or at a price in the shop's currency, which
   * cardd turns into sats at its rate (refused wrong_currency, or no_rate). The same id and amount again
   * answers the same sale, a priced one with its first sats. It cancels this phone's earlier open sale.
   */
  async newSale(id: string, amount: { sat: number } | { price: { currency: CurrencyCode; minor: number } }): Promise<PosSale> {
    const body = 'sat' in amount ? { id, amountSat: amount.sat } : { id, price: { currency: amount.price.currency, minor: amount.price.minor } };
    return (await this.signed.call<{ sale: PosSale }>('POST', '/api/v1/pos/sales', body)).sale;
  }

  /** The shop's currency and its rate, read when the till opens and every 5 minutes it is in front; never on Charge's way. */
  async fiat(): Promise<Fiat> {
    return (await this.signed.call<{ fiat: Fiat }>('GET', '/api/v1/pos/fiat')).fiat;
  }

  /**
   * Reads a sale: an open one past its time reads as expired. With waitS the shop may hold its answer that many
   * seconds, until the sale is paid; a shop that doesn't hold answers at once.
   */
  async sale(id: string, waitS?: number): Promise<PosSale> {
    return (await this.signed.call<{ sale: PosSale }>('GET', `/api/v1/pos/sales/${id}${waitS ? `?wait=${waitS}` : ''}`)).sale;
  }

  /**
   * Tells the server a card was read for this phone's sale, so it is "by card" once paid, with the card's return link
   * when it gave one, for a refund from Karto Wallet.
   */
  async cardRead(id: string, returnLink?: string): Promise<PosSale> {
    return (await this.signed.call<{ sale: PosSale }>('POST', `/api/v1/pos/sales/${id}/card`, returnLink ? { returnLink } : undefined)).sale;
  }

  /** Cancels this phone's sale. Its invoice can still be paid by a wallet that already has it: the sale then reads paid. */
  async cancel(id: string): Promise<PosSale> {
    return (await this.signed.call<{ sale: PosSale }>('POST', `/api/v1/pos/sales/${id}/cancel`)).sale;
  }

  /** The paid sales this phone took, newest first: up to limit (50; at most 100) before the txId before. */
  async sales(page: { before?: number; limit?: number } = {}): Promise<PosSale[]> {
    const q = new URLSearchParams();
    if (page.before) q.set('before', String(page.before));
    if (page.limit) q.set('limit', String(page.limit));
    const query = q.size ? `?${q}` : '';
    return (await this.signed.call<{ sales: PosSale[] }>('GET', `/api/v1/pos/sales${query}`)).sales;
  }

  /** The paid sales counted by this phone's local day, newest first: offsetMin is its minutes east of UTC; up to limit days (30; at most 90). */
  async days(offsetMin: number, limit?: number): Promise<PosDay[]> {
    const q = new URLSearchParams({ offset: String(offsetMin) });
    if (limit) q.set('limit', String(limit));
    return (await this.signed.call<{ days: PosDay[] }>('GET', `/api/v1/pos/sales/days?${q}`)).days;
  }
}
