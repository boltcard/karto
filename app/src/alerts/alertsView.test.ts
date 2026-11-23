import { describe, expect, it } from 'vitest';
import type { PushState } from '../cardd/client';
import { CarddError } from '../cardd/client';
import { alertsChecklist, alertsRow, alertsView, batteryHow, isOn, NTFY, onChecklistPath, registerError, sameOrigin, type AlertsInput } from './alertsView';

const NTFY_URL = 'https://vm-1.lnvps.cloud:8443';
const ENDPOINT: NonNullable<PushState['endpoint']> = {
  transport: 'unifiedpush', origin: NTFY_URL, createdAt: 1_790_000_000, deliveredAt: null, failedAt: null, failure: '', failures: 0,
};
const ON: PushState = { vapidPublicKey: 'BEl6', ntfy: NTFY_URL, endpoint: ENDPOINT };
const OFF: PushState = { ...ON, endpoint: null };
/** A Google-free phone with ntfy installed and chosen, exempt from battery saving, alerts on through the server's ntfy. */
const BASE: AlertsInput = { server: ON, distributors: [NTFY], distributor: NTFY, allowed: true, ntfyExempt: true, play: false, endpointOrigin: NTFY_URL };
const view = (o: Partial<AlertsInput> = {}) => alertsView({ ...BASE, ...o });
const said = (o: Partial<AlertsInput> = {}) => {
  const v = view(o);
  return { status: v.status, line: v.line, canTest: v.canTest };
};

const FCM = { transport: 'fcm' as const, origin: 'https://fcm.googleapis.com' };
const PLAY: Partial<AlertsInput> = { server: { ...ON, endpoint: { ...ENDPOINT, ...FCM } }, distributors: [], distributor: 'tech.whitewolf.karto.dev', play: true, ntfyExempt: null, endpointOrigin: FCM.origin };

