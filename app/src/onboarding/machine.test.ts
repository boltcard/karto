import { describe, expect, it } from 'vitest';
import {
  advance, verifyHostKey, DEFAULT_PAY_DAYS, HOST_KEY_WAIT_MS, initialState, INVOICE_RENEW_BEFORE_MS, MAX_PAY_DAYS, NEWER_BACKUP, OLD_VM_SSH_WAIT_MS, PAY_DAY_PRESETS, reconcileDevice,
  FINAL_NOT_FETCHED, oldVmsToWatch, overrideFor, overrideOffered, overridePrompt, RECOVERY_CHECK_WAIT_MS, RETIRE_TRIES_BEFORE_OVERRIDE, retireOldServer, serverHostname, sshKeyName, startRebuild, withPayDays, PAY_DAYS_SETTLE_MS, INVOICE_BUSY_WAIT_MS, paySat,
  type ChosenBackup, type OnboardingState, type Rebuild, type RetireRecord, type ServerHost, type Waiting,
} from './machine';
import { statusLine } from './progress';
import { INSTALL_STEPS } from './install';
import { notNewest, olderNotice, timeText, withBackup } from './rebuild';
import { ageEncrypt } from '../backup/age';
import { SnapshotUnreadable } from '../backup/summary';
import { MAX_SNAPSHOT_BYTES, snapshotName, type Kept, type SnapshotSummary } from '../backup/backups';
import { bundleSha } from '../deploy/bundle';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import type { FetchFn } from '../lightning/lightning';
import { LnvpsClient, LnvpsError, type Vm } from '../lnvps/client';
import { HOST_KEY, sealSummary, world, type OtherServer } from '../testing/world';
import { fakeInvoice } from '../testing/fakeLnvps';
import { vectors } from '../testing/vectors';

type World = ReturnType<typeof world>;

/** A verification link as LNVPS builds it (LNVPS/api, routes.rs). */
const LINK = (token: string) => `https://api.lnvps.net/api/v1/account/verify-email?token=${token}`;

/** Advances until done, an error, or `stopAt`; when waiting, lets the world move on. */
async function drive(s: OnboardingState, t: World, stopAt?: (s: OnboardingState) => boolean): Promise<OnboardingState> {
  for (let i = 0; i < 50; i++) {
    if (s.step === 'done' || s.error || stopAt?.(s)) return s;
    s = await advance(s, t.deps);
    if (s.waiting) s = react(s.waiting, s, t);
  }
  throw new Error(`stuck at ${s.step} (${s.waiting})`);
}

function react(waiting: Waiting, s: OnboardingState, t: World): OnboardingState {
  if (waiting === 'payment') t.lnvps.pay(s.vmId!);
  if (waiting === 'boot') t.lnvps.boot(s.vmId!);
  if (waiting === 'host_keys') t.lnvps.publishHostKeys(s.vmId!, [{ key_type: 'ssh-rsa', public_key: 'AAAAB3', fingerprint_sha256: 'SHA256:x' }, HOST_KEY]);
  // The person picks the first server offered (the one paid furthest ahead).
  if (waiting === 'choose_vm') return { ...s, chosenVmId: s.vmChoices![0].id };
  return s;
}

/**
 * The install's start was noted while it ran (a checkpoint has it), and the state that left the step carries none,
 * nor its steps' times.
 */
function sinceDropped(s: OnboardingState, t: World) {
  expect(t.checkpoints.some((x) => x.step === 'install' && x.installSince !== undefined)).toBe(true);
  expect(s.step).not.toBe('install');
  expect([s.installSince, s.stepMs, s.stepStartedAt]).toEqual([undefined, undefined, undefined]);
}

