import { describe, expect, it } from 'vitest';
import { WalletEpoch } from './walletEpoch';

/** Something the app writes through, with its methods on a class as the store's are. */
class Notes {
  rows: string[] = [];
  async save(row: string): Promise<void> {
    this.rows.push(row);
  }
  async drop(row: string): Promise<void> {
    this.rows = this.rows.filter((r) => r !== row);
  }
  async all(): Promise<string[]> {
    return [...this.rows];
  }
}
const WRITES = ['save', 'drop'] as const;

// A wallet taken off the phone while work for it is still
// on its way. What that work was given to write through stops writing; nothing is put back into what was emptied.
describe('WalletEpoch', () => {
  it('lets what it bound write and read while the wallet is the one it was bound for', async () => {
    const notes = new Notes();
    const bound = new WalletEpoch().bind(notes, WRITES);
    await bound.save('a');
    await bound.save('b');
    await bound.drop('a');
    expect([notes.rows, await bound.all()]).toEqual([['b'], ['b']]);
  });

  it('stops the writes of everything bound before the wallet ended, and still reads', async () => {
    const epoch = new WalletEpoch();
    const notes = new Notes();
    const bound = epoch.bind(notes, WRITES);
    await bound.save('old');
    epoch.end();
    notes.rows = [];
    await bound.save('late');
    await bound.drop('nothing');
    expect([notes.rows, await bound.all()]).toEqual([[], []]);
  });

  it('lets what is bound after the end write: the next wallet is not held back by the last', async () => {
    const epoch = new WalletEpoch();
    const notes = new Notes();
    const before = epoch.bind(notes, WRITES);
    epoch.end();
    const after = epoch.bind(notes, WRITES);
    await before.save('old');
    await after.save('new');
    expect(notes.rows).toEqual(['new']);
  });

  it('says whether the wallet current when it was asked still is', () => {
    const epoch = new WalletEpoch();
    const live = epoch.live();
    expect(live()).toBe(true);
    epoch.end();
    expect([live(), epoch.live()()]).toEqual([false, true]);
  });

  // A removal takes several steps: the watch may wake between them and be given new clients, which must not write
  // into what the removal is emptying, then or once it has finished.
  it('while closed, binds nothing that can write, even after it is opened again', async () => {
    const epoch = new WalletEpoch();
    const notes = new Notes();
    const before = epoch.bind(notes, WRITES);
    const open = epoch.close();
    const during = epoch.bind(notes, WRITES);
    await before.save('before');
    await during.save('during');
    expect([notes.rows, epoch.live()()]).toEqual([[], false]);
    open();
    await before.save('before');
    await during.save('during');
    expect(notes.rows).toEqual([]);
    await epoch.bind(notes, WRITES).save('after');
    expect(notes.rows).toEqual(['after']);
  });

  it('stays closed until every close has been opened, each only once', async () => {
    const epoch = new WalletEpoch();
    const notes = new Notes();
    const first = epoch.close();
    const second = epoch.close();
    first();
    first();
    await epoch.bind(notes, WRITES).save('still closed');
    expect(notes.rows).toEqual([]);
    second();
    await epoch.bind(notes, WRITES).save('open');
    expect(notes.rows).toEqual(['open']);
  });

  it('passes on what a write answers and what it throws while it may write', async () => {
    const epoch = new WalletEpoch();
    const target = { put: async (n: number) => n * 2, fail: async (): Promise<void> => Promise.reject(new Error('disk full')), size: 3 };
    const bound = epoch.bind(target, ['put', 'fail']);
    expect(await bound.put(4)).toBe(8);
    await expect(bound.fail()).rejects.toThrow('disk full');
    expect(bound.size).toBe(3);
    epoch.end();
    expect(await bound.put(4)).toBeUndefined();
    await expect(bound.fail()).resolves.toBeUndefined();
  });

  // Carrying a wallet on, as taking one off, ends the wallet's work part-way through several steps: the server
  // watch can wake between them, read the state not yet replaced, and be given clients for it. They must never
  // write (a backups check with the new, unpaired key would mark the wallet "restored by another phone" for good).
  describe('whileClosed', () => {
    it('runs the act with the epoch closed: what is bound during it never writes, what is bound after does', async () => {
      const epoch = new WalletEpoch();
      const notes = new Notes();
      const before = epoch.bind(notes, WRITES);
      let during = before;
      const order: string[] = [];
      const answer = await epoch.whileClosed(
        async () => {
          during = epoch.bind(notes, WRITES);
          await during.save('during the act');
          order.push('act');
          return 'done';
        },
        () => order.push(`after, live: ${epoch.live()()}`),
      );
      await before.save('from before');
      await during.save('after the act, bound during it');
      await epoch.bind(notes, WRITES).save('after');
      expect([answer, order, notes.rows]).toEqual(['done', ['act', 'after, live: true'], ['after']]);
    });

    // Carrying on fails before it lets go of anything when the phone can't change its key: the wallet in front is
    // then the same one, and what it was given must go on writing. Only the act itself ends the wallet (its forget).
    it('whileHeld leaves what was bound before alone unless the act ends the wallet, and still binds nothing live during it', async () => {
      const epoch = new WalletEpoch();
      const notes = new Notes();
      const before = epoch.bind(notes, WRITES);
      await expect(
        epoch.whileHeld(
          async () => {
            await before.save('before, during a held act');
            await epoch.bind(notes, WRITES).save('bound during');
            throw new Error('the key could not be removed');
          },
          () => {},
        ),
      ).rejects.toThrow('the key could not be removed');
      await before.save('before, after the act failed');
      expect(notes.rows).toEqual(['before, during a held act', 'before, after the act failed']);

      notes.rows = [];
      let during = before;
      await epoch.whileHeld(
        async () => {
          epoch.end();
          during = epoch.bind(notes, WRITES);
        },
        () => {},
      );
      await before.save('before');
      await during.save('bound during');
      await epoch.bind(notes, WRITES).save('after');
      expect(notes.rows).toEqual(['after']);
    });

    it('opens again, and calls after once, when the act fails; the failure is the act\'s', async () => {
      const epoch = new WalletEpoch();
      const notes = new Notes();
      let after = 0;
      await expect(
        epoch.whileClosed(
          async () => {
            throw new Error('errSecInteractionNotAllowed');
          },
          () => void after++,
        ),
      ).rejects.toThrow('errSecInteractionNotAllowed');
      await epoch.bind(notes, WRITES).save('open again');
      expect([after, notes.rows]).toEqual([1, ['open again']]);
    });
  });
});
