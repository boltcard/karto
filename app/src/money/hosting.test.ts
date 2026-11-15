import { describe, expect, it } from 'vitest';
import { CarddClient, type HostingStatus } from '../cardd/client';
import { bolt11AmountMsat, bolt11ExpiresAtMs } from '../lightning/lightning';
import { LnvpsClient } from '../lnvps/client';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { FakeLnvps } from '../testing/fakeLnvps';
import { vectors } from '../testing/vectors';
import { hostingWarnings, HostingSyncer, lnvpsInvoice, paidUntil, renewDays, renewedText, renewProblem, renewSat, syncHosting, type HostingSnapshot } from './hosting';

const VM = 1001;
const EXPIRES = Date.parse('2026-11-02T12:00:00Z') / 1000;
const NOW = 1_790_000_000; // 2026-09-21 14:13 UTC
/** cardd's estimate after an earlier sync: what it falls back to for the price. */
const CARDD_SYNCED = { expires: EXPIRES, msatPerDay: 221_395, vatOk: true, syncedAt: NOW };

function setup(country = 'GBR') {
  const lnvpsFake = new FakeLnvps();
  lnvpsFake.account.country_code = country;
  lnvpsFake.vms.set(VM, {
    id: VM, created: '2026-10-01T12:00:00Z', expires: '2026-11-02T12:00:00Z', status: { state: 'running' },
    ip_assignments: [], host_ssh_keys: [], image: {}, ssh_key: { id: 1 },
  });
  const lnvps = new LnvpsClient({ fetch: lnvpsFake.http.fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey });
  const carddFake = new FakeCardd(() => NOW * 1000);
  carddFake.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  const cardd = new CarddClient({ fetch: carddFake.http.fetch, host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => NOW * 1000 });
  return { lnvpsFake, lnvps, carddFake, cardd };
}

const status = (o: Partial<HostingStatus> = {}): HostingStatus => ({
  synced: true, expires: NOW + 40 * 86400, syncedAt: NOW, daysLeft: 40, msatPerDay: 221_387, fundingDays: 100, vatOk: true, willRenew: true,
  problem: '', problemAt: 0, ...o,
});

// Renew now's result: the fee as the history says it, under the next whole sat when it has a part of one.
describe('renewedText', () => {
  it('says what was paid, for how long, and the fee as the history says it', () => {
    expect(renewedText(1_591_000, 7, 4_400)).toBe('Renewed: 1,591 sat for 7 days (fee under 5 sat).');
    expect(renewedText(227_000, 1, 3_000)).toBe('Renewed: 227 sat for 1 day (fee 3 sat).');
    expect(renewedText(1_591_000, 7, 4_400, 'fiat', { currency: 'GBP', price: 61_352, time: 1_792_037_404 })).toBe('Renewed: £0.98 for 7 days (fee under £0.01).');
    expect(renewedText(1_591_000, 7, 4_400, 'msat', null)).toBe('Renewed: 1,591,000 msat for 7 days (fee 4,400 msat).');
  });
});

