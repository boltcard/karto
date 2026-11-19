// What the setup screen shows for a state (onboarding, and Rebuild server): one step at a time.
import { shortDate } from '../money/format';
import type { ResultView } from '../money/steps';
import { INSTALL_STEPS, installStepsFor, type InstallStep, type UploadProgress } from './install';
import {
  HOST_KEY_CONFIRM_WAIT_MS, INVOICE_RENEW_BEFORE_MS, REBUILD_STEPS, secretsAt, STOP_INVOICING_BEFORE_DEADLINE_MS, STEPS, type OnboardingState, type Step, type Waiting,
} from './machine';
import { chosenLine } from './rebuild';
import { REFREEZE } from './serverPage';

export const STEP_LABELS: Record<Step, string> = {
  country: 'Country',
  email: 'Email',
  backup: 'Choose a backup',
  where: 'Choose where',
  order: 'Order the server',
  pay: 'Pay',
  retire: 'Retire the old server',
  boot: 'Start the server',
  install: 'Install',
  pair: 'Pair this phone',
  done: 'Done',
};

const WAITING_TEXT: Record<Waiting, string> = {
  email: 'Waiting for LNVPS’s email. Karto Wallet reads it for you.',
  payment: 'Waiting for the payment…',
  order_expiring: 'This order is about to expire. A new one is made once LNVPS deletes it…',
  boot: 'The server is starting…',
  host_keys: 'Waiting for the new server to answer…',
  host_key_confirm: 'Waiting for LNVPS to confirm your server…',
  health: 'Waiting for the server’s web address to be ready…',
  network: 'The phone can’t reach the internet right now. Trying again…',
  old_unreachable: 'Neither the old server nor LNVPS can be reached to say what the old server is doing. Trying again…',
  choose_vm: 'Choose which of your servers to set up…',
  choose_backup: 'Choose the backup to restore…',
  confirm_older: 'This backup isn’t the newest: confirm to restore it all the same…',
  choose_where: 'Choose where to rebuild the server…',
  confirm_retire: 'Confirm to retire the old server…',
  old_vm_starting: 'Waiting for the old server to answer SSH…',
  confirm_reinstall: 'Confirm to re-install the old server through LNVPS…',
  confirm_expired: 'The old server has expired: choose whether to pay a day to retire it properly…',
  old_payment: 'Waiting for the payment for the old server…',
  recovery_check: 'The old server is busy with a recovery check or another install step: waiting for it to finish (up to 15 minutes)…',
  // No connection could be made. One cut under a step says which step: reconnectLine.
  reconnect: 'Your server isn’t answering yet. Trying again…',
  pay_days: 'Getting the invoice for the days chosen…',
  lnvps_busy: 'LNVPS is busy. Asking for the invoice again in a minute…',
  mailtm_busy: "mail.tm, the inbox for LNVPS's email, is busy. Trying again in a minute…",
};

/**
 * The wait after a dropped connection: cut under a step, it
 * names the step it carries on from, by its label; a connection that could not be made is the server not answering.
 */
function reconnectLine(s: OnboardingState): string {
  // A rebuild's step 4 talks to the old server, after a login that answered.
  if (s.step === 'retire') return 'The connection to the old server dropped. Carrying on.';
  if (!s.drops) return WAITING_TEXT.reconnect;
  return dropLine(s.drops.during, s.step === 'install' ? installRows(s).find((r) => r.status === 'current')?.step : undefined);
}

/** The line for a dropped connection to the person's server: during what it dropped, and the install step it carries on from, if one. */
export function dropLine(during: 'connect' | 'command' | 'upload', step?: InstallStep): string {
  if (during === 'connect') return WAITING_TEXT.reconnect;
  return `The connection to your server dropped. Carrying on${step ? ` from “${INSTALL_STEP_LABELS[step]}”` : ''}.`;
}

