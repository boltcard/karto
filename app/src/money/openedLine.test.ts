import { afterEach, describe, expect, it, vi } from 'vitest';
import { openedLine, SETTLE_MS } from './openedLine';

describe('openedLine.settled', () => {
  afterEach(() => {
    vi.useRealTimers();
    openedLine.clear();
  });

  it('a save that hangs holds the history read back 3 s at most, and is waited for again by the next', async () => {
    vi.useFakeTimers();
    const hung = new Promise<never>(() => {});
    openedLine.saving = hung;
    let read = false;
    void openedLine.settled().then(() => (read = true));
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
    expect(read).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(read).toBe(true);
    expect(openedLine.saving).toBe(hung);
  });

  it('a save that answers in time lets the read go at once', async () => {
    let answer!: () => void;
    openedLine.saving = new Promise<void>((r) => (answer = r));
    const read = openedLine.settled().then(() => 'read');
    answer();
    expect(await read).toBe('read');
    expect(openedLine.saving).toBeNull();
  });
});
