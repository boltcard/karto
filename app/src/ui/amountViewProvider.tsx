// The wallet's AmountViewWith wired to the app: the phone's AppStore
// for the view, the server watch's last wallet answer for the currency and its rate, and the watch's client for
// Settings' currency list. Mounted once, in services/server.tsx, inside ServerProvider's context and around the screens and the tap sheet. Apart from amountView.tsx so that
// what draws an amount never brings the services with it (a screen test renders it without them).
import { getLocales } from 'expo-localization';
import { useMemo, type ReactNode } from 'react';
import { useServer } from '../services/server';
import { useServices, walletStore } from '../services/services';
import { AmountViewWith, type ViewKv, type ViewServer } from './amountView';

/** The phone's region currency, for a server that has never had one. */
const regionCode = () => getLocales()[0]?.currencyCode ?? null;

export function AmountViewProvider({ children }: { children: ReactNode }) {
  const sv = useServices();
  const { snap } = useServer();
  // Read from the store; written through the wallet's epoch, so nothing lands while a wallet is taken off the phone.
  const kv = useMemo<ViewKv>(
    () => ({
      amountView: () => sv.store.amountView(),
      setAmountView: (view) => walletStore(sv).setAmountView(view),
      showMsat: () => sv.store.showMsat(),
      setShowMsat: (on) => walletStore(sv).setShowMsat(on),
      typingUnit: () => sv.store.typingUnit(),
      setTypingUnit: (unit) => walletStore(sv).setTypingUnit(unit),
    }),
    [sv],
  );
  const deps = snap.deps;
  const server = useMemo<ViewServer | null>(() => (deps ? { host: deps.host, setCurrency: (code) => deps.cardd.setCurrency(code) } : null), [deps]);
  return (
    <AmountViewWith kv={kv} answer={snap.wallet} server={server} region={regionCode}>
      {children}
    </AmountViewWith>
  );
}
