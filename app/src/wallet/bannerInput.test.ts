import { describe, expect, it } from 'vitest';
import type { HostingStatus, Wallet } from '../cardd/client';
import { NO_BACKUPS } from '../backup/panel';
import type { Vm } from '../lnvps/client';
import { hostingWarnings } from '../money/hosting';
import type { OnboardingState, ServerHost } from '../onboarding/machine';
import { bannerInput, type BannerSnap } from './bannerInput';
import { walletBanners } from './banners';
import { serverView } from './serverView';
import type { Row } from './stack';

const NOW = 1_790_000_000_000;
const DAY_S = 86400;
const HOST = 'vm-1001.lnvps.cloud';
const host: ServerHost = { ipv4: '45.67.89.10', hostname: HOST, user: 'root', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3Nza' }, keySource: 'lnvps' };
const saved = (o: Partial<OnboardingState> = {}): OnboardingState => ({ step: 'done', payDays: 30, installed: [], vmId: 1001, host, ...o });
const vm = (o: Partial<Vm> = {}): Vm => ({
  id: 1001, created: '2026-09-01T00:00:00Z', expires: '2026-11-02T12:00:00Z', status: { state: 'running' },
  ip_assignments: [], host_ssh_keys: [], image: {}, ssh_key: { id: 1 }, ...o,
});
const account = { balanceMsat: 0, heldMsat: 0, address: `pool@${HOST}` };
const WALLET: Wallet = { cards: [], pool: account, hosting: account, paused: false, pausedReason: '', liquidity: null, restore: null };
const HOSTING: HostingStatus = {
  synced: true, expires: NOW / 1000 + 40 * DAY_S, syncedAt: NOW / 1000, daysLeft: 40, msatPerDay: 100_000, fundingDays: 90,
  vatOk: true, willRenew: true, problem: '', problemAt: 0,
};
const row = (id: string, o: Partial<Row> = {}): Row => ({ id, name: id, state: 'active', version: 1, host: HOST, created: 1, ...o });

// The snapshot the watch holds (only what the banners read) for a well server.
const WELL: BannerSnap & Parameters<typeof serverView>[0] = {
  state: saved(),
  status: { kind: 'ok', version: '0.7.0', updateAvailable: false },
  unreachable: false,
  wallet: WALLET,
  hosting: HOSTING,
  lnvpsExpires: NOW / 1000 + 40 * DAY_S,
  backups: { ...NO_BACKUPS, lines: ['Fetched today'] },
  cards: [row('a')],
  nfc: 'on',
  phoneCard: { supported: false, record: null, ids: [], own: null, removed: [] },
  lnvps: { vm: vm(), old: [], lnvpsNowMs: NOW, unreachableSince: null },
  update: null,
  retire: { running: false },
  keyCheckedAt: NOW,
};
const input = (o: Partial<typeof WELL> = {}) => {
  const snap = { ...WELL, ...o };
  return bannerInput(snap, serverView(snap, NOW)!, NOW);
};

// What the wallet's banners are made from, out of what the watch holds.
describe('bannerInput', () => {
  it('reads nothing that needs the person from a well server', () => {
    expect(input()).toEqual({
      keyNotice: { kind: 'ok', text: "LNVPS has confirmed this server's SSH key." },
      status: WELL.status,
      unreachable: false,
      updating: null,
      nowMs: NOW,
      revoked: false,
      pausedReason: null,
      hosting: { funding: null, fundingTone: 'amber', vat: null, banner: null },
      oldVm: null,
      backupWarnings: [],
      restoreRed: null,
      rebuild: null,
      repoint: 0,
      check: 0,
      nfc: 'on',
    });
    expect(walletBanners(input())).toEqual([]);
  });

  it("takes the view's host-key notice, the update's start, the old server and the rebuild suggestion", () => {
    const running = { done: [], upload: null, startedAt: NOW - 65_000, running: true };
    expect(input({ update: running, unreachable: true })).toMatchObject({ updating: { startedAt: NOW - 65_000 }, unreachable: true });
    const state = saved({ rebuild: { source: 'server_page', oldVm: { id: 1012 } } });
    expect(input({ state, lnvps: { ...WELL.lnvps!, old: [vm({ id: 1012 })] } }).oldVm).toMatchObject({ vmId: 1012 });
    expect(input({ lnvps: { ...WELL.lnvps!, vm: null } }).rebuild).toMatchObject({ gone: true });
    expect(input({ state: saved({ hostKeyMismatch: 'ssh-ed25519 AAAAother' }) }).keyNotice.kind).toBe('mismatch');
  });

  it("is paused for the wallet's pause, with its reason, even an empty one", () => {
    expect(input({ wallet: { ...WALLET, paused: true, pausedReason: 'books 120000 msat over' } }).pausedReason).toBe('books 120000 msat over');
    expect(input({ wallet: { ...WALLET, paused: true, pausedReason: '' } }).pausedReason).toBe('');
    expect(input({ wallet: null }).pausedReason).toBeNull();
  });

  it("warns of hosting from cardd's status and LNVPS's expiry, judged now", () => {
    // Kept at 7 days, as the daily renewal keeps it: Hosting's 12 days are the runway.
    const short = { ...HOSTING, expires: NOW / 1000 + 7 * DAY_S, fundingDays: 12, vatOk: false };
    expect(input({ hosting: short })).toMatchObject({ hosting: hostingWarnings(short, WELL.lnvpsExpires, NOW / 1000) });
    expect(input({ hosting: short }).hosting.funding).not.toBeNull();
    // cardd unreachable: LNVPS's own expiry still warns when the server is nearly out of time (under 3 days).
    const soon = NOW / 1000 + 2 * DAY_S;
    expect(input({ hosting: null, lnvpsExpires: soon }).hosting).toEqual(hostingWarnings(null, soon, NOW / 1000));
    expect(input({ hosting: null, lnvpsExpires: soon }).hosting.banner).not.toBeNull();
    // Judged at nowMs, not the phone's clock (NOW is in the past): 10 days left then is no warning.
    expect(input({ hosting: null, lnvpsExpires: NOW / 1000 + 10 * DAY_S }).hosting.banner).toBeNull();
  });

  it('takes the revoke and the warnings from the backups check, none before it answers', () => {
    const warned = { ...NO_BACKUPS, warnings: ["The phone hasn't fetched a backup for 3 days."], revoked: true };
    expect(input({ backups: warned })).toMatchObject({ revoked: true, backupWarnings: warned.warnings });
    expect(input({ backups: null })).toMatchObject({ revoked: false, backupWarnings: [] });
  });

  it("takes a restore's line only when it is red", () => {
    const restored = (restore: Wallet['restore']) => input({ wallet: { ...WALLET, restore } }).restoreRed;
    expect(restored({ state: 'no_channel', from: 'phrase' })).toMatch(/^No channel came back from the Lightning provider \(ACINQ\)/);
    expect(restored({ state: 'done', from: 'phrase', reconciledMsat: -4_000_000, reconciledAt: 1 })).toBe(
      'The server holds less than the backup said: 4,000 sat short',
    );
    expect(restored({ state: 'done', from: 'phrase', reconciledMsat: 4_000_000, reconciledAt: 1 })).toBeNull();
    expect(restored({ state: 'pending', from: 'phrase' })).toBeNull();
  });

  it("counts the cards pointing at another server, not wiped ones nor the cache's, which know no server", () => {
    const cards = [
      row('a'),
      row('b', { host: 'vm-1012.lnvps.cloud' }),
      row('c', { host: '' }),
      row('d', { host: 'vm-1012.lnvps.cloud', state: 'reset' }),
      { id: 'e', name: 'Cached', state: 'active', version: 1 } as Row,
    ];
    expect(input({ cards }).repoint).toBe(2);
    expect(input({ cards: null }).repoint).toBe(0);
    // A phone's card is never one to re-point.
    expect(input({ cards, phoneCard: { supported: true, record: { n: 0, removing: false }, ids: ['b'], own: 'b', removed: [] } }).repoint).toBe(1);
  });

  // A restore leaves each card needing its owner's check before it can pay. A card to re-point is counted there
  // alone, as its re-point checks it; a phone's card is checked by the wallet itself (phoneCard/keep.ts).
  it('counts the cards a restore left needing a check, but not those to re-point, wiped ones or phones\' cards', () => {
    const cards = [
      row('a', { needsCheck: true }),
      row('b', { needsCheck: true, host: 'vm-1012.lnvps.cloud' }),
      row('c', { needsCheck: true, state: 'frozen' }),
      row('d', { needsCheck: true, state: 'reset' }),
      row('e'),
      row('f', { needsCheck: true }),
    ];
    expect(input({ cards })).toMatchObject({ check: 3, repoint: 1 });
    expect(input({ cards, phoneCard: { supported: true, record: { n: 0, removing: false }, ids: ['f'], own: 'f', removed: [] } }).check).toBe(2);
    expect(input({ cards: null }).check).toBe(0);
  });

  it("takes the server's status, the NFC state and the time as they are", () => {
    const status = { kind: 'not_paired', message: "This phone isn't paired with the server." } as const;
    expect(input({ status, nfc: 'off' })).toMatchObject({ status, nfc: 'off', nowMs: NOW });
    expect(input({ status: null, nfc: null })).toMatchObject({ status: null, nfc: null });
  });
});
