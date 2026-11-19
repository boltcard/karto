import { describe, expect, it } from 'vitest';
import { installStepsFor } from './install';
import { initialState, startRebuild, STEPS, type OnboardingState, type Rebuild, type ServerHost, type Waiting } from './machine';
import {
  countdown, doneLine, doneSteps, doneSummary, elapsed, errorActions, hostKeyNotice, INSTALL_STEP_LABELS, installFoot, installLogLine, installRows, installStepStatus, newInstallLogLines, payFoot, payWithin, readyView,
  setupInstallSteps, setupProgress, STEP_LABELS, statusLine, stepHeading, stepRows, stepsFor, stepStatus, uploadLine, working,
} from './progress';
import { chosenLine } from './rebuild';

describe('progress', () => {
  it('marks steps done, current or to do', () => {
    const s = { ...initialState('GBR'), step: 'pay' as const };
    expect(stepStatus(s, 'order')).toBe('done');
    expect(stepStatus(s, 'pay')).toBe('current');
    expect(stepStatus(s, 'install')).toBe('todo');
    expect(stepStatus({ ...s, step: 'done' }, 'done')).toBe('done');
  });

  // Choosing a backup, where, and retiring the old server belong to a rebuild only.
  it('shows a rebuild\'s own steps only in a rebuild', () => {
    const s = initialState('GBR');
    expect(stepsFor(s)).toEqual(['country', 'email', 'order', 'pay', 'boot', 'install', 'pair', 'done']);
    expect(stepsFor({ ...s, rebuild: { source: 'new_phone' } })).toEqual(['country', 'email', 'backup', 'where', 'order', 'pay', 'boot', 'retire', 'install', 'pair', 'done']);
    expect([STEP_LABELS.backup, STEP_LABELS.where, STEP_LABELS.retire]).toEqual(['Choose a backup', 'Choose where', 'Retire the old server']);
  });

  // A rebuild trusts on first use as onboarding does: the same wait for SSH.
  it('says a rebuild waits for the server to answer SSH, as onboarding does', () => {
    const s = { ...initialState('GBR'), step: 'boot' as const, waiting: 'host_keys' as const, rebuild: { source: 'server_page' as const } };
    expect(statusLine(s)).toBe('Waiting for the new server to answer…');
  });

  // Without LNVPS, nothing says the old server can't run; the screen offers going on blind.
  it('says step 4 waits for LNVPS, and what each of a rebuild\'s other waits is for', () => {
    const s = { ...initialState('GBR'), rebuild: { source: 'server_page' as const } };
    expect(statusLine({ ...s, step: 'retire', waiting: 'old_unreachable' })).toBe('Neither the old server nor LNVPS can be reached to say what the old server is doing. Trying again…');
    expect(statusLine({ ...s, step: 'retire', waiting: 'old_vm_starting' })).toBe('Waiting for the old server to answer SSH…');
    expect(statusLine({ ...s, step: 'retire', waiting: 'confirm_expired' })).toBe('The old server has expired: choose whether to pay a day to retire it properly…');
    expect(statusLine({ ...s, step: 'retire', waiting: 'old_payment' })).toBe('Waiting for the payment for the old server…');
    expect(statusLine({ ...s, step: 'backup', waiting: 'confirm_older' })).toBe('This backup isn’t the newest: confirm to restore it all the same…');
  });

  it('says what the current step is doing', () => {
    const s = initialState('GBR');
    expect(statusLine({ ...s, step: 'pay', waiting: 'payment' })).toBe('Waiting for the payment…');
    expect(statusLine({ ...s, step: 'boot', error: { kind: 'retry', message: 'boom' } })).toBe('boom');
  });

  it("says mail.tm is busy and that it tries again by itself", () => {
    expect(statusLine({ ...initialState('GBR'), step: 'email', waiting: 'mailtm_busy' })).toBe("mail.tm, the inbox for LNVPS's email, is busy. Trying again in a minute…");
  });

  it('says it is waiting for the network, not that something broke', () => {
    expect(statusLine({ ...initialState('GBR'), waiting: 'network' })).toBe('The phone can’t reach the internet right now. Trying again…');
    // Since trust on first use, boot waits for the server's SSH to answer, not for LNVPS.
    expect(statusLine({ ...initialState('GBR'), step: 'boot', waiting: 'host_keys' })).toBe('Waiting for the new server to answer…');
  });

  // Three waits in words for someone who has never run a server; the rest as they were.
  it('says the email, the new server and its address in plain words', () => {
    const s = initialState('GBR');
    expect(statusLine({ ...s, step: 'email', waiting: 'email' })).toBe('Waiting for LNVPS’s email. Karto Wallet reads it for you.');
    expect(statusLine({ ...s, step: 'pair', waiting: 'health' })).toBe('Waiting for the server’s web address to be ready…');
    expect(statusLine({ ...s, step: 'boot', waiting: 'boot' })).toBe('The server is starting…');
    expect(statusLine({ ...s, step: 'pay', waiting: 'order_expiring' })).toBe('This order is about to expire. A new one is made once LNVPS deletes it…');
  });

  it('says what a step is doing when it waits for nothing', () => {
    const s = initialState('GBR');
    const line = (step: OnboardingState['step'], o: Partial<OnboardingState> = {}) => statusLine({ ...s, step, ...o });
    expect(line('country')).toBe('Setting the country on your LNVPS account…');
    expect(line('email')).toBe('Making an inbox for LNVPS’s email…');
    expect(line('backup')).toBe('Looking for backups…');
    expect(line('where')).toBe('Asking LNVPS for your servers…');
    expect(line('order')).toBe('Asking LNVPS for a server…');
    expect(line('pay')).toBe('Getting the invoice…');
    expect(line('boot')).toBe('The server is starting…');
    expect(line('retire')).toBe('Retiring the old server…');
    expect(line('pair')).toBe('Adding this phone to the server…');
    // The install's own steps say it, and done has nothing to say.
    expect(line('install')).toBeNull();
    expect(line('done')).toBeNull();
    // A typed-in phrase looks for its paid server: nothing is ordered.
    expect(line('order', { restoring: true })).toBe('Asking LNVPS for your servers…');
    expect(line('order', { restoring: true, rebuild: { source: 'new_phone' } })).toBe('Asking LNVPS for a server…');
    // A wait or an error at the install still has its line.
    expect(line('install', { waiting: 'network' })).toBe('The phone can’t reach the internet right now. Trying again…');
    expect(line('install', { error: { kind: 'retry', message: 'boom' } })).toBe('boom');
  });

  // "Choose another country" only when the country is the problem (VAT), not on a network error.
  it('offers the buttons that can fix the error', () => {
    const s = initialState('GBR');
    expect(errorActions(s)).toEqual({ retry: false, chooseCountry: false, final: false });
    expect(errorActions({ ...s, error: { kind: 'retry', message: 'LNVPS said 502' } })).toEqual({ retry: true, chooseCountry: false, final: false });
    expect(errorActions({ ...s, error: { kind: 'fatal', message: 'LNVPS would charge 23% VAT' } })).toEqual({ retry: false, chooseCountry: true, final: false });
    expect(errorActions({ ...s, step: 'install', error: { kind: 'wrong_phrase', message: 'x' } })).toEqual({ retry: false, chooseCountry: false, final: true });
  });

  // What the pay screen counts down: the time until this invoice is replaced, not the order's hour.
  it('says how long is left to pay this invoice', () => {
    const s = { ...initialState('GBR'), step: 'pay' as const, waiting: 'payment' as const };
    const invoice = { vmId: 1, sat: 6863, days: 31, bolt11: 'lnbc…', expiresAt: 1_000_000 + 10 * 60_000 };
    expect(payWithin({ ...s, invoice }, 1_000_000)).toBe('9:00');
    expect(payWithin({ ...s, invoice }, 1_000_000 + 9 * 60_000 + 30_000)).toBe('0:00');
    expect(payWithin(s, 1_000_000)).toBeNull();
    // The app stops offering this order's invoices 10 min before LNVPS deletes it: count to that if sooner.
    const orderDeadline = 1_000_000 + 15 * 60_000;
    expect(payWithin({ ...s, invoice, orderDeadline }, 1_000_000)).toBe('5:00');
  });

  // Under the QR code: who can pay, how long this invoice shows, and that nothing more is asked once it is paid.
  it('says under the invoice how long it shows and that Karto Wallet carries on by itself', () => {
    expect(payFoot('9:41')).toBe('Pay from any Lightning wallet within 9:41; after that a new invoice appears here. Karto Wallet carries on by itself once it’s paid.');
    expect(payFoot(null)).toBe('Pay from any Lightning wallet. Karto Wallet carries on by itself once it’s paid.');
  });

  // Trusted on first use, then checked against LNVPS's key (about an hour after the server starts).
  it('says whether LNVPS has confirmed the server key', () => {
    const host = { ipv4: '45.67.89.164', hostname: 'vm-1009.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' } };
    const s = { ...initialState('GBR'), step: 'done' as const };
    expect(hostKeyNotice({ ...s, host: { ...host, keySource: 'lnvps' } }, 0)).toEqual({ kind: 'ok', text: 'LNVPS has confirmed this server\'s SSH key.' });
    expect(hostKeyNotice({ ...s, host }, 0)).toEqual({ kind: 'ok', text: 'LNVPS has confirmed this server\'s SSH key.' });
    expect(hostKeyNotice({ ...s, host: { ...host, keySource: 'first_use' } }, 0)).toEqual({
      kind: 'pending',
      text: "LNVPS hasn't confirmed your server's identity yet. It usually does about an hour after the server starts; the app checks while the wallet or a Settings page is open.",
    });
    const bad = hostKeyNotice({ ...s, host: { ...host, keySource: 'first_use' }, hostKeyMismatch: 'LNVPS published SHA256:x' }, 0);
    expect(bad.kind).toBe('mismatch');
    expect(bad.text).toContain('LNVPS published SHA256:x');
    expect(bad.text).toContain('Stop using this server and this recovery phrase');
  });

  // Security review: "pending" must not last forever. LNVPS normally publishes within an hour.
  it('warns when LNVPS has not confirmed a trusted key 2 hours on', () => {
    const host = { ipv4: '45.67.89.164', hostname: 'vm-1009.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' } };
    const s = { ...initialState('GBR'), step: 'done' as const, host: { ...host, keySource: 'first_use' as const, trustedAt: 1_000_000 } };
    expect(hostKeyNotice(s, 1_000_000 + 2 * 3600_000).kind).toBe('pending');
    const late = hostKeyNotice(s, 1_000_000 + 2 * 3600_000 + 1);
    expect(late.kind).toBe('overdue');
    expect(late.text).toContain('2 hours');
    expect(late.text).toMatch(/^LNVPS still hasn't confirmed your server's identity \(its SSH key\) after 2 hours; it normally does within one\./);
    expect(late.text).toContain('vm-1009.lnvps.cloud');
    // Saved before trustedAt existed: no way to tell how long, so still pending.
    expect(hostKeyNotice({ ...s, host: { ...host, keySource: 'first_use' } }, 1e15).kind).toBe('pending');
  });

  // The person watches these during the install and Update server: plain words, and how far the upload is.
  it('names each install step in plain words', () => {
    expect(INSTALL_STEP_LABELS.upload).toBe('Upload the server files');
    expect(INSTALL_STEP_LABELS['first-boot']).toBe("Wait for the server's first boot");
    expect(INSTALL_STEP_LABELS.swap).toBe('Add swap');
    expect(INSTALL_STEP_LABELS.docker).toBe('Install Docker');
    expect(INSTALL_STEP_LABELS['docker-setup']).toBe('Set up Docker');
    expect(INSTALL_STEP_LABELS.up).toBe('Start the services');
    expect(INSTALL_STEP_LABELS.wipe).toBe('Wipe the old server data');
    expect(INSTALL_STEP_LABELS.restore).toBe('Restore the backup');
    expect(installRows({ ...initialState('GBR'), step: 'install', installed: ['upload', 'first-boot', 'swap', 'docker', 'docker-setup'] })).toEqual([
      { step: 'upload', label: 'Upload the server files', status: 'done', time: null, spoken: 'Upload the server files, done' },
      { step: 'first-boot', label: "Wait for the server's first boot", status: 'done', time: null, spoken: "Wait for the server's first boot, done" },
      { step: 'swap', label: 'Add swap', status: 'done', time: null, spoken: 'Add swap, done' },
      { step: 'docker', label: 'Install Docker', status: 'done', time: null, spoken: 'Install Docker, done' },
      { step: 'docker-setup', label: 'Set up Docker', status: 'done', time: null, spoken: 'Set up Docker, done' },
      { step: 'prepare', label: 'Build the card server', status: 'current', time: null, spoken: 'Build the card server, running' },
      { step: 'seed', label: 'Set the Lightning wallet seed', status: 'todo', time: null, spoken: 'Set the Lightning wallet seed, to do' },
      { step: 'issuer-key', label: 'Set the card key', status: 'todo', time: null, spoken: 'Set the card key, to do' },
      { step: 'up', label: 'Start the services', status: 'todo', time: null, spoken: 'Start the services, to do' },
      { step: 'meta', label: 'Record the version', status: 'todo', time: null, spoken: 'Record the version, to do' },
    ]);
  });

  // Nothing is wiped or restored outside a rebuild: Update server and an ordinary install list neither.
  it('lists the wipe and the restore only when they do something', () => {
    expect(installStepsFor({})).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key', 'up', 'meta']);
    expect(installStepsFor({ restore: true })).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(installStepsFor({ wipe: true, restore: true })).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(installStepsFor({ hostKey: true })).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'host-key', 'seed', 'issuer-key', 'up', 'meta']);
  });

  // The wait for LNVPS is listed for a key trusted on first use, and stays listed, with its time, once LNVPS confirms it.
  it('lists the wait for LNVPS only for a key trusted on first use', () => {
    const host = { ipv4: '45.67.89.170', hostname: 'vm-1003.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' } };
    const at = (h: Partial<ServerHost>): OnboardingState => ({ ...initialState('GBR'), step: 'install', host: { ...host, ...h } });
    expect(setupInstallSteps(at({ keySource: 'lnvps' }))).not.toContain('host-key');
    expect(setupInstallSteps(at({}))).not.toContain('host-key'); // saved before keySource: LNVPS's
    expect(setupInstallSteps(at({ keySource: 'first_use', trustedAt: 1 }))).toContain('host-key');
    expect(setupInstallSteps(at({ keySource: 'first_use' }))).toContain('host-key');
    expect(setupInstallSteps(at({ keySource: 'lnvps', trustedAt: 1 }))).toContain('host-key');
    expect(INSTALL_STEP_LABELS['host-key']).toBe('Wait for LNVPS to confirm your server');
  });

  it('lists only the install steps this install runs, and never marks a hidden one as the current', () => {
    const at = (installed: OnboardingState['installed'], rebuild?: Rebuild): OnboardingState =>
      ({ ...initialState('GBR'), step: 'install', installed, rebuild });
    const kept = { kind: 'kept' as const, name: 'x-1-100.age', created: 100, cards: 1, totalMsat: 1000 };
    const rebuild = (r: Partial<Rebuild>): Rebuild => ({ source: 'server_page', backup: kept, target: { kind: 'new' }, ...r });
    const current = (s: OnboardingState) => installRows(s).find((r) => r.status === 'current')?.step;
    // An ordinary install reports the wipe done (it did nothing) only once it has run: the seed is next either way.
    expect(setupInstallSteps(at([]))).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key', 'up', 'meta']);
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare']))).toBe('seed');
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key']))).toBe('up');
    // A rebuild onto a new VM restores, and wipes nothing.
    expect(setupInstallSteps(at([], rebuild({})))).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key'], rebuild({})))).toBe('restore');
    // The phrase alone restores no backup to show.
    expect(setupInstallSteps(at([], rebuild({ backup: { kind: 'phrase_only' } })))).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key', 'up', 'meta']);
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key'], rebuild({ backup: { kind: 'phrase_only' } })))).toBe('up');
    // In place, or again after a newer final snapshot replaced one restored, the old data is wiped first.
    expect(setupInstallSteps(at([], rebuild({ target: { kind: 'in_place', vmId: 1 } })))).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare'], rebuild({ target: { kind: 'in_place', vmId: 1 } })))).toBe('wipe');
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'seed', 'issuer-key'], rebuild({ rewipe: true })))).toBe('wipe');
    // Everything done: nothing is current.
    expect(current(at(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta']))).toBeUndefined();
  });

  it('says how long the install has run, in whole minutes, and to keep the app open', () => {
    const s = { ...initialState('GBR'), step: 'install' as const };
    expect(installFoot({ ...s, installSince: 1_000_000 }, 1_000_000 + 59_000)).toBe('0 min so far. Keep the app open: the screen stays on. If you leave, it carries on when you come back.');
    expect(installFoot({ ...s, installSince: 1_000_000 }, 1_000_000 + 4 * 60_000 + 30_000)).toBe('4 min so far. Keep the app open: the screen stays on. If you leave, it carries on when you come back.');
    // A clock set back never shows minutes below nought; a state saved mid-install by an older build has no start.
    expect(installFoot({ ...s, installSince: 1_000_000 }, 900_000)).toBe('0 min so far. Keep the app open: the screen stays on. If you leave, it carries on when you come back.');
    expect(installFoot(s, 1_000_000)).toBe('Keep the app open: the screen stays on. If you leave, it carries on when you come back.');
    // During the wait for LNVPS: no third count of minutes beside the status line's and the row's.
    expect(installFoot({ ...s, installSince: 1_000_000, waiting: 'host_key_confirm' }, 1_000_000 + 14 * 60_000)).toBe(
      'You can leave the app while LNVPS confirms your server: the install carries on when you come back.',
    );
  });

  it('shows how far an upload has got', () => {
    expect(uploadLine({ path: 'bin/cardd', sent: 4_200_000, total: 11_096_226 })).toBe('Uploading bin/cardd: 4.2 of 11.1 MB');
    expect(uploadLine({ path: 'install.sh', sent: 0, total: 5_639 })).toBe('Uploading install.sh: 0.0 of 0.0 MB');
  });

  it('marks the update\'s steps done, current or to do', () => {
    expect(installStepStatus(['upload'], 'upload')).toBe('done');
    expect(installStepStatus(['upload'], 'first-boot')).toBe('current');
    expect(installStepStatus(['upload'], 'prepare')).toBe('todo');
    expect(installStepStatus([], 'upload')).toBe('current');
    // Update server lists no wipe: the seed is current while the hidden wipe runs.
    expect(installStepStatus(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare'], 'seed', installStepsFor({}))).toBe('current');
  });

  it('counts down to the order deadline, and stops at zero', () => {
    expect(countdown(1_000_000 + 42 * 60_000 + 7_000, 1_000_000)).toBe('42:07');
    expect(countdown(1_000_000 + 59_999, 1_000_000)).toBe('0:59');
    expect(countdown(1_000_000, 1_000_000)).toBe('0:00');
    expect(countdown(1_000_000, 2_000_000)).toBe('0:00');
  });

  it('counts the time a long operation has taken', () => {
    expect(elapsed(1_000_000, 1_000_000)).toBe('0:00');
    expect(elapsed(1_000_000, 1_000_000 + 4 * 60_000 + 9_500)).toBe('4:09');
  });
});

// The real run: "it does not tell me the new VM id". Each finished step says what it settled.
describe('doneLine', () => {
  const host = { ipv4: '45.67.89.170', hostname: 'vm-1003.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' }, keySource: 'first_use' as const };
  const KEPT = { kind: 'kept' as const, name: 'ab-3-1789990000.age', created: 1_789_990_000, cards: 1, totalMsat: 31_084_000 };
  const at = (o: Partial<NonNullable<OnboardingState['rebuild']>>, s: Partial<OnboardingState> = {}): OnboardingState => {
    const r = startRebuild({ ...initialState('GBR'), step: 'done', vmId: 1009 }, 'server_page');
    return { ...r, step: 'retire', ...s, rebuild: { ...r.rebuild!, ...o } };
  };

  it('names the backup, a new server, the VM ordered and the server booted', () => {
    const s = at({ backup: KEPT, target: { kind: 'new' } }, { vmId: 1003, host });
    expect(doneLine(s, 'backup', 1_789_990_000 + 3600, 0)).toBe(chosenLine(KEPT, 1_789_990_000 + 3600, 0));
    expect(doneLine(s, 'backup', 1_789_990_000 + 3600, 0)).toMatch(/^Today at \d\d:\d\d · 1 card · 31,084 sat$/);
    expect(doneLine(s, 'where')).toBe('A new server');
    expect(doneLine(s, 'order')).toBe('VM 1003');
    expect(doneLine(s, 'pay')).toBeNull();
    expect(doneLine(s, 'boot')).toBe('vm-1003.lnvps.cloud · 45.67.89.170');
  });

  it('names the VM chosen in place, with no order line', () => {
    const s = at({ backup: KEPT, target: { kind: 'in_place', vmId: 1009 } }, { vmId: 1009 });
    expect(doneLine(s, 'where')).toBe('In place on VM 1009');
    expect(doneLine(s, 'order')).toBeNull();
    expect(doneLine(s, 'boot')).toBeNull(); // not booted yet: no host
  });

  it('names the VM ordered in ordinary onboarding too', () => {
    expect(doneLine({ ...initialState('GBR'), step: 'pay', vmId: 1003 }, 'order')).toBe('VM 1003');
  });
});