describe('syncHosting', () => {
  // LNVPS's quote: 6,863 sat for 31 days, 221.387 sat a day.
  it("sends cardd LNVPS's expiry, the price of a day and the VAT guard", async () => {
    const { lnvps, cardd, carddFake } = setup();
    const snap = await syncHosting({ lnvps, cardd }, VM);
    expect(snap.lnvpsExpires).toBe(EXPIRES);
    expect(carddFake.hostingSync).toEqual({ expires: EXPIRES, msatPerDay: 221_387, vatOk: true, syncedAt: NOW });
    expect(snap.status).toMatchObject({ synced: true, expires: EXPIRES, vatOk: true });
  });

  // The phone's offset from UTC, for hosting's daily alert at 09:00 phone time.
  it("sends the phone's offset from UTC", async () => {
    const { lnvps, cardd, carddFake } = setup();
    await syncHosting({ lnvps, cardd }, VM, 60);
    expect(carddFake.hostingOffsetMin).toBe(60);
  });

  // An older cardd refuses the field it doesn't know (400 malformed): the sync goes again without it, so cardd's
  // estimate stays fresh until Update server.
  it('syncs without the offset when an older cardd refuses it', async () => {
    const { lnvps, cardd, carddFake } = setup();
    carddFake.refuseOffset = true;
    const snap = await syncHosting({ lnvps, cardd }, VM, 60);
    expect(snap.status).toMatchObject({ synced: true, expires: EXPIRES });
    expect(carddFake.hostingSync).toEqual({ expires: EXPIRES, msatPerDay: 221_387, vatOk: true, syncedAt: NOW });
    expect(carddFake.hostingOffsetMin).toBeNull();
  });

  it('says so when LNVPS would charge VAT', async () => {
    const { lnvps, cardd, carddFake } = setup('IRL');
    await syncHosting({ lnvps, cardd }, VM);
    expect(carddFake.hostingSync?.vatOk).toBe(false);
  });

  // LNVPS won't quote once the VM is paid over a year ahead (max_prepay_days): the sync uses cardd's price.
  it("uses cardd's price when LNVPS refuses to quote", async () => {
    const { lnvps, lnvpsFake, cardd, carddFake } = setup();
    lnvpsFake.quoteRefused = true;
    expect(await syncHosting({ lnvps, cardd }, VM)).toEqual({ lnvpsExpires: null, status: null }); // cardd has no price yet
    carddFake.hostingSync = { ...CARDD_SYNCED };
    const snap = await syncHosting({ lnvps, cardd }, VM);
    expect(snap.lnvpsExpires).toBe(EXPIRES);
    expect(carddFake.hostingSync).toEqual({ expires: EXPIRES, msatPerDay: 221_395, vatOk: true, syncedAt: NOW });
  });

  it("skips quietly without LNVPS, and keeps LNVPS's expiry without cardd", async () => {
    const { lnvps, cardd, carddFake } = setup();
    const offline = async () => {
      throw new Error('fetch failed: offline');
    };
    const noLnvps = new LnvpsClient({ fetch: offline, nostrSecretKey: vectors.phrase.nostrPrivateKey });
    expect(await syncHosting({ lnvps: noLnvps, cardd }, VM)).toEqual({ lnvpsExpires: null, status: null });
    expect(carddFake.http.requests).toEqual([]);
    const noCardd = new CarddClient({ fetch: offline, host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => NOW * 1000 });
    expect(await syncHosting({ lnvps, cardd: noCardd }, VM)).toEqual({ lnvpsExpires: EXPIRES, status: null });
  });

  // An order not yet paid has no expiry: nothing to sync, and cardd keeps what it has.
  it('sends nothing for a VM LNVPS gives no expiry', async () => {
    const { lnvps, lnvpsFake, cardd, carddFake } = setup();
    lnvpsFake.vms.get(VM)!.expires = null;
    expect(await syncHosting({ lnvps, cardd }, VM)).toEqual({ lnvpsExpires: null, status: null });
    expect(carddFake.http.requests).toEqual([]);
  });
});

