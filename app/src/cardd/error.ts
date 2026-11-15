// cardd's refusals, as both apps' clients raise them (Karto Wallet's cardd/client.ts, Karto PoS's pos/client.ts).
// A leaf: it imports nothing.

/** cardd's answer when it isn't the one asked for: the HTTP status, cardd's own code for the refusal, and its message. */
export class CarddError extends Error {
  /** body: the refusal's whole answer, for a refusal that carries more than its words (wrong_amount's figure). */
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: Record<string, unknown>) {
    super(message);
  }
}

/** A price or limits in a currency cardd has no rate for yet. */
export const isNoRate = (e: unknown) => e instanceof CarddError && e.code === 'no_rate';

/** A price in a currency that is no longer the shop's: the till rings the sale up again. */
export const isWrongCurrency = (e: unknown) => e instanceof CarddError && e.code === 'wrong_currency';

/** cardd no longer knows this phone's key: another phone restored the server. */
export const isRevoked = (e: unknown) => e instanceof CarddError && e.status === 401 && /unknown or revoked device/.test(e.message);
