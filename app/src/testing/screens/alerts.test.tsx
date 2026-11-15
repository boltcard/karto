// Settings → Alerts rendered: each status's line and the
// buttons it offers, ntfy's steps with the server's address and Copy, and Turn on alerts through the server step to
// cardd. The phone's module and the server are fakes the test sets; register.ts and alertsView.ts are the app's own.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NTFY } from '../../alerts/alertsView';
import { OFFER } from '../../alerts/offer';
import Alerts from '../../app/alerts';
import { CarddError, type PushState } from '../../cardd/client';
import type { PushEndpoint } from '../../native/api';

const NTFY_URL = 'https://karto.example:8443';
const OWN = 'app.cardapp';
const ENDPOINT: NonNullable<PushState['endpoint']> = { transport: 'unifiedpush', origin: NTFY_URL, createdAt: 1_790_000_000, deliveredAt: null, failedAt: null, failure: '', failures: 0 };
const ON: PushState = { vapidPublicKey: 'BEl6', ntfy: NTFY_URL, endpoint: ENDPOINT };
const OFF: PushState = { ...ON, endpoint: null };
const at = (origin: string, topic = 'upAbC'): PushEndpoint => ({ endpoint: `${origin}/${topic}?up=1`, p256dh: 'BPk', auth: 'aGk' });

/** The phone: what the module answers, and the endpoint a registration gives. */
const phone = {
  distributors: [NTFY] as string[], embedded: null as string | null, saved: NTFY as string | null, allowed: true, exempt: true,
  kept: at(NTFY_URL) as PushEndpoint | null, gives: at(NTFY_URL, 'upNew') as PushEndpoint,
};
const listeners = new Set<(e: PushEndpoint) => void>();
const native = {
  pushDistributors: () => phone.distributors,
  pushDistributor: () => phone.saved,
  pushEmbeddedDistributor: () => phone.embedded,
  pushRegister: vi.fn(async (_vapid: string, distributor: string | null) => {
    phone.saved = distributor;
    phone.kept = phone.gives;
    queueMicrotask(() => listeners.forEach((l) => l(phone.gives)));
  }),
  pushUnregister: vi.fn(async () => void (phone.kept = null)),
  pushEndpoint: () => phone.kept,
  notificationsAllowed: () => phone.allowed,
  requestNotifications: async () => phone.allowed,
  ignoringBatteryOptimizations: () => phone.exempt,
  openNtfySettings: vi.fn(),
  addListener: (event: string, l: (e: PushEndpoint) => void) => {
    if (event === 'onPushEndpoint') listeners.add(l);
    return { remove: () => listeners.delete(l) };
  },
};
const server: { state: PushState } = { state: ON };
const cardd = {
  push: vi.fn(async () => server.state),
  setPush: vi.fn(async (r: { endpoint: string; transport: string }) => (server.state = { ...server.state, endpoint: { ...ENDPOINT, origin: new URL(r.endpoint).origin, transport: r.transport as 'fcm' } })),
  dropPush: vi.fn(async () => void (server.state = { ...server.state, endpoint: null })),
  testPush: vi.fn(async () => {}),
};
const store = { alertsSent: async () => null, saveAlertsSent: vi.fn(async () => {}) };
const play = { on: false };

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('../../alerts/store', () => ({
  get isPlayBuild() {
    return play.on;
  },
}));
vi.mock('../../services/server', () => ({ useCardDeps: () => ({ host: 'karto.example' }) }));
/** The services the page sees: the phone's module is the test's. */
const services: { native: object } = { native };
vi.mock('../../services/services', () => ({
  useRouteGuard: () => true, useServices: () => services, alertsClient: () => cardd, walletStore: () => store,
}));

/** A flow runs several awaits deep: 10 s, as two runs timed out at 5 s on a machine busy with a Gradle build. */
const WAIT = { timeout: 10_000 };
// The band's back arrow has no words: left out.
const buttons = () => screen.getAllByRole('button').map((b) => b.textContent).filter(Boolean);
/** The page once the server has answered: its status line shows. */
async function shown(line: string) {
  render(<Alerts />);
  await screen.findByText(line, undefined, WAIT);
}

