import { describe, expect, it } from 'vitest';
import type { Wallet } from '../cardd/client';
import { pausedText } from '../cards/labels';
import type { Vm } from '../lnvps/client';
import { HOST_KEY_CONFIRM_WAIT_MS, type OnboardingState, type ServerHost } from '../onboarding/machine';
import { UNREACHABLE_SUGGEST_MS } from '../onboarding/serverPage';
import { serverView, type ServerViewInput } from './serverView';

const NOW = 1_790_000_000_000;
const host = (o: Partial<ServerHost> = {}): ServerHost => ({
  ipv4: '45.67.89.10', hostname: 'vm-1001.lnvps.cloud', user: 'root', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3Nza' }, keySource: 'lnvps', ...o,
});
const saved = (o: Partial<OnboardingState> = {}): OnboardingState => ({ step: 'done', payDays: 30, installed: [], vmId: 1001, host: host(), ...o });
const vm = (o: Partial<Vm> = {}): Vm => ({
  id: 1001, created: '2026-09-01T00:00:00Z', expires: '2026-11-02T12:00:00Z', status: { state: 'running' },
  ip_assignments: [], host_ssh_keys: [], image: {}, ssh_key: { id: 1 }, ...o,
});
const account = { balanceMsat: 0, heldMsat: 0, address: 'pool@vm-1001.lnvps.cloud' };
const WALLET: Wallet = { cards: [], pool: account, hosting: account, paused: false, pausedReason: '', liquidity: null, restore: null };
const PAUSED: Wallet = { ...WALLET, paused: true, pausedReason: 'books 120000 msat over' };
const WELL: ServerViewInput = {
  state: saved(),
  status: { kind: 'ok', version: '0.7.0', updateAvailable: false },
  unreachable: false,
  wallet: WALLET,
  lnvps: { vm: vm(), old: [], lnvpsNowMs: NOW, unreachableSince: null },
  update: null,
  retire: { running: false },
  keyCheckedAt: NOW,
};
const view = (o: Partial<ServerViewInput>) => serverView({ ...WELL, ...o }, NOW);

// What Settings › Server shows and offers, as the server page worked it out.
describe('serverView', () => {
  it('is nothing before the watch holds a finished setup', () => {
    expect(view({ state: null })).toBeNull();
  });

  it('offers nothing for a well server', () => {
    expect(view({})).toEqual({
      keyNotice: { kind: 'ok', text: "LNVPS has confirmed this server's SSH key." },
      rebuild: null,
      oldVm: null,
      paused: '',
      setBooks: false,
      restore: null,
      offerUpdate: false,
      updating: null,
      sshBusy: false,
      moneyOff: false,
    });
  });

  it('judges the host-key notice at the last key check, as the server page did', () => {
    const pending = saved({ host: host({ keySource: 'first_use', trustedAt: NOW }) });
    const later = NOW + HOST_KEY_CONFIRM_WAIT_MS + 1;
    expect(serverView({ ...WELL, state: pending }, later)!.keyNotice.kind).toBe('pending');
    expect(serverView({ ...WELL, state: pending, keyCheckedAt: later }, later)!.keyNotice.kind).toBe('overdue');
  });

  it('suggests a rebuild from what LNVPS says, and from cardd not answering for over an hour by the last status', () => {
    expect(view({ lnvps: { ...WELL.lnvps!, vm: null } })!.rebuild).toEqual({
      text: 'LNVPS no longer lists VM 1001: your server is gone. Rebuild it from a backup.', gone: true,
    });
    const quiet = { ...WELL.lnvps!, unreachableSince: NOW - UNREACHABLE_SUGGEST_MS - 1 };
    expect(view({ lnvps: quiet, status: { kind: 'unreachable', message: 'no answer' } })!.rebuild).toMatchObject({ gone: false });
    expect(view({ lnvps: quiet, status: null })!.rebuild).toMatchObject({ gone: false });
    expect(view({ lnvps: quiet })!.rebuild).toBeNull();
    // Before LNVPS answers, and for a state without a VM, nothing is suggested.
    expect(view({ lnvps: null, status: null })!.rebuild).toBeNull();
    expect(view({ state: saved({ vmId: undefined }), lnvps: { ...WELL.lnvps!, vm: null } })!.rebuild).toBeNull();
  });

  it('warns of the old server running when LNVPS reports it, naming the VM Retire retires', () => {
    const state = saved({ rebuild: { source: 'server_page', oldVm: { id: 1012 } } });
    expect(view({ state, lnvps: { ...WELL.lnvps!, old: [vm({ id: 1012 })] } })!.oldVm).toMatchObject({ vmId: 1012 });
    expect(view({ state, lnvps: { ...WELL.lnvps!, old: ['unreachable'] } })!.oldVm).toBeNull();
    expect(view({ state, lnvps: null })!.oldVm).toBeNull();
  });

  it("offers Set the books while paused, but not while a restore's own setting of the books is pending", () => {
    expect(view({ wallet: PAUSED })).toMatchObject({ paused: pausedText('books 120000 msat over'), setBooks: true, restore: null });
    const from = 'phrase';
    expect(view({ wallet: { ...PAUSED, restore: { state: 'pending', from } } })).toMatchObject({ setBooks: false, restore: { line: 'Waiting for the channel to come back' } });
    expect(view({ wallet: { ...PAUSED, restore: { state: 'no_channel', from } } })).toMatchObject({ setBooks: false, restore: { red: true, setBooks: true } });
    expect(view({ wallet: { ...PAUSED, restore: { state: 'done', from, reconciledMsat: 0, reconciledAt: 1 } } })).toMatchObject({ setBooks: true });
    expect(view({ wallet: null })).toMatchObject({ paused: '', setBooks: false, restore: null });
  });

  it('offers Update server for a newer cardd in the app, not while it runs nor on a host-key mismatch', () => {
    const newer = { kind: 'ok', version: '0.6.0', updateAvailable: true } as const;
    expect(view({ status: newer })!.offerUpdate).toBe(true);
    expect(view({ status: newer, update: { done: [], upload: null, startedAt: NOW, running: true } })!.offerUpdate).toBe(false);
    expect(view({ status: newer, state: saved({ hostKeyMismatch: 'ssh-ed25519 AAAAother' }) })!.offerUpdate).toBe(false);
    expect(view({ status: { kind: 'unreachable', message: 'no answer' } })!.offerUpdate).toBe(false);
  });

  it('is busy over SSH while Update server or Retire VM works, and updating only while the update runs', () => {
    const running = { done: [], upload: null, startedAt: NOW - 5_000, running: true };
    expect(view({ update: running })).toMatchObject({ updating: { startedAt: NOW - 5_000 }, sshBusy: true });
    expect(view({ retire: { running: true } })).toMatchObject({ updating: null, sshBusy: true });
    expect(view({ update: { ...running, running: false, endedAt: NOW } })).toMatchObject({ updating: null, sshBusy: false });
  });

  it("turns the money buttons off while cardd can't be reached, unless Update server is restarting it", () => {
    expect(view({ unreachable: true })!.moneyOff).toBe(true);
    expect(view({ unreachable: true, update: { done: [], upload: null, startedAt: NOW, running: true } })!.moneyOff).toBe(false);
  });
});
