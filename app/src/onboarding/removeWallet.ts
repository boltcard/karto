// Taking a wallet off a phone that keeps it when the app is deleted (an iPhone):
// from Settings' Remove this wallet, and before a new wallet is
// started on a phone that still has an old one. The server is not touched, and is not told.

/** The three things removed, in their order. */
export type RemovalStep = 'memory' | 'key' | 'phrase';

const WHAT: Record<RemovalStep, string> = {
  memory: 'what the app remembers',
  key: "this phone's key",
  phrase: 'the recovery phrase',
};

/** A removal stopped at a step: everything after it is as it was, the phrase above all. */
export class RemovalError extends Error {
  constructor(
    readonly step: RemovalStep,
    readonly reason: string,
  ) {
    super(`${WHAT[step]} (${reason})`);
    this.name = 'RemovalError';
  }
}

/**
 * Removes, in this order and each only once the one before is done:
 * 1. what the app remembers: the background job's registration, the database's contents, the backups it keeps.
 *    Before any of it, what the running app holds for the wallet is let go (forget): the server watch and the
 *    onboarding runner then drop the answers still on their way to them, so none is written back into a database
 *    just emptied; no screen goes on showing the wallet; and nothing of it reaches a wallet set up next in the
 *    same run;
 * 2. the phone's key;
 * 3. the phrase, which its store reads back gone.
 * The phrase goes last, so a removal that stops leaves it where it was; from step 2 on the phone is one with a
 * phrase and no memory, which the app opens on its found-wallet screen, where the removal can be finished.
 */
export async function removeWallet(d: {
  job: { unregister(): Promise<unknown> };
  store: { clear(): Promise<unknown> };
  backups: { removeAll(): Promise<unknown> };
  deviceKey: { remove(): Promise<unknown> };
  phrase: { remove(): Promise<unknown> };
  forget(): void;
}): Promise<void> {
  const step = async (name: RemovalStep, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      throw new RemovalError(name, e instanceof Error ? e.message : String(e));
    }
  };
  d.forget();
  await step('memory', async () => {
    await d.job.unregister();
    await d.store.clear();
    await d.backups.removeAll();
  });
  await step('key', () => d.deviceKey.remove());
  await step('phrase', () => d.phrase.remove());
}

/** What the page says when a removal stopped. */
export const removalFailed = (e: unknown): string =>
  `Couldn't remove everything from this iPhone: ${e instanceof Error ? e.message : String(e)}. Your recovery phrase is still here. Try again.`;
