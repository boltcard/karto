import { describe, expect, it } from 'vitest';
import type { Tx, Wallet } from '../cardd/client';
import { confirmPayment } from './confirm';

describe('confirmPayment', () => {
  const ID = 'e07ce1279d980ecb892a81924b67bf18';
  // The card's server as the phone sees it: its held amount and history change as the payment goes.
  const server = (steps: { heldMsat: number; txs: Tx[] }[]) => {
    let i = 0;
    const now = () => steps[Math.min(i, steps.length - 1)];
    return {
      wallet: async () => {
        i++;
        return { cards: [{ id: ID, heldMsat: now().heldMsat }] } as unknown as Wallet;
      },
      history: async () => now().txs,
    };
  };
  const noWait = { everyMs: 0, timeoutMs: 1000, sleep: async () => {} };

  it('is paid once the card shows "paid <hash>", with what the card paid', async () => {
    const tx: Tx = { id: 9, kind: 'spend', note: 'paid 00ff', amountMsat: -1_012_000, feeMsat: 12_000, created: 0 };
    const s = server([{ heldMsat: 1_020_000, txs: [] }, { heldMsat: 1_020_000, txs: [] }, { heldMsat: 0, txs: [tx] }]);
    expect(await confirmPayment(s, ID, '00ff', noWait)).toEqual({ kind: 'paid', cardMsat: 1_012_000, feeMsat: 12_000 });
  });

  it('has failed when the hold is gone and nothing was paid', async () => {
    const s = server([{ heldMsat: 1_020_000, txs: [] }, { heldMsat: 0, txs: [] }]);
    expect(await confirmPayment(s, ID, '00ff', noWait)).toEqual({ kind: 'failed' });
  });

  it('is unconfirmed while the payment is still on its way', async () => {
    let t = 0;
    const s = server([{ heldMsat: 1_020_000, txs: [] }]);
    const r = await confirmPayment(s, ID, '00ff', { everyMs: 1000, timeoutMs: 5000, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(r).toEqual({ kind: 'unconfirmed' });
  });
});
