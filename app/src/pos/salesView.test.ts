import { describe, expect, it } from 'vitest';
import type { PosDay, PosSale } from './client';
import { fiatSpoken, minorSpoken, type Rated } from '../money/fiat';
import { salesDays, salesHead } from './salesView';

const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
const at = (daysAgo: number, h: number, m: number) => Date.UTC(2026, 8, 21 - daysAgo, h, m) / 1000;
const day = (daysAgo: number, count: number, totalMsat: number, offsetMin = 0): PosDay => ({ day: Date.UTC(2026, 8, 21 - daysAgo) / 1000 - offsetMin * 60, count, totalMsat });
const sale = (n: number, paidAt: number, amountMsat: number, method: 'card' | 'qr' = 'card', name = 'Till 1'): PosSale => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, amountMsat, state: 'paid', method, device: { keyId: 'k', name }, created: paidAt - 30, expires: paidAt + 570, paidAt, txId: n,
});

// The shop's paid sales as a till sees them, with prices and never Shop's balance.
describe('salesHead', () => {
  it("says today's sales and their total", () => {
    expect(salesHead([day(0, 5, 12_400_000), day(1, 2, 6_500_000)], NOW, 0)).toEqual({ title: 'Today · 5 sales', total: '12,400 sat' });
    expect(salesHead([day(0, 1, 2_500_000)], NOW, 0)).toEqual({ title: 'Today · 1 sale', total: '2,500 sat' });
  });

  it("says there are none when the newest day isn't today, or there is no day at all", () => {
    expect(salesHead([day(1, 2, 6_500_000)], NOW, 0)).toEqual({ title: 'No sales today', total: '' });
    expect(salesHead([], NOW, 0)).toEqual({ title: 'No sales today', total: '' });
    // Counted in another offset's days: not this phone's today.
    expect(salesHead([day(0, 5, 12_400_000)], NOW, 120)).toEqual({ title: 'No sales today', total: '' });
    expect(salesHead([day(0, 5, 12_400_000, 120)], NOW, 120).title).toBe('Today · 5 sales');
  });
});

describe('salesDays', () => {
  const sales = [sale(5, at(0, 14, 2), 2_500_000), sale(4, at(0, 9, 30), 9_900_000, 'qr', 'Front'), sale(3, at(1, 18, 0), 4_000_000), sale(2, at(1, 12, 0), 2_500_000, 'qr'), sale(1, at(40, 12, 0), 1_000_000)];
  const days = [day(0, 2, 12_400_000), day(1, 2, 6_500_000)];

  it('groups the sales by day, newest first, each heading with its count and total where the shop counted the day', () => {
    const out = salesDays(sales, days, NOW, 0);
    expect(out.map((d) => [d.day, d.rows.map((r) => r.id)])).toEqual([
      ['Today · 2 sales · 12,400 sat', [sales[0].id, sales[1].id]],
      ['Yesterday · 2 sales · 6,500 sat', [sales[2].id, sales[3].id]],
      // A day the count didn't return has its plain heading.
      ['12 Aug', [sales[4].id]],
    ]);
  });

  // A till lists only the sales it took, so a row doesn't name the phone.
  it('says each sale: its time, how it was paid, and its price with a plus', () => {
    const [today] = salesDays(sales, days, NOW, 0);
    expect(today.rows).toEqual([
      { id: sales[0].id, name: 'Sale', line: '14:02 · Card', amount: '+2,500 sat', under: null, label: 'Sale, 14:02, Card, plus 2,500 sat', refunded: false },
      { id: sales[1].id, name: 'Sale', line: '09:30 · QR', amount: '+9,900 sat', under: null, label: 'Sale, 09:30, QR, plus 9,900 sat', refunded: false },
    ]);
  });

  it("puts a sale in the phone's day, and one dated a moment ahead of its clock under today", () => {
    const late = at(1, 23, 30);
    expect(salesDays([sale(1, late, 1_000_000)], [], NOW, 0)[0].day).toBe('Yesterday');
    const east = salesDays([sale(1, late, 1_000_000)], [], NOW, 120)[0];
    expect([east.day, east.rows[0].line]).toEqual(['Today', '01:30 · Card']);
    expect(salesDays([sale(2, NOW + 30, 1_000_000), sale(1, NOW - 60, 1_000_000)], [], NOW, 0).map((d) => d.rows.length)).toEqual([2]);
  });

  it('gives nothing for no sales', () => {
    expect(salesDays([], days, NOW, 0)).toEqual([]);
  });
});