describe('HostingSyncer', () => {
  it('syncs on the first open, then 10 minutes or more after the last sync that reached LNVPS, or when asked', async () => {
    const s = new HostingSyncer();
    let runs = 0;
    const run = async () => (runs++, { lnvpsExpires: runs === 1 ? null : EXPIRES + runs, status: null });
    const t = 1_790_000_000_000;
    await s.maybe(t, 1009, run); // offline: LNVPS didn't answer
    expect([runs, s.lnvpsExpires]).toEqual([1, null]);
    await s.maybe(t + 60_000, 1009, run); // so the next open tries again
    expect([runs, s.lnvpsExpires]).toEqual([2, EXPIRES + 2]);
    await s.maybe(t + 9 * 60_000, 1009, run);
    expect(runs).toBe(2);
    await s.maybe(t + 11 * 60_000, 1009, run);
    expect(runs).toBe(3);
    await s.maybe(t + 11 * 60_000 + 5_000, 1009, run, { force: true }); // after a payment
    expect([runs, s.lnvpsExpires]).toEqual([4, EXPIRES + 4]);
  });

  it('runs one sync at a time', async () => {
    const s = new HostingSyncer();
    let release = () => {};
    const slow = () => new Promise<{ lnvpsExpires: number; status: null }>((r) => (release = () => r({ lnvpsExpires: EXPIRES, status: null })));
    const first = s.maybe(0, 1009, slow);
    expect(await s.maybe(0, 1009, slow, { force: true })).toBeNull();
    release();
    expect(await first).toEqual({ lnvpsExpires: EXPIRES, status: null });
  });

  // The real run: on 1009, the server page showed the test VM's paid-until date until a cold start.
  it("never shows another VM's expiry, and syncs a VM it hasn't synced at once", async () => {
    const s = new HostingSyncer();
    const t = 1_790_000_000_000;
    await s.maybe(t, 1003, async () => ({ lnvpsExpires: EXPIRES, status: null }));
    expect(s.lnvpsExpires).toBe(EXPIRES);
    let release = () => {};
    const run = () => new Promise<HostingSnapshot>((r) => (release = () => r({ lnvpsExpires: null, status: null })));
    const next = s.maybe(t + 60_000, 1009, run); // within 10 minutes, but another VM: due
    expect(s.lnvpsExpires).toBeNull(); // forgotten before the sync even answers
    release();
    expect(await next).toEqual({ lnvpsExpires: null, status: null });
    expect(s.lnvpsExpires).toBeNull(); // LNVPS didn't answer: still nothing, never 1003's
  });

  it("drops a sync's answer for a VM it has moved on from", async () => {
    const s = new HostingSyncer();
    let release = () => {};
    const slow = () => new Promise<HostingSnapshot>((r) => (release = () => r({ lnvpsExpires: EXPIRES, status: null })));
    const first = s.maybe(0, 1003, slow);
    expect(await s.maybe(0, 1009, slow)).toBeNull(); // one at a time
    release();
    await first;
    expect(s.lnvpsExpires).toBeNull(); // 1003's answer arrived after the page moved to 1009
  });

  // LNVPS has taken over 20 s to credit a payment from another wallet.
  it("after a payment, syncs every 10 seconds until LNVPS's date moves, for up to 3 minutes", async () => {
    const s = new HostingSyncer();
    let slept = 0;
    const sleep = async (ms: number) => void (slept += ms);
    const seen = [EXPIRES, null, EXPIRES + 7 * 86400];
    let syncs = 0;
    expect(await s.afterPayment(async () => seen[syncs++], { before: EXPIRES, sleep })).toBe(true);
    expect([syncs, slept]).toEqual([3, 30_000]);
    syncs = slept = 0;
    expect(await s.afterPayment(async () => (syncs++, EXPIRES), { before: EXPIRES, sleep })).toBe(false);
    expect([syncs, slept]).toEqual([18, 180_000]);
    // Not knowing the date before: the first date LNVPS gives will do.
    syncs = slept = 0;
    expect(await s.afterPayment(async () => (syncs++, EXPIRES), { before: null, sleep })).toBe(true);
    expect(syncs).toBe(1);
  });
});

describe('paidUntil', () => {
  it("shows cardd's estimate, marked estimated once its sync is over 7 days old, else LNVPS's own", () => {
    expect(paidUntil(status(), EXPIRES, NOW)).toEqual({ expires: NOW + 40 * 86400, days: 40, estimated: false });
    expect(paidUntil(status({ syncedAt: NOW - 8 * 86400 }), null, NOW)).toMatchObject({ estimated: true });
    expect(paidUntil(null, EXPIRES, NOW)).toEqual({ expires: EXPIRES, days: (EXPIRES - NOW) / 86400, estimated: false });
    expect(paidUntil(status({ synced: false }), null, NOW)).toBeNull();
  });
});