// The status in words, each with what the page offers.
describe('alertsView', () => {
  it('says each status in its words, and whether a test alert can be sent', () => {
    expect(said()).toEqual({ status: 'on-ntfy', line: "On: through your server's ntfy", canTest: true });
    expect(said(PLAY)).toEqual({ status: 'on-play', line: 'On', canTest: true });
    expect(said({ server: OFF, endpointOrigin: null })).toEqual({ status: 'off', line: 'Off', canTest: false });
    expect(said({ server: OFF, distributors: [], distributor: null, ntfyExempt: null, endpointOrigin: null })).toEqual({
      status: 'needs-distributor', line: 'Off', canTest: false,
    });
    expect(said({ server: OFF, endpointOrigin: 'https://ntfy.sh' })).toEqual({ status: 'needs-ntfy-server', line: 'ntfy is set to another server', canTest: false });
    expect(said({ server: OFF, endpointOrigin: 'https://ntfy.sh', ntfyExempt: false })).toEqual({ status: 'needs-ntfy-server', line: 'ntfy is set to another server', canTest: false });
    expect(said({ allowed: false })).toEqual({ status: 'needs-permission', line: "Allow notifications in Android's settings", canTest: false });
    expect(said({ ntfyExempt: false })).toEqual({ status: 'late-battery', line: "Alerts may be late: ntfy isn't exempt from battery saving", canTest: true });
    expect(said({ server: { ...ON, endpoint: { ...ENDPOINT, failures: 2, failedAt: 1_790_000_100, failure: 'HTTP 410 Gone' } } })).toEqual({
      status: 'failing', line: "Last alert didn't arrive: HTTP 410 Gone", canTest: true,
    });
  });

  it('puts the permission first, then a failure, then battery saving', () => {
    const failing = { server: { ...ON, endpoint: { ...ENDPOINT, failures: 1, failure: 'x' } } };
    expect(view({ ...failing, allowed: false, ntfyExempt: false }).status).toBe('needs-permission');
    expect(view({ ...failing, ntfyExempt: false }).status).toBe('failing');
  });

  it('is off when the server has no endpoint or the phone has none, whatever the other says', () => {
    expect(view({ server: OFF }).status).toBe('off');
    expect(view({ endpointOrigin: null }).status).toBe('off');
    // The server's answer not read yet: only the phone's side is known.
    expect(view({ server: null, endpointOrigin: null }).status).toBe('off');
  });

  it('is on, for the page, in every status where the server has the endpoint, wrong as it may be', () => {
    expect(['on-ntfy', 'on-play', 'late-battery', 'failing', 'needs-permission'].every((x) => isOn(x as never))).toBe(true);
    expect(['off', 'needs-distributor', 'needs-ntfy-server'].some((x) => isOn(x as never))).toBe(false);
  });

  // A Play build uses Google's push only with no distributor installed, and says what Google can see.
  it("says once on the Play build's own path that Google can't read the alerts, and treats a Play build with ntfy as Google-free", () => {
    const note = "Alerts come through Google's push, encrypted: Google can't read them.";
    expect(view(PLAY).note).toBe(note);
    expect(view({ ...PLAY, server: OFF, endpointOrigin: null })).toMatchObject({ status: 'off', note });
    expect(view({ play: true })).toMatchObject({ status: 'on-ntfy', note: null });
    expect(view({ play: true, server: OFF, endpointOrigin: 'https://ntfy.sh' }).status).toBe('needs-ntfy-server');
    expect(view().note).toBeNull();
  });

  // cardd's origin as the endpoint has it, a default port or capitals and all.
  it("knows the server's ntfy in an origin cardd gives with its default port or capitals", () => {
    const at443 = { ...ON, ntfy: 'https://vm-1.lnvps.cloud', endpoint: { ...ENDPOINT, origin: 'https://VM-1.lnvps.cloud:443' } };
    expect(said({ server: at443, endpointOrigin: 'https://vm-1.lnvps.cloud' }).line).toBe("On: through your server's ntfy");
    expect(sameOrigin('https://VM-1.lnvps.cloud:443', 'https://vm-1.lnvps.cloud/up1?up=1')).toBe(true);
    expect(sameOrigin('https://vm-1.lnvps.cloud:8443', 'https://vm-1.lnvps.cloud')).toBe(false);
    expect(sameOrigin('http://vm-1.lnvps.cloud:80', 'http://vm-1.lnvps.cloud')).toBe(true);
    expect(sameOrigin(null, 'https://a.example')).toBe(false);
    expect(sameOrigin('not a url', 'not a url')).toBe(false);
  });

  it('says plain On for another distributor, with no battery check', () => {
    const other = { distributors: ['org.unifiedpush.distributor.nextpush'], distributor: 'org.unifiedpush.distributor.nextpush', ntfyExempt: null };
    const on = { ...other, server: { ...ON, endpoint: { ...ENDPOINT, origin: 'https://cloud.example' } }, endpointOrigin: 'https://cloud.example' };
    expect(said(on)).toEqual({ status: 'on-ntfy', line: 'On', canTest: true });
    expect(said({ ...other, server: OFF, endpointOrigin: 'https://cloud.example' }).status).toBe('off');
  });

  it('colours the status for Settings: green when on, amber when it needs a step, red when the last alert failed, none before ntfy', () => {
    expect(view().tone).toBe('ok');
    expect(view(PLAY).tone).toBe('ok');
    expect(view({ server: OFF }).tone).toBe('none');
    expect(view({ server: OFF, distributors: [], distributor: null, ntfyExempt: null, endpointOrigin: null }).tone).toBe('none');
    for (const o of [{ ntfyExempt: false }, { allowed: false }, { server: OFF, endpointOrigin: 'https://ntfy.sh' }]) expect(view(o).tone).toBe('warn');
    expect(view({ server: { ...ON, endpoint: { ...ENDPOINT, failures: 1, failure: 'x' } } }).tone).toBe('error');
  });
});

