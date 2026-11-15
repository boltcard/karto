import { describe, expect, it } from 'vitest';
import type { BackupsView } from '../backup/panel';
import { settingsRows, type RowsSnap, type SettingsRow } from './settingsRows';
import type { ServerView } from './serverView';

const NOW = 1_790_000_000_000; // 2026-09-21 14:13 UTC
const VIEW: ServerView = {
  keyNotice: { kind: 'ok', text: "LNVPS has confirmed this server's SSH key." },
  rebuild: null, oldVm: null, paused: '', setBooks: false, restore: null, offerUpdate: false, updating: null, sshBusy: false, moneyOff: false,
};
const BACKUPS: BackupsView = {
  lines: ['Last one today at 13:43', '1 kept on this phone'], warnings: [], revoked: false, failure: null, unreachable: false, noApi: false,
  lastFetch: NOW / 1000 - 1800, checking: false,
};
const SNAP: RowsSnap = { status: { kind: 'ok', version: '0.7.0', updateAvailable: false }, unreachable: false, backups: BACKUPS, nfc: 'on', retire: { running: false } };
const rows = (snap: Partial<RowsSnap> = {}, view: Partial<ServerView> = {}) => settingsRows({ ...SNAP, ...snap }, { ...VIEW, ...view }, NOW, 0);
const row = (key: SettingsRow['key'], snap?: Partial<RowsSnap>, view?: Partial<ServerView>) => rows(snap, view).find((r) => r.key === key);
/** A row's line, tone and tag only. */
const said = (key: SettingsRow['key'], snap?: Partial<RowsSnap>, view?: Partial<ServerView>) => {
  const r = row(key, snap, view);
  return r && { line: r.line, tone: r.tone, ...(r.tag ? { tag: r.tag } : {}) };
};
const backups = (o: Partial<BackupsView>) => ({ backups: { ...BACKUPS, ...o } });