describe('hostingWarnings', () => {
  it('warns under 14 days of funding, when LNVPS charges VAT, and under 7 days when cardd will not renew', () => {
    expect(hostingWarnings(status(), null, NOW, 0)).toEqual({ funding: null, fundingTone: 'amber', vat: null, banner: null });
    expect(hostingWarnings(status({ expires: NOW + 7 * 86400, fundingDays: 13.9 }), null, NOW, 0).funding).toBe(
      'Hosting covers about 13 more days after 28 Sep: top it up or move from Pool',
    );
    // 36 days is more than a renewal (to 30 days) takes: no nagging to top up.
    expect(hostingWarnings(status({ fundingDays: 36.6 }), null, NOW, 0).funding).toBeNull();
    expect(hostingWarnings(status({ fundingDays: 14 }), null, NOW, 0).funding).toBeNull();
    expect(hostingWarnings(status({ vatOk: false, willRenew: false }), null, NOW, 0).vat).toBe(
      'Automatic renewal is stopped: LNVPS now charges you VAT. Renew by hand (you will pay the VAT), or check your LNVPS account.',
    );
    const soon = NOW + 6 * 86400;
    expect(hostingWarnings(status({ expires: soon }), null, NOW, 0).banner).toBeNull();
    expect(hostingWarnings(status({ expires: soon, willRenew: false }), null, NOW, 0).banner).toEqual({ text: 'Your server is paid only until 27 Sep', tone: 'amber', forFunding: false });
    expect(hostingWarnings(status({ expires: NOW + 8 * 86400, willRenew: false }), null, NOW, 0).banner).toBeNull();
    // With the VM kept at about 7 days, cardd out of reach for a moment says nothing until the date is close:
    // LNVPS's own expiry decides, under 3 days (red).
    expect(hostingWarnings(null, soon, NOW, 0)).toEqual({ funding: null, fundingTone: 'amber', vat: null, banner: null });
    expect(hostingWarnings(status({ synced: false }), soon, NOW, 0).banner).toBeNull();
    expect(hostingWarnings(null, NOW + 2 * 86400, NOW, 0).banner).toEqual({ text: 'Your server is paid only until 23 Sep', tone: 'red', forFunding: false });
  });

  // Amber first, red when it is close: red from 7 days down met a new server, paid for 7 days, at once.
  it('is amber with 3 days or more left, and red under 3 or once the date has passed', () => {
    const tone = (days: number) => hostingWarnings(status({ expires: NOW + days * 86400, willRenew: false }), null, NOW, 0).banner?.tone;
    expect([tone(6.9), tone(3), tone(2.99), tone(0.1), tone(-1)]).toEqual(['amber', 'amber', 'red', 'red', 'red']);
    // The date as Settings' pages write dates: no clock time, the year only when it isn't this one's.
    expect(hostingWarnings(status({ expires: NOW + 2 * 86400, willRenew: false }), null, NOW, 0).banner!.text).toBe('Your server is paid only until 23 Sep');
    expect(hostingWarnings(null, Date.UTC(2027, 0, 1, 9, 0) / 1000, Date.UTC(2026, 11, 30, 9, 0) / 1000, 0).banner!.text).toBe('Your server is paid only until 1 Jan 2027');
    // The phone's time zone decides the day.
    expect(hostingWarnings(status({ expires: Date.UTC(2026, 8, 27, 23, 30) / 1000, willRenew: false }), null, NOW, 60).banner!.text).toBe('Your server is paid only until 28 Sep');
  });

  // A brand-new server is both at once (paid for 7 days, Hosting empty): one sentence says what to do, not two alarms.
  it('says one thing when the server is paid under 7 days and Hosting is too low to renew it', () => {
    const fresh = hostingWarnings(status({ expires: NOW + 6.99 * 86400, willRenew: false, fundingDays: 0 }), null, NOW, 0);
    expect(fresh).toEqual({
      funding: 'Hosting covers about 0 more days after 28 Sep: top it up or move from Pool',
      fundingTone: 'red',
      vat: null,
      banner: { text: 'Your server is paid until 28 Sep. Top up Hosting and it renews itself.', tone: 'amber', forFunding: true },
    });
    expect(hostingWarnings(status({ expires: NOW + 2 * 86400, willRenew: false, fundingDays: 12 }), null, NOW, 0).banner).toEqual({
      text: 'Your server is paid only until 23 Sep. Top up Hosting, or pay LNVPS from any wallet.', tone: 'red', forFunding: true,
    });
    // LNVPS charging VAT stops renewals whatever Hosting holds: topping up wouldn't renew it, so the two stay apart.
    expect(hostingWarnings(status({ expires: NOW + 6 * 86400, willRenew: false, fundingDays: 0, vatOk: false }), null, NOW, 0).banner).toEqual({
      text: 'Your server is paid only until 27 Sep', tone: 'amber', forFunding: false,
    });
    // Paid for longer (10 days: 3 beyond the 7): the funding line alone, as before.
    expect(hostingWarnings(status({ expires: NOW + 10 * 86400, fundingDays: 0, willRenew: false }), null, NOW, 0)).toEqual({
      funding: 'Hosting covers about 0 more days after 1 Oct: top it up or move from Pool', fundingTone: 'red', vat: null, banner: null,
    });
  });

  // The money line's own colour: amber under 14 days of runway, red under 7; at 7 days paid or
  // under, the runway is Hosting's days (a VM 54 days ahead has plenty, whatever Hosting holds).
  it('colours the funding line amber from 7 days of funding, red under', () => {
    const w = (days: number, fundingDays: number) => hostingWarnings(status({ expires: NOW + days * 86400, fundingDays }), null, NOW, 0);
    expect([w(6, 13.9).fundingTone, w(6, 7).fundingTone, w(6, 6.9).fundingTone, w(54, 0).fundingTone, w(-1, 3).fundingTone]).toEqual(['amber', 'amber', 'red', 'amber', 'red']);
    expect([w(6, 14).funding, w(6, 13.9).funding, w(54, 0).funding]).toEqual([null, 'Hosting covers about 13 more days after 27 Sep: top it up or move from Pool', null]);
  });
});

