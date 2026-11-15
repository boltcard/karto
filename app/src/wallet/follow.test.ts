import { describe, expect, it } from 'vitest';
import type { Tx, Wallet } from '../cardd/client';
import { HELD_WAIT_S } from '../cards/poll';
import { historyAsk, walletAsk } from './follow';

const account = { balanceMsat: 0, heldMsat: 0, address: 'pool@vm-1001.lnvps.cloud' };
const walletAt = (rev: string | undefined, poolMsat = 0): Wallet => ({
  cards: [], pool: { ...account, balanceMsat: poolMsat }, hosting: account, paused: false, pausedReason: '', liquidity: null, restore: null, ...(rev ? { rev } : {}),
});
const tx = (id: number, kind = 'topup'): Tx => ({ id, kind, note: '', amountMsat: 1_000_000, feeMsat: 0, created: 1_790_000_000 + id });

/** An account's page as the asks see it: what it shows, what it is shown, and what it told the watch. */
function page(shown: Wallet | null) {
  const p = {
    wallet: shown,
    answers: [] as (Wallet | Error)[],
    asked: [] as ({ since: string; wait: number } | undefined)[],
    reports: [] as boolean[],
    live: true,
  };
  const ask = walletAsk({
    cardd: {
      wallet: async (held) => {
        p.asked.push(held);
        const a = p.answers.shift()!;
        if (a instanceof Error) throw a;
        return a;
      },
    },
    shown: () => p.wallet,
    show: (w) => void (p.wallet = w),
    report: (r) => void p.reports.push(r.ok),
    live: () => p.live,
  });
  return { p, ask };
}

describe('walletAsk', () => {
  it('asks the server to hold a read from the rev shown, shows what comes, and says whether it moved on', async () => {
    const { p, ask } = page(walletAt('fa4eca4d-1'));
    p.answers.push(walletAt('fa4eca4d-2', 3_000_000), walletAt('fa4eca4d-2', 3_000_000));
    expect(await ask()).toBe('moved');
    expect(p.asked).toEqual([{ since: 'fa4eca4d-1', wait: HELD_WAIT_S }]);
    expect(p.wallet).toEqual(walletAt('fa4eca4d-2', 3_000_000));
    expect(await ask()).toBe('held'); // the wait ran out with nothing new
    expect(p.asked[1]).toEqual({ since: 'fa4eca4d-2', wait: HELD_WAIT_S });
    expect(p.reports).toEqual([true, true]);
  });

  it('is a plain read with no rev shown: every 5 seconds for a server from before, and held from the first rev that comes', async () => {
    const { p, ask } = page(null);
    p.answers.push(walletAt(undefined, 1_000), walletAt('fa4eca4d-4'));
    expect(await ask()).toBe('plain');
    expect(p.asked).toEqual([undefined]);
    expect(p.wallet).toEqual(walletAt(undefined, 1_000));
    expect(await ask()).toBe('moved');
    expect(p.asked[1]).toBeUndefined();
  });

  it("doesn't show an answer behind the wallet shown: the page's own load brought a newer one while this was held", async () => {
    const { p, ask } = page(walletAt('fa4eca4d-1'));
    p.answers.push(walletAt('fa4eca4d-2', 3_000_000));
    const held = ask();
    p.wallet = walletAt('fa4eca4d-3', 5_000_000); // the page's own load, after a move
    expect(await held).toBe('moved'); // there is a newer rev to ask past
    expect(p.wallet).toEqual(walletAt('fa4eca4d-3', 5_000_000));
  });

  // A held read is open nearly all the time: every brief drop of the phone's connection lands on one.
  it('says nothing to the watch when a held read drops: the next ask is a plain read, and that one says whether the server answers', async () => {
    const { p, ask } = page(walletAt('fa4eca4d-1'));
    p.answers.push(new Error('offline'), new Error('offline'), walletAt('fa4eca4d-1'));
    await expect(ask()).rejects.toThrow('offline');
    expect([p.asked[0], p.reports]).toEqual([{ since: 'fa4eca4d-1', wait: HELD_WAIT_S }, []]);
    await expect(ask()).rejects.toThrow('offline');
    expect([p.asked[1], p.reports]).toEqual([undefined, [false]]);
    // It answers again: the watch is told, and the next ask is held at once.
    expect(await ask()).toBe('moved');
    expect([p.asked[2], p.reports]).toEqual([undefined, [false, true]]);
    p.answers.push(walletAt('fa4eca4d-1'));
    expect(await ask()).toBe('held');
    expect(p.asked[3]).toEqual({ since: 'fa4eca4d-1', wait: HELD_WAIT_S });
  });

  it('tells the watch of a plain read that failed only while the page is in front, and fails either way', async () => {
    const { p, ask } = page(null);
    p.answers.push(new Error('offline'), new Error('offline'));
    await expect(ask()).rejects.toThrow('offline');
    p.live = false;
    await expect(ask()).rejects.toThrow('offline');
    expect(p.reports).toEqual([false]);
  });
});

