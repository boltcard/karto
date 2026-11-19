import { describe, expect, it } from 'vitest';
import { moneyOff, walletBanners, type Banner, type BannerInput } from './banners';

const NOW = 1_790_000_000_000;
const WELL: BannerInput = {
  keyNotice: { kind: 'ok', text: "LNVPS has confirmed this server's SSH key." },
  status: { kind: 'ok', version: 'v0.7.0', updateAvailable: false },
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
};
const banners = (o: Partial<BannerInput>) => walletBanners({ ...WELL, ...o });

const PAID = { text: 'Your server is paid only until 12 Oct', tone: 'red' as const, forFunding: false };
const FUNDING = 'Hosting covers about 12 days: top it up or move from Pool';
const VAT = 'Automatic renewal is stopped: LNVPS now charges you VAT. Renew by hand (you will pay the VAT), or check your LNVPS account.';
const BACKUP = "The phone hasn't fetched a backup for 3 days.";
const RESTORE = 'The server holds less than the backup said: 4,000 sat short';
const GONE = 'LNVPS no longer lists VM 1001: your server is gone. Rebuild it from a backup.';
const QUIET = "Your server hasn't answered for over an hour, though LNVPS does. If it doesn't come back, rebuild it from a backup.";
const server = { kind: 'page', to: '/server' } as const;

