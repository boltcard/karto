// The wallet's banners: anything that needs the
// person, red before amber, each opening where it is dealt with. The server
// page's helpers make what they say; Settings and its pages keep the full text.
import type { ServerStatus } from '../cardd/status';
import type { HostingWarnings } from '../money/hosting';
import type { NfcState } from '../native/nfc';
import { elapsed } from '../onboarding/progress';

export type Tone = 'red' | 'amber';
/** Where a banner opens: a page of Settings (or Settings itself), Pay LNVPS from any wallet, hosting's page, Android's NFC setting, or the releases on GitHub. */
export type BannerTarget =
  | { kind: 'page'; to: '/server' | '/backups' | '/settings' }
  | { kind: 'pay-lnvps' }
  | { kind: 'hosting' }
  | { kind: 'nfc-settings' }
  | { kind: 'github-releases' }
  | null;
/** checkAgain: tapping it also checks the server again at once, as Check again did. */
export type Banner = { key: string; tone: Tone; text: string; target: BannerTarget; checkAgain?: true };

export type BannerInput = {
  keyNotice: { kind: 'ok' | 'pending' | 'overdue' | 'mismatch'; text: string };
  status: ServerStatus | null;
  /** The last status check or 5-second refresh failed to reach cardd. */
  unreachable: boolean;
  /** Update server is running, since startedAt (ms). */
  updating: { startedAt: number } | null;
  nowMs: number;
  /** Another phone's restore unpaired this one. */
  revoked: boolean;
  /** wallet.paused ? wallet.pausedReason : null */
  pausedReason: string | null;
  hosting: HostingWarnings;
  oldVm: { vmId: number; text: string } | null;
  backupWarnings: string[];
  /** restoreView(...)?.red ? its line : null */
  restoreRed: string | null;
  rebuild: { text: string; gone: boolean } | null;
  /** How many cards point at another server. */
  repoint: number;
  /** How many cards a restore left needing a check before they can pay, not counting those to re-point. */
  check: number;
  nfc: NfcState | null;
  /** A newer release on GitHub, for an APK from there (appUpdate/useAppUpdate.ts); null or absent otherwise. */
  appUpdate?: string | null;
};

// The Server and Backups pages; This phone and Rebuild server are rows of Settings itself.
const page = (to: '/server' | '/backups' | '/settings'): BannerTarget => ({ kind: 'page', to });
const SERVER = page('/server');
const BACKUPS = page('/backups');
const SETTINGS = page('/settings');
const red = (key: string, text: string, target: BannerTarget): Banner => ({ key, tone: 'red', text, target });
const amber = (key: string, text: string, target: BannerTarget): Banner => ({ key, tone: 'amber', text, target });

export function walletBanners(i: BannerInput): Banner[] {
  // A server that may not be the person's: nothing else on it matters.
  if (i.keyNotice.kind === 'mismatch') return [red('mismatch', "Stop using this server: its SSH key isn't the one LNVPS published", SERVER)];
  const b: Banner[] = [];
  // cardd restarts while Update server runs: its failures then aren't the server being down.
  if (i.unreachable && !i.updating) b.push({ ...red('unreachable', "Can't reach your server. Tap to check again.", SERVER), checkAgain: true });
  if (i.status?.kind === 'not_paired' && !i.revoked) b.push(red('not-paired', "This phone isn't paired with your server", SETTINGS));
  if (i.revoked) b.push(red('revoked', 'Another phone restored this server, so this phone is unpaired', BACKUPS));
  if (i.pausedReason !== null) b.push(red('paused', "Payments are paused: the books don't add up", SERVER));
  // The paid-until banner: amber with 3 days or more left, red under (money/hosting.ts). When it speaks for the
  // funding line too (a new server: paid for 7 days, Hosting empty) it is the one banner, and opens Hosting, where
  // Top up, Pay LNVPS and Renew now are.
  const paid = i.hosting.banner;
  const paidBanner: Banner | null = paid && { key: 'hosting-paid', tone: paid.tone, text: paid.text, target: paid.forFunding ? { kind: 'hosting' } : { kind: 'pay-lnvps' } };
  if (paidBanner?.tone === 'red') b.push(paidBanner);
  // The funding line alone, in its own colour: amber under 14 days of funding, red under 7.
  const funding: Banner | null =
    i.hosting.funding && !paid?.forFunding ? { key: 'hosting-funding', tone: i.hosting.fundingTone, text: i.hosting.funding, target: { kind: 'hosting' } } : null;
  if (funding?.tone === 'red') b.push(funding);
  if (i.hosting.vat) b.push(red('hosting-vat', i.hosting.vat, { kind: 'hosting' }));
  if (i.oldVm) b.push(red('old-vm', `The old server (VM ${i.oldVm.vmId}) is running and was never retired`, SERVER));
  if (i.keyNotice.kind === 'overdue') b.push(red('key-overdue', "LNVPS still hasn't confirmed this server's SSH key", SERVER));
  i.backupWarnings.forEach((w, n) => b.push(red(`backup-${n}`, w, BACKUPS)));
  if (i.restoreRed) b.push(red('restore', i.restoreRed, SERVER));
  if (i.rebuild?.gone) b.push(red('rebuild', i.rebuild.text, SETTINGS));
  if (paidBanner?.tone === 'amber') b.push(paidBanner);
  if (funding?.tone === 'amber') b.push(funding);
  if (i.rebuild && !i.rebuild.gone) b.push(amber('rebuild', i.rebuild.text, SETTINGS));
  if (i.repoint > 0) {
    b.push(amber('repoint', i.repoint === 1 ? '1 card to re-point: hold it to the phone' : `${i.repoint} cards to re-point: hold each to the phone`, null));
  }
  if (i.check > 0) {
    b.push(amber('check', i.check === 1 ? "1 card can't pay until you hold it to the phone" : `${i.check} cards can't pay until you hold each to the phone`, null));
  }
  if (i.nfc === 'off') b.push(amber('nfc-off', "NFC is off: cards can't be added or checked", { kind: 'nfc-settings' }));
  // The server's name with no IPv4 address, or one that isn't the server's: the Server page says who can fix it.
  const dns = i.status?.kind === 'ok' ? i.status.dns?.ipv4 : undefined;
  if (dns === 'missing' || dns === 'other') b.push(amber('dns', "Your server can't be reached on some networks", SERVER));
  if (i.status?.kind === 'ok' && i.status.updateAvailable && !i.updating) b.push(amber('update', 'This app carries a newer version of the server', SERVER));
  if (i.updating) b.push(amber('updating', `Updating the server · ${elapsed(i.updating.startedAt, i.nowMs)}`, SERVER));
  if (i.appUpdate) b.push(amber('app-update', `Karto Wallet ${i.appUpdate} is out on GitHub`, { kind: 'github-releases' }));
  return b;
}

/** The money buttons are off: cardd unreachable and no Update server running. */
export const moneyOff = (i: { unreachable: boolean; updating: { startedAt: number } | null }): boolean => i.unreachable && !i.updating;
