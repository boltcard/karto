// The end of the setup (onboarding, and Rebuild
// server): how long the server is paid for is read behind a spinner, and then one page says it worked,
// with one button to the wallet. Not a route: the app closed on it opens on the wallet. When alerts can be offered
// the button is Next: the wallet opens with the Alerts step over it (app/alerts.tsx, setup=1), counted as the
// one offer so the wallet's own sheet doesn't ask again. A server whose wallet has no name yet (every new one;
// a restore's or a rebuild's keeps the name it had) puts the Name this wallet page first (app/wallet-name.tsx),
// which then opens the Alerts step and counts it.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { offerDue, offerShown } from '../alerts/offer';
import { alertsSupported } from '../alerts/register';
import { DONE_SYNC_MS, hostingSyncer } from '../money/hosting';
import type { OnboardingState } from '../onboarding/machine';
import { readyView } from '../onboarding/progress';
import { useServer } from '../services/server';
import { alertsClient, syncHostingIfDue, useServices, walletStore } from '../services/services';
import { askedThisRun } from '../wallet/walletName';
import { ResultPage } from './money';
import { Screen } from './ui';
import { useAndroidBack } from './useBack';

/** s: the finished state (its step is done). title: the setup screen's, kept in the band. */
export function SetupDone({ s, title }: { s: OnboardingState; title: string }) {
  const sv = useServices();
  const { watch } = useServer();
  const [read, setRead] = useState(false);
  // The Alerts step follows: asked while the page reads, within the same wait.
  const [alertsNext, setAlertsNext] = useState(false);
  // The name page follows: unless the server's wallet answers with a name, or with none to keep (an older
  // cardd). A read that fails or is late asks: the page is prefilled, and leaving it costs nothing.
  const [nameNext, setNameNext] = useState(true);
  // The read is over: a late answer about alerts no longer turns the button into Next under the person's finger.
  const shown = useRef(false);
  // The button or Back has been pressed: a second press while the first awaits does nothing.
  const going = useRef(false);

  useEffect(() => {
    // The new server's cardd knows nothing of hosting yet: read its VM's date before the page shows.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let left = false;
    const wait = new Promise((r) => (timer = setTimeout(r, DONE_SYNC_MS)));
    const host = s.host?.hostname;
    const offer = host
      ? offerDue({ store: walletStore(sv), supported: alertsSupported(sv.native), cardd: alertsClient(sv, host) })
          .then((due) => !left && !shown.current && setAlertsNext(due))
          .catch(() => {})
      : null;
    const named = host
      ? Promise.resolve()
          .then(() => alertsClient(sv, host).wallet())
          .then((w) => !left && !shown.current && setNameNext(w.name === ''))
          .catch(() => {})
      : null;
    void Promise.race([Promise.all([syncHostingIfDue(sv, { force: true, state: s }).catch(() => null), offer, named]), wait]).then(() => {
      shown.current = true;
      if (!left) setRead(true);
    });
    // Left meanwhile: nothing to show.
    return () => {
      left = true;
      clearTimeout(timer);
    };
    // Once: s is the finished state, which no longer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async () => {
    if (going.current) return;
    going.current = true;
    // Counted before the wallet shows, so its sheet finds the offer made. Not counted: no step, and the sheet asks.
    // With the name page first, that page counts it, as it opens the step.
    const step = alertsNext && !nameNext && (await offerShown({ store: walletStore(sv) }).then(() => true, () => false));
    watch.forget(); // the wallet waits for the saved server rather than drawing the one it held
    // Nothing stays under the wallet. In the run of the app that made the wallet, the screen the app started on is
    // still at the bottom (Welcome, or the wallet it found), drawn as it was before there was a server, and its
    // guard was asked once, when it was made. Left there, a Back from a page opened over the wallet's place showed
    // it again (seen on an iPhone: Settings, Rebuild server, the arrow: Welcome, on a phone with a wallet).
    if (router.canDismiss()) router.dismissAll();
    // Asked here, before the wallet shows: its own ask (WalletNameAsk) can't open under the name page.
    if (nameNext && s.host?.hostname) askedThisRun.add(s.host.hostname);
    router.replace('/home');
    if (nameNext) router.push({ pathname: '/wallet-name', params: { setup: '1', alerts: alertsNext ? '1' : '0' } });
    else if (step) router.push({ pathname: '/alerts', params: { setup: '1' } });
  };
  // Android's Back on the ready page opens the wallet, as its button does. During the read it does nothing: the
  // page is seconds away, and Back would otherwise leave the app with the wallet still holding the old server.
  useAndroidBack(() => {
    if (read) void open();
    return true;
  });

  // Up to DONE_SYNC_MS: the forced sync at done (a bare spinner said nothing).
  if (!read) return <Screen title={title} busy busyText="Reading from LNVPS how long the new server is paid for…" />;
  const nowS = Date.now() / 1000;
  return (
    <Screen title={title}>
      <ResultPage view={readyView(s, hostingSyncer.lnvpsExpires, nowS, -new Date().getTimezoneOffset())} onDone={() => void open()} done={alertsNext || nameNext ? 'Next' : 'Open the wallet'} />
    </Screen>
  );
}
