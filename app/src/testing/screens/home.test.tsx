// Home rendered: Pool, Hosting and Shop as Amounts
// in the app's view with the other figure under them; in *** every amount on it is hidden; a tap on any amount moves
// the app to the next view. The watch's snapshot is given as Home reads it; what decides the banners, the stack and
// the phone's card is left out (their own tests cover them), and the view's hook is the test's.
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../../app/home';
import type { Wallet } from '../../cardd/client';
import type { Fiat, Rated } from '../../money/fiat';
import type { View } from '../../money/view';
import type { GaveUp } from '../../wallet/accountView';

const NOW_S = Math.floor(Date.now() / 1000);
const FIAT: Fiat = { currency: 'GBP', price: 61_352, time: NOW_S };
const RATED: Rated = { currency: 'GBP', price: 61_352, time: NOW_S };
const look: { view: View; next: () => void } = { view: 'sat', next: vi.fn() };

const wallet = {
  cards: [], paused: false, pausedReason: '', liquidity: null, restore: null, rev: '0a1b2c3d-1', fiat: FIAT,
  pool: { balanceMsat: 13_291_204, heldMsat: 0, address: 'pool@karto.example' },
  hosting: { balanceMsat: 1_975_000, heldMsat: 0, address: 'hosting@karto.example' },
  shop: { balanceMsat: 12_384_000, heldMsat: 0, address: 'shop@karto.example', phones: 1, sales: 3 },
} as unknown as Wallet;
const snap = {
  cantRead: false, update: null, state: { host: { hostname: 'karto.example' } }, notices: [], cards: [], cardsError: null, wallet,
  salesToday: 3, hadShop: true, photos: {}, nfc: null, backups: null, status: null, unreachable: false,
  phoneCard: { supported: false, ids: [], own: null, record: null, removed: [] }, gaveUp: [] as GaveUp[],
};
const watch = { dismissGaveUp: vi.fn() };

vi.mock('../../services/server', () => ({ useWatcher: () => ({ snap, watch }), useReadCard: () => null }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({}), reopenAppDb: vi.fn() }));
vi.mock('../../wallet/serverView', () => ({ serverView: () => ({ keyNotice: { kind: 'ok' }, moneyOff: false }) }));
vi.mock('../../wallet/bannerInput', () => ({ bannerInput: () => ({}) }));
vi.mock('../../wallet/banners', () => ({ walletBanners: () => [] }));
// The alerts' offer reads the phone's store: its own tests cover it.
vi.mock('../../ui/AlertsOffer', () => ({ AlertsOffer: () => null }));
vi.mock('../../wallet/phoneCardView', () => ({ payButton: () => null, removedNotice: () => null }));
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({
    view: look.view, rated: RATED, fiat: FIAT, showMsat: false, next: look.next, setShowMsat: () => {},
    typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: async () => {},
  }),
}));

describe("Home in the app's view", () => {
  beforeEach(() => {
    look.view = 'sat';
    vi.mocked(look.next).mockClear();
  });

  it("shows Pool, Hosting and Shop to the nearest sat, with today's value under them", () => {
    const { container } = render(<Home />);
    const text = container.textContent ?? '';
    for (const shown of ['13,291', '≈ £8.15', '1,975', '12,384', '3 sales today']) expect(text).toContain(shown);
  });

  it('hides every amount on it in ***: Pool, Hosting and Shop, and the value under them', () => {
    look.view = 'hidden';
    const { container } = render(<Home />);
    const text = container.textContent ?? '';
    expect(text.split('***').length - 1).toBe(3);
    for (const shown of ['13,291', '1,975', '12,384', 'sat', '£']) expect(text).not.toContain(shown);
    // What isn't an amount stays.
    expect(text).toContain('3 sales today');
  });

  it('moves every amount to the next view at a tap on any of them', () => {
    render(<Home />);
    const pool = screen.getAllByRole('button').find((b) => (b.textContent ?? '').startsWith('13,291'));
    fireEvent.click(pool!);
    expect(look.next).toHaveBeenCalledTimes(1);
  });
});

// A card given up on its page: the Wallet page says what was removed and what moved, until it is read.
describe('Home after a card was given up', () => {
  it('says so until the person presses OK', () => {
    look.view = 'sat';
    snap.gaveUp = [{ name: 'Daily', amountMsat: 5_000_000, pending: false }];
    try {
      render(<Home />);
      expect(screen.getByText('Daily was removed: its 5,000 sat moved to Pool.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(watch.dismissGaveUp).toHaveBeenCalledTimes(1);
    } finally {
      snap.gaveUp = [];
    }
  });
});