/** What a step is doing while it waits for nothing (the install's own steps say it themselves). */
const STEP_WORKING: Record<Exclude<Step, 'install' | 'done'>, string> = {
  country: 'Setting the country on your LNVPS account…',
  email: 'Making an inbox for LNVPS’s email…',
  backup: 'Looking for backups…',
  where: 'Asking LNVPS for your servers…',
  order: 'Asking LNVPS for a server…',
  pay: 'Getting the invoice…',
  boot: 'The server is starting…',
  retire: 'Retiring the old server…',
  pair: 'Adding this phone to the server…',
};

/** The heading over each step: what is happening. */
const STEP_HEADINGS: Record<Step, string> = {
  country: 'Telling LNVPS your country',
  email: 'Opening your LNVPS account',
  backup: 'Choose a backup',
  where: 'Choose where to rebuild',
  order: 'Ordering the server',
  pay: 'Pay for the server',
  boot: 'Starting the server',
  retire: 'Retiring the old server',
  install: 'Installing your server',
  pair: 'Pairing this phone',
  done: 'Done',
};

/** A step's name on the Done line. */
const STEP_SHORT: Record<Step, string> = {
  country: 'country', email: 'email', backup: 'backup', where: 'where', order: 'order', pay: 'payment', boot: 'start', retire: 'old server',
  install: 'install', pair: 'pairing', done: 'done',
};

/** The waits that are the person's turn: the screen shows no spinner. Every other wait is Karto asking again. */
const PERSONS_TURN: readonly Waiting[] = [
  'payment', 'old_payment', 'choose_vm', 'choose_backup', 'choose_where', 'confirm_older', 'confirm_retire', 'confirm_reinstall', 'confirm_expired',
];

/** The steps the stepper lists: a rebuild's own only in a rebuild. */
export const stepsFor = (s: OnboardingState): readonly Step[] => (s.rebuild ? STEPS : STEPS.filter((x) => !REBUILD_STEPS.includes(x)));

/** A typed-in phrase that isn't rebuilding: its order step looks for the phrase's paid server and orders nothing, and nothing is paid. */
const findsServer = (s: OnboardingState) => !!s.restoring && !s.rebuild;

/**
 * The steps the setup counts: the machine's for this state, without done. A rebuild's own step in a state with no
 * rebuild (the machine never makes one) is counted among all ten, so the number is never nought.
 */
const countedSteps = (s: OnboardingState): Step[] => (stepsFor(s).includes(s.step) ? stepsFor(s) : STEPS).filter((x) => x !== 'done');

/** The heading over the current step; the order step says so when it orders nothing. */
export function stepHeading(s: OnboardingState): string {
  if (s.step === 'order' && s.waiting === 'choose_vm') return 'Choose your server';
  if (s.step === 'order' && findsServer(s)) return 'Looking for your server';
  return STEP_HEADINGS[s.step];
}

/**
 * Where the setup stands: step n of the machine's steps (seven setting up, ten in a rebuild), and what TalkBack
 * reads for the bar. A step the machine passes over keeps its number, so the count never shrinks.
 */
export function setupProgress(s: OnboardingState): { n: number; of: number; label: string } {
  const steps = countedSteps(s);
  const n = s.step === 'done' ? steps.length : steps.indexOf(s.step) + 1;
  return { n, of: steps.length, label: `Step ${n} of ${steps.length}, ${stepHeading(s)}` };
}

/** Whether Karto is working and nothing is asked of the person: the spinner before the line. */
export const working = (s: OnboardingState): boolean => s.step !== 'done' && !s.error && !(s.waiting && PERSONS_TURN.includes(s.waiting));

/** The finished steps that ran, in order: in place orders and pays nothing; a typed-in phrase's paid server was found, and nothing paid. */
function ranSteps(s: OnboardingState): Step[] {
  const all = countedSteps(s);
  const before = s.step === 'done' ? all : all.slice(0, all.indexOf(s.step));
  const inPlace = s.rebuild?.target?.kind === 'in_place';
  return before.filter((x) => !(x === 'pay' && (inPlace || findsServer(s))) && !(x === 'order' && inPlace));
}

