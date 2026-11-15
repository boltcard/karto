// A phone the server no longer knows, where the phrase outlives the app:
// an iPhone erased and restored from its backup has its phrase and no key, and one another phone's restore
// unpaired keeps a key the server refuses. Android's words for both name what an iPhone has not got; here each says
// what happened, and the pages offer one button, which pairs the phone again with a restore.
import type { ServerStatus } from '../cardd/status';

export const NO_KEY_HERE = 'This iPhone has your recovery phrase but has lost its own key, which no backup holds.';
export const REVOKED_HERE = 'Another phone restored this server, and this iPhone is no longer paired with it.';

/** The button, the muted line under it (every restore unpairs the other phones), and the lock's title. */
export const PAIR_AGAIN = {
  button: 'Pair this iPhone again',
  line: 'Your other phones are unpaired; Karto PoS phones stay.',
  lockTitle: 'Pair this iPhone again',
} as const;

/**
 * What to say beside Pair this iPhone again; null: nothing to put right, or a phone whose phrase goes with the app,
 * where Android's words stand. revoked: the backups check found another phone's restore.
 */
export function pairAgain(o: { outlivesApp: boolean; status: ServerStatus | null; revoked: boolean }): { text: string } | null {
  if (!o.outlivesApp) return null;
  const notPaired = o.status?.kind === 'not_paired' ? o.status : null;
  // A phone with no key was told nothing by the server: the lost key is what it can put right.
  if (notPaired?.noKey) return { text: NO_KEY_HERE };
  if (o.revoked) return { text: REVOKED_HERE };
  return notPaired ? { text: notPaired.message } : null;
}
