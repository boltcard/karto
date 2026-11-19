// Onboarding as a resumable state machine. advance() does the
// current step's work once and returns the next state; the caller saves every
// state it gets back (and every checkpoint), so the app can be killed at any
// point and pick up where it stopped. Every step is safe to repeat.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ageDecrypt } from '../backup/age';
import type { BackupFiles, ServerLatest, SnapshotSummary } from '../backup/backups';
import { CarddError, isRevoked, type CarddClient } from '../cardd/client';
import type { DerivedKeys } from '../keys/derive';
import { bolt11ExpiresAtMs, isNetworkFailure, LnurlHttpError, type FetchFn } from '../lightning/lightning';
import { getVmOrNull, LnvpsClient, LnvpsError, vatGuard, type Account, type Vm } from '../lnvps/client';
import { MailTmClient, MailTmError, MAX_VERIFY_LINKS } from '../mailtm/client';
import { keyId } from '../cardd/deviceauth';
import { hexToBytes } from '@noble/hashes/utils.js';
import { bundleSha } from '../deploy/bundle';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import {
  addDevice, finalSnapshot, FinalSnapshotRefused, install, InstallError, INSTALL_STEPS, isRetired, phoenixdState, RecoveryCheckRunning, recoveryCheckRunning,
  retireServer, revokeOthers, SECRET_STEPS, uploadBundle,
  type BundleFile, type InstallOptions, type InstallStep, type Restore, type UploadProgress,
} from './install';
import { downloadLatest, notNewest, olderNotice, SnapshotRefused, timeText } from './rebuild';
import { HostKeyMismatchError, SshAuthError, SshDropped, type PinnedHostKey, type SshConnect, type SshScan, type SshSession } from './ssh';

// backup, where and retire are a rebuild's: onboarding never visits them.
// The old server is retired before the new one is given the seed, so the two never run phoenixd on it at once. On a
// new VM, or in place on another VM, the install first runs the steps that carry no secret and waits for LNVPS to
// confirm the new server's key (install, up to host-key), wipes a VM rebuilt in place, then step 4 retires the old
// server, then the install goes on (install, from the seed): until then the old server keeps running, and stays if
// the new one is never confirmed.
// In place on the old server's own VM, step 4 comes first, its final snapshot before the wipe, once LNVPS has
// confirmed that VM's key (boot waits for it).
export const STEPS = ['country', 'email', 'backup', 'where', 'order', 'pay', 'boot', 'retire', 'install', 'pair', 'done'] as const;
export type Step = (typeof STEPS)[number];
export const REBUILD_STEPS: readonly Step[] = ['backup', 'where', 'retire'];

/**
 * The choose_ and confirm_ waits are for the person (the screen sets what they wait for through the
 * runner's update()); old_vm_starting is for the old server to answer SSH after LNVPS starts it;
 * old_payment for a day paid on an expired old server, so that it can be retired properly;
 * recovery_check for install.sh recovery-check to end on the old server (it starts its phoenixd again);
 * reconnect for the connection to the server being set up, which dropped (drops says how often in a row);
 * host_key_confirm for LNVPS to publish the SSH key of a server trusted on first use, before any secret goes to it.
 */
export type Waiting =
  | 'email' | 'payment' | 'order_expiring' | 'boot' | 'host_keys' | 'host_key_confirm' | 'health' | 'network' | 'old_unreachable'
  | 'choose_vm' | 'choose_backup' | 'confirm_older' | 'choose_where' | 'confirm_retire' | 'old_vm_starting' | 'confirm_reinstall'
  | 'confirm_expired' | 'old_payment' | 'recovery_check' | 'reconnect' | 'pay_days' | 'lnvps_busy' | 'mailtm_busy';
export type ErrorKind = 'retry' | 'fatal' | 'wrong_phrase';

/**
 * keySource: 'lnvps' when the pinned key is the one LNVPS published; 'first_use' when it is
 * the one the server presented before LNVPS had it. The install sends the server no secret until
 * LNVPS publishes the same key (the step host-key), which makes it 'lnvps'.
 * Older saved states have no keySource: they pinned LNVPS's key.
 * trustedAt: when a first-use key was trusted (ms); kept once LNVPS confirms it, so the setup still lists the wait.
 * secretsHeld: the key was trusted by an app that sends no secret before LNVPS confirms it (host-key). Without it, a
 * first-use key is an older app's, which may have sent the seed and the card key over it (secretsAt).
 */
export type ServerHost = {
  ipv4: string; hostname: string; user: string; hostKey: PinnedHostKey; keySource?: 'lnvps' | 'first_use'; trustedAt?: number; secretsHeld?: boolean;
};

/**
 * What a key LNVPS hasn't confirmed may have been given, for the words about it: 'unsent' when this app held the
 * secrets back and no secret step has run; 'maybe_sent' for any other first-use key (an older app's install, which
 * didn't wait); null for a key LNVPS published.
 */
export function secretsAt(s: Pick<OnboardingState, 'host' | 'installed'>): 'unsent' | 'maybe_sent' | null {
  if (s.host?.keySource !== 'first_use') return null;
  return s.host.secretsHeld && !s.installed.some((x) => SECRET_STEPS.includes(x)) ? 'unsent' : 'maybe_sent';
}

/** The sentence on what a server that can't be trusted was given, and what to do: none for a key LNVPS published. */
export function secretsWords(s: Pick<OnboardingState, 'host' | 'installed'>): string | null {
  switch (secretsAt(s)) {
    case 'unsent': return 'Your wallet seed and card key were not sent to it. Stop using this server.';
    case 'maybe_sent': return 'Your wallet seed and card key may have been sent to it. Stop using this server and this recovery phrase.';
    case null: return null;
  }
}

/** What a rebuild restores: a snapshot kept on this phone (its file's name and what it holds), or nothing but the phrase. */
export type ChosenBackup = { kind: 'kept'; name: string; created: number; cards: number; totalMsat: number } | { kind: 'phrase_only' };

/**
 * How step 4 left the old server; at is ms. Only retired, reinstalled, empty (it holds no phoenixd
 * seed) and in_place mean it can't run phoenixd again. overSsh: the override was confirmed after retiring
 * over SSH kept failing, the old server known to run (the check before up lets it be).
 */
export type RetireRecord = {
  result: 'retired' | 'gone' | 'expired' | 'reinstalled' | 'empty' | 'override' | 'in_place'; at: number; deletingOn?: string; overSsh?: boolean;
};

/**
 * A rebuild in progress: where it started, steps 1, 2 and 4's choices and
 * record, and the server it replaces (oldVm: its id, and its pinned key to reach it).
 * others: step 4's records of other VMs of the phrase it saw to before the look before up sent it
 * to this one, which that look reads by the same rules.
 * target: in place, retired: a rebuild had retired that VM when it was chosen (retiredVms), so it can't
 * run a wallet and LNVPS may start it.
 * confirm: what the person has confirmed, each with its button: an older backup, in place
 * (Rebuild on VM), retiring the old server, re-installing it, the override (for what it was given:
 * going on while neither the old server nor LNVPS answered, or after attempts over SSH failed);
 * and for an expired old server, a button: paying it a day (payOld) or not (expired).
 * backupLocked: step 4 has run, so step 1's choice stays (withBackup).
 * reachingSince: when step 4 began waiting for the old server's SSH through LNVPS (ms).
 * retireTries: step 4's attempts over SSH; after RETIRE_TRIES_BEFORE_OVERRIDE the override is offered.
 * fetchFailed: the last of them failed fetching the final snapshot it had just made (the override then
 * goes on without that snapshot, and still retires the old server).
 * rewipe: a newer final snapshot replaced a backup the install had restored already: the install
 * wipes and restores again, on any target.
 * oldInvoice: the day's invoice for an expired old server (expiresAt in LNVPS's time, ms).
 * before: what startRebuild cleared, so that Cancel rebuild puts the server page back as it was.
 */
export type Rebuild = {
  source: 'server_page' | 'new_phone';
  before?: RebuildBefore;
  backup?: ChosenBackup;
  target?: { kind: 'new' } | { kind: 'in_place'; vmId: number; retired?: boolean };
  oldVm?: { id: number; host?: ServerHost };
  retire?: RetireRecord;
  others?: (RetireRecord & { id: number })[];
  confirm?: { older?: boolean; inPlace?: boolean; retire?: boolean; reinstall?: boolean; override?: Override; payOld?: boolean; expired?: boolean };
  backupLocked?: boolean;
  reachingSince?: number;
  retireTries?: number;
  fetchFailed?: boolean;
  rewipe?: boolean;
  oldInvoice?: { bolt11: string; sat: number; expiresAt: number };
};

/** What the override was confirmed for (overrideFor): it is only ever taken for that. */
export type Override = 'unreachable' | 'ssh';

/** The parts of the state a rebuild starts afresh. */
export type RebuildBefore = Pick<OnboardingState, 'step' | 'vmId' | 'host' | 'hostKeyMismatch' | 'installed' | 'deviceKeyId' | 'othersRevoked' | 'notice'> & {
  /** An earlier rebuild's record (the old VM it left to watch), which Cancel rebuild puts back. */
  rebuild?: Rebuild;
};

export type OnboardingState = {
  step: Step;
  /** Chosen by the user before the country step (ISO alpha-3). */
  country?: string;
  /** Days of hosting to pay for; the user may change it on the pay screen. */
  payDays: number;
  /** When the days were last changed on the pay screen (ms): no invoice is asked for until the presses stop. */
  payDaysAt?: number;
  /** The VM's price of a day from LNVPS's quote, kept while the days change and asked again when an invoice runs out. */
  payPrice?: { vmId: number; satPerDay: number };
  /** After LNVPS answered 429 to an invoice: none is asked for before this (ms). */
  invoiceBusyUntil?: number;
  mailtmAddress?: string;
  /** Verification links LNVPS refused (400, 404 or 410): never opened again (at most 100, the newest kept). */
  emailLinksRefused?: string[];
  /**
   * Verification links that opened without verifying this account, or failed unrefused in a pass that found a
   * full five, and when (ms): passed over for 10 minutes.
   */
  emailLinksOpened?: { link: string; at: number }[];
  /** After LNVPS answered 429: nothing is opened before this (ms). */
  emailBusyUntil?: number;
  /** After mail.tm answered 429: mail.tm is asked nothing before this (ms). */
  mailtmBusyUntil?: number;
  sshKeyId?: number;
  vmId?: number;
  /** When LNVPS deletes the order if it is still unpaid (ms, LNVPS's clock): the pay screen's countdown. */
  orderDeadline?: number;
  /** While waiting for the ed25519 host key: the key types LNVPS does list (for the log). */
  hostKeyTypes?: string[];
  /** expiresAt: from the invoice itself, on LNVPS's clock (ms). */
  invoice?: { vmId: number; sat: number; days: number; bolt11: string; expiresAt: number };
  /**
   * When the VM was first seen running (ms), to time out waiting for host keys; in a rebuild in place on the old
   * server's own VM, when boot began waiting for LNVPS to confirm its key.
   */
  runningSince?: number;
  host?: ServerHost;
  /** Set when LNVPS later published a different key than the one trusted on first use. */
  hostKeyMismatch?: string;
  installed: InstallStep[];
  deviceKeyId?: string;
  /** Every other paired phone revoked, once this one is paired. */
  othersRevoked?: boolean;
  /** The phrase was typed back in (Welcome's "I already have a recovery phrase"), not made here. */
  restoring?: boolean;
  /** VMs whose server a rebuild retired (or re-installed): order passes them over, and the look before up knows them. */
  retiredVms?: number[];
  /** A new phone's phrase with more than one paid server: the ones offered, and the one the person chose. */
  vmChoices?: { id: number; expires: string }[];
  chosenVmId?: number;
  rebuild?: Rebuild;
  /** Something the person should know that is neither a wait nor an error, such as a VM passed over. */
  notice?: string;
  /** Nothing to do until something outside the app happens; call advance again later. */
  waiting?: Waiting;
  /** When a recovery check on the old server began holding things up (ms); cleared once one advance meets none. */
  checkSince?: number;
  /** When this install began (ms), for the setup screen's minutes; only ever on the install step (advance). */
  installSince?: number;
  /** The install step running and when it began (ms), for its time; kept across a drop and a closed app. */
  stepStartedAt?: { step: InstallStep; at: number };
  /** Each install step finished in this visit of the install step, its time in ms. */
  stepMs?: Partial<Record<InstallStep, number>>;
  /**
   * The connection to the server being set up dropped: how
   * often in a row with nothing finished between, which part of the last one failed, and the phone's own words
   * for it (for the log). Kept only while waiting to connect again.
   */
  drops?: { n: number; during: SshDropped['during']; last: string };
  error?: { kind: ErrorKind; message: string };
};