/** What is done, for the Done line's unfolded panel: each step's short name, its label and what it settled (the phone's clock for the backup's time). */
export function doneSteps(s: OnboardingState, nowS: number, offsetMin: number): { step: Step; name: string; label: string; line: string | null }[] {
  return ranSteps(s).map((step) => {
    const found = step === 'order' && findsServer(s);
    return { step, name: found ? 'server found' : STEP_SHORT[step], label: found ? 'Find the server' : STEP_LABELS[step], line: doneLine(s, step, nowS, offsetMin) };
  });
}

/** The Done line, folded: "Done: country, email, order"; null while nothing is. */
export function doneSummary(s: OnboardingState): string | null {
  const names = ranSteps(s).map((step) => (step === 'order' && findsServer(s) ? 'server found' : STEP_SHORT[step]));
  return names.length ? `Done: ${names.join(', ')}` : null;
}

export function stepStatus(s: OnboardingState, step: Step): 'done' | 'current' | 'todo' {
  if (s.step === 'done') return 'done';
  const at = STEPS.indexOf(s.step);
  const i = STEPS.indexOf(step);
  return i < at ? 'done' : i === at ? 'current' : 'todo';
}

/**
 * A finished step's line under it: the backup chosen (its time by the phone's clock: nowS, and offsetMin minutes east
 * of UTC), where, the VM ordered, the server booted (the real run: the VM was never named).
 */
export function doneLine(s: OnboardingState, step: Step, nowS = Date.now() / 1000, offsetMin = -new Date(nowS * 1000).getTimezoneOffset()): string | null {
  const target = s.rebuild?.target;
  if (step === 'backup') return s.rebuild?.backup ? chosenLine(s.rebuild.backup, nowS, offsetMin) : null;
  if (step === 'where') return target ? (target.kind === 'in_place' ? `In place on VM ${target.vmId}` : 'A new server') : null;
  if (step === 'order') return target?.kind !== 'in_place' && s.vmId !== undefined ? `VM ${s.vmId}` : null;
  if (step === 'boot') return s.host ? `${s.host.hostname} · ${s.host.ipv4}` : null;
  return null;
}

/**
 * One line under the heading: the step's error, what it waits for, or what it is doing. Null at the install with
 * no wait (its own steps are listed) and once done.
 */
export function statusLine(s: OnboardingState, now = Date.now()): string | null {
  if (s.error) return s.error.message;
  if (s.waiting === 'recovery_check' && s.checkSince !== undefined) {
    return `${WAITING_TEXT.recovery_check} ${Math.floor(Math.max(0, now - s.checkSince) / 60_000)} min so far.`;
  }
  if (s.waiting === 'reconnect') return reconnectLine(s);
  if (s.waiting === 'host_key_confirm') return hostKeyWaitLine(s, now);
  if (s.waiting) return WAITING_TEXT[s.waiting];
  if (s.step === 'install' || s.step === 'done') return null;
  if (s.step === 'order' && findsServer(s)) return STEP_WORKING.where;
  return STEP_WORKING[s.step];
}

/**
 * The wait for LNVPS to confirm the server: how long so far, why, and what it holds back. The minutes count from the
 * wait's start (kept across a closed app): host-key's, or at a rebuild's boot in place on the old server's own VM,
 * runningSince. What it holds back is said only as far as it is known (secretsAt).
 */