// The rows and their lines, in the order of the wallet's banners.
describe('settingsRows', () => {
  it('lists the six rows of a well server, each opening its page', () => {
    expect(rows()).toEqual([
      { key: 'server', name: 'Server', line: 'Running', tone: 'ok', opens: '/server' },
      { key: 'backups', name: 'Backups', line: 'Last one today at 13:43', tone: 'ok', opens: '/backups' },
      { key: 'phone', name: 'This phone', line: 'Paired · NFC on', tone: 'ok', opens: null },
      { key: 'phrase', name: 'Recovery phrase', line: 'Your 12 words', tone: 'none', opens: '/show-phrase' },
      { key: 'pos', name: 'Point of sale', line: 'Take payments with Karto PoS', tone: 'none', opens: '/pos-phones' },
      { key: 'rebuild', name: 'Rebuild server', line: 'Start again on a new server', tone: 'none', opens: '/rebuild' },
    ]);
  });

  // Only where the phrase outlives the app, last, in Rebuild server's group.
  it('ends with Remove this wallet where the phrase outlives the app, and nowhere else', () => {
    const REMOVE = { key: 'remove', name: 'Remove this wallet', line: 'Take it off this iPhone', tone: 'none', opens: '/remove' };
    const here = (snap: Partial<RowsSnap> = {}, view: Partial<ServerView> = {}) => settingsRows({ ...SNAP, ...snap }, { ...VIEW, ...view }, NOW, 0, { outlivesApp: true });
    expect(here().slice(0, -1)).toEqual(rows());
    for (const all of [here(), here({ status: null }), here({ unreachable: true }), here({}, { keyNotice: { kind: 'mismatch', text: 'x' } }), here({}, { sshBusy: true })]) {
      expect(all.at(-1)).toEqual(REMOVE);
      expect(all.at(-2)?.key).toBe('rebuild');
    }
    expect(rows().some((r) => r.key === 'remove')).toBe(false);
    expect(settingsRows(SNAP, VIEW, NOW, 0, { outlivesApp: false }).some((r) => r.key === 'remove')).toBe(false);
  });

  // Alerts with the app closed: Android's row, after This phone.
  it('lists Alerts after This phone where the phone has alerts, with how they stand, and not on a mismatch', () => {
    const alerts = { line: "On: through your server's ntfy", tone: 'ok' as const };
    const here = (view: Partial<ServerView> = {}) => settingsRows(SNAP, { ...VIEW, ...view }, NOW, 0, { alerts });
    expect(here().map((r) => r.key)).toEqual(['server', 'backups', 'phone', 'alerts', 'phrase', 'pos', 'rebuild']);
    expect(here().find((r) => r.key === 'alerts')).toEqual({ key: 'alerts', name: 'Alerts', line: alerts.line, tone: 'ok', opens: '/alerts' });
    expect(here({ keyNotice: { kind: 'mismatch', text: 'x' } }).some((r) => r.key === 'alerts')).toBe(false);
    expect(rows().some((r) => r.key === 'alerts')).toBe(false);
  });

  // The row knows the server's state, not the wallet's, so it says the same with or without a PoS phone.
  it('keeps Point of sale between the first rows and Rebuild server, whatever the server says', () => {
    for (const snap of [{}, { status: null }, { unreachable: true }, backups({ revoked: true })]) {
      const all = rows(snap);
      expect(all.at(-2)).toEqual({ key: 'pos', name: 'Point of sale', line: 'Take payments with Karto PoS', tone: 'none', opens: '/pos-phones' });
      expect(all.at(-1)?.key).toBe('rebuild');
    }
  });

  // A server that may not be the person's is offered no pairing codes, as it shows no money and no backups.
  it('leaves Point of sale out on a mismatch, as Backups is', () => {
    expect(row('pos', {}, { keyNotice: { kind: 'mismatch', text: 'x' } })).toBeUndefined();
    expect(rows({}, { keyNotice: { kind: 'mismatch', text: 'x' } }).map((r) => r.key)).toEqual(['server', 'phone', 'phrase', 'rebuild']);
  });

  it("says each of the Server row's states", () => {
    const red = (line: string) => ({ line, tone: 'error' });
    expect(said('server', {}, { keyNotice: { kind: 'mismatch', text: 'x' } })).toEqual(red('Stop using this server'));
    expect(said('server', { status: { kind: 'unreachable', message: 'no answer' } })).toEqual(red("Can't reach it"));
    expect(said('server', { unreachable: true })).toEqual(red("Can't reach it"));
    expect(said('server', { status: { kind: 'not_paired', message: 'x' } })).toEqual(red('Not paired with this phone'));
    expect(said('server', {}, { paused: 'Payments are paused: x' })).toEqual(red('Payments are paused'));
    expect(said('server', {}, { oldVm: { vmId: 1012, text: 'x' } })).toEqual(red('The old server is still running'));
    expect(said('server', {}, { keyNotice: { kind: 'overdue', text: 'x' } })).toEqual(red("LNVPS hasn't confirmed its identity"));
    expect(said('server', {}, { restore: { from: 'x', line: 'x', red: true, setBooks: false } })).toEqual(red('The restore needs you'));
    expect(said('server', { retire: { running: true } }, { oldVm: { vmId: 1012, text: 'x' } })).toEqual({ line: 'Retiring the old server…', tone: 'warn' });
    expect(said('server', {}, { updating: { startedAt: NOW - 65_000 } })).toEqual({ line: 'Updating · 1:05', tone: 'warn' });
    expect(said('server', { status: null })).toEqual({ line: 'Checking…', tone: 'none' });
    expect(said('server', {}, { offerUpdate: true })).toEqual({ line: 'Running', tone: 'ok', tag: 'Update ready' });
  });

  it('puts the most serious first when several hold', () => {
    expect(said('server', { unreachable: true }, { keyNotice: { kind: 'mismatch', text: 'x' } })!.line).toBe('Stop using this server');
    expect(said('server', { unreachable: true }, { paused: 'x' })!.line).toBe("Can't reach it");
    // cardd restarts while Update server runs: not the server being down, as its banner says.
    expect(said('server', { unreachable: true, status: { kind: 'unreachable', message: 'x' } }, { updating: { startedAt: NOW } })!.line).toBe('Updating · 0:00');
    expect(said('server', {}, { paused: 'x', oldVm: { vmId: 1012, text: 'x' } })!.line).toBe('Payments are paused');
    expect(said('server', { status: null }, { paused: 'x' })!.line).toBe('Payments are paused');
  });

  it('says a revoked phone once on the Server row, red on This phone and Backups', () => {
    const revoked = { status: { kind: 'not_paired', message: 'unknown key' } as const, ...backups({ revoked: true }) };
    expect(said('server', revoked)).toEqual({ line: 'Unpaired by another phone', tone: 'none' });
    expect(said('phone', revoked)).toEqual({ line: 'Another phone restored this server', tone: 'error' });
    expect(said('backups', revoked)).toEqual({ line: 'Another phone restored this server', tone: 'error' });
  });

  it("says each of the Backups row's states, and leaves it out on a mismatch", () => {
    expect(said('backups', backups({ warnings: ['w'] }))).toEqual({ line: 'Backups need you', tone: 'error' });
    expect(said('backups', backups({ failure: "Couldn't check backups: x." }))).toEqual({ line: "Couldn't check backups", tone: 'error' });
    expect(said('backups', { backups: null })).toEqual({ line: 'Checking…', tone: 'none' });
    expect(said('backups', backups({ checking: true }))).toEqual({ line: 'Checking…', tone: 'none' });
    expect(said('backups', backups({ unreachable: true, lines: ['3 kept on this phone'] }))).toEqual({ line: '3 kept on this phone', tone: 'none' });
    expect(said('backups', backups({ unreachable: true, lines: ['No backup on this phone yet'] }))).toEqual({ line: 'No backup on this phone yet', tone: 'none' });
    expect(said('backups', backups({ noApi: true }))).toEqual({ line: 'Needs a server update', tone: 'warn' });
    expect(said('backups', backups({ lastFetch: null }))).toEqual({ line: 'None fetched yet', tone: 'ok' });
    expect(row('backups', {}, { keyNotice: { kind: 'mismatch', text: 'x' } })).toBeUndefined();
  });

  it("says This phone's states, and opens Android's NFC setting only when NFC is off", () => {
    expect(row('phone', { nfc: 'off' })).toMatchObject({ line: 'NFC is off', tone: 'warn', tag: 'Turn on', opens: 'nfc-settings' });
    expect(said('phone', { nfc: 'unsupported' })).toEqual({ line: "No NFC, so cards can't be added or checked here", tone: 'none' });
    expect(said('phone', { status: { kind: 'not_paired', message: 'x' } })).toEqual({ line: 'Not paired with your server', tone: 'error' });
    // Paired is known only from the server's answer just now.
    expect(said('phone', { status: null })).toEqual({ line: 'NFC on', tone: 'none' });
    expect(said('phone', { unreachable: true })).toEqual({ line: 'NFC on', tone: 'none' });
    expect(said('phone', { nfc: null })).toEqual({ line: 'Paired', tone: 'ok' });
    expect(said('phone', { nfc: null, status: null })).toEqual({ line: 'Checking…', tone: 'none' });
    expect(row('phone')!.opens).toBeNull();
  });

  it('greys Rebuild while the server work runs, over any suggestion, and says a suggestion in its colour', () => {
    const quiet = { text: "Your server hasn't answered for over an hour, though LNVPS does. If it doesn't come back, rebuild it from a backup.", gone: false };
    expect(row('rebuild', {}, { sshBusy: true, rebuild: quiet })).toMatchObject({ line: 'Wait for the server work to finish', tone: 'none', disabled: true });
    expect(said('rebuild', {}, { rebuild: quiet })).toEqual({ line: quiet.text, tone: 'warn' });
    expect(said('rebuild', {}, { rebuild: { text: 'LNVPS no longer lists VM 1001: your server is gone. Rebuild it from a backup.', gone: true } })!.tone).toBe('error');
  });
});