// Each row's text, colour and where it opens.
describe('walletBanners', () => {
  const rows: [string, Partial<BannerInput>, Banner][] = [
    [
      'a host-key mismatch',
      { keyNotice: { kind: 'mismatch', text: "The server's SSH key is not the one LNVPS published (…)." } },
      { key: 'mismatch', tone: 'red', text: "Stop using this server: its SSH key isn't the one LNVPS published", target: server },
    ],
    [
      'cardd unreachable, checking again on a tap',
      { unreachable: true },
      { key: 'unreachable', tone: 'red', text: "Can't reach your server. Tap to check again.", target: server, checkAgain: true },
    ],
    [
      'this phone not paired',
      { status: { kind: 'not_paired', message: "The server does not accept this phone's key: unknown device" } },
      { key: 'not-paired', tone: 'red', text: "This phone isn't paired with your server", target: { kind: 'page', to: '/settings' } },
    ],
    [
      'this phone unpaired by a restore',
      { revoked: true },
      { key: 'revoked', tone: 'red', text: 'Another phone restored this server, so this phone is unpaired', target: { kind: 'page', to: '/backups' } },
    ],
    [
      'payments paused',
      { pausedReason: 'books 120000 msat over' },
      { key: 'paused', tone: 'red', text: "Payments are paused: the books don't add up", target: server },
    ],
    [
      'the server paid only until soon',
      { hosting: { funding: null, fundingTone: 'amber', vat: null, banner: PAID } },
      { key: 'hosting-paid', tone: 'red', text: PAID.text, target: { kind: 'pay-lnvps' } },
    ],
    [
      'hosting running low, with under 3 days left in all',
      { hosting: { funding: FUNDING, fundingTone: 'red', vat: null, banner: null } },
      { key: 'hosting-funding', tone: 'red', text: FUNDING, target: { kind: 'hosting' } },
    ],
    [
      'hosting running low, with time in hand',
      { hosting: { funding: FUNDING, fundingTone: 'amber', vat: null, banner: null } },
      { key: 'hosting-funding', tone: 'amber', text: FUNDING, target: { kind: 'hosting' } },
    ],
    [
      'VAT stopping renewal',
      { hosting: { funding: null, fundingTone: 'amber', vat: VAT, banner: null } },
      { key: 'hosting-vat', tone: 'red', text: VAT, target: { kind: 'hosting' } },
    ],
    [
      'the old server running',
      { oldVm: { vmId: 1012, text: 'LNVPS reports the old server (VM 1012) running, …' } },
      { key: 'old-vm', tone: 'red', text: 'The old server (VM 1012) is running and was never retired', target: server },
    ],
    [
      'the SSH key still unconfirmed',
      { keyNotice: { kind: 'overdue', text: "LNVPS still hasn't confirmed this server's SSH key after 2 hours; …" } },
      { key: 'key-overdue', tone: 'red', text: "LNVPS still hasn't confirmed this server's SSH key", target: server },
    ],
    [
      'a backup warning',
      { backupWarnings: [BACKUP] },
      { key: 'backup-0', tone: 'red', text: BACKUP, target: { kind: 'page', to: '/backups' } },
    ],
    ["a restore's red line", { restoreRed: RESTORE }, { key: 'restore', tone: 'red', text: RESTORE, target: server }],
    [
      'a rebuild, red with the VM gone',
      { rebuild: { text: GONE, gone: true } },
      { key: 'rebuild', tone: 'red', text: GONE, target: { kind: 'page', to: '/settings' } },
    ],
    [
      'a rebuild, amber with cardd quiet for an hour',
      { rebuild: { text: QUIET, gone: false } },
      { key: 'rebuild', tone: 'amber', text: QUIET, target: { kind: 'page', to: '/settings' } },
    ],
    ['a card to re-point', { repoint: 1 }, { key: 'repoint', tone: 'amber', text: '1 card to re-point: hold it to the phone', target: null }],
    [
      'a card to check after a restore',
      { check: 1 },
      { key: 'check', tone: 'amber', text: "1 card can't pay until you hold it to the phone", target: null },
    ],
    [
      'NFC off',
      { nfc: 'off' },
      { key: 'nfc-off', tone: 'amber', text: "NFC is off: cards can't be added or checked", target: { kind: 'nfc-settings' } },
    ],
    [
      'a newer server in the app',
      { status: { kind: 'ok', version: 'v0.7.0', updateAvailable: true } },
      { key: 'update', tone: 'amber', text: 'This app carries a newer version of the server', target: server },
    ],
    [
      "the server's name with no IPv4 address",
      { status: { kind: 'ok', version: 'v0.7.0', updateAvailable: false, dns: { ipv4: 'missing' } } },
      { key: 'dns', tone: 'amber', text: "Your server can't be reached on some networks", target: server },
    ],
    [
      "the server's name pointing elsewhere",
      { status: { kind: 'ok', version: 'v0.7.0', updateAvailable: false, dns: { ipv4: 'other', got: ['1.2.3.4'] } } },
      { key: 'dns', tone: 'amber', text: "Your server can't be reached on some networks", target: server },
    ],
    [
      'Update server running',
      { updating: { startedAt: NOW - 65_000 } },
      { key: 'updating', tone: 'amber', text: 'Updating the server · 1:05', target: server },
    ],
  ];
  for (const [what, input, banner] of rows) it(`shows ${what}`, () => expect(banners(input)).toEqual([banner]));

  it("puts the name's banner with the ambers, before the update's, and none for a name that is right", () => {
    const status = { kind: 'ok', version: 'v0.7.0', updateAvailable: true, dns: { ipv4: 'missing' } } as const;
    expect(banners({ status, nfc: 'off' }).map((b) => b.key)).toEqual(['nfc-off', 'dns', 'update']);
    expect(banners({ status: { ...status, updateAvailable: false, dns: { ipv4: 'ok' } } })).toEqual([]);
  });

  it('shows nothing when all is well', () => {
    expect(walletBanners(WELL)).toEqual([]);
    expect(banners({ nfc: 'unsupported', status: null, keyNotice: { kind: 'pending', text: "LNVPS hasn't confirmed this server's SSH key yet." } })).toEqual([]);
  });

  // Amber with 3 days or more left (money/hosting.ts): it then stands with the ambers, first among them.
  it('shows the paid-until banner in its own tone, among the ambers when amber', () => {
    const soon = { text: 'Your server is paid only until 17 Oct', tone: 'amber' as const, forFunding: false };
    const all = banners({ hosting: { funding: FUNDING, fundingTone: 'amber', vat: VAT, banner: soon }, rebuild: { text: QUIET, gone: false }, nfc: 'off' });
    expect(all.map((b) => [b.key, b.tone])).toEqual([['hosting-vat', 'red'], ['hosting-paid', 'amber'], ['hosting-funding', 'amber'], ['rebuild', 'amber'], ['nfc-off', 'amber']]);
    expect(all[1]).toEqual({ key: 'hosting-paid', tone: 'amber', text: soon.text, target: { kind: 'pay-lnvps' } });
  });

  // A brand-new server: paid for 7 days with Hosting empty. One banner, which opens Hosting, where Top up is.
  it('shows one banner when the paid-until banner speaks for the funding line too', () => {
    const one = { text: 'Your server is paid until 18 Oct. Top up Hosting and it renews itself.', tone: 'amber' as const, forFunding: true };
    expect(banners({ hosting: { funding: 'Hosting covers about 0 days: top it up or move from Pool', fundingTone: 'amber', vat: null, banner: one } })).toEqual([
      { key: 'hosting-paid', tone: 'amber', text: one.text, target: { kind: 'hosting' } },
    ]);
    const close = { ...one, tone: 'red' as const, text: 'Your server is paid only until 13 Oct. Top up Hosting, or pay LNVPS from any wallet.' };
    expect(banners({ hosting: { funding: FUNDING, fundingTone: 'red', vat: null, banner: close } })).toEqual([
      { key: 'hosting-paid', tone: 'red', text: close.text, target: { kind: 'hosting' } },
    ]);
  });

  it('puts red before amber, each in its place', () => {
    const all = banners({
      unreachable: true,
      status: { kind: 'not_paired', message: 'no key' },
      pausedReason: 'books over',
      hosting: { funding: FUNDING, fundingTone: 'red', vat: VAT, banner: PAID },
      oldVm: { vmId: 1012, text: '' },
      keyNotice: { kind: 'overdue', text: '' },
      backupWarnings: [BACKUP, 'The latest backup came from another server.'],
      restoreRed: RESTORE,
      rebuild: { text: QUIET, gone: false },
      repoint: 2,
      check: 1,
      nfc: 'off',
    });
    expect(all.map((b) => [b.key, b.tone])).toEqual([
      ['unreachable', 'red'],
      ['not-paired', 'red'],
      ['paused', 'red'],
      ['hosting-paid', 'red'],
      ['hosting-funding', 'red'],
      ['hosting-vat', 'red'],
      ['old-vm', 'red'],
      ['key-overdue', 'red'],
      ['backup-0', 'red'],
      ['backup-1', 'red'],
      ['restore', 'red'],
      ['rebuild', 'amber'],
      ['repoint', 'amber'],
      ['check', 'amber'],
      ['nfc-off', 'amber'],
    ]);
  });

  // As the server page showed only the warning: nothing else matters on a server that may not be the person's.
  it('shows the host-key mismatch alone', () => {
    const all = banners({
      keyNotice: { kind: 'mismatch', text: '' },
      unreachable: true,
      revoked: true,
      pausedReason: 'books over',
      rebuild: { text: GONE, gone: true },
      repoint: 3,
      nfc: 'off',
      updating: { startedAt: NOW },
    });
    expect(all.map((b) => b.key)).toEqual(['mismatch']);
  });

  // cardd restarts during Update server: the amber banner stands alone, with no offer of another update.
  it("doesn't call the server unreachable, or offer an update, while Update server runs", () => {
    const keys = banners({ unreachable: true, status: { kind: 'ok', version: 'v0.7.0', updateAvailable: true }, updating: { startedAt: NOW } }).map((b) => b.key);
    expect(keys).toEqual(['updating']);
  });

  it('says only that another phone unpaired this one, not that it is unpaired', () => {
    const keys = banners({ revoked: true, status: { kind: 'not_paired', message: 'unknown device' } }).map((b) => b.key);
    expect(keys).toEqual(['revoked']);
  });

  it('says a newer release is on GitHub, last and amber, opening the releases', () => {
    expect(banners({ appUpdate: '1.0.1' })).toEqual([
      { key: 'app-update', tone: 'amber', text: 'Karto Wallet 1.0.1 is out on GitHub', target: { kind: 'github-releases' } },
    ]);
    expect(banners({ appUpdate: '1.0.1', nfc: 'off' }).map((b) => b.key)).toEqual(['nfc-off', 'app-update']);
    expect(banners({ appUpdate: null })).toEqual([]);
  });

  it('counts the cards to re-point', () => {
    expect(banners({ repoint: 3 })[0].text).toBe('3 cards to re-point: hold each to the phone');
  });

  it('counts the cards to check after a restore', () => {
    expect(banners({ check: 3 })[0].text).toBe("3 cards can't pay until you hold each to the phone");
  });
});

// The provider's flag turns off the money buttons.
describe('moneyOff', () => {
  it('turns the money buttons off while cardd is unreachable, unless Update server is running', () => {
    expect(moneyOff({ unreachable: true, updating: null })).toBe(true);
    expect(moneyOff({ unreachable: true, updating: { startedAt: NOW } })).toBe(false);
    expect(moneyOff({ unreachable: false, updating: null })).toBe(false);
  });
});
