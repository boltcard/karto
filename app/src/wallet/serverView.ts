// What the server page worked out from what it held, now from the watch's
// snapshot: the host-key notice, the rebuild
// suggestion, the old server's warning, a pause and a restore, and which of
// Settings' server controls are on offer. The server page's helpers make the
// words, so they stay in one place.
import { pausedText } from '../cards/labels';
import { hostKeyNotice } from '../onboarding/progress';
import { oldVmWarning, rebuildSuggestion, restoreView, type RestoreView } from '../onboarding/serverPage';
import type { WatchSnapshot } from '../services/serverWatch';
import { moneyOff } from './banners';

export type ServerViewInput = Pick<WatchSnapshot, 'state' | 'status' | 'unreachable' | 'wallet' | 'lnvps' | 'update' | 'retire' | 'keyCheckedAt'>;

export type ServerView = {
  keyNotice: ReturnType<typeof hostKeyNotice>;
  /** Rebuild server is suggested: the line above it. */
  rebuild: { text: string; gone: boolean } | null;
  /** The old server runs and was never retired: Retire VM <id>. */
  oldVm: { vmId: number; text: string } | null;
  /** Why spending is paused; '' when it isn't. */
  paused: string;
  /** Set the books to the server's balance: while paused, but not while a restore's own setting of the books is pending. */
  setBooks: boolean;
  restore: RestoreView | null;
  /** Update server: the app carries a newer cardd, no update runs, and the key isn't a mismatch. */
  offerUpdate: boolean;
  /** Update server is running, since startedAt. */
  updating: { startedAt: number } | null;
  /** Update server or Retire VM works over SSH: the other of the two, and Rebuild server, are off. */
  sshBusy: boolean;
  moneyOff: boolean;
};

/** null until the watch holds a finished setup. nowMs: for the rebuild suggestion's hour. */
export function serverView(snap: ServerViewInput, nowMs: number): ServerView | null {
  const { state: s, status, wallet, lnvps, update, retire } = snap;
  if (!s) return null;
  const keyNotice = hostKeyNotice(s, snap.keyCheckedAt);
  const rebuild =
    lnvps && s.vmId !== undefined
      ? rebuildSuggestion({
          vmId: s.vmId,
          vm: lnvps.vm,
          lnvpsNowMs: lnvps.lnvpsNowMs,
          unreachableSince: lnvps.unreachableSince,
          carddAnswers: !!status && status.kind !== 'unreachable',
          nowMs,
        })
      : null;
  const paused = wallet?.paused ? pausedText(wallet.pausedReason) : '';
  // The server refuses Set the books until a restore's own setting of the books is done.
  const restoring = wallet?.restore?.state === 'pending' || wallet?.restore?.state === 'no_channel';
  const updating = update?.running ? { startedAt: update.startedAt } : null;
  return {
    keyNotice,
    rebuild,
    oldVm: lnvps && oldVmWarning(s, lnvps.old),
    paused,
    setBooks: paused !== '' && !restoring,
    restore: restoreView(wallet?.restore ?? null, wallet?.liquidity ?? null, nowMs / 1000),
    offerUpdate: status?.kind === 'ok' && status.updateAvailable && !updating && keyNotice.kind !== 'mismatch',
    updating,
    sshBusy: !!updating || retire.running,
    moneyOff: moneyOff({ unreachable: snap.unreachable, updating }),
  };
}
