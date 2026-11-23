import { describe, expect, it } from 'vitest';
import type { OnboardingState, ServerHost } from '../onboarding/machine';
import { serverCards, type ServerCardsSnap } from './serverCards';
import type { ServerView } from './serverView';

const host: ServerHost = {
  ipv4: '45.67.89.10', hostname: 'vm-1001.lnvps.cloud', user: 'root', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAAC3Nza' }, keySource: 'lnvps',
};
const state: OnboardingState = { step: 'done', payDays: 30, installed: [], vmId: 1001, host };
const VIEW: ServerView = {
  keyNotice: { kind: 'ok', text: "LNVPS has confirmed this server's SSH key." },
  rebuild: null, oldVm: null, paused: '', setBooks: false, restore: null, offerUpdate: false, updating: null, sshBusy: false, moneyOff: false,
};
const SNAP: ServerCardsSnap = { state, status: { kind: 'ok', version: '0.7.0', updateAvailable: false }, unreachable: false, backups: null, update: null };
const cards = (snap: Partial<ServerCardsSnap> = {}, view: Partial<ServerView> = {}) => serverCards({ ...SNAP, ...snap }, { ...VIEW, ...view });
const kinds = (snap?: Partial<ServerCardsSnap>, view?: Partial<ServerView>) => cards(snap, view).map((c) => c.kind);
const DETAILS = [['Address', 'vm-1001.lnvps.cloud'], ['IP', '45.67.89.10'], ['Hosted by', 'LNVPS, VM 1001'], ['Version', '0.7.0'], ['Identity', 'Confirmed by LNVPS']];