/** The pay screen's day buttons, and where it starts. */
export const PAY_DAY_PRESETS = [7, 14, 30] as const;
export const DEFAULT_PAY_DAYS = 7;

export const initialState = (country?: string): OnboardingState => ({ step: 'country', country, payDays: DEFAULT_PAY_DAYS, installed: [] });

export const MIN_PAY_DAYS = 1;
export const MAX_PAY_DAYS = 365;

/**
 * The pay screen's day picker: whole days within bounds; a change needs a new invoice. at: when it was pressed (ms),
 * so the invoice waits until the presses stop (PAY_DAYS_SETTLE_MS).
 */
export function withPayDays(s: OnboardingState, days: number, at?: number): OnboardingState {
  const payDays = Number.isFinite(days) ? Math.min(MAX_PAY_DAYS, Math.max(MIN_PAY_DAYS, Math.round(days))) : s.payDays;
  return payDays === s.payDays ? s : { ...s, payDays, invoice: undefined, payDaysAt: at };
}

/** What the days cost at a price of a day: whole sats, at least LNVPS's minimum. */
export const paySat = (days: number, satPerDay: number): number => Math.max(MIN_PAYMENT_SAT, Math.ceil(days * satPerDay));

/**
 * How long after the last press of a day button the invoice is asked for: LNVPS allows about five
 * invoices a minute for a VM, and a press each made one, so stepping from 7 days down to 1 was refused with a 429.
 */
export const PAY_DAYS_SETTLE_MS = 800;
/** After a 429 to an invoice none is asked for this long: LNVPS's limit is per minute. */
export const INVOICE_BUSY_WAIT_MS = 60 * 1000;

/**
 * App data comes back from Android's backup but Keystore keys don't: if the
 * key this phone has now isn't the one paired, pair it (before onboarding is
 * done; afterwards that is restore's job).
 */
export function reconcileDevice(s: OnboardingState, publicKeyHex: string): OnboardingState {
  if (s.step === 'done' || !s.deviceKeyId || s.deviceKeyId === keyId(hexToBytes(publicKeyHex))) return s;
  return { ...s, deviceKeyId: undefined };
}

export type Deps = {
  keys: DerivedKeys;
  lnvps: LnvpsClient;
  mailtm: MailTmClient;
  /** Plain HTTPS: the verification link and the new server's /health. */
  fetch: FetchFn;
  ssh: SshConnect;
  /** The server's host key without logging in, for trust on first use. */
  scanHostKey: SshScan;
  bundle: () => Promise<BundleFile[]>;
  device: { publicKeyHex: string; name: string };
  /** The phone's kept snapshots, which a rebuild restores from, the old server's final one among them. */
  backups: Pick<BackupFiles, 'list' | 'read' | 'write' | 'remove'> & {
    /** Opens a kept snapshot with the phrase and reads what it holds; null if it can't be opened. */
    inspect(name: string): Promise<SnapshotSummary | null>;
  };
  /** The server's latest snapshot as the phone last noted it, or null. */
  serverLatest: () => Promise<ServerLatest | null>;
  /** cardd's API on another server of this phrase: a rebuild's old one, for its latest snapshot. */
  oldCardd: (host: string) => Pick<CarddClient, 'backups' | 'backupFile'>;
  now: () => number;
  /** Saves progress made inside a step (each finished install step). */
  checkpoint: (s: OnboardingState) => Promise<void>;
  /** The install's upload as it goes, for the screen (the runner sets it); never part of the saved state. */
  onUpload?: (p: UploadProgress) => void;
};

export const HOST_KEY_WAIT_MS = 10 * 60 * 1000;
/** LNVPS publishes a new server's key about an hour after it starts: twice that is a warning. */
export const HOST_KEY_CONFIRM_WAIT_MS = 2 * 60 * 60 * 1000;
/**
 * How long the install waits at host-key for LNVPS to publish the server's key before it offers Try again: LNVPS
 * reads a new server's key about an hour after it starts, then hourly, so three hours is more than it should take.
 */
export const HOST_KEY_CONFIRM_LIMIT_MS = 3 * 60 * 60 * 1000;
export const HOST_KEY_UNCONFIRMED =
  'LNVPS still hasn’t confirmed your server after 3 hours; it normally does within about an hour of the server starting. ' +
  'Your wallet seed and card key have not been sent to the server. Try again to keep waiting, or ask LNVPS why your ' +
  'server’s SSH key isn’t listed.';
/** The same, for a server an older app set up without waiting for LNVPS: what it was sent then is not known. */
export const HOST_KEY_UNCONFIRMED_OLDER =
  'LNVPS still hasn’t confirmed your server after 3 hours. It was set up before Karto Wallet waited for LNVPS, so your ' +
  'wallet seed and card key may already have been sent to it; nothing more is sent until LNVPS confirms it. Try again to ' +
  'keep waiting, or ask LNVPS why your server’s SSH key isn’t listed.';
/** The same, at a rebuild's boot in place on the old server's own VM, before anything is retired or wiped. */
export const HOST_KEY_UNCONFIRMED_IN_PLACE =
  'LNVPS still hasn’t confirmed your server after 3 hours, so nothing on it has been retired or wiped. Try again to keep ' +
  'waiting, or ask LNVPS why your server’s SSH key isn’t listed.';
export const INVOICE_RENEW_BEFORE_MS = 60 * 1000;
/** For an invoice whose expiry can't be read: assume it is short. */
const INVOICE_FALLBACK_LIFETIME_MS = 5 * 60 * 1000;
export const MIN_PAYMENT_SAT = 100;
/** LNVPS deletes an order that is still unpaid an hour after it was made. */
export const ORDER_LIFETIME_MS = 60 * 60 * 1000;
/** Only resume an unpaid order with at least this long left. */
export const REUSE_ORDER_MIN_LEFT_MS = 20 * 60 * 1000;
/** Stop offering an invoice this long before the order is deleted, so nobody pays for a VM that is gone. */
export const STOP_INVOICING_BEFORE_DEADLINE_MS = 10 * 60 * 1000;

class StepError extends Error {
  constructor(readonly kind: ErrorKind, message: string) {
    super(message);
  }
}

/** The old server runs again although step 4 never retired it over SSH: step 4 again. */
class OldServerRunning extends StepError {}

export async function advance(state: OnboardingState, deps: Deps): Promise<OnboardingState> {
  const s: OnboardingState = { ...state, waiting: undefined, error: undefined };
  // The caller saves what we return after any checkpoint, so an error must
  // carry the latest checkpointed state, not the state we started from.
  let latest = s;
  const d: Deps = {
    ...deps,
    checkpoint: async (x) => {
      latest = x;
      await deps.checkpoint(x);
    },
  };
  const step = async (): Promise<OnboardingState> => {
    switch (s.step) {
      case 'country': return await country(s, d);
      case 'email': return await email(s, d);
      case 'backup': return await chooseBackup(s, d);
      case 'where': return await chooseWhere(s, d);
      case 'order': return await order(s, d);
      case 'pay': return await pay(s, d);
      case 'retire': return await retireOld(s, d);
      case 'boot': return await boot(s, d);
      case 'install': return await installStep(s, d);
      case 'pair': return await pair(s, d);
      case 'done': return s;
    }
  };
  // The install's start and its steps' times belong to the install step alone: whichever way the step is left (on to
  // pair, back to order or to retire), the next install starts its minutes, and its steps' times, from nought.
  const since = (x: OnboardingState): OnboardingState =>
    x.step === 'install' || (x.installSince === undefined && x.stepMs === undefined && x.stepStartedAt === undefined)
      ? x
      : { ...x, installSince: undefined, stepMs: undefined, stepStartedAt: undefined };
  // The count of drops is kept only by the wait for the connection: anything else that comes back ends the row.
  // An error at the install step (a step's own failure, the drops running out, a refusal before the steps) ends the
  // running step: Try again times it afresh. A drop's wait keeps it.
  const ended = (x: OnboardingState): OnboardingState => (x.step === 'install' && x.error && x.stepStartedAt ? { ...x, stepStartedAt: undefined } : x);
  const settle = (x: OnboardingState): OnboardingState => ended(since(x.waiting === 'reconnect' || x.drops === undefined ? x : { ...x, drops: undefined }));
  try {
    return settle({ ...(await step()), checkSince: undefined });
  } catch (e) {
    // The connection to the server being set up, before the older tests: one of them goes by an error's words,
    // and the iPhone's words for a drop are not known. A rebuild's step 4 talks to the old server and has its own rules.
    if (e instanceof SshDropped && (latest.step === 'install' || latest.step === 'pair')) return settle(dropped(e, latest));
    if (e instanceof OldServerDropped) return settle(oldServerWait(e, latest));
    // A recovery check on the old server: wait for it, from the same step, up to RECOVERY_CHECK_WAIT_MS.
    if (e instanceof RecoveryCheckRunning) return settle(recoveryCheckWait(latest, d));
    // The phone's network, not a fault: ask again shortly, from the same step.
    if (isNetworkFailure(e)) return settle({ ...latest, waiting: 'network' });
    return settle({ ...latest, checkSince: undefined, error: classify(e, latest) });
  }
}

/**
 * How long a recovery check on the old server may hold step 4 or the install up: its 15 minutes and its
 * settling. One that runs longer is hung (a wedged Docker daemon, say), and keeps install.sh's lock for good.
 */
export const RECOVERY_CHECK_WAIT_MS = 20 * 60 * 1000;

const CHECK_RUNNING_TEXT = 'The old server is busy with a recovery check or another install step: waiting for it to finish.';

/** Whether the recovery check on the old server has held things up past RECOVERY_CHECK_WAIT_MS. */
const checkHung = (s: OnboardingState, d: Pick<Deps, 'now'>) => s.checkSince !== undefined && d.now() - s.checkSince >= RECOVERY_CHECK_WAIT_MS;

/**
 * A wait for the recovery check, from when it began; past RECOVERY_CHECK_WAIT_MS, an error that says how to end
 * it. Its attempts then count as any other's (failedAttempt), so the override comes in the usual way.
 */
function recoveryCheckWait(s: OnboardingState, d: Pick<Deps, 'now'>): OnboardingState {
  const since = s.checkSince ?? d.now();
  if (!checkHung({ ...s, checkSince: since }, d)) return { ...s, checkSince: since, waiting: 'recovery_check' };
  const vm = s.rebuild?.oldVm?.id ?? s.vmId;
  return {
    ...s, checkSince: since,
    error: {
      kind: 'retry',
      message: `The recovery check on the old server hasn't ended after ${RECOVERY_CHECK_WAIT_MS / 60_000} minutes. Restart VM ${vm} from LNVPS's site: ` +
        'that stops the check, and the old server finishes it when it next starts. Then try again.',
    },
  };
}

/** The drops in a row that are waited out; the next stops the step. */
export const DROPS_WAITED = 3;
export const KEEPS_DROPPING =
  'Karto Wallet can’t keep a connection to your server. Check this phone’s internet; if that is fine, your server may be down. Then try again.';

/**
 * A dropped connection to the server being set up: a wait, from the same step and the steps saved, and at the
 * drop after DROPS_WAITED in a row an error with words of its own. The runner waits a little longer each time.
 */
function dropped(e: SshDropped, s: OnboardingState): OnboardingState {
  const n = (s.drops?.n ?? 0) + 1;
  if (n > DROPS_WAITED) return { ...s, drops: undefined, error: { kind: 'retry', message: KEEPS_DROPPING } };
  return { ...s, waiting: 'reconnect', drops: { n, during: e.during, last: e.message } };
}

function classify(e: unknown, s: OnboardingState): { kind: ErrorKind; message: string } {
  if (e instanceof StepError) return { kind: e.kind, message: e.message };
  if (e instanceof InstallError && e.kind === 'revoked') {
    return { kind: 'fatal', message: `This server revoked this phone's key, so it can't be paired again with it (${e.message}).` };
  }
  if (e instanceof InstallError) {
    // retired reaches here only in a rebuild (ordinary onboarding passes the VM over): nothing a try again mends.
    const kind = e.kind === 'wrong_phrase' ? 'wrong_phrase' : e.kind === 'bug' || e.kind === 'newer_backup' || e.kind === 'retired' ? 'fatal' : 'retry';
    return { kind, message: e.message };
  }
  // What the server may have been given, said only as far as it is known (secretsAt).
  const given = (head: string) => ({ kind: 'fatal' as const, message: `${head}. ${secretsWords(s) ?? 'Stop using this server.'}` });
  if (e instanceof HostKeyMismatchError && s.host?.keySource === 'first_use' && !s.hostKeyMismatch) {
    return given(`The server's SSH key changed since this app first trusted it: ${e.message}`);
  }
  if (e instanceof HostKeyMismatchError) return given(`The server's SSH key is not the one LNVPS published: ${e.message}`);
  if (e instanceof SshAuthError) {
    return {
      kind: 'retry',
      message: 'The server refused this app\'s SSH key. A new server can take a minute to install it, so try again shortly. ' +
        'If it keeps happening, the server was set up with another recovery phrase.',
    };
  }
  if (e instanceof MailTmError) return { kind: 'retry', message: e.plain ?? MAILTM_FAILED(e.status) };
  return { kind: 'retry', message: e instanceof Error ? e.message : String(e) };
}

