// What the wallet's banners are made from: the
// watch's snapshot and what serverView worked out of it, read with the server
// page's own helpers, so the banners and Settings judge alike.
import { hostingWarnings } from '../money/hosting';
import { cardsToRepoint } from '../onboarding/serverPage';
import type { WatchSnapshot } from '../services/serverWatch';
import type { BannerInput } from './banners';
import type { ServerView } from './serverView';

export type BannerSnap = Pick<WatchSnapshot, 'state' | 'status' | 'unreachable' | 'wallet' | 'hosting' | 'lnvpsExpires' | 'backups' | 'cards' | 'nfc' | 'phoneCard'>;

/** view: serverView(snap, nowMs). nowMs: for hosting's days left and Updating the server's elapsed time. */
export function bannerInput(snap: BannerSnap, view: ServerView, nowMs: number): BannerInput {
  const host = snap.state?.host?.hostname;
  return {
    keyNotice: view.keyNotice,
    status: snap.status,
    unreachable: snap.unreachable,
    updating: view.updating,
    nowMs,
    revoked: snap.backups?.revoked ?? false,
    pausedReason: snap.wallet?.paused ? snap.wallet.pausedReason : null,
    hosting: hostingWarnings(snap.hosting, snap.lnvpsExpires, nowMs / 1000),
    oldVm: view.oldVm,
    backupWarnings: snap.backups?.warnings ?? [],
    restoreRed: view.restore?.red ? view.restore.line : null,
    rebuild: view.rebuild,
    // A phone's card is never one to re-point.
    repoint: host === undefined ? 0 : cardsToRepoint(snap.cards ?? [], host, new Set(snap.phoneCard.ids)).length,
    nfc: snap.nfc,
  };
}
