// Settings' rows: each part as its name and how it stands in one line, with
// a coloured dot, a yellow tag for something ready, and where a tap goes. From what the watch holds and serverView
// worked out of it, judged in the order of the wallet's banners.
import { whenText } from '../money/format';
import { elapsed } from '../onboarding/progress';
import type { WatchSnapshot } from '../services/serverWatch';
import type { RowTone } from '../ui/look';
import type { ServerView } from './serverView';

export type SettingsRow = {
  key: 'server' | 'backups' | 'phone' | 'alerts' | 'phrase' | 'pos' | 'rebuild' | 'remove';
  name: string;
  line: string;
  tone: RowTone;
  /** In the highlight yellow: something ready for the person, or the tap that puts a warning right. */
  tag?: string;
  /** Where a tap goes: a page, Android's NFC setting, or nowhere. */
  opens: '/server' | '/backups' | '/alerts' | '/show-phrase' | '/pos-phones' | '/rebuild' | '/remove' | 'nfc-settings' | null;
  /** Greyed, and a tap does nothing. */
  disabled?: boolean;
};

export type RowsSnap = Pick<WatchSnapshot, 'status' | 'unreachable' | 'backups' | 'nfc' | 'retire'>;

type Said = Pick<SettingsRow, 'line' | 'tone' | 'tag'>;

const red = (line: string): Said => ({ line, tone: 'error' });

/**
 * nowMs: for Updating · m:ss and the last backup's day; offsetMin: the phone's time zone, minutes east of UTC;
 * outlivesApp: the phrase store's, an iPhone's, where deleting the app removes no wallet; alerts: how alerts stand
 * (alerts/alertsView.ts), on a phone that has them (Android's).
 */
export function settingsRows(
  snap: RowsSnap, view: ServerView, nowMs: number, offsetMin = -new Date(nowMs).getTimezoneOffset(),
  o: { outlivesApp?: boolean; alerts?: Pick<SettingsRow, 'line' | 'tone'> } = {},
): SettingsRow[] {
  const revoked = snap.backups?.revoked ?? false;
  const rows: SettingsRow[] = [{ key: 'server', name: 'Server', ...serverSays(snap, view, nowMs, revoked), opens: '/server' }];
  // A server that may not be the person's: its backups aren't theirs either, as Settings showed none.
  if (view.keyNotice.kind !== 'mismatch') rows.push({ key: 'backups', name: 'Backups', ...backupsSay(snap, nowMs, offsetMin), opens: '/backups' });
  rows.push(phoneRow(snap, revoked));
  // Left out, as Backups is, on a server that may not be the person's: no endpoint is handed to it.
  if (o.alerts && view.keyNotice.kind !== 'mismatch') rows.push({ key: 'alerts', name: 'Alerts', line: o.alerts.line, tone: o.alerts.tone, opens: '/alerts' });
  rows.push({ key: 'phrase', name: 'Recovery phrase', line: 'Your 12 words', tone: 'none', opens: '/show-phrase' });
  // A group of its own: the same line with or without a PoS phone, as this knows the server's state, not the wallet's.
  // Left out, as Backups is, on a server that may not be the person's: no pairing code is made on it.
  if (view.keyNotice.kind !== 'mismatch') rows.push({ key: 'pos', name: 'Point of sale', line: 'Take payments with Karto PoS', tone: 'none', opens: '/pos-phones' });
  rows.push(rebuildRow(view));
  // Whatever the server says: the removal touches this phone only.
  if (o.outlivesApp) rows.push({ key: 'remove', name: 'Remove this wallet', line: 'Take it off this iPhone', tone: 'none', opens: '/remove' });
  return rows;
}

function serverSays(snap: RowsSnap, view: ServerView, nowMs: number, revoked: boolean): Said {
  const { status } = snap;
  // cardd restarts while Update server runs: its failures then aren't the server being down, as its banner says.
  const unreachable = (status?.kind === 'unreachable' || snap.unreachable) && !view.updating;
  const retiring = snap.retire.running;
  if (view.keyNotice.kind === 'mismatch') return red('Stop using this server');
  if (unreachable) return red("Can't reach it");
  // Another phone's restore: This phone and Backups say it, and Backups says what to do.
  if (status?.kind === 'not_paired' && !revoked) return red('Not paired with this phone');
  if (view.paused !== '') return red('Payments are paused');
  // The old server's warning stays until LNVPS answers again after a retire: while it runs, the row says so.
  if (view.oldVm && !retiring) return red('The old server is still running');
  if (view.keyNotice.kind === 'overdue') return red("LNVPS hasn't confirmed its identity");
  if (view.restore?.red) return red('The restore needs you');
  if (retiring) return { line: 'Retiring the old server…', tone: 'warn' };
  if (view.updating) return { line: `Updating · ${elapsed(view.updating.startedAt, nowMs)}`, tone: 'warn' };
  if (!status) return { line: 'Checking…', tone: 'none' };
  if (status.kind === 'not_paired') return { line: 'Unpaired by another phone', tone: 'none' };
  return view.offerUpdate ? { line: 'Running', tone: 'ok', tag: 'Update ready' } : { line: 'Running', tone: 'ok' };
}

function backupsSay(snap: RowsSnap, nowMs: number, offsetMin: number): Said {
  const b = snap.backups;
  if (b?.revoked) return red('Another phone restored this server');
  if (b && b.warnings.length > 0) return red('Backups need you');
  if (b?.failure) return red("Couldn't check backups");
  if (!b || b.checking) return { line: 'Checking…', tone: 'none' };
  // The check reached no server: what this phone keeps, in the view's own words.
  if (b.unreachable) return { line: b.lines[0] ?? 'No backup on this phone yet', tone: 'none' };
  if (b.noApi) return { line: 'Needs a server update', tone: 'warn' };
  return { line: b.lastFetch ? `Last one ${whenText(b.lastFetch, nowMs / 1000, offsetMin)}` : 'None fetched yet', tone: 'ok' };
}

function phoneRow(snap: RowsSnap, revoked: boolean): SettingsRow {
  const row = (said: Said, opens: SettingsRow['opens'] = null): SettingsRow => ({ key: 'phone', name: 'This phone', ...said, opens });
  const { status, nfc } = snap;
  if (status?.kind === 'not_paired') return row(red(revoked ? 'Another phone restored this server' : 'Not paired with your server'));
  if (nfc === 'off') return row({ line: 'NFC is off', tone: 'warn', tag: 'Turn on' }, 'nfc-settings');
  if (nfc === 'unsupported') return row({ line: "No NFC, so cards can't be added or checked here", tone: 'none' });
  // Paired only from the server's answer just now: before it, or out of reach, it isn't known.
  const paired = status?.kind === 'ok' && !snap.unreachable;
  const parts = [...(paired ? ['Paired'] : []), ...(nfc === 'on' ? ['NFC on'] : [])];
  return row({ line: parts.length > 0 ? parts.join(' · ') : 'Checking…', tone: paired ? 'ok' : 'none' });
}

function rebuildRow(view: ServerView): SettingsRow {
  const row = { key: 'rebuild', name: 'Rebuild server', opens: '/rebuild' } as const;
  // Never while Update server or Retire VM works over SSH: the rebuild would start beside it.
  if (view.sshBusy) return { ...row, line: 'Wait for the server work to finish', tone: 'none', disabled: true };
  if (view.rebuild) return { ...row, line: view.rebuild.text, tone: view.rebuild.gone ? 'error' : 'warn' };
  return { ...row, line: 'Start again on a new server', tone: 'none' };
}
