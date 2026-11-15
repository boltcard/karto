// Whose till this is: the wallet's name and the till's own, as
// the till shows them, and how a read of /pos/me updates the pairing it keeps. Names are only ever shown, so one that
// isn't a name (cardd/names.ts) is ignored rather than refused.
import { isName } from '../cardd/names';
import type { Paired } from './settings';

/** Under the pad: "Pixel 9a · Till 1", or the server's address while the wallet has no name. */
export const tillLine = (p: Paired): string => `${p.wallet || p.host} · ${p.name}`;

/** This PoS's Wallet fact. */
export const walletFact = (p: Paired): string => p.wallet || 'Not named yet';

/**
 * The pairing after a read of /pos/me, or null when nothing in it changes. A name that isn't one is ignored; an
 * absent wallet (an older cardd) is no news; '' is the wallet's name gone (a restore from an older backup).
 */
export function refreshPaired(p: Paired, me: { name?: unknown; wallet?: unknown }): Paired | null {
  const name = isName(me.name) ? me.name : p.name;
  const wallet = me.wallet === '' || isName(me.wallet) ? me.wallet : (p.wallet ?? '');
  return name === p.name && wallet === (p.wallet ?? '') ? null : { ...p, name, wallet };
}
