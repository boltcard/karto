import { describe, expect, it, vi } from 'vitest';
import type { SendAnswer, Tx, Wallet } from '../cardd/client';
import { CarddError } from '../cardd/error';
import { feeBudgetMsat, feeEstimateSat, followSend, sendAllMsat, sendProblem, watchSend } from './send';

describe('feeBudgetMsat', () => {
  it("is cardd's: 0.5% rounded up, plus 5 sat", () => {
    expect(feeBudgetMsat(1_000_000)).toBe(10_000);
    expect(feeBudgetMsat(1)).toBe(5_001);
    expect(feeBudgetMsat(228_000)).toBe(6_140);
  });
});

describe('sendAllMsat', () => {
  it('is the most whole sats Pool can send with its fee budget, as cardd counts it', () => {
    expect(sendAllMsat(0)).toBe(0);
    expect(sendAllMsat(6_004)).toBe(0);
    expect(sendAllMsat(6_005)).toBe(1_000); // 1,000 msat + its 5,005 msat budget
    expect(sendAllMsat(100_000_000)).toBe(99_497_000);
    expect(sendAllMsat(50_000_000)).toBe(49_746_000);
    // cardd checks the msat as they are: a part of a sat in Pool counts.
    expect(sendAllMsat(100_000_490)).toBe(99_498_000);
    expect(sendAllMsat(100_000_489)).toBe(99_497_000);
  });

  it('agrees with sendProblem: All fits, a sat more does not', () => {
    for (let i = 0; i < 2000; i++) {
      const a = i * 49_999_999 + i * i;
      const s = sendAllMsat(a);
      if (s > 0) expect(sendProblem(a, s)).toBeNull();
      expect(sendProblem(a, s + 1000)).not.toBeNull();
    }
  });
});

describe('feeEstimateSat', () => {
  // phoenixd v0.9.2's trampoline fee (conf/Lsp.kt): 4 sat + 0.4%, shown in whole sats rounded up.
  it("is phoenixd's 4 sat + 0.4%, rounded up to whole sats", () => {
    expect(feeEstimateSat(228_000)).toBe(5); // 4.912
    expect(feeEstimateSat(100_000)).toBe(5); // 4.4
    expect(feeEstimateSat(19_000_000)).toBe(80);
    expect(feeEstimateSat(1)).toBe(4);
  });
});

describe('sendProblem', () => {
  it('needs an amount that fits with its fee budget', () => {
    expect(sendProblem(5_000_000, 0)).toBe('Enter an amount.');
    expect(sendProblem(5_000_000, 1_500)).toBe('Send whole sats.');
    expect(sendProblem(5_000_000, 4_970_000)).toBeNull(); // + 29,850 msat = 4,999,850
    // In the view: the nearest whole sat, or exactly in msat (the part of a sat is kept there).
    expect(sendProblem(5_000_000, 4_980_000)).toBe('Pool has 5,000 sat; this needs up to 5,010 sat with routing fees.');
    expect(sendProblem(5_000_000, 4_980_000, {}, 'msat', null)).toBe('Pool has 5,000,000 msat; this needs up to 5,009,900 msat with routing fees.');
    // Figures that would read the same in the view are said exactly, so a refusal never reads as if it fits.
    expect(sendProblem(5_000_000, 4_980_000, {}, 'fiat', { currency: 'GBP', price: 61_352, time: 1_792_037_404 })).toBe('Pool has 5,000,000 msat; this needs up to 5,009,900 msat with routing fees.');
    expect(sendProblem(5_009_600, 4_980_000, {}, 'sat', null)).toBe('Pool has 5,009,600 msat; this needs up to 5,009,900 msat with routing fees.');
    // An invoice's own amount is paid as it is, msat and all; only a typed amount must be whole sats.
    expect(sendProblem(5_000_000, 1_500, { typed: false })).toBeNull();
  });
});

describe('watchSend', () => {
  const pool = (heldMsat: number, txs: Tx[]) => ({
    wallet: async () => ({ cards: [], pool: { heldMsat }, hosting: { heldMsat: 0 } }) as unknown as Wallet,
    history: async () => txs,
  });
  const noWait = { everyMs: 0, sleep: async () => {} };

  it("is sent once pool's history shows the payment, with its fee", async () => {
    const tx: Tx = { id: 1, kind: 'send', note: 'paid ab', amountMsat: -5_025_000, feeMsat: 25_000, created: 0 };
    expect(await watchSend(pool(0, [tx]), 'ab', noWait)).toEqual({ kind: 'sent', feeMsat: 25_000 });
  });

  // A send cut off by a cardd restart before it reached phoenixd is released
  // only after the server's 2-minute grace (ledger.unsentGrace): the watch
  // outlasts it, so the screen gets the answer.
  it('watches for longer than the server waits before releasing an unrecorded send', async () => {
    let t = 0;
    const w = {
      wallet: async () => ({ cards: [], pool: { heldMsat: t < 130_000 ? 5_060_000 : 0 }, hosting: { heldMsat: 0 } }) as unknown as Wallet,
      history: async () => [] as Tx[],
    };
    expect(await watchSend(w, 'ab', { everyMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) })).toEqual({ kind: 'failed' });
  });

  it('has failed when nothing is held and nothing was paid', async () => {
    expect(await watchSend(pool(0, []), 'ab', noWait)).toEqual({ kind: 'failed' });
  });
});

describe('followSend', () => {
  it("reads a send's state until it ends, and gives a reason with a failure", async () => {
    const answers: SendAnswer[] = [
      { status: 'pending', paymentHash: '', amountMsat: 1000 },
      { status: 'failed', paymentHash: 'aa', amountMsat: 1000, reason: 'The receiving wallet refused the payment.' },
    ];
    const cardd = { sendState: vi.fn(async () => answers.shift()!) };
    expect(await followSend(cardd, 'r', { sleep: async () => {} })).toEqual({ kind: 'failed', reason: 'The receiving wallet refused the payment.' });
    expect(cardd.sendState).toHaveBeenCalledWith('r', 20);
  });

  it('asks again after a dropped connection, and says sent with its fee', async () => {
    let n = 0;
    const cardd = { sendState: vi.fn(async () => (n++ === 0 ? Promise.reject(new TypeError('Network request failed')) : { status: 'sent' as const, paymentHash: 'aa', amountMsat: 1000, feeMsat: 4_000 })) };
    expect(await followSend(cardd, 'r', { sleep: async () => {} })).toEqual({ kind: 'sent', feeMsat: 4_000 });
  });

  it('says unconfirmed at once when cardd has no send by that id', async () => {
    const cardd = { sendState: vi.fn(async () => Promise.reject(new CarddError(404, 'not_found', 'store: not found'))) };
    const sleep = vi.fn(async () => {});
    let t = 0;
    expect(await followSend(cardd, 'r', { now: () => (t += 10_000), sleep })).toEqual({ kind: 'unconfirmed' });
    expect(cardd.sendState).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up as unconfirmed after the watch's time", async () => {
    let t = 0;
    const cardd = { sendState: vi.fn(async () => ({ status: 'pending' as const, paymentHash: '', amountMsat: 1000 })) };
    const out = await followSend(cardd, 'r', { now: () => (t += 60_000), sleep: async () => {} });
    expect(out).toEqual({ kind: 'unconfirmed' });
  });
});
