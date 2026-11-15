// Karto PoS's Sales screen with a sale refunded from Karto Wallet:
// the refunded sale is tagged and read as refunded; one whose refund is on its way isn't yet.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PosSale } from '../../pos/client';
import Sales from '../../pos-app/sales';

const NOW_S = Math.floor(Date.now() / 1000);
const base = { amountMsat: 5_000_000, state: 'paid', method: 'card', device: { keyId: 'k', name: 'Till 1' }, created: NOW_S, expires: NOW_S + 600, paidAt: NOW_S };
const SALES = [
  { ...base, id: 'a', txId: 2, refund: { state: 'paid', txId: 9, at: NOW_S, amountMsat: 5_000_000 } },
  { ...base, id: 'b', txId: 1, refund: { state: 'pending' } },
] as unknown as PosSale[];

vi.mock('../../pos/app', () => ({
  usePos: () => ({
    paired: { host: 'karto.example', name: 'Till 1' },
    fiat: null,
    ask: (call: (c: { sales: () => Promise<PosSale[]>; days: () => Promise<unknown[]> }) => Promise<unknown>) =>
      call({ sales: async () => SALES, days: async () => [] }),
  }),
}));

describe("the till's Sales with a refund", () => {
  it('tags the refunded sale, and not the one whose refund is on its way', async () => {
    render(<Sales />);
    expect(await screen.findByText('Refunded')).toBeTruthy();
    expect(screen.getAllByText('Refunded')).toHaveLength(1);
    expect(screen.getByLabelText(/, refunded$/)).toBeTruthy();
  });
});
