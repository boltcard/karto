// Home rendered after a restore: the server lets no card pay until it has been held to the phone, and Home says
// so plainly, with an amber banner counting them and each such card's strip saying "hold to phone". A card to
// re-point says "re-point" alone: its re-point is the check. The watch's snapshot is given as Home reads it, with
// the real banners and stack; serverView, the alerts' offer and the phone's card are left out (their own tests
// cover them).
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Home from '../../app/home';
import type { CardInfo, Wallet } from '../../cardd/client';

const HOST = 'karto.example';
const card = (id: string, name: string, o: Partial<CardInfo> = {}): CardInfo => ({
  id, name, version: 0, state: 'active', counter: 4, host: HOST, created: Number(id.slice(1)), updated: 0, ...o,
});
const cards = [
  card('c1', 'Daily', { needsCheck: true }),
  card('c2', 'Travel', { needsCheck: true, state: 'frozen' }),
  card('c3', 'Spare', { needsCheck: true, host: 'vm-1009.lnvps.cloud' }),
  card('c4', 'Gift'),
];
const account = (balanceMsat: number) => ({ balanceMsat, heldMsat: 0, address: `x@${HOST}` });
const wallet = {
  cards: cards.map((c) => ({ ...c, ...account(1_000_000), spent24hMsat: 0, perTapSat: 20_000, dailySat: 50_000 })),
  paused: false, pausedReason: '', liquidity: null, restore: null, rev: '0a1b2c3d-1',
  pool: account(0), hosting: account(0),
} as unknown as Wallet;
const snap = {
  cantRead: false, update: null, state: { host: { hostname: HOST } }, notices: [], cards, cardsError: null, wallet,
  salesToday: 0, hadShop: false, photos: {}, nfc: 'on', backups: null, status: null, unreachable: false,
  hosting: null, lnvpsExpires: null,
  phoneCard: { supported: false, ids: [], own: null, record: null, removed: [] },
};

vi.mock('../../services/server', () => ({ useWatcher: () => ({ snap, watch: {} }), useReadCard: () => null }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({}), reopenAppDb: vi.fn() }));
vi.mock('../../wallet/serverView', () => ({
  serverView: () => ({ keyNotice: { kind: 'ok', text: '' }, moneyOff: false, updating: null, oldVm: null, restore: null, rebuild: null }),
}));
vi.mock('../../ui/AlertsOffer', () => ({ AlertsOffer: () => null }));
vi.mock('../../wallet/phoneCardView', () => ({ payButton: () => null, removedNotice: () => null }));

describe('Home after a restore', () => {
  it('says which cards to hold to the phone before they can pay', () => {
    const { container } = render(<Home />);
    const text = container.textContent ?? '';
    expect(text).toContain("2 cards can't pay until you hold each to the phone");
    expect(text).toContain('1 card to re-point: hold it to the phone');
    expect(text.split('hold to phone').length - 1).toBe(2);
    // Each tag on its card's strip.
    for (const [name, tag] of [['Daily', 'hold to phone'], ['Travel', 'hold to phone'], ['Spare', 're-point']]) {
      const strip = [...container.querySelectorAll('[role="button"]')].find((b) => b.getAttribute('aria-label')?.startsWith(`${name},`));
      expect(strip?.textContent).toContain(tag);
    }
    const gift = [...container.querySelectorAll('[role="button"]')].find((b) => b.getAttribute('aria-label')?.startsWith('Gift,'));
    expect(gift?.textContent).not.toContain('hold to phone');
  });

  it('names each card with its tag for a screen reader', () => {
    render(<Home />);
    for (const name of ['Daily, Active, hold to phone', 'Travel, Frozen, hold to phone', 'Spare, Active, re-point', 'Gift, Active']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});
