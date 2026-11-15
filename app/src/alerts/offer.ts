// The one offer to turn alerts on: after setup, and once for
// a wallet updated to this version, then only Settings → Alerts. It is counted as made when it is shown, and is due
// only once the server can send alerts: a wallet updated before its server keeps it for a later visit to the wallet.
import type { CarddClient } from '../cardd/client';
import type { AppStore } from '../store/store';

export const OFFER = { text: 'Get a notification when money arrives or a card is used?', yes: 'Turn on alerts', no: 'Not now' } as const;

/** supported: the phone has alerts (alerts/register.ts alertsSupported). cardd: this wallet's server, asked last. */
export async function offerDue(d: { store: Pick<AppStore, 'alertsOffered' | 'alertsSent'>; supported: boolean; cardd: Pick<CarddClient, 'push'> }): Promise<boolean> {
  if (!d.supported || (await d.store.alertsOffered())) return false;
  // Alerts already on (turned on in Settings first): nothing to offer.
  if ((await d.store.alertsSent()) !== null) return false;
  // A server without the push API (before Update server), or one not answering now: another time.
  try {
    await d.cardd.push();
    return true;
  } catch {
    return false;
  }
}

export const offerShown = (d: { store: Pick<AppStore, 'setAlertsOffered'> }): Promise<void> => d.store.setAlertsOffered();
