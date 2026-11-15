import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOnce, openRetrying, openStore } from './startup';

describe('openRetrying', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens at once when nothing goes wrong', async () => {
    const open = vi.fn(async () => 'services');
    expect(await openRetrying(open)).toBe('services');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('tries again half a second after a failure, and logs the failed try', async () => {
    const log = vi.fn();
    const open = vi.fn().mockRejectedValueOnce(new Error('NullPointerException')).mockResolvedValue('services');
    const p = openRetrying(open, { log });
    await vi.advanceTimersByTimeAsync(499);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('services');
    expect(open).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(1, expect.objectContaining({ message: 'NullPointerException' }));
  });

  it('gives up after three tries with the last error, without waiting after the last', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('one')).mockRejectedValueOnce(new Error('two')).mockRejectedValue(new Error('three'));
    const p = openRetrying(open);
    const done = expect(p).rejects.toThrow('three');
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(open).toHaveBeenCalledTimes(3);
  });
});

/** A database whose first statement fails, as the one handed back right after the screen was re-created did. */
function db(fail: boolean) {
  const closed = { count: 0 };
  return {
    closed,
    execAsync: async () => {
      if (fail) throw new Error("Call to function 'NativeDatabase.execAsync' has been rejected");
    },
    runAsync: async () => null,
    getFirstAsync: async () => null,
    getAllAsync: async () => [],
    closeAsync: async () => {
      closed.count++;
    },
  };
}

describe('openStore', () => {
  it('keeps a database that opens', async () => {
    const d = db(false);
    await openStore(d);
    expect(d.closed.count).toBe(0);
  });

  // expo-sqlite hands the same open database back to the next open: closing it lets a retry start afresh.
  it('closes a database whose first statement fails, and says why', async () => {
    const d = db(true);
    await expect(openStore(d)).rejects.toThrow('NativeDatabase.execAsync');
    expect(d.closed.count).toBe(1);
  });

  it('says why the statement failed even when closing fails too', async () => {
    const d = { ...db(true), closeAsync: async () => { throw new Error('close failed'); } };
    await expect(openStore(d)).rejects.toThrow('NativeDatabase.execAsync');
  });
});

describe('openOnce', () => {
  // Android can destroy the screen and make a new one in the same process; JS carries on and the app mounts again.
  it('hands every later mount what the first opened, opening only once', async () => {
    const open = vi.fn(async () => ({ store: 'one' }));
    const services = openOnce(open);
    const first = await services();
    expect(await services()).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shares an open still under way', async () => {
    const open = vi.fn(async () => 'services');
    const services = openOnce(open);
    const [a, b] = await Promise.all([services(), services()]);
    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens afresh after a failed open, for Try again', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('could not open')).mockResolvedValue('services');
    const services = openOnce(open);
    await expect(services()).rejects.toThrow('could not open');
    expect(await services()).toBe('services');
    expect(open).toHaveBeenCalledTimes(2);
  });
});
