// The wallet's own asks over Home: an unnamed wallet is asked its
// name once per start of the app, a sheet that may be closed; a named wallet, or one whose server keeps no names,
// isn't. With the alerts offer also due the name comes first and the offer follows once the sheet is closed, counted
// only when it shows; the offer waits for the wallet's answer. A name saved on another phone closes the sheet.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../../app/home';
import type { Wallet } from '../../cardd/client';
import { OFFER } from '../../alerts/offer';
import { askedThisRun } from '../../wallet/walletName';
import { blur, refocus } from './focus';

const base = {
  cards: [], paused: false, pausedReason: '', liquidity: null, restore: null, rev: '0a1b2c3d-1',
  pool: { balanceMsat: 0, heldMsat: 0, address: 'pool@karto.example' },
  hosting: { balanceMsat: 0, heldMsat: 0, address: 'hosting@karto.example' },
} as unknown as Wallet;
const snap: { wallet: Wallet | null } & Record<string, unknown> = {
  cantRead: false, update: null, state: { host: { hostname: 'karto.example' } }, notices: [], cards: [], cardsError: null, wallet: null,
  salesToday: 0, hadShop: false, photos: {}, nfc: null, backups: null, status: null, unreachable: false,
  phoneCard: { supported: false, ids: [], own: null, record: null, removed: [] },
};
const store = { offered: false };
const setAlertsOffered = vi.fn(async () => void (store.offered = true));
const setWalletName = vi.fn(async (name: string) => name);

vi.mock('expo-device', () => ({ modelName: 'Pixel 9a' }));
vi.mock('../../services/server', () => ({ useWatcher: () => ({ snap, watch: {} }), useReadCard: () => null }));
vi.mock('../../services/services', () => ({
  useRouteGuard: () => true,
  useServices: () => ({ native: {} }),
  reopenAppDb: vi.fn(),
  walletStore: () => ({ alertsOffered: async () => store.offered, alertsSent: async () => null, setAlertsOffered }),
  alertsClient: () => ({ push: vi.fn(async () => ({})), setWalletName }),
}));
vi.mock('../../alerts/register', () => ({ alertsSupported: () => true }));
vi.mock('../../wallet/serverView', () => ({ serverView: () => ({ keyNotice: { kind: 'ok' }, moneyOff: false }) }));
vi.mock('../../wallet/bannerInput', () => ({ bannerInput: () => ({}) }));
vi.mock('../../wallet/banners', () => ({ walletBanners: () => [] }));
vi.mock('../../wallet/phoneCardView', () => ({ payButton: () => null, removedNotice: () => null }));
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({ view: 'sat', rated: null, fiat: null, showMsat: false, next: () => {}, setShowMsat: () => {}, typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: async () => {} }),
}));

const WAIT = { timeout: 3000 };
const asking = () => screen.queryByText('Name this wallet');
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

describe('the asks over Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    askedThisRun.clear();
    store.offered = true;
    snap.wallet = { ...base, name: '' } as Wallet;
  });

  it('asks an unnamed wallet its name once in a run', async () => {
    const { rerender } = render(<Home />);
    await screen.findByText('Name this wallet', undefined, WAIT);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Pixel 9a');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(setWalletName).toHaveBeenCalledWith('Pixel 9a');
    expect(asking()).toBeNull();
    // Back on Home from another page, the server still saying ''. Not asked again in this run.
    snap.wallet = { ...base, name: '' } as Wallet;
    rerender(<Home />);
    await settle();
    expect(asking()).toBeNull();
  });

  it("doesn't ask a named wallet, or one whose server keeps no names", async () => {
    snap.wallet = { ...base, name: 'Café' } as Wallet;
    const { rerender } = render(<Home />);
    await settle();
    expect(asking()).toBeNull();
    snap.wallet = { ...base } as Wallet;
    rerender(<Home />);
    await settle();
    expect(asking()).toBeNull();
  });

  it('with alerts also due: the name first, then the alerts offer, counted only when it shows', async () => {
    store.offered = false;
    render(<Home />);
    await screen.findByText('Name this wallet', undefined, WAIT);
    await settle();
    expect(screen.queryByText(OFFER.text)).toBeNull();
    expect(setAlertsOffered).not.toHaveBeenCalled();
    // Closed unsaved, by the sheet's own close.
    fireEvent.click(screen.getByLabelText('Close'));
    await screen.findByText(OFFER.text, undefined, WAIT);
    expect(setAlertsOffered).toHaveBeenCalledTimes(1);
    expect(asking()).toBeNull();
  });

  it("holds the alerts offer until the wallet's answer is in", async () => {
    store.offered = false;
    snap.wallet = null;
    render(<Home />);
    await settle();
    expect(screen.queryByText(OFFER.text)).toBeNull();
    expect(setAlertsOffered).not.toHaveBeenCalled();
  });

  // After Update server, the answer with name '' came while the Server page was over Home, and the
  // sheet opened over that page. It waits for Home.
  it('asks only when Home is in front', async () => {
    snap.wallet = null;
    const { rerender } = render(<Home />);
    await act(async () => blur());
    snap.wallet = { ...base, name: '' } as Wallet;
    rerender(<Home />);
    await settle();
    expect(asking()).toBeNull();
    await act(async () => refocus());
    await screen.findByText('Name this wallet', undefined, WAIT);
  });

  // The wallet's name at the top, by "Wallet".
  it("names the wallet in Home's title, after Wallet", async () => {
    snap.wallet = { ...base, name: 'Café' } as Wallet;
    const { rerender } = render(<Home />);
    await settle();
    expect(screen.getByRole('heading').textContent).toBe('Wallet · Café');
    // No name yet, a server that keeps none, and before the wallet's answer: Wallet alone.
    for (const w of [{ ...base, name: '' }, { ...base }, null]) {
      snap.wallet = w as Wallet | null;
      rerender(<Home />);
      await settle();
      expect(screen.getByRole('heading').textContent).toBe('Wallet');
    }
  });

  it('closes the sheet when a name saved on another phone arrives', async () => {
    const { rerender } = render(<Home />);
    await screen.findByText('Name this wallet', undefined, WAIT);
    snap.wallet = { ...base, name: 'Café' } as Wallet;
    rerender(<Home />);
    await settle();
    expect(asking()).toBeNull();
  });
});
