// Which wallet this run of the app is working for, as a count that moves on when that wallet goes: taken off the
// phone, or carried on with a new key. The app's
// database is opened once per run (startup.ts), so a removal empties it in place, under requests still on their
// way: a card list, a photo, a backups check. Each was given the store through bind(), and once its wallet has
// ended its writes do nothing, so none of them puts back what was just removed.

export class WalletEpoch {
  private n = 0;
  private closed = 0;

  /** The wallet is gone from this run: everything bound before now writes no more. */
  end(): void {
    this.n++;
  }

  /**
   * end(), and until the function it returns is called nothing bound can write either, then or later: a removal
   * takes several steps, and what wakes between them must not write into what it is emptying.
   */
  close(): () => void {
    this.end();
    return this.hold();
  }

  /** As close(), without ending the wallet: what was bound before goes on writing unless end() is called. */
  private hold(): () => void {
    this.closed++;
    let opened = false;
    return () => {
      if (opened) return;
      opened = true;
      this.closed--;
    };
  }

  /**
   * act, with the epoch closed for as long as it runs, whatever its outcome; then after, once it is open again (the
   * caller has the server watch let go of the clients it may have been given meanwhile, which never write). For
   * taking a wallet off the phone: its work ends before the first step.
   */
  whileClosed<T>(act: () => Promise<T>, after: () => void): Promise<T> {
    return this.during(this.close(), act, after);
  }

  /**
   * As whileClosed, but the wallet is not ended here: the act ends it itself, part-way, or fails before that and
   * leaves the wallet in front as it was, still writing. For carrying a wallet on with a new key: nothing given the
   * store between its steps may write, least of all a backups check asking the server with the unpaired key.
   */
  whileHeld<T>(act: () => Promise<T>, after: () => void): Promise<T> {
    return this.during(this.hold(), act, after);
  }

  private async during<T>(open: () => void, act: () => Promise<T>, after: () => void): Promise<T> {
    try {
      return await act();
    } finally {
      open();
      after();
    }
  }

  /** Whether the wallet that is current now still is, asked later. Asked for while closed, never. */
  live(): () => boolean {
    if (this.closed > 0) return () => false;
    const n = this.n;
    return () => n === this.n;
  }

  /**
   * target, for the wallet current now: its `writes` do nothing, and answer nothing, once that wallet has ended.
   * Everything else (its reads) goes through as it is.
   */
  bind<T extends object>(target: T, writes: readonly (keyof T)[]): T {
    const live = this.live();
    return new Proxy(target, {
      get: (t, key) => {
        const value: unknown = Reflect.get(t, key, t);
        if (typeof value !== 'function') return value;
        if (!writes.includes(key as keyof T)) return value.bind(t);
        return (...args: unknown[]) => (live() ? value.apply(t, args) : Promise.resolve());
      },
    });
  }
}

/**
 * The one epoch of this run. The services hold it, and the background job binds to it too: when the job runs
 * inside the running app (the only way it can overlap a removal) it writes to the app's database, on a connection
 * of its own (backup/jobDb.ts), and its notes and snapshots for a wallet since removed must not land. In a run of its own the job's epoch never ends.
 */
export const walletEpoch = new WalletEpoch();