/** A mail.tm failure (other than its rate limit, which is waited out) in words. */
export const MAILTM_FAILED = (status: number) => `mail.tm, the inbox for LNVPS's email, didn't answer as it should (HTTP ${status}). Try again in a little while.`;

async function country(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  if (!s.country) throw new StepError('fatal', 'Choose a country first');
  try {
    const account = await d.lnvps.setCountry(s.country);
    const vat = vatGuard(account);
    if (!vat.ok) throw new StepError('fatal', vat.message);
  } catch (e) {
    if (e instanceof LnvpsError && e.status === 400) throw new StepError('fatal', e.message);
    throw e;
  }
  return { ...s, step: 'email' };
}

/** The most refused verification links remembered (emailLinksRefused), the newest kept: their messages are deleted, so few build up. */
const MAX_REFUSED_LINKS = 100;
/** What LNVPS answers a token it doesn't know: only these refuse a link for good. Any other 4xx may be passing (a firewall's 403). */
const LINK_REFUSED = [400, 404, 410];
/**
 * How long a link is passed over that opened without verifying this account (getAccount may have lagged),
 * or that failed without being refused in a pass that found a full five (more may wait behind it).
 */
const OPENED_PASS_OVER_MS = 10 * 60 * 1000;
/** After a 429 nothing is opened for this long: LNVPS's limit (10 a minute) may count the requests it rejects. */
export const EMAIL_BUSY_WAIT_MS = 60 * 1000;
/** After mail.tm's 429 it is asked nothing for this long, as LNVPS after its own. */
export const MAILTM_BUSY_WAIT_MS = 60 * 1000;

/**
 * The email step. An account LNVPS already has with this phrase's address, verified (a restore, or set-up started
 * over), needs nothing of mail.tm: the address's name is the phrase's, whatever mail.tm's domain was then. Otherwise
 * mail.tm's rate limit (429), at any of its calls, is a wait of a minute that the step sits out by itself, from the
 * latest state (the address kept), never an error.
 */
async function email(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  const account = await d.lnvps.getAccount();
  if (account.email_verified && account.email && phrasesAddress(account.email, d.keys.mailtmName)) {
    return { ...s, mailtmAddress: account.email, mailtmBusyUntil: undefined, emailLinksRefused: undefined, emailLinksOpened: undefined, emailBusyUntil: undefined, step: 'order' };
  }
  if (s.mailtmBusyUntil !== undefined && d.now() < s.mailtmBusyUntil) return { ...s, waiting: 'mailtm_busy' };
  let current: OnboardingState = { ...s, mailtmBusyUntil: undefined };
  try {
    return await emailNow(current, d, account, (x) => (current = x));
  } catch (e) {
    if (e instanceof MailTmError && e.status === 429) return { ...current, mailtmBusyUntil: d.now() + MAILTM_BUSY_WAIT_MS, waiting: 'mailtm_busy' };
    throw e;
  }
}

/** Whether an email address is this phrase's mail.tm inbox: its name (before the last @) is the phrase's, in any case. */
const phrasesAddress = (email: string, name: string) => email.slice(0, email.lastIndexOf('@')).toLowerCase() === name.toLowerCase();

/** The email step's work, from the account as read; kept: told each state worth keeping, for a 429's wait to start from. */
async function emailNow(s: OnboardingState, d: Deps, read: Account, kept: (s: OnboardingState) => void): Promise<OnboardingState> {
  if (!s.mailtmAddress) {
    s = { ...s, mailtmAddress: `${d.keys.mailtmName}@${await d.mailtm.domain()}` };
    kept(s);
  }
  const address = s.mailtmAddress!;
  // Open the inbox before setting it on the account, so the email can't arrive first.
  const token = await d.mailtm.open(address, d.keys.mailtmPassword);
  await d.checkpoint(s);
  let account = read;
  if (account.email !== address) {
    await d.lnvps.updateAccount({ email: address });
    return { ...s, waiting: 'email' };
  }
  if (!account.email_verified) {
    // Every LNVPS link in the inbox, in order, each opened once: one LNVPS refuses as it does an unknown
    // token (400, 404, 410: expired, or a look-alike's) is remembered and passed over without counting
    // toward the pass's five, so look-alikes can't spend LNVPS's 10 verify-email requests a minute every
    // pass nor fill the five ahead of its own link; a message holding only such links is deleted at the
    // next pass (a failed delete is ignored: the list still covers it), so a flood can't keep LNVPS's
    // email off mail.tm's first page. One that opened but didn't verify this account (another account's
    // token) is passed over for 10 minutes, its message kept. A 429 ends the pass, and nothing is opened
    // for a minute (LNVPS's limit has tripped). Any other 4xx, a 5xx or a network failure leaves the link
    // for the next pass, the 4xx and 5xx shown as an error with Try again; but when the pass found a full
    // five, those failing are passed over for 10 minutes too, so five failing look-alikes can't take every
    // pass's five ahead of LNVPS's own link.
    const now = d.now();
    if (s.emailBusyUntil !== undefined && now < s.emailBusyUntil) return { ...s, waiting: 'email' };
    let refused = s.emailLinksRefused ?? [];
    let opened = (s.emailLinksOpened ?? []).filter((o) => now - o.at < OPENED_PASS_OVER_MS);
    let failed: number | undefined;
    let busy = false;
    const scan = await d.mailtm.findVerificationLinks(token, refused, opened.map((o) => o.link));
    for (const id of scan.spent) await d.mailtm.deleteMessage(token, id).catch(() => {});
    const full = scan.links.length >= MAX_VERIFY_LINKS;
    const passOver = (link: string) => (opened = [...opened, { link, at: now }].slice(-MAX_REFUSED_LINKS));
    for (const { link } of scan.links) {
      const res = await d.fetch(link);
      if (LINK_REFUSED.includes(res.status)) {
        refused = [...refused, link].slice(-MAX_REFUSED_LINKS);
        continue;
      }
      if (res.status === 429) {
        busy = true;
        break;
      }
      if (!res.ok) {
        failed = res.status;
        if (full) passOver(link);
        continue;
      }
      account = await d.lnvps.getAccount();
      if (account.email_verified) break;
      passOver(link);
    }
    if (account.email_verified) s = { ...s, emailLinksRefused: undefined, emailLinksOpened: undefined, emailBusyUntil: undefined };
    else {
      s = {
        ...s,
        emailLinksRefused: refused.length ? refused : undefined,
        emailLinksOpened: opened.length ? opened : undefined,
        emailBusyUntil: busy ? now + EMAIL_BUSY_WAIT_MS : undefined,
      };
      // Returned as state, not thrown, so the refused links are saved with it. After a 429 the polls go on
      // (a minute later), whatever failed before it: an error would stop them until Try again.
      if (failed !== undefined && !busy) return { ...s, error: { kind: 'retry', message: `opening the verification link gave HTTP ${failed}` } };
      return { ...s, waiting: 'email' };
    }
  }
  return { ...s, step: 'order' };
}

/** The account's name for our key: stable for one phrase, distinct from other keys. */
export const sshKeyName = (keys: DerivedKeys) => `card-app-${bytesToHex(sha256(utf8ToBytes(keys.sshAuthorizedKey))).slice(0, 8)}`;

async function order(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  let sshKeyId = s.sshKeyId;
  if (sshKeyId === undefined) {
    const name = sshKeyName(d.keys);
    const existing = (await d.lnvps.listSshKeys()).find((k) => k.name === name);
    sshKeyId = existing?.id ?? (await d.lnvps.addSshKey(name, d.keys.sshAuthorizedKey)).id;
    s = { ...s, sshKeyId };
    await d.checkpoint(s);
  }
  const now = d.lnvps.serverTime();
  const mine = (await d.lnvps.listVms()).filter((v) => v.ssh_key?.id === sshKeyId && !s.retiredVms?.includes(v.id));
  // This phrase already has a paid VM (onboarding started over, or a repeat test):
  // set that one up again rather than buying another. Every install step can be re-run.
  // Not in a rebuild onto a new VM: the paid one is the old server.
  const latestFirst = (vms: Vm[]) => vms.filter((v) => v.expires).sort((a, b) => Date.parse(b.expires!) - Date.parse(a.expires!));
  const paid = latestFirst(mine).filter((v) => Date.parse(v.expires!) > now);
  if (paid.length && !s.rebuild) {
    // More than one server asks which: the look before up may refuse one for another.
    const vm = paid.length > 1 ? paid.find((v) => v.id === s.chosenVmId) : paid[0];
    if (!vm) return { ...s, vmChoices: paid.map((v) => ({ id: v.id, expires: v.expires! })), chosenVmId: undefined, waiting: 'choose_vm' };
    // The same VM again (the look before up refused it): its install resumes where it stopped.
    const another = vm.id !== s.vmId && { installed: [], hostKeyMismatch: undefined };
    return { ...s, ...another, vmId: vm.id, vmChoices: undefined, orderDeadline: undefined, invoice: undefined, step: 'boot' };
  }
  // A phrase typed back in with no server left to set up: a rebuild, not an empty server.
  // Its last server, now expired, is the old one step 4 sees to.
  if (s.restoring && !s.rebuild) return startRebuild({ ...s, vmId: latestFirst(mine)[0]?.id }, 'new_phone');
  // If the app died after ordering but before saving, the unpaid order is
  // still there: reuse it rather than ordering a second VM, unless it is
  // about to be deleted (no invoice was ever shown for it, so it can lapse).
  const unpaid = mine.find((v) => !v.expires && orderDeadline(v) - now >= REUSE_ORDER_MIN_LEFT_MS);
  const vm = unpaid ?? (await d.lnvps.orderVm((await d.lnvps.customTemplate()).id, (await d.lnvps.debianImage()).id, sshKeyId));
  return { ...s, vmId: vm.id, orderDeadline: orderDeadline(vm), invoice: undefined, step: 'pay' };
}

const orderDeadline = (vm: Vm) => Date.parse(vm.created) + ORDER_LIFETIME_MS;

/** cardd is an amd64 binary: refuse another architecture before any money moves. */
function checkArch(vm: Vm) {
  if (vm.cpu_arch && vm.cpu_arch !== 'x86_64') {
    throw new StepError('fatal', `The VM runs on ${vm.cpu_arch}; cardd is built for x86_64`);
  }
}

async function pay(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  const now = d.now();
  // Still choosing the days: the screen shows what they cost at the price kept, and one invoice is asked for once the
  // presses stop.
  if (s.payDaysAt !== undefined && now - s.payDaysAt < PAY_DAYS_SETTLE_MS) return { ...s, waiting: 'pay_days' };
  const vm = await getVmOrNull(d.lnvps, s.vmId!);
  const left = { payDaysAt: undefined, invoiceBusyUntil: undefined };
  // LNVPS deletes an order that stays unpaid for an hour: order again.
  if (!vm) return { ...s, ...left, step: 'order', vmId: undefined, orderDeadline: undefined, invoice: undefined };
  // Paid (an earlier invoice, even during a 429's minute): on at once.
  if (vm.expires) return { ...s, ...left, step: 'boot', invoice: undefined };
  // After a 429, no quote or invoice is asked of LNVPS until its minute is up.
  if (s.invoiceBusyUntil !== undefined && now < s.invoiceBusyUntil) return { ...s, waiting: 'lnvps_busy' };
  checkArch(vm);
  const deadline = s.orderDeadline ?? orderDeadline(vm);
  if (deadline - d.lnvps.serverTime() < STOP_INVOICING_BEFORE_DEADLINE_MS) {
    // Too late to pay safely: wait for LNVPS to delete the order (or for a
    // payment already on its way to land), then order again.
    return { ...s, orderDeadline: deadline, invoice: undefined, waiting: 'order_expiring' };
  }
  // Replace it a minute before it expires (or at once if it was saved without its expiry).
  const fresh = s.invoice?.vmId === vm.id && s.invoice.expiresAt - d.lnvps.serverTime() > INVOICE_RENEW_BEFORE_MS;
  if (fresh) return { ...s, waiting: 'payment' };
  // The days the person picked, through the VM's Lightning address (LNURL takes any amount).
  // LNVPS's host-key stall on the first real run was its hourly key scan, not this route.
  // The price of a day is asked for once while the days change, and again when an invoice runs out.
  const kept = !s.invoice && s.payPrice?.vmId === vm.id ? s.payPrice : undefined;
  let payPrice = kept;
  try {
    payPrice ??= { vmId: vm.id, satPerDay: await d.lnvps.satPerDay(vm.id) };
    const sat = paySat(s.payDays, payPrice.satPerDay);
    const bolt11 = await d.lnvps.vmInvoice(vm.id, sat);
    const expiresAt = bolt11ExpiresAtMs(bolt11) ?? d.lnvps.serverTime() + INVOICE_FALLBACK_LIFETIME_MS;
    const invoice = { vmId: vm.id, sat, days: s.payDays, bolt11, expiresAt };
    return { ...s, orderDeadline: deadline, invoice, payPrice, payDaysAt: undefined, invoiceBusyUntil: undefined, waiting: 'payment' };
  } catch (e) {
    // LNVPS's rate limit is a wait, never an error with its raw URL on the screen.
    if (!((e instanceof LnurlHttpError || e instanceof LnvpsError) && e.status === 429)) throw e;
    return { ...s, orderDeadline: deadline, payPrice, payDaysAt: undefined, invoiceBusyUntil: now + INVOICE_BUSY_WAIT_MS, waiting: 'lnvps_busy' };
  }
}

