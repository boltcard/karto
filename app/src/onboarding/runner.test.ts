import { describe, expect, it } from 'vitest';
import { initialState, NEWER_BACKUP, startRebuild, withPayDays, type OnboardingState } from './machine';
import { chooseCountry, OnboardingRunner, RunnerSlot, WAIT_MS } from './runner';
import { HOST_KEY, world } from '../testing/world';
import { SshDropped } from './ssh';
import type { FetchFn } from '../lightning/lightning';
import { LnvpsClient } from '../lnvps/client';

/** A runner over the fake world whose sleeps let the world move on (and record the waits). */
function setup(initial = initialState('GBR')) {
  const t = world();
  const saved: OnboardingState[] = [];
  const waits: number[] = [];
  const runner = new OnboardingRunner({
    initial,
    deps: t.deps,
    save: async (s) => void saved.push(s),
    sleep: async (ms) => {
      waits.push(ms);
      const s = runner.state;
      if (s.waiting === 'payment') t.lnvps.pay(s.vmId!);
      if (s.waiting === 'boot') t.lnvps.boot(s.vmId!);
      if (s.waiting === 'host_keys') t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    },
  });
  return { t, runner, saved, waits };
}

describe('OnboardingRunner', () => {
  // The setup screen's megabytes: a runner is shared, so every screen on it listens.
  it("passes the install's upload progress to every listener, and to none that has left", async () => {
    const { t, runner, saved } = setup();
    const first: number[] = [];
    const second: number[] = [];
    const gone: number[] = [];
    runner.subscribeUpload((p) => first.push(p.sent));
    runner.subscribeUpload((p) => second.push(p.sent));
    runner.subscribeUpload((p) => gone.push(p.sent))();
    await runner.start();
    expect(runner.state.step).toBe('done');
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(gone).toEqual([]);
    // The world's own deps are left as they were, and no figure reaches a saved state.
    expect(t.deps.onUpload).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('"sent"');
  });

  // A deep link can mount a second onboarding screen over the first: both must drive the
  // same runner, or two of them would order, pay-poll and install over SSH at once.
  it('gives every screen the same runner, so onboarding runs once', async () => {
    const t = world();
    const slot = new RunnerSlot();
    let made = 0;
    const create = (): OnboardingRunner => {
      made++;
      const r: OnboardingRunner = new OnboardingRunner({
        initial: initialState('GBR'),
        deps: t.deps,
        save: async () => {},
        sleep: async () => {
          const s = r.state;
          if (s.waiting === 'payment') t.lnvps.pay(s.vmId!);
          if (s.waiting === 'boot') t.lnvps.boot(s.vmId!);
          if (s.waiting === 'host_keys') t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
        },
      });
      return r;
    };
    const first = slot.get(create);
    const second = slot.get(create);
    expect(second).toBe(first);
    expect(made).toBe(1);
    await Promise.all([first.start(), second.start()]);
    expect(first.state.step).toBe('done');
    expect(t.lnvps.vms.size).toBe(1);
    expect(t.ssh.ran(/install\.sh up/)).toBe(1);
  });

  // A backup refused as newer than the app's server is asked about again on the next start, as the app may have been updated.
  it('clears a newer-backup refusal when it starts, but not other fatal errors', async () => {
    for (const [message, cleared] of [[`${NEWER_BACKUP} of the server than this app carries: update the app first`, true], ['The VM runs on arm64', false]] as const) {
      const t = world();
      const base = startRebuild({ ...initialState('GBR'), step: 'done', vmId: 1012 }, 'server_page');
      const runner: OnboardingRunner = new OnboardingRunner({
        initial: { ...base, error: { kind: 'fatal', message } }, deps: t.deps, save: async () => {}, sleep: async () => runner.pause(),
      });
      await runner.start();
      expect(runner.state.error === undefined).toBe(cleared);
    }
  });

  // "Choose another country" after a VAT refusal: the runner already in memory holds the
  // refused country, so the new one must reach it, not just the store.
  it('carries on with the country chosen after a refusal', async () => {
    const { t, runner } = setup(initialState('IRL'));
    const slot = new RunnerSlot();
    slot.get(() => runner);
    await runner.start();
    expect(runner.state.error).toMatchObject({ kind: 'fatal' });
    let stored: OnboardingState | null = runner.state;
    const store = { onboarding: async () => stored, saveOnboarding: async (s: OnboardingState) => void (stored = s) };
    await chooseCountry(slot, store, 'GBR');
    await slot.get(() => {
      throw new Error('a second runner');
    }).start();
    expect(runner.state).toMatchObject({ country: 'GBR', step: 'done' });
    expect(t.lnvps.vms.size).toBe(1);
  });

  // A wallet removed, and a new one set up, in one run of the app.
  it('lets go of its runner, so a new wallet is not saved with the old one\'s server', async () => {
    const { runner } = setup(initialState('GBR'));
    const slot = new RunnerSlot();
    slot.get(() => runner);
    await runner.start();
    expect(runner.state.step).toBe('done');
    slot.reset();
    expect(slot.current).toBeUndefined();
    let stored: OnboardingState | null = null;
    const store = { onboarding: async () => stored, saveOnboarding: async (s: OnboardingState) => void (stored = s) };
    await chooseCountry(slot, store, 'IRL');
    expect(stored).toEqual(initialState('IRL'));
    expect(runner.state.country).toBe('GBR');
    let made = 0;
    slot.get(() => (made++, runner));
    expect(made).toBe(1);
  });

  // Before onboarding has a runner (first run, or after restore), the choice goes to the store.
  it('saves the chosen country when no runner exists yet', async () => {
    let stored: OnboardingState | null = null;
    const store = { onboarding: async () => stored, saveOnboarding: async (s: OnboardingState) => void (stored = s) };
    await chooseCountry(new RunnerSlot(), store, 'GBR');
    expect(stored).toEqual(initialState('GBR'));
  });

  it('rides out a network failure without a button press', async () => {
    const t = world();
    let failures = 2;
    const flaky: FetchFn = async (url, init) => {
      if (failures-- > 0) throw new TypeError('fetch failed: java.net.UnknownHostException: Unable to resolve host "api.lnvps.net"');
      return t.deps.fetch(url, init);
    };
    const waits: number[] = [];
    const runner: OnboardingRunner = new OnboardingRunner({
      initial: initialState('GBR'),
      deps: { ...t.deps, lnvps: new LnvpsClient({ fetch: flaky, nostrSecretKey: t.keys.nostrPrivateKey, now: () => t.w.nowMs }) },
      save: async () => {},
      sleep: async (ms) => {
        waits.push(ms);
        const s = runner.state;
        if (s.waiting === 'payment') t.lnvps.pay(s.vmId!);
        if (s.waiting === 'boot') t.lnvps.boot(s.vmId!);
        if (s.waiting === 'host_keys') t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
      },
    });
    await runner.start();
    expect(runner.state.step).toBe('done');
    expect(waits.slice(0, 2)).toEqual([WAIT_MS.network, WAIT_MS.network]);
  });

  it('drives onboarding to done, saving every state and waiting between polls', async () => {
    const { runner, saved, waits } = setup();
    await runner.start();
    expect(runner.state.step).toBe('done');
    expect(saved.at(-1)!.step).toBe('done');
    // Each install step is saved as it finishes, not only at the end.
    expect(saved.filter((s) => s.step === 'install').map((s) => s.installed.length)).toContain(3);
    expect(waits).toContain(WAIT_MS.payment);
    expect(waits).toContain(WAIT_MS.boot);
  });

  it('stops on an error and goes on after retry()', async () => {
    const { t, runner } = setup();
    t.ssh.when(/install\.sh up/, { code: 1, stderr: 'dependency failed to start' }, 1);
    await runner.start();
    expect(runner.state).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    await runner.retry();
    expect(runner.state.step).toBe('done');
  });

  it('tells subscribers about every state', async () => {
    const { runner } = setup();
    const seen: string[] = [];
    const off = runner.subscribe((s) => seen.push(s.step));
    await runner.start();
    off();
    expect(seen.at(-1)).toBe('done');
    expect(new Set(seen)).toEqual(new Set(['email', 'order', 'pay', 'boot', 'install', 'pair', 'done']));
  });

  // The user leaves to pay in another wallet: polling stops in the background and starts
  // again, at once, in the foreground.
  it('pauses at the next wait and wakes at once on start()', async () => {
    const t = world();
    let paused = false;
    const runner: OnboardingRunner = new OnboardingRunner({
      initial: initialState('GBR'),
      deps: t.deps,
      save: async () => {},
      sleep: (_ms, signal) => {
        const w = runner.state.waiting;
        if (w === 'payment' && !paused) {
          paused = true;
          runner.pause(); // the app went to the background while waiting for payment
        }
        if (w === 'boot' && !signal.aborted) return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        if (w === 'host_keys') t.lnvps.publishHostKeys(runner.state.vmId!, [HOST_KEY]);
        return Promise.resolve();
      },
    });
    await runner.start();
    expect(runner.state).toMatchObject({ step: 'pay', waiting: 'payment' });
    expect(runner.running).toBe(false);
    t.lnvps.pay(runner.state.vmId!);
    const resumed = runner.start();
    // Woken at once: the payment is seen without waiting out WAIT_MS.payment.
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.state.step).not.toBe('pay');
    runner.pause();
    await resumed;
  });

  // The day picker changes state while an advance may be in flight; the change must survive it.
  it('keeps a change made while a step is running', async () => {
    const { t, runner } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const satPerDay = t.deps.lnvps.satPerDay.bind(t.deps.lnvps);
    t.deps.lnvps.satPerDay = async (id) => {
      await gate;
      return satPerDay(id);
    };
    const run = runner.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.state.step).toBe('pay');
    await runner.update((s) => withPayDays(s, 2));
    release();
    await run;
    expect(runner.state.payDays).toBe(2);
    expect(runner.state.step).toBe('done');
    // The change dropped the invoice that was in flight; the one paid is for the 2 days.
    expect(t.lnvps.invoices.map((i) => i.msat).at(-1)).toBe(443_000n);
  });

  // Back from the wallet app after a network blip: carry on by itself; but never retry what can't succeed.
  it('resume() retries a retryable error, but not a fatal one', async () => {
    const { t, runner } = setup();
    t.ssh.when(/install\.sh up/, { code: 1, stderr: 'connection reset' }, 1);
    await runner.start();
    expect(runner.state.error?.kind).toBe('retry');
    await runner.resume();
    expect(runner.state.step).toBe('done');

    const vat = setup(initialState('IRL')); // LNVPS charges Irish VAT
    await vat.runner.start();
    expect(vat.runner.state.error?.kind).toBe('fatal');
    await vat.runner.resume();
    expect(vat.runner.state).toMatchObject({ step: 'country', error: { kind: 'fatal' } });
  });
});

