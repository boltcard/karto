import { describe, expect, it } from 'vitest';
import type { PushState } from '../cardd/client';
import { CarddError } from '../cardd/client';
import { alertsRow, alertsView, NTFY, ntfySteps, registerError, sameOrigin, type AlertsInput } from './alertsView';

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
  return { status: v.status, line: v.line, canTest: v.canTest, steps: v.steps.map((s) => s.n) };
};

const FCM = { transport: 'fcm' as const, origin: 'https://fcm.googleapis.com' };
const PLAY: Partial<AlertsInput> = { server: { ...ON, endpoint: { ...ENDPOINT, ...FCM } }, distributors: [], distributor: 'tech.whitewolf.karto.dev', play: true, ntfyExempt: null, endpointOrigin: FCM.origin };

// The status in words, each with what the page offers.
describe('alertsView', () => {
  it('says each status in its words, with its steps and whether a test alert can be sent', () => {
    expect(said()).toEqual({ status: 'on-ntfy', line: "On: through your server's ntfy", canTest: true, steps: [] });
    expect(said(PLAY)).toEqual({ status: 'on-play', line: 'On', canTest: true, steps: [] });
    expect(said({ server: OFF, endpointOrigin: null })).toEqual({ status: 'off', line: 'Off', canTest: false, steps: [] });
    expect(said({ server: OFF, distributors: [], distributor: null, ntfyExempt: null, endpointOrigin: null })).toEqual({
      status: 'needs-distributor', line: 'Needs the ntfy app', canTest: false, steps: [1, 2, 3],
    });
    expect(said({ server: OFF, endpointOrigin: 'https://ntfy.sh' })).toEqual({ status: 'needs-ntfy-server', line: "Set ntfy's server first", canTest: false, steps: [2] });
    expect(said({ server: OFF, endpointOrigin: 'https://ntfy.sh', ntfyExempt: false })).toEqual({ status: 'needs-ntfy-server', line: "Set ntfy's server first", canTest: false, steps: [2, 3] });
    expect(said({ allowed: false })).toEqual({ status: 'needs-permission', line: "Allow notifications in Android's settings", canTest: false, steps: [] });
    expect(said({ ntfyExempt: false })).toEqual({ status: 'late-battery', line: "Alerts may be late: ntfy isn't exempt from battery saving", canTest: true, steps: [3] });
    expect(said({ server: { ...ON, endpoint: { ...ENDPOINT, failures: 2, failedAt: 1_790_000_100, failure: 'HTTP 410 Gone' } } })).toEqual({
      status: 'failing', line: "Last alert didn't arrive: HTTP 410 Gone", canTest: true, steps: [],
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

  it('gives the server step its ntfy address, and links ntfy on F-Droid and the Play Store', () => {
    const steps = view({ server: OFF, distributors: [], distributor: null, ntfyExempt: null, endpointOrigin: null }).steps;
    expect(steps).toEqual([
      { n: 1, text: 'Install ntfy', links: [{ label: 'F-Droid', url: 'https://f-droid.org/packages/io.heckel.ntfy/' }, { label: 'Play Store', url: 'https://play.google.com/store/apps/details?id=io.heckel.ntfy' }] },
      { n: 2, text: 'In ntfy: Settings → General → Default server, paste this address', address: NTFY_URL },
      { n: 3, text: "In ntfy's App info: App battery usage → Unrestricted" },
    ]);
    expect(ntfySteps(NTFY_URL, null)).toEqual(steps.slice(1));
  });

  // The battery step only where ntfy isn't already exempt.
  it('leaves the battery step out where ntfy is already exempt from battery saving', () => {
    const server = { n: 2, text: 'In ntfy: Settings → General → Default server, paste this address', address: NTFY_URL };
    const battery = { n: 3, text: "In ntfy's App info: App battery usage → Unrestricted" };
    expect(ntfySteps(NTFY_URL, true)).toEqual([server]);
    expect(ntfySteps(NTFY_URL, false)).toEqual([server, battery]);
    expect(ntfySteps(NTFY_URL, null)).toEqual([server, battery]);
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

  it('says plain On for another distributor, with no ntfy step and no battery check', () => {
    const other = { distributors: ['org.unifiedpush.distributor.nextpush'], distributor: 'org.unifiedpush.distributor.nextpush', ntfyExempt: null };
    const on = { ...other, server: { ...ON, endpoint: { ...ENDPOINT, origin: 'https://cloud.example' } }, endpointOrigin: 'https://cloud.example' };
    expect(said(on)).toEqual({ status: 'on-ntfy', line: 'On', canTest: true, steps: [] });
    expect(said({ ...other, server: OFF, endpointOrigin: 'https://cloud.example' }).status).toBe('off');
  });

  it('colours the status for Settings: green when on, amber when it needs a step, red when the last alert failed', () => {
    expect(view().tone).toBe('ok');
    expect(view(PLAY).tone).toBe('ok');
    expect(view({ server: OFF }).tone).toBe('none');
    for (const o of [{ ntfyExempt: false }, { allowed: false }, { server: OFF, endpointOrigin: 'https://ntfy.sh' }]) expect(view(o).tone).toBe('warn');
    expect(view({ server: { ...ON, endpoint: { ...ENDPOINT, failures: 1, failure: 'x' } } }).tone).toBe('error');
  });
});

describe('registerError', () => {
  it("says why alerts didn't turn on where the status line doesn't", () => {
    expect(registerError({ ok: false, why: 'server', detail: 'HTTP 500' }, 'ntfy')).toBe("Couldn't turn on alerts: HTTP 500");
    expect(registerError({ ok: false, why: 'timeout' }, 'ntfy')).toBe("ntfy didn't answer. Open ntfy, then try again.");
    expect(registerError({ ok: false, why: 'timeout', detail: 'network' }, 'fcm')).toBe("Google's push didn't answer (network). Try again.");
    // The status line says these: Needs the ntfy app, Set ntfy's server first, Allow notifications.
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