function hostKeyWaitLine(s: OnboardingState, now: number): string {
  const atBoot = s.step === 'boot';
  const since = s.stepStartedAt?.step === 'host-key' ? s.stepStartedAt.at : atBoot ? (s.runningSince ?? now) : now;
  const head = `Waiting for LNVPS to confirm your server: ${Math.floor(Math.max(0, now - since) / 60_000)} min so far. `;
  if (atBoot) {
    return `${head}LNVPS checks a server’s identity (its SSH key) every hour. Nothing on it is retired or wiped until LNVPS has confirmed it.`;
  }
  const held = secretsAt(s) === 'maybe_sent'
    ? 'This server was set up before Karto Wallet waited for LNVPS, so your wallet seed and card key may already have been sent to it; nothing more is sent until LNVPS confirms it.'
    : 'Your wallet seed and card key are sent only once LNVPS has confirmed it, so they can’t go to any other server.';
  return `${head}LNVPS checks a new server’s identity (its SSH key) about an hour after it starts, then every hour. ${held}`;
}

/**
 * The install steps the setup lists: a rebuild's wipe in place, or again after a newer final snapshot
 * replaced a backup restored (rewipe); the wait for LNVPS to confirm a key trusted on first use (trustedAt stays
 * once it has); its restore for a kept backup (the phrase alone has none to show).
 */
export const setupInstallSteps = (s: OnboardingState): readonly InstallStep[] => {
  const r = s.rebuild;
  const hostKey = s.host?.keySource === 'first_use' || s.host?.trustedAt !== undefined;
  return installStepsFor({ wipe: r?.target?.kind === 'in_place' || !!r?.rewipe, hostKey, restore: r?.backup?.kind === 'kept' });
};

export type StepRow = { step: InstallStep; label: string; status: 'done' | 'current' | 'todo'; time: string | null; spoken: string };

/**
 * A step's time in plain seconds ("1.1 s", not "0:01.1"), rounded down: a finished
 * step to a tenth ("48.4 s", "2 min 5.9 s", "1 min"), the running one in whole seconds ("5 s", "1 min 3 s").
 */
export function stepTimeText(ms: number, tenths: boolean): string {
  const t = Math.max(0, Math.floor(ms / (tenths ? 100 : 1000)));
  const perMinute = tenths ? 600 : 60;
  const m = Math.floor(t / perMinute);
  const rest = t % perMinute;
  const s = tenths ? (rest / 10).toFixed(1) : String(rest);
  if (m === 0) return `${s} s`;
  return rest === 0 ? `${m} min` : `${m} min ${s} s`;
}

/** A finished step's time said aloud, to a tenth of a second: "48.4 seconds", "1 second", "2 minutes 5.9 seconds", "1 minute". */
export function spokenDuration(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 100));
  const m = Math.floor(t / 600);
  const tenths = t % 600;
  const s = tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
  const seconds = `${s} second${s === '1' ? '' : 's'}`;
  const minutes = `${m} minute${m === 1 ? '' : 's'}`;
  return m === 0 ? seconds : tenths === 0 ? minutes : `${minutes} ${seconds}`;
}

/**
 * An install's rows with their times: the running step's
 * time counts up while live, from its start (nowMs null: no running time); a step finished in this run keeps its time;
 * a step done before it shows none. spoken: the row's words for a screen reader, which don't change each second.
 */
export function stepRows(
  steps: readonly InstallStep[],
  done: readonly InstallStep[],
  t: { stepMs?: Partial<Record<InstallStep, number>>; stepStartedAt?: { step: InstallStep; at: number } },
  nowMs: number | null,
  live: boolean,
): StepRow[] {
  return steps.map((step) => {
    const label = INSTALL_STEP_LABELS[step];
    const status = installStepStatus(done, step, steps);
    const ms = t.stepMs?.[step];
    const running = status === 'current' && live && nowMs !== null && t.stepStartedAt?.step === step;
    const time = status === 'done' && ms !== undefined ? stepTimeText(ms, true) : running ? stepTimeText(nowMs! - t.stepStartedAt!.at, false) : null;
    const spoken =
      status === 'done' ? `${label}, done${ms !== undefined ? `, ${spokenDuration(ms)}` : ''}` : status === 'current' ? `${label}, running` : `${label}, to do`;
    return { step, label, status, time, spoken };
  });
}

