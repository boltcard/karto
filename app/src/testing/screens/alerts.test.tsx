// Settings → Alerts rendered: each status's line and the
// buttons it offers once on; the checklist that turns them on through ntfy (install, the server's address, battery,
// turn on), each step ticking as the phone sees it; the one press on the Play build; and the step at the end of
// set-up: the question, Finish later, Alerts are on. The phone's module and the server are fakes the test sets;
// register.ts and alertsView.ts are the app's own.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK, batteryHow, NTFY, PERMISSION_AHEAD } from '../../alerts/alertsView';
import Alerts from '../../app/alerts';
import { CarddError, type PushState } from '../../cardd/client';
import type { PushEndpoint } from '../../native/api';
import type { NtfyPasted } from '../../store/store';

const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn(async () => undefined) }));
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>();
  // react-native-web's Linking has no openSettings; the page reads Android's API level for the battery words.
  return { ...rn, Linking: { ...rn.Linking, openSettings }, Platform: { ...rn.Platform, OS: 'android', Version: 35 } };
});

const NTFY_URL = 'https://karto.example:8443';
const OWN = 'tech.whitewolf.karto.dev';
const ENDPOINT: NonNullable<PushState['endpoint']> = { transport: 'unifiedpush', origin: NTFY_URL, createdAt: 1_790_000_000, deliveredAt: null, failedAt: null, failure: '', failures: 0 };
const ON: PushState = { vapidPublicKey: 'BEl6', ntfy: NTFY_URL, endpoint: ENDPOINT };
const OFF: PushState = { ...ON, endpoint: null };
const at = (origin: string, topic = 'upAbC'): PushEndpoint => ({ endpoint: `${origin}/${topic}?up=1`, p256dh: 'BPk', auth: 'aGk' });

/** The phone: what the module answers, and the endpoint a registration gives. */
const phone = {
  distributors: [NTFY] as string[], embedded: null as string | null, saved: NTFY as string | null, allowed: true, grant: true, exempt: true,
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
  requestNotifications: vi.fn(async () => (phone.allowed = phone.grant)),
  ignoringBatteryOptimizations: () => phone.exempt,
  openNtfySettings: vi.fn(),
  openBatterySettings: vi.fn(),
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
const store = {
  pasted: null as NtfyPasted | null,
  alertsSent: async () => null,
  saveAlertsSent: vi.fn(async () => {}),
  ntfyPasted: async () => store.pasted,
  saveNtfyPasted: vi.fn(async (p: NtfyPasted | null) => void (store.pasted = p)),
};
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
const press = (name: string) => act(async () => fireEvent.click(screen.getByRole('button', { name })));
/** The page once the server has answered: its status line shows. */
async function shown(line: string) {
  render(<Alerts />);
  await screen.findByText(line, undefined, WAIT);
}
/** The app comes back to the front (react-native-web's AppState follows the page's visibility). */
const comeBack = () =>
  act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
/** The checklist, once shown: its heading and the line under it. */
const checklist = (under: string) => screen.findByText(under, undefined, WAIT);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(phone, { distributors: [NTFY], embedded: null, saved: NTFY, allowed: true, grant: true, exempt: true, kept: at(NTFY_URL), gives: at(NTFY_URL, 'upNew') });
  server.state = ON;
  store.pasted = null;
  play.on = false;
  services.native = native;
  vi.mocked(useLocalSearchParams).mockReturnValue({});
});