async function boot(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  // A rebuild in place stopped on a key LNVPS contradicted (below) stays stopped: nothing goes on to that VM.
  if (s.rebuild && s.hostKeyMismatch) throw new StepError('fatal', inPlaceMismatch(s, s.hostKeyMismatch));
  const vm = await d.lnvps.getVm(s.vmId!);
  checkArch(vm);
  const v4 = vm.ip_assignments.find((a) => !a.ip.includes(':'));
  if (vm.status.state === 'stopped' && s.rebuild?.target?.kind === 'in_place') return startInPlace(s, d, vm);
  if (vm.status.state !== 'running' || !v4) return { ...s, waiting: 'boot' };
  const published = vm.host_ssh_keys.find((k) => k.key_type === 'ssh-ed25519');
  const ownVm = onOldVm(s);
  if (s.rebuild) {
    // In place, the key pinned for this VM stays, LNVPS's or one trusted on first use; one LNVPS confirms becomes
    // LNVPS's. One LNVPS contradicts stops the rebuild there: nothing is retired, wiped or restored onto that VM.
    if (s.rebuild.target?.kind === 'in_place' && s.host) {
      const listed = published && { keyType: published.key_type, publicKey: published.public_key };
      if (s.host.keySource === 'first_use' && listed && listed.publicKey !== s.host.hostKey.publicKey) {
        const hostKeyMismatch = `LNVPS published ${published!.fingerprint_sha256}, but the key this app trusted for VM ${vm.id} is another`;
        return { ...s, hostKeyMismatch, runningSince: undefined, error: { kind: 'fatal', message: inPlaceMismatch(s, hostKeyMismatch) } };
      }
      const host: ServerHost = s.host.keySource !== 'first_use' || !listed ? s.host : { ...s.host, keySource: 'lnvps', trustedAt: undefined };
      // The old server's own VM is retired and wiped first: only once LNVPS has confirmed its key (an older wallet's
      // first-use key LNVPS never confirmed).
      if (ownVm && host.keySource === 'first_use') return bootKeyWait({ ...s, host, hostKeyTypes: undefined }, d);
      return { ...s, host, hostKeyTypes: undefined, runningSince: undefined, step: ownVm ? 'retire' : 'install' };
    }
    // The old server's own VM with nothing pinned: LNVPS's key, waited for, never one trusted on first use.
    if (ownVm && !published) return bootKeyWait({ ...s, hostKeyTypes: vm.host_ssh_keys.map((k) => k.key_type) }, d);
    // Otherwise (a new VM, or in place on another VM) a rebuild trusts on first use as onboarding does: its
    // install, too, sends the seed, the issuer key and the whole ledger only once LNVPS has published the same key.
  }
  const runningSince = s.runningSince ?? d.now();
  const ipv4 = v4.ip.split('/')[0];
  let hostKey: PinnedHostKey;
  let keySource: 'lnvps' | 'first_use';
  if (published) {
    hostKey = { keyType: published.key_type, publicKey: published.public_key };
    keySource = 'lnvps';
  } else {
    // LNVPS reads a new server's key about an hour after it starts (one scan before sshd is
    // up, then hourly). The app pins the key the server presents now, for the install's
    // steps that carry no secret; the step host-key waits for LNVPS's to match it before any secret goes.
    try {
      hostKey = await d.scanHostKey(ipv4, 22);
    } catch {
      if (d.now() - runningSince > HOST_KEY_WAIT_MS) {
        // Forget when the wait started, so Try again waits another 10 minutes.
        const message = 'The server\'s SSH is not answering after 10 minutes. Try again later.';
        return { ...s, runningSince: undefined, error: { kind: 'retry', message } };
      }
      return { ...s, runningSince, hostKeyTypes: vm.host_ssh_keys.map((k) => k.key_type), waiting: 'host_keys' };
    }
    keySource = 'first_use';
  }
  return {
    ...s,
    runningSince: undefined,
    hostKeyTypes: undefined,
    host: {
      ipv4,
      hostname: serverHostname(vm),
      user: vm.image.default_username ?? 'debian',
      hostKey,
      keySource,
      ...(keySource === 'first_use' && { trustedAt: d.now(), secretsHeld: true }),
    },
    // In place on the old server's own VM, step 4 (retire) comes first: its final snapshot is taken before the
    // install's wipe. On a new VM, or in place on another, the install's steps that carry no secret come first, and
    // step 4 just before the seed (installStep), so the old server runs on through the wait for LNVPS.
    step: ownVm ? 'retire' : 'install',
  };
}

/** A rebuild in place on the old server's own VM (not on another VM of the phrase). */
export const onOldVm = (s: OnboardingState) => s.rebuild?.target?.kind === 'in_place' && s.rebuild.target.vmId === s.rebuild.oldVm?.id;

/**
 * Why a rebuild in place stopped at boot on a first-use key LNVPS contradicts (mismatch: the record), what the VM may
 * have been given (secretsWords), and the innocent reason there can be.
 */
export function inPlaceMismatch(s: Pick<OnboardingState, 'host' | 'installed'>, mismatch: string): string {
  return (
    `The server's SSH key is not the one LNVPS published (${mismatch}). If you re-installed this VM through LNVPS, that ` +
    `changed its key; otherwise another server may have answered in its place. ${secretsWords(s) ?? 'Stop using this server.'} ` +
    "Don't rebuild on this VM: rebuild onto a new one."
  );
}

/**
 * Boot's wait for LNVPS to publish the key of the old server's own VM, before step 4 retires and wipes it, timed
 * from its start (runningSince); past HOST_KEY_CONFIRM_LIMIT_MS, Try again, which waits as long again.
 */
function bootKeyWait(s: OnboardingState, d: Pick<Deps, 'now'>): OnboardingState {
  const since = s.runningSince ?? d.now();
  if (d.now() - since >= HOST_KEY_CONFIRM_LIMIT_MS) {
    return { ...s, runningSince: undefined, error: { kind: 'retry', message: HOST_KEY_UNCONFIRMED_IN_PLACE } };
  }
  return { ...s, runningSince: since, waiting: 'host_key_confirm' };
}

/**
 * A rebuild in place on a VM LNVPS reports stopped: LNVPS starts it, as step 4 does the old server, if it
 * can't run a wallet beside the old server: it is the old server's own VM, or a rebuild had retired it.
 * Any other may hold a live wallet on this phrase: the person decides.
 */
async function startInPlace(s: OnboardingState, d: Deps, vm: Vm): Promise<OnboardingState> {
  const target = s.rebuild!.target as Extract<Rebuild['target'], { kind: 'in_place' }>;
  if (vm.id === s.rebuild!.oldVm?.id || target.retired) {
    await d.lnvps.startVm(vm.id);
    return { ...s, waiting: 'boot' };
  }
  throw new StepError(
    'retry',
    `VM ${vm.id} is stopped. It may hold a Lightning wallet on this phrase, so the app doesn't start it while the old server may run: ` +
      "start it from LNVPS's site only if you know it can't, then try again.",
  );
}

/**
 * Checks a key trusted on first use against the one LNVPS publishes (about an hour after the
 * server starts): the same key makes it 'lnvps'; a different one sets hostKeyMismatch.
 * Returns the state unchanged while LNVPS has no key yet, or when nothing needs checking.
 */
export async function verifyHostKey(s: OnboardingState, lnvps: Pick<LnvpsClient, 'getVm'>): Promise<OnboardingState> {
  if (!s.host || s.host.keySource !== 'first_use' || s.hostKeyMismatch || s.vmId === undefined) return s;
  const published = (await lnvps.getVm(s.vmId)).host_ssh_keys.find((k) => k.key_type === 'ssh-ed25519');
  if (!published) return s;
  if (published.public_key === s.host.hostKey.publicKey) return { ...s, host: { ...s.host, keySource: 'lnvps' } };
  return {
    ...s,
    hostKeyMismatch: `LNVPS published ${published.fingerprint_sha256}, but the server this app trusted presented a different key`,
  };
}

// cardd's -host rule (cmd/cardd validHost), plus at least one dot.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The name LNVPS gives the VM's IPv4 address, if it is a plain hostname; else LNVPS's default. */
export function serverHostname(vm: Pick<Vm, 'id' | 'ip_assignments'>): string {
  const v4 = vm.ip_assignments.find((a) => !a.ip.includes(':'));
  const name = (v4?.forward_dns ?? '').trim().toLowerCase().replace(/\.$/, '');
  return HOSTNAME.test(name) ? name : `vm-${vm.id}.lnvps.cloud`;
}

/** What install.sh needs for this server: shared by onboarding and "Update server". */
export function installOptions(s: OnboardingState, keys: DerivedKeys, bundle: BundleFile[]): Omit<InstallOptions, 'done' | 'onStep'> {
  return {
    bundle,
    host: s.host!.hostname,
    phoenixdSeed: keys.phoenixdSeed,
    issuerKey: keys.issuerKey,
    meta: {
      'vm.id': String(s.vmId),
      'vm.host': s.host!.hostname,
      'vm.ipv4': s.host!.ipv4,
      'account.pubkey': keys.nostrPublicKey,
      'mailtm.address': s.mailtmAddress!,
      'bundle.sha256': bundleSha(bundle),
      // The backup public key: cardd encrypts its snapshots to it.
      'backup.recipient': keys.backupAgeRecipient,
    },
  };
}

/** Logs in to the server: never once LNVPS's key has contradicted the one trusted on first use. */
export async function connectToServer(s: OnboardingState, ssh: SshConnect, keys: Pick<DerivedKeys, 'sshEd25519Seed'>) {
  if (s.hostKeyMismatch) throw new HostKeyMismatchError(s.hostKeyMismatch);
  const h = s.host!;
  return ssh({ host: h.ipv4, port: 22, user: h.user, hostKey: h.hostKey, ed25519Seed: keys.sshEd25519Seed });
}

const connect = (s: OnboardingState, d: Deps) => connectToServer(s, d.ssh, d.keys);

/**
 * A first-use key is checked against LNVPS's again before each connection: a retry
 * may come after LNVPS has published its key, and a contradicted server must get no secrets.
 */
async function checkedHost(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  const v = await verifyHostKey(s, d.lnvps);
  if (v !== s) await d.checkpoint(v);
  return v;
}

/** A key trusted on first use that LNVPS has neither confirmed nor contradicted yet. */
const keyUnconfirmed = (s: OnboardingState) => s.host?.keySource === 'first_use' && !s.hostKeyMismatch;

/** The install step that runs next. */
const nextInstallStep = (s: OnboardingState) => INSTALL_STEPS.find((x) => !s.installed.includes(x));

/** host-key's check found the key still unconfirmed: the install stops there, before any secret. */
class HostKeyUnconfirmed extends Error {}

/** A rebuild whose step 4 hasn't retired the old server: no secret goes to the new one yet. */
const retireDue = (s: OnboardingState) => !!s.rebuild && !s.rebuild.retire;

/** The install reached the seed of a rebuild whose old server still runs: step 4 now, then the install goes on. */
class RetireFirst extends Error {}

/**
 * The wait at host-key for LNVPS to publish the server's key, timed from when the step began (kept across a
 * closed app); past HOST_KEY_CONFIRM_LIMIT_MS, Try again, which waits as long again.
 */