// Settings' Server page.
describe('serverCards', () => {
  it('shows a well server as running, then the details', () => {
    expect(cards()).toEqual([{ kind: 'running' }, { kind: 'details', rows: DETAILS, identityNote: null }]);
  });

  // The server's name with no IPv4 address, or one that isn't this server's.
  it("says when the server's name doesn't work on every network, and not when it does", () => {
    const ok = { kind: 'ok', version: '0.7.0', updateAvailable: false } as const;
    const dns = cards({ status: { ...ok, dns: { ipv4: 'missing' } } });
    expect(dns.map((c) => c.kind)).toEqual(['running', 'dns', 'details']);
    expect(dns[1]).toMatchObject({ kind: 'dns', title: "Your server's name doesn't work on every network" });
    expect((dns[1] as { text: string }).text).toContain('vm-1001.lnvps.cloud has no IPv4 address in DNS');
    expect((dns[1] as { text: string }).text).toContain('pointing to 45.67.89.10.');
    expect(kinds({ status: { ...ok, dns: { ipv4: 'other', got: ['1.2.3.4'] } } })).toEqual(['running', 'dns', 'details']);
    expect(kinds({ status: { ...ok, dns: { ipv4: 'ok' } } })).toEqual(['running', 'details']);
  });

  it('says checking, unreachable with its reason or the refresh, and never Running while the flag is set', () => {
    expect(cards({ status: null })[0]).toEqual({ kind: 'checking' });
    expect(cards({ status: { kind: 'unreachable', message: 'no answer from vm-1001.lnvps.cloud in 30 s' } })[0])
      .toEqual({ kind: 'unreachable', reason: 'no answer from vm-1001.lnvps.cloud in 30 s' });
    expect(cards({ unreachable: true })[0]).toEqual({ kind: 'unreachable', reason: 'The last refresh got no answer.' });
  });

  // cardd restarts while Update server runs, and the page said Can't reach your server beside the running update.
  it("doesn't say Can't reach your server while Update server runs: the last status's card stands", () => {
    const updating = { updating: { startedAt: 1 } };
    expect(cards({ unreachable: true }, updating)[0]).toEqual({ kind: 'running' });
    expect(cards({ status: { kind: 'unreachable', message: 'no answer in 30 s' }, unreachable: true }, updating)[0]).toEqual({ kind: 'checking' });
    expect(cards({ status: null, unreachable: true }, updating)[0]).toEqual({ kind: 'checking' });
    // Once the update has ended, a server still out of reach says so again.
    expect(cards({ unreachable: true })[0]).toEqual({ kind: 'unreachable', reason: 'The last refresh got no answer.' });
  });

  it("says a phone that isn't paired, and one another phone's restore unpaired", () => {
    expect(cards({ status: { kind: 'not_paired', message: 'The server refused this phone' } })[0]).toEqual({ kind: 'not-paired', text: 'The server refused this phone' });
    const revoked = { status: { kind: 'not_paired', message: 'x' } as const, backups: { lines: [], warnings: [], revoked: true, failure: null, unreachable: false, noApi: false, lastFetch: null, checking: false } };
    expect(cards(revoked)[0]).toEqual({ kind: 'not-paired', text: 'Another phone restored this server: see Backups.' });
  });

  // Where the phrase outlives the app, the card says what happened and offers Pair this iPhone again.
  it('gives a phone whose phrase outlives the app its own words and the way to pair again', () => {
    const here = (snap: Partial<ServerCardsSnap>) => serverCards({ ...SNAP, ...snap }, VIEW, { outlivesApp: true })[0];
    const revoked = { lines: [], warnings: [], revoked: true, failure: null, unreachable: false, noApi: false, lastFetch: null, checking: false };
    expect(here({ status: { kind: 'not_paired', noKey: true, message: 'This phone has no device key (was the app restored from a backup?). Pairing again comes with restore.' } }))
      .toEqual({ kind: 'not-paired', text: 'This iPhone has your recovery phrase but has lost its own key, which no backup holds.', pairAgain: true });
    expect(here({ status: { kind: 'not_paired', message: 'x' }, backups: revoked }))
      .toEqual({ kind: 'not-paired', text: 'Another phone restored this server, and this iPhone is no longer paired with it.', pairAgain: true });
    expect(here({ status: { kind: 'not_paired', message: 'The server refused this phone' } })).toEqual({ kind: 'not-paired', text: 'The server refused this phone', pairAgain: true });
    expect(here({})).toEqual({ kind: 'running' });
  });

  it('is one red card and the details on a mismatch, the notice word for word, nothing else', () => {
    const text = "The server's SSH key is not the one LNVPS published (LNVPS published SHA256:x). The wallet seed and card key may have gone to someone else. Stop using this server and this recovery phrase.";
    const got = cards({}, { keyNotice: { kind: 'mismatch', text }, paused: 'x', offerUpdate: true });
    expect(got.map((c) => c.kind)).toEqual(['stop', 'details']);
    expect(got[0]).toEqual({ kind: 'stop', text });
    expect(got[1]).toMatchObject({ rows: [...DETAILS.slice(0, 4), ['Identity', "Doesn't match LNVPS's"]] });
  });

  it('orders what needs the person as the banners do, then the update, the restore and the details', () => {
    const restore = { from: 'Restored from the backup of today at 11:26', line: 'The balances matched.', red: false, setBooks: false };
    expect(kinds({ update: { done: [], upload: null, startedAt: 1, running: true } }, {
      oldVm: { vmId: 1012, text: 'x' }, paused: 'x', setBooks: true, keyNotice: { kind: 'overdue', text: 'x' }, offerUpdate: true, restore,
    })).toEqual(['running', 'old-vm', 'paused', 'overdue', 'update', 'update-run', 'restore', 'details']);
    expect(cards({}, { paused: 'p', setBooks: true })[1]).toEqual({ kind: 'paused', text: 'p', setBooks: true });
    expect(cards({}, { oldVm: { vmId: 1012, text: 'o' } })[1]).toEqual({ kind: 'old-vm', vmId: 1012, text: 'o' });
  });

  it("carries the update's error, and turns the restore's button off while unreachable or the channel isn't up", () => {
    expect(cards({ update: { done: [], upload: null, startedAt: 1, running: false, error: 'The update stopped: x' } }).find((c) => c.kind === 'update-run'))
      .toEqual({ kind: 'update-run', error: 'The update stopped: x' });
    // While it waits to connect again after a drop, the card says so.
    const run = (o: object) => cards({ update: { done: ['upload'], upload: null, startedAt: 1, running: true, ...o } }).find((c) => c.kind === 'update-run');
    expect(run({ dropped: 'command' })).toEqual({ kind: 'update-run', error: null, waiting: 'The connection to your server dropped. Carrying on from “Wait for the first boot”.' });
    expect(run({ dropped: 'upload', done: [] })).toEqual({ kind: 'update-run', error: null, waiting: 'The connection to your server dropped. Carrying on from “Upload the server files”.' });
    expect(run({ dropped: 'connect' })).toEqual({ kind: 'update-run', error: null, waiting: 'Your server isn’t answering yet. Trying again…' });
    expect(run({})).toEqual({ kind: 'update-run', error: null });
    const restore = { from: 'x', line: 'x', red: true, setBooks: true, notUp: "The channel isn't up yet: wait for it." };
    expect(cards({}, { restore }).find((c) => c.kind === 'restore')).toMatchObject({ booksOff: true });
    expect(cards({}, { restore: { ...restore, notUp: undefined }, moneyOff: true }).find((c) => c.kind === 'restore')).toMatchObject({ booksOff: true });
    expect(cards({}, { restore: { ...restore, notUp: undefined } }).find((c) => c.kind === 'restore')).toMatchObject({ booksOff: false });
  });

  it("puts the pending notice under Identity, and leaves the version out when the status isn't ok", () => {
    const pending = { kind: 'pending' as const, text: "LNVPS hasn't confirmed your server's identity yet. It usually does within minutes of a new server starting; the app checks while the wallet or a Settings page is open." };
    expect(cards({}, { keyNotice: pending }).at(-1)).toEqual({
      kind: 'details', rows: [...DETAILS.slice(0, 4), ['Identity', 'Waiting for LNVPS']], identityNote: pending.text,
    });
    expect(cards({ status: null }, { keyNotice: { kind: 'overdue', text: 'x' } }).at(-1)).toMatchObject({
      rows: [...DETAILS.slice(0, 3), ['Identity', 'Not confirmed by LNVPS']],
    });
  });
});