describe('Settings → Alerts, once on', () => {
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

  it('says plainly that the iPhone has no alerts yet, on a link to the page there', async () => {
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

  it("asks for Android's permission where notifications are blocked, and opens Android's settings when refused", async () => {
    phone.allowed = false;
    phone.grant = false;
    await shown("Allow notifications in Android's settings");
    expect(buttons()).toEqual(['Turn on alerts', 'Turn off']);
    await press('Turn on alerts');
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1), WAIT);
  });

  it("says alerts may be late while ntfy isn't exempt from battery saving, with a button to its setting", async () => {
    phone.exempt = false;
    await shown("Alerts may be late: ntfy isn't exempt from battery saving");
    expect(screen.getByText(`So Android doesn't hold alerts back to save battery. ${batteryHow(35)}`)).toBeTruthy();
    expect(buttons()).toEqual(["Open ntfy's battery setting", 'Send a test alert', 'Turn off']);
    fireEvent.click(screen.getByRole('button', { name: "Open ntfy's battery setting" }));
    expect(native.openBatterySettings).toHaveBeenCalledWith(NTFY);
  });

  it("says the last alert didn't arrive, and why", async () => {
    server.state = { ...ON, endpoint: { ...ENDPOINT, failures: 1, failedAt: 1_790_000_100, failure: 'HTTP 410 Gone' } };
    await shown("Last alert didn't arrive: HTTP 410 Gone");
    expect(buttons()).toEqual(['Send a test alert', 'Turn off']);
  });

  it('turns alerts off on the server and the phone, and then shows the checklist', async () => {
    await shown("On: through your server's ntfy");
    await press('Turn off');
    await checklist('Set up alerts');
    expect(cardd.dropPush).toHaveBeenCalledTimes(1);
    expect(native.pushUnregister).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(store.saveAlertsSent).toHaveBeenCalledWith(null));
  });

  it('says Checking until the server answers, with no checklist yet', async () => {
    let answer = (_s: PushState) => {};
    cardd.push.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    render(<Alerts />);
    await screen.findByText('Checking…', undefined, WAIT);
    expect(screen.queryByText('Set up alerts')).toBeNull();
    await act(async () => answer(OFF));
  });

  it('says a server from before alerts needs Update server, with no checklist', async () => {
    cardd.push.mockRejectedValue(new CarddError(404, 'bad_response', 'GET /api/v1/push → HTTP 404: 404 page not found'));
    render(<Alerts />);
    await screen.findByText('Your server needs Update server before it can send alerts.', undefined, WAIT);
    expect(screen.queryByText('Set up alerts')).toBeNull();
    cardd.push.mockReset();
    cardd.push.mockImplementation(async () => server.state);
  });

  // On, then ntfy's default set back: the server keeps the older endpoint, the phone's new one is elsewhere.
  it("shows the checklist at the server step, naming the server ntfy used, once a registration went elsewhere", async () => {
    phone.kept = at('https://ntfy.sh', 'upZz');
    render(<Alerts />);
    await screen.findByText('ntfy is still using ntfy.sh', undefined, WAIT);
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
  });
});

