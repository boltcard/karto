import { describe, expect, it } from 'vitest';
import type { Wallet } from '../cardd/client';
import { capacityLine, salesToday, shopTile } from './shop';

const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
const wallet = (shop?: Partial<NonNullable<Wallet['shop']>>): Wallet => ({
  cards: [],
  pool: { balanceMsat: 48_500_000, heldMsat: 0, address: 'pool@vm.example.net' },
  hosting: { balanceMsat: 18_789_000, heldMsat: 0, address: 'hosting@vm.example.net' },
  paused: false, pausedReason: '', liquidity: null, restore: null,
  ...(shop ? { shop: { balanceMsat: 0, heldMsat: 0, address: '', phones: 0, sales: 0, ...shop } } : {}),
});

// The wallet's wide Shop tile.
describe('shopTile', () => {
  it('is hidden with nothing of a shop: no wallet yet, an older server, or no phone, balance or sale', () => {
    expect(shopTile(null, 5)).toBeNull();
    expect(shopTile(wallet(), 5)).toBeNull();
    expect(shopTile(wallet({}), 0)).toBeNull();
  });

  it('shows for a PoS phone, a balance or a past sale', () => {
    expect(shopTile(wallet({ phones: 1 }), 0)).toEqual({ balanceMsat: 0, line: '' });
    expect(shopTile(wallet({ balanceMsat: 12_400_999 }), 0)).toEqual({ balanceMsat: 12_400_999, line: '' });
    expect(shopTile(wallet({ sales: 3 }), 0)).toEqual({ balanceMsat: 0, line: '' });
  });

  it("says today's sales beside the balance: none with none, or when the count couldn't be read", () => {
    const w = wallet({ phones: 1, balanceMsat: 12_400_000, sales: 9 });
    expect(shopTile(w, 5)).toEqual({ balanceMsat: 12_400_000, line: '5 sales today' });
    expect(shopTile(w, 1)?.line).toBe('1 sale today');
    expect(shopTile(w, 0)?.line).toBe('');
    expect(shopTile(w, null)?.line).toBe('');
  });

  it('shows what is available: the balance less what a move in progress holds', () => {
    expect(shopTile(wallet({ balanceMsat: 12_400_000, heldMsat: 400_000 }), 0)?.balanceMsat).toBe(12_000_000);
  });

  // Pool, Hosting and the cards stay on the wallet while cardd can't be read; so does Shop.
  it("stays, without its figures, while the wallet can't be read on a server that had a shop", () => {
    expect(shopTile(null, 5, true)).toEqual({ balanceMsat: null, line: '' });
    expect(shopTile(null, null, true)).toEqual({ balanceMsat: null, line: '' });
    expect(shopTile(null, 5, false)).toBeNull();
    // A wallet that answered is believed over the memory: no shop on it, no tile.
    expect(shopTile(wallet(), 5, true)).toBeNull();
    expect(shopTile(wallet({}), 0, true)).toBeNull();
  });
});

describe('salesToday', () => {
  it("is the newest day's count only when that day is the phone's today", () => {
    const today = Date.UTC(2026, 8, 21) / 1000;
    expect(salesToday([{ day: today, count: 5, totalMsat: 12_400_000 }], NOW, 0)).toBe(5);
    expect(salesToday([{ day: today - 86_400, count: 3, totalMsat: 1_000_000 }], NOW, 0)).toBe(0);
    expect(salesToday([], NOW, 0)).toBe(0);
    // Two hours east the day began at 22:00 UTC the evening before.
    expect(salesToday([{ day: today - 7200, count: 2, totalMsat: 1_000 }], NOW, 120)).toBe(2);
    expect(salesToday([{ day: today, count: 2, totalMsat: 1_000 }], NOW, 120)).toBe(0);
    // West of UTC, at a half hour (St John's, -3:30): 14:13 UTC is 10:43 there, and the day began at 03:30 UTC.
    expect(salesToday([{ day: today + 12_600, count: 4, totalMsat: 1_000 }], NOW, -210)).toBe(4);
    expect(salesToday([{ day: today, count: 4, totalMsat: 1_000 }], NOW, -210)).toBe(0);
  });
});

// Shop's page says beforehand why some sales will read +0.
describe('capacityLine', () => {
  const liq = (o: Partial<NonNullable<Wallet['liquidity']>>): Wallet['liquidity'] => ({ channel: true, usable: true, inboundSat: 1_900_000, feeCreditSat: 0, firstChannelFeeSat: 0, ...o });

  it("says nothing while the channel has room, or when it can't be asked", () => {
    expect(capacityLine(liq({}))).toBe('');
    expect(capacityLine(liq({ inboundSat: 100_000 }))).toBe('');
    expect(capacityLine(null)).toBe('');
  });

  it('says a channel is nearly full under 100,000 sat of room', () => {
    expect(capacityLine(liq({ inboundSat: 99_999 }))).toBe(
      "Your server's channel is nearly full: about 99,999 sat more fits. After that the next sales go toward more room, in full, until they add up to its price (about 20,000 sat and a mining fee), and the sale that completes it pays the rest.",
    );
    expect(capacityLine(liq({ inboundSat: 0, usable: false }))).toMatch(/^Your server's channel is nearly full: about 0 sat more fits\./);
  });

  it('says the first sales go toward the channel when there is none: its price less the fee credit already there', () => {
    expect(capacityLine(liq({ channel: false, usable: false, inboundSat: 0, firstChannelFeeSat: 21_411 }))).toBe(
      'Your server has no channel yet. The first sales go toward it, in full, until they add up to its price (at least 21,411 sat), and the sale that completes it pays the rest.',
    );
    expect(capacityLine(liq({ channel: false, usable: false, inboundSat: 0, firstChannelFeeSat: 21_411, feeCreditSat: 8_000 }))).toMatch(/\(at least 13,411 sat\)/);
  });

  it('says the figures in the view: £ at the rate, *** hidden', () => {
    const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
    expect(capacityLine(liq({ inboundSat: 99_999 }), 'fiat', GBP)).toMatch(/nearly full: about £61\.35 more fits\./);
    expect(capacityLine(liq({ inboundSat: 99_999 }), 'hidden', GBP)).toMatch(/nearly full: about \*\*\* more fits\./);
    expect(capacityLine(liq({ channel: false, usable: false, inboundSat: 0, firstChannelFeeSat: 21_411, feeCreditSat: 8_000 }), 'fiat', GBP)).toMatch(/\(at least £8\.23\)/);
    expect(capacityLine(liq({ channel: false, usable: false, inboundSat: 0, firstChannelFeeSat: 21_411 }), 'hidden', GBP)).toMatch(/\(at least \*\*\*\)/);
  });

  it('leaves the figure out once the fee credit covers the estimate: the next sale may complete it', () => {
    expect(capacityLine(liq({ channel: false, usable: false, inboundSat: 0, firstChannelFeeSat: 21_411, feeCreditSat: 21_411 }))).toBe(
      'Your server has no channel yet. The first sales go toward it, in full, until they add up to its price, and the sale that completes it pays the rest.',
    );
  });
});
