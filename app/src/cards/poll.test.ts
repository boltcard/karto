import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heldLoop, poll, type Asked } from './poll';

describe('poll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls every interval until stopped', async () => {
    const fn = vi.fn(async () => {});
    const stop = poll(fn, 5000, () => true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never runs two at once: the next waits for a slow one', async () => {
    let running = 0;
    let most = 0;
    const fn = vi.fn(async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 12_000));
      running--;
    });
    const stop = poll(fn, 5000, () => true);
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    expect(most).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2); // at 5 s and at 5 + 12 + 5 = 22 s
  });

  it('skips while not active, and keeps going after a failure', async () => {
    let active = false;
    const fn = vi.fn(async () => {
      throw new Error('offline');
    });
    const stop = poll(fn, 5000, () => active);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).not.toHaveBeenCalled();
    active = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('heldLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** An ask the test answers: moved (something new came) or not, or a failure, after ms on the server. */
  function server() {
    const asked: number[] = [];
    let next: { ms: number; moved?: boolean; plain?: boolean; fail?: boolean } = { ms: 0 };
    const ask = () => {
      asked.push(Date.now());
      const { ms, moved = false, plain = false, fail = false } = next;
      return new Promise<Asked>((done, failed) => setTimeout(() => (fail ? failed(new Error('offline')) : done(moved ? 'moved' : plain ? 'plain' : 'held')), ms));
    };
    return { asked, ask, answers: (n: typeof next) => void (next = n) };
  }

  it('asks at once, and again the moment an answer the server held comes', async () => {
    const s = server();
    s.answers({ ms: 5000 }); // held for the whole wait, with nothing new
    const { stop } = heldLoop({ ask: s.ask, active: () => true });
    await vi.advanceTimersByTimeAsync(16_000);
    stop();
    expect(s.asked.map((t) => t - s.asked[0])).toEqual([0, 5000, 10_000, 15_000]);
  });

  it('waits 5 seconds after an answer that came at once with nothing new: a server that does not hold is asked as before', async () => {
    const s = server();
    s.answers({ ms: 20 });
    const { stop } = heldLoop({ ask: s.ask, active: () => true });
    await vi.advanceTimersByTimeAsync(10_500);
    stop();
    expect(s.asked.map((t) => t - s.asked[0])).toEqual([0, 5020, 10_040]);
  });

  it('waits 5 seconds after a plain read, however long it took: a slow answer is not one the server held', async () => {
    const s = server();
    s.answers({ ms: 3000, plain: true });
    const { stop } = heldLoop({ ask: s.ask, active: () => true });
    await vi.advanceTimersByTimeAsync(17_000);
    stop();
    expect(s.asked.map((t) => t - s.asked[0])).toEqual([0, 8000, 16_000]);
  });

  it('asks again at once after an answer that moved on, but never more than 4 times a second', async () => {
    const s = server();
    s.answers({ ms: 20, moved: true }); // a server that says "new" every time
    const { stop } = heldLoop({ ask: s.ask, active: () => true });
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    expect(s.asked.map((t) => t - s.asked[0])).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
  });

  it('waits 5 seconds after a failure, and asks nothing while not active', async () => {
    const s = server();
    let active = false;
    s.answers({ ms: 20, fail: true });
    const { stop } = heldLoop({ ask: s.ask, active: () => active });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(s.asked).toHaveLength(0);
    active = true;
    await vi.advanceTimersByTimeAsync(16_000);
    stop();
    // Looked at every 5 seconds while behind; in front, a failed ask is followed 5 seconds after it failed.
    expect(s.asked.map((t) => t - s.asked[0])).toEqual([0, 5020, 10_040]);
  });

  it('can start later, and a kick has a waiting loop ask at once: its caller has learned what to ask past', async () => {
    const s = server();
    s.answers({ ms: 20 });
    const t0 = Date.now();
    const { stop, kick } = heldLoop({ ask: s.ask, active: () => true, startIn: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.asked).toHaveLength(0);
    kick(); // before its first turn
    await vi.advanceTimersByTimeAsync(100);
    expect(s.asked.map((t) => t - t0)).toEqual([2000]);
    kick(); // 100 ms after an ask began: not before 250 ms after it
    kick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.asked.map((t) => t - t0)).toEqual([2000, 2250]);
    s.answers({ ms: 3000 });
    await vi.advanceTimersByTimeAsync(5000); // the next turn, at 2270 + 5000, is held 3 seconds by the server
    kick(); // while it asks: nothing more is asked
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.asked.map((t) => t - t0)).toEqual([2000, 2250, 7270]);
    stop();
    kick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.asked).toHaveLength(3);
  });

  it('never has two asks under way, and asks no more once stopped', async () => {
    const s = server();
    s.answers({ ms: 3000, moved: true });
    let under = 0;
    let most = 0;
    const { stop } = heldLoop({
      ask: async () => {
        most = Math.max(most, ++under);
        try {
          return await s.ask();
        } finally {
          under--;
        }
      },
      active: () => true,
    });
    await vi.advanceTimersByTimeAsync(7000);
    expect(most).toBe(1);
    expect(s.asked).toHaveLength(3); // at 0, 3 and 6 seconds
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.asked).toHaveLength(3);
  });
});
