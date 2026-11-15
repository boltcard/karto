import { describe, expect, it, vi } from 'vitest';
import { CarddError, type PushState } from '../cardd/client';
import { AppStore } from '../store/store';
import { nodeSqlite } from '../testing/nodeSqlite';
import { OFFER, offerDue, offerShown } from './offer';

const STATE: PushState = { vapidPublicKey: 'BEl6', ntfy: 'https://vm-1.lnvps.cloud:8443', endpoint: null };
const answers = () => ({ push: vi.fn(async () => STATE) });

// After setup, and once for a wallet updated to this version, the wallet offers alerts; then only Settings.
describe('the alerts offer', () => {
  it('is made once: due on a phone never offered, not after it was shown', async () => {
    const store = await AppStore.open(nodeSqlite());
    expect(await offerDue({ store, supported: true, cardd: answers() })).toBe(true);
    await offerShown({ store });
    expect(await offerDue({ store, supported: true, cardd: answers() })).toBe(false);
  });

  it('is not made where alerts are already on, or where the phone has no alerts', async () => {
    const store = await AppStore.open(nodeSqlite());
    expect(await offerDue({ store, supported: false, cardd: answers() })).toBe(false);
    await store.saveAlertsSent({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', createdAt: 1, vapid: 'B' });
    expect(await offerDue({ store, supported: true, cardd: answers() })).toBe(false);
  });

  // A wallet updated before its server has had Update server keeps its one offer for later.
  it("waits for a server that can send alerts, and isn't used up meanwhile", async () => {
    const store = await AppStore.open(nodeSqlite());
    const old = { push: vi.fn(async (): Promise<PushState> => Promise.reject(new CarddError(404, 'bad_response', 'GET /api/v1/push → HTTP 404: 404 page not found'))) };
    expect(await offerDue({ store, supported: true, cardd: old })).toBe(false);
    const away = { push: vi.fn(async (): Promise<PushState> => Promise.reject(new Error('Network request failed'))) };
    expect(await offerDue({ store, supported: true, cardd: away })).toBe(false);
    expect(await store.alertsOffered()).toBe(false);
    expect(await offerDue({ store, supported: true, cardd: answers() })).toBe(true);
  });

  it('asks the server only when the offer is otherwise due', async () => {
    const store = await AppStore.open(nodeSqlite());
    await offerShown({ store });
    const cardd = answers();
    await offerDue({ store, supported: true, cardd });
    expect(cardd.push).not.toHaveBeenCalled();
  });

  it('asks in its words', () => {
    expect(OFFER).toEqual({ text: 'Get a notification when money arrives or a card is used?', yes: 'Turn on alerts', no: 'Not now' });
  });
});