function awaitHostKey(s: OnboardingState, d: Pick<Deps, 'now'>): OnboardingState {
  const at = s.stepStartedAt?.step === 'host-key' ? s.stepStartedAt.at : d.now();
  if (d.now() - at >= HOST_KEY_CONFIRM_LIMIT_MS) {
    const message = secretsAt(s) === 'maybe_sent' ? HOST_KEY_UNCONFIRMED_OLDER : HOST_KEY_UNCONFIRMED;
    return { ...s, stepStartedAt: undefined, error: { kind: 'retry', message } };
  }
  return { ...s, stepStartedAt: { step: 'host-key', at }, waiting: 'host_key_confirm' };
}

async function installStep(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  // Noted and saved before anything can fail, so a first attempt that never connects keeps it.
  if (s.installSince === undefined) {
    s = { ...s, installSince: d.now() };
    await d.checkpoint(s);
  }
  s = await checkedHost(s, d);
  // Waiting at host-key: LNVPS is asked again, and nothing is sent to the server, not even a login.
  const next = nextInstallStep(s);
  if (keyUnconfirmed(s) && (next === 'host-key' || (next !== undefined && SECRET_STEPS.includes(next)))) return awaitHostKey(s, d);
  // Back from a closed app with the key confirmed, the wipe done and the old server not yet retired: step 4, before
  // connecting here (an install that runs on reaches it at the seed: beforeSecret).
  if (retireDue(s) && next !== undefined && INSTALL_STEPS.indexOf(next) > INSTALL_STEPS.indexOf('wipe')) return { ...s, stepStartedAt: undefined, step: 'retire' };
  const rebuild = await rebuildOptions(s, d);
  const session = await connect(s, d);
  let current = s;
  try {
    // Ordinary onboarding looks before the seed makes this VM one more that holds it, else a VM refused
    // here would then be what refuses the other (a rebuild never looks at its own target).
    if (!s.rebuild && !s.installed.includes('seed')) await checkPhraseVms(s, d);
    await install(session, {
      ...installOptions(s, d.keys, await d.bundle()),
      ...rebuild,
      // The seed, the issuer key and a backup go only to a server whose SSH key LNVPS has published: a key
      // trusted on first use could be anyone's on the network between this phone and the server.
      confirmHostKey: async () => {
        current = await checkedHost(current, d);
        if (current.hostKeyMismatch) throw new HostKeyMismatchError(current.hostKeyMismatch);
        if (keyUnconfirmed(current)) throw new HostKeyUnconfirmed();
      },
      // A rebuild onto a new VM retires the old server (step 4) only now, with the new server ready and confirmed.
      beforeSecret: async () => {
        if (retireDue(current)) throw new RetireFirst();
      },
      beforeUp: () => checkPhraseVms(s, d),
      done: s.installed,
      onUpload: d.onUpload,
      onStart: async (step) => {
        if (current.stepStartedAt?.step === step) return; // a retry after a drop keeps the step's first start
        current = { ...current, stepStartedAt: { step, at: d.now() } };
        await d.checkpoint(current);
      },
      onStep: async (step) => {
        // A step finished: the row of drops ends, and the step's time is kept.
        const started = current.stepStartedAt?.step === step ? current.stepStartedAt.at : undefined;
        current = {
          ...current,
          installed: [...current.installed, step],
          drops: undefined,
          stepStartedAt: undefined,
          ...(started !== undefined && { stepMs: { ...current.stepMs, [step]: d.now() - started } }),
        };
        await d.checkpoint(current);
      },
    });
  } catch (e) {
    if (e instanceof SshDropped) return dropped(e, current); // a wait, from the steps saved
    if (e instanceof HostKeyUnconfirmed) return awaitHostKey(current, d); // a wait, from host-key's start
    if (e instanceof RetireFirst) return { ...current, stepStartedAt: undefined, step: 'retire' };
    if (isNetworkFailure(e)) throw e; // LNVPS, asked before up: wait, from the steps saved
    // In place, a recovery check on this (old) server holds wipe and up: advance waits for it, from the steps saved.
    if (e instanceof RecoveryCheckRunning) throw e;
    // The step ended (it failed, or the look before it refused): its next run starts its time afresh.
    current = { ...current, stepStartedAt: undefined };
    if (e instanceof OtherServerRunning) {
      // Ordinary onboarding: the person chooses that VM instead, or deletes it. A rebuild: step 4 sees to it.
      if (!current.rebuild) return { ...current, step: 'order', chosenVmId: undefined, error: classify(e, current) };
      return { ...current, step: 'retire', rebuild: otherOldVm(current, e.vmId), error: classify(e, current) };
    }
    if (e instanceof OldServerRunning) return { ...current, step: 'retire', rebuild: retireAgain(current.rebuild!), error: classify(e, current) };
    if (e instanceof InstallError && e.kind === 'retired' && !current.rebuild) return passOver(current, e.replacedBy);
    return { ...current, error: classify(e, current) };
  } finally {
    await session.close().catch(() => {}); // the work is done; a failed close changes nothing
  }
  return { ...current, step: 'pair' };
}

/**
 * A rebuild's part of the install: in place, wipe the old
 * server's data first; restore the chosen backup (decrypted in memory when the restore
 * step runs, and only while it is still to do), or start empty for the phrase alone.
 */
async function rebuildOptions(s: OnboardingState, d: Deps): Promise<Pick<InstallOptions, 'wipe' | 'restore' | 'device'>> {
  const r = s.rebuild;
  if (!r) return {};
  const backup = r.backup;
  if (!backup) throw new StepError('fatal', 'A rebuild reached the install without a backup chosen');
  // On the old server's own VM, step 4 comes before the install's wipe; elsewhere, before the seed (installStep). The
  // look before up reads its record: without one it would let any old server be.
  if (!r.retire && onOldVm(s)) throw new StepError('fatal', "A rebuild reached the install without step 4's record");
  return {
    wipe: r.target?.kind === 'in_place' || !!r.rewipe,
    restore: s.installed.includes('restore') ? undefined : () => restoreOf(backup, d),
    device: d.device.publicKeyHex.toLowerCase(),
  };
}

/** The chosen snapshot, decrypted in memory and never saved; or an empty database for the phrase alone. */
async function restoreOf(b: ChosenBackup, d: Deps): Promise<Restore> {
  if (b.kind === 'phrase_only') return { kind: 'fresh' };
  const db = ageDecrypt(await d.backups.read(b.name), d.keys.backupAgeIdentity);
  // Its name (install id, version, time) becomes meta restore.from.
  return { kind: 'db', db, from: b.name.replace(/\.age$/, '') };
}

/** Only these leave the old server unable to run phoenixd again, whatever LNVPS later says of it. */
const RETIRED_FOR_GOOD: readonly RetireRecord['result'][] = ['retired', 'reinstalled', 'empty', 'in_place'];

/**
 * Install's last look before up, at every VM of the phrase (one phoenixd
 * per seed); in ordinary onboarding also before the seed is written. Step 4's own VM keeps its rules (checkOldVm). Every other VM LNVPS lists, but this
 * server's and an unpaid order (it never booted, and LNVPS deletes it), must be known not to run
 * phoenixd: retired by a rebuild (retiredVms), seen to by this rebuild's step 4 (rebuild.others, by
 * checkOldVm's rules), or found retired or without a seed over SSH. Throws OtherServerRunning for
 * the first that isn't. In ordinary onboarding only a VM LNVPS reports running is looked at: a
 * stopped or expired one passes (one stopped by hand, which LNVPS starts again at a host boot, is
 * the risk left).
 */
async function checkPhraseVms(s: OnboardingState, d: Deps): Promise<void> {
  const r = s.rebuild;
  if (r) await checkOldVm(s, d);
  for (const vm of await d.lnvps.listVms()) {
    if (vm.id === s.vmId || vm.id === r?.oldVm?.id || !vm.expires || s.retiredVms?.includes(vm.id)) continue;
    const why = await mayRunWallet(s, d, vm);
    if (why) throw new OtherServerRunning(vm.id, `VM ${vm.id} ${why}: ${r ? 'retire it before the new one starts' : wayOn(s, d, vm)}.`);
  }
}

/** What ordinary onboarding can do about another VM that may run the wallet: order offers a paid one of this key. */
function wayOn(s: OnboardingState, d: Deps, vm: Vm): string {
  if (lapsed(vm, d)) return "it stops when LNVPS's grace ends, or delete it in LNVPS";
  return vm.ssh_key?.id === s.sshKeyId ? 'choose it instead, or delete it in LNVPS' : 'delete it in LNVPS';
}

/** Why another VM of the phrase may run phoenixd beside this server, or null if it can't. */
async function mayRunWallet(s: OnboardingState, d: Deps, vm: Vm): Promise<string | null> {
  const running = vm.status.state === 'running';
  const known = s.rebuild?.others?.find((o) => o.id === vm.id);
  if (known) return RETIRED_FOR_GOOD.includes(known.result) || known.overSsh || !running ? null : 'is running again without having been retired';
  if (!running) return s.rebuild ? `may hold a wallet on this phrase, and LNVPS reports it ${vm.status.state}` : null;
  const state = await phoenixdStateOf(vm, d);
  if (state === 'retired' || state === 'empty') return null;
  return state === 'live' ? 'is running with a wallet on this phrase and was never retired'
    : "is running and may hold a wallet on this phrase, but can't be looked at over SSH";
}

/**
 * A VM's phoenixd over SSH, with the key LNVPS publishes for it (never one trusted on first use) and the
 * app's install.sh uploaded first; null if it can't be had, whatever the reason.
 */
async function phoenixdStateOf(vm: Vm, d: Deps): Promise<'retired' | 'empty' | 'live' | null> {
  const host = lnvpsHost(vm);
  const session = host && (await login(host, d));
  if (!session) return null;
  try {
    await uploadInstallSh(session, d);
    return await phoenixdState(session);
  } catch {
    return null;
  } finally {
    await session.close().catch(() => {});
  }
}

/** Another VM of the phrase that may run phoenixd: up waits until the person, or step 4, has seen to it. */
class OtherServerRunning extends StepError {
  constructor(readonly vmId: number, message: string) {
    super('retry', message);
  }
}

/**
 * Step 4 again, for another VM of the phrase the look before up refused: what it recorded of the
 * one before is kept (rebuild.others), unless that is this server's own VM (in place).
 */
function otherOldVm(s: OnboardingState, id: number): Rebuild {
  const r = s.rebuild!;
  const was = r.oldVm && r.retire && r.oldVm.id !== s.vmId ? [{ id: r.oldVm.id, ...r.retire }] : [];
  return { ...retireAgain(r), oldVm: { id }, others: [...(r.others ?? []).filter((o) => o.id !== id && o.id !== r.oldVm?.id), ...was] };
}

/**
 * Install's last look before up at step 4's VM: its record can be old,
 * and LNVPS starts a stopped VM when its host boots, or when someone pays it.
 * Throws when the old server runs and step 4 never retired it over SSH. The override
 * confirmed at step 4 also lets it go on when LNVPS can't be reached.
 */
export async function checkOldVm(s: OnboardingState, d: Pick<Deps, 'lnvps'>): Promise<void> {
  const old = s.rebuild?.oldVm;
  const id = old && oldVmsToWatch(s).includes(old.id) ? old.id : undefined;
  const retire = s.rebuild?.retire;
  // An override confirmed while the old server answered SSH: the person knew it ran.
  if (id === undefined || retire?.overSsh) return;
  let vm: Vm | null;
  try {
    vm = await getVmOrNull(d.lnvps, id);
  } catch (e) {
    if (retire?.result === 'override' && isNetworkFailure(e)) return;
    throw e;
  }
  if (vm?.status.state === 'running') {
    const message = lapsed(vm, d) ? expiredRunning(vm.id)
      : `The old server is running again (VM ${id}) without having been retired: retire it before the new one starts.`;
    throw new OldServerRunning('retry', message);
  }
}

/**
 * The old VMs to keep an eye on: step 4's, and those it saw to before (rebuild.others), that may yet
 * run phoenixd beside this server (never this server's own VM).
 */
export function oldVmsToWatch(s: OnboardingState): number[] {
  const r = s.rebuild;
  const records = [...(r?.oldVm ? [{ id: r.oldVm.id, result: r.retire?.result }] : []), ...(r?.others ?? [])];
  return records.filter((x) => x.id !== s.vmId && !(x.result && RETIRED_FOR_GOOD.includes(x.result))).map((x) => x.id);
}

/** This phrase's servers as the backups check knows them: this one, the rebuild's old VM and others, every VM a rebuild retired. */
export function serversOfThisPhrase(s: OnboardingState): string[] {
  const ids = [s.vmId, s.rebuild?.oldVm?.id, ...(s.rebuild?.others ?? []).map((o) => o.id), ...(s.retiredVms ?? [])];
  return [...new Set(ids.filter((id): id is number => id !== undefined))].map(String);
}