// No cycle here. A sale rung up in a currency shows its price large and
// its sats under it; a sale typed in sats shows its sats with today's value under it when the shop has a currency.
// A sale refunded from Karto Wallet is marked; one whose refund is on its way isn't yet.
describe('salesDays and refunds', () => {
  it('marks a refunded sale, and only once its refund is paid', () => {
    const base = { amountMsat: 5_000_000, state: 'paid' as const, method: 'card' as const, device: { keyId: 'k', name: 'Till 1' }, created: NOW, expires: NOW + 600, paidAt: NOW };
    const days = salesDays(
      [{ ...base, id: 'a', refund: { state: 'paid', txId: 9, at: NOW, amountMsat: 5_000_000 } }, { ...base, id: 'b', refund: { state: 'pending' } }, { ...base, id: 'c', refund: null }],
      [], NOW, 0,
    );
    expect(days[0].rows.map((r) => [r.id, r.refunded])).toEqual([['a', true], ['b', false], ['c', false]]);
    expect(days[0].rows[0].label).toMatch(/, refunded$/);
  });

  // Today's only sale refunded is no "No sales today".
  it("says Today · 0 sales when today's sales were all refunded", () => {
    const back = { ...sale(8, at(0, 14, 2), 2_500_000), refund: { state: 'paid' as const, txId: 9, at: NOW, amountMsat: 2_500_000 } };
    expect(salesHead([day(1, 2, 6_500_000)], NOW, 0, [back])).toEqual({ title: 'Today · 0 sales', total: '0 sat' });
    expect(salesHead([day(1, 2, 6_500_000)], NOW, 0, [sale(3, at(1, 18, 0), 4_000_000)])).toEqual({ title: 'No sales today', total: '' });
    expect(salesDays([back], [day(1, 2, 6_500_000)], NOW, 0)[0].day).toBe('Today · 0 sales · 0 sat');
    // A sale of today not refunded, with no count yet (an older cardd, or counts not read): no "0 sales".
    const kept = sale(9, at(0, 13, 0), 1_000_000);
    expect(salesHead([], NOW, 0, [back, kept]).title).toBe('No sales today');
    expect(salesDays([back, kept], [], NOW, 0)[0].day).toBe('Today');
  });
});

describe('salesDays with a currency', () => {
  const GBP: Rated = { currency: 'GBP', price: 61_352, time: NOW };
  const priced = { ...sale(7, at(0, 14, 2), 4_386_000), price: { currency: 'GBP' as const, minor: 250 } };
  const plain = sale(6, at(0, 13, 40), 2_000_000, 'qr');

  it('shows a priced sale by its price, its sats under it, at any rate or none', () => {
    for (const r of [GBP, null]) {
      expect(salesDays([priced], [], NOW, 0, r)[0].rows[0]).toEqual({
        id: priced.id, name: 'Sale', line: '14:02 · Card', amount: '+£2.50', under: '4,386 sat',
        label: `Sale, 14:02, Card, plus ${minorSpoken(250, 'GBP')}, 4,386 sat`, refunded: false,
      });
    }
  });

  it("shows a sale typed in sats with today's value under it, marked now", () => {
    expect(salesDays([plain], [], NOW, 0, GBP)[0].rows[0]).toMatchObject({
      amount: '+2,000 sat', under: '£1.23 now', label: `Sale, 13:40, QR, plus 2,000 sat, worth ${fiatSpoken(2_000_000, GBP)} now`,
    });
    expect(salesDays([plain], [], NOW, 0, null)[0].rows[0]).toMatchObject({ amount: '+2,000 sat', under: null });
  });

  it('keeps the headings in sats', () => {
    expect(salesDays([priced, plain], [day(0, 2, 6_386_000)], NOW, 0, GBP)[0].day).toBe('Today · 2 sales · 6,386 sat');
  });

  it('shows a price in a currency this app does not know by its sats alone', () => {
    const future = { ...sale(8, at(0, 14, 2), 4_386_000), price: { currency: 'XYZ' as never, minor: 250 } };
    expect(salesDays([future], [], NOW, 0, GBP)[0].rows[0]).toMatchObject({ amount: '+4,386 sat', under: '£2.69 now' });
  });
});
