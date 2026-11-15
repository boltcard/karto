// Drives the onboarding state machine (machine.ts) for the screens: calls
// advance() until done or an error, saves every state before going on, waits
// between polls, and stops polling while the app is in the background.
import type { UploadProgress } from './install';
import { advance, initialState, KEEPS_DROPPING, NEWER_BACKUP, PAY_DAYS_SETTLE_MS, type Deps, type OnboardingState, type Waiting } from './machine';

/** How long to wait before asking again, by what we are waiting for. */
export const WAIT_MS: Record<Waiting, number> = {
  email: 5_000,
  payment: 3_000,
  order_expiring: 30_000,
  boot: 10_000,
  host_keys: 15_000,
  health: 10_000,
  network: 10_000,
  old_unreachable: 10_000,
  // The person's choices and confirmations: the screen's update() wakes the runner at once.
  choose_vm: 60_000,
  choose_backup: 60_000,
  confirm_older: 60_000,
  choose_where: 60_000,
  confirm_retire: 60_000,
  confirm_reinstall: 60_000,
  old_vm_starting: 15_000,
  confirm_expired: 60_000,
  old_payment: 3_000,
  // install.sh recovery-check takes up to 15 minutes.
  recovery_check: 30_000,
  // The first wait after a dropped connection; RECONNECT_MS has the later ones.
  reconnect: 2_000,
  // A press of a day button wakes the runner, which waits this long after the last one before the invoice.
  pay_days: PAY_DAYS_SETTLE_MS,
  // The pay step asks LNVPS nothing until the 429's minute is up.
  lnvps_busy: 10_000,
};

/** After the first, second and third drop in a row (the fourth stops the step: machine.ts DROPS_WAITED). */
export const RECONNECT_MS = [2_000, 5_000, 10_000] as const;

/** How long to wait before asking again, for this state. */
export const waitMs = (s: OnboardingState): number =>
  s.waiting === 'reconnect' ? RECONNECT_MS[Math.min(s.drops?.n ?? 1, RECONNECT_MS.length) - 1] : WAIT_MS[s.waiting!];

export type Sleep = (ms: number, wake: AbortSignal) => Promise<void>;