describe('onboarding', () => {
  it('goes from a country to a paired, healthy server', async () => {
    const t = world();
    const s = await drive(initialState('GBR'), t);
    expect(s.error).toBeUndefined();
    expect(s.step).toBe('done');
    // Email: the phrase-derived inbox, verified.
    expect(t.lnvps.account.email).toBe(`${t.keys.mailtmName}@uberip.com`);
    expect(t.lnvps.account.email_verified).toBe(true);
    // One VM, one key named for this phrase.
    expect(t.lnvps.vms.size).toBe(1);
    expect(t.lnvps.sshKeys.map((k) => [k.name, k.key_data])).toEqual([[sshKeyName(t.keys), t.keys.sshAuthorizedKey]]);
    // The default 7 days at 6,863 sat per 31 days, through the VM's Lightning address (LNURL),
    // never LNVPS's own whole-period invoice.
    expect(t.lnvps.invoices.map((i) => i.msat)).toEqual([1_550_000n]);
    expect(t.lnvps.http.requests.some((r) => /\/renew\?/.test(r.url))).toBe(false);
    // SSH only to the published ed25519 key, never the RSA one.
    expect(t.ssh.connects.every((c) => c.hostKey.publicKey === HOST_KEY.public_key && c.host === '45.67.89.164' && c.user === 'debian')).toBe(true);
    expect(t.ssh.connects[0].ed25519Seed).toBe(t.keys.sshEd25519Seed);
    // Installed, with the meta the backups need, and paired.
    expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(t.ssh.commands.some((c) => c.command === `sh card-app/install.sh prepare 'vm-1001.lnvps.cloud'`)).toBe(true);
    expect(t.ssh.commands.some((c) => c.command === `sh card-app/cardd-ctl meta set 'mailtm.address' '${t.keys.mailtmName}@uberip.com'`)).toBe(true);
    expect(t.ssh.commands.some((c) => c.command === `sh card-app/cardd-ctl meta set 'account.pubkey' '${vectors.phrase.nostrPublicKey}'`)).toBe(true);
    expect(s.deviceKeyId).toBe(vectors.deviceAuth.keyId);
    // The backup public key, so cardd can encrypt snapshots to this phrase.
    expect(t.ssh.commands.some((c) => c.command === `sh card-app/cardd-ctl meta set 'backup.recipient' '${vectors.phrase.backupAgeRecipient}'`)).toBe(true);
    expect(t.cardd.meta.get('backup.recipient')).toBe(vectors.phrase.backupAgeRecipient);
  });

  // Restore onto a new phone: once this phone is paired,
  // every other one loses access, as a step of its own that a cut resumes.
  it('revokes every other phone once this one is paired, finishing after a cut', async () => {
    const t = world();
    t.cardd.devices.set('aaaaaaaaaaaaaaaa', '04' + 'aa'.repeat(64)); // the lost phone
    t.ssh.when(/device revoke-others/, { code: 255, stderr: 'connection reset' }, 1);
    let s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'pair', deviceKeyId: vectors.deviceAuth.keyId, error: { kind: 'retry' } });
    expect(s.othersRevoked).toBeFalsy();
    expect(t.cardd.revoked.has('aaaaaaaaaaaaaaaa')).toBe(false);
    s = await drive({ ...s, error: undefined }, t);
    expect(s).toMatchObject({ step: 'done', othersRevoked: true });
    expect(t.cardd.revoked.has('aaaaaaaaaaaaaaaa')).toBe(true);
    expect(t.cardd.revoked.has(vectors.deviceAuth.keyId)).toBe(false);
    expect(t.ssh.ran(/device add/)).toBe(1);
    expect(t.ssh.commands.some((c) => c.command === `sh card-app/cardd-ctl device revoke-others -keep '${vectors.deviceAuth.keyId}'`)).toBe(true);
  });

  it('stops for good when LNVPS would charge VAT', async () => {
    const t = world();
    const s = await advance(initialState('IRL'), t.deps);
    expect(s.step).toBe('country');
    expect(s.error).toEqual({ kind: 'fatal', message: 'LNVPS would charge 23% VAT (domestic, IRL)' });
  });

  it('stops when LNVPS does not know the country', async () => {
    const t = world();
    const s = await advance(initialState('XYZ'), t.deps);
    expect(s.error?.kind).toBe('fatal');
    expect(s.error?.message).toContain('XYZ');
    expect((await advance(initialState(), t.deps)).error?.message).toBe('Choose a country first');
  });

  it('waits for the verification email, then carries on', async () => {
    const t = world();
    let pending: (() => void) | undefined;
    t.lnvps.onVerificationEmail = (address, link) => (pending = () => t.mail.deliver(address, 'Verify', link));
    let s = await advance(initialState('GBR'), t.deps);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    pending!();
    s = await advance(s, t.deps);
    expect(s.step).toBe('order');
    expect(t.lnvps.account.email_verified).toBe(true);
  });

  // A look-alike sent to the inbox first (a token LNVPS refuses) can't block LNVPS's own link.
  it('tries every LNVPS link until the email is verified', async () => {
    const t = world();
    const mailed = t.lnvps.onVerificationEmail;
    t.lnvps.onVerificationEmail = (to, link) => {
      t.mail.deliver(to, 'Verify', `${LINK('bogus')}`); // first in the inbox
      mailed(to, link);
    };
    const s = await drive(initialState('GBR'), t, (x) => x.step === 'order');
    expect(t.lnvps.account.email_verified).toBe(true);
    expect(s.error).toBeUndefined();
    expect(t.lnvps.verifyCalls).toEqual(['bogus', 'tok1']); // the look-alike was tried, and passed over
  });

  // Look-alikes in the inbox must not spend LNVPS's 10 verify-email requests a minute every 5-second pass.
  it('opens each link LNVPS refuses once, remembering it across passes', async () => {
    const t = world();
    t.lnvps.onVerificationEmail = (to) => t.mail.deliver(to, 'Verify', LINK('bogus')); // LNVPS's own email hasn't come yet
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && !!x.emailLinksRefused?.length);
    expect(s.emailLinksRefused).toEqual([LINK('bogus')]);
    s = await advance(s, t.deps);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    expect(t.lnvps.verifyCalls).toEqual(['bogus']); // once, not every pass
  });

  // The security review of f6e873a: refused look-alikes never fill a pass's five, and their messages are deleted,
  // so a flood can't keep LNVPS's email off mail.tm's first page.
  it('opens LNVPS\'s link within two passes behind six refused look-alikes, deleting their messages', async () => {
    const t = world();
    const mailed = t.lnvps.onVerificationEmail;
    t.lnvps.onVerificationEmail = (to, link) => {
      for (let i = 1; i <= 6; i++) t.mail.deliver(to, 'Verify', LINK(`bogus${i}`));
      mailed(to, link);
    };
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && !!x.emailLinksRefused?.length);
    expect(t.lnvps.verifyCalls).toEqual(['bogus1', 'bogus2', 'bogus3', 'bogus4', 'bogus5']);
    s = await advance(s, t.deps);
    expect(s.step).toBe('order');
    expect(t.lnvps.verifyCalls.slice(5)).toEqual(['bogus6', 'tok1']);
    expect(t.mail.accounts.get(s.mailtmAddress!)!.messages.map((m) => m.subject)).toEqual(['Verify', 'Verify your email']); // bogus6's, and LNVPS's
    expect(s.emailLinksRefused).toBeUndefined();
  });

  it('deletes a message whose links LNVPS all refused, going on if the delete fails', async () => {
    const t = world();
    t.lnvps.onVerificationEmail = (to) => t.mail.deliver(to, 'Verify', LINK('bogus')); // LNVPS's own email hasn't come yet
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && !!x.emailLinksRefused?.length);
    const inbox = () => t.mail.accounts.get(s.mailtmAddress!)!.messages;
    expect(inbox()).toHaveLength(1);
    t.mail.deleteFails = true;
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'email', waiting: 'email', emailLinksRefused: [LINK('bogus')] });
    expect(inbox()).toHaveLength(1);
    t.mail.deleteFails = false;
    s = await advance(s, t.deps);
    expect(inbox()).toHaveLength(0);
    expect(t.lnvps.verifyCalls).toEqual(['bogus']); // never opened again
  });

  // One message's hundreds of look-alikes take five at most, so it is deleted after five refusals.
  it('opens LNVPS\'s link within two passes behind one message of 120 look-alikes, deleting it', async () => {
    const t = world();
    const mailed = t.lnvps.onVerificationEmail;
    t.lnvps.onVerificationEmail = (to, link) => {
      const bogus = Array.from({ length: 120 }, (_, i) => LINK(`bogus${i}`));
      t.mail.deliver(to, 'Flood', '', Array.from({ length: 24 }, (_, p) => bogus.slice(p * 5, p * 5 + 5).join(' ')));
      mailed(to, link);
    };
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && !!x.emailLinksRefused?.length);
    s = await advance(s, t.deps);
    expect(s.step).toBe('order');
    expect(t.lnvps.verifyCalls).toEqual(['bogus0', 'bogus1', 'bogus2', 'bogus3', 'bogus4', 'tok1']);
    expect(t.mail.accounts.get(s.mailtmAddress!)!.messages.map((m) => m.subject)).toEqual(['Verify your email']);
  });

  // Five look-alikes that fail without being refused (a 5xx, or a 4xx such as 403)
  // would otherwise take every pass's five, and LNVPS's own link behind them would never be asked.
  it('passes over for 10 minutes the links a full pass found failing, so LNVPS\'s link behind them is asked', async () => {
    const t = world();
    const mailed = t.lnvps.onVerificationEmail;
    const bogus = ['b1', 'b2', 'b3', 'b4', 'b5'];
    t.lnvps.onVerificationEmail = (to, link) => {
      for (const b of bogus) t.mail.deliver(to, 'Verify', LINK(b));
      mailed(to, link);
    };
    bogus.forEach((b, i) => t.lnvps.verifyStatusFor.set(b, i % 2 ? 403 : 503));
    let s = await drive(initialState('GBR'), t, (x) => !!x.error);
    expect(s).toMatchObject({ step: 'email', error: { kind: 'retry', message: 'opening the verification link gave HTTP 503' } });
    expect(s.emailLinksRefused).toBeUndefined();
    expect(s.emailLinksOpened?.map((o) => o.link)).toEqual(bogus.map(LINK));
    s = await advance({ ...s, error: undefined }, t.deps); // Try again
    expect(s.step).toBe('order');
    expect(t.lnvps.verifyCalls).toEqual([...bogus, 'tok1']);
    expect(t.mail.accounts.get(s.mailtmAddress!)!.messages).toHaveLength(6); // none refused: none deleted
  });

  // LNVPS's limit counts the requests it rejects, so the app waits a minute after a 429.
  it('opens nothing for a minute after a 429', async () => {
    const t = world();
    t.lnvps.verifyStatus = 429;
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && t.lnvps.verifyCalls.length > 0);
    expect(s.emailBusyUntil).toBe(t.w.nowMs + 60_000);
    t.lnvps.verifyStatus = undefined;
    t.w.nowMs += 55_000;
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    expect(t.lnvps.verifyCalls).toEqual(['tok1']);
    t.w.nowMs += 5_000;
    s = await advance(s, t.deps);
    expect(s.step).toBe('order');
    expect(s.emailBusyUntil).toBeUndefined();
    expect(t.lnvps.verifyCalls).toEqual(['tok1', 'tok1']);
  });

  // A 429 after another failure in the same pass waits, polling on, rather than stopping on an error.
  it('waits after a 429 that follows a failure in the same pass, showing no error', async () => {
    const t = world();
    const mailed = t.lnvps.onVerificationEmail;
    t.lnvps.onVerificationEmail = (to, link) => {
      t.mail.deliver(to, 'Verify', LINK('bogus'));
      mailed(to, link);
    };
    t.lnvps.verifyStatusFor.set('bogus', 403).set('tok1', 429);
    const s = await drive(initialState('GBR'), t, (x) => !!x.error || (x.waiting === 'email' && t.lnvps.verifyCalls.length > 0));
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    expect(s.error).toBeUndefined();
    expect(t.lnvps.verifyCalls).toEqual(['bogus', 'tok1']);
  });

  // LNVPS's limit has tripped, so nothing more is asked this pass.
  it('ends the pass at a 429', async () => {
    const t = world();
    const mailed = t.lnvps.onVerificationEmail;
    t.lnvps.onVerificationEmail = (to, link) => {
      t.mail.deliver(to, 'Verify', LINK('bogus'));
      mailed(to, link);
    };
    t.lnvps.verifyStatus = 429;
    const s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && t.lnvps.verifyCalls.length > 0);
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    expect(t.lnvps.verifyCalls).toEqual(['bogus']);
  });

  // Only what LNVPS answers an unknown token (400, 404, 410) refuses a link for
  // good; a 403 (a firewall, say) on LNVPS's own link must not delete its email.
  it('shows any other 4xx as an error, refusing and deleting nothing', async () => {
    const t = world();
    t.lnvps.verifyStatus = 403;
    let s = await drive(initialState('GBR'), t, (x) => !!x.error || x.step === 'order');
    expect(s).toMatchObject({ step: 'email', error: { kind: 'retry', message: 'opening the verification link gave HTTP 403' } });
    expect(s.emailLinksRefused).toBeUndefined();
    t.lnvps.verifyStatus = undefined;
    s = await advance({ ...s, error: undefined }, t.deps);
    expect(s.step).toBe('order');
  });

  // A valid token for someone else's account answers 2xx and verifies nothing.
  it('passes over a link that opened without verifying this account for 10 minutes, keeping its message', async () => {
    const t = world();
    t.lnvps.foreignTokens.add('foreign');
    t.lnvps.onVerificationEmail = (to) => t.mail.deliver(to, 'Verify', LINK('foreign')); // LNVPS's own email hasn't come yet
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && !!x.emailLinksOpened?.length);
    expect(s.emailLinksOpened).toEqual([{ link: LINK('foreign'), at: t.w.nowMs }]);
    s = await advance(s, t.deps);
    s = await advance(s, t.deps);
    expect(t.lnvps.verifyCalls).toEqual(['foreign']);
    expect(t.mail.accounts.get(s.mailtmAddress!)!.messages).toHaveLength(1);
    t.w.nowMs += 10 * 60_000;
    s = await advance(s, t.deps);
    expect(t.lnvps.verifyCalls).toEqual(['foreign', 'foreign']); // getAccount may have lagged: tried again
  });

  it('leaves a link for the next pass when LNVPS is busy (429) or down (5xx)', async () => {
    const t = world();
    t.lnvps.verifyStatus = 429;
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'email' && t.lnvps.verifyCalls.length > 0);
    expect(s).toMatchObject({ step: 'email', waiting: 'email' });
    expect(s.emailLinksRefused).toBeUndefined();
    expect(t.mail.accounts.get(s.mailtmAddress!)!.messages).toHaveLength(1); // a 429 neither refuses nor deletes
    t.w.nowMs += 60_000; // the minute's wait after a 429
    t.lnvps.verifyStatus = 503;
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'email', error: { kind: 'retry', message: 'opening the verification link gave HTTP 503' } });
    expect(s.emailLinksRefused).toBeUndefined();
    t.lnvps.verifyStatus = undefined;
    s = await advance({ ...s, error: undefined }, t.deps);
    expect(s.step).toBe('order');
    expect(t.lnvps.verifyCalls).toEqual(['tok1', 'tok1', 'tok1']); // asked again at each pass
  });

  it('does not order a second VM if the app died before saving the order', async () => {
    const t = world();
    const atOrder = await drive(initialState('GBR'), t, (s) => s.step === 'order');
    const first = await advance(atOrder, t.deps); // ordered, but this state is "lost"
    const again = await advance(atOrder, t.deps);
    expect(t.lnvps.vms.size).toBe(1);
    expect(again.vmId).toBe(first.vmId);
    expect(t.lnvps.sshKeys).toHaveLength(1);
  });

  it('orders again if LNVPS deleted the unpaid order', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    t.lnvps.deleteVm(s.vmId!);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'order', vmId: undefined, invoice: undefined });
    s = await advance(s, t.deps);
    expect(s.step).toBe('pay');
    expect(s.vmId).toBe(1002);
  });

  // The invoice's own expiry (LNVPS sets it, here 10 minutes) decides, not a fixed guess.
  it('keeps an invoice until a minute before it expires, then makes a new one', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    s = await advance(s, t.deps);
    const first = s.invoice!;
    expect(first).toMatchObject({ sat: 1550, days: 7, bolt11: fakeInvoice(1_550_000n), expiresAt: t.w.nowMs + 600_000 });
    t.w.nowMs += 600_000 - INVOICE_RENEW_BEFORE_MS - 1_000;
    s = await advance(s, t.deps);
    expect(s.invoice).toEqual(first);
    t.w.nowMs += 2_000;
    s = await advance(s, t.deps);
    expect(s.invoice!.expiresAt).toBeGreaterThan(first.expiresAt);
  });

  // LNURL takes any amount (LNVPS's minimum is 100 sat), so the person picks the days.
  it('invoices the days the person picked, at the VM\'s price, at least 100 sat', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    s = await advance(withPayDays(s, 14), t.deps);
    expect(s.invoice).toMatchObject({ sat: 3100, days: 14, bolt11: fakeInvoice(3_100_000n) });
    s = await advance(withPayDays(s, 1), t.deps);
    expect(s.invoice).toMatchObject({ sat: 222, days: 1 });
    expect(t.lnvps.http.requests.some((r) => /\/renew\?/.test(r.url))).toBe(false);
  });

  // A press each asked LNVPS for an invoice, and stepping from 7 days to 1 met its limit (about five a minute).
  it('asks for one invoice once the day presses stop, at the price of a day asked for once', async () => {
    const t = world();
    let s = await advance(await drive(initialState('GBR'), t, (x) => x.step === 'pay'), t.deps);
    expect(s.invoice).toMatchObject({ days: 7 });
    const quotes = () => t.lnvps.http.requests.filter((r) => /\/renew\/quote$/.test(new URL(r.url).pathname)).length;
    const [invoices, asked] = [t.lnvps.invoices.length, quotes()];
    for (const days of [6, 5, 4, 3]) {
      s = withPayDays(s, days, t.w.nowMs);
      expect(s.invoice).toBeUndefined();
      s = await advance(s, t.deps);
      expect(s.waiting).toBe('pay_days');
      t.w.nowMs += PAY_DAYS_SETTLE_MS - 100;
    }
    expect([t.lnvps.invoices.length, quotes()]).toEqual([invoices, asked]);
    t.w.nowMs += 100;
    s = await advance(s, t.deps);
    expect(s.invoice).toMatchObject({ sat: paySat(3, 6_863 / 31), days: 3 });
    expect([t.lnvps.invoices.length, quotes()]).toEqual([invoices + 1, asked]);
    expect(s.payDaysAt).toBeUndefined();
  });

  it("waits a minute after LNVPS's 429 to an invoice, saying so, and asks for no quote or invoice meanwhile", async () => {
    const t = world();
    let s = await advance(await drive(initialState('GBR'), t, (x) => x.step === 'pay'), t.deps);
    expect(s.invoice).toMatchObject({ days: 7 });
    t.lnvps.invoiceStatus = 429;
    s = await advance(withPayDays(s, 3, t.w.nowMs - PAY_DAYS_SETTLE_MS), t.deps);
    expect(s).toMatchObject({ step: 'pay', waiting: 'lnvps_busy', invoiceBusyUntil: t.w.nowMs + INVOICE_BUSY_WAIT_MS });
    expect(s.error).toBeUndefined();
    expect(s.invoice).toBeUndefined();
    t.lnvps.invoiceStatus = undefined;
    // Only whether the VM was paid meanwhile is asked.
    const asked = () => t.lnvps.http.requests.filter((r) => /\/renew\/quote$|lnurlp/.test(new URL(r.url).pathname)).length;
    const before = asked();
    t.w.nowMs += INVOICE_BUSY_WAIT_MS - 1_000;
    s = await advance(s, t.deps);
    expect(s.waiting).toBe('lnvps_busy');
    expect(asked()).toBe(before);
    t.w.nowMs += 1_000;
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ waiting: 'payment', invoice: { days: 3 }, invoiceBusyUntil: undefined });
  });

  it("goes on to start the server when an earlier invoice is paid during a 429's minute", async () => {
    const t = world();
    let s = await advance(await drive(initialState('GBR'), t, (x) => x.step === 'pay'), t.deps);
    t.lnvps.invoiceStatus = 429;
    s = await advance(withPayDays(s, 3, t.w.nowMs - PAY_DAYS_SETTLE_MS), t.deps);
    expect(s.waiting).toBe('lnvps_busy');
    t.lnvps.pay(s.vmId!);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'boot', invoiceBusyUntil: undefined });
  });

  it('replaces an invoice saved without its expiry (by an older version of the app)', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    s = await advance(s, t.deps);
    const { expiresAt: _, ...old } = s.invoice!;
    s = await advance({ ...s, invoice: { ...old, bolt11: 'lnbc1old' } as never }, t.deps);
    expect(s.invoice).toMatchObject({ bolt11: fakeInvoice(1_550_000n), expiresAt: t.w.nowMs + 600_000 });
  });

  // LNVPS reads a new server's host key about an hour after it starts (one scan before sshd is
  // up, then hourly). Until then: trust the key the server presents, and verify it later.
  it('trusts the key the server presents when LNVPS has not published one yet', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.boot(s.vmId!);
    s = await advance(s, t.deps);
    expect(s.step).toBe('install');
    expect(s.host).toMatchObject({ hostKey: { keyType: 'ssh-ed25519', publicKey: HOST_KEY.public_key }, keySource: 'first_use' });
    expect(s.host!.trustedAt).toBe(t.w.nowMs); // when the 2 h for LNVPS to confirm it starts
    s = await drive(s, t);
    expect(s.step).toBe('done');
    expect(t.ssh.connects.every((c) => c.hostKey.publicKey === HOST_KEY.public_key)).toBe(true);
  });

  // An install retried after LNVPS has published its key checks the trusted one
  // against it before connecting, so the seed and issuer key never go to a contradicted server.
  describe('checks a first-use key against LNVPS before each connection', () => {
    async function firstUse(step: 'install' | 'pair') {
      const t = world();
      let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
      t.lnvps.boot(s.vmId!);
      s = await advance(s, t.deps);
      expect(s.host).toMatchObject({ keySource: 'first_use' });
      if (step === 'pair') s = await advance(s, t.deps);
      expect(s.step).toBe(step);
      return { t, s };
    }
    const impostor = { ...HOST_KEY, public_key: 'AAAAimpostor', fingerprint_sha256: 'SHA256:other' };

    it.each(['install', 'pair'] as const)('stops at %s when LNVPS published a different key', async (step) => {
      const { t, s } = await firstUse(step);
      t.lnvps.publishHostKeys(s.vmId!, [impostor]);
      const connects = t.ssh.connects.length;
      const next = await advance(s, t.deps);
      expect(next.hostKeyMismatch).toContain('SHA256:other');
      expect(next.error).toMatchObject({ kind: 'fatal' });
      expect(t.ssh.connects.length).toBe(connects);
    });

    it('carries on, confirmed, when LNVPS published the same key', async () => {
      const { t, s } = await firstUse('install');
      t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
      const next = await advance(s, t.deps);
      expect(next).toMatchObject({ step: 'pair', host: { keySource: 'lnvps' } });
    });
  });

  // Security review: once LNVPS's key contradicts the trusted one, nothing more goes over SSH.
  it('connects to no server whose key LNVPS contradicted', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'install');
    s = { ...s, hostKeyMismatch: 'LNVPS published SHA256:x' };
    const connects = t.ssh.connects.length;
    s = await advance(s, t.deps);
    expect(s.error).toMatchObject({ kind: 'fatal' });
    expect(s.error!.message).toContain('LNVPS published SHA256:x');
    expect(t.ssh.connects.length).toBe(connects);
  });

  // Same phrase again (a reset, or a repeat test): the account already has a paid VM for this
  // phrase's SSH key, so set that one up again instead of buying another.
  it('resumes a paid VM for this phrase instead of ordering a second', async () => {
    const t = world();
    const first = await drive(initialState('GBR'), t);
    expect(first.step).toBe('done');
    const again = await drive(initialState('GBR'), t);
    expect(again).toMatchObject({ step: 'done', vmId: first.vmId });
    expect(t.lnvps.vms.size).toBe(1);
    expect(t.lnvps.invoices).toHaveLength(1);
  });

  it('orders again when the paid VM has expired', async () => {
    const t = world();
    const first = await drive(initialState('GBR'), t);
    t.lnvps.vms.get(first.vmId!)!.expires = new Date(t.w.nowMs - 1000).toISOString();
    const again = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    expect(again.vmId).not.toBe(first.vmId);
  });

  it('pins the key LNVPS publishes when it already has it', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.boot(s.vmId!);
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    s = await advance(s, t.deps);
    expect(s.host).toMatchObject({ keySource: 'lnvps' });
    expect(t.ssh.scans).toBe(0);
  });

  it('waits while the server\'s SSH is not answering, then lets the person try again', async () => {
    const t = world();
    t.ssh.scanFails = true;
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.boot(s.vmId!);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'boot', waiting: 'host_keys' });
    t.w.nowMs += HOST_KEY_WAIT_MS + 1;
    s = await advance(s, t.deps);
    expect(s.error).toMatchObject({ kind: 'retry' });
    expect(s.error?.message).toContain('not answering');
    // Try again waits another 10 minutes rather than failing at once.
    s = await advance({ ...s, error: undefined }, t.deps);
    expect(s).toMatchObject({ waiting: 'host_keys' });
    t.ssh.scanFails = false;
    s = await advance(s, t.deps);
    expect(s.step).toBe('install');
  });

  describe('verifyHostKey', () => {
    async function trusted() {
      const t = world();
      let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
      t.lnvps.boot(s.vmId!);
      s = await drive(s, t);
      expect(s).toMatchObject({ step: 'done', host: { keySource: 'first_use' } });
      return { t, s };
    }

    it('leaves a first-use key as it is until LNVPS publishes one', async () => {
      const { t, s } = await trusted();
      expect(await verifyHostKey(s, t.deps.lnvps)).toBe(s);
    });

    it('marks it verified when LNVPS publishes the same key', async () => {
      const { t, s } = await trusted();
      t.lnvps.publishHostKeys(s.vmId!, [{ key_type: 'ssh-rsa', public_key: 'AAAAB3', fingerprint_sha256: 'SHA256:x' }, HOST_KEY]);
      expect((await verifyHostKey(s, t.deps.lnvps)).host).toMatchObject({ keySource: 'lnvps' });
    });

    it('records a mismatch when LNVPS publishes a different key', async () => {
      const { t, s } = await trusted();
      t.lnvps.publishHostKeys(s.vmId!, [{ ...HOST_KEY, public_key: 'AAAAimpostor', fingerprint_sha256: 'SHA256:other' }]);
      const v = await verifyHostKey(s, t.deps.lnvps);
      expect(v.host).toMatchObject({ keySource: 'first_use' });
      expect(v.hostKeyMismatch).toContain('SHA256:other');
    });
  });

  // A key trusted on first use that the server no longer presents: LNVPS has nothing to do with it.
  it('says a first-use key changed when the server presents another', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.boot(s.vmId!);
    s = await advance(s, t.deps);
    expect(s.host).toMatchObject({ keySource: 'first_use' });
    t.ssh.serverKey = { keyType: 'ssh-ed25519', publicKey: 'AAAAimpostor' };
    s = await advance(s, t.deps);
    expect(s.error?.kind).toBe('fatal');
    expect(s.error?.message).toContain('changed since this app first trusted it');
  });

  it('treats a server key that does not match the one LNVPS published as fatal', async () => {
    const t = world();
    t.ssh.serverKey = { keyType: 'ssh-ed25519', publicKey: 'AAAAimpostor' };
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.boot(s.vmId!);
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    s = await drive(s, t);
    expect(s.step).toBe('install');
    expect(s.error?.kind).toBe('fatal');
    expect(s.error?.message).toContain('not the one LNVPS published');
  });

  it('resumes an interrupted install where it stopped', async () => {
    const t = world();
    t.ssh.when(/install\.sh up/, { code: 1, stderr: 'dependency failed to start' }, 1);
    let s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore']);
    expect(t.checkpoints.at(-1)!.installed).toEqual(s.installed);
    s = await drive({ ...s, error: undefined }, t);
    expect(s.step).toBe('done');
    expect(t.ssh.ran(/install\.sh (first-boot|swap|docker|docker-setup)$/)).toBe(4);
  });

  // The setup screen's "N min so far".
  it('notes when the install began before it connects, keeps it through a failed attempt and a retry, and drops it at pair', async () => {
    const t = world();
    t.ssh.authorizedSeed = '11'.repeat(32); // the first attempt can't log in
    let s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' }, installed: [] });
    const began = t.nowMs;
    expect(s.installSince).toBe(began);
    expect(t.checkpoints.at(-1)!.installSince).toBe(began);
    // Try again, minutes later, and an install step that fails: still the first attempt's time.
    t.ssh.authorizedSeed = undefined;
    t.ssh.when(/install\.sh up/, { code: 1, stderr: 'dependency failed to start' }, 1);
    t.nowMs += 4 * 60_000;
    s = await drive({ ...s, error: undefined }, t);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' }, installSince: began });
    t.nowMs += 60_000;
    s = await drive({ ...s, error: undefined }, t, (x) => x.step === 'pair');
    expect(s.step).toBe('pair');
    expect(t.checkpoints.filter((x) => x.step === 'install').every((x) => x.installSince === began)).toBe(true);
    sinceDropped(s, t);
  });

  it('carries no install time on any step but the install', async () => {
    const t = world();
    // A state saved with one (a stale one, however it came about) loses it at the next step.
    const s = await advance({ ...initialState('GBR'), installSince: 5, stepMs: { upload: 5 }, stepStartedAt: { step: 'swap', at: 1 } }, t.deps);
    expect(s.step).not.toBe('install');
    expect([s.installSince, s.stepMs, s.stepStartedAt]).toEqual([undefined, undefined, undefined]);
  });

  it("passes the upload's progress to onUpload, and saves none of it", async () => {
    const t = world();
    const seen: { path: string; sent: number; total: number }[] = [];
    t.deps.onUpload = (p) => seen.push(p);
    const s = await drive(initialState('GBR'), t, (x) => x.step === 'pair');
    expect(s.step).toBe('pair');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!.sent).toBe(seen.at(-1)!.total);
    // The bundled binary reports part-way too (the fake sends half).
    expect(seen.some((p) => p.sent > 0 && p.sent < p.total)).toBe(true);
    expect(JSON.stringify([s, ...t.checkpoints])).not.toContain('"sent"');
  });

  // A fresh VM may not have installed our key yet, or it was set up for another phrase:
  // either way the user gets an explanation and a Retry, not a raw sshj message.
  it('explains a refused SSH login and lets the user retry', async () => {
    const t = world();
    t.ssh.authorizedSeed = '11'.repeat(32);
    let s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(s.error?.message).toContain('refused this app\'s SSH key');
    t.ssh.authorizedSeed = undefined;
    s = await drive({ ...s, error: undefined }, t);
    expect(s.step).toBe('done');
  });

  it('reports a server set up with another phrase', async () => {
    const t = world();
    t.ssh.when(/install\.sh seed/, { code: 3, stderr: 'refusing to replace' });
    const s = await drive(initialState('GBR'), t);
    expect(s.error?.kind).toBe('wrong_phrase');
  });

  it('waits for the certificate before calling the server healthy', async () => {
    const t = world();
    t.w.healthy = false;
    let s = await drive(initialState('GBR'), t, (x) => x.waiting === 'health');
    expect(s).toMatchObject({ step: 'pair', waiting: 'health', deviceKeyId: vectors.deviceAuth.keyId });
    t.w.healthy = true;
    s = await advance(s, t.deps);
    expect(s.step).toBe('done');
    expect(t.ssh.ran(/device add/)).toBe(1);
  });

  it('does not reuse an unpaid order that is about to be deleted', async () => {
    const t = world();
    const atOrder = await drive(initialState('GBR'), t, (s) => s.step === 'order');
    const first = await advance(atOrder, t.deps); // ordered, but this state is "lost"
    t.w.nowMs += 45 * 60_000; // the app comes back 45 minutes later
    const again = await advance(atOrder, t.deps);
    expect(again.vmId).not.toBe(first.vmId);
    expect(again.orderDeadline).toBe(t.w.nowMs + 3600_000);
  });

  it('records the order deadline for the countdown', async () => {
    const t = world();
    const s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    expect(s.orderDeadline).toBe(Date.parse(t.lnvps.vms.get(s.vmId!)!.created) + 3600_000);
  });

  it('stops offering an invoice near the deadline, then orders again once LNVPS deletes the order', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    const firstVm = s.vmId!;
    t.w.nowMs += 40 * 60_000;
    s = await advance(s, t.deps);
    expect(s.invoice).toBeDefined(); // 20 minutes left: fine
    t.w.nowMs += 11 * 60_000;
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'pay', waiting: 'order_expiring', invoice: undefined });
    t.w.nowMs += 10 * 60_000; // past the hour: LNVPS deletes it, and says 409
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'order', vmId: undefined });
    s = await advance(s, t.deps);
    expect(s.vmId).not.toBe(firstVm);
    expect(t.lnvps.deleted.has(firstVm)).toBe(true);
  });

  it('refuses an arm64 VM before asking for any money', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    t.lnvps.vms.get(s.vmId!)!.cpu_arch = 'arm64';
    s = await advance(s, t.deps);
    expect(s.error).toMatchObject({ kind: 'fatal', message: expect.stringContaining('arm64') });
    expect(s.invoice).toBeUndefined();
    expect(t.lnvps.invoices).toHaveLength(0);
  });

  it('keeps progress saved inside a step when the step then fails', async () => {
    const t = world();
    let s = await advance(initialState('GBR'), t.deps);
    const real = t.deps.lnvps.getAccount.bind(t.deps.lnvps);
    let fail = true;
    t.deps.lnvps.getAccount = async () => {
      if (fail) {
        fail = false;
        throw new Error('network down');
      }
      return real();
    };
    s = await advance(s, t.deps);
    expect(s.error?.kind).toBe('retry');
    expect(s.mailtmAddress).toBe(`${t.keys.mailtmName}@uberip.com`);
  });

  it('keeps finished install steps when closing the connection fails', async () => {
    const t = world();
    t.ssh.closeFails = true;
    const s = await drive(initialState('GBR'), t, (x) => x.step === 'pair');
    expect(s.error).toBeUndefined();
    expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
  });

  it('refuses an arm64 VM', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.vms.get(s.vmId!)!.cpu_arch = 'arm64';
    s = await advance(s, t.deps);
    expect(s.error).toMatchObject({ kind: 'fatal', message: expect.stringContaining('arm64') });
  });

  // The server's name goes into Caddy's config and onto every card: only a plain hostname will do.
  it('uses the hostname LNVPS gives only if it is a plain hostname', () => {
    const vm = (forward_dns?: string) => ({ id: 1001, ip_assignments: [{ ip: '45.67.89.164/24', forward_dns }] });
    expect(serverHostname(vm('VM-1001.LNVPS.cloud.'))).toBe('vm-1001.lnvps.cloud');
    expect(serverHostname(vm('host; rm -rf ~'))).toBe('vm-1001.lnvps.cloud');
    expect(serverHostname(vm('-bad-.lnvps.cloud'))).toBe('vm-1001.lnvps.cloud');
    expect(serverHostname(vm(''))).toBe('vm-1001.lnvps.cloud');
    expect(serverHostname(vm(undefined))).toBe('vm-1001.lnvps.cloud');
    expect(serverHostname(vm('card.example.org'))).toBe('card.example.org');
  });

  it('records the installed bundle on the server, for "Update server"', async () => {
    const t = world();
    await drive(initialState('GBR'), t);
    const sha = bundleSha(await t.deps.bundle());
    expect(t.ssh.commands.some((c) => c.command === `sh card-app/cardd-ctl meta set 'bundle.sha256' '${sha}'`)).toBe(true);
  });

  it('stops for good if cardd says this phone\'s key was revoked', async () => {
    const t = world();
    t.ssh.when(/device add/, { code: 5, stderr: 'cardd: device b18b86ce1389e46d was revoked; generate a new key on the phone' });
    const s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'pair', error: { kind: 'fatal' } });
    expect(s.error?.message).toContain('revoked');
  });

  it('reads the key id from the last line cardd prints', async () => {
    const t = world();
    t.ssh.when(/device add/, { stdout: `WARN[0000] some docker compose notice\n${vectors.deviceAuth.keyId}\n\n` });
    t.cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey); // the add this answer stands for
    const s = await drive(initialState('GBR'), t);
    expect(s.step).toBe('done');
    expect(s.deviceKeyId).toBe(vectors.deviceAuth.keyId);
  });

  // A DNS or connection failure is the phone's network, not a fault: wait and ask again, no error, no button.
  it('waits out a network failure and carries on by itself', async () => {
    const t = world();
    let failures = 1;
    const flaky: FetchFn = async (url, init) => {
      if (failures-- > 0) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
      return t.deps.fetch(url, init);
    };
    const deps = { ...t.deps, lnvps: new LnvpsClient({ fetch: flaky, nostrSecretKey: t.keys.nostrPrivateKey, now: () => t.w.nowMs }) };
    let s = await advance(initialState('GBR'), deps);
    expect(s).toMatchObject({ step: 'country', waiting: 'network' });
    expect(s.error).toBeUndefined();
    s = await advance(s, deps);
    expect(s).toMatchObject({ step: 'email' });
  });

  // On the phone, expo/fetch rejects with its own FetchError (a plain Error), not a TypeError.
  it('waits out the network failure expo/fetch reports on the phone', async () => {
    class FetchError extends Error {}
    const t = world();
    let failures = 1;
    const flaky: FetchFn = async (url, init) => {
      if (failures-- > 0) throw new FetchError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net": No address associated with hostname');
      return t.deps.fetch(url, init);
    };
    const deps = { ...t.deps, lnvps: new LnvpsClient({ fetch: flaky, nostrSecretKey: t.keys.nostrPrivateKey, now: () => t.w.nowMs }) };
    const s = await advance(initialState('GBR'), deps);
    expect(s).toMatchObject({ step: 'country', waiting: 'network' });
    expect(s.error).toBeUndefined();
  });

  it('still reports a bug that happens to be a TypeError', async () => {
    const t = world();
    const broken: FetchFn = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'json')");
    };
    const deps = { ...t.deps, lnvps: new LnvpsClient({ fetch: broken, nostrSecretKey: t.keys.nostrPrivateKey, now: () => t.w.nowMs }) };
    const s = await advance(initialState('GBR'), deps);
    expect(s.waiting).toBeUndefined();
    expect(s.error).toMatchObject({ kind: 'retry' });
  });

  it('offers 7, 14 and 30 days and starts at 7', () => {
    expect(PAY_DAY_PRESETS).toEqual([7, 14, 30]);
    expect(DEFAULT_PAY_DAYS).toBe(7);
    expect(initialState('GBR').payDays).toBe(7);
  });

  it('keeps the days to pay for within bounds, and asks for a new invoice when they change', async () => {
    const t = world();
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'pay');
    s = await advance(s, t.deps);
    expect(s.invoice).toBeDefined();
    expect(withPayDays(s, DEFAULT_PAY_DAYS)).toBe(s);
    expect(withPayDays(s, 2)).toMatchObject({ payDays: 2, invoice: undefined });
    expect(withPayDays(s, 0).payDays).toBe(1);
    expect(withPayDays(s, 1.5).payDays).toBe(2);
    expect(withPayDays(s, 10_000).payDays).toBe(MAX_PAY_DAYS);
    expect(withPayDays(s, Number.NaN).payDays).toBe(DEFAULT_PAY_DAYS);
  });

  // App data comes back from Android's backup, Keystore keys don't: pair the key this phone has now.
  it('pairs again if the device key changed before onboarding finished', async () => {
    const paired: OnboardingState = { ...initialState('GBR'), step: 'pair', deviceKeyId: 'aaaaaaaaaaaaaaaa' };
    expect(reconcileDevice(paired, vectors.deviceAuth.publicKey).deviceKeyId).toBeUndefined();
    const same = { ...paired, deviceKeyId: vectors.deviceAuth.keyId };
    expect(reconcileDevice(same, vectors.deviceAuth.publicKey)).toBe(same);
    const done = { ...paired, step: 'done' as const };
    expect(reconcileDevice(done, vectors.deviceAuth.publicKey)).toBe(done);
  });
});