describe('historyAsk', () => {
  function history(txs: Tx[], loaded = true) {
    const h = {
      txs, loaded,
      answers: [] as Tx[][],
      asked: [] as unknown[],
      shown: [] as { ids: number[]; startedOver: boolean; sale: boolean }[],
    };
    const ask = historyAsk({
      cardd: { history: async (account, o) => (h.asked.push([account, o]), h.answers.shift()!) },
      id: 'pool',
      page: 3,
      shown: () => ({ txs: h.txs, loaded: h.loaded }),
      show: (next, o) => {
        h.txs = next;
        h.shown.push({ ids: next.map((t) => t.id), ...o });
      },
    });
    return { h, ask };
  }

  it('asks the server to hold a read past the newest row shown, and puts what is newer on top', async () => {
    const { h, ask } = history([tx(5), tx(2)]);
    h.answers.push([tx(6), tx(5), tx(2)], [tx(6), tx(5), tx(2)]);
    expect(await ask()).toBe('moved');
    expect(h.asked).toEqual([['pool', { limit: 3, after: 5, wait: HELD_WAIT_S }]]);
    expect(h.shown).toEqual([{ ids: [6, 5, 2], startedOver: false, sale: false }]);
    expect(await ask()).toBe('held');
    expect(h.asked[1]).toEqual(['pool', { limit: 3, after: 6, wait: HELD_WAIT_S }]);
    expect(h.shown).toHaveLength(1); // nothing newer: nothing shown again
  });

  it("reads the first page itself when the page's own read of it has not come: one that failed heals at the next turn", async () => {
    const { h, ask } = history([], false);
    h.answers.push([tx(2), tx(1)]);
    expect(await ask()).toBe('moved');
    expect(h.asked).toEqual([['pool', { limit: 3 }]]); // a plain read: there is nothing yet to ask past
    expect(h.shown).toEqual([{ ids: [2, 1], startedOver: false, sale: false }]);
    h.loaded = true;
    h.answers.push([tx(2), tx(1)]);
    expect(await ask()).toBe('held');
    expect(h.asked[1]).toEqual(['pool', { limit: 3, after: 2, wait: HELD_WAIT_S }]);
  });

  it('asks past none for a history with nothing in it yet', async () => {
    const { h, ask } = history([], true);
    h.answers.push([tx(1)]);
    expect(await ask()).toBe('moved');
    expect(h.asked).toEqual([['pool', { limit: 3, after: 0, wait: HELD_WAIT_S }]]);
    expect(h.shown).toEqual([{ ids: [1], startedOver: false, sale: false }]);
  });

  it('offers Load more for a whole first page that came at once into a list with nothing in it', async () => {
    const { h, ask } = history([], true);
    h.answers.push([tx(3), tx(2), tx(1)]);
    expect(await ask()).toBe('moved');
    expect(h.shown).toEqual([{ ids: [3, 2, 1], startedOver: true, sale: false }]);
  });

  it('says when the list started over from a whole page of newer rows, and when a sale came', async () => {
    const { h, ask } = history([tx(2), tx(1)]);
    h.answers.push([tx(9), tx(8, 'sale'), tx(7)]);
    expect(await ask()).toBe('moved');
    expect(h.shown).toEqual([{ ids: [9, 8, 7], startedOver: true, sale: true }]);
  });
});
