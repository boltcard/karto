// The ready page at the end of setup: a wallet whose server has no name yet goes on to the name page,
// with the Alerts step to follow when alerts can be offered, counted only when that step shows (the name page counts
// it). A server that already has a name (a restore, a rebuild) or none to keep (older) goes on as before: Next to the
// Alerts step, counted here, or the wallet.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { router } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingState } from '../../onboarding/machine';
import { SetupDone } from '../../ui/SetupDone';
import { askedThisRun } from '../../wallet/walletName';

const offer = { due: true };
const offerShown = vi.fn(async (_d: unknown) => {});
const walletRead = vi.fn(async (): Promise<{ name?: string }> => ({ name: '' }));
vi.mock('../../alerts/offer', async (real) => ({
  ...(await real<typeof import('../../alerts/offer')>()),
  offerDue: vi.fn(async () => offer.due),
  offerShown: (d: unknown) => offerShown(d),
}));
vi.mock('../../alerts/register', () => ({ alertsSupported: () => true }));
vi.mock('../../services/server', () => ({ useServer: () => ({ watch: { forget: vi.fn() } }) }));
vi.mock('../../services/services', () => ({
  useServices: () => ({ native: {} }),
  syncHostingIfDue: vi.fn(async () => null),
  walletStore: () => ({}),
  alertsClient: () => ({ wallet: () => walletRead() }),
}));

const done = { step: 'done', host: { hostname: 'vm-1.lnvps.cloud' } } as unknown as OnboardingState;
const WAIT = { timeout: 5000 };
const press = async (name: string) => {
  const b = await screen.findByRole('button', { name }, WAIT);
  await act(async () => fireEvent.click(b));
};

describe('the ready page at the end of setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    offer.due = true;
    walletRead.mockImplementation(async () => ({ name: '' }));
    askedThisRun.clear();
    // The ready page empties the stack under the wallet: setup.ts's router has no such calls.
    Object.assign(router, { canDismiss: vi.fn(() => false), dismissAll: vi.fn() });
  });

  it('opens the wallet with the name page over it, alerts to follow and not yet counted', async () => {
    render(<SetupDone s={done} title="Setting up" />);
    await press('Next');
    expect(router.replace).toHaveBeenCalledWith('/home');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/wallet-name', params: { setup: '1', alerts: '1' } });
    expect(offerShown).not.toHaveBeenCalled();
    // Counted as asked before the wallet shows, so the wallet's own ask can't open under the page.
    expect(askedThisRun.has('vm-1.lnvps.cloud')).toBe(true);
  });

  it('opens the page once when Next is pressed twice', async () => {
    render(<SetupDone s={done} title="Setting up" />);
    const next = await screen.findByRole('button', { name: 'Next' }, WAIT);
    await act(async () => {
      fireEvent.click(next);
      fireEvent.click(next);
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(offerShown).not.toHaveBeenCalled();
  });

  it('says Next for the name page alone when alerts are not to be offered', async () => {
    offer.due = false;
    render(<SetupDone s={done} title="Setting up" />);
    await press('Next');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/wallet-name', params: { setup: '1', alerts: '0' } });
  });

  it("asks the name when the server's wallet can't be read in time", async () => {
    walletRead.mockRejectedValue(new Error('offline'));
    render(<SetupDone s={done} title="Setting up" />);
    await press('Next');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/wallet-name', params: { setup: '1', alerts: '1' } });
  });

  describe('a server that already has a name (a restore), or none to keep', () => {
    for (const [what, answer] of [['named', { name: 'Café' }], ['older', {}]] as const) {
      it(`${what}: goes to the Alerts step, counted as asked`, async () => {
        walletRead.mockImplementation(async () => answer);
        render(<SetupDone s={done} title="Setting up" />);
        await press('Next');
        expect(offerShown).toHaveBeenCalledTimes(1);
        expect(router.replace).toHaveBeenCalledWith('/home');
        expect(router.push).toHaveBeenCalledWith({ pathname: '/alerts', params: { setup: '1' } });
      });
    }

    it("opens the wallet without the step when the offer can't be counted, so home asks", async () => {
      walletRead.mockImplementation(async () => ({ name: 'Café' }));
      offerShown.mockRejectedValueOnce(new Error('disk full'));
      render(<SetupDone s={done} title="Setting up" />);
      await press('Next');
      expect(router.replace).toHaveBeenCalledWith('/home');
      expect(router.push).not.toHaveBeenCalled();
    });

    it('opens the wallet as before when alerts are not to be offered', async () => {
      walletRead.mockImplementation(async () => ({ name: 'Café' }));
      offer.due = false;
      render(<SetupDone s={done} title="Setting up" />);
      await press('Open the wallet');
      expect(offerShown).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith('/home');
      expect(router.push).not.toHaveBeenCalled();
    });
  });
});