// After a drop the runner asks again by itself, a little later each time.
describe('OnboardingRunner, a connection that drops', () => {
  it('waits 2, 5, then 10 seconds, then stops at the fourth drop in a row', async () => {
    const { t, runner, waits } = setup();
    t.ssh.drop(/install\.sh prepare/, 4);
    await runner.start();
    expect(runner.state).toMatchObject({ step: 'install', error: { kind: 'retry' } });
    expect(runner.state.error!.message).toContain('can’t keep a connection to your server');
    expect(waits.slice(-3)).toEqual([2_000, 5_000, 10_000]);
    // Try again starts the count afresh, and the step runs.
    await runner.retry();
    expect(runner.state.step).toBe('done');
  });

  it('carries on by itself when the connection holds again, with nothing pressed', async () => {
    const { t, runner, waits, saved } = setup();
    t.ssh.drop(/install\.sh first-boot/, 2);
    await runner.start();
    expect(runner.state.step).toBe('done');
    // Its two waits follow one another: nothing else is waited for between two tries at the same step.
    expect(waits.join(' ')).toContain('2000 5000');
    expect(saved.filter((s) => s.waiting === 'reconnect').map((s) => s.drops?.n)).toEqual([1, 2]);
    expect(saved.some((s) => s.error)).toBe(false);
  });

  // The runner is paused away from the screen; a return to the front is a new try, whatever was counted before.
  it('asks again at once when resumed, and counts from nothing', async () => {
    const t = world();
    const saved: OnboardingState[] = [];
    const waits: number[] = [];
    const runner: OnboardingRunner = new OnboardingRunner({
      initial: initialState('GBR'),
      deps: t.deps,
      save: async (s) => void saved.push(s),
      sleep: async (ms) => {
        waits.push(ms);
        const s = runner.state;
        if (s.waiting === 'payment') t.lnvps.pay(s.vmId!);
        if (s.waiting === 'boot') t.lnvps.boot(s.vmId!);
        if (s.waiting === 'host_keys') t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
        // The app leaves the screen during the third wait for the connection.
        if (s.waiting === 'reconnect' && s.drops?.n === 3) runner.pause();
      },
    });
    t.ssh.drop(/install\.sh prepare/, 5);
    await runner.start();
    expect(runner.state).toMatchObject({ waiting: 'reconnect', drops: { n: 3 } });
    await runner.resume();
    // Two more drops were left: counted 1 and 2, not 4 and 5, so no stop.
    expect(runner.state.step).toBe('done');
    expect(saved.filter((s) => s.waiting === 'reconnect').map((s) => s.drops?.n)).toEqual([1, 2, 3, 1, 2]);
    expect(saved.some((s) => s.error)).toBe(false);
  });

  /** A runner whose install's build step drops as told: the nth start of it does what `at` says (true: drops). */
  function flaky(at: (n: number, runner: OnboardingRunner) => boolean) {
    const x = setup();
    let n = 0;
    x.t.ssh.when(/install\.sh prepare/, () => {
      if (at(++n, x.runner)) throw new SshDropped('command', 'Broken pipe');
      return undefined;
    });
    return x;
  }
  /** The app leaves the screen and comes back while a step is running, as an iPhone's lock does: the drop shows only after. */
  const awayAndBack = (runner: OnboardingRunner) => {
    runner.pause();
    void runner.resume();
  };

  // An iPhone is paused while away: the connection is found dead only once the app is back, after it was told so.
  it('counts a drop that a return to the front finds as the first of a new row', async () => {
    const { runner, saved } = flaky((n, r) => {
      if (n === 3) awayAndBack(r);
      return n <= 5;
    });
    await runner.start();
    expect(runner.state.step).toBe('done');
    expect(saved.filter((s) => s.waiting === 'reconnect').map((s) => s.drops?.n)).toEqual([1, 2, 1, 2, 3]);
    expect(saved.some((s) => s.error)).toBe(false);
  });

  it('does not stop at a fourth drop that a return to the front found', async () => {
    const { runner, saved } = flaky((n, r) => {
      if (n === 4) awayAndBack(r);
      return n <= 4;
    });
    await runner.start();
    expect(runner.state.step).toBe('done');
    expect(saved.filter((s) => s.waiting === 'reconnect').map((s) => s.drops?.n)).toEqual([1, 2, 3, 1]);
    expect(saved.some((s) => s.error)).toBe(false);
  });

  // The app killed while it waited, and opened again: a new try, as a return to the front is.
  it('starts from nothing when it is made from a state saved while it waited to connect again', () => {
    const waiting: OnboardingState = { ...initialState('GBR'), step: 'install', waiting: 'reconnect', drops: { n: 3, during: 'command', last: 'Broken pipe' } };
    const runner = new OnboardingRunner({ initial: waiting, deps: world().deps, save: async () => {} });
    expect([runner.state.drops, runner.state.waiting, runner.state.step]).toEqual([undefined, undefined, 'install']);
  });

  it('has a wait of its own for it', () => {
    expect(WAIT_MS.reconnect).toBe(2_000);
  });
});