/** The install's own steps as the setup screen lists them, each done, current or to do, with its time (nowMs: the screen's clock). */
export function installRows(s: OnboardingState, nowMs?: number): StepRow[] {
  return stepRows(setupInstallSteps(s), s.installed, s, nowMs ?? null, s.step === 'install' && !s.error);
}

/** The install log lines a new saved state brings: one for each step it finished since prev, with its time. */
export function newInstallLogLines(prev: OnboardingState | null, s: OnboardingState): string[] {
  const before = new Set(prev?.installed ?? []);
  const run = s.rebuild ? 'rebuild' : 'setup';
  return s.installed.filter((step) => !before.has(step) && s.stepMs?.[step] !== undefined).map((step) => installLogLine(run, step, s.stepMs![step]!));
}

/**
 * Under the install's steps: its whole minutes so far (from installSince, when the state has it) and what to do
 * meanwhile. During the wait for LNVPS the minutes are left out: the status line and the step's row already count the
 * wait's own, and a third count from the install's start read as a clock that disagreed with them.
 */
export function installFoot(s: OnboardingState, nowMs: number): string {
  // The wait for LNVPS can take an hour: the app needn't stay open for it.
  if (s.waiting === 'host_key_confirm') return 'You can leave the app while LNVPS confirms your server: the install carries on when you come back.';
  const keep = 'Keep the app open: the screen stays on. If you leave, it carries on when you come back.';
  return s.installSince === undefined ? keep : `${Math.floor(Math.max(0, nowMs - s.installSince) / 60_000)} min so far. ${keep}`;
}

/**
 * The page the setup ends on, drawn as a money screen's result page, by what ran: a rebuild from the phrase alone (no
 * cards are listed), a rebuild from a backup, a typed-in phrase paired with its paid server, or a new setup.
 * lnvpsExpires: LNVPS's own date for this VM (unix seconds), or null when the phone has none.
 */
export function readyView(s: OnboardingState, lnvpsExpires: number | null, nowS: number, offsetMin: number): ResultView {
  const paid = lnvpsExpires === null ? null : `It’s paid for until ${shortDate(lnvpsExpires, nowS, offsetMin)}`;
  const view = (title: string, sentences: (string | null)[]): ResultView => ({ tone: 'ok', mark: 'check', title, line: sentences.filter(Boolean).join(' ') });
  if (s.rebuild?.backup?.kind === 'phrase_only') {
    return view('Your server is rebuilt', [paid && `${paid}.`, 'No cards are listed yet: hold each card to the phone to add it back. All the money is in Pool.']);
  }
  if (s.rebuild) {
    // cardd lets no restored card pay until it has been held to the phone (the card's own check), and has no record of a
    // freeze made after the backup.
    return view('Your server is rebuilt', [
      paid && `${paid}.`,
      'No card can pay until you hold it to the phone: each one is marked in the wallet, and one that still points at the old server is re-pointed then.',
      REFREEZE,
    ]);
  }
  if (s.restoring) return view('Your server is ready', ['This phone is now paired with your server.', paid && `${paid}.`]);
  return view('Your server is ready', [paid ? `${paid}, and this phone is paired with it.` : 'This phone is paired with it.', 'Next, add your first card.']);
}

/** The install steps as the person sees them (onboarding's Install step, and Update server). */
export const INSTALL_STEP_LABELS: Record<InstallStep, string> = {
  upload: 'Upload the server files',
  'first-boot': "Wait for the server's first boot",
  swap: 'Add swap',
  docker: 'Install Docker',
  'docker-setup': 'Set up Docker',
  prepare: 'Build the card server',
  wipe: 'Wipe the old server data',
  'host-key': 'Wait for LNVPS to confirm your server',
  seed: 'Set the Lightning wallet seed',
  'issuer-key': 'Set the card key',
  restore: 'Restore the backup',
  up: 'Start the services',
  meta: 'Record the version',
};

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** One line for a file being uploaded. */
export const uploadLine = (p: UploadProgress) => `Uploading ${p.path}: ${mb(p.sent)} of ${mb(p.total)} MB`;