/**
 * The server page's Retire old server: LNVPS reports an old VM
 * running (id: step 4's, or one it saw to before) though step 4 never retired it over SSH. Retires it
 * now as step 4 does, naming this server's VM, without a final snapshot (this server holds the books
 * now); one that holds no seed is only recorded. Throws when it can't be reached or doesn't stay
 * retired; returns the state to save, that VM's record updated.
 */
export async function retireOldServer(
  s: OnboardingState, d: Pick<Deps, 'ssh' | 'keys' | 'lnvps' | 'fetch' | 'now' | 'bundle'>, id = s.rebuild!.oldVm!.id,
): Promise<OnboardingState> {
  const r = s.rebuild!;
  const pinned = r.oldVm?.id === id ? r.oldVm.host : undefined;
  // A first-use key is checked against LNVPS's; LNVPS out of reach leaves it to try, as step 4 does (retireOld).
  const vm = pinned && pinned.keySource !== 'first_use' ? null
    : await getVmOrNull(d.lnvps, id).catch((e) => {
      if (pinned && isNetworkFailure(e)) return 'unreachable' as const;
      throw e;
    });
  const host = pinned ? listedOr(pinned, vm) : vm && vm !== 'unreachable' ? lnvpsHost(vm) : undefined;
  if (!host) throw new Error(`LNVPS doesn't list VM ${id}'s address and SSH key, so the app can't reach it.`);
  const session = await d.ssh({ host: host.ipv4, port: 22, user: host.user, hostKey: host.hostKey, ed25519Seed: d.keys.sshEd25519Seed });
  let result: 'retired' | 'empty' = 'retired';
  try {
    await uploadInstallSh(session, d);
    if ((await phoenixdState(session)) === 'empty') result = 'empty';
    else {
      await retireServer(session, s.vmId!);
      if ((await isRetired(session))?.replacedBy !== s.vmId) throw new Error(`The old server has no retired marker naming VM ${s.vmId} after retiring it.`);
    }
  } finally {
    await session.close().catch(() => {});
  }
  if (result === 'retired' && (await answers(host.hostname, d))) {
    throw new Error(`The old server still answers at https://${host.hostname}/health after it was retired: try again.`);
  }
  const retire: RetireRecord = { result, at: d.now() };
  if (r.oldVm?.id === id) return { ...s, rebuild: { ...r, retire } };
  return { ...s, rebuild: { ...r, others: (r.others ?? []).map((o) => (o.id === id ? { id, ...retire } : o)) } };
}

const lapsed = (vm: Vm, d: Pick<Deps, 'lnvps'>) => !!vm.expires && Date.parse(vm.expires) <= d.lnvps.serverTime();
const expiredRunning = (id: number) =>
  `LNVPS reports VM ${id} running though it has expired: wait for LNVPS to stop it, or pay a day so it can be retired properly.`;

/** Step 4 from its start: its record is out of date, and each branch asks again before it acts. */
const retireAgain = (r: Rebuild): Rebuild => ({
  ...r,
  retire: undefined,
  reachingSince: undefined,
  retireTries: undefined,
  fetchFailed: undefined,
  oldInvoice: undefined,
  confirm: r.confirm && { older: r.confirm.older, inPlace: r.confirm.inPlace },
});

/**
 * up refused a server a rebuild retired: order again,
 * passing it over, and say what replaced it.
 */
function passOver(s: OnboardingState, replacedBy?: number): OnboardingState {
  const vmId = s.vmId!;
  return {
    ...s,
    step: 'order',
    retiredVms: [...(s.retiredVms ?? []), vmId],
    chosenVmId: undefined,
    notice: `VM ${vmId} was replaced by ${replacedBy !== undefined ? `VM ${replacedBy}` : 'another'} in a rebuild: it can't be used again.`,
    vmId: undefined,
    host: undefined,
    hostKeyMismatch: undefined,
    runningSince: undefined,
    installed: [],
  };
}

/**
 * The old server as step 4 reaches it: by its pinned key, LNVPS's or trusted on first use (the one the
 * app installed through), never one LNVPS contradicted; otherwise by
 * the key LNVPS publishes. A first-use key LNVPS has since contradicted gives way to LNVPS's (listedOr).
 */
function oldVmOf(id: number, x: Pick<OnboardingState, 'host' | 'hostKeyMismatch'>): NonNullable<Rebuild['oldVm']> {
  return x.host && !x.hostKeyMismatch ? { id, host: x.host } : { id };
}

/** A first-use key, unless LNVPS now lists another for the VM: then LNVPS's address and key. */
function listedOr(host: ServerHost, vm: Vm | null | 'unreachable'): ServerHost {
  if (host.keySource !== 'first_use' || !vm || vm === 'unreachable') return host;
  const listed = lnvpsHost(vm);
  return listed && listed.hostKey.publicKey !== host.hostKey.publicKey ? listed : host;
}

/**
 * Starts a rebuild from where s stands: the server it had becomes the
 * old one, and the server to set up starts afresh, down to pairing this phone and
 * revoking the others again.
 */
export function startRebuild(s: OnboardingState, source: Rebuild['source']): OnboardingState {
  const before: RebuildBefore = {
    step: s.step, vmId: s.vmId, host: s.host, hostKeyMismatch: s.hostKeyMismatch, installed: s.installed,
    deviceKeyId: s.deviceKeyId, othersRevoked: s.othersRevoked, notice: s.notice,
    ...(s.rebuild && { rebuild: { ...s.rebuild, before: undefined } }),
  };
  return {
    ...s,
    step: 'backup',
    rebuild: { source, before, ...(s.vmId !== undefined && { oldVm: oldVmOf(s.vmId, s) }) },
    vmId: undefined,
    orderDeadline: undefined,
    invoice: undefined,
    runningSince: undefined,
    hostKeyTypes: undefined,
    host: undefined,
    hostKeyMismatch: undefined,
    installed: [],
    deviceKeyId: undefined,
    othersRevoked: false,
    waiting: undefined,
    error: undefined,
    // An earlier rebuild's note doesn't belong to this one (the real run); before.notice keeps it for Cancel rebuild.
    notice: undefined,
  };
}

// Rebuild steps 1, 2 and 4: choosing the backup and where, and retiring the old server.

/** Step 1: the person's choice, opened and checked before anything is ordered. */
async function chooseBackup(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  let r = s.rebuild!;
  if (!r.backup) return { ...s, waiting: 'choose_backup' };
  const kept = await d.backups.list();
  let backup = r.backup;
  if (backup.kind === 'kept') {
    const x = await openSnapshot(backup.name, d);
    backup = { kind: 'kept', name: backup.name, created: x.created, cards: x.cards, totalMsat: x.totalMsat };
    // A new phone knows the old server from the backup only (its meta vm.id).
    if (r.source === 'new_phone' && /^\d+$/.test(x.vmId)) r = { ...r, oldVm: { id: Number(x.vmId) } };
  } else {
    // The phrase's last VM, as the rebuild started (a backup chosen before may have named another).
    const before = r.before?.vmId;
    r = { ...r, oldVm: before !== undefined ? oldVmOf(before, r.before!) : undefined };
    if (kept.some((k) => k.checked !== 'unreadable') && (await oldServerAnswers(r, d))) {
      throw new StepError('retry', 'The old server still answers, so step 4 takes a final snapshot from it, newer than the phrase alone: choose a backup.');
    }
  }
  r = { ...r, backup };
  const newer = notNewest(backup, kept, await d.serverLatest());
  if (newer && !r.confirm?.older) return { ...s, rebuild: r, notice: olderNotice(backup, newer), waiting: 'confirm_older' };
  return { ...s, rebuild: r, step: 'where' };
}

/** What a kept snapshot holds; refused if the phrase can't open it, or the cardd this app carries is older than its own. */
async function openSnapshot(name: string, d: Deps): Promise<SnapshotSummary> {
  const x = await d.backups.inspect(name);
  if (!x) throw new StepError('retry', "This backup can't be opened with your recovery phrase: choose another.");
  if (x.userVersion > CARDD_SCHEMA_VERSION) throw newerBackup(x.userVersion);
  return x;
}

/** The start of newerBackup's message: the runner clears that error when it starts, as the person may have updated the app. */
export const NEWER_BACKUP = 'This backup was made by a newer version';
/** A newer-schema backup: never counted as a failed attempt at retiring (it says nothing about the old server). */
class NewerBackupError extends StepError {}
const newerBackup = (schema: number) => new NewerBackupError(
  'fatal',
  `${NEWER_BACKUP} of the server than this app carries: update the app first (its schema is ${schema}, this app's ${CARDD_SCHEMA_VERSION}).`,
);

/** Whether the old server's cardd answers over HTTPS. A new phone has its name from LNVPS. */
export async function oldServerAnswers(r: Rebuild, d: Pick<Deps, 'lnvps' | 'fetch'>): Promise<boolean> {
  const old = r.oldVm;
  if (!old) return false;
  let hostname = old.host?.hostname;
  if (!hostname) {
    const vm = await getVmOrNull(d.lnvps, old.id);
    if (!vm) return false;
    hostname = serverHostname(vm);
  }
  return answers(hostname, d);
}

const answers = (hostname: string, d: Pick<Deps, 'fetch'>) => d.fetch(`https://${hostname}/health`).then((res) => res.ok, () => false);

/** Step 2: a new VM, or in place on a paid VM of this phrase once the person has confirmed Rebuild on VM (its data is wiped). */
async function chooseWhere(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  const r = s.rebuild!;
  const target = r.target;
  if (!target || (target.kind === 'in_place' && !r.confirm?.inPlace)) return { ...s, waiting: 'choose_where' };
  if (target.kind === 'new') return { ...s, step: 'order' };
  const vm = await getVmOrNull(d.lnvps, target.vmId);
  if (!vm?.expires || Date.parse(vm.expires) <= d.lnvps.serverTime()) {
    throw new StepError('retry', `VM ${target.vmId} isn't a paid server of this recovery phrase: choose another, or a new one.`);
  }
  checkArch(vm);
  // The old server's own VM keeps the key pinned for it; boot has another's from LNVPS.
  const host = r.oldVm?.id === target.vmId ? r.oldVm.host : undefined;
  // One a rebuild retired is a server again, which the look before up must look at like any other. Safe
  // even if this rebuild goes no further: a VM not known retired is looked at over SSH, which finds its marker.
  const retired = target.retired || !!s.retiredVms?.includes(target.vmId);
  return {
    ...s,
    vmId: target.vmId,
    host,
    ...(s.retiredVms && { retiredVms: s.retiredVms.filter((id) => id !== target.vmId) }),
    ...(retired && { rebuild: { ...r, target: { ...target, retired } } }),
    orderDeadline: undefined,
    invoice: undefined,
    step: 'boot',
  };
}

/** How long step 4 waits for the old server's SSH, once LNVPS says it runs, before the last resort. */
export const OLD_VM_SSH_WAIT_MS = 10 * 60 * 1000;

/** Step 4's attempts over SSH before the screen also offers the override. */
export const RETIRE_TRIES_BEFORE_OVERRIDE = 3;

/**
 * Whether step 4 offers the override: LNVPS can't be reached to say what the old server
 * does, or retiring it over SSH has failed RETIRE_TRIES_BEFORE_OVERRIDE times. Never for a backup
 * made by a newer server: only an app update gets past that.
 */
export function overrideOffered(s: OnboardingState): boolean {
  if (s.step !== 'retire') return false;
  if (s.error?.message.startsWith(NEWER_BACKUP)) return false;
  return s.waiting === 'old_unreachable' || (!!s.error && (s.rebuild?.retireTries ?? 0) >= RETIRE_TRIES_BEFORE_OVERRIDE);
}

/** What an override confirmed now is for: going on while nothing answers, or after attempts over SSH failed. */
export const overrideFor = (s: OnboardingState): Override => (s.waiting === 'old_unreachable' ? 'unreachable' : 'ssh');

/**
 * What confirming the override gives up, as step 4 offers it: going on blind, or with the old server not
 * retired; or, once its final snapshot couldn't be had or in place, that snapshot (the old server is still retired).
 */