// The setup screen, one step at a time.
describe('the setup screen', () => {
  const NOW = Date.UTC(2026, 9, 10, 15, 0) / 1000;
  const host = { ipv4: '45.67.89.170', hostname: 'vm-1003.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' }, keySource: 'first_use' as const };
  const KEPT = { kind: 'kept' as const, name: 'ab-3-1.age', created: NOW - 2 * 3600, cards: 3, totalMsat: 48_210_000 };
  const plain = (step: OnboardingState['step'], o: Partial<OnboardingState> = {}): OnboardingState => ({ ...initialState('GBR'), step, ...o });
  const rebuilding = (step: OnboardingState['step'], r: Partial<Rebuild> = {}, o: Partial<OnboardingState> = {}): OnboardingState =>
    plain(step, { rebuild: { source: 'server_page', ...r }, ...o });

  it('counts the steps: seven setting up, ten in a rebuild', () => {
    expect(['country', 'email', 'order', 'pay', 'boot', 'install', 'pair'].map((x) => setupProgress(plain(x as OnboardingState['step'])).n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(setupProgress(plain('pay'))).toEqual({ n: 4, of: 7, label: 'Step 4 of 7, Pay for the server' });
    expect(STEPS.filter((x) => x !== 'done').map((x) => setupProgress(rebuilding(x)).n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(setupProgress(rebuilding('retire'))).toEqual({ n: 8, of: 10, label: 'Step 8 of 10, Retiring the old server' });
    expect(setupProgress(plain('done'))).toMatchObject({ n: 7, of: 7 });
  });

  // The machine never puts a rebuild's step in a state without its rebuild; if one ever were, the count is still a count.
  it("counts a rebuild's step among all ten even without its rebuild", () => {
    expect(setupProgress(plain('backup'))).toMatchObject({ n: 3, of: 10 });
    expect(setupProgress(plain('retire'))).toMatchObject({ n: 8, of: 10 });
    expect(doneSummary(plain('where'))).toBe('Done: country, email, backup');
  });

  it('keeps the number of a step the machine passed over', () => {
    // In place has no order and no payment: starting the server is still step 7 of 10.
    expect(setupProgress(rebuilding('boot', { target: { kind: 'in_place', vmId: 1009 } }))).toMatchObject({ n: 7, of: 10 });
    // A typed-in phrase whose server is still paid has no payment: step 5 of 7.
    expect(setupProgress(plain('boot', { restoring: true }))).toMatchObject({ n: 5, of: 7 });
  });

  it('heads each step with what is happening', () => {
    expect(STEPS.filter((x) => x !== 'done').map((x) => stepHeading(rebuilding(x)))).toEqual([
      'Telling LNVPS your country', 'Opening your LNVPS account', 'Choose a backup', 'Choose where to rebuild', 'Ordering the server', 'Pay for the server',
      'Starting the server', 'Retiring the old server', 'Installing your server', 'Pairing this phone',
    ]);
    expect(stepHeading(plain('order'))).toBe('Ordering the server');
  });

  it('says so at the order step when nothing is ordered', () => {
    // A typed-in phrase looks for its paid server; rebuilding (none was left), it orders.
    expect(stepHeading(plain('order', { restoring: true }))).toBe('Looking for your server');
    expect(stepHeading(plain('order', { restoring: true, rebuild: { source: 'new_phone' } }))).toBe('Ordering the server');
    // Asking which of several.
    expect(stepHeading(plain('order', { restoring: true, waiting: 'choose_vm' }))).toBe('Choose your server');
    expect(stepHeading(plain('order', { waiting: 'choose_vm' }))).toBe('Choose your server');
  });

  it('spins while Karto works, and not when it is the person\'s turn or something failed', () => {
    const turn: Waiting[] = ['payment', 'old_payment', 'choose_vm', 'choose_backup', 'choose_where', 'confirm_older', 'confirm_retire', 'confirm_reinstall', 'confirm_expired'];
    const karto: Waiting[] = ['email', 'order_expiring', 'boot', 'host_keys', 'host_key_confirm', 'health', 'network', 'old_unreachable', 'old_vm_starting', 'recovery_check'];
    for (const w of turn) expect([w, working(plain('pay', { waiting: w }))]).toEqual([w, false]);
    for (const w of karto) expect([w, working(plain('boot', { waiting: w }))]).toEqual([w, true]);
    // Every wait is one or the other.
    expect([...turn, ...karto]).toHaveLength(19);
    expect(working(plain('order'))).toBe(true);
    expect(working(plain('install'))).toBe(true);
    for (const kind of ['retry', 'fatal', 'wrong_phrase'] as const) expect(working(plain('boot', { error: { kind, message: 'x' } }))).toBe(false);
    expect(working(plain('boot', { waiting: 'network', error: { kind: 'retry', message: 'x' } }))).toBe(false);
    expect(working(plain('done'))).toBe(false);
  });

  it('names what is done, in order, and nothing at the first step', () => {
    expect(doneSummary(plain('country'))).toBeNull();
    expect(doneSteps(plain('country'), NOW, 0)).toEqual([]);
    expect(doneSummary(plain('pay'))).toBe('Done: country, email, order');
    expect(doneSummary(plain('pair'))).toBe('Done: country, email, order, payment, start, install');
    expect(doneSummary(rebuilding('pair', { target: { kind: 'new' } }))).toBe('Done: country, email, backup, where, order, payment, start, old server, install');
    expect(doneSummary(plain('done'))).toBe('Done: country, email, order, payment, start, install, pairing');
  });

  it('says what each finished step settled', () => {
    const s = rebuilding('retire', { backup: KEPT, target: { kind: 'new' } }, { vmId: 1003, host });
    expect(doneSteps(s, NOW, 0)).toEqual([
      { step: 'country', name: 'country', label: 'Country', line: null },
      { step: 'email', name: 'email', label: 'Email', line: null },
      { step: 'backup', name: 'backup', label: 'Choose a backup', line: 'Today at 13:00 · 3 cards · 48,210 sat' },
      { step: 'where', name: 'where', label: 'Choose where', line: 'A new server' },
      { step: 'order', name: 'order', label: 'Order the server', line: 'VM 1003' },
      { step: 'pay', name: 'payment', label: 'Pay', line: null },
      { step: 'boot', name: 'start', label: 'Start the server', line: 'vm-1003.lnvps.cloud · 45.67.89.170' },
    ]);
    // The backup's time as the phone's clock has it: a day later it is yesterday's.
    expect(doneSteps(s, NOW + 86_400, 0)[2].line).toBe('Yesterday at 13:00 · 3 cards · 48,210 sat');
  });

  it('leaves out the steps that never ran', () => {
    // In place: nothing is ordered or paid.
    const inPlace = rebuilding('install', { backup: KEPT, target: { kind: 'in_place', vmId: 1009 } }, { vmId: 1009, host });
    expect(doneSummary(inPlace)).toBe('Done: country, email, backup, where, start, old server');
    expect(doneSteps(inPlace, NOW, 0).map((x) => x.step)).toEqual(['country', 'email', 'backup', 'where', 'boot', 'retire']);
    expect(doneSteps(inPlace, NOW, 0)[3]).toMatchObject({ label: 'Choose where', line: 'In place on VM 1009' });
    // A typed-in phrase whose server is still paid: it was found, not ordered, and nothing was paid.
    const found = plain('install', { restoring: true, vmId: 1009, host });
    expect(doneSummary(found)).toBe('Done: country, email, server found, start');
    expect(doneSteps(found, NOW, 0)[2]).toEqual({ step: 'order', name: 'server found', label: 'Find the server', line: 'VM 1009' });
    // The same phrase with no server left rebuilds, and orders and pays as a rebuild does.
    expect(doneSummary(plain('boot', { restoring: true, rebuild: { source: 'new_phone', target: { kind: 'new' } } }))).toBe('Done: country, email, backup, where, order, payment');
  });
});

// The page the setup ends on.
describe('readyView', () => {
  const NOW = Date.UTC(2026, 9, 10, 15, 0) / 1000;
  const OCT17 = Date.UTC(2026, 9, 17, 8, 0) / 1000;
  const done = (o: Partial<OnboardingState> = {}): OnboardingState => ({ ...initialState('GBR'), step: 'done', ...o });
  const KEPT = { kind: 'kept' as const, name: 'ab-3-1.age', created: NOW - 60, cards: 3, totalMsat: 1000 };

  it('greets a new setup, with the date when LNVPS gave one', () => {
    expect(readyView(done(), OCT17, NOW, 0)).toEqual({
      tone: 'ok', mark: 'check', title: 'Your server is ready', line: 'It’s paid for until 17 Oct, and this phone is paired with it. Next, add your first card.',
    });
    expect(readyView(done(), null, NOW, 0).line).toBe('This phone is paired with it. Next, add your first card.');
    // Another year says so.
    expect(readyView(done(), Date.UTC(2027, 0, 3, 8, 0) / 1000, NOW, 0).line).toContain('until 3 Jan 2027,');
  });

  it("tells a typed-in phrase's phone that it is paired with the server it found", () => {
    expect(readyView(done({ restoring: true }), OCT17, NOW, 0)).toMatchObject({
      title: 'Your server is ready', line: 'This phone is now paired with your server. It’s paid for until 17 Oct.',
    });
    expect(readyView(done({ restoring: true }), null, NOW, 0).line).toBe('This phone is now paired with your server.');
  });

  it('says after a rebuild from a backup that each card must be held to the phone, and frozen again if it was frozen since, from the server page or a new phone', () => {
    const line =
      'No card can pay until you hold it to the phone: each one is marked in the wallet, and one that still points at the old server is re-pointed then. ' +
      'Cards you froze after this backup was made are active again: freeze them again.';
    for (const s of [done({ rebuild: { source: 'server_page', backup: KEPT } }), done({ restoring: true, rebuild: { source: 'new_phone', backup: KEPT } })]) {
      expect(readyView(s, OCT17, NOW, 0)).toEqual({ tone: 'ok', mark: 'check', title: 'Your server is rebuilt', line: `It’s paid for until 17 Oct. ${line}` });
      expect(readyView(s, null, NOW, 0).line).toBe(line);
    }
  });

  it('says after a rebuild from the phrase alone that no cards are listed', () => {
    const s = done({ restoring: true, rebuild: { source: 'new_phone', backup: { kind: 'phrase_only' } } });
    const line = 'No cards are listed yet: hold each card to the phone to add it back. All the money is in Pool.';
    expect(readyView(s, OCT17, NOW, 0)).toMatchObject({ title: 'Your server is rebuilt', line: `It’s paid for until 17 Oct. ${line}` });
    expect(readyView(s, null, NOW, 0).line).toBe(line);
  });
});

// A drop is a wait, said in the wait's place.
describe('a connection that dropped', () => {
  const at = (o: Partial<OnboardingState>): OnboardingState => ({ ...initialState('GBR'), step: 'install', waiting: 'reconnect', ...o });
  const cut = { n: 1, during: 'command' as const, last: 'Broken pipe' };

  it('says the connection dropped and which step it carries on from, by the step\'s own label', () => {
    expect(statusLine(at({ installed: ['upload'], drops: cut }))).toBe("The connection to your server dropped. Carrying on from “Wait for the server's first boot”.");
    expect(statusLine(at({ installed: [], drops: { ...cut, during: 'upload' } }))).toBe('The connection to your server dropped. Carrying on from “Upload the server files”.');
    expect(statusLine(at({ installed: ['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore'], drops: { ...cut, n: 3 } })))
      .toBe('The connection to your server dropped. Carrying on from “Start the services”.');
  });

  it('says so without a step at pairing, and once every listed step is done', () => {
    expect(statusLine(at({ step: 'pair', drops: cut }))).toBe('The connection to your server dropped. Carrying on.');
    expect(statusLine(at({ installed: ['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta'], drops: cut }))).toBe('The connection to your server dropped. Carrying on.');
  });

  // Not blamed on the phone: a new server whose SSH is not up yet, or one that is down, reads the same from here.
  it('says the server isn\'t answering when no connection could be made', () => {
    for (const step of ['install', 'pair'] as const) {
      expect(statusLine(at({ step, drops: { ...cut, during: 'connect' } }))).toBe('Your server isn’t answering yet. Trying again…');
    }
    expect(statusLine(at({}))).toBe('Your server isn’t answering yet. Trying again…');
  });

  // A rebuild's step 4 talks to the old server.
  it('names the old server at a rebuild\'s step 4', () => {
    expect(statusLine(at({ step: 'retire', drops: cut }))).toBe('The connection to the old server dropped. Carrying on.');
    expect(statusLine(at({ step: 'retire', drops: { ...cut, during: 'upload' } }))).toBe('The connection to the old server dropped. Carrying on.');
  });

  it('is working, not the person\'s turn, and shows an error over it', () => {
    expect(working(at({ drops: cut }))).toBe(true);
    expect(statusLine(at({ waiting: undefined, error: { kind: 'retry', message: 'Karto Wallet can’t keep a connection to your server.' } }))).toBe('Karto Wallet can’t keep a connection to your server.');
  });
});

describe('stepRows', () => {
  const steps = ['upload', 'first-boot', 'swap', 'docker'] as const;
  it("shows the running step's time counting up, a finished step's time kept, and none for a step done before this run", () => {
    const rows = stepRows(steps, ['upload', 'first-boot', 'swap'], { stepMs: { 'first-boot': 72_400, swap: 900 }, stepStartedAt: { step: 'docker', at: 1_000 } }, 43_500, true);
    expect(rows.map((r) => [r.step, r.status, r.time])).toEqual([
      ['upload', 'done', null],
      ['first-boot', 'done', '1 min 12.4 s'],
      ['swap', 'done', '0.9 s'],
      ['docker', 'current', '42 s'],
    ]);
  });
  it('says each row aloud with a label that does not change each second', () => {
    const rows = stepRows(steps, ['upload', 'first-boot'], { stepMs: { 'first-boot': 72_400 }, stepStartedAt: { step: 'swap', at: 0 } }, 5_000, true);
    expect(rows.map((r) => r.spoken)).toEqual([
      'Upload the server files, done',
      "Wait for the server's first boot, done, 1 minute 12.4 seconds",
      'Add swap, running',
      'Install Docker, to do',
    ]);
  });
  it('shows no running time once the run has stopped, or without a clock', () => {
    const t = { stepStartedAt: { step: 'swap' as const, at: 0 } };
    expect(stepRows(steps, ['upload', 'first-boot'], t, 5_000, false)[2].time).toBeNull();
    expect(stepRows(steps, ['upload', 'first-boot'], t, null, true)[2].time).toBeNull();
  });
});

describe('the install log lines', () => {
  it('writes one line per finished step, with its run', () => {
    expect(installLogLine('update', 'docker', 71_234)).toBe('CARDAPP-INSTALL {"run":"update","step":"docker","ms":71234}');
    const prev = { ...initialState('GBR'), step: 'install' as const, installed: ['upload' as const], stepMs: { upload: 5 } };
    const s = { ...prev, installed: ['upload' as const, 'first-boot' as const], stepMs: { upload: 5, 'first-boot': 61_000 } };
    expect(newInstallLogLines(prev, s)).toEqual(['CARDAPP-INSTALL {"run":"setup","step":"first-boot","ms":61000}']);
    expect(newInstallLogLines(prev, { ...s, rebuild: {} as never })).toEqual(['CARDAPP-INSTALL {"run":"rebuild","step":"first-boot","ms":61000}']);
    expect(newInstallLogLines(s, s)).toEqual([]);
  });
});

describe('finished step times in tenths of a second', () => {
  it('writes "48.4 s" or "2 min 5.9 s", rounding down, and says it aloud the same', () => {
    const done = (ms: number) => stepRows(['upload'], ['upload'], { stepMs: { upload: ms } }, 0, true)[0];
    expect([48_415, 323, 2_000, 60_050, 125_990].map((ms) => done(ms).time)).toEqual(['48.4 s', '0.3 s', '2.0 s', '1 min', '2 min 5.9 s']);
    expect([48_415, 323, 1_000, 2_000, 60_050, 125_990].map((ms) => done(ms).spoken)).toEqual([
      'Upload the server files, done, 48.4 seconds',
      'Upload the server files, done, 0.3 seconds',
      'Upload the server files, done, 1 second',
      'Upload the server files, done, 2 seconds',
      'Upload the server files, done, 1 minute',
      'Upload the server files, done, 2 minutes 5.9 seconds',
    ]);
  });
});

describe("the running step's time in plain seconds (\"1.1 s\", not \"0:01.1\")", () => {
  it('counts "5 s", "59 s", "1 min", "1 min 3 s"', () => {
    const running = (ms: number) => stepRows(['upload'], [], { stepStartedAt: { step: 'upload', at: 0 } }, ms, true)[0].time;
    expect([5_400, 59_999, 60_000, 63_200, 125_000].map(running)).toEqual(['5 s', '59 s', '1 min', '1 min 3 s', '2 min 5 s']);
  });
});