// ntfy put the phone's registration on another ntfy server (its default): not On, and the checklist's step 2 again.
describe('another ntfy server', () => {
  it("isn't On while the phone's registration is on another server, though the server still has an older one", () => {
    expect(view({ server: OFF, endpointOrigin: 'https://ntfy.whitewolf.tech' })).toMatchObject({ status: 'needs-ntfy-server', line: 'ntfy is set to another server', tone: 'warn' });
    expect(view({ server: ON, endpointOrigin: 'https://ntfy.whitewolf.tech' }).status).toBe('needs-ntfy-server');
  });

  // Google's push in use, ntfy installed later: alerts still come through Google's, so they are On.
  it("stays On through Google's push when ntfy is installed afterwards", () => {
    expect(view({ ...PLAY, distributors: [NTFY], distributor: null, ntfyExempt: true })).toMatchObject({ status: 'on-play', line: 'On' });
  });
});

/** A Google-free phone before alerts are on: nothing installed, nothing registered. */
const FRESH: AlertsInput = { server: OFF, distributors: [], distributor: null, allowed: false, ntfyExempt: null, play: false, endpointOrigin: null };
type Extra = Parameters<typeof alertsChecklist>[1];
const list = (o: Partial<AlertsInput> = {}, c: Partial<Extra> = {}) => alertsChecklist({ ...FRESH, ...o }, { endpoint: null, pasted: null, batteryPassed: false, ...c });
const ticks = (o: Partial<AlertsInput> = {}, c: Partial<Extra> = {}) => {
  const l = list(o, c);
  return { done: l.items.filter((i) => i.done).map((i) => i.key), current: l.current, n: l.done };
};
const WITH_NTFY: Partial<AlertsInput> = { distributors: [NTFY], distributor: null, ntfyExempt: false };
const OWN_EP = `${NTFY_URL}/upAbC?up=1`;
const SH_EP = 'https://ntfy.sh/upZz?up=1';

describe('which way alerts turn on', () => {
  it('takes the checklist through ntfy, and with nothing installed on a Google-free phone; one press otherwise', () => {
    expect(onChecklistPath(FRESH)).toBe(true);
    expect(onChecklistPath({ ...FRESH, ...WITH_NTFY })).toBe(true);
    // The Play build with Google's push; with ntfy installed, ntfy is chosen first.
    expect(onChecklistPath({ ...FRESH, play: true })).toBe(false);
    expect(onChecklistPath({ ...FRESH, play: true, distributors: [NTFY] })).toBe(true);
    // Another distributor: one press.
    expect(onChecklistPath({ ...FRESH, distributors: ['org.unifiedpush.distributor.nextpush'] })).toBe(false);
  });
});

