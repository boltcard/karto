// Home rendered: Pool, Hosting and Shop as Amounts
// in the app's view with the other figure under them; in *** every amount on it is hidden; a tap anywhere on a box,
// its figure too, opens its account. The watch's snapshot is given as Home reads it; what decides the banners, the stack and
// the phone's card is left out (their own tests cover them), and the view's hook is the test's.
import { fireEvent, render, screen } from '@testing-library/react';
import { router } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../../app/home';
import { BAND_END } from '../../ui/ui';
import type { Wallet } from '../../cardd/client';
import type { Fiat, Rated } from '../../money/fiat';
import type { View } from '../../money/view';
import type { GaveUp } from '../../wallet/accountView';

const NOW_S = Math.floor(Date.now() / 1000);
const FIAT: Fiat = { currency: 'GBP', price: 61_352, time: NOW_S };
const RATED: Rated = { currency: 'GBP', price: 61_352, time: NOW_S };
const look: { view: View; setHidden: (on: boolean) => void } = { view: 'sat', setHidden: vi.fn() };

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
    view: look.view, unit: 'sat', hidden: look.view === 'hidden', setUnit: () => {}, setHidden: look.setHidden, rated: RATED, fiat: FIAT,
    typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: async () => {},
  }),
}));

describe("Home in the app's view", () => {
  beforeEach(() => {
    look.view = 'sat';
    vi.mocked(router.push).mockClear();
    vi.mocked(look.setHidden).mockClear();
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

  it('has an eye beside Settings that hides every amount, and shows them again while hidden', () => {
    const { unmount } = render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide amounts' }));
    expect(look.setHidden).toHaveBeenCalledWith(true);
    unmount();
    look.view = 'hidden';
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: 'Show amounts' }));
    expect(look.setHidden).toHaveBeenCalledWith(false);
  });

  it("keeps the eye's and the gear's hit areas apart: a press between them goes to neither", () => {
    expect(BAND_END.gap).toBeGreaterThanOrEqual(BAND_END.eyeSlop + BAND_END.gearSlop);
  });

  it("opens Pool's account at a tap on its figure: a box does one thing", () => {
    render(<Home />);
    fireEvent.click(screen.getByLabelText('13,291 sat'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/account', params: { id: 'pool' } });
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
