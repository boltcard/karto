// The one offer to turn alerts on, as a sheet over the
// wallet: the first time it opens after setup, and once for a wallet updated to this version, as soon as its server
// can send alerts (asked each time the wallet is shown until then). Counted as made when it shows; then only
// Settings → Alerts. Turn on alerts opens that page and starts turning them on. While Home holds it (the wallet's
// name is being asked, or the wallet hasn't answered yet) it neither asks, counts nor shows; it asks again once
// the hold is let go.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { OFFER, offerDue, offerShown } from '../alerts/offer';
import { alertsSupported } from '../alerts/register';
import { alertsClient, useServices, walletStore } from '../services/services';
import { Body, Button, Sheet } from './ui';

/** host: this wallet's server. hold: not now (Home's other ask is up, or due). onOpen: told when it shows and goes. */
export function AlertsOffer({ host, hold = false, onOpen }: { host: string; hold?: boolean; onOpen?: (open: boolean) => void }) {
  const sv = useServices();
  const [shown, setShownState] = useState(false);
  const told = useRef(onOpen);
  told.current = onOpen;
  const setShown = useCallback((on: boolean) => {
    setShownState(on);
    told.current?.(on);
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (hold) return;
      let live = true;
      const store = walletStore(sv);
      void offerDue({ store, supported: alertsSupported(sv.native), cardd: alertsClient(sv, host) })
        .then(async (due) => {
          if (!due || !live) return;
          await offerShown({ store });
          if (live) setShown(true);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [sv, host, hold, setShown]),
  );
  const yes = () => {
    setShown(false);
    router.push({ pathname: '/alerts', params: { start: '1' } });
  };
  return (
    <Sheet visible={shown} onClose={() => setShown(false)}>
      <Body>{OFFER.text}</Body>
      <Button title={OFFER.yes} onPress={yes} />
      <Button title={OFFER.no} kind="secondary" onPress={() => setShown(false)} />
    </Sheet>
  );
}