describe('alertsChecklist', () => {
  it('opens the first step not done: install, the server, battery, turn on', () => {
    expect(ticks()).toEqual({ done: [], current: 'install', n: 0 });
    expect(ticks(WITH_NTFY)).toEqual({ done: ['install'], current: 'server', n: 1 });
    expect(ticks(WITH_NTFY, { pasted: { address: NTFY_URL, endpoint: null } })).toEqual({ done: ['install', 'server'], current: 'battery', n: 2 });
    expect(ticks({ ...WITH_NTFY, ntfyExempt: true }, { pasted: { address: NTFY_URL, endpoint: null } })).toEqual({ done: ['install', 'server', 'battery'], current: 'on', n: 3 });
    // A later step done first still waits for the one before it.
    expect(ticks({ ...WITH_NTFY, ntfyExempt: true })).toEqual({ done: ['install', 'battery'], current: 'server', n: 2 });
    expect(list().items.map((i) => i.title)).toEqual(['Install ntfy', 'Point ntfy at your server', 'Let ntfy run in the background', 'Turn on alerts']);
  });

  it('has three steps where the server has no ntfy address', () => {
    const l = list({ ...WITH_NTFY, server: { ...OFF, ntfy: '' } });
    expect(l.items.map((i) => i.key)).toEqual(['install', 'battery', 'on']);
    expect(l.current).toBe('battery');
  });

  it("ticks the server step for the person's word on this address while the phone has the endpoint it had then", () => {
    const pasted = { address: NTFY_URL, endpoint: SH_EP };
    expect(ticks(WITH_NTFY, { pasted, endpoint: SH_EP }).done).toContain('server');
    // A registration since gave another endpoint: where ntfy's default really is.
    expect(ticks(WITH_NTFY, { pasted, endpoint: 'https://ntfy.sh/upNew?up=1' }).done).not.toContain('server');
    // Said for another server's address.
    expect(ticks(WITH_NTFY, { pasted: { address: 'https://old.example:8443', endpoint: null } }).done).not.toContain('server');
    // The phone's endpoint on the server's ntfy says it, word or none.
    expect(ticks({ ...WITH_NTFY, endpointOrigin: NTFY_URL }, { endpoint: OWN_EP }).done).toContain('server');
  });

  it('warns on the server step where ntfy put the registration on another server, naming it', () => {
    const step = (c: Partial<Extra>) => list({ ...WITH_NTFY, endpointOrigin: 'https://ntfy.sh' }, c).items.find((i) => i.key === 'server')!;
    expect(step({ endpoint: SH_EP }).warn).toEqual({
      title: 'ntfy is still using ntfy.sh',
      text: "Its Default server isn't your server's address yet, so alerts would go the wrong way. Paste the address, then turn on again.",
    });
    expect(step({ endpoint: 'https://ntfy.example:8443/upZz?up=1' }).warn?.title).toBe('ntfy is still using ntfy.example:8443');
    // Once the person says it is set, no warning: Turn on alerts tells.
    expect(step({ endpoint: SH_EP, pasted: { address: NTFY_URL, endpoint: SH_EP } })).toMatchObject({ done: true, warn: null });
    expect(list(WITH_NTFY).items.find((i) => i.key === 'server')!.warn).toBeNull();
  });

  it("ticks battery when ntfy is exempt, or when the person says the phone hasn't the setting", () => {
    const battery = (o: Partial<AlertsInput>, batteryPassed = false) => list(o, { batteryPassed }).items.find((i) => i.key === 'battery')!;
    expect(battery({ ...WITH_NTFY, ntfyExempt: true })).toMatchObject({ done: true, doneLine: 'Unrestricted' });
    expect(battery(WITH_NTFY)).toMatchObject({ done: false });
    expect(battery(WITH_NTFY, true)).toMatchObject({ done: true, doneLine: 'Not set: alerts may come late' });
  });

  it("says where ntfy's battery setting is by Android version", () => {
    expect(batteryHow(35)).toBe('On the page that opens, choose App battery usage, then Unrestricted. If you see Allow background usage, tap its words to find Unrestricted.');
    expect(batteryHow(31)).toBe(batteryHow(35));
    expect(batteryHow(30)).toBe("In the list that opens, choose All apps, then ntfy, then Don't optimise. If ntfy's App info opens instead, choose Battery.");
  });
});

describe('registerError', () => {
  it("says why alerts didn't turn on where the status line doesn't", () => {
    expect(registerError({ ok: false, why: 'server', detail: 'HTTP 500' }, 'ntfy')).toBe("Couldn't turn on alerts: HTTP 500");
    expect(registerError({ ok: false, why: 'timeout' }, 'ntfy')).toBe("ntfy didn't answer. Open ntfy, then try again.");
    expect(registerError({ ok: false, why: 'timeout', detail: 'network' }, 'fcm')).toBe("Google's push didn't answer (network). Try again.");
    // The page says these: the checklist's Install ntfy, its server step again, Allow notifications.
    for (const why of ['no-distributor', 'ntfy-sh', 'permission'] as const) expect(registerError({ ok: false, why }, 'ntfy')).toBeNull();
    expect(registerError({ ok: true }, 'ntfy')).toBeNull();
  });
});

describe('alertsRow', () => {
  it("says Checking until the server answers, the status after, and a server without alerts as needing an update", () => {
    expect(alertsRow(view(), null, null)).toEqual({ line: 'Checking…', tone: 'none' });
    expect(alertsRow(view(), ON, null)).toEqual({ line: "On: through your server's ntfy", tone: 'ok' });
    expect(alertsRow(null, null, new CarddError(404, 'bad_response', 'GET /api/v1/push → HTTP 404: 404 page not found'))).toEqual({ line: 'Needs a server update', tone: 'warn' });
    expect(alertsRow(view(), null, new Error('offline'))).toEqual({ line: "Couldn't check alerts", tone: 'none' });
  });
});
