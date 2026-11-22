// Pay LNVPS's invoice for the days chosen: what a press shows at once, one invoice once the presses
// stop, no answer for days no longer chosen, and LNVPS's 429 as a minute's wait.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LnvpsClient } from '../lnvps/client';
import type { FetchFn } from '../lightning/lightning';
import { FakeLnvps } from '../testing/fakeLnvps';
import { vectors } from '../testing/vectors';
import { LNVPS_BUSY, NO_SERVER, useLnvpsInvoice, type LnvpsConnection } from './useLnvpsInvoice';

const VM = 1001;
const path = (url: string) => new URL(url).pathname;

function setup() {
  const fake = new FakeLnvps();
  fake.account.country_code = 'GBR'; // no VAT: the price of a day is the quote's 6,863 sat for 31 days
  fake.vms.set(VM, {
    id: VM, created: '2026-10-01T12:00:00Z', expires: '2026-11-02T12:00:00Z', status: { state: 'running' },
    ip_assignments: [], host_ssh_keys: [], image: {}, ssh_key: { id: 1 },
  });
  // Set: LNVPS's next answer to a request matching re waits for it, as a slow answer does.
  let hold: { re: RegExp; until: Promise<void> } | null = null;
  const fetch: FetchFn = async (input, init) => {
    if (hold?.re.test(path(String(input)))) {
      const wait = hold.until;
      hold = null;
      await wait;
    }
    return fake.http.fetch(input, init);
  };
  const lnvps = new LnvpsClient({ fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey });
  const conn: LnvpsConnection = { lnvps, vmId: VM, cardd: { hosting: async () => Promise.reject(new Error('cardd is not asked')) } };
  const connect = async () => conn;
  const count = (re: RegExp) => fake.http.requests.filter((r) => re.test(path(r.url))).length;
  return {
    fake,
    connect,
    quotes: () => count(/\/renew\/quote$/),
    invoices: () => count(/\/renew-lnurlp$/),
    holdNext: (re: RegExp) => {
      let release!: () => void;
      hold = { re, until: new Promise((r) => (release = r)) };
      return release;
    },
  };
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('useLnvpsInvoice', () => {
  beforeEach(() => void vi.useFakeTimers({ now: Date.parse('2026-10-16T12:00:00Z') }));
  afterEach(() => void vi.useRealTimers());

  it('asks for the first invoice at once, and what it costs at the price of a day LNVPS quotes', async () => {
    const t = setup();
    const { result } = renderHook(() => useLnvpsInvoice(7, t.connect));
    await tick(0);
    // 6,863 sat for 31 days: 7 days are 1,549.7, rounded up.
    expect(result.current.sat).toBe(1_550);
    expect(result.current.invoice).toMatchObject({ days: 7, sat: 1_550 });
    expect([t.quotes(), t.invoices()]).toEqual([1, 1]);
  });

  it('shows what the days cost at each press, and asks for one invoice once the presses stop, at the price of a day kept', async () => {
    const t = setup();
    const { result, rerender } = renderHook(({ days }) => useLnvpsInvoice(days, t.connect), { initialProps: { days: 7 } });
    await tick(0);
    rerender({ days: 14 });
    await tick(300);
    rerender({ days: 30 });
    expect(result.current.sat).toBe(6_642);
    expect(result.current.invoice).toBeNull();
    await tick(799);
    expect([t.quotes(), t.invoices()]).toEqual([1, 1]);
    await tick(1);
    expect(result.current.invoice).toMatchObject({ days: 30, sat: 6_642 });
    expect([t.quotes(), t.invoices()]).toEqual([1, 2]);
  });

  it('drops an invoice that comes for days no longer chosen', async () => {
    const t = setup();
    const release = t.holdNext(/renew-lnurlp$/);
    const { result, rerender } = renderHook(({ days }) => useLnvpsInvoice(days, t.connect), { initialProps: { days: 7 } });
    await tick(0);
    rerender({ days: 30 });
    await tick(800);
    expect(result.current.invoice).toMatchObject({ days: 30 });
    release();
    await tick(0);
    expect(t.fake.invoices.map((i) => Number(i.msat / 1000n))).toEqual([6_642, 1_550]);
    expect(result.current.invoice).toMatchObject({ days: 30 });
  });

  it('asks the price of a day once when a press comes while the first question is out', async () => {
    const t = setup();
    const release = t.holdNext(/\/renew\/quote$/);
    const { result, rerender } = renderHook(({ days }) => useLnvpsInvoice(days, t.connect), { initialProps: { days: 7 } });
    await tick(0);
    rerender({ days: 14 });
    await tick(800);
    release();
    await tick(0);
    expect(result.current.invoice).toMatchObject({ days: 14, sat: 3_100 });
    expect([t.quotes(), t.invoices()]).toEqual([1, 1]);
  });

  it('waits out a 429 that answered days no longer chosen: the limit is the VM\'s', async () => {
    const t = setup();
    const release = t.holdNext(/renew-lnurlp$/);
    const { result, rerender } = renderHook(({ days }) => useLnvpsInvoice(days, t.connect), { initialProps: { days: 7 } });
    await tick(0);
    rerender({ days: 30 });
    t.fake.invoiceStatus = 429;
    release();
    await tick(800);
    expect(result.current).toMatchObject({ busy: true, invoice: null, sat: 6_642 });
    expect(t.invoices()).toBe(1);
    t.fake.invoiceStatus = undefined;
    await tick(60_000);
    expect(result.current).toMatchObject({ busy: false, invoice: { days: 30 } });
    expect(t.invoices()).toBe(2);
  });

  it("waits a minute after LNVPS's 429, saying so, asks nothing meanwhile, then asks again by itself", async () => {
    const t = setup();
    t.fake.invoiceStatus = 429;
    const { result, rerender } = renderHook(({ days }) => useLnvpsInvoice(days, t.connect), { initialProps: { days: 7 } });
    await tick(0);
    expect(result.current).toMatchObject({ busy: true, error: null, invoice: null, sat: 1_550 });
    expect(LNVPS_BUSY).toBe('LNVPS is busy. Asking for the invoice again in a minute…');
    // A press during the minute shows its figure and asks nothing.
    rerender({ days: 14 });
    await tick(800);
    expect(result.current.sat).toBe(3_100);
    expect([t.quotes(), t.invoices()]).toEqual([1, 1]);
    t.fake.invoiceStatus = undefined;
    await tick(58_000);
    expect([t.quotes(), t.invoices()]).toEqual([1, 1]);
    await tick(1_200);
    expect(result.current).toMatchObject({ busy: false, invoice: { days: 14, sat: 3_100 } });
    expect([t.quotes(), t.invoices()]).toEqual([1, 2]);
  });

  it('shows another failure as an error; Try again asks at once at the price kept, New invoice asks the price again', async () => {
    const t = setup();
    t.fake.invoiceStatus = 500;
    const { result } = renderHook(() => useLnvpsInvoice(7, t.connect));
    await tick(0);
    expect(result.current.error).toMatch(/^Couldn't get an invoice from LNVPS: /);
    expect(result.current.busy).toBe(false);
    t.fake.invoiceStatus = undefined;
    act(() => result.current.retry());
    await tick(0);
    expect(result.current).toMatchObject({ error: null, invoice: { days: 7 } });
    expect([t.quotes(), t.invoices()]).toEqual([1, 2]);
    act(() => result.current.renew());
    await tick(0);
    expect(result.current.invoice).toMatchObject({ days: 7 });
    expect([t.quotes(), t.invoices()]).toEqual([2, 3]);
  });

  it('says so when the phone has no server, and asks nothing before the screen may', async () => {
    const t = setup();
    const { result, rerender } = renderHook(({ connect }) => useLnvpsInvoice(7, connect), {
      initialProps: { connect: null as (() => Promise<LnvpsConnection>) | null },
    });
    await tick(1_000);
    expect(t.fake.http.requests).toEqual([]);
    const none = async () => null;
    rerender({ connect: none });
    await tick(0);
    expect(result.current.error).toBe(NO_SERVER);
  });
});
