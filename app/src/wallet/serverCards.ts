// The Server page's cards: how the server stands, what needs the person in
// the order of the wallet's banners, the update, a restore's lines, then the builder's details. The page draws each
// with today's buttons; this says which show and with what words.
import { installStepsFor } from '../onboarding/install';
import { dropLine } from '../onboarding/progress';
import type { RestoreView } from '../onboarding/serverPage';
import type { WatchSnapshot } from '../services/serverWatch';
import { dnsWords } from './dnsWords';
import { pairAgain } from './pairAgain';
import type { ServerView } from './serverView';

export type ServerCard =
  | { kind: 'running' }
  | { kind: 'checking' }
  | { kind: 'unreachable'; reason: string }
  /** pairAgain: Pair this iPhone again, where the phrase outlives the app. */
  | { kind: 'not-paired'; text: string; pairAgain?: true }
  /** A host-key mismatch: the notice word for word, a security warning. */
  | { kind: 'stop'; text: string }
  | { kind: 'old-vm'; vmId: number; text: string }
  | { kind: 'paused'; text: string; setBooks: boolean }
  | { kind: 'overdue'; text: string }
  /** The server's name has no IPv4 address, or one that isn't the server's: who can fix it, in words to copy. */
  | { kind: 'dns'; title: string; text: string }
  /** Update ready: Update server. */
  | { kind: 'update' }
  /** An update's steps and outcome, while it runs and after; error: "The update stopped: …". waiting: its line while it waits to connect again after a drop. */
  | { kind: 'update-run'; error: string | null; waiting?: string }
  /** booksOff: Set the books to phoenixd's balance is off, while cardd can't be reached or the channel isn't up. */
  | { kind: 'restore'; restore: RestoreView; booksOff: boolean }
  | { kind: 'details'; rows: [string, string][]; identityNote: string | null };

export type ServerCardsSnap = Pick<WatchSnapshot, 'state' | 'status' | 'unreachable' | 'backups' | 'update'>;

const IDENTITY = { ok: 'Confirmed by LNVPS', pending: 'Waiting for LNVPS', overdue: 'Not confirmed by LNVPS', mismatch: "Doesn't match LNVPS's" } as const;

/** snap.state holds a finished setup (serverView isn't null). outlivesApp: the phrase store's, an iPhone's. */
export function serverCards(snap: ServerCardsSnap, view: ServerView, o: { outlivesApp?: boolean } = {}): ServerCard[] {
  const details = detailsCard(snap, view);
  // A server that may not be the person's: none of its money and no update, as Settings showed.
  if (view.keyNotice.kind === 'mismatch') return [{ kind: 'stop', text: view.keyNotice.text }, details];
  const cards: ServerCard[] = [stateCard(snap, !!view.updating, !!o.outlivesApp)];
  if (view.oldVm) cards.push({ kind: 'old-vm', vmId: view.oldVm.vmId, text: view.oldVm.text });
  if (view.paused !== '') cards.push({ kind: 'paused', text: view.paused, setBooks: view.setBooks });
  if (view.keyNotice.kind === 'overdue') cards.push({ kind: 'overdue', text: view.keyNotice.text });
  const host = snap.state?.host;
  const name = host && snap.status?.kind === 'ok' ? dnsWords(host.hostname, host.ipv4, snap.status.dns) : null;
  if (name) cards.push({ kind: 'dns', ...name });
  if (view.offerUpdate) cards.push({ kind: 'update' });
  if (snap.update) {
    const { dropped, done, error } = snap.update;
    // Update server lists every step (it wipes and restores nothing): the first not done is the one it carries on from.
    const waiting = dropped && { waiting: dropLine(dropped, installStepsFor({}).find((step) => !done.includes(step))) };
    cards.push({ kind: 'update-run', error: error ?? null, ...waiting });
  }
  if (view.restore) cards.push({ kind: 'restore', restore: view.restore, booksOff: view.moneyOff || !!view.restore.notUp });
  cards.push(details);
  return cards;
}

/** updating: Update server runs. cardd restarts under it, so its failures then aren't the server being down, as Settings' row and the banner have it. */
function stateCard(snap: ServerCardsSnap, updating: boolean, outlivesApp: boolean): ServerCard {
  const { status } = snap;
  if (status?.kind === 'unreachable') return updating ? { kind: 'checking' } : { kind: 'unreachable', reason: status.message };
  // The 5-second refresh (or the account page's) got nothing: there is no reason to give, and it isn't Running.
  if (snap.unreachable && !updating) return { kind: 'unreachable', reason: 'The last refresh got no answer.' };
  if (status?.kind === 'not_paired') {
    const revoked = snap.backups?.revoked ?? false;
    const again = pairAgain({ outlivesApp, status, revoked });
    if (again) return { kind: 'not-paired', text: again.text, pairAgain: true };
    return { kind: 'not-paired', text: revoked ? 'Another phone restored this server: see Backups.' : status.message };
  }
  return status?.kind === 'ok' ? { kind: 'running' } : { kind: 'checking' };
}

function detailsCard(snap: ServerCardsSnap, view: ServerView): ServerCard {
  const s = snap.state!;
  const host = s.host!;
  const rows: [string, string][] = [
    ['Address', host.hostname],
    ['IP', host.ipv4],
    ['Hosted by', s.vmId !== undefined ? `LNVPS, VM ${s.vmId}` : 'LNVPS'],
    ...(snap.status?.kind === 'ok' ? [['Version', snap.status.version] as [string, string]] : []),
    ['Identity', IDENTITY[view.keyNotice.kind]],
  ];
  return { kind: 'details', rows, identityNote: view.keyNotice.kind === 'pending' ? view.keyNotice.text : null };
}
