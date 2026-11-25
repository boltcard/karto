// The Server page's disk card: what is happening and, when a rebuild would free enough, Rebuild server, which goes
// as Settings' row does (back to home, which Rebuild server then replaces). The watch and the view are fixed; the
// cards are real.
import { fireEvent, render, screen } from '@testing-library/react';
import { router } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Server from '../../app/server';
import type { DiskAnswer } from '../../cardd/client';
import type { OnboardingState } from '../../onboarding/machine';
import type { ServerView } from '../../wallet/serverView';

const view: { now: ServerView } = { now: null as unknown as ServerView };
const snap: { now: object } = { now: {} };
vi.mock('../../services/server', () => ({ useWatcher: () => ({ snap: snap.now, watch: {} }) }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({ phrase: { outlivesApp: false } }) }));
vi.mock('../../wallet/serverView', () => ({ serverView: () => view.now }));

const state: OnboardingState = {
  step: 'done', payDays: 30, installed: [], vmId: 1001,
  host: { hostname: 'vm-1001.lnvps.cloud', ipv4: '45.67.89.10', sshPort: 22, keySource: 'lnvps', hostKeys: [] } as unknown as OnboardingState['host'],
};
const VIEW: ServerView = {
  keyNotice: { kind: 'ok', text: "LNVPS has confirmed this server's SSH key." },
  rebuild: null, oldVm: null, paused: '', setBooks: false, restore: null, offerUpdate: false, updating: null, sshBusy: false, moneyOff: false,
};
const low: DiskAnswer = { freeBytes: 1_400_000_000, totalBytes: 10_700_000_000, freeableBytes: 3e9, rebuildHelps: true, level: 'low' };
function show(disk: DiskAnswer, v: Partial<ServerView> = {}) {
  view.now = { ...VIEW, ...v };
  snap.now = { state, status: { kind: 'ok', version: '0.7.0', updateAvailable: false, disk }, unreachable: false, backups: null, update: null, retire: {} };
  render(<Server />);
}

describe("the Server page's disk card", () => {
  beforeEach(() => vi.clearAllMocks());

  it('says the disk is nearly full and Rebuild server opens the rebuild over home', () => {
    show(low);
    expect(screen.getByText('The disk is nearly full')).toBeTruthy();
    expect(screen.getByText(/^1\.4 GB of 10\.7 GB is left\. phoenixd/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild server' }));
    expect(router.dismissTo).toHaveBeenCalledWith('/home');
    expect(router.replace).toHaveBeenCalledWith('/rebuild');
  });

  it('says a critical disk is almost full, rebuild now, and goes home before it opens the rebuild', () => {
    show({ ...low, freeBytes: 400_000_000, level: 'critical' });
    expect(screen.getByText('The disk is almost full: rebuild now')).toBeTruthy();
    expect(screen.getByText(/^400 MB of 10\.7 GB is left\. phoenixd/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild server' }));
    const [home] = vi.mocked(router.dismissTo).mock.invocationCallOrder;
    const [rebuild] = vi.mocked(router.replace).mock.invocationCallOrder;
    expect(home).toBeLessThan(rebuild);
  });

  it('turns Rebuild server off while the phone is busy with the server over SSH', () => {
    show(low, { sshBusy: true });
    expect(screen.getByRole('button', { name: 'Rebuild server' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('offers no rebuild that would free too little', () => {
    show({ ...low, freeableBytes: 3e8, rebuildHelps: false });
    expect(screen.getByText(/something other than Karto's own data is filling the disk/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rebuild server' })).toBeNull();
  });
});