// Rebuild server: steps 3–6 and the order step's part.
describe('rebuild', () => {
  const OLD_VM = 1012;
  const LOST_PHONE = ['aaaaaaaaaaaaaaaa', '04' + 'aa'.repeat(64)] as const;
  // A cardd.db's bytes, as the phone decrypts them: cardd checks them, the app only carries them.
  const PLAIN = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 256);
  const NAME = snapshotName('00112233445566778899aabbccddeeff', 12, 1_789_990_000);

  /** A paid VM of this phrase (its first SSH key), running, with LNVPS's host key. */
  function paidVm(t: World, id: number, expires = '2026-11-02T12:00:00Z', ipv4 = '45.67.89.170'): Vm {
    const vm: Vm = {
      id, created: '2026-09-01T00:00:00Z', expires, status: { state: 'running' },
      ip_assignments: [{ ip: `${ipv4}/24`, forward_dns: `vm-${id}.lnvps.cloud` }], host_ssh_keys: [HOST_KEY],
      image: { default_username: 'debian' }, ssh_key: { id: 1 },
    };
    t.lnvps.vms.set(id, vm);
    return vm;
  }

  /** The chosen snapshot, kept on this phone, encrypted to the phrase. */
  async function kept(t: World): Promise<ChosenBackup> {
    await t.files.write(NAME, ageEncrypt(PLAIN, t.keys.backupAgeRecipient));
    return { kind: 'kept', name: NAME, created: 1_789_990_000, cards: 2, totalMsat: 5_000_000 };
  }

  /**
   * A rebuild onto a new VM (paid and booting) whose old server, VM 1012, step 4 retired:
   * the state at `step`, as the steps before it leave it.
   */
  async function rebuildAt(step: 'boot' | 'retire' | 'install', r: Partial<Rebuild> = {}) {
    const t = world();
    t.cardd.devices.set(...LOST_PHONE); // stands for the backup's other phones
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot'); // VM 1001, ordered and paid
    paidVm(t, OLD_VM);
    s = startRebuild({ ...s, vmId: OLD_VM }, 'server_page');
    const rebuild: Rebuild = {
      ...s.rebuild!, backup: await kept(t), target: { kind: 'new' }, retire: { result: 'retired', at: t.w.nowMs }, ...r,
    };
    s = { ...s, step: 'boot', vmId: 1001, rebuild };
    t.lnvps.boot(1001);
    t.lnvps.publishHostKeys(1001, [HOST_KEY]);
    if (step !== 'boot') s = await advance(s, t.deps);
    if (step === 'install') s = await advance(s, t.deps);
    expect(s.step).toBe(step);
    return { t, s };
  }

  it('starts afresh from the server it replaces, which it remembers as the old one, and what the server page was', async () => {
    const t = world();
    const done = await drive(initialState('GBR'), t);
    const s = startRebuild(done, 'server_page');
    expect(s).toMatchObject({ step: 'backup', rebuild: { source: 'server_page', oldVm: { id: done.vmId } }, installed: [], othersRevoked: false });
    expect([s.vmId, s.host, s.deviceKeyId]).toEqual([undefined, undefined, undefined]);
    expect(s.country).toBe('GBR');
    // Cancel rebuild puts it back exactly.
    expect(s.rebuild!.before).toEqual({
      step: 'done', vmId: done.vmId, host: done.host, hostKeyMismatch: undefined, installed: done.installed,
      deviceKeyId: done.deviceKeyId, othersRevoked: true, notice: undefined,
    });
  });

  // Step 4 reaches the old server by the key the app pinned for it, trusted on first use or LNVPS's,
  // never one LNVPS has contradicted.
  it('remembers the old server\'s pinned key, first use or LNVPS\'s, unless contradicted', async () => {
    const t = world();
    const done = await drive(initialState('GBR'), t);
    expect(done.host!.keySource).toBe('first_use');
    expect(startRebuild(done, 'server_page').rebuild!.oldVm).toEqual({ id: done.vmId, host: done.host });
    expect(startRebuild({ ...done, hostKeyMismatch: 'LNVPS published another' }, 'server_page').rebuild!.oldVm).toEqual({ id: done.vmId });
    const lnvps = { ...done, host: { ...done.host!, keySource: 'lnvps' as const } };
    expect(startRebuild(lnvps, 'server_page').rebuild!.oldVm).toEqual({ id: done.vmId, host: lnvps.host });
    expect(startRebuild({ ...lnvps, host: { ...lnvps.host, keySource: undefined } }, 'server_page').rebuild!.oldVm!.host).toBeDefined(); // saved before keySource
    expect(startRebuild({ ...lnvps, hostKeyMismatch: 'LNVPS published another' }, 'server_page').rebuild!.oldVm).toEqual({ id: done.vmId });
    // Phrase only puts back the phrase's last VM by the same rule.
    const r = startRebuild(done, 'server_page');
    t.w.healthy = false;
    const s = await advance({ ...r, rebuild: { ...r.rebuild!, oldVm: { id: 1020 }, backup: { kind: 'phrase_only' } } }, t.deps);
    expect(s.rebuild!.oldVm).toEqual({ id: done.vmId, host: done.host });
  });

  it('restores a kept backup on the new server byte for byte, then pairs and revokes every other phone', async () => {
    const { t, s: at } = await rebuildAt('install');
    expect(at.installed).toEqual([]);
    const s = await drive(at, t);
    expect(s.error).toBeUndefined();
    expect(s).toMatchObject({ step: 'done', vmId: 1001, othersRevoked: true, deviceKeyId: vectors.deviceAuth.keyId });
    expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(t.cardd.restored).toEqual({ kind: 'db', db: PLAIN, device: vectors.deviceAuth.publicKey.toLowerCase(), from: NAME.replace(/\.age$/, '') });
    expect(t.cardd.meta.get('restore.from')).toBe(NAME.replace(/\.age$/, ''));
    expect(t.cardd.meta.get('vm.id')).toBe('1001');
    // A new VM has nothing to wipe; the old one was retired at step 4.
    expect(t.ssh.ran(/install\.sh wipe/)).toBe(0);
    expect(t.ssh.ran(/device add/)).toBe(1);
    expect(t.cardd.revoked.has(LOST_PHONE[0])).toBe(true);
  });

  it('starts an empty server for the phrase alone', async () => {
    const { t, s } = await rebuildAt('install', { backup: { kind: 'phrase_only' } });
    expect(await drive(s, t)).toMatchObject({ step: 'done', othersRevoked: true });
    expect(t.cardd.restored).toEqual({ kind: 'fresh', device: vectors.deviceAuth.publicKey.toLowerCase() });
    expect(t.cardd.meta.get('restore.from')).toBe('phrase');
  });

  it('names a backup from a newer server as the app to update', async () => {
    const { t, s } = await rebuildAt('install');
    t.ssh.when(/install\.sh restore /, { code: 6, stderr: "cardd: this backup is from a newer cardd: update the app first (its schema is 5, this cardd's 4)" });
    const next = await drive(s, t);
    expect(next).toMatchObject({ step: 'install', error: { kind: 'fatal' } });
    expect(next.error!.message).toContain('update the app first');
    expect(t.ssh.ran(/install\.sh up/)).toBe(0);
  });

  // In place: the old server's data goes first, then the restore lands where its database was.
  it('wipes the server first in place, keeps its pinned key, and resumes after a cut without wiping again', async () => {
    const t = world();
    t.cardd.devices.set(...LOST_PHONE);
    let s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
    t.lnvps.boot(s.vmId!);
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    const done = await drive(s, t);
    expect(done).toMatchObject({ step: 'done', host: { keySource: 'lnvps' } });
    expect(t.cardd.database).toBe(true);
    const vmId = done.vmId!;
    s = startRebuild(done, 'server_page');
    // What steps 1, 2 and 4 leave for in place: the same VM, its pinned key.
    s = {
      ...s, step: 'boot', vmId, host: done.host,
      rebuild: { ...s.rebuild!, backup: await kept(t), target: { kind: 'in_place', vmId }, retire: { result: 'in_place', at: t.w.nowMs } },
    };
    // Boot keeps the pinned key, then step 4 (already recorded here) goes on to the install.
    t.lnvps.publishHostKeys(vmId, []); // no need to wait for LNVPS: the key is already LNVPS's
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'retire', host: done.host });
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'install', host: done.host });
    const before = t.ssh.commands.length;
    t.ssh.when(/install\.sh up/, { code: 1, stderr: 'dependency failed to start' }, 1);
    s = await drive(s, t);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore']);
    s = await drive({ ...s, error: undefined }, t);
    expect(s).toMatchObject({ step: 'done', othersRevoked: true });
    const ran = t.ssh.commands.slice(before).map((c) => c.command);
    const at = (re: RegExp) => ran.findIndex((c) => re.test(c));
    expect(at(/install\.sh prepare/)).toBeLessThan(at(/install\.sh wipe$/));
    expect(at(/install\.sh wipe$/)).toBeLessThan(at(/install\.sh seed/));
    expect(at(/install\.sh issuer-key/)).toBeLessThan(at(/install\.sh restore /));
    expect(ran.filter((c) => /install\.sh (wipe|restore) /.test(`${c} `))).toHaveLength(2); // once each, cut or not
    expect(t.cardd.restored).toMatchObject({ kind: 'db', db: PLAIN });
    expect(t.cardd.revoked.has(LOST_PHONE[0])).toBe(false); // the wipe took the old phones with it
    expect(t.cardd.devices.has(vectors.deviceAuth.keyId)).toBe(true);
  });

  // A rebuild trusts on first use as onboarding does,
  // and the key is checked against LNVPS's later; the old server keeps running until then only for minutes.
  it('trusts the key the server presents when LNVPS has not published one, and goes on to retire', async () => {
    const { t, s: at } = await rebuildAt('boot');
    t.lnvps.publishHostKeys(1001, [{ key_type: 'ssh-rsa', public_key: 'AAAAB3', fingerprint_sha256: 'SHA256:x' }]);
    const s = await advance(at, t.deps);
    expect(t.ssh.scans).toBe(1);
    expect(s).toMatchObject({ step: 'retire', host: { hostKey: { publicKey: HOST_KEY.public_key }, keySource: 'first_use', hostname: 'vm-1001.lnvps.cloud' } });
    expect(s.host!.trustedAt).toBe(t.w.nowMs); // when the 2 h for LNVPS to confirm it starts
    expect(s.hostKeyTypes).toBeUndefined();
  });

  it('pins LNVPS\'s key when it already lists one', async () => {
    const { t, s: at } = await rebuildAt('boot');
    const s = await advance(at, t.deps);
    expect(t.ssh.scans).toBe(0);
    expect(s).toMatchObject({ step: 'retire', host: { keySource: 'lnvps' } });
    expect(s.host!.trustedAt).toBeUndefined();
  });

  it('waits for SSH to answer, and after 10 minutes offers Try again, like onboarding', async () => {
    const { t, s: at } = await rebuildAt('boot');
    t.lnvps.publishHostKeys(1001, []);
    t.ssh.scanFails = true;
    let s = await advance(at, t.deps);
    expect(s).toMatchObject({ step: 'boot', waiting: 'host_keys' });
    t.w.nowMs += HOST_KEY_WAIT_MS + 1;
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'boot', error: { kind: 'retry' } });
    expect(s.rebuild).toEqual(at.rebuild); // boot leaves the rebuild's record alone
  });

  // In place on the old VM, chooseWhere carries its pinned host here: a first-use key is kept, as step 4 keeps it.
  describe('in place, with a key trusted on first use pinned for that VM', () => {
    const firstUse = (publicKey = HOST_KEY.public_key) => ({
      ipv4: '45.67.89.164', hostname: 'vm-1001.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey },
      keySource: 'first_use' as const, trustedAt: 1_000,
    });

    it('in place, keeps the first-use key pinned for that VM while LNVPS lists none', async () => {
      const { t, s: at } = await rebuildAt('boot', { target: { kind: 'in_place', vmId: 1001 } });
      t.lnvps.publishHostKeys(1001, []);
      const s = await advance({ ...at, host: firstUse() }, t.deps);
      expect(s).toMatchObject({ step: 'retire', host: firstUse() });
      expect(t.ssh.scans).toBe(0);
    });

    it("in place, records a first-use key LNVPS now lists as LNVPS's", async () => {
      const { t, s: at } = await rebuildAt('boot', { target: { kind: 'in_place', vmId: 1001 } });
      const s = await advance({ ...at, host: firstUse() }, t.deps);
      expect(s).toMatchObject({ step: 'retire', host: { hostKey: { publicKey: HOST_KEY.public_key }, keySource: 'lnvps' } });
      expect(s.host!.trustedAt).toBeUndefined();
      expect(t.ssh.scans).toBe(0);
    });

    it("in place, takes LNVPS's key when it lists another than the first-use one pinned", async () => {
      const { t, s: at } = await rebuildAt('boot', { target: { kind: 'in_place', vmId: 1001 } });
      const s = await advance({ ...at, host: firstUse('AAAAC3NzaC1lZDI1NTE5AAAAIfirstuse') }, t.deps);
      expect(s).toMatchObject({ step: 'retire', host: { hostKey: { publicKey: HOST_KEY.public_key }, keySource: 'lnvps' } });
      expect(s.host!.trustedAt).toBeUndefined();
      expect(t.ssh.scans).toBe(0);
    });
  });

  // The server page's check (verifyHostKey) covers a rebuilt server as it does a new one, and a
  // contradicted key stops anything more going over SSH (checkedHost before each connection).
  it('sends nothing to a rebuilt server once LNVPS contradicts the key trusted on first use', async () => {
    const { t, s: at } = await rebuildAt('boot');
    t.lnvps.publishHostKeys(1001, []);
    let s = await advance(at, t.deps);
    expect(s).toMatchObject({ step: 'retire', host: { keySource: 'first_use' } });
    t.lnvps.publishHostKeys(1001, [{ key_type: 'ssh-ed25519', public_key: 'AAAAC3NzaC1lZDI1NTE5AAAAIOther', fingerprint_sha256: 'SHA256:other' }]);
    const before = t.ssh.connects.length;
    s = await drive(s, t);
    expect(s.hostKeyMismatch).toContain('SHA256:other');
    expect(s.error).toMatchObject({ kind: 'fatal' });
    expect(t.ssh.connects.length).toBe(before); // no login at all: the seed, issuer key and ledger stay on the phone
  });

  // Step 4's record can be old.
  describe('looks at the old server again just before up', () => {
    it('refuses while it runs without having been retired over SSH, and goes back to retiring it', async () => {
      const { t, s: at } = await rebuildAt('install', { retire: { result: 'override', at: 1 }, confirm: { older: true, override: 'ssh' } });
      const s = await drive(at, t);
      expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' } });
      sinceDropped(s, t);
      expect(s.error!.message).toContain('old server is running again');
      expect(s.rebuild).toMatchObject({ retire: undefined, confirm: { older: true } });
      expect(s.rebuild!.confirm!.override).toBeUndefined();
      expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore']);
      expect(t.ssh.ran(/install\.sh up/)).toBe(0);
      expect(t.cardd.restored).toMatchObject({ kind: 'db' }); // restored, and kept for the install's next try
    });

    it.each([
      ['retired over SSH', { result: 'retired' as const, at: 1 }, 'running' as const],
      ['re-installed', { result: 'reinstalled' as const, at: 1 }, 'running' as const],
      ['stopped', { result: 'override' as const, at: 1 }, 'stopped' as const],
    ])('goes on when it was %s', async (_, retire, state) => {
      const { t, s } = await rebuildAt('install', { retire });
      t.lnvps.vms.get(OLD_VM)!.status = { state };
      expect(await drive(s, t)).toMatchObject({ step: 'done' });
    });

    it('goes on when LNVPS deleted it', async () => {
      const { t, s } = await rebuildAt('install', { retire: { result: 'gone', at: 1 } });
      t.lnvps.deleteVm(OLD_VM);
      expect(await drive(s, t)).toMatchObject({ step: 'done' });
    });

    /** LNVPS can't be reached about the old VM (the new one still answers). */
    function oldVmUnreachable(t: World) {
      const real = t.deps.lnvps.getVm.bind(t.deps.lnvps);
      t.deps.lnvps.getVm = async (id) => {
        if (id === OLD_VM) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
        return real(id);
      };
    }

    it('waits for the network when LNVPS can\'t be reached', async () => {
      const { t, s: at } = await rebuildAt('install', { retire: { result: 'expired', at: 1 } });
      oldVmUnreachable(t);
      const s = await advance(at, t.deps);
      expect(s).toMatchObject({ step: 'install', waiting: 'network' });
      expect(s.error).toBeUndefined();
      expect(s.installed).toContain('restore');
    });

    // The override typed at step 4 also lets this check go on blind.
    it('goes on when LNVPS can\'t be reached after the override (it still refuses when LNVPS says the old VM runs, above)', async () => {
      const { t, s: at } = await rebuildAt('install', { retire: { result: 'override', at: 1 } });
      oldVmUnreachable(t);
      expect(await drive(at, t)).toMatchObject({ step: 'done' });
    });
  });

  it('refuses, as a bug, a rebuild\'s install with no record of step 4', async () => {
    const { t, s } = await rebuildAt('install');
    const next = await advance({ ...s, rebuild: { ...s.rebuild!, retire: undefined } }, t.deps);
    expect(next).toMatchObject({ step: 'install', error: { kind: 'fatal', message: "A rebuild reached the install without step 4's record" } });
    expect(t.ssh.commands).toEqual([]);
  });

  // Nothing the app does mends it (a rebuild's own target is wiped in place, or new): a try again would refuse the same.
  it('stops, neither ordering again nor trying again, when the new server says it was retired', async () => {
    const { t, s } = await rebuildAt('install');
    t.cardd.retired = { at: '2026-10-06T17:40:12Z', replacedBy: 1010 };
    expect(await drive(s, t)).toMatchObject({ step: 'install', vmId: 1001, error: { kind: 'fatal' } });
  });

  it('resumes after a cut between pairing and revoking the other phones', async () => {
    const { t, s: at } = await rebuildAt('install');
    t.ssh.when(/device revoke-others/, { code: 255, stderr: 'connection reset' }, 1);
    let s = await drive(at, t);
    expect(s).toMatchObject({ step: 'pair', deviceKeyId: vectors.deviceAuth.keyId, othersRevoked: false, error: { kind: 'retry' } });
    s = await drive({ ...s, error: undefined }, t);
    expect(s).toMatchObject({ step: 'done', othersRevoked: true });
    expect(t.ssh.ran(/device add/)).toBe(1);
    expect(t.cardd.revoked.has(LOST_PHONE[0])).toBe(true);
  });

  describe('order', () => {
    async function atOrder(restoring: boolean) {
      const t = world();
      const s = await drive({ ...initialState('GBR'), restoring }, t, (x) => x.step === 'order');
      return { t, s };
    }

    // A paid VM of this phrase that nothing retired is set up again.
    it('on a new phone, sets up the phrase\'s paid VM again', async () => {
      const { t, s } = await atOrder(true);
      paidVm(t, OLD_VM);
      expect(await advance(s, t.deps)).toMatchObject({ step: 'boot', vmId: OLD_VM });
    });

    it('on a new phone with no paid VM left but a retired one, offers to rebuild instead of installing an empty server', async () => {
      const { t, s } = await atOrder(true);
      paidVm(t, OLD_VM);
      const next = await advance({ ...s, retiredVms: [OLD_VM] }, t.deps);
      expect(next).toMatchObject({ step: 'backup', rebuild: { source: 'new_phone' }, installed: [] });
      expect(next.vmId).toBeUndefined();
      expect(t.lnvps.vms.size).toBe(1); // nothing ordered
    });

    it('orders a new VM when onboarding a new phrase', async () => {
      const { t, s } = await atOrder(false);
      expect(await advance(s, t.deps)).toMatchObject({ step: 'pay', vmId: 1001 });
    });

    // The phrase's paid VM is the old server (or another); a rebuild onto a new VM buys one.
    it('in a rebuild onto a new VM, orders one even with a paid VM there, boots it once paid, and then retires the old server', async () => {
      const { t, s: at } = await atOrder(true);
      paidVm(t, OLD_VM);
      let s = startRebuild({ ...at, vmId: OLD_VM }, 'new_phone');
      s = { ...s, step: 'order', rebuild: { ...s.rebuild!, backup: { kind: 'phrase_only' }, target: { kind: 'new' } } };
      s = await advance(s, t.deps);
      expect(s).toMatchObject({ step: 'pay', vmId: 1001 });
      s = await advance(s, t.deps);
      t.lnvps.pay(1001);
      s = await advance(s, t.deps);
      expect(s).toMatchObject({ step: 'boot', vmId: 1001 });
      t.lnvps.boot(1001);
      t.lnvps.publishHostKeys(1001, [HOST_KEY]);
      s = await advance(s, t.deps);
      expect(s).toMatchObject({ step: 'retire', vmId: 1001, host: { keySource: 'lnvps' } });
    });
  });

  // A new phone finds the phrase's paid VMs; one a rebuild retired says so at up.
  it('skips a server a rebuild retired, saying what replaced it, and sets up the next', async () => {
    const t = world();
    paidVm(t, OLD_VM, '2026-12-01T00:00:00Z'); // paid longest, so tried first
    paidVm(t, 1013);
    t.cardd.retired = { at: '2026-10-06T17:40:12Z', replacedBy: 1013 };
    let s = await drive({ ...initialState('GBR'), restoring: true }, t, (x) => !!x.retiredVms?.length);
    expect(s).toMatchObject({ step: 'order', retiredVms: [OLD_VM], installed: [] });
    sinceDropped(s, t);
    expect(s.error).toBeUndefined();
    expect(s.notice).toBe('VM 1012 was replaced by VM 1013 in a rebuild: it can\'t be used again.');
    expect([s.vmId, s.host]).toEqual([undefined, undefined]);
    t.cardd.retired = null; // VM 1013's server
    s = await drive(s, t);
    expect(s).toMatchObject({ step: 'done', vmId: 1013 });
    expect(t.lnvps.vms.size).toBe(2);
  });

  // A new phone whose phrase has more than one paid server asks which.
  describe('more than one server left', () => {
    it('asks which to set up, and takes only one of them', async () => {
      const t = world();
      paidVm(t, OLD_VM);
      paidVm(t, 1013, '2026-12-01T00:00:00Z');
      const at = await drive({ ...initialState('GBR'), restoring: true }, t, (x) => x.step === 'order');
      let s = await advance(at, t.deps);
      expect(s).toMatchObject({ step: 'order', waiting: 'choose_vm' });
      expect(s.vmChoices).toEqual([{ id: 1013, expires: '2026-12-01T00:00:00Z' }, { id: OLD_VM, expires: '2026-11-02T12:00:00Z' }]);
      s = await advance({ ...s, chosenVmId: 2999 }, t.deps); // not one of them
      expect(s).toMatchObject({ step: 'order', waiting: 'choose_vm', chosenVmId: undefined });
      s = await advance({ ...s, chosenVmId: OLD_VM }, t.deps);
      expect(s).toMatchObject({ step: 'boot', vmId: OLD_VM });
      expect(t.lnvps.vms.size).toBe(2); // nothing ordered
    });

    it('sets up the only one without asking, and asks whenever there are more, a new phone or not', async () => {
      const t = world();
      paidVm(t, OLD_VM);
      const at = await drive({ ...initialState('GBR'), restoring: true }, t, (x) => x.step === 'order');
      expect(await advance(at, t.deps)).toMatchObject({ step: 'boot', vmId: OLD_VM });
      paidVm(t, 1013, '2026-12-01T00:00:00Z');
      expect(await advance({ ...at, restoring: false }, t.deps)).toMatchObject({ step: 'order', waiting: 'choose_vm' });
    });
  });

  // Steps 1, 2 and 4: choosing the backup and where, and retiring the old server.
  describe('steps 1, 2 and 4', () => {
    const T0 = 1_790_000_000; // the world's clock, in seconds
    const OLD_HOST: ServerHost = {
      ipv4: '45.67.89.170', hostname: 'vm-1012.lnvps.cloud', user: 'debian',
      hostKey: { keyType: 'ssh-ed25519', publicKey: HOST_KEY.public_key }, keySource: 'lnvps',
    };
    const OLD_INSTALL = 'ab'.repeat(16);

    /** What a snapshot of VM 1012 holds, as the phone's inspect reads it. */
    const summary = (created: number, o: Partial<SnapshotSummary> = {}): SnapshotSummary =>
      ({ vmId: String(OLD_VM), userVersion: CARDD_SCHEMA_VERSION, cards: 2, totalMsat: 5_000_000, created, ...o });

    /** Keeps a snapshot on this phone, encrypted to the phrase; returns its name. */
    async function keep(t: World, x: SnapshotSummary, version = 1) {
      const name = snapshotName(OLD_INSTALL, version, x.created);
      await t.files.write(name, sealSummary(x, t.keys.backupAgeRecipient));
      return name;
    }

    /** A final snapshot the old server makes, newer than the choice. */
    const finalOf = (old: OtherServer, t: World) => old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);

    /** The screen's choice: what it shows is checked again by step 1. */
    const choice = (name: string): ChosenBackup => ({ kind: 'kept', name, created: 0, cards: 0, totalMsat: 0 });
    const confirmed = (s: OnboardingState, c: NonNullable<Rebuild['confirm']>): OnboardingState =>
      ({ ...s, rebuild: { ...s.rebuild!, confirm: { ...s.rebuild!.confirm, ...c } } });

    /**
     * A rebuild started on the server page of VM 1012 (paid, running, its own server answering
     * SSH and HTTPS, this phone paired), after onboarding's email step: at step 1, with `r` merged in.
     */
    async function fromServerPage(r: Partial<Rebuild> = {}, host = OLD_HOST) {
      const t = world();
      const atOrder = await drive(initialState('GBR'), t, (x) => x.step === 'order');
      paidVm(t, OLD_VM);
      const old = t.addServer(OLD_HOST.ipv4, OLD_HOST.hostname);
      old.cardd.backupInstallId = OLD_INSTALL;
      const page = { ...atOrder, step: 'done' as const, vmId: OLD_VM, host, deviceKeyId: vectors.deviceAuth.keyId, othersRevoked: true };
      const s = startRebuild(page, 'server_page');
      return { t, old, s: { ...s, rebuild: { ...s.rebuild!, ...r } } };
    }

    /** The same rebuild at step 4: a kept backup of two hours ago chosen, the new VM 1001 ordered, paid and booted. */
    async function atRetire(r: Partial<Rebuild> = {}, host = OLD_HOST) {
      const f = await fromServerPage({}, host);
      const name = await keep(f.t, summary(T0 - 7200));
      const backup: ChosenBackup = { kind: 'kept', name, created: T0 - 7200, cards: 2, totalMsat: 5_000_000 };
      const at: OnboardingState = { ...f.s, step: 'order', rebuild: { ...f.s.rebuild!, backup, target: { kind: 'new' }, ...r } };
      const s = await drive(at, f.t, (x) => x.step === 'retire');
      expect(s).toMatchObject({ step: 'retire', vmId: 1001 });
      return { ...f, s, name };
    }

    /** Another VM of this phrase, paid and running at its own address, with its own server: its seed there, never retired. */
    function another(t: World, id: number, expires?: string): OtherServer {
      const ipv4 = `45.67.89.${id - 842}`;
      paidVm(t, id, expires, ipv4);
      const other = t.addServer(ipv4, `vm-${id}.lnvps.cloud`);
      other.cardd.backupInstallId = 'cd'.repeat(16);
      return other;
    }

    // The whole of steps 1–4, then the rest as onboarding, every state saved as JSON between steps.
    it('rebuilds onto a new VM: the backup checked, the old server\'s final snapshot taken and the server retired before the new one starts', async () => {
      const { t, old, s: at } = await fromServerPage();
      const chosen = await keep(t, summary(T0 - 7200));
      const saved = (x: OnboardingState): OnboardingState => JSON.parse(JSON.stringify(x));
      let s = saved(await advance(at, t.deps));
      expect(s).toMatchObject({ step: 'backup', waiting: 'choose_backup' });
      s = saved(await advance(withBackup(s, choice(chosen)), t.deps));
      expect(s).toMatchObject({ step: 'where', rebuild: { backup: { kind: 'kept', name: chosen, created: T0 - 7200, cards: 2, totalMsat: 5_000_000 } } });
      s = saved(await advance(s, t.deps));
      expect(s).toMatchObject({ step: 'where', waiting: 'choose_where' });
      s = saved(await advance({ ...s, rebuild: { ...s.rebuild!, target: { kind: 'new' } } }, t.deps));
      expect(s).toMatchObject({ step: 'order' });
      s = saved(await drive(s, t, (x) => x.step === 'retire'));
      // Booted, its key trusted on first use (LNVPS publishes it about an hour later): the old server keeps running until now.
      expect(s).toMatchObject({ vmId: 1001, host: { keySource: 'first_use' } });
      s = saved(await advance(s, t.deps));
      expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_retire' });
      expect(old.ssh.ran(/install\.sh (final-snapshot|retire )/)).toBe(0); // nothing before the person confirms
      // The old server has changed since: its final snapshot is newer than the choice.
      old.cardd.addSnapshot(sealSummary(summary(T0 - 60, { cards: 3, totalMsat: 7_000_000 }), t.keys.backupAgeRecipient), T0 - 60);
      const final = snapshotName(OLD_INSTALL, 1, T0 - 60);
      s = saved(await advance(confirmed(s, { retire: true }), t.deps));
      expect(s).toMatchObject({
        step: 'install',
        rebuild: { retire: { result: 'retired', at: t.w.nowMs }, backupLocked: true, backup: { kind: 'kept', name: final, created: T0 - 60, cards: 3, totalMsat: 7_000_000 } },
      });
      expect(s.notice).toBe(`The old server's final snapshot, of ${timeText(T0 - 60)}, replaces the backup of ${timeText(T0 - 7200)} chosen in step 1.`);
      expect(await t.files.read(final)).toEqual(old.cardd.snapshots.get(1));
      expect(old.cardd.retired).toEqual({ at: '2026-09-21T14:13:20Z', replacedBy: 1001 });
      const ran = old.ssh.commands.map((c) => c.command);
      expect(ran.findIndex((c) => /final-snapshot$/.test(c))).toBeLessThan(ran.findIndex((c) => /install\.sh retire '1001'$/.test(c)));
      // The app's own install.sh, and nothing else of the bundle.
      expect([...old.ssh.files.keys()]).toEqual(['card-app/install.sh']);
      expect(ran.filter((c) => /cardd-ctl device add/.test(c))).toEqual([]); // paired already
      expect(t.ssh.commands).toHaveLength(0); // nothing on the new VM yet
      s = await drive(s, t);
      expect(s).toMatchObject({ step: 'done', vmId: 1001, othersRevoked: true });
      expect(t.cardd.restored).toMatchObject({ kind: 'db', from: final.replace(/\.age$/, '') });
    });

    describe('choose a backup', () => {
      it('keeps what the chosen backup holds, and refuses one the phrase can\'t open or a newer server made', async () => {
        const { t, s: at } = await fromServerPage();
        const good = await keep(t, summary(T0 - 60, { cards: 3, totalMsat: 9_000 }));
        expect(await advance(withBackup(at, choice(good)), t.deps)).toMatchObject({
          step: 'where', rebuild: { backup: { kind: 'kept', name: good, created: T0 - 60, cards: 3, totalMsat: 9_000 } },
        });
        const garbled = snapshotName(OLD_INSTALL, 2, T0 - 30);
        await t.files.write(garbled, new Uint8Array([1, 2, 3]));
        let s = await advance(withBackup(at, choice(garbled)), t.deps);
        expect(s).toMatchObject({ step: 'backup', error: { kind: 'retry', message: "This backup can't be opened with your recovery phrase: choose another." } });
        const newer = await keep(t, summary(T0, { userVersion: CARDD_SCHEMA_VERSION + 1 }), 3);
        s = await advance(withBackup(s, choice(newer)), t.deps);
        expect(s).toMatchObject({ step: 'backup', error: { kind: 'fatal' } });
        expect(s.error!.message).toBe(
          `This backup was made by a newer version of the server than this app carries: update the app first (its schema is ${CARDD_SCHEMA_VERSION + 1}, this app's ${CARDD_SCHEMA_VERSION}).`,
        );
      });

      it.each([
        ['this phone holds a newer one', { phone: T0 - 600 }],
        ['the server last reported a newer one', { server: T0 - 300 }],
        ['both', { phone: T0 - 600, server: T0 - 300 }],
      ])('warns when %s, naming the times, and goes on only after a second confirmation', async (_, newer: { phone?: number; server?: number }) => {
        const { t, s: at } = await fromServerPage();
        const name = await keep(t, summary(T0 - 7200));
        if (newer.phone) await keep(t, summary(newer.phone), 2);
        if (newer.server) t.w.serverLatest = { installId: OLD_INSTALL, version: 9, created: newer.server };
        let s = await advance(withBackup(at, choice(name)), t.deps);
        expect(s).toMatchObject({ step: 'backup', waiting: 'confirm_older', rebuild: { backup: { name, created: T0 - 7200 } } });
        expect(s.notice).toBe(olderNotice(s.rebuild!.backup!, newer));
        for (const time of [T0 - 7200, newer.phone, newer.server]) if (time) expect(s.notice).toContain(timeText(time));
        s = await advance(s, t.deps); // the app was closed meanwhile
        expect(s).toMatchObject({ step: 'backup', waiting: 'confirm_older' });
        expect(await advance(confirmed(s, { older: true }), t.deps)).toMatchObject({ step: 'where' });
      });

      it('goes straight on with the newest there is', async () => {
        const { t, s: at } = await fromServerPage();
        await keep(t, summary(T0 - 7200));
        const name = await keep(t, summary(T0 - 60), 2);
        t.w.serverLatest = { installId: OLD_INSTALL, version: 2, created: T0 - 60 }; // the same snapshot
        expect(await advance(withBackup(at, choice(name)), t.deps)).toMatchObject({ step: 'where' });
      });

      it('offers the phrase alone only when the old server can\'t be reached, or the phone holds no backup', async () => {
        const { t, old, s: at } = await fromServerPage();
        const phraseOnly = withBackup(at, { kind: 'phrase_only' });
        expect(await advance(phraseOnly, t.deps)).toMatchObject({ step: 'where' }); // nothing kept: step 4's final snapshot may replace it
        await keep(t, summary(T0 - 7200));
        let s = await advance(phraseOnly, t.deps);
        expect(s).toMatchObject({ step: 'backup', error: { kind: 'retry' } });
        expect(s.error!.message).toContain('still answers');
        old.httpsDown = true;
        s = await advance(phraseOnly, t.deps);
        // A kept snapshot is newer than none: the same second confirmation.
        expect(s).toMatchObject({ step: 'backup', waiting: 'confirm_older', rebuild: { backup: { kind: 'phrase_only' } } });
        expect(s.notice).toContain(timeText(T0 - 7200));
        expect(await advance(confirmed(s, { older: true }), t.deps)).toMatchObject({ step: 'where' });
      });

      it('offers the phrase alone while the old server answers if the phone\'s only backups can\'t be opened', async () => {
        const { t, s: at } = await fromServerPage();
        const bad = await keep(t, summary(T0 - 7200));
        await t.files.mark(bad, 'unreadable');
        expect(await advance(withBackup(at, { kind: 'phrase_only' }), t.deps)).toMatchObject({ step: 'where' });
      });

      it('on a new phone, the old server is the one the chosen backup names, else the phrase\'s last', async () => {
        const t = world();
        paidVm(t, OLD_VM, '2026-09-01T00:00:00Z'); // expired: nothing left to set up
        let s = await drive({ ...initialState('GBR'), restoring: true }, t, (x) => x.step === 'backup');
        expect(s.rebuild).toMatchObject({ source: 'new_phone', oldVm: { id: OLD_VM } });
        expect(await advance(withBackup(s, { kind: 'phrase_only' }), t.deps)).toMatchObject({ step: 'where', rebuild: { oldVm: { id: OLD_VM } } });
        const name = await keep(t, summary(T0 - 7200, { vmId: '1013' }));
        s = await advance(withBackup(s, choice(name)), t.deps);
        expect(s).toMatchObject({ step: 'where', rebuild: { oldVm: { id: 1013 } } });
        expect(s.rebuild!.oldVm!.host).toBeUndefined();
        // Back at step 1, the phrase alone: the old server is the phrase's last again, not the backup's.
        t.w.healthy = false; // nothing answers, so the phrase alone is offered
        const back = await advance(withBackup({ ...s, step: 'backup' }, { kind: 'phrase_only' }), t.deps);
        expect(back).toMatchObject({ step: 'backup', waiting: 'confirm_older', rebuild: { oldVm: { id: OLD_VM } } });
      });

      it('changes the choice only until step 4 has run, and asks for the second confirmation again', () => {
        const at = startRebuild({ ...initialState('GBR'), vmId: OLD_VM }, 'server_page');
        const s = { ...at, rebuild: { ...at.rebuild!, backup: choice('a'), confirm: { older: true, retire: true } } };
        expect(withBackup(s, choice('b')).rebuild).toMatchObject({ backup: { name: 'b' }, confirm: { older: undefined, retire: true } });
        const locked = { ...s, rebuild: { ...s.rebuild, backupLocked: true } };
        expect(withBackup(locked, choice('b'))).toBe(locked);
      });
    });

    describe('notNewest', () => {
      const k = (created: number, checked?: 'ok' | 'unreadable' | 'other'): Kept => ({ name: `x-1-${created}.age`, installId: 'x', version: 1, created, checked });
      const chosen: ChosenBackup = { kind: 'kept', name: 'x-1-100.age', created: 100, cards: 0, totalMsat: 0 };
      const server = (created: number) => ({ installId: 'x', version: 3, created });

      it('names the newer snapshots on the phone and on the server, if any', () => {
        expect(notNewest(chosen, [k(50), k(100)], server(100))).toBeNull();
        expect(notNewest(chosen, [k(50), k(200)], null)).toEqual({ phone: 200 });
        expect(notNewest(chosen, [k(100)], server(300))).toEqual({ server: 300 });
        expect(notNewest(chosen, [k(200), k(150)], server(300))).toEqual({ phone: 200, server: 300 });
      });

      it('passes over a kept snapshot the phrase can\'t open', () => {
        expect(notNewest(chosen, [k(200, 'unreadable')], null)).toBeNull();
        expect(notNewest(chosen, [k(200, 'unreadable'), k(150, 'ok')], null)).toEqual({ phone: 150 });
        expect(notNewest(chosen, [k(200, 'other')], null)).toEqual({ phone: 200 }); // it opens with the phrase
      });

      it('finds anything newer than the phrase alone', () => {
        expect(notNewest({ kind: 'phrase_only' }, [], null)).toBeNull();
        expect(notNewest({ kind: 'phrase_only' }, [k(1)], server(2))).toEqual({ phone: 1, server: 2 });
      });
    });

    describe('choose where', () => {
      it('rebuilds in place only once Rebuild on VM is tapped, keeping the old server\'s pinned key, its final snapshot taken first', async () => {
        const { t, old, s: at } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM } });
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        let s = await advance({ ...at, step: 'where' }, t.deps);
        expect(s).toMatchObject({ step: 'where', waiting: 'choose_where' });
        s = await advance(confirmed(s, { inPlace: true }), t.deps);
        expect(s).toMatchObject({ step: 'boot', vmId: OLD_VM, host: OLD_HOST });
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', host: OLD_HOST });
        expect(old.ssh.connects).toHaveLength(0);
        // REBUILD was the confirmation: the final snapshot, then the install's wipe retires it.
        s = await advance(s, t.deps);
        expect(s).toMatchObject({
          step: 'install',
          rebuild: { retire: { result: 'in_place', at: t.w.nowMs }, backupLocked: true, backup: { kind: 'kept', name: snapshotName(OLD_INSTALL, 1, T0 - 60), created: T0 - 60 } },
        });
        expect(s.notice).toBe(`The old server's final snapshot, of ${timeText(T0 - 60)}, replaces the phrase alone chosen in step 1.`);
        expect(old.ssh.files.has('card-app/install.sh')).toBe(true);
        expect(old.ssh.ran(/install\.sh final-snapshot$/)).toBe(1);
        expect(old.ssh.ran(/install\.sh retire /)).toBe(0);
        expect(old.cardd.retired).toBeNull();
      });

      it('rebuilds in place with no final snapshot when the server doesn\'t answer SSH', async () => {
        const { t, old, s: at } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        old.ssh.unreachable = old.httpsDown = true;
        const s = await drive({ ...at, step: 'where' }, t, (x) => x.step === 'install');
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' }, backup: { kind: 'phrase_only' } } });
        expect(old.ssh.commands).toEqual([]);
      });

      it('in place, tries again when the final snapshot it just made can\'t be fetched, and the override goes on to the wipe without it', async () => {
        const { t, old, s: from } = await fromServerPage({ target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const name = await keep(t, summary(T0 - 7200));
        const backup: ChosenBackup = { kind: 'kept', name, created: T0 - 7200, cards: 2, totalMsat: 5_000_000 };
        const at = await drive({ ...from, step: 'where', rebuild: { ...from.rebuild!, backup } }, t, (x) => x.step === 'retire');
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        old.httpsDown = true;
        let s = at;
        for (let i = 1; i <= RETIRE_TRIES_BEFORE_OVERRIDE; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: expect.stringContaining("final snapshot couldn't be fetched") }, rebuild: { retireTries: i } });
          expect(s.rebuild!.retire).toBeUndefined();
        }
        expect(overrideOffered(s)).toBe(true);
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' }, backup: { name, created: T0 - 7200 } } });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(s.notice).toContain(`The rebuild goes on from the backup of ${timeText(T0 - 7200)}.`);
        old.httpsDown = false;
        expect(await drive(s, t)).toMatchObject({ step: 'done', vmId: OLD_VM });
        expect(old.ssh.ran(/install\.sh wipe$/)).toBe(1);
        expect(old.cardd.restored).toMatchObject({ kind: 'db', from: name.replace(/\.age$/, '') });
      });

      it('in place on a VM that holds no Lightning wallet, takes no final snapshot', async () => {
        const { t, old, s: at } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        old.cardd.seeded = false;
        const s = await drive({ ...at, step: 'where' }, t, (x) => x.step === 'install');
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' }, backup: { kind: 'phrase_only' } } });
        expect(s.error).toBeUndefined();
        expect(old.ssh.ran(/install\.sh final-snapshot$/)).toBe(0);
      });

      // Each attempt counts, whatever stops it, and the override acts: the install's wipe retires the server all the same.
      it('in place, counts every failed attempt, and the override goes on to the wipe without the final snapshot', async () => {
        const { t, old, s: from } = await fromServerPage({ target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const name = await keep(t, summary(T0 - 7200));
        const backup: ChosenBackup = { kind: 'kept', name, created: T0 - 7200, cards: 2, totalMsat: 5_000_000 };
        const at = await drive({ ...from, step: 'where', rebuild: { ...from.rebuild!, backup } }, t, (x) => x.step === 'retire');
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        old.ssh.when(/install\.sh retired$/, { code: 125, stderr: 'docker: error during connect' });
        let s = at;
        for (let i = 1; i <= RETIRE_TRIES_BEFORE_OVERRIDE; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: expect.stringContaining('error during connect') }, rebuild: { retireTries: i } });
        }
        expect(overrideOffered(s)).toBe(true);
        expect(overridePrompt(s)).toEqual({
          text: `${s.error!.message} Going on without the old server's final snapshot starts from the backup of ${timeText(T0 - 7200)}: anything on it after that is lost. The install's wipe still retires it.`,
          title: 'Go on without the final snapshot',
        });
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' }, backup: { name } } });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(s.notice).toBe(`The override went on without the old server's final snapshot. The rebuild goes on from the backup of ${timeText(T0 - 7200)}.`);
        expect(await drive(s, t)).toMatchObject({ step: 'done', vmId: OLD_VM });
        expect(old.ssh.ran(/install\.sh final-snapshot$/)).toBe(0);
        expect(old.ssh.ran(/install\.sh wipe$/)).toBe(1);
        expect(old.cardd.restored).toMatchObject({ kind: 'db', from: name.replace(/\.age$/, '') });
      });

      it('in place, never counts a final snapshot from a newer cardd as a failed attempt', async () => {
        const { t, old, s: from } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const at = await drive({ ...from, step: 'where' }, t, (x) => x.step === 'retire');
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60, { userVersion: CARDD_SCHEMA_VERSION + 1 }), t.keys.backupAgeRecipient), T0 - 60);
        let s = at;
        for (let i = 0; i < RETIRE_TRIES_BEFORE_OVERRIDE + 1; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'fatal' } });
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
        }
      });

      it('in place, waits while a recovery check runs on the server, at step 4 and at the install\'s wipe', async () => {
        const { t, old, s: from } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const at = await drive({ ...from, step: 'where' }, t, (x) => x.step === 'retire');
        old.ssh.when(/install\.sh recovery-check result$/, { code: 11, stderr: 'install.sh recovery-check: a check is running (…)\n' }, 2);
        let s = at;
        for (let i = 0; i < 2; i++) {
          s = await advance(s, t.deps);
          expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check' });
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
          expect(overrideOffered(s)).toBe(false);
        }
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' } } });
        old.ssh.when(/install\.sh wipe$/, { code: 11, stderr: 'install.sh wipe: a recovery check is running (…)\n' }, 1);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', waiting: 'recovery_check' });
        expect(s.error).toBeUndefined();
        expect(await drive(s, t)).toMatchObject({ step: 'done', vmId: OLD_VM });
        expect(old.ssh.ran(/install\.sh wipe$/)).toBe(2);
      });

      it('in place, never takes a due override while a recovery check runs on the server', async () => {
        const { t, old, s: from } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const at = await drive({ ...from, step: 'where' }, t, (x) => x.step === 'retire');
        old.ssh.when(/install\.sh recovery-check result$/, { code: 11, stderr: 'install.sh recovery-check: a check is running (…)\n' }, 1);
        const due: OnboardingState = { ...at, rebuild: { ...at.rebuild!, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE, confirm: { ...at.rebuild!.confirm, override: 'ssh' } } };
        let s = await advance(due, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check', rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(s.rebuild!.retire).toBeUndefined();
        s = await advance(s, t.deps); // the check has ended: a fresh attempt, with the final snapshot
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' } } });
      });

      it('in place on another paid VM, retires the old server for that one', async () => {
        const { t, old, s: at } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: 1013 }, confirm: { inPlace: true } });
        paidVm(t, 1013);
        let s = await advance({ ...at, step: 'where' }, t.deps);
        expect(s).toMatchObject({ step: 'boot', vmId: 1013, host: undefined });
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', vmId: 1013, host: { hostname: 'vm-1013.lnvps.cloud', keySource: 'lnvps' } });
        s = await advance(confirmed(s, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.cardd.retired?.replacedBy).toBe(1013);
      });

      it('refuses in place on a VM that isn\'t this phrase\'s paid one', async () => {
        const { t, s: at } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: 1013 }, confirm: { inPlace: true } });
        let s = await advance({ ...at, step: 'where' }, t.deps);
        expect(s).toMatchObject({ step: 'where', error: { kind: 'retry', message: "VM 1013 isn't a paid server of this recovery phrase: choose another, or a new one." } });
        paidVm(t, 1013);
        t.lnvps.expire(1013, '2026-09-30T00:00:00Z');
        s = await advance({ ...s, error: undefined }, t.deps);
        expect(s.error?.message).toContain('VM 1013 isn\'t a paid server');
      });

      // The real run goes back to the VM its first rebuild retired.
      it('rebuilds in place on a VM a rebuild retired, which is no longer passed over once chosen', async () => {
        const { t, old, s: from } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: 1013 }, confirm: { inPlace: true } });
        const y = another(t, 1013);
        y.cardd.retired = { at: '2026-09-01T00:00:00Z', replacedBy: OLD_VM };
        let s = await advance({ ...from, step: 'where', retiredVms: [1020, 1013] }, t.deps);
        expect(s).toMatchObject({ step: 'boot', vmId: 1013, retiredVms: [1020], rebuild: { target: { kind: 'in_place', vmId: 1013, retired: true } } });
        s = await drive(confirmed(s, { retire: true }), t);
        expect(s).toMatchObject({ step: 'done', vmId: 1013, retiredVms: [1020, OLD_VM] });
        expect(old.cardd.retired?.replacedBy).toBe(1013);
        expect(y.cardd.retired).toBeNull(); // the wipe took its marker
        expect(y.ssh.ran(/install\.sh wipe$/)).toBe(1);
      });

      // LNVPS starts a stopped one as step 4 does the old server, unless it may run a wallet beside the old server.
      it('in place on a VM LNVPS reports stopped, starts it if it is the old server\'s own or a rebuild retired it', async () => {
        const own = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        own.t.lnvps.stop(OLD_VM);
        let s = await advance({ ...own.s, step: 'where' }, own.t.deps);
        s = await advance(s, own.t.deps);
        expect(s).toMatchObject({ step: 'boot', waiting: 'boot' });
        expect(own.t.lnvps.vms.get(OLD_VM)!.status.state).toBe('running');
        expect(await advance(s, own.t.deps)).toMatchObject({ step: 'retire' });

        const retired = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: 1013 }, confirm: { inPlace: true } });
        another(retired.t, 1013).cardd.retired = { at: '2026-09-01T00:00:00Z', replacedBy: OLD_VM };
        retired.t.lnvps.stop(1013);
        s = await advance({ ...retired.s, step: 'where', retiredVms: [1013] }, retired.t.deps);
        s = await advance(s, retired.t.deps);
        expect(s).toMatchObject({ step: 'boot', waiting: 'boot' });
        expect(retired.t.lnvps.vms.get(1013)!.status.state).toBe('running');
      });

      it('in place on a stopped VM that may hold a live wallet, never starts it beside the old server, and says so', async () => {
        const { t, s: from } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: 1013 }, confirm: { inPlace: true } });
        another(t, 1013);
        t.lnvps.stop(1013);
        let s = await advance({ ...from, step: 'where' }, t.deps);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'boot', error: { kind: 'retry', message: expect.stringContaining('VM 1013 is stopped') } });
        expect(t.lnvps.vms.get(1013)!.status.state).toBe('stopped');
        expect(statusLine(s)).toContain("start it from LNVPS's site");
      });

      // A final snapshot the phone couldn't open says nothing about it: in place, the wipe would delete the old server's own copy.
      it('in place, tries again when the phone can\'t open the final snapshot it fetched, and only the override wipes without it', async () => {
        const { t, old, s: from } = await fromServerPage({ target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const name = await keep(t, summary(T0 - 7200));
        const backup: ChosenBackup = { kind: 'kept', name, created: T0 - 7200, cards: 2, totalMsat: 5_000_000 };
        const at = await drive({ ...from, step: 'where', rebuild: { ...from.rebuild!, backup } }, t, (x) => x.step === 'retire');
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        const inspect = t.deps.backups.inspect;
        t.deps.backups = {
          ...t.deps.backups,
          inspect: async (n) => {
            if (n !== name) throw new SnapshotUnreadable('out of memory');
            return inspect(n);
          },
        };
        let s = at;
        for (let i = 1; i <= RETIRE_TRIES_BEFORE_OVERRIDE; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({
            step: 'retire', error: { kind: 'retry', message: `${FINAL_NOT_FETCHED}: The backup couldn't be opened on this phone: out of memory.` }, rebuild: { retireTries: i },
          });
          expect(s.rebuild!.retire).toBeUndefined();
        }
        expect(overridePrompt(s).title).toBe('Go on without the final snapshot');
        s = await advance(confirmed({ ...s, error: undefined }, { override: overrideFor(s) }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'in_place' }, backup: { name } } });
        expect(old.ssh.ran(/install\.sh wipe$/)).toBe(0);
      });
    });

    describe('retire the old server', () => {
      it('keeps the choice when the final snapshot is no newer', async () => {
        const { t, old, s: at, name } = await atRetire();
        old.cardd.addSnapshot(sealSummary(summary(T0 - 7200), t.keys.backupAgeRecipient), T0 - 7200); // the one chosen
        const s = await advance(confirmed(at, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { name } } });
        expect(s.notice).toBeUndefined();
        expect(old.cardd.lastDownload).toBe(0); // the phone holds it already
      });

      it.each([
        [
          'makes no final snapshot',
          (old: OtherServer) => void (old.cardd.backupProblem = 'no backup key yet (meta backup.recipient)'),
          'The old server made no final snapshot: install.sh final-snapshot failed (exit 1): cardd: no snapshot: no backup key yet (meta backup.recipient).',
        ],
        [
          'serves a snapshot the phrase can\'t open',
          (old: OtherServer) => void old.cardd.addSnapshot(new Uint8Array([1, 2, 3]), T0 - 60),
          'The old server\'s final snapshot can\'t be opened with your recovery phrase.',
        ],
        // A final snapshot just made, but one no second try can fetch.
        [
          'encrypts its snapshots to another phrase',
          (old: OtherServer, t: World) => {
            finalOf(old, t);
            old.cardd.backupRecipient = `age1${'q'.repeat(58)}`;
          },
          'The old server\'s final snapshot couldn\'t be fetched: its snapshots aren\'t encrypted to your recovery phrase.',
        ],
        [
          'describes its snapshot oddly',
          (old: OtherServer, t: World) => {
            finalOf(old, t);
            old.cardd.backupInstallId = 'not-an-install-id';
          },
          'The old server\'s final snapshot couldn\'t be fetched: it described its snapshot oddly.',
        ],
        [
          'describes a snapshot too big',
          (old: OtherServer, t: World) => {
            finalOf(old, t);
            old.cardd.backupLatest!.size = MAX_SNAPSHOT_BYTES + 1;
          },
          `The old server's final snapshot couldn't be fetched: snapshot 1 is too big (${MAX_SNAPSHOT_BYTES + 1} bytes).`,
        ],
        [
          'serves a snapshot of no stated size',
          (old: OtherServer, t: World) => {
            finalOf(old, t);
            old.cardd.backupNoLength = true;
          },
          `The old server's final snapshot couldn't be fetched: snapshot 1 is of no stated bytes, over the ${MAX_SNAPSHOT_BYTES} allowed.`,
        ],
        [
          'revoked this phone',
          (old: OtherServer, t: World) => {
            finalOf(old, t);
            old.cardd.revoked.add(vectors.deviceAuth.keyId);
          },
          'The old server\'s final snapshot couldn\'t be fetched: deviceauth: unknown or revoked device.',
        ],
      ])('retires it all the same when it %s, and says so', async (_, spoil: (old: OtherServer, t: World) => void, why) => {
        const { t, old, s: at, name } = await atRetire();
        spoil(old, t);
        const s = await advance(confirmed(at, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { name } } });
        expect(s.notice).toBe(`${why} The rebuild goes on from the backup of ${timeText(T0 - 7200)}.`);
        expect(old.cardd.retired?.replacedBy).toBe(1001);
      });

      // A snapshot just made is there to be had: the old server's HTTPS failing, or a download cut short, is tried again.
      it.each([
        ['its HTTPS is down', (old: OtherServer) => void (old.httpsDown = true), 'fetch failed: connection refused by vm-1012.lnvps.cloud'],
        [
          'it serves a snapshot that isn\'t what it described',
          (old: OtherServer) => void old.cardd.snapshots.set(1, new Uint8Array(old.cardd.snapshots.get(1)!.length)),
          'snapshot 1 doesn\'t match what the server described',
        ],
        [
          'the download is cut off by its timer',
          (_old: OtherServer, t: World) => {
            const real = t.deps.oldCardd;
            t.deps.oldCardd = (host) => ({ backups: () => real(host).backups(), backupFile: () => Promise.reject(new Error('Aborted')) });
          },
          'Aborted',
        ],
        [
          'the phone can\'t store it',
          (_old: OtherServer, t: World) => {
            t.deps.backups.write = () => Promise.reject(new Error('ENOSPC: no space left on device'));
          },
          'ENOSPC: no space left on device',
        ],
        [
          'cardd couldn\'t make it this time',
          (old: OtherServer) => void old.ssh.when(/install\.sh final-snapshot$/, { code: 1, stderr: 'Error response from daemon: container cardd is restarting' }, 1),
          'it made none: install.sh final-snapshot failed (exit 1): Error response from daemon: container cardd is restarting',
        ],
      ])('tries again rather than retire it without the final snapshot it just made when %s', async (_, spoil: (old: OtherServer, t: World) => void, why) => {
        const { t, old, s: at, name } = await atRetire({ confirm: { retire: true } });
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        spoil(old, t);
        const s = await advance(at, t.deps);
        // An error, not a wait for the network: the SSH session shows the phone's is fine.
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: `${FINAL_NOT_FETCHED}: ${why}.` } });
        expect(s.waiting).toBeUndefined();
        expect(s.rebuild).toMatchObject({ retireTries: 1, backup: { name } });
        expect(s.rebuild!.retire).toBeUndefined();
        expect(old.cardd.retired).toBeNull();
      });

      it('after the final snapshot can\'t be fetched again and again, the override goes on without it and still retires the old server', async () => {
        const { t, old, s: at, name } = await atRetire({ confirm: { retire: true } });
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        old.httpsDown = true;
        let s = at;
        for (let i = 1; i <= RETIRE_TRIES_BEFORE_OVERRIDE; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { retireTries: i } });
        }
        expect(old.cardd.retired).toBeNull();
        expect(overrideOffered(s)).toBe(true);
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { name } } });
        expect(s.rebuild!.retire!.overSsh).toBeUndefined(); // the old server is retired: nothing for the check before up to let be
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(s.notice).toBe(
          `The old server's final snapshot couldn't be fetched: fetch failed: connection refused by vm-1012.lnvps.cloud. The rebuild goes on from the backup of ${timeText(T0 - 7200)}.`,
        );
        expect(old.cardd.retired?.replacedBy).toBe(1001);
      });

      // The override after fetches failed is used on the final snapshot: a retire that then fails asks for it again.
      it('asks for the override again when retiring fails after it went on without the final snapshot', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true }, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE, fetchFailed: true });
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        old.httpsDown = true;
        old.ssh.when(/install\.sh retire '1001'$/, { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
        let s = await advance(confirmed(at, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE + 1 } });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(s.rebuild!.fetchFailed).toBeUndefined();
        expect(overrideOffered(s)).toBe(true);
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override', overSsh: true } } });
      });

      // Without a final snapshot just made, nothing is lost by going on: the last resort is still reached.
      it('reaches the re-install with the old server\'s HTTPS down too', async () => {
        const { t, old, s: at, name } = await atRetire({ confirm: { retire: true } });
        old.ssh.unreachable = old.httpsDown = true;
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_vm_starting' });
        t.w.nowMs += OLD_VM_SSH_WAIT_MS;
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_reinstall', rebuild: { backup: { name } } });
        expect(s.error).toBeUndefined();
      });

      // Never installed, or re-installed through LNVPS: it holds no seed, so it can never run the wallet.
      it('records an old server that holds no Lightning wallet, with no final snapshot or retire', async () => {
        const { t, old, s: at, name } = await atRetire({ confirm: { retire: true } });
        old.cardd.seeded = false;
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'empty' }, backup: { name } } });
        expect(s.notice).toBe('VM 1012 holds no Lightning wallet: there is nothing on it to retire.');
        expect(s.retiredVms).toBeUndefined(); // still a paid VM to set up later
        expect(old.ssh.ran(/install\.sh (final-snapshot|retire '\d+')$/)).toBe(0);
        expect(old.cardd.lastDownload).toBe(0);
        expect(oldVmsToWatch(s)).toEqual([]);
        expect(await drive(s, t)).toMatchObject({ step: 'done', vmId: 1001 }); // LNVPS reports it running: it can't run the wallet
      });

      it('stops before retiring it when its final snapshot is from a newer cardd than the app carries', async () => {
        const { t, old, s: at } = await atRetire();
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60, { userVersion: CARDD_SCHEMA_VERSION + 1 }), t.keys.backupAgeRecipient), T0 - 60);
        const s = await advance(confirmed(at, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'fatal', message: expect.stringContaining('update the app first') } });
        expect(old.cardd.retired).toBeNull();
      });

      it('resumes after a cut once the marker is written, without a second snapshot or retire, the final snapshot still chosen', async () => {
        const { t, old, s: at } = await atRetire();
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        let cut = true;
        old.ssh.when(/install\.sh retired$/, () => {
          const m = old.cardd.retired;
          if (m && cut) {
            cut = false; // the connection drops just after the marker is written
            return { code: 255, stderr: 'connection reset' };
          }
          return m ? { stdout: `${m.at} ${m.replacedBy}\n` } : { code: 1 };
        });
        let s = await advance(confirmed(at, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { backupLocked: true, backup: { created: T0 - 60 } } });
        expect(s.rebuild!.retire).toBeUndefined();
        expect(withBackup(s, choice('other')).rebuild!.backup).toMatchObject({ created: T0 - 60 }); // step 1 is locked now
        s = await advance({ ...s, error: undefined }, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { created: T0 - 60 } } });
        expect(old.ssh.ran(/install\.sh final-snapshot$/)).toBe(1);
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(1);
      });

      it('says so when the old server still answers after retiring it', async () => {
        const { t, old, s: at } = await atRetire();
        // The marker is written, but compose down left everything running.
        let marked = false;
        old.ssh.when(/install\.sh retire '1001'$/, () => {
          marked = true;
          return { stdout: 'retired\n' };
        });
        old.ssh.when(/install\.sh retired$/, () => (marked ? { stdout: '2026-09-21T14:13:20Z 1001\n' } : { code: 1 }));
        const s = await advance(confirmed(at, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: 'The old server still answers at https://vm-1012.lnvps.cloud/health after it was retired: try again.' } });
        expect(s.rebuild!.retire).toBeUndefined();
      });

      it('on a new phone, reaches the old server by the address and key LNVPS publishes for it', async () => {
        const { t, old, s: at } = await atRetire({ oldVm: { id: OLD_VM }, confirm: { retire: true } });
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.ssh.connects[0]).toMatchObject({ host: OLD_HOST.ipv4, user: 'debian', hostKey: OLD_HOST.hostKey });
        expect(old.cardd.retired?.replacedBy).toBe(1001);
      });

      it('reaches an old server whose first-use key LNVPS now contradicts by the key LNVPS publishes', async () => {
        const firstUse: ServerHost = { ...OLD_HOST, hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIfirstuse' }, keySource: 'first_use' };
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } }, firstUse);
        old.ssh.serverKey = OLD_HOST.hostKey; // the key LNVPS publishes for VM 1012
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.ssh.connects.map((c) => c.hostKey)).toEqual([OLD_HOST.hostKey]);
      });

      // Going back within the hour LNVPS takes to list a new server's key (the real run, 2026-10-07).
      it('reaches an old server by the key trusted on first use while LNVPS lists none', async () => {
        const firstUse: ServerHost = { ...OLD_HOST, hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIfirstuse' }, keySource: 'first_use' };
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } }, firstUse);
        t.lnvps.publishHostKeys(OLD_VM, []);
        old.ssh.serverKey = firstUse.hostKey;
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.ssh.connects.map((c) => c.hostKey)).toEqual([firstUse.hostKey]);
        expect(old.cardd.retired?.replacedBy).toBe(1001);
      });

      it('reaches an old server by the key trusted on first use while LNVPS can\'t be reached', async () => {
        const firstUse: ServerHost = { ...OLD_HOST, keySource: 'first_use' };
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } }, firstUse);
        const real = t.deps.lnvps.getVm.bind(t.deps.lnvps);
        t.deps.lnvps.getVm = async (id) => {
          if (id === OLD_VM) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
          return real(id);
        };
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.ssh.connects.map((c) => c.hostKey)).toEqual([OLD_HOST.hostKey]);
        // And with SSH down too, it waits for LNVPS as before.
        const again = await atRetire({ confirm: { retire: true } }, firstUse);
        again.old.ssh.unreachable = again.old.httpsDown = true;
        const real2 = again.t.deps.lnvps.getVm.bind(again.t.deps.lnvps);
        again.t.deps.lnvps.getVm = async (id) => {
          if (id === OLD_VM) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
          return real2(id);
        };
        s = await advance(again.s, again.t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_unreachable' });
      });

      it('reaches an old server by the key trusted on first use when LNVPS lists the same one', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } }, { ...OLD_HOST, keySource: 'first_use' });
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.ssh.connects.map((c) => c.hostKey)).toEqual([OLD_HOST.hostKey]);
      });

      it('records it gone when LNVPS deleted it', async () => {
        const { t, old, s: at } = await atRetire();
        old.ssh.unreachable = old.httpsDown = true;
        t.lnvps.deleteVm(OLD_VM);
        expect(await advance(at, t.deps)).toMatchObject({ step: 'install', rebuild: { retire: { result: 'gone', at: t.w.nowMs } } });
      });

      it('records it expired when the person won\'t pay it, says not to pay it, and never starts it', async () => {
        const { t, old, s: at } = await atRetire();
        old.ssh.unreachable = old.httpsDown = true;
        t.lnvps.expire(OLD_VM, '2026-09-30T00:00:00Z');
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_expired' });
        expect(s.rebuild!.retire).toBeUndefined();
        s = await advance(confirmed(s, { expired: true }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'expired', deletingOn: '2026-09-30T00:00:00Z' } } });
        expect(s.notice).toBe('VM 1012 has expired, and LNVPS deletes it on 2026-09-30. Don\'t pay for it: a payment starts it again, beside the new server.');
        expect(t.lnvps.http.requests.filter((r) => /\/vm\/1012\/(start|re-install)$|lnurlp\/1012$/.test(r.url))).toEqual([]);
      });

      // It still holds the seed; a day paid lets it be retired over SSH.
      it('pays a day for an expired one when the person chooses to, then retires it properly', async () => {
        const { t, old, s: at } = await atRetire();
        old.ssh.unreachable = old.httpsDown = true;
        t.lnvps.expire(OLD_VM, '2026-09-30T00:00:00Z');
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ waiting: 'confirm_expired' });
        s = await advance(confirmed(s, { payOld: true }), t.deps);
        // One day at 6,863 sat per 31 days, through the old VM's Lightning address.
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_payment', rebuild: { oldInvoice: { sat: 222 } } });
        const first = s.rebuild!.oldInvoice!;
        expect(t.lnvps.invoices.filter((i) => i.vmId === OLD_VM).map((i) => [i.msat, i.pr])).toEqual([[222_000n, first.bolt11]]);
        s = await advance(s, t.deps);
        expect(s.rebuild!.oldInvoice).toEqual(first); // still fresh
        t.w.nowMs = first.expiresAt - INVOICE_RENEW_BEFORE_MS + 1;
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ waiting: 'old_payment' });
        expect(s.rebuild!.oldInvoice!.bolt11).not.toBe(first.bolt11); // renewed a minute before it expires
        // Paid: LNVPS reports it paid ahead, and step 4 goes on as for a stopped one.
        t.lnvps.vms.get(OLD_VM)!.expires = '2026-11-02T12:00:00Z';
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_retire' });
        s = await advance(confirmed(s, { retire: true }), t.deps);
        expect(s).toMatchObject({ waiting: 'old_vm_starting' });
        expect(t.lnvps.vms.get(OLD_VM)!.status.state).toBe('running');
        old.ssh.unreachable = old.httpsDown = false;
        old.cardd.addSnapshot(sealSummary(summary(T0 + 30), t.keys.backupAgeRecipient), T0 + 30);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { created: T0 + 30 } } });
        expect(s.rebuild!.oldInvoice).toBeUndefined();
        expect(old.cardd.retired?.replacedBy).toBe(1001);
      });

      it('says to wait or pay a day for an expired one LNVPS still runs, and refuses before up while it runs', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { expired: true } });
        old.ssh.unreachable = old.httpsDown = true;
        t.lnvps.expire(OLD_VM, '2026-09-30T00:00:00Z');
        t.lnvps.vms.get(OLD_VM)!.status = { state: 'running' };
        const said = 'LNVPS reports VM 1012 running though it has expired: wait for LNVPS to stop it, or pay a day so it can be retired properly.';
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'expired' } }, notice: said });
        s = await drive(s, t);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: said } });
        expect(s.rebuild!.confirm!.expired).toBeUndefined(); // step 4 asks again
      });

      it('starts a stopped one through LNVPS once confirmed, and retires it over SSH when it answers', async () => {
        const { t, old, s: at } = await atRetire();
        old.ssh.unreachable = old.httpsDown = true;
        t.lnvps.stop(OLD_VM);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_retire' });
        expect(t.lnvps.vms.get(OLD_VM)!.status.state).toBe('stopped');
        s = await advance(confirmed(s, { retire: true }), t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_vm_starting', rebuild: { reachingSince: t.w.nowMs } });
        expect(t.lnvps.vms.get(OLD_VM)!.status.state).toBe('running');
        t.w.nowMs += 60_000;
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_vm_starting', rebuild: { reachingSince: t.w.nowMs - 60_000 } });
        old.ssh.unreachable = old.httpsDown = false; // it has booted
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.cardd.retired?.replacedBy).toBe(1001);
      });

      it('re-installs one that never answers SSH, as the last resort, after fetching its latest snapshot and a second confirmation', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.unreachable = true; // its sshd is broken; cardd still serves its snapshots
        old.cardd.addSnapshot(sealSummary(summary(T0 + 30), t.keys.backupAgeRecipient), T0 + 30);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_vm_starting', rebuild: { reachingSince: t.w.nowMs } });
        t.w.nowMs += OLD_VM_SSH_WAIT_MS - 1000;
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ waiting: 'old_vm_starting' });
        t.w.nowMs += 1000;
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_reinstall', rebuild: { backup: { created: T0 + 30 }, backupLocked: true } });
        expect(s.notice).toBe(`VM 1012 still doesn't answer over SSH. The last resort is re-installing it through LNVPS, which wipes its disk: anything on it after the backup of ${timeText(T0 + 30)} is lost.`);
        expect(t.lnvps.reinstalled).toEqual([]);
        s = await advance(confirmed(s, { reinstall: true }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'reinstalled' } } });
        expect(s.notice).toBe(`VM 1012 was re-installed through LNVPS: anything on it after the backup of ${timeText(T0 + 30)} is lost.`);
        expect(t.lnvps.reinstalled).toEqual([OLD_VM]);
      });

      it('records it expired when LNVPS refuses to re-install it for that', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true, reinstall: true }, reachingSince: 1 });
        old.ssh.unreachable = old.httpsDown = true;
        t.deps.lnvps.reinstallVm = async () => {
          throw new LnvpsError(402, 'VM is expired, renew it first');
        };
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'expired' } } });
        // LNVPS still reports it running.
        expect(s.notice).toBe('LNVPS reports VM 1012 running though it has expired: wait for LNVPS to stop it, or pay a day so it can be retired properly.');
      });

      it('waits while LNVPS can\'t be reached, and goes on blind only when the person types so', async () => {
        const { t, old, s: at } = await atRetire();
        old.ssh.unreachable = old.httpsDown = true;
        const real = t.deps.lnvps.getVm.bind(t.deps.lnvps);
        t.deps.lnvps.getVm = async (id) => {
          if (id === OLD_VM) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
          return real(id);
        };
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_unreachable' });
        expect(s.error).toBeUndefined();
        expect(overrideFor(s)).toBe('unreachable');
        s = await advance(confirmed(s, { override: 'unreachable' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override' } } });
      });

      // After the login a drop is waited out and the attempt it
      // cut is not counted; an iPhone locked while the snapshot is fetched must not earn the override.
      it('waits out a drop after the login, the attempt it cut not counted, and then retires the old server', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.drop(/install\.sh retire '1001'$/);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'reconnect', drops: { n: 1, during: 'command', last: 'Broken pipe' } });
        expect([s.error, s.rebuild!.retireTries ?? 0, overrideOffered(s)]).toEqual([undefined, 0, false]);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, retireTries: 1 } });
        expect(s.drops).toBeUndefined();
      });

      it('waits out a drop under each thing step 4 does over SSH', async () => {
        for (const cut of [/sha256sum --quiet/, /install\.sh retired$/, /install\.sh final-snapshot$/, /install\.sh retire '1001'$/]) {
          const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
          old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
          old.ssh.drop(cut);
          const s = await advance(at, t.deps);
          expect(s).toMatchObject({ step: 'retire', waiting: 'reconnect', drops: { n: 1 } });
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
          expect(await drive(s, t, (x) => x.step === 'install')).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        }
      });

      it('counts the fourth drop in a row as one failed attempt, shown as an attempt\'s failure is', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.drop(/install\.sh retire '1001'$/, 4);
        let s = at;
        for (let n = 1; n <= 3; n++) {
          s = await advance(s, t.deps);
          expect(s).toMatchObject({ waiting: 'reconnect', drops: { n } });
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
        }
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: 'Broken pipe' }, rebuild: { retireTries: 1 } });
        expect([s.waiting, s.drops, overrideOffered(s)]).toEqual([undefined, undefined, false]);
      });

      // The fourth under the snapshot is a snapshot not made, with the words and the note that has today.
      it('counts the fourth drop under the final snapshot as a snapshot that could not be made', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.drop(/install\.sh final-snapshot$/, 4);
        let s = at;
        for (let n = 1; n <= 3; n++) s = await advance(s, t.deps);
        expect(s).toMatchObject({ waiting: 'reconnect', drops: { n: 3 } });
        expect([s.rebuild!.retireTries ?? 0, s.rebuild!.fetchFailed]).toEqual([0, undefined]);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: `${FINAL_NOT_FETCHED}: it made none: Broken pipe.` }, rebuild: { retireTries: 1, fetchFailed: true } });
      });

      // An old server that truly cannot hold a connection: three such stops, and the override is offered as before.
      it('still reaches the override for an old server that never holds a connection', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.drop(/install\.sh retire '1001'$/, 99);
        let s = at;
        for (let stop = 1; stop <= RETIRE_TRIES_BEFORE_OVERRIDE; stop++) {
          s = await drive({ ...s, error: undefined }, t);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { retireTries: stop } });
        }
        expect(overrideOffered(s)).toBe(true);
      });

      it('leaves an override confirmed too soon as it was when the attempt that would spend it is cut', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true }, retireTries: 1 });
        old.ssh.drop(/install\.sh retire '1001'$/);
        const s = await advance(confirmed(at, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ waiting: 'reconnect', rebuild: { retireTries: 1, confirm: { override: 'ssh' } } });
      });

      // Found by the security check of the scratch code: the wait must be built on what the attempt had saved. The
      // final snapshot it fetched replaces the backup chosen in step 1; a wait built on the state from before the
      // attempt would put the older backup back, and with the old server retired meanwhile nothing would fetch
      // the newer one again: the install would restore the older backup, and the balances with it.
      it('keeps the final snapshot an attempt had fetched when a drop cuts the attempt after it', async () => {
        for (const cut of [{ after: true }, { skip: 0 }]) {
          const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
          old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
          // The server retires, and the connection goes before its answer comes (after), or before it is asked at all.
          old.ssh.drop(/install\.sh retire '1001'$/, 1, cut);
          let s = await advance(at, t.deps);
          expect(s).toMatchObject({ step: 'retire', waiting: 'reconnect', rebuild: { backup: { created: T0 - 60 }, backupLocked: true } });
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
          s = await drive(s, t, (x) => x.step === 'install');
          expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { created: T0 - 60 } } });
        }
      });

      // Two things step 4 asks the old server outside an attempt's own try.
      it('waits out a drop under the look for the retired marker after retiring, and finds the server retired when it is back', async () => {
        const clean = await atRetire({ confirm: { retire: true } });
        await advance(clean.s, clean.t.deps);
        const looks = clean.old.ssh.ran(/install\.sh retired$/);
        expect(looks).toBeGreaterThan(1);
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.drop(/install\.sh retired$/, 1, { skip: looks - 1 });
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'reconnect', drops: { n: 1 } });
        expect([s.error, s.rebuild!.retireTries ?? 0, old.ssh.ran(/install\.sh retire '1001'$/)]).toEqual([undefined, 0, 1]);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(1);
      });

      it('waits out a drop under the override\'s look for a recovery check, the override still confirmed', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true, override: 'ssh' }, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE });
        old.ssh.drop(/install\.sh recovery-check result$/);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'reconnect', drops: { n: 1 }, rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE, confirm: { override: 'ssh' } } });
        expect(s.error).toBeUndefined();
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override' } } });
      });

      it('in place, waits out a drop the same way', async () => {
        const { t, old, s: from } = await fromServerPage({ target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        const name = await keep(t, summary(T0 - 7200));
        const backup: ChosenBackup = { kind: 'kept', name, created: T0 - 7200, cards: 2, totalMsat: 5_000_000 };
        const at = await drive({ ...from, step: 'where', rebuild: { ...from.rebuild!, backup } }, t, (x) => x.step === 'retire');
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        old.ssh.drop(/install\.sh retired$/);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'reconnect', drops: { n: 1 } });
        expect(s.rebuild!.retireTries ?? 0).toBe(0);
        s = await drive(s, t, (x) => x.step === 'install');
        expect(s).toMatchObject({ step: 'install', rebuild: { retireTries: 1 } });
      });

      // Docker broken on the old VM, say.
      it('offers the override when retiring keeps failing while SSH answers, and the check before up honours it', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.when(/install\.sh retire '1001'$/, { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { retireTries: 1 } });
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps); // too soon: it tries again
        expect(s).toMatchObject({ error: { kind: 'retry' }, rebuild: { retireTries: 2 } });
        expect(s.rebuild!.confirm!.override).toBeUndefined(); // typed too soon, then the old server answered: spent
        s = await advance({ ...s, error: undefined }, t.deps);
        expect(s).toMatchObject({ error: { kind: 'retry' }, rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } });
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(3);
        expect(overrideOffered(s)).toBe(true);
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override', overSsh: true } } });
        expect(s.rebuild!.confirm!.override).toBeUndefined(); // used once
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(3);
        // LNVPS still reports it running: the person accepted that.
        expect(await drive(s, t)).toMatchObject({ step: 'done', vmId: 1001 });
      });

      // Confirmed while neither the old server nor LNVPS answered: three failures over SSH before that don't make it an override of retiring.
      it('takes an override only for what it was typed for: one typed while nothing answered costs a fresh attempt over SSH', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true, override: 'unreachable' }, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE });
        old.ssh.when(/install\.sh retire '1001'$/, { code: 1, stderr: 'Cannot connect to the Docker daemon' }, 1);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE + 1 } });
        expect(s.rebuild!.retire).toBeUndefined();
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(1);
        expect(overrideOffered(s)).toBe(true);
        expect(overrideFor(s)).toBe('ssh');
        s = await advance(confirmed({ ...s, error: undefined }, { override: overrideFor(s) }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override', overSsh: true } } });
      });

      it('drops an override typed for retiring over SSH once nothing answers, and waits for one typed for that', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true, override: 'ssh' }, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE });
        old.ssh.unreachable = old.httpsDown = true;
        const real = t.deps.lnvps.getVm.bind(t.deps.lnvps);
        t.deps.lnvps.getVm = async (id) => {
          if (id === OLD_VM) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
          return real(id);
        };
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'old_unreachable' });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(s.rebuild!.retire).toBeUndefined();
        s = await advance(confirmed(s, { override: overrideFor(s) }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override' } } });
        expect(s.rebuild!.retire!.overSsh).toBeUndefined();
      });

      // install.sh recovery-check stops cardd and starts the old server's phoenixd again when it ends: step 4 waits for it.
      const CHECK_RUNNING = { code: 11, stderr: 'install.sh recovery-check: a check is running (from 20261007T000000Z, started): …\n' };

      it('waits while a recovery check runs on the old server: never an attempt, never the override; then retires it', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.when(/install\.sh recovery-check result$/, CHECK_RUNNING, RETIRE_TRIES_BEFORE_OVERRIDE + 2);
        let s = at;
        for (let i = 0; i < RETIRE_TRIES_BEFORE_OVERRIDE + 2; i++) {
          s = await advance(s, t.deps);
          expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check' });
          expect(s.error).toBeUndefined();
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
          expect(overrideOffered(s)).toBe(false);
        }
        expect(old.ssh.ran(/install\.sh (final-snapshot|retire '1001')$/)).toBe(0);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(old.cardd.retired?.replacedBy).toBe(1001);
        expect(s.checkSince).toBeUndefined(); // the wait's clock, cleared once the check ended
      });

      // A hung check (a wedged Docker daemon, say) holds install.sh's lock for good: the wait has a bound.
      it('shows how long it has waited, and after the bound gives an error with a way on, then step 4\'s usual rules', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.when(/install\.sh recovery-check result$/, CHECK_RUNNING);
        const t0 = t.w.nowMs;
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check', checkSince: t0 });
        t.w.nowMs += 5 * 60_000;
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ waiting: 'recovery_check', checkSince: t0 });
        expect(statusLine(s, t.w.nowMs)).toBe(
          'The old server is busy with a recovery check or another install step: waiting for it to finish (up to 15 minutes)… 5 min so far.');
        expect(s.rebuild!.retireTries ?? 0).toBe(0);
        t.w.nowMs = t0 + RECOVERY_CHECK_WAIT_MS;
        s = await advance(s, t.deps);
        expect(s.waiting).toBeUndefined();
        expect(s).toMatchObject({ step: 'retire', checkSince: t0, rebuild: { retireTries: 1 } });
        expect(s.error).toEqual({
          kind: 'retry',
          message: "The recovery check on the old server hasn't ended after 20 minutes. Restart VM 1012 from LNVPS's site: that stops the check, " +
            "and the old server finishes it when it next starts. Then try again.",
        });
        for (let i = 2; i <= RETIRE_TRIES_BEFORE_OVERRIDE; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ error: { kind: 'retry' }, rebuild: { retireTries: i } });
        }
        expect(overrideOffered(s)).toBe(true);
        old.ssh.when(/install\.sh recovery-check result$/, { code: 0 }); // the VM restarted: the check is over
        s = await advance({ ...s, error: undefined }, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
        expect(s.checkSince).toBeUndefined();
      });

      it('never counts a failure caused by a check that started during the attempt', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.when(/install\.sh recovery-check result$/, CHECK_RUNNING).when(/install\.sh recovery-check result$/, { code: 0 }, 1);
        old.ssh.when(/install\.sh final-snapshot$/, { code: 1, stderr: 'service "cardd" is not running' });
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check' });
        expect(s.error).toBeUndefined();
        expect(s.rebuild!.retireTries ?? 0).toBe(0);
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(0);
      });

      it('waits when the retire finds a check started since (exit 11), without counting it', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.ssh.when(/install\.sh retire '1001'$/, { code: 11, stderr: 'install.sh retire: a recovery check is running (…)\n' }, 1);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check' });
        expect(s.rebuild!.retireTries ?? 0).toBe(0);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } } });
      });

      // The failures that earned it may have been the check's own: after the wait, a fresh attempt must fail first.
      it('drops a typed override while a recovery check runs there, and offers it again only after a fresh failure', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true, override: 'ssh' }, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE });
        old.ssh.when(/install\.sh recovery-check result$/, CHECK_RUNNING, 1);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check', rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(overrideOffered(s)).toBe(false);
        old.ssh.when(/install\.sh retire '1001'$/, { code: 1, stderr: 'Cannot connect to the Docker daemon' }, 1);
        s = await advance(s, t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE + 1 } });
        expect(overrideOffered(s)).toBe(true);
        s = await advance(confirmed({ ...s, error: undefined }, { override: 'ssh' }), t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'override', overSsh: true } } });
      });

      it('drops an override typed for a final snapshot that could not be fetched, while a check runs', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true, override: 'ssh' }, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE, fetchFailed: true });
        old.ssh.when(/install\.sh recovery-check result$/, CHECK_RUNNING, 1);
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'recovery_check', rebuild: { retireTries: RETIRE_TRIES_BEFORE_OVERRIDE, fetchFailed: true } });
        expect(s.rebuild!.confirm!.override).toBeUndefined();
        expect(old.ssh.ran(/install\.sh (final-snapshot|retire '1001')$/)).toBe(0);
      });

      // A snapshot of a newer schema says nothing about the old server: it never counts toward the override.
      it('does not count a newer final snapshot as a failed attempt, however often it is run again', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60, { userVersion: CARDD_SCHEMA_VERSION + 1 }), t.keys.backupAgeRecipient), T0 - 60);
        let s = at;
        for (let i = 0; i < RETIRE_TRIES_BEFORE_OVERRIDE + 2; i++) {
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'fatal' } });
          expect(s.rebuild!.retireTries ?? 0).toBe(0);
          expect(overrideOffered(s)).toBe(false);
        }
        expect(old.ssh.ran(/install\.sh retire '1001'$/)).toBe(0); // never retired, and never counted
      });

      it('never offers the override for a backup made by a newer server, however many attempts failed before', () => {
        const at = startRebuild({ ...initialState('GBR'), vmId: OLD_VM }, 'server_page');
        const s: OnboardingState = { ...at, step: 'retire', rebuild: { ...at.rebuild!, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } };
        expect(overrideOffered({ ...s, error: { kind: 'retry', message: 'install.sh retire failed' } })).toBe(true);
        expect(overrideOffered({ ...s, error: { kind: 'fatal', message: `${NEWER_BACKUP} of the server than this app carries: update the app first.` } })).toBe(false);
      });

      it('says what the override gives up: the retire, or once the final snapshot couldn\'t be had, that snapshot', () => {
        const at = startRebuild({ ...initialState('GBR'), vmId: OLD_VM }, 'server_page');
        const kept: ChosenBackup = { kind: 'kept', name: 'x', created: T0 - 7200, cards: 2, totalMsat: 5_000_000 };
        const s: OnboardingState = { ...at, step: 'retire', rebuild: { ...at.rebuild!, backup: kept, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } };
        const fetchFailed = `${FINAL_NOT_FETCHED}: fetch failed: connection refused by vm-1012.lnvps.cloud.`;
        expect(overridePrompt({ ...s, error: { kind: 'retry', message: fetchFailed } })).toEqual({
          text: `${fetchFailed} Going on without it starts from the backup of ${timeText(T0 - 7200)}: anything on the old server after that is lost. The old server is still retired.`,
          title: 'Go on without the final snapshot',
        });
        const phraseOnly = { ...s, rebuild: { ...s.rebuild!, backup: { kind: 'phrase_only' as const } }, error: { kind: 'retry' as const, message: fetchFailed } };
        expect(overridePrompt(phraseOnly).text).toContain('Going on without it starts from the phrase alone');
        expect(overridePrompt({ ...s, error: { kind: 'retry', message: 'install.sh retire failed (exit 1): Docker' } })).toEqual({
          text: "Going on with the old server not retired (install.sh retire failed (exit 1): Docker) risks two Lightning wallets on one seed, which can close the channel. Go on only if you know it can't run.",
          title: 'Go on without retiring it',
        });
        expect(overridePrompt({ ...s, waiting: 'old_unreachable' }).text).toMatch(/^Going on without knowing what the old server does risks two Lightning wallets/);
      });

      // An old server set up before this app: its install.sh has none of a rebuild's commands.
      it('uploads the app\'s own install.sh to the old server before asking it anything', async () => {
        const { t, old, s: at } = await atRetire({ confirm: { retire: true } });
        const usage = { code: 2, stderr: 'usage: install.sh upload|system|prepare|seed|issuer-key|up|meta\n' };
        old.ssh.when(/install\.sh (retired|final-snapshot|retire '\d+')$/, () => (old.ssh.files.has('card-app/install.sh') ? undefined : usage));
        old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { created: T0 - 60 } } });
        expect(old.ssh.files.get('card-app/install.sh')).toEqual({ data: new Uint8Array([1]), mode: 0o755 });
        const ran = old.ssh.commands.map((c) => c.command);
        expect(ran.slice(0, 4)).toEqual(['mkdir -p card-app', 'cd card-app && sha256sum -c - 2>/dev/null', "cd card-app && chmod 755 'install.sh'", 'cd card-app && sha256sum --quiet -c -']);
        expect(old.ssh.commands[1].stdin).toBe(`${'aa'.repeat(32)}  install.sh\n`);
      });

      // A new phone isn't paired with the old server: it pairs before fetching the final snapshot.
      describe('from a new phone', () => {
        const newPhone = { source: 'new_phone' as const, before: undefined, oldVm: { id: OLD_VM }, confirm: { retire: true } };

        it('pairs with the old server, then fetches its final snapshot', async () => {
          const { t, old, s: at } = await atRetire(newPhone);
          old.cardd.devices.delete(vectors.deviceAuth.keyId);
          old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
          const s = await advance(at, t.deps);
          expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { created: T0 - 60 } } });
          expect(old.cardd.devices.get(vectors.deviceAuth.keyId)).toBe(vectors.deviceAuth.publicKey);
          const ran = old.ssh.commands.map((c) => c.command);
          expect(ran.findIndex((c) => /cardd-ctl device add/.test(c))).toBeLessThan(ran.findIndex((c) => /final-snapshot$/.test(c)));
        });

        it('retires it without its final snapshot when it revoked this phone, and says so', async () => {
          const { t, old, s: at, name } = await atRetire(newPhone);
          old.cardd.devices.delete(vectors.deviceAuth.keyId);
          old.cardd.revoked.add(vectors.deviceAuth.keyId);
          old.cardd.addSnapshot(sealSummary(summary(T0 - 60), t.keys.backupAgeRecipient), T0 - 60);
          const s = await advance(at, t.deps);
          expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { name } } });
          expect(s.notice).toBe(`The old server revoked this phone's key, so its final snapshot can't be fetched. The rebuild goes on from the backup of ${timeText(T0 - 7200)}.`);
          expect(old.ssh.ran(/final-snapshot$/)).toBe(0);
          expect(old.cardd.lastDownload).toBe(0);
        });
      });
    });

    // The look before up sends a rebuild whose backup is restored already back to step 4.
    describe('back at step 4 after the restore', () => {
      const WIPE = /install\.sh wipe$/;
      const RESTORE = /install\.sh restore /;
      const newer = (t: World) => sealSummary(summary(T0 - 60, { cards: 3 }), t.keys.backupAgeRecipient);
      const final = snapshotName(OLD_INSTALL, 1, T0 - 60);

      /**
       * Step 4 left the old server expired; the install restored the backup chosen, then refused up while
       * LNVPS reports the old server running: step 4 again, confirmed. decrypts: the backups the install decrypted.
       */
      async function backFromUp() {
        const f = await atRetire({ retire: { result: 'expired', at: 1 } });
        let decrypts = 0;
        const read = f.t.deps.backups.read;
        f.t.deps.backups.read = async (name) => {
          decrypts++;
          return read(name);
        };
        const s = await drive(f.s, f.t);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: expect.stringContaining('old server is running again') } });
        expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore']);
        expect(f.t.cardd.restored).toMatchObject({ kind: 'db', from: f.name.replace(/\.age$/, '') });
        return { ...f, s: confirmed({ ...s, error: undefined }, { retire: true }), decrypts: () => decrypts };
      }

      it('restores nothing again when the old server\'s final snapshot is no newer', async () => {
        const { t, old, s: at, name, decrypts } = await backFromUp();
        old.cardd.addSnapshot(sealSummary(summary(T0 - 7200), t.keys.backupAgeRecipient), T0 - 7200); // the one chosen
        const s = await drive(at, t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001, rebuild: { retire: { result: 'retired' }, backup: { name } } });
        expect(s.rebuild!.rewipe).toBeUndefined();
        expect(t.ssh.ran(WIPE)).toBe(0);
        expect(t.ssh.ran(RESTORE)).toBe(1);
        expect(decrypts()).toBe(1);
      });

      // cardd restores only where no database is: a new VM is wiped too, before cardd ever started there.
      it('restores a newer final snapshot in place of the one restored, after a wipe, once, cut or not', async () => {
        const { t, old, s: at, decrypts } = await backFromUp();
        old.cardd.addSnapshot(newer(t), T0 - 60);
        let s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' }, backup: { name: final }, rewipe: true } });
        expect(s.installed).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key']); // the seed and the card key stay through a wipe
        const before = t.ssh.commands.length;
        t.ssh.when(/install\.sh up$/, { code: 1, stderr: 'dependency failed to start' }, 1);
        s = await drive(s, t);
        expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
        s = await drive({ ...s, error: undefined }, t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001 });
        const ran = t.ssh.commands.slice(before).map((c) => c.command);
        expect(ran.filter((c) => WIPE.test(c))).toHaveLength(1);
        expect(ran.filter((c) => RESTORE.test(c))).toHaveLength(1);
        expect(ran.findIndex((c) => WIPE.test(c))).toBeLessThan(ran.findIndex((c) => RESTORE.test(c)));
        expect(ran.filter((c) => /install\.sh (seed|issuer-key)$/.test(c))).toEqual([]);
        expect(t.cardd.restored).toMatchObject({ kind: 'db', from: final.replace(/\.age$/, '') });
        expect(decrypts()).toBe(2);
      });

      // up may have started the services: the wipe stops them, and phoenixd starts again from its seed.
      it('restores a newer final snapshot after a cut once up had run but before that was saved', async () => {
        const { t, old, s: at } = await atRetire({ retire: { result: 'expired', at: 1 } });
        t.lnvps.stop(OLD_VM); // so the look before up lets the new server start
        expect(await advance(await advance(at, t.deps), t.deps)).toMatchObject({ step: 'pair' });
        // The app was killed once up had run: the last state saved is the one before it.
        const saved = t.checkpoints.filter((x) => x.step === 'install' && !x.installed.includes('up')).at(-1)!;
        expect(saved.installed.at(-1)).toBe('restore');
        t.lnvps.vms.get(OLD_VM)!.status = { state: 'running' }; // and LNVPS started the old server again
        let s = await advance(saved, t.deps);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' } });
        old.cardd.addSnapshot(newer(t), T0 - 60);
        const before = t.ssh.commands.length;
        s = await drive(confirmed({ ...s, error: undefined }, { retire: true }), t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001, rebuild: { backup: { name: final } } });
        const ran = t.ssh.commands.slice(before).map((c) => c.command);
        const pos = (re: RegExp) => ran.findIndex((c) => re.test(c));
        expect(ran.filter((c) => WIPE.test(c))).toHaveLength(1);
        expect(pos(WIPE)).toBeLessThan(pos(RESTORE));
        expect(pos(RESTORE)).toBeLessThan(pos(/install\.sh up$/));
        expect(t.cardd.restored).toMatchObject({ kind: 'db', from: final.replace(/\.age$/, '') });
      });
    });

    // One phoenixd per seed, whatever else the phrase has (a test VM, a cancelled rebuild's).
    describe('every other VM of the phrase, just before up', () => {
      const UP = /install\.sh up$/;
      const RETIRED = /install\.sh retired$/;
      const BEFORE_UP = ['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore'];

      /** Step 4 retired VM 1012 over SSH, so the rebuild onto VM 1001 is at the install. */
      async function installing() {
        const f = await atRetire({ confirm: { retire: true } });
        const s = await advance(f.s, f.t.deps);
        expect(s).toMatchObject({ step: 'install', rebuild: { retire: { result: 'retired' } }, retiredVms: [OLD_VM] });
        return { ...f, s };
      }

      const refused = (id: number, why: string) => `VM ${id} ${why}: retire it before the new one starts.`;

      // (a) A VM the backup doesn't name, or (b) one phrase only passed over, still runs the wallet.
      it('refuses up while another VM runs the wallet unretired, then step 4 retires that one too', async () => {
        const { t, old, s: at } = await installing();
        const y = another(t, 1013);
        y.cardd.addSnapshot(sealSummary(summary(T0 - 60, { vmId: '1013' }), t.keys.backupAgeRecipient), T0 - 60);
        let s = await drive(at, t);
        expect(s).toMatchObject({
          step: 'retire',
          error: { kind: 'retry', message: refused(1013, 'is running with a wallet on this phrase and was never retired') },
          rebuild: { oldVm: { id: 1013 }, others: [{ id: OLD_VM, result: 'retired' }] },
        });
        sinceDropped(s, t);
        expect(s.rebuild!.retire).toBeUndefined();
        expect(s.rebuild!.oldVm!.host).toBeUndefined(); // reached by what LNVPS publishes
        expect(s.installed).toEqual(BEFORE_UP);
        expect(t.ssh.ran(UP)).toBe(0);
        expect(y.cardd.retired).toBeNull(); // looked at, nothing more
        s = await advance({ ...s, error: undefined }, t.deps);
        expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_retire' });
        const probedOld = old.ssh.ran(RETIRED);
        s = await drive(confirmed(s, { retire: true }), t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001, retiredVms: [OLD_VM, 1013], rebuild: { retire: { result: 'retired' }, backup: { created: T0 - 60 } } });
        expect(y.cardd.retired?.replacedBy).toBe(1001);
        // Its final snapshot is newer than the backup restored: restored in its place.
        expect(t.cardd.restored).toMatchObject({ kind: 'db', from: snapshotName('cd'.repeat(16), 1, T0 - 60).replace(/\.age$/, '') });
        expect(old.ssh.ran(RETIRED)).toBe(probedOld); // known retired: no SSH
      });

      // (d) A VM retired by an earlier rebuild, rebuilt in place while the one that replaced it still runs.
      it('in place on a VM an earlier rebuild retired, refuses up while its replacement runs, and retires that', async () => {
        const { t, old, s: from } = await fromServerPage({ backup: { kind: 'phrase_only' }, target: { kind: 'in_place', vmId: OLD_VM }, confirm: { inPlace: true } });
        old.cardd.retired = { at: '2026-09-01T00:00:00Z', replacedBy: 1013 };
        const y = another(t, 1013);
        y.cardd.addSnapshot(sealSummary(summary(T0 - 60, { vmId: '1013' }), t.keys.backupAgeRecipient), T0 - 60);
        let s = await drive({ ...from, step: 'where' }, t);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { oldVm: { id: 1013 } } });
        expect(s.error!.message).toBe(refused(1013, 'is running with a wallet on this phrase and was never retired'));
        expect(s.rebuild!.others ?? []).toEqual([]); // VM 1012 is this server
        expect(old.ssh.ran(UP)).toBe(0);
        s = await drive(confirmed({ ...s, error: undefined }, { retire: true }), t);
        expect(s).toMatchObject({ step: 'done', vmId: OLD_VM, rebuild: { backup: { created: T0 - 60 } } });
        expect(y.cardd.retired?.replacedBy).toBe(OLD_VM);
        expect(old.cardd.restored).toMatchObject({ kind: 'db', from: snapshotName('cd'.repeat(16), 1, T0 - 60).replace(/\.age$/, '') });
      });

      it('goes on past VMs deleted, retired, holding no seed, or never paid, looking only at those it doesn\'t know', async () => {
        const { t, s: at } = await installing();
        const retired = another(t, 1013);
        const empty = another(t, 1014);
        empty.cardd.seeded = false;
        another(t, 1015);
        t.lnvps.deleteVm(1015);
        const unpaid = another(t, 1016);
        Object.assign(t.lnvps.vms.get(1016)!, { expires: null, created: new Date(t.w.nowMs).toISOString() }); // an order LNVPS hasn't deleted yet
        const s = await drive({ ...at, retiredVms: [...at.retiredVms!, 1013] }, t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001 });
        expect(retired.ssh.connects).toEqual([]);
        expect(unpaid.ssh.connects).toEqual([]);
        expect(empty.ssh.ran(RETIRED)).toBe(1);
        expect([...empty.ssh.files.keys()]).toEqual(['card-app/install.sh']); // the app's own, as for an old server
      });

      const unseen = "is running and may hold a wallet on this phrase, but can't be looked at over SSH";
      it.each([
        ['LNVPS reports it stopped', (t: World) => t.lnvps.stop(1013), 'may hold a wallet on this phrase, and LNVPS reports it stopped'],
        ['it doesn\'t answer over SSH', (_t: World, y: OtherServer) => void (y.ssh.unreachable = true), unseen],
        ['LNVPS hasn\'t published its key', (t: World) => void (t.lnvps.vms.get(1013)!.host_ssh_keys = []), unseen],
        ['it can\'t tell (Docker not answering)', (_t: World, y: OtherServer) => void y.ssh.when(RETIRED, { code: 125, stderr: 'docker: error during connect' }), unseen],
      ])('refuses up for one it can\'t look at: %s', async (_, spoil: (t: World, y: OtherServer) => void, why) => {
        const { t, s: at } = await installing();
        spoil(t, another(t, 1013));
        const s = await drive(at, t);
        expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry', message: refused(1013, why) }, rebuild: { oldVm: { id: 1013 } } });
        expect(t.ssh.ran(UP)).toBe(0);
      });

      // Each one step 4 dealt with keeps its record, so neither is looked at again while LNVPS keeps it stopped.
      it('sees to two expired VMs in turn, and goes on', async () => {
        const { t, s: at } = await installing();
        for (const id of [1013, 1014]) {
          another(t, id).ssh.unreachable = true;
          t.lnvps.expire(id, '2026-09-30T00:00:00Z');
        }
        let s = at;
        for (const id of [1013, 1014]) {
          s = await drive(s, t);
          expect(s).toMatchObject({ step: 'retire', error: { kind: 'retry' }, rebuild: { oldVm: { id } } });
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'retire', waiting: 'confirm_expired' });
          s = confirmed(s, { expired: true });
        }
        s = await drive(s, t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001, rebuild: { oldVm: { id: 1014 }, retire: { result: 'expired' } } });
        expect(s.rebuild!.others).toEqual([
          { id: OLD_VM, result: 'retired', at: t.w.nowMs },
          { id: 1013, result: 'expired', at: t.w.nowMs, deletingOn: '2026-09-30T00:00:00Z' },
        ]);
        expect(t.ssh.ran(UP)).toBe(1);
      });

      it('refuses up again when one step 4 recorded expired runs again', async () => {
        const { t, s: at } = await installing();
        const r: Rebuild = { ...at.rebuild!, others: [{ id: 1013, result: 'expired', at: 1 }] };
        another(t, 1013);
        const s = await drive({ ...at, rebuild: r }, t);
        expect(s).toMatchObject({ step: 'retire', error: { message: refused(1013, 'is running again without having been retired') }, rebuild: { oldVm: { id: 1013 } } });
        expect(s.rebuild!.others).toEqual([{ id: OLD_VM, result: 'retired', at: t.w.nowMs }]); // it is step 4's again
      });

      it('waits when LNVPS can\'t be reached to list the VMs', async () => {
        const { t, s: at } = await installing();
        t.deps.lnvps.listVms = () => Promise.reject(new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"'));
        const s = await advance(at, t.deps);
        expect(s).toMatchObject({ step: 'install', waiting: 'network', installed: BEFORE_UP });
        expect(s.error).toBeUndefined();
        expect(t.ssh.ran(UP)).toBe(0);
      });

      describe('in ordinary onboarding', () => {
        /** A new phrase's onboarding, its VM 1001 paid and booting; then `other` set up beside it. */
        async function onboarding(other?: (t: World) => void) {
          const t = world();
          const s = await drive(initialState('GBR'), t, (x) => x.step === 'boot');
          other?.(t);
          return { t, s };
        }

        // Expired, stopped, and started again by LNVPS (a payment, a host boot) while the install ran: not one order offers.
        it('stops at up for another VM running the wallet unretired, and Try again resumes there, not from the upload', async () => {
          let y!: OtherServer;
          const { t, s: at } = await onboarding((t) => {
            y = another(t, 1013, '2026-09-01T00:00:00Z');
            t.lnvps.stop(1013);
            t.ssh.when(/install\.sh seed$/, () => void (t.lnvps.vms.get(1013)!.status = { state: 'running' }));
          });
          const message = "VM 1013 is running with a wallet on this phrase and was never retired: it stops when LNVPS's grace ends, or delete it in LNVPS.";
          let s = await drive(at, t);
          expect(s).toMatchObject({ step: 'order', vmId: 1001, error: { kind: 'retry', message }, installed: BEFORE_UP });
          sinceDropped(s, t); // the steps' times were there to clear: the next visit shows none that are stale
          expect(t.checkpoints.filter((x) => x.step === 'install').at(-1)!.stepMs).toMatchObject({ 'issuer-key': 0, restore: 0 });
          expect(s.chosenVmId).toBeUndefined();
          expect(t.ssh.ran(UP)).toBe(0);
          s = await drive({ ...s, error: undefined }, t);
          expect(s).toMatchObject({ step: 'order', vmId: 1001, error: { message } });
          expect(t.ssh.ran(/sha256sum --quiet/)).toBe(1); // uploaded once
          y.cardd.retired = { at: '2026-09-01T00:00:00Z', replacedBy: 1001 };
          expect(await drive({ ...s, error: undefined }, t)).toMatchObject({ step: 'done', vmId: 1001 });
          expect(t.ssh.ran(/sha256sum --quiet/)).toBe(1);
        });

        it.each([
          ['expired and stopped', (t: World) => void (another(t, 1013).ssh.unreachable = true, t.lnvps.expire(1013, '2026-09-30T00:00:00Z'))],
          ['stopped by hand', (t: World) => void (another(t, 1013).ssh.unreachable = true, t.lnvps.stop(1013))],
          ['paid and running, holding no seed', (t: World) => void (another(t, 1013).cardd.seeded = false)],
          ['retired', (t: World) => void (another(t, 1013).cardd.retired = { at: '2026-09-01T00:00:00Z', replacedBy: 1001 })],
        ])('goes on past another VM %s', async (_, other: (t: World) => void) => {
          const { t, s } = await onboarding(other);
          expect(await drive(s, t)).toMatchObject({ step: 'done', vmId: 1001 });
        });

        // Another account's key on it: this app can't look, and order never offers it.
        it('says to delete in LNVPS a VM it could never set up', async () => {
          const { t, s } = await onboarding((t) => {
            another(t, 1013).ssh.authorizedSeed = 'ff'.repeat(32);
            t.lnvps.vms.get(1013)!.ssh_key = { id: 9 };
          });
          expect((await drive(s, t)).error).toEqual({
            kind: 'retry', message: "VM 1013 is running and may hold a wallet on this phrase, but can't be looked at over SSH: delete it in LNVPS.",
          });
        });

        it('stops at up for another VM LNVPS runs that can\'t be looked at', async () => {
          const { t, s } = await onboarding((t) => void another(t, 1013).ssh.when(RETIRED, { code: 125, stderr: 'docker: error during connect' }));
          expect(await drive(s, t)).toMatchObject({
            step: 'order',
            error: { kind: 'retry', message: "VM 1013 is running and may hold a wallet on this phrase, but can't be looked at over SSH: choose it instead, or delete it in LNVPS." },
          });
        });

        // (c) A choice refused before its seed is written: otherwise each VM would then name the other, with no way on.
        it('on a new phone, refuses an empty VM before seeding it while another runs the wallet, and the other then finishes', async () => {
          const t = world();
          another(t, 1013, '2026-12-01T00:00:00Z');
          const e = another(t, 1014);
          e.cardd.seeded = false; // until install.sh seed runs there
          let s = await drive({ ...initialState('GBR'), restoring: true }, t, (x) => x.waiting === 'choose_vm');
          s = await drive({ ...s, chosenVmId: 1014 }, t);
          expect(s).toMatchObject({ step: 'order', vmId: 1014, error: { kind: 'retry', message: 'VM 1013 is running with a wallet on this phrase and was never retired: choose it instead, or delete it in LNVPS.' } });
          expect(e.ssh.ran(/install\.sh seed$/)).toBe(0);
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ waiting: 'choose_vm' });
          expect(await drive({ ...s, chosenVmId: 1013 }, t)).toMatchObject({ step: 'done', vmId: 1013 });
          expect(e.cardd.seeded).toBe(false);
        });

        // (c) A phrase typed back in with two paid VMs: the one not chosen still runs the wallet.
        it('on a new phone, refuses the VM chosen while the other runs the wallet, and asks again', async () => {
          const t = world();
          another(t, 1013, '2026-12-01T00:00:00Z');
          another(t, 1014);
          let s = await drive({ ...initialState('GBR'), restoring: true }, t, (x) => x.waiting === 'choose_vm');
          s = await drive({ ...s, chosenVmId: 1014 }, t);
          expect(s).toMatchObject({ step: 'order', vmId: 1014, error: { kind: 'retry', message: 'VM 1013 is running with a wallet on this phrase and was never retired: choose it instead, or delete it in LNVPS.' } });
          s = await advance({ ...s, error: undefined }, t.deps);
          expect(s).toMatchObject({ step: 'order', waiting: 'choose_vm', chosenVmId: undefined });
          s = await advance({ ...s, chosenVmId: 1013 }, t.deps);
          expect(s).toMatchObject({ step: 'boot', vmId: 1013, installed: [] }); // another VM: its install from the start
        });
      });
    });

    // After the rebuild the server page watches it, and retires it when it runs again.
    describe('the old VM, once rebuilt', () => {
      /** The rebuild done on VM 1001, step 4 having recorded the old server as `result`. */
      async function rebuilt(result: RetireRecord['result']) {
        const f = await atRetire({ retire: { result, at: 1 } });
        f.t.lnvps.stop(OLD_VM); // so install's last look lets the new server start
        const s = await drive(f.s, f.t);
        expect(s).toMatchObject({ step: 'done', vmId: 1001 });
        f.t.lnvps.vms.get(OLD_VM)!.status.state = 'running'; // then something started it again
        return { ...f, s };
      }

      it('is watched unless step 4 left it unable to run phoenixd again', async () => {
        const { s } = await rebuilt('expired');
        for (const result of ['expired', 'gone', 'override'] as const) {
          expect(oldVmsToWatch({ ...s, rebuild: { ...s.rebuild!, retire: { result, at: 1 } } })).toEqual([OLD_VM]);
        }
        for (const result of ['retired', 'reinstalled', 'empty', 'in_place'] as const) {
          expect(oldVmsToWatch({ ...s, rebuild: { ...s.rebuild!, retire: { result, at: 1 } } })).toEqual([]);
        }
        expect(oldVmsToWatch({ ...s, vmId: OLD_VM })).toEqual([]); // in place: it is this server
        expect(oldVmsToWatch({ ...s, rebuild: undefined })).toEqual([]);
      });

      // Each VM step 4 dealt with, until LNVPS reports it deleted.
      it('watches the other VMs step 4 saw to before, unless they can\'t run phoenixd again', async () => {
        const { s } = await rebuilt('expired');
        const others: Rebuild['others'] = [
          { id: 1013, result: 'expired', at: 1, deletingOn: '2026-09-30T00:00:00Z' },
          { id: 1014, result: 'retired', at: 1 },
          { id: 1015, result: 'override', at: 1, overSsh: true },
          { id: 1016, result: 'empty', at: 1 },
        ];
        expect(oldVmsToWatch({ ...s, rebuild: { ...s.rebuild!, others } })).toEqual([OLD_VM, 1013, 1015]);
      });

      it('retires one of those, and records it in its own entry', async () => {
        const { t, s: done } = await rebuilt('retired');
        const w = another(t, 1013);
        const s = { ...done, rebuild: { ...done.rebuild!, others: [{ id: 1013, result: 'expired' as const, at: 1 }] } };
        expect(oldVmsToWatch(s)).toEqual([1013]);
        const next = await retireOldServer(s, t.deps, 1013);
        expect(w.cardd.retired?.replacedBy).toBe(1001);
        expect(next.rebuild!.others).toEqual([{ id: 1013, result: 'retired', at: t.w.nowMs }]);
        expect(next.rebuild!.retire).toEqual(done.rebuild!.retire);
        expect(oldVmsToWatch(next)).toEqual([]);
      });

      it('records one that holds no Lightning wallet as such, retiring nothing', async () => {
        const { t, old, s } = await rebuilt('expired');
        old.cardd.seeded = false;
        const next = await retireOldServer(s, t.deps);
        expect(next.rebuild!.retire).toEqual({ result: 'empty', at: t.w.nowMs });
        expect(old.ssh.ran(/install\.sh retire '/)).toBe(0);
        expect(oldVmsToWatch(next)).toEqual([]);
      });

      it('retires it over SSH, naming this server, and records it retired', async () => {
        const { t, old, s } = await rebuilt('expired');
        const next = await retireOldServer(s, t.deps);
        expect(old.cardd.retired).toEqual({ at: '2026-09-21T14:13:20Z', replacedBy: 1001 });
        // The app's own install.sh first: an old server never updated has no retire.
        expect(old.ssh.files.has('card-app/install.sh')).toBe(true);
        const ran = old.ssh.commands.map((c) => c.command);
        expect(ran.lastIndexOf('cd card-app && sha256sum --quiet -c -')).toBeLessThan(ran.lastIndexOf("sh card-app/install.sh retire '1001'"));
        expect(next).toEqual({ ...s, rebuild: { ...s.rebuild!, retire: { result: 'retired', at: t.w.nowMs } } });
        expect(oldVmsToWatch(next)).toEqual([]);
        expect(old.ssh.ran(/install\.sh final-snapshot$/)).toBe(0); // the new server holds the books now
      });

      it('reaches a new phone\'s old server by what LNVPS publishes', async () => {
        const { t, old, s } = await rebuilt('gone');
        const next = await retireOldServer({ ...s, rebuild: { ...s.rebuild!, oldVm: { id: OLD_VM } } }, t.deps);
        expect(next.rebuild!.retire!.result).toBe('retired');
        expect(old.ssh.connects.at(-1)).toMatchObject({ host: OLD_HOST.ipv4, hostKey: OLD_HOST.hostKey });
      });

      describe('reaches an old server whose key was trusted on first use', () => {
        const FIRST_USE: ServerHost = { ...OLD_HOST, hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIfirstuse' }, keySource: 'first_use' };
        it('by that key while LNVPS lists none', async () => {
          const { t, old, s } = await rebuilt('expired');
          t.lnvps.publishHostKeys(OLD_VM, []);
          old.ssh.serverKey = FIRST_USE.hostKey;
          const next = await retireOldServer({ ...s, rebuild: { ...s.rebuild!, oldVm: { id: OLD_VM, host: FIRST_USE } } }, t.deps);
          expect(next.rebuild!.retire!.result).toBe('retired');
          expect(old.ssh.connects.at(-1)).toMatchObject({ host: OLD_HOST.ipv4, hostKey: FIRST_USE.hostKey });
        });

        // As step 4 does, LNVPS out of reach leaves the pinned key to try.
        it('by that key while LNVPS can\'t be reached', async () => {
          const { t, old, s } = await rebuilt('expired');
          old.ssh.serverKey = FIRST_USE.hostKey;
          t.deps.lnvps.getVm = async () => {
            throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
          };
          const next = await retireOldServer({ ...s, rebuild: { ...s.rebuild!, oldVm: { id: OLD_VM, host: FIRST_USE } } }, t.deps);
          expect(next.rebuild!.retire!.result).toBe('retired');
          expect(old.ssh.connects.at(-1)).toMatchObject({ host: OLD_HOST.ipv4, hostKey: FIRST_USE.hostKey });
          // With no key pinned there is nothing to try: the failure is the answer.
          await expect(retireOldServer({ ...s, rebuild: { ...s.rebuild!, oldVm: { id: OLD_VM } } }, t.deps)).rejects.toThrow('fetch failed');
        });

        it('by LNVPS\'s key once LNVPS lists another', async () => {
          const { t, old, s } = await rebuilt('expired');
          old.ssh.serverKey = OLD_HOST.hostKey; // the key LNVPS lists for VM 1012
          const next = await retireOldServer({ ...s, rebuild: { ...s.rebuild!, oldVm: { id: OLD_VM, host: FIRST_USE } } }, t.deps);
          expect(next.rebuild!.retire!.result).toBe('retired');
          expect(old.ssh.connects.at(-1)).toMatchObject({ hostKey: OLD_HOST.hostKey });
          expect(old.ssh.connects.some((c) => c.hostKey.publicKey === FIRST_USE.hostKey.publicKey)).toBe(false);
        });
      });

      it('throws, recording nothing, when it can\'t be reached or still answers', async () => {
        const { t, old, s } = await rebuilt('expired');
        old.ssh.unreachable = true;
        await expect(retireOldServer(s, t.deps)).rejects.toThrow();
        old.ssh.unreachable = false;
        old.ssh.when(/install\.sh retire '1001'$/, () => ({ stdout: 'retired\n' })); // compose down did nothing
        await expect(retireOldServer(s, t.deps)).rejects.toThrow("The old server has no retired marker naming VM 1001 after retiring it.");
      });
    });
  });
});

