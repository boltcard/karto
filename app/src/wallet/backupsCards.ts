// The Backups page's cards: how the backups stand, what needs the person,
// and why the lines are only the phone's when they are. The page draws them with Export backups.
import type { BackupsView } from '../backup/panel';
import type { RowTone } from '../ui/look';
import { REVOKED_HERE } from './pairAgain';

// Export stays on offer: clearing the storage deletes the backups this phone keeps.
export const REVOKED =
  "Another phone restored this server. To use this phone again, first export its backups below, then clear this app's storage in Android's settings and restore here with your recovery phrase.";

export type BackupsCards = {
  state: { tone: RowTone; title: string };
  lines: string[];
  /** Under the lines: they are only what the phone keeps, or the server makes none. */
  note: 'unreachable' | 'no-api' | null;
  /** Red cards: another phone's restore first, then each warning. */
  problems: string[];
  /** The check's own failure, under Export backups. */
  failure: string | null;
  /** Pair this iPhone again, under another phone's restore, where the phrase outlives the app. */
  pairAgain?: true;
};

/** outlivesApp: the phrase store's, an iPhone's: there is no storage to clear there, and the page pairs the phone again. */
export function backupsCards(v: BackupsView | null, o: { outlivesApp?: boolean } = {}): BackupsCards {
  const again = !!v?.revoked && !!o.outlivesApp;
  const problems = v ? [...(v.revoked ? [again ? REVOKED_HERE : REVOKED] : []), ...v.warnings] : [];
  const pair = again ? { pairAgain: true as const } : {};
  if (!v || v.checking) {
    // What the phone keeps shows at once, as the panel showed it: the fetch can take seconds. So do the warnings
    // the phone already has: Settings' Backups row is red for them, and the page must say why.
    return { state: { tone: 'none', title: 'Checking backups…' }, lines: v?.lines ?? [], note: null, problems, failure: null, ...pair };
  }
  const state: BackupsCards['state'] =
    problems.length > 0 || v.failure !== null
      ? { tone: 'error', title: 'Backups need you' }
      : v.unreachable
        ? { tone: 'none', title: "Can't reach the server" }
        : v.noApi
          ? { tone: 'warn', title: 'Your server is too old to make backups' }
          : { tone: 'ok', title: 'Backed up' };
  return { state, lines: v.lines, note: v.unreachable ? 'unreachable' : v.noApi ? 'no-api' : null, problems, failure: v.failure, ...pair };
}
