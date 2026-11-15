// The history line a payment's page was opened from: the account page puts it here before it
// opens the page, so the page draws the line's facts at once, before its details come. One line: the last opened.
// It holds the page's note save on its way too, for the account page's history read to wait for.
import type { Tx } from '../cardd/client';

/**
 * How long the history read waits for a save on its way: the cardd client has no timeout of its own, so a
 * hung PATCH held the history back as long as the request lived. The save goes on; the next read waits for it again.
 */
export const SETTLE_MS = 3000;

let kept: { account: string; tx: Tx } | null = null;

export const openedLine = {
  /**
   * The payment page's note save on its way, null when none is. The page saves on leaving it too (Android's back key
   * closes the keyboard without leaving the field), and the account page's history read then starts in the same
   * moment: it waits for this, so the row it shows carries the note just saved.
   */
  saving: null as Promise<unknown> | null,
  /**
   * Resolves when no save is on its way, waiting out one that starts as another ends; a save that failed counts. It
   * waits SETTLE_MS at most, leaving a save that hasn't answered as saving.
   */
  async settled(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), SETTLE_MS)));
    try {
      while (openedLine.saving) {
        const now = openedLine.saving;
        if ((await Promise.race([now.then(() => {}, () => {}), late])) === 'late') return;
        if (openedLine.saving === now) openedLine.saving = null;
      }
    } finally {
      clearTimeout(timer);
    }
  },
  put(account: string, tx: Tx): void {
    kept = { account, tx };
  },
  get(account: string, id: number): Tx | null {
    return kept && kept.account === account && kept.tx.id === id ? kept.tx : null;
  },
  /** Forgets the line and any save (the screen tests, between tests). */
  clear(): void {
    kept = null;
    openedLine.saving = null;
  },
};