// A connection to the server being set up that drops is
// a wait, not an error; the install and pairing carry on from where they were.
describe('a connection that drops under the install or pairing', () => {
  const KEEPS = 'Karto Wallet can’t keep a connection to your server. Check this phone’s internet; if that is fine, your server may be down. Then try again.';
  /** Up to the first wait for the connection (or wherever it stops). */
  const toDrop = (s: OnboardingState, t: World) => drive(s, t, (x) => x.waiting === 'reconnect');

  it('waits when a step is cut, keeps the steps done, and carries on from the cut one', async () => {
    const t = world();
    t.ssh.drop(/install\.sh prepare/);
    let s = await toDrop(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', waiting: 'reconnect', drops: { n: 1, during: 'command', last: 'Broken pipe' }, installed: ['upload', 'first-boot', 'swap', 'docker', 'docker-setup'] });
    expect(s.error).toBeUndefined();
    s = await drive(s, t);
    expect(s.step).toBe('done');
    expect([t.ssh.ran(/install\.sh (first-boot|swap|docker|docker-setup)$/), t.ssh.ran(/install\.sh prepare/)]).toEqual([4, 1]);
    expect(s.drops).toBeUndefined();
  });

  // Each step's time; a step cut by a drop keeps its first start, since the step command keeps it running on the server.
  it("times each install step: its start kept across a drop, its time recorded at its end", async () => {
    const t = world();
    const began = t.w.nowMs; // the machine's clock (t.nowMs is a copy)
    t.ssh.drop(/install\.sh docker$/);
    // When Install Docker does run, it takes 30 s (the rule moves the clock and answers nothing, so the step still succeeds).
    t.ssh.when(/install\.sh docker$/, () => void (t.w.nowMs += 30_000));
    let s = await toDrop(initialState('GBR'), t);
    expect(s).toMatchObject({
      step: 'install', waiting: 'reconnect', drops: { n: 1, during: 'command' },
      installed: ['upload', 'first-boot', 'swap'], stepStartedAt: { step: 'docker', at: began }, stepMs: { upload: 0, 'first-boot': 0, swap: 0 },
    });
    expect(t.checkpoints.at(-1)!).toMatchObject({ step: 'install', stepStartedAt: { step: 'docker', at: began } });
    t.w.nowMs += 10_000; // the wait before the connection is tried again
    s = await drive(s, t);
    expect(s.step).toBe('done');
    // The retry kept the first start: the step's time counts the wait and the run (40 s), not the run alone (30 s).
    const finished = t.checkpoints.find((x) => x.installed.includes('docker'))!;
    expect(finished.stepMs).toEqual({ upload: 0, 'first-boot': 0, swap: 0, docker: 40_000 });
    expect(finished.stepStartedAt).toBeUndefined();
    expect(t.checkpoints.filter((x) => x.stepStartedAt?.step === 'docker').every((x) => x.stepStartedAt!.at === began)).toBe(true);
    // Every step got its time; the state that left the install step carries none.
    expect(Object.keys(t.checkpoints.filter((x) => x.step === 'install').at(-1)!.stepMs!)).toEqual([...INSTALL_STEPS]);
    expect([s.stepMs, s.stepStartedAt]).toEqual([undefined, undefined]);
  });

  // A step that failed ended; Try again times its new run afresh.
  it('clears a failed step\'s start, so Try again times it afresh', async () => {
    const t = world();
    t.ssh.when(/install\.sh up$/, { code: 1, stderr: 'boom' }, 1);
    const s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(s.stepStartedAt).toBeUndefined();
    expect(t.checkpoints.some((x) => x.stepStartedAt?.step === 'up')).toBe(true);
  });

  // An error at the install step (here the fourth drop in a row) clears the step's start, as a failed step's does.
  it('clears the start of a step whose drops ran out into an error, so Try again times it afresh', async () => {
    const t = world();
    t.ssh.drop(/install\.sh docker$/, 4);
    let s = await toDrop(initialState('GBR'), t);
    expect(s).toMatchObject({ waiting: 'reconnect', drops: { n: 1 }, stepStartedAt: { step: 'docker' } });
    for (let n = 2; n <= 3; n++) {
      s = await advance(s, t.deps);
      expect(s).toMatchObject({ waiting: 'reconnect', drops: { n }, stepStartedAt: { step: 'docker' } });
    }
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(s.stepStartedAt).toBeUndefined();
  });

  it('waits when no connection can be made, and when an upload is cut', async () => {
    const t = world();
    t.ssh.connectDrops = 1;
    let s = await toDrop(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', waiting: 'reconnect', drops: { n: 1, during: 'connect' }, installed: [] });
    t.ssh.uploadDrops = 1;
    // The connection holds for a moment (as after a return to the front, which starts the count afresh), then an upload is cut.
    s = await toDrop(await advance({ ...s, drops: undefined }, t.deps), t);
    expect(s).toMatchObject({ step: 'install', waiting: 'reconnect', drops: { n: 1, during: 'upload' }, installed: [] });
    expect((await drive(s, t)).step).toBe('done');
  });

  // The server answered, so nothing is waited out.
  it('stops at an upload the server refuses, with its words and no wait, and goes on when tried again', async () => {
    const t = world();
    t.ssh.uploadRefusals = 1;
    const s = await drive(initialState('GBR'), t);
    expect(s).toMatchObject({ step: 'install', installed: [] });
    expect(s.error).toEqual({ kind: 'retry', message: expect.stringMatching(/^The server refused the upload of \S+: No space left on device$/) });
    expect([s.waiting, s.drops]).toEqual([undefined, undefined]);
    expect((await drive({ ...s, error: undefined }, t)).step).toBe('done');
  });

  it('counts drops in a row, and stops at the fourth with words of its own, the count gone', async () => {
    const t = world();
    t.ssh.drop(/install\.sh prepare/, 4);
    let s = await toDrop(initialState('GBR'), t);
    const seen = [s.drops?.n];
    for (let i = 0; i < 2; i++) {
      s = await advance(s, t.deps);
      seen.push(s.drops?.n);
      expect(s).toMatchObject({ waiting: 'reconnect' });
    }
    expect(seen).toEqual([1, 2, 3]);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry', message: KEEPS }, installed: ['upload', 'first-boot', 'swap', 'docker', 'docker-setup'] });
    expect([s.waiting, s.drops]).toEqual([undefined, undefined]);
    // Try again starts afresh, and the step is there to be run.
    expect((await drive({ ...s, error: undefined }, t)).step).toBe('done');
  });

  it('starts the count again when a step is finished', async () => {
    const t = world();
    t.ssh.drop(/install\.sh first-boot/, 2).drop(/install\.sh prepare/, 2).drop(/install\.sh up/, 2);
    let s = await toDrop(initialState('GBR'), t);
    const seen: [number, number][] = [];
    while (s.waiting === 'reconnect') {
      seen.push([s.installed.length, s.drops!.n]);
      s = await toDrop(await advance(s, t.deps), t);
    }
    expect(s.step).toBe('done');
    expect(seen.map(([, n]) => n)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(t.checkpoints.filter((x) => x.drops !== undefined)).toEqual([]);
  });

  it('finds a step the server had finished before its answer was lost, and goes on', async () => {
    const t = world();
    // The server's side of the step: what it has done, whether or not its answer arrived.
    let seeded = 0;
    t.ssh.when(/install\.sh seed/, () => (seeded++, {}));
    t.ssh.drop(/install\.sh seed/, 1, { after: true });
    let s = await toDrop(initialState('GBR'), t);
    expect([seeded, s.installed.includes('seed'), s.waiting]).toEqual([1, false, 'reconnect']);
    s = await drive(s, t);
    expect([s.step, seeded, s.installed.includes('seed')]).toEqual(['done', 2, true]);
  });

  it('takes a step the command did not run for this start as a drop, and a step that failed as a failure at once', async () => {
    const t = world();
    t.ssh.when(/install\.sh prepare/, { code: 70 }, 1);
    let s = await toDrop(initialState('GBR'), t);
    expect(s).toMatchObject({ waiting: 'reconnect', drops: { n: 1, during: 'command' } });
    t.ssh.when(/install\.sh prepare/, { code: 1, stderr: 'docker: no space left on device' }, 1);
    s = await advance(s, t.deps);
    expect(s).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(s.error!.message).toContain('no space left on device');
    expect(s.drops).toBeUndefined();
  });

  it('leaves the phone\'s own network and a refused key as they were', async () => {
    const t = world();
    t.ssh.authorizedSeed = '11'.repeat(32);
    const s = await drive(initialState('GBR'), t);
    expect(s.error?.message).toContain("refused this app's SSH key");
    expect(s.drops).toBeUndefined();
  });

  it('waits at pairing too, each of its two stages starting the count again', async () => {
    const t = world();
    t.ssh.drop(/device add/, 2).drop(/revoke-others/, 2);
    let s = await toDrop(initialState('GBR'), t);
    const seen: (string | number | boolean | undefined)[][] = [];
    while (s.waiting === 'reconnect') {
      seen.push([s.step, s.drops!.n, s.deviceKeyId !== undefined, s.othersRevoked]);
      s = await toDrop(await advance(s, t.deps), t);
    }
    expect(s.step).toBe('done');
    expect(seen).toEqual([['pair', 1, false, undefined], ['pair', 2, false, undefined], ['pair', 1, true, undefined], ['pair', 2, true, undefined]]);
  });
});
