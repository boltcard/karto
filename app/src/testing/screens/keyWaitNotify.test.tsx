// The offer under the wait for LNVPS to confirm the server: a button that asks for the notification permission and
// starts the background watch, where the phone can post the notice; honest words where it can't, or may not.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyWaitNotify } from '../../ui/KeyWaitNotify';

const NOSTR = 'ab'.repeat(32);
const armKeyWatch = vi.fn(async (_key: string) => {});
const keyWatchArmed = vi.fn(async () => false);
vi.mock('../../onboarding/keyWatchTask', () => ({ armKeyWatch: (k: string) => armKeyWatch(k), keyWatchArmed: () => keyWatchArmed() }));

const android = {
  postSetupNotice: vi.fn(),
  notificationsAllowed: vi.fn(() => false),
  requestNotifications: vi.fn(async () => true),
};
let native: object = android;
vi.mock('../../services/services', () => ({
  useServices: () => ({ native, phrase: { get: async () => 'the phrase' }, keys: () => ({ nostrPrivateKey: NOSTR }) }),
}));

const WAIT = { timeout: 5000 };
const BUTTON = 'Tell me when it’s ready';
const press = async (name: string) => {
  const b = await screen.findByRole('button', { name }, WAIT);
  await act(async () => fireEvent.click(b));
};

describe('the offer to be told when LNVPS has confirmed the server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native = android;
    android.notificationsAllowed.mockReturnValue(false);
    android.requestNotifications.mockResolvedValue(true);
    keyWatchArmed.mockResolvedValue(false);
  });

  it('asks for the permission, starts the watch with the LNVPS key alone, and says a notification will come', async () => {
    render(<KeyWaitNotify />);
    expect(await screen.findByText(/can send you a notification when LNVPS has confirmed your server/, undefined, WAIT)).toBeTruthy();
    await press(BUTTON);
    expect(android.requestNotifications).toHaveBeenCalledTimes(1);
    expect(armKeyWatch).toHaveBeenCalledWith(NOSTR);
    expect(await screen.findByText(/You’ll get a notification when LNVPS has confirmed your server/, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('says to come back in about an hour when notifications are refused, and starts no watch', async () => {
    android.requestNotifications.mockResolvedValue(false);
    render(<KeyWaitNotify />);
    await press(BUTTON);
    expect(await screen.findByText(/Notifications are off for Karto Wallet, so come back in about an hour/, undefined, WAIT)).toBeTruthy();
    expect(armKeyWatch).not.toHaveBeenCalled();
  });

  it('says why when the watch can\'t start', async () => {
    armKeyWatch.mockRejectedValueOnce(new Error('WorkManager refused'));
    render(<KeyWaitNotify />);
    await press(BUTTON);
    expect(await screen.findByText(/couldn’t set up the notification \(WorkManager refused\), so come back in about an hour/, undefined, WAIT)).toBeTruthy();
  });

  it('promises no notification on a phone that can\'t post one (an iPhone)', async () => {
    native = { requestNotifications: vi.fn(), notificationsAllowed: vi.fn() };
    render(<KeyWaitNotify />);
    expect(await screen.findByText(/This phone can’t tell you when it’s ready, so come back in about an hour/, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/You’ll get a notification/)).toBeNull();
  });

  it('says the watch runs when it was started before the app was closed', async () => {
    keyWatchArmed.mockResolvedValue(true);
    android.notificationsAllowed.mockReturnValue(true);
    render(<KeyWaitNotify />);
    expect(await screen.findByText(/You’ll get a notification when LNVPS has confirmed your server/, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });
});
