// Setup's Name this wallet page: prefilled with the phone's model;
// Save names the wallet; Save or leaving goes on to the Alerts step when it is to follow (counted as asked only
// then, and in place of this page, so Back from it is the wallet), else back to the wallet. Either way the wallet
// isn't asked again in this run.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { router, useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WalletName from '../../app/wallet-name';
import { askedThisRun } from '../../wallet/walletName';

const calls: string[] = [];
const offerShown = vi.fn(async (_d: unknown) => void calls.push('offerShown'));
const setWalletName = vi.fn(async (name: string) => {
  calls.push(`setWalletName ${name}`);
  return name;
});

vi.mock('expo-device', () => ({ modelName: 'Pixel 9a' }));
vi.mock('../../alerts/offer', async (real) => ({ ...(await real<typeof import('../../alerts/offer')>()), offerShown: (d: unknown) => offerShown(d) }));
vi.mock('../../services/server', () => ({ useCardDeps: () => ({ host: 'karto.example', cardd: { setWalletName } }) }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({}), walletStore: () => ({}) }));

describe('the Name this wallet page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    askedThisRun.clear();
    vi.mocked(useLocalSearchParams).mockReturnValue({ setup: '1', alerts: '1' });
    vi.mocked(router.replace).mockImplementation(() => void calls.push('replace'));
    Object.assign(router, { canGoBack: vi.fn(() => true) });
  });

  it("is prefilled with the phone's model, and asks nothing yet", () => {
    render(<WalletName />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Pixel 9a');
    expect(screen.getByText('Name this wallet')).toBeTruthy();
    expect(offerShown).not.toHaveBeenCalled();
  });

  // The run in which this page was shown counts as asked, however it is left (an iPhone's swipe back
  // included), so Home doesn't ask the same thing again at once.
  it('counts the wallet as asked as soon as it shows', () => {
    render(<WalletName />);
    expect(askedThisRun.has('karto.example')).toBe(true);
  });

  it('names the wallet, then counts the alerts offer, then shows the Alerts step in its place', async () => {
    render(<WalletName />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Café ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(calls).toEqual(['setWalletName Café', 'offerShown', 'replace']);
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/alerts', params: { setup: '1' } });
    expect(askedThisRun.has('karto.example')).toBe(true);
  });

  it('left by its arrow: no name, and the Alerts step still follows', async () => {
    render(<WalletName />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Back' })));
    expect(setWalletName).not.toHaveBeenCalled();
    expect(calls).toEqual(['offerShown', 'replace']);
    expect(askedThisRun.has('karto.example')).toBe(true);
  });

  it('goes back to the wallet when no Alerts step follows', async () => {
    vi.mocked(useLocalSearchParams).mockReturnValue({ setup: '1', alerts: '0' });
    render(<WalletName />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(offerShown).not.toHaveBeenCalled();
    expect(router.back).toHaveBeenCalled();
  });

  it('stays, with the reason, when the server refuses the name', async () => {
    setWalletName.mockRejectedValueOnce(new Error('offline'));
    render(<WalletName />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