describe('hostingWarnings: the runway', () => {
  const w = (days: number, fundingDays: number) => hostingWarnings(status({ expires: NOW + days * 86400, fundingDays }), null, NOW, 0);

  // A VM paid 30 days ahead with about 8 days in Hosting warned "Hosting covers about 8 days".
  it("counts the days paid beyond the 7 the renewal keeps, with Hosting's own", () => {
    expect(w(30, 8)).toEqual({ funding: null, fundingTone: 'amber', vat: null, banner: null });
    expect([w(10, 8).funding, w(10, 8).fundingTone]).toEqual(['Hosting covers about 8 more days after 1 Oct: top it up or move from Pool', 'amber']);
    expect(w(10, 3).fundingTone).toBe('red');
    expect(w(10, 11).funding).toBeNull();
  });

  it("is Hosting's days alone at 7 days paid or under", () => {
    expect([w(7, 13.9).funding, w(5, 13.9).funding]).toEqual([
      'Hosting covers about 13 more days after 28 Sep: top it up or move from Pool',
      'Hosting covers about 13 more days after 26 Sep: top it up or move from Pool',
    ]);
    expect([w(7, 14).funding, w(7, 6.9).fundingTone, w(7, 7).fundingTone]).toEqual([null, 'red', 'amber']);
  });
});

describe('renewProblem', () => {
  it('says what Hosting has against the need, exactly in msat when the view would round them to the same', () => {
    expect(renewProblem(2_000_000, 1_000)).toBeNull();
    expect(renewProblem(1_000_000, 1_000)).toBe('Hosting has 1,000 sat; this needs up to 1,010 sat with routing fees.');
    // 1,001 sat needs 1,011,005 msat: against 1,011,000 both read "1,011 sat".
    expect(renewProblem(1_011_000, 1_001)).toBe('Hosting has 1,011,000 msat; this needs up to 1,011,005 msat with routing fees.');
  });
});