export function overridePrompt(s: OnboardingState): { text: string; title: string } {
  const error = s.error?.message ?? '';
  if (error.startsWith(FINAL_NOT_FETCHED)) {
    return {
      text: `${error} Going on without it starts from ${fromText(s.rebuild?.backup)}: anything on the old server after that is lost. The old server is still retired.`,
      title: 'Go on without the final snapshot',
    };
  }
  // In place, the install's wipe retires the old server whatever happens here: only its final snapshot is given up.
  if (s.rebuild?.oldVm !== undefined && s.rebuild.oldVm.id === s.vmId) {
    return {
      text: `${error} Going on without the old server's final snapshot starts from ${fromText(s.rebuild.backup)}: anything on it after that is lost. The install's wipe still retires it.`,
      title: 'Go on without the final snapshot',
    };
  }
  const why = s.waiting === 'old_unreachable' ? 'Going on without knowing what the old server does' : `Going on with the old server not retired (${error})`;
  return {
    text: `${why} risks two Lightning wallets on one seed, which can close the channel. Go on only if you know it can't run.`,
    title: 'Go on without retiring it',
  };
}

/**
 * Step 4, before the install sends the new server the seed (on a new VM, once its steps that carry no secret are
 * done and LNVPS has confirmed its key): the old server must never run phoenixd beside the new one.
 * Over SSH when it answers; otherwise LNVPS says what
 * it is. Each branch that acts waits for the person's confirmation first.
 */
async function retireOld(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  const r = s.rebuild!;
  if (r.retire) return { ...s, step: 'install' };
  if (s.vmId === undefined) throw new StepError('fatal', 'A rebuild reached step 4 without the new server\'s VM');
  const old = r.oldVm;
  // Nothing known to retire: a new phone whose phrase had no other server.
  if (!old) return retired(s, d, 'gone');
  // In place on its own VM, the install's wipe retires it (step 5).
  if (old.id === s.vmId) return retireInPlace(s, d);
  const ask = () => getVmOrNull(d.lnvps, old.id).catch((e) => {
    if (isNetworkFailure(e)) return 'unreachable' as const;
    throw e;
  });
  let vm: Vm | null | 'unreachable' | undefined;
  let host = old.host;
  // A new phone knows the old server from LNVPS only: its address and published key.
  if (!host) {
    vm = await ask();
    host = vm && vm !== 'unreachable' ? lnvpsHost(vm) : undefined;
  } else if (host.keySource === 'first_use') {
    vm = await ask();
    host = listedOr(host, vm);
  }
  // Whatever stops the login (the VM off, sshd down, another key) means it doesn't answer: LNVPS says what next.
  const session = host && (await login(host, d));
  if (session) return retireOverSsh(s, d, session, host!.hostname);
  if (vm === undefined) vm = await ask();
  // Two phoenixd on one seed can close the channel: only the person's confirmation goes on without knowing.
  if (vm === 'unreachable') {
    if (r.confirm?.override === 'unreachable') return retired(s, d, 'override');
    // One given for retiring over SSH isn't for going on blind: dropped, and asked for again.
    const dropped = r.confirm?.override ? { rebuild: { ...r, confirm: { ...r.confirm, override: undefined } } } : {};
    return { ...s, ...dropped, waiting: 'old_unreachable' };
  }
  if (!vm) return retired(s, d, 'gone');
  if (lapsed(vm, d)) {
    // It still holds the seed, and starts again if paid: a day paid lets it be retired over SSH.
    if (r.confirm?.expired) return expired(s, d, vm);
    if (r.confirm?.payOld) return payOld(s, d, vm);
    return { ...s, waiting: 'confirm_expired' };
  }
  if (!r.confirm?.retire) return { ...s, waiting: 'confirm_retire' };
  const since = r.reachingSince ?? d.now();
  s = { ...s, rebuild: { ...r, reachingSince: since } };
  if (d.now() - since >= OLD_VM_SSH_WAIT_MS) return reinstallOld(s, d, vm, host?.hostname ?? serverHostname(vm));
  // LNVPS starts it; SSH is tried again on each pass until it answers.
  if (vm.status.state === 'stopped') await d.lnvps.startVm(vm.id);
  return { ...s, waiting: 'old_vm_starting' };
}

/** An SSH session on the old server, or null: whatever stops the login means it doesn't answer. */
const login = (host: ServerHost, d: Pick<Deps, 'ssh' | 'keys'>) =>
  d.ssh({ host: host.ipv4, port: 22, user: host.user, hostKey: host.hostKey, ed25519Seed: d.keys.sshEd25519Seed }).catch(() => null);

/**
 * An expired old server, paid a day through its Lightning address (as onboarding's pay step), so
 * that it starts and step 4 can retire it over SSH. The invoice is renewed a minute before it expires.
 */
async function payOld(s: OnboardingState, d: Deps, vm: Vm): Promise<OnboardingState> {
  const r = s.rebuild!;
  if (r.oldInvoice && r.oldInvoice.expiresAt - d.lnvps.serverTime() > INVOICE_RENEW_BEFORE_MS) return { ...s, waiting: 'old_payment' };
  const sat = Math.max(MIN_PAYMENT_SAT, Math.ceil(await d.lnvps.satPerDay(vm.id)));
  const bolt11 = await d.lnvps.vmInvoice(vm.id, sat);
  const expiresAt = bolt11ExpiresAtMs(bolt11) ?? d.lnvps.serverTime() + INVOICE_FALLBACK_LIFETIME_MS;
  return { ...s, rebuild: { ...r, oldInvoice: { bolt11, sat, expiresAt } }, waiting: 'old_payment' };
}

/**
 * In place on the old server's own VM, the install's wipe retires it (step 5); Rebuild on VM, tapped
 * at step 2, was the confirmation. If it answers over SSH, its final snapshot is taken first. Each
 * attempt counts, as retiring over SSH does: after RETIRE_TRIES_BEFORE_OVERRIDE the override
 * goes on to the wipe without that snapshot.
 */
async function retireInPlace(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  const host = s.host;
  const session = host && (await login(host, d));
  if (!session) return retired(s, d, 'in_place');
  const before = s;
  try {
    const next = await nextAttempt(s, d);
    if (next.overridden) {
      await askOldServer(() => noOverrideDuringCheck(s, d, session), s, s);
      return retired(goesOn(s, "The override went on without the old server's final snapshot."), d, 'in_place');
    }
    s = next.s;
    try {
      await uploadInstallSh(session, d);
      await noRecoveryCheck(session);
      // One retired by an earlier rebuild has no cardd running to snapshot, and one without a seed never had.
      if ((await phoenixdState(session)) === 'live') s = await takeFinal(s, d, session, host!.hostname, next.goOn);
    } catch (e) {
      waitOutDrop(e, next.s, before);
      const x = await duringCheck(e, session);
      await failedAttempt(x, next.s, d, before);
      throw x;
    }
  } finally {
    await session.close().catch(() => {});
  }
  return retired(s, d, 'in_place');
}

/**
 * Counts one of step 4's attempts over SSH (saved before it starts) and spends a confirmed override.
 * overridden: the override applies, given for this (overrideFor 'ssh') after RETIRE_TRIES_BEFORE_OVERRIDE
 * failed attempts the last of which wasn't fetching the final snapshot. goOn: it was, so the override is
 * spent on that snapshot, and the attempt goes on without it if it can't be had again.
 */
async function nextAttempt(s: OnboardingState, d: Deps): Promise<{ s: OnboardingState; goOn: boolean; overridden: boolean }> {
  const r = s.rebuild!;
  const tries = r.retireTries ?? 0;
  const due = r.confirm?.override === 'ssh' && tries >= RETIRE_TRIES_BEFORE_OVERRIDE;
  if (due && !r.fetchFailed) return { s, goOn: false, overridden: true };
  // Used now on the final snapshot; or given too soon, or while nothing answered and the old server answers now: spent either way.
  const confirm = r.confirm?.override ? { confirm: { ...r.confirm, override: undefined } } : {};
  s = { ...s, rebuild: { ...r, ...confirm, retireTries: tries + 1, fetchFailed: undefined } };
  await d.checkpoint(s);
  return { s, goOn: due, overridden: false };
}

/**
 * What a failed attempt means for the override: a newer-schema snapshot isn't an attempt at all; a fetch failure
 * is noted. A recovery check running on the old server undoes the attempt (before: the state it started from) and
 * drops a confirmed override, as the failures that earned it may have been the check's: a fresh attempt must fail
 * first. Once the check is hung (RECOVERY_CHECK_WAIT_MS), it counts as any other failure.
 */
async function failedAttempt(e: unknown, attempted: OnboardingState, d: Deps, before: OnboardingState): Promise<void> {
  const r = attempted.rebuild!;
  if (e instanceof RecoveryCheckRunning && !checkHung(attempted, d)) {
    const b = before.rebuild!;
    await d.checkpoint({ ...attempted, rebuild: { ...r, retireTries: b.retireTries, fetchFailed: b.fetchFailed, confirm: { ...b.confirm, override: undefined } } });
  }
  // A snapshot of a newer schema says nothing about retiring: it never leads to the override.
  if (e instanceof NewerBackupError) await d.checkpoint({ ...attempted, rebuild: { ...r, retireTries: r.retireTries! - 1 } });
  if (e instanceof FinalNotFetched) await d.checkpoint({ ...attempted, rebuild: { ...r, fetchFailed: true } });
}

/**
 * A connection to the old server that dropped after the login, and is to be waited out.
 * Thrown from inside step 4; advance turns it into the wait,
 * built on the last state the attempt saved (a final snapshot it fetched stays the backup chosen), with the
 * attempt's count, its note of a fetch that failed and a confirmed override put back as they were before it.
 */
class OldServerDropped extends Error {
  constructor(
    readonly drop: SshDropped,
    readonly before: OnboardingState,
  ) {
    super(drop.message);
  }
}

/**
 * Inside step 4, for whatever failed under something asked of the old server: a drop is thrown on as one to wait
 * out, so a phone that was locked a few times while the snapshot was fetched does not earn the override. Not the
 * drop after DROPS_WAITED in a row: that one is the attempt's failure, counted and shown as any other, so an old
 * server that cannot hold a connection still gets there. before: the state before the attempt was counted.
 */
function waitOutDrop(e: unknown, attempted: OnboardingState, before: OnboardingState): void {
  if (e instanceof SshDropped && (attempted.drops?.n ?? 0) < DROPS_WAITED) throw new OldServerDropped(e, before);
}

/** The wait for the old server's connection, on the last state saved. Never on an older one: what an attempt saved before it was cut is not undone. */
function oldServerWait(e: OldServerDropped, latest: OnboardingState): OnboardingState {
  const r = latest.rebuild!;
  const b = e.before.rebuild!;
  return {
    ...latest,
    rebuild: { ...r, retireTries: b.retireTries, fetchFailed: b.fetchFailed, confirm: r.confirm || b.confirm ? { ...r.confirm, override: b.confirm?.override } : undefined },
    waiting: 'reconnect',
    drops: { n: (latest.drops?.n ?? 0) + 1, during: e.drop.during, last: e.drop.message },
  };
}

/** What step 4 asks the old server outside an attempt's own try: a drop under it is waited out too (waitOutDrop). */
async function askOldServer(ask: () => Promise<void>, attempted: OnboardingState, before: OnboardingState): Promise<void> {
  try {
    await ask();
  } catch (e) {
    waitOutDrop(e, attempted, before);
    throw e;
  }
}

/** Throws RecoveryCheckRunning while install.sh recovery-check (or another step holding its lock) runs on the server. */
async function noRecoveryCheck(session: SshSession): Promise<void> {
  if (await recoveryCheckRunning(session)) throw new RecoveryCheckRunning(CHECK_RUNNING_TEXT);
}

/** A failed attempt's error, or RecoveryCheckRunning if a check runs now: one that started during the attempt caused it. */
async function duringCheck(e: unknown, session: SshSession): Promise<unknown> {
  if (e instanceof RecoveryCheckRunning) return e;
  return (await recoveryCheckRunning(session).catch(() => false)) ? new RecoveryCheckRunning(CHECK_RUNNING_TEXT) : e;
}

/**
 * A due override goes on without retiring the old server (or its final snapshot): never while a recovery check
 * runs there, which starts its phoenixd again when it ends. The override is dropped (failedAttempt's rule), unless
 * the check is hung.
 */
async function noOverrideDuringCheck(s: OnboardingState, d: Deps, session: SshSession): Promise<void> {
  if (checkHung(s, d) || !(await recoveryCheckRunning(session))) return;
  const r = s.rebuild!;
  await d.checkpoint({ ...s, rebuild: { ...r, confirm: { ...r.confirm, override: undefined } } });
  throw new RecoveryCheckRunning(CHECK_RUNNING_TEXT);
}

/** The app's own install.sh, as Update server uploads it: one never updated has none of a rebuild's commands. */
async function uploadInstallSh(session: SshSession, d: Pick<Deps, 'bundle'>): Promise<void> {
  await uploadBundle(session, (await d.bundle()).filter((f) => f.path === 'install.sh'));
}