describe('Settings → Alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(phone, { distributors: [NTFY], embedded: null, saved: NTFY, allowed: true, exempt: true, kept: at(NTFY_URL), gives: at(NTFY_URL, 'upNew') });
    server.state = ON;
    play.on = false;
    services.native = native;
    vi.mocked(useLocalSearchParams).mockReturnValue({});
  });

  it("says alerts are on through the server's ntfy, with Send a test alert and Turn off", async () => {
    await shown("On: through your server's ntfy");
    expect(buttons()).toEqual(['Send a test alert', 'Turn off']);
    fireEvent.click(screen.getByRole('button', { name: 'Send a test alert' }));
    await screen.findByText('Test alert sent: it should show in a moment.', undefined, WAIT);
    expect(cardd.testPush).toHaveBeenCalledTimes(1);
  });

  it("says why a test alert couldn't be sent, beside its button, unless the status line says it", async () => {
    cardd.testPush.mockRejectedValueOnce(new CarddError(404, 'not_found', 'store: not found'));
    await shown("On: through your server's ntfy");
    fireEvent.click(screen.getByRole('button', { name: 'Send a test alert' }));
    await screen.findByText("Couldn't send a test alert: store: not found", undefined, WAIT);
    cardd.testPush.mockRejectedValueOnce(new Error('Network request failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Send a test alert' }));
    await screen.findByText("Couldn't send a test alert: Network request failed", undefined, WAIT);
    // The endpoint refused it: the status line, read again, says what it said.
    cardd.testPush.mockRejectedValueOnce(new CarddError(502, 'push_failed', 'HTTP 410 Gone'));
    server.state = { ...ON, endpoint: { ...ENDPOINT, failures: 1, failure: 'HTTP 410 Gone' } };
    fireEvent.click(screen.getByRole('button', { name: 'Send a test alert' }));
    await screen.findByText("Last alert didn't arrive: HTTP 410 Gone", undefined, WAIT);
    expect(screen.queryByText(/Couldn't send a test alert/)).toBeNull();
  });

  it("says plainly that the iPhone has no alerts yet, on a link to the page there", async () => {
    const iphone = Object.fromEntries(Object.entries(native).filter(([k]) => !k.startsWith('push')));
    services.native = iphone;
    render(<Alerts />);
    expect(await screen.findByText("Alerts aren't on the iPhone yet.", undefined, WAIT)).toBeTruthy();
  });

  it("says On on the Play build's own push, with its line about Google", async () => {
    play.on = true;
    Object.assign(phone, { distributors: [OWN], embedded: OWN, saved: OWN, kept: { ...at('https://fcm.googleapis.com'), endpoint: 'https://fcm.googleapis.com/fcm/send/x' } });
    server.state = { ...ON, endpoint: { ...ENDPOINT, transport: 'fcm', origin: 'https://fcm.googleapis.com' } };
    await shown('On');
    expect(screen.getByText("Alerts come through Google's push, encrypted: Google can't read them.")).toBeTruthy();
    expect(buttons()).toEqual(['Send a test alert', 'Turn off']);
  });

  it('says Off, with Turn on alerts', async () => {
    server.state = OFF;
    phone.kept = null;
    await shown('Off');
    expect(buttons()).toEqual(['Turn on alerts']);
  });

  it("says ntfy is needed, with ntfy's three steps, its store links, the server's address and Copy", async () => {
    Object.assign(phone, { distributors: [], saved: null, kept: null });
    server.state = OFF;
    await shown('Needs the ntfy app');
    for (const words of ['Install ntfy', 'In ntfy: Settings → General → Default server, paste this address', "In ntfy's App info: App battery usage → Unrestricted", NTFY_URL]) {
      expect(screen.getByText(words)).toBeTruthy();
    }
    expect(buttons()).toEqual(['F-Droid', 'Play Store', 'Copy', 'Done, turn on']);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(NTFY_URL);
  });

  it("says ntfy's server must be set first when ntfy gave an endpoint elsewhere", async () => {
    server.state = OFF;
    phone.kept = at('https://ntfy.sh');
    await shown("Set ntfy's server first");
    expect(screen.getByText(NTFY_URL)).toBeTruthy();
    expect(buttons()).toEqual(['Copy', 'Open ntfy', 'Done, turn on']);
  });

  it("asks for Android's permission where notifications are blocked", async () => {
    phone.allowed = false;
    await shown("Allow notifications in Android's settings");
    expect(buttons()).toEqual(['Turn on alerts', 'Turn off']);
  });

  it("says alerts may be late while ntfy isn't exempt from battery saving, with its step", async () => {
    phone.exempt = false;
    await shown("Alerts may be late: ntfy isn't exempt from battery saving");
    expect(screen.getByText("In ntfy's App info: App battery usage → Unrestricted")).toBeTruthy();
    expect(buttons()).toEqual(['Open ntfy', 'Send a test alert', 'Turn off']);
  });

  it("says the last alert didn't arrive, and why", async () => {
    server.state = { ...ON, endpoint: { ...ENDPOINT, failures: 1, failedAt: 1_790_000_100, failure: 'HTTP 410 Gone' } };
    await shown("Last alert didn't arrive: HTTP 410 Gone");
    expect(buttons()).toEqual(['Send a test alert', 'Turn off']);
  });

  it('turns alerts on: the server step first, then the endpoint ntfy gives goes to cardd', async () => {
    server.state = OFF;
    phone.kept = null;
    await shown('Off');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on alerts' }));
    await screen.findByText('In ntfy: Settings → General → Default server, paste this address', undefined, WAIT);
    // ntfy is installed and already exempt from battery saving: only the server step, numbered 1.
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.queryByText('2')).toBeNull();
    expect(screen.queryByText("In ntfy's App info: App battery usage → Unrestricted")).toBeNull();
    expect(native.pushRegister).not.toHaveBeenCalled();
    expect(buttons()).toEqual(['Copy', 'Open ntfy', 'Done, turn on']);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Done, turn on' })));
    await screen.findByText("On: through your server's ntfy", undefined, WAIT);
    expect(native.pushRegister).toHaveBeenCalledWith('BEl6', NTFY, true);
    expect(cardd.setPush).toHaveBeenCalledWith({ endpoint: `${NTFY_URL}/upNew?up=1`, p256dh: 'BPk', auth: 'aGk', transport: 'unifiedpush' });
  });

  it("shows the battery step with the server step, numbered 1 and 2, while ntfy isn't exempt from battery saving", async () => {
    server.state = OFF;
    phone.kept = null;
    phone.exempt = false;
    await shown('Off');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on alerts' }));
    await screen.findByText('In ntfy: Settings → General → Default server, paste this address', undefined, WAIT);
    expect(screen.getByText("In ntfy's App info: App battery usage → Unrestricted")).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('3')).toBeNull();
  });

  // Review Focus 4: ntfy's default server is another (ntfy.sh): the endpoint isn't handed to cardd, and the step shows again.
  it("shows the server step again, and hands cardd nothing, when ntfy gives an endpoint off the server's ntfy", async () => {
    server.state = OFF;
    phone.kept = null;
    phone.gives = at('https://ntfy.sh', 'upZz');
    await shown('Off');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on alerts' }));
    const done = await screen.findByRole('button', { name: 'Done, turn on' }, WAIT);
    await act(async () => fireEvent.click(done));
    await screen.findByText("Set ntfy's server first", undefined, WAIT);
    expect(screen.getByText(NTFY_URL)).toBeTruthy();
    expect(cardd.setPush).not.toHaveBeenCalled();
  });

  it("starts turning alerts on at once from the offer's Turn on alerts", async () => {
    vi.mocked(useLocalSearchParams).mockReturnValue({ start: '1' });
    server.state = OFF;
    phone.kept = null;
    render(<Alerts />);
    await screen.findByText('In ntfy: Settings → General → Default server, paste this address', undefined, WAIT);
  });

  it('turns alerts off on the server and the phone', async () => {
    await shown("On: through your server's ntfy");
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Turn off' })));
    await screen.findByText('Off', undefined, WAIT);
    expect(cardd.dropPush).toHaveBeenCalledTimes(1);
    expect(native.pushUnregister).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(store.saveAlertsSent).toHaveBeenCalledWith(null));
  });

  // The step at the end of setup: the question, Turn on alerts or Not now; the wallet is under the page.
  describe('at the end of setup', () => {
    beforeEach(() => {
      vi.mocked(useLocalSearchParams).mockReturnValue({ setup: '1' });
      server.state = OFF;
      phone.kept = null;
    });

    it('asks, with Turn on alerts and Not now; Not now opens the wallet', async () => {
      render(<Alerts />);
      await screen.findByText(OFFER.text, undefined, WAIT);
      expect(buttons()).toEqual(['Turn on alerts', 'Not now']);
      // The question says it: no "Off" line before alerts were ever on.
      expect(screen.queryByText('Off')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(router.back).toHaveBeenCalledTimes(1);
    });

    it("turns alerts on through ntfy's steps, then opens the wallet", async () => {
      render(<Alerts />);
      await screen.findByText(OFFER.text, undefined, WAIT);
      // The question shows at once; Turn on alerts once the phone and the server have answered.
      await waitFor(() => expect((screen.getByRole('button', { name: 'Turn on alerts' }) as HTMLButtonElement).disabled).toBe(false), WAIT);
      fireEvent.click(screen.getByRole('button', { name: 'Turn on alerts' }));
      const done = await screen.findByRole('button', { name: 'Done, turn on' }, WAIT);
      await act(async () => fireEvent.click(done));
      await screen.findByText("On: through your server's ntfy", undefined, WAIT);
      // No Turn off in setup: the way on is the wallet.
      expect(buttons()).toEqual(['Send a test alert', 'Open the wallet']);
      expect(screen.queryByText(OFFER.text)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Open the wallet' }));
      expect(router.back).toHaveBeenCalledTimes(1);
    });

    it("asks with ntfy's steps when there is no ntfy, and Not now", async () => {
      phone.distributors = [];
      phone.saved = null;
      render(<Alerts />);
      await screen.findByText(OFFER.text, undefined, WAIT);
      expect(screen.getByText('Install ntfy')).toBeTruthy();
      expect(buttons()).toEqual(['F-Droid', 'Play Store', 'Copy', 'Done, turn on', 'Not now']);
    });
  });
});