describe('Settings → Alerts, turning on through the checklist', () => {
  beforeEach(() => {
    server.state = OFF;
    phone.kept = null;
  });

  it("puts the checklist away when a later read of the server fails, saying why", async () => {
    render(<Alerts />);
    await checklist('Step 2 of 4');
    cardd.push.mockRejectedValueOnce(new Error('offline'));
    await comeBack();
    await screen.findByText("Couldn't check alerts: offline", undefined, WAIT);
    expect(screen.queryByText('Set up alerts')).toBeNull();
    // Answering again: the checklist is back.
    await comeBack();
    await checklist('Step 2 of 4');
  });

  it("offers Try again when a read of the server fails, and the checklist comes back when it answers", async () => {
    render(<Alerts />);
    await checklist('Step 2 of 4');
    cardd.push.mockRejectedValueOnce(new Error('offline'));
    await comeBack();
    await screen.findByText("Couldn't check alerts: offline", undefined, WAIT);
    await press('Try again');
    await checklist('Step 2 of 4');
  });

  it("says each step's state in words to a screen reader, not as its mark", async () => {
    render(<Alerts />);
    await checklist('Step 2 of 4');
    const said = screen.getAllByLabelText(/, (done|now|to do)$/).map((e) => e.getAttribute('aria-label')!.split(', ').pop());
    expect(said).toEqual(['done', 'now', 'done', 'to do']);
  });

  it("says so when nothing on the phone opens ntfy or its store page", async () => {
    Object.assign(phone, { distributors: [], saved: null });
    native.openNtfySettings.mockImplementationOnce(() => {
      throw new Error('nothing on this phone opens ntfy or its store page');
    });
    render(<Alerts />);
    await checklist('4 steps · about 2 minutes');
    await press('Install ntfy');
    expect(screen.getByText("Couldn't open ntfy: nothing on this phone opens ntfy or its store page")).toBeTruthy();
  });

  it("opens with Install ntfy where ntfy isn't installed, as nothing has gone wrong yet; its button opens ntfy's store page", async () => {
    Object.assign(phone, { distributors: [], saved: null, exempt: false });
    render(<Alerts />);
    await checklist('4 steps · about 2 minutes');
    expect(screen.getByText('Set up alerts')).toBeTruthy();
    expect(screen.queryByText('Needs the ntfy app')).toBeNull();
    expect(screen.getByText("Free, from your app store. Come back here once it's installed: this step ticks itself.")).toBeTruthy();
    expect(buttons()).toEqual(['Install ntfy']);
    fireEvent.click(screen.getByRole('button', { name: 'Install ntfy' }));
    expect(native.openNtfySettings).toHaveBeenCalledTimes(1);
    // ntfy installed in the store, and back: the step ticks itself.
    phone.distributors = [NTFY];
    await comeBack();
    await checklist('Step 2 of 4');
    expect(screen.getByText(NTFY_URL)).toBeTruthy();
  });

  it("gives the server's address with Copy address and open ntfy, and moves on at I've pasted it, kept for the next visit", async () => {
    phone.exempt = false;
    render(<Alerts />);
    await checklist('Step 2 of 4');
    expect(screen.getByText("In ntfy, open Settings, then General, then Default server, and paste your server's address:")).toBeTruthy();
    expect(buttons()).toEqual(['Copy address and open ntfy', "I've pasted it"]);
    await press('Copy address and open ntfy');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(NTFY_URL);
    await waitFor(() => expect(native.openNtfySettings).toHaveBeenCalledTimes(1));
    await press("I've pasted it");
    await checklist('Step 3 of 4');
    expect(store.saveNtfyPasted).toHaveBeenCalledWith({ address: NTFY_URL, endpoint: null });
    expect(buttons()).toEqual(["Open ntfy's battery setting"]);
  });

  it('remembers I\'ve pasted it across a visit', async () => {
    phone.exempt = false;
    store.pasted = { address: NTFY_URL, endpoint: null };
    render(<Alerts />);
    await checklist('Step 3 of 4');
  });

  it("opens ntfy's battery setting, ticks when ntfy is exempt on coming back, and offers a way past only after a try", async () => {
    phone.exempt = false;
    store.pasted = { address: NTFY_URL, endpoint: null };
    render(<Alerts />);
    await checklist('Step 3 of 4');
    expect(screen.getByText(`So Android doesn't hold alerts back to save battery. ${batteryHow(35)}`)).toBeTruthy();
    const wayPast = () => screen.queryByRole('button', { name: "My phone doesn't have this setting" });
    expect(wayPast()).toBeNull();
    // Back from elsewhere without trying the setting: still no way past.
    await comeBack();
    expect(wayPast()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Open ntfy's battery setting" }));
    expect(native.openBatterySettings).toHaveBeenCalledWith(NTFY);
    // Back still not exempt: the way past shows.
    await comeBack();
    await waitFor(() => expect(wayPast()).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole('button', { name: "Open ntfy's battery setting" }));
    phone.exempt = true;
    await comeBack();
    await checklist('Step 4 of 4');
  });

  it("lets the person past the battery step when the phone hasn't the setting, after trying it", async () => {
    phone.exempt = false;
    store.pasted = { address: NTFY_URL, endpoint: null };
    render(<Alerts />);
    await checklist('Step 3 of 4');
    fireEvent.click(screen.getByRole('button', { name: "Open ntfy's battery setting" }));
    await comeBack();
    await press("My phone doesn't have this setting");
    await checklist('Step 4 of 4');
    expect(screen.getByText('Not set: alerts may come late', { exact: false })).toBeTruthy();
    // Turned on, it is On with Settings' late warning.
    await press('Turn on alerts');
    await screen.findByText("Alerts may be late: ntfy isn't exempt from battery saving", undefined, WAIT);
  });

  it('turns alerts on at the last step: the endpoint ntfy gives goes to cardd', async () => {
    store.pasted = { address: NTFY_URL, endpoint: null };
    render(<Alerts />);
    await checklist('Step 4 of 4');
    expect(screen.queryByText(PERMISSION_AHEAD)).toBeNull();
    expect(buttons()).toEqual(['Turn on alerts']);
    await press('Turn on alerts');
    await screen.findByText("On: through your server's ntfy", undefined, WAIT);
    expect(native.pushRegister).toHaveBeenCalledWith('BEl6', NTFY, true);
    expect(cardd.setPush).toHaveBeenCalledWith({ endpoint: `${NTFY_URL}/upNew?up=1`, p256dh: 'BPk', auth: 'aGk', transport: 'unifiedpush' });
    expect(store.saveNtfyPasted).toHaveBeenLastCalledWith({ address: NTFY_URL, endpoint: null });
  });

  it("says Android's question is coming, and opens Android's settings on the press after a refusal", async () => {
    store.pasted = { address: NTFY_URL, endpoint: null };
    Object.assign(phone, { allowed: false, grant: false });
    render(<Alerts />);
    await checklist('Step 4 of 4');
    expect(screen.getByText(PERMISSION_AHEAD)).toBeTruthy();
    await press('Turn on alerts');
    await screen.findByText("Allow notifications in Android's settings", undefined, WAIT);
    // Android won't ask again: no "Android will ask".
    expect(screen.queryByText(PERMISSION_AHEAD)).toBeNull();
    expect(native.requestNotifications).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
    await press('Turn on alerts');
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(native.requestNotifications).toHaveBeenCalledTimes(1);
  });

  // ntfy's default server is another (ntfy.sh): the endpoint isn't handed to cardd, and step 2 is open again.
  it("opens the server step again, naming the server ntfy used, and hands cardd nothing", async () => {
    store.pasted = { address: NTFY_URL, endpoint: null };
    phone.gives = at('https://ntfy.sh', 'upZz');
    render(<Alerts />);
    await checklist('Step 4 of 4');
    await press('Turn on alerts');
    await screen.findByText('ntfy is still using ntfy.sh', undefined, WAIT);
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    expect(cardd.setPush).not.toHaveBeenCalled();
    // Pasted again, and on: the new endpoint is on the server's ntfy.
    await press("I've pasted it");
    await checklist('Step 4 of 4');
    expect(store.pasted).toEqual({ address: NTFY_URL, endpoint: `https://ntfy.sh/upZz?up=1` });
    phone.gives = at(NTFY_URL, 'upOk');
    await press('Turn on alerts');
    await screen.findByText("On: through your server's ntfy", undefined, WAIT);
  });

  it("keeps the server step ticked after a press that got no answer, though the registration's endpoint went", async () => {
    store.pasted = { address: NTFY_URL, endpoint: at('https://ntfy.sh', 'upZz').endpoint };
    phone.kept = at('https://ntfy.sh', 'upZz');
    render(<Alerts />);
    await checklist('Step 4 of 4');
    native.pushRegister.mockImplementationOnce(async () => {
      phone.kept = null;
      throw new Error('ntfy is gone');
    });
    await press('Turn on alerts');
    await screen.findByText("Couldn't turn on alerts: ntfy is gone", undefined, WAIT);
    expect(screen.getByText('Step 4 of 4')).toBeTruthy();
    expect(store.pasted).toEqual({ address: NTFY_URL, endpoint: null });
  });

  it('has three steps where the server has no ntfy of its own', async () => {
    server.state = { ...OFF, ntfy: '' };
    phone.exempt = false;
    render(<Alerts />);
    await checklist('Step 2 of 3');
    expect(screen.queryByText('Point ntfy at your server')).toBeNull();
  });

  it("goes straight to the checklist from Home's offer, turning nothing on by itself", async () => {
    vi.mocked(useLocalSearchParams).mockReturnValue({ start: '1' });
    render(<Alerts />);
    await checklist('Step 2 of 4');
    expect(native.pushRegister).not.toHaveBeenCalled();
  });
});

describe('Settings → Alerts, one press', () => {
  beforeEach(() => {
    server.state = OFF;
    phone.kept = null;
  });

  it("turns on the Play build's own push with one press, the question announced", async () => {
    play.on = true;
    Object.assign(phone, { distributors: [OWN], embedded: OWN, saved: null, allowed: false, gives: { ...at('https://fcm.googleapis.com'), endpoint: 'https://fcm.googleapis.com/fcm/send/x' } });
    await shown('Off');
    expect(screen.getByText(PERMISSION_AHEAD)).toBeTruthy();
    expect(buttons()).toEqual(['Turn on alerts']);
    await press('Turn on alerts');
    await screen.findByText('On', undefined, WAIT);
    expect(cardd.setPush).toHaveBeenCalledWith(expect.objectContaining({ transport: 'fcm' }));
  });

  it("starts at once from Home's offer on the Play build", async () => {
    play.on = true;
    vi.mocked(useLocalSearchParams).mockReturnValue({ start: '1' });
    Object.assign(phone, { distributors: [OWN], embedded: OWN, saved: null, gives: { ...at('https://fcm.googleapis.com'), endpoint: 'https://fcm.googleapis.com/fcm/send/x' } });
    render(<Alerts />);
    await screen.findByText('On', undefined, WAIT);
    expect(native.pushRegister).toHaveBeenCalledTimes(1);
  });

  it('takes another distributor with one press, no checklist', async () => {
    const other = 'org.unifiedpush.distributor.nextpush';
    Object.assign(phone, { distributors: [other], saved: other, gives: at('https://cloud.example') });
    await shown('Off');
    expect(screen.queryByText('Set up alerts')).toBeNull();
    expect(buttons()).toEqual(['Turn on alerts']);
  });
});

// The step at the end of setup: the question, then the checklist or one press; the wallet is under the page.
describe('at the end of setup', () => {
  beforeEach(() => {
    vi.mocked(useLocalSearchParams).mockReturnValue({ setup: '1' });
    server.state = OFF;
    phone.kept = null;
  });

  it('asks first, with Turn on alerts and Later, and says where to find it; Later opens the wallet', async () => {
    render(<Alerts />);
    await screen.findByText(ASK.title, undefined, WAIT);
    for (const words of [ASK.what, ASK.ntfy, ASK.where]) expect(screen.getByText(words)).toBeTruthy();
    expect(buttons()).toEqual(['Turn on alerts', 'Later']);
    expect(screen.queryByText('Off')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("goes through the checklist to Alerts are on, with a test alert and Open the wallet", async () => {
    store.pasted = { address: NTFY_URL, endpoint: null };
    render(<Alerts />);
    await screen.findByText(ASK.title, undefined, WAIT);
    await press('Turn on alerts');
    await checklist('Step 4 of 4');
    expect(buttons()).toEqual(['Turn on alerts', 'Finish later']);
    expect(native.pushRegister).not.toHaveBeenCalled();
    await press('Turn on alerts');
    await screen.findByText('Alerts are on', undefined, WAIT);
    expect(screen.getByText("You'll get a notification when money arrives or a card is used, even with the app closed.")).toBeTruthy();
    // No Turn off in setup: the way on is the wallet.
    expect(buttons()).toEqual(['Send a test alert', 'Open the wallet']);
    fireEvent.click(screen.getByRole('button', { name: 'Open the wallet' }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('says how far the person got at Finish later, with the way back to the steps', async () => {
    render(<Alerts />);
    await screen.findByText(ASK.title, undefined, WAIT);
    await press('Turn on alerts');
    await checklist('Step 2 of 4');
    await press('Finish later');
    await screen.findByText("Alerts aren't on yet", undefined, WAIT);
    // ntfy installed and exempt: 2 of the 4.
    expect(screen.getByText("You've done 2 of the 4 steps. Pick up where you left off any time in Settings → Alerts.")).toBeTruthy();
    expect(buttons()).toEqual(['Open the wallet', 'Back to the steps']);
    await press('Back to the steps');
    await checklist('Step 2 of 4');
    await press('Finish later');
    await press('Open the wallet');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("keeps Try again and Finish later when a read of the server fails in set-up", async () => {
    render(<Alerts />);
    await screen.findByText(ASK.title, undefined, WAIT);
    await press('Turn on alerts');
    await checklist('Step 2 of 4');
    cardd.push.mockRejectedValueOnce(new Error('offline'));
    await comeBack();
    await screen.findByText("Couldn't check alerts: offline", undefined, WAIT);
    expect(buttons()).toEqual(['Try again', 'Finish later']);
    await press('Finish later');
    await screen.findByText("Alerts aren't on yet", undefined, WAIT);
  });

  it("asks on the Play build with its line about Google, and turns on with the one press", async () => {
    play.on = true;
    Object.assign(phone, { distributors: [OWN], embedded: OWN, saved: null, gives: { ...at('https://fcm.googleapis.com'), endpoint: 'https://fcm.googleapis.com/fcm/send/x' } });
    render(<Alerts />);
    await screen.findByText(ASK.title, undefined, WAIT);
    expect(screen.getByText("Alerts come through Google's push, encrypted: Google can't read them.")).toBeTruthy();
    expect(screen.queryByText(ASK.ntfy)).toBeNull();
    await press('Turn on alerts');
    await screen.findByText('Alerts are on', undefined, WAIT);
  });
});