/**
 * The old server's final snapshot, fetched through its cardd as this phone: a phone not paired
 * with it (a new phone) pairs first, and one it revoked goes on without. goOn: the person confirmed
 * the override after it couldn't be fetched, so a fetch that fails again goes on without it.
 */
async function takeFinal(s: OnboardingState, d: Deps, session: SshSession, hostname: string, goOn = false): Promise<OnboardingState> {
  if (!s.rebuild!.before?.deviceKeyId) {
    try {
      await addDevice(session, d.device.publicKeyHex, d.device.name);
    } catch (e) {
      if (e instanceof InstallError && e.kind === 'revoked') return goesOn(s, "The old server revoked this phone's key, so its final snapshot can't be fetched.");
      throw e;
    }
  }
  let failed = '';
  try {
    await finalSnapshot(session);
  } catch (e) {
    // A drop that is still waited out is step 4's to wait for (waitOutDrop); the one after is a snapshot not made, as before.
    if (e instanceof SshDropped && (s.drops?.n ?? 0) < DROPS_WAITED) throw e;
    failed = e instanceof Error ? e.message : String(e);
    // The old server answers SSH: a failure a second try may mend is tried again, as a fetch is.
    if (!goOn && !(e instanceof FinalSnapshotRefused)) throw new FinalNotFetched('retry', `${FINAL_NOT_FETCHED}: it made none: ${failed}.`);
  }
  return takeLatest(s, d, hostname, failed ? { failed } : { justMade: true, goOn });
}

/** Step 1's choice as the notices name it. */
const fromText = (b?: ChosenBackup) => (b?.kind === 'kept' ? `the backup of ${timeText(b.created)}` : 'the phrase alone');

/** Step 1's choice stays, and the notice says why. */
function goesOn(s: OnboardingState, why: string): OnboardingState {
  return { ...s, notice: `${why} The rebuild goes on from ${fromText(s.rebuild!.backup)}.` };
}

/** A server as LNVPS describes it, once it lists the VM's IPv4 address and ed25519 key. */
function lnvpsHost(vm: Vm): ServerHost | undefined {
  const v4 = vm.ip_assignments.find((a) => !a.ip.includes(':'));
  const key = vm.host_ssh_keys.find((k) => k.key_type === 'ssh-ed25519');
  if (!v4 || !key) return undefined;
  const hostKey = { keyType: key.key_type, publicKey: key.public_key };
  return { ipv4: v4.ip.split('/')[0], hostname: serverHostname(vm), user: vm.image.default_username ?? 'debian', hostKey, keySource: 'lnvps' };
}

/**
 * Over SSH, once confirmed: the app's install.sh, a final snapshot, then compose down and the
 * marker naming the new VM, then a check that the marker is there and /health no longer
 * answers. A server whose marker already names the new VM (a cut after writing it) only needs
 * the check, and one that holds no phoenixd seed at all is only recorded. Each attempt is counted: after RETIRE_TRIES_BEFORE_OVERRIDE the person may go on
 * by confirming the override (Docker broken on the old VM, say). When the last attempt failed fetching
 * the final snapshot, the override goes on without that snapshot and still retires the server.
 */
async function retireOverSsh(s: OnboardingState, d: Deps, session: SshSession, hostname: string): Promise<OnboardingState> {
  const newVm = s.vmId!;
  try {
    if (!s.rebuild!.confirm?.retire) return { ...s, waiting: 'confirm_retire' };
    const before = s;
    const next = await nextAttempt(s, d);
    // The override goes on with the old server not retired: never while a recovery check there will start its phoenixd again.
    if (next.overridden) {
      await askOldServer(() => noOverrideDuringCheck(s, d, session), s, s);
      return retired(s, d, 'override', { overSsh: true });
    }
    s = next.s;
    try {
      await uploadInstallSh(session, d);
      await noRecoveryCheck(session);
      const state = await phoenixdState(session);
      // Never installed, or re-installed through LNVPS: nothing to snapshot or retire.
      if (state === 'empty') return retired(s, d, 'empty', { notice: `VM ${s.rebuild!.oldVm!.id} holds no Lightning wallet: there is nothing on it to retire.` });
      const marker = state === 'retired' ? await isRetired(session) : null;
      if (marker?.replacedBy !== newVm) {
        // One already retired for another VM has no cardd running to snapshot.
        if (!marker) s = await takeFinal(s, d, session, hostname, next.goOn);
        await retireServer(session, newVm);
      }
    } catch (e) {
      waitOutDrop(e, next.s, before);
      const x = await duringCheck(e, session);
      await failedAttempt(x, next.s, d, before);
      throw x;
    }
    // Retired, and the connection may go before the marker is read back: the same wait, and the next pass finds the marker.
    const read: { marker: Awaited<ReturnType<typeof isRetired>> } = { marker: null };
    await askOldServer(async () => void (read.marker = await isRetired(session)), next.s, before);
    if (read.marker?.replacedBy !== newVm) throw new Error(`The old server has no retired marker naming VM ${newVm} after retiring it.`);
  } finally {
    await session.close().catch(() => {});
  }
  if (await answers(hostname, d)) throw new StepError('retry', `The old server still answers at https://${hostname}/health after it was retired: try again.`);
  return retired(s, d, 'retired');
}

/**
 * The old server's latest snapshot through cardd's API, checked like any other, becomes step 1's
 * choice if it is newer, and the screen says so. One that can't be had leaves the choice as it was,
 * and the notice says why (failed: why no final snapshot was made). But a final snapshot just made
 * (justMade) that can't be fetched for a passing reason is tried again rather than lost, unless the
 * person confirmed the override after that happened before (goOn).
 */
async function takeLatest(
  s: OnboardingState, d: Deps, hostname: string, final: { failed?: string; justMade?: boolean; goOn?: boolean } = {},
): Promise<OnboardingState> {
  const r = s.rebuild!;
  const was = r.backup;
  const noFinal = final.failed && `The old server made no final snapshot: ${final.failed}.`;
  let name: string;
  let x: SnapshotSummary | null;
  try {
    name = await downloadLatest(d.oldCardd(hostname), d.backups, d.keys.backupAgeRecipient);
    x = await d.backups.inspect(name);
  } catch (e) {
    const why = `${FINAL_NOT_FETCHED}: ${e instanceof Error ? e.message : String(e)}.`;
    // An error, not a wait for the network: the SSH session shows the phone's network works, so it is the old server's HTTPS.
    if (final.justMade && !final.goOn && !permanent(e)) throw new FinalNotFetched('retry', why);
    return goesOn(s, noFinal || why);
  }
  if (!x) return goesOn(s, "The old server's final snapshot can't be opened with your recovery phrase.");
  if (x.userVersion > CARDD_SCHEMA_VERSION) throw newerBackup(x.userVersion);
  if (was?.kind === 'kept' && x.created <= was.created) return noFinal ? goesOn(s, noFinal) : s;
  // Restored already (the look before up sent the rebuild back to step 4): cardd restores only where no
  // database is, so the install wipes and restores again, on any target; the seed and the card key stay.
  // cardd hasn't started there, unless the app was cut once up had run and before that was saved: then
  // the wipe stops it and deletes phoenixd's data but its seed, which a rebuild accepts (ACINQ gives
  // the channel back to the seed).
  const again = s.installed.includes('restore');
  s = {
    ...s,
    ...(again && { installed: s.installed.filter((step) => step !== 'wipe' && step !== 'restore') }),
    rebuild: { ...r, backup: { kind: 'kept', name, created: x.created, cards: x.cards, totalMsat: x.totalMsat }, backupLocked: true, ...(again && { rewipe: true }) },
    notice: `The old server's final snapshot, of ${timeText(x.created)}, replaces ${fromText(was)} chosen in step 1.`,
  };
  await d.checkpoint(s);
  return s;
}

/** The start of FinalNotFetched's message: the screen's override then gives up the final snapshot, not the retire. */
export const FINAL_NOT_FETCHED = "The old server's final snapshot couldn't be fetched";
/** A final snapshot that couldn't be made or fetched, though the old server answers: step 4 tries again, and it counts toward the override. */
class FinalNotFetched extends StepError {}

/**
 * A fetch failure no second try mends: snapshots not this phrase's, described oddly or too big, or this
 * phone revoked. Anything else (the network, a download cut short or altered, the phone's storage) is tried again.
 */
const permanent = (e: unknown) => e instanceof SnapshotRefused || isRevoked(e) || (e instanceof CarddError && e.code === 'too_big');

/**
 * The last resort for a server that never answers SSH: LNVPS re-installs it, wiping its disk.
 * First its latest snapshot, if cardd still serves one, so the confirmation says what is lost.
 */
async function reinstallOld(s: OnboardingState, d: Deps, vm: Vm, hostname: string): Promise<OnboardingState> {
  s = await takeLatest(s, d, hostname);
  const b = s.rebuild!.backup;
  const lost = b?.kind === 'kept' ? `anything on it after the backup of ${timeText(b.created)} is lost` : 'with no backup, the split between the cards is lost';
  if (!s.rebuild!.confirm?.reinstall) {
    const notice = `VM ${vm.id} still doesn't answer over SSH. The last resort is re-installing it through LNVPS, which wipes its disk: ${lost}.`;
    return { ...s, notice, waiting: 'confirm_reinstall' };
  }
  try {
    await d.lnvps.reinstallVm(vm.id);
  } catch (e) {
    // LNVPS refuses an expired VM.
    if (e instanceof LnvpsError && e.status === 402) return expired(s, d, vm);
    throw e;
  }
  return retired(s, d, 'reinstalled', { notice: `VM ${vm.id} was re-installed through LNVPS: ${lost}.` });
}

/**
 * An expired VM the person chose not to pay: it only starts again if someone pays it, so the app
 * never does, and says not to. One LNVPS still runs is the check before up's to refuse.
 */
function expired(s: OnboardingState, d: Deps, vm: Vm): OnboardingState {
  const deletingOn = vm.deleting_on ?? undefined;
  const notice = vm.status.state === 'running' ? expiredRunning(vm.id)
    : `VM ${vm.id} has expired, and LNVPS deletes it ${deletingOn ? `on ${deletingOn.slice(0, 10)}` : 'soon'}. ` +
      "Don't pay for it: a payment starts it again, beside the new server.";
  return retired(s, d, 'expired', { deletingOn, notice });
}

/** Step 4's record; step 1's choice stays from now on. */
function retired(
  s: OnboardingState, d: Deps, result: RetireRecord['result'], o: { deletingOn?: string; notice?: string; overSsh?: boolean } = {},
): OnboardingState {
  const retire: RetireRecord = { result, at: d.now(), ...(o.deletingOn ? { deletingOn: o.deletingOn } : {}), ...(o.overSsh ? { overSsh: true } : {}) };
  // Its seed is gone, or marked never to run: order passes it over, and the look before up knows it.
  const id = s.rebuild!.oldVm?.id;
  const forGood = id !== undefined && (result === 'retired' || result === 'reinstalled') && !s.retiredVms?.includes(id);
  return {
    ...s,
    ...(forGood && { retiredVms: [...(s.retiredVms ?? []), id] }),
    ...(o.notice ? { notice: o.notice } : {}),
    step: 'install',
    rebuild: { ...s.rebuild!, retire, backupLocked: true, reachingSince: undefined, oldInvoice: undefined, ...(s.rebuild!.confirm?.override && { confirm: { ...s.rebuild!.confirm, override: undefined } }) },
  };
}

async function pair(s: OnboardingState, d: Deps): Promise<OnboardingState> {
  if (!s.deviceKeyId || !s.othersRevoked) {
    s = await checkedHost(s, d);
    const session = await connect(s, d);
    try {
      if (!s.deviceKeyId) {
        const id = await addDevice(session, d.device.publicKeyHex, d.device.name);
        const expected = keyId(hexToBytes(d.device.publicKeyHex));
        if (id !== expected) throw new StepError('fatal', `cardd registered key id ${id}, expected ${expected}`);
        s = { ...s, deviceKeyId: id, drops: undefined };
        await d.checkpoint(s);
      }
      // A restore onto a new phone: every other phone
      // loses access. Saved as its own step, so a cut here finishes next time.
      await revokeOthers(session, s.deviceKeyId!);
      s = { ...s, othersRevoked: true, drops: undefined };
      await d.checkpoint(s);
    } finally {
      await session.close().catch(() => {});
    }
  }
  // Caddy may still be getting the certificate: keep checking until it serves.
  try {
    const res = await d.fetch(`https://${s.host!.hostname}/health`);
    const body = (await res.json()) as { ok?: boolean };
    if (!res.ok || body.ok !== true) return { ...s, waiting: 'health' };
  } catch {
    return { ...s, waiting: 'health' };
  }
  return { ...s, step: 'done' };
}