/** Where an install step stands among those listed, given the steps finished so far (they run in order). */
export function installStepStatus(done: readonly InstallStep[], step: InstallStep, steps: readonly InstallStep[] = INSTALL_STEPS): 'done' | 'current' | 'todo' {
  if (done.includes(step)) return 'done';
  return steps.find((x) => !done.includes(x)) === step ? 'current' : 'todo';
}

/** Which buttons the stepper shows under an error: only those that can fix it. */
export function errorActions(s: OnboardingState): { retry: boolean; chooseCountry: boolean; final: boolean } {
  const kind = s.error?.kind;
  const chooseCountry = s.step === 'country' && kind === 'fatal';
  return { retry: kind === 'retry', chooseCountry, final: !!kind && kind !== 'retry' && !chooseCountry };
}

/** What Settings and the wallet's banner say about the pinned SSH host key (trusted on first use, or LNVPS's). */
export function hostKeyNotice(s: OnboardingState, nowMs: number): { kind: 'ok' | 'pending' | 'overdue' | 'mismatch'; text: string } {
  if (s.hostKeyMismatch) {
    return {
      kind: 'mismatch',
      text:
        `The server's SSH key is not the one LNVPS published (${s.hostKeyMismatch}). The wallet seed and card key may have gone to ` +
        'someone else. Stop using this server and this recovery phrase.',
    };
  }
  if (s.host?.keySource === 'first_use') {
    if (s.host.trustedAt !== undefined && nowMs - s.host.trustedAt > HOST_KEY_CONFIRM_WAIT_MS) {
      return {
        kind: 'overdue',
        text:
          `LNVPS still hasn't confirmed your server's identity (its SSH key) after 2 hours; it normally does within one. Until it does, the app ` +
          `can't be sure the server it set up is really ${s.host.hostname}. Don't put more money on it until it does, and ask LNVPS why the ` +
          'key isn\'t listed.',
      };
    }
    return {
      kind: 'pending',
      text: "LNVPS hasn't confirmed your server's identity yet. It usually does about an hour after the server starts; the app checks while the wallet or a Settings page is open.",
    };
  }
  return { kind: 'ok', text: 'LNVPS has confirmed this server\'s SSH key.' };
}

/** m:ss left to pay the invoice on screen before the app replaces it, or null without one. */
export function payWithin(s: OnboardingState, nowMs: number): string | null {
  if (!s.invoice) return null;
  // Whichever comes first: the swap to a new invoice, or the order getting too close to deletion.
  const ends = [s.invoice.expiresAt - INVOICE_RENEW_BEFORE_MS];
  if (s.orderDeadline !== undefined) ends.push(s.orderDeadline - STOP_INVOICING_BEFORE_DEADLINE_MS);
  return countdown(Math.min(...ends), nowMs);
}

/** Under the invoice's QR code: who can pay it, how long it shows (within: payWithin's m:ss, or null) and that the setup then carries on. */
export const payFoot = (within: string | null): string =>
  `Pay from any Lightning wallet${within === null ? '.' : ` within ${within}; after that a new invoice appears here.`} Karto Wallet carries on by itself once it’s paid.`;

/** m:ss until the deadline (both ms on the same clock), never below zero. */
export function countdown(deadlineMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** One install step's time for adb logcat: which run, which step, how long. */
export const installLogLine = (run: 'setup' | 'rebuild' | 'update', step: InstallStep, ms: number): string =>
  `CARDAPP-INSTALL ${JSON.stringify({ run, step, ms })}`;

/** m:ss since startMs (both ms on the same clock). */
export const elapsed = (startMs: number, nowMs: number) => countdown(nowMs, startMs);
