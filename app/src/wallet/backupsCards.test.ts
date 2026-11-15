import { describe, expect, it } from 'vitest';
import type { BackupsView } from '../backup/panel';
import { backupsCards, REVOKED } from './backupsCards';

const WELL: BackupsView = {
  lines: ['Last one today at 11:24', '25 kept on this phone', 'This phone last checked today at 11:28'], warnings: [], revoked: false, failure: null,
  unreachable: false, noApi: false, lastFetch: 1, checking: false,
};
const v = (o: Partial<BackupsView>) => backupsCards({ ...WELL, ...o });

// Settings' Backups page.
describe('backupsCards', () => {
  it('says Backed up with the lines, and Checking backups… before the first answer', () => {
    expect(backupsCards(WELL)).toEqual({ state: { tone: 'ok', title: 'Backed up' }, lines: WELL.lines, note: null, problems: [], failure: null });
    expect(backupsCards(null).state).toEqual({ tone: 'none', title: 'Checking backups…' });
    expect(v({ checking: true }).state).toEqual({ tone: 'none', title: 'Checking backups…' });
    expect(v({ checking: true }).lines).toEqual(WELL.lines);
  });

  // The Backups row was red for a warning the phone already had while the page showed no red card.
  it('shows the warnings it already has while the first check runs, the restore first', () => {
    const w = 'No phone checked for backups for over a day. Android may be holding the app back: open it now and then.';
    expect(v({ checking: true, warnings: [w] })).toMatchObject({ state: { tone: 'none', title: 'Checking backups…' }, problems: [w], failure: null });
    expect(v({ checking: true, revoked: true, warnings: [w] }).problems).toEqual([REVOKED, w]);
    expect(v({ checking: true }).problems).toEqual([]);
  });

  it('says Backups need you over Backed up when anything is wrong, the restore first', () => {
    const w = 'No phone checked for backups for over a day. Android may be holding the app back: open it now and then.';
    expect(v({ warnings: [w] })).toMatchObject({ state: { tone: 'error', title: 'Backups need you' }, problems: [w] });
    expect(v({ revoked: true, warnings: [w] }).problems).toEqual([REVOKED, w]);
    expect(v({ failure: "Couldn't check backups: database is locked." })).toMatchObject({
      state: { tone: 'error', title: 'Backups need you' }, failure: "Couldn't check backups: database is locked.",
    });
  });

  // An iPhone has no storage to clear in Android's settings; the page offers Pair this iPhone again.
  it('gives a phone whose phrase outlives the app its own words for the restore, and the way to pair again', () => {
    const w = 'No phone checked for backups for over a day. Android may be holding the app back: open it now and then.';
    const here = (o: Partial<BackupsView>) => backupsCards({ ...WELL, ...o }, { outlivesApp: true });
    expect(here({ revoked: true, warnings: [w] })).toMatchObject({
      state: { tone: 'error', title: 'Backups need you' },
      problems: ['Another phone restored this server, and this iPhone is no longer paired with it.', w],
      pairAgain: true,
    });
    expect(here({ checking: true, revoked: true })).toMatchObject({ problems: ['Another phone restored this server, and this iPhone is no longer paired with it.'], pairAgain: true });
    expect(here({ warnings: [w] })).not.toHaveProperty('pairAgain');
    expect(here({})).toEqual(backupsCards(WELL));
    expect(v({ revoked: true })).not.toHaveProperty('pairAgain');
  });

  it("says when the server can't be reached, and when it makes no backups", () => {
    expect(v({ unreachable: true, lines: ['25 kept on this phone'] })).toMatchObject({ state: { tone: 'none', title: "Can't reach the server" }, note: 'unreachable' });
    expect(v({ noApi: true })).toMatchObject({ state: { tone: 'warn', title: 'Your server is too old to make backups' }, note: 'no-api' });
  });
});