const sleep: Sleep = (ms, wake) =>
  new Promise((resolve) => {
    if (wake.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    wake.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export type RunnerOptions = {
  initial: OnboardingState;
  deps: Omit<Deps, 'checkpoint'>;
  /** Persists a state (AppStore.saveOnboarding). */
  save: (s: OnboardingState) => Promise<void>;
  sleep?: Sleep;
  /** Called with every new state, e.g. to log progress. */
  log?: (s: OnboardingState) => void;
};

export class OnboardingRunner {
  private s: OnboardingState;
  private readonly listeners = new Set<(s: OnboardingState) => void>();
  /** Apart from the state's: an upload's figures are shown, never saved. */
  private readonly uploadListeners = new Set<(p: UploadProgress) => void>();
  private loop?: Promise<void>;
  private active = false;
  private wake?: AbortController;
  private inFlight = false;
  /** Changes made while advance() was running, applied again to what it returns. */
  private pending: ((s: OnboardingState) => OnboardingState)[] = [];

  constructor(private readonly o: RunnerOptions) {
    // A state saved while it waited to connect again (the app was killed there): opening the app is a new try.
    this.s = o.initial.drops ? { ...o.initial, drops: undefined, waiting: undefined } : o.initial;
  }

  get state(): OnboardingState {
    return this.s;
  }

  /** What it drives onboarding with (the pay screen reads LNVPS's clock from its client). */
  get deps(): RunnerOptions['deps'] {
    return this.o.deps;
  }

  get running(): boolean {
    return this.loop !== undefined;
  }

  subscribe(fn: (s: OnboardingState) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The install's upload as it goes (each file from 0 to its size), for every screen on this runner. */
  subscribeUpload(fn: (p: UploadProgress) => void): () => void {
    this.uploadListeners.add(fn);
    return () => void this.uploadListeners.delete(fn);
  }

  /** Runs until done, an error, or pause(). If it is waiting, asks again at once. */
  start(): Promise<void> {
    this.active = true;
    this.wake?.abort();
    return (this.loop ??= this.run().finally(() => (this.loop = undefined)));
  }

  /** Stops at the next wait (the current step, if any, finishes first). */
  pause(): void {
    this.active = false;
    this.wake?.abort();
  }

  async retry(): Promise<void> {
    await this.commit({ ...this.s, error: undefined });
    return this.start();
  }

  /**
   * The app is back in the foreground: retry a retryable error, else carry on as start() does. A return is a new
   * try: drops counted before it are forgotten, so a phone that was locked a few times never adds up to a stop.
   */
  async resume(): Promise<void> {
    if (this.s.error?.kind === 'retry') return this.retry();
    // A step still running: on an iPhone the app was paused under it, and its connection is found dead only now,
    // after this call. The drop that comes back is the first of a new row, and never the one that stops the step.
    if (this.inFlight) this.pending.push(afresh);
    else if (this.s.drops) await this.commit({ ...this.s, drops: undefined, waiting: undefined });
    return this.start();
  }

  /** Changes the state from the UI (e.g. withPayDays), saves it, and asks again at once. */
  async update(f: (s: OnboardingState) => OnboardingState): Promise<void> {
    if (this.inFlight) this.pending.push(f);
    await this.commit(f(this.s));
    this.wake?.abort();
  }

  private async commit(s: OnboardingState): Promise<void> {
    this.s = s;
    this.o.log?.(s);
    for (const fn of this.listeners) fn(s);
    await this.o.save(s);
  }

  private async run(): Promise<void> {
    // A backup refused as newer than this app's server may be fine once the app is updated: step 1 asks again.
    if (this.s.error?.kind === 'fatal' && this.s.error.message.startsWith(NEWER_BACKUP)) await this.commit({ ...this.s, error: undefined });
    while (this.active && this.s.step !== 'done' && !this.s.error) {
      let next: OnboardingState;
      // A change made during advance() (new days to pay for) is acted on at once, not after a wait.
      let changed = false;
      try {
        this.inFlight = true;
        next = await advance(this.s, {
          ...this.o.deps,
          checkpoint: (x) => this.commit(x),
          onUpload: (p) => {
            for (const fn of this.uploadListeners) fn(p);
          },
        });
        this.inFlight = false;
        changed = this.pending.length > 0;
        next = this.pending.reduce((acc, f) => f(acc), next);
        this.pending = [];
        await this.commit(next);
      } catch (e) {
        // advance() reports its own errors as state; this is the phone failing to save.
        this.inFlight = false;
        this.s = { ...this.s, error: { kind: 'retry', message: `Could not save progress: ${e instanceof Error ? e.message : e}` } };
        for (const fn of this.listeners) fn(this.s);
        return;
      }
      if (next.waiting && this.active && !changed) {
        this.wake = new AbortController();
        await (this.o.sleep ?? sleep)(waitMs(next), this.wake.signal);
        this.wake = undefined;
      }
    }
  }
}

/** What a step that was running across a return to the front comes back with, as a new try: a first drop, not a later one or the stop. */
function afresh(s: OnboardingState): OnboardingState {
  if (s.waiting === 'reconnect' && s.drops) return { ...s, drops: { ...s.drops, n: 1 } };
  if (s.error?.message === KEEPS_DROPPING) return { ...s, error: undefined, waiting: 'reconnect', drops: { n: 1, during: 'command', last: '' } };
  return s;
}

/**
 * One runner per app. A deep link can mount a second onboarding screen over
 * the first; both get this runner, so onboarding never runs twice at once.
 */
export class RunnerSlot {
  private runner?: OnboardingRunner;

  get(create: () => OnboardingRunner): OnboardingRunner {
    return (this.runner ??= create());
  }

  /** The runner, if an onboarding screen has made one in this process. */
  get current(): OnboardingRunner | undefined {
    return this.runner;
  }

  /**
   * Lets go of the runner, stopped: the wallet it ran for was removed from the phone, or is being paired again from
   * the start. The next onboarding screen makes a new one from the saved state.
   */
  reset(): void {
    this.runner?.pause();
    this.runner = undefined;
  }
}

/**
 * The country screen's choice. Once a runner exists it holds the state (the
 * onboarding screen reuses it and never re-reads the store), so the change goes
 * through it; before that, into the store.
 */
export async function chooseCountry(
  slot: RunnerSlot,
  store: { onboarding(): Promise<OnboardingState | null>; saveOnboarding(s: OnboardingState): Promise<void> },
  country: string,
): Promise<void> {
  const choose = (s: OnboardingState): OnboardingState => ({ ...s, country, error: undefined });
  if (slot.current) return slot.current.update(choose);
  await store.saveOnboarding(choose((await store.onboarding()) ?? initialState()));
}
