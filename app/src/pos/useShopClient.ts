// The till's client for its shop, made once per server: a pairing
// that changes only its names keeps the same client, so what hangs on it (the currency read, the watched sales) isn't
// started again.
import { useMemo } from 'react';

/** make: the client for a host; null while the phone isn't paired. */
export function useShopClient<T>(host: string | undefined, make: (host: string) => T): T | null {
  // make is the caller's, the same for the app's life: only the host decides.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (host ? make(host) : null), [host]);
}
