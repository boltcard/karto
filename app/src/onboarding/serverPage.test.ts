import { describe, expect, it } from 'vitest';
import type { CardInfo } from '../cardd/client';
import type { Vm } from '../lnvps/client';
import { initialState, type OnboardingState } from './machine';
import { cardsToRepoint, oldVmWarning, rebuildSuggestion, REFREEZE, restoreView, UNREACHABLE_SUGGEST_MS } from './serverPage';

const NOW = 1_790_000_000_000;
const vm = (o: Partial<Vm> = {}): Vm => ({
  id: 1001, created: '2026-09-01T00:00:00Z', expires: '2026-11-02T12:00:00Z', status: { state: 'running' },
  ip_assignments: [], host_ssh_keys: [], image: {}, ssh_key: { id: 1 }, ...o,
});

// The server page suggests Rebuild server.
describe('rebuildSuggestion', () => {
  const base = { vmId: 1001, vm: vm(), lnvpsNowMs: NOW, unreachableSince: null, carddAnswers: true, nowMs: NOW };

  it('suggests nothing while the server is paid and answers', () => {
    expect(rebuildSuggestion(base)).toBeNull();
  });

  it('suggests a rebuild when LNVPS reports the VM deleted', () => {
    expect(rebuildSuggestion({ ...base, vm: null })).toEqual({
      text: 'LNVPS no longer lists VM 1001: your server is gone. Rebuild it from a backup.', gone: true,
    });
  });

  it('suggests a rebuild when LNVPS reports the VM expired, naming when it deletes it', () => {
    const expired = vm({ expires: '2026-09-20T00:00:00Z', status: { state: 'stopped' }, deleting_on: '2026-09-27T00:00:00Z' });
    expect(rebuildSuggestion({ ...base, vm: expired })).toEqual({
      text: 'VM 1001 has expired, and LNVPS deletes it on 2026-09-27. Pay LNVPS for it in time, or rebuild the server from a backup.', gone: true,
    });
    expect(rebuildSuggestion({ ...base, vm: { ...expired, deleting_on: null } })).toMatchObject({ text: expect.stringContaining('LNVPS deletes it soon.'), gone: true });
  });

  it('suggests a rebuild once cardd has failed to answer for over an hour while LNVPS answers', () => {
    const down = { ...base, carddAnswers: false };
    expect(rebuildSuggestion({ ...down, unreachableSince: NOW - UNREACHABLE_SUGGEST_MS })).toBeNull();
    // The server may come back: the wallet's banner is amber, not red.
    expect(rebuildSuggestion({ ...down, unreachableSince: NOW - UNREACHABLE_SUGGEST_MS - 1 })).toEqual({
      text: "Your server hasn't answered for over an hour, though LNVPS does. If it doesn't come back, rebuild it from a backup.", gone: false,
    });
    expect(rebuildSuggestion({ ...down, unreachableSince: null })).toBeNull();
    // cardd answering now outweighs the background job's record; LNVPS not answering says nothing.
    expect(rebuildSuggestion({ ...down, carddAnswers: true, unreachableSince: NOW - 2 * UNREACHABLE_SUGGEST_MS })).toBeNull();
    expect(rebuildSuggestion({ ...down, vm: 'unreachable', unreachableSince: NOW - 2 * UNREACHABLE_SUGGEST_MS })).toBeNull();
  });
});

// After the rebuild, on the server page.
describe('restoreView', () => {
  // A backup's cards are as it had them: a card frozen after it was made is active again, and cardd can't know.
  it('says that cards frozen after the backup need freezing again, except for a fresh start from the phrase', () => {
    expect(REFREEZE).toBe('Cards you froze after this backup was made are active again: freeze them again.');
    const now = 1_790_000_000;
    for (const state of ['pending', 'no_channel'] as const) expect(restoreView({ state, from: 'backup' }, null, now)!.refreeze).toBe(REFREEZE);
    expect(restoreView({ state: 'done', from: 'backup', reconciledMsat: 0, reconciledAt: now - 86_400 }, null, now)!.refreeze).toBe(REFREEZE);
    expect(restoreView({ state: 'pending', from: 'phrase' }, null, now)!.refreeze).toBeUndefined();
  });

  // The old server's final snapshot holds every freeze made there: nothing is undone.
  it("says nothing of freezes for the old server's final snapshot", () => {
    for (const state of ['pending', 'no_channel'] as const) expect(restoreView({ state, from: 'backup', final: true })!.refreeze).toBeUndefined();
    expect(restoreView({ state: 'done', from: 'backup', final: true, reconciledMsat: 0, reconciledAt: 1_790_000_000 }, null, 1_790_000_000)!.refreeze).toBeUndefined();
  });

  // A week after the books were set, the cards' freezes have long been seen to: the line goes.
  it('drops the line a week after the books were set', () => {
    const done = { state: 'done', from: 'backup', reconciledMsat: 0, reconciledAt: 1_790_000_000 } as const;
    expect(restoreView(done, null, 1_790_000_000 + 7 * 86_400 - 1)!.refreeze).toBe(REFREEZE);
    expect(restoreView(done, null, 1_790_000_000 + 7 * 86_400)!.refreeze).toBeUndefined();
  });

  const from = '0123456789abcdef0123456789abcdef-7-1789990000';
  const NOW_S = 1_790_000_000;

  it('shows nothing for a server that was never restored', () => {
    expect(restoreView(null)).toBeNull();
  });

  it('names the backup restored, or the phrase alone', () => {
    expect(restoreView({ state: 'pending', from }, null, NOW_S, 0)!.from).toBe('Restored from the backup of today at 11:26');
    expect(restoreView({ state: 'pending', from }, null, NOW_S + 2 * 86_400, 0)!.from).toBe('Restored from the backup of 21 Sep at 11:26');
    expect(restoreView({ state: 'pending', from: 'phrase' })!.from).toBe('Started fresh from the recovery phrase');
    expect(restoreView({ state: 'pending', from: 'backup' })!.from).toBe('Restored from a backup');
  });

  it('says how reconciling stands, red only for a shortfall and no channel', () => {
    expect(restoreView({ state: 'pending', from })).toMatchObject({ line: 'Waiting for the channel to come back', red: false, setBooks: false });
    expect(restoreView({ state: 'done', from, reconciledMsat: 12_345_678, reconciledAt: 1 })).toMatchObject({ line: '12,345 sat more than the backup, moved to Pool.', red: false, setBooks: false });
    expect(restoreView({ state: 'done', from, reconciledMsat: 0, reconciledAt: 1 })).toMatchObject({ line: 'The balances matched.', red: false });
    // Under a whole sat over is the balances matching: the app shows whole sats.
    expect(restoreView({ state: 'done', from, reconciledMsat: 500, reconciledAt: 1 })).toMatchObject({ line: 'The balances matched.', red: false });
    expect(restoreView({ state: 'done', from, reconciledMsat: -4_000_500, reconciledAt: 1 })).toMatchObject({
      line: 'The server holds less than the backup said: 4,000 sat short', red: true, setBooks: false,
    });
  });

  it('explains no channel and offers setting the books, saying what phoenixd reports', () => {
    const liquidity = (channel: boolean, usable: boolean) => ({ channel, usable, inboundSat: 0, feeCreditSat: 0, firstChannelFeeSat: 0 });
    expect(restoreView({ state: 'no_channel', from }, liquidity(false, false), NOW_S, 0)).toEqual({
      from: 'Restored from the backup of today at 11:26',
      line:
        'No channel came back from the Lightning provider (ACINQ) after the restore. The money may be on-chain in phoenixd\'s wallet, or was spent after the backup. ' +
        "Spending stays paused until the books are set to phoenixd's balance: the difference goes to pool.",
      red: true,
      setBooks: true,
      phoenixd: "The server's Lightning wallet (phoenixd) has no channel.",
      refreeze: REFREEZE,
    });
    // The server refuses the books then (409 channel_not_up): it sets them itself once the channel is up.
    expect(restoreView({ state: 'no_channel', from }, liquidity(true, false))).toMatchObject({
      setBooks: true, phoenixd: "The server's Lightning wallet (phoenixd) has a channel that isn't up yet.", notUp: "The channel isn't up yet: wait for it.",
    });
    expect(restoreView({ state: 'no_channel', from }, liquidity(true, true))).toMatchObject({
      phoenixd: "The server's Lightning wallet (phoenixd) has its channel up again: the server sets the books itself within a minute.",
    });
    expect(restoreView({ state: 'no_channel', from }, null)).toMatchObject({ setBooks: true, phoenixd: "The server's Lightning wallet (phoenixd) didn't answer just now." });
    expect(restoreView({ state: 'no_channel', from }, liquidity(true, true))!.notUp).toBeUndefined();
  });

  // phoenixd not talking to ACINQ yet (its liquidity call doesn't answer) is what to know while the channel is awaited.
  it('says what phoenixd reports while waiting for the channel, with nothing to set', () => {
    const liquidity = (channel: boolean, usable: boolean) => ({ channel, usable, inboundSat: 0, feeCreditSat: 0, firstChannelFeeSat: 0 });
    expect(restoreView({ state: 'pending', from }, null, NOW_S, 0)).toEqual({
      from: 'Restored from the backup of today at 11:26', line: 'Waiting for the channel to come back', red: false, setBooks: false,
      phoenixd: "The server's Lightning wallet (phoenixd) didn't answer just now.", refreeze: REFREEZE,
    });
    expect(restoreView({ state: 'pending', from }, liquidity(false, false))!.phoenixd).toBe("The server's Lightning wallet (phoenixd) has no channel.");
    expect(restoreView({ state: 'pending', from }, liquidity(true, false))).toMatchObject({ setBooks: false, phoenixd: "The server's Lightning wallet (phoenixd) has a channel that isn't up yet." });
    expect(restoreView({ state: 'pending', from }, liquidity(true, false))!.notUp).toBeUndefined();
  });

  // A channel that came back after no_channel: the server set the books itself, as if it had come in time.
  it('says a late reconcile as any other', () => {
    expect(restoreView({ state: 'done', from, reconciledMsat: 2_000_000, reconciledAt: 1 }, null)).toMatchObject({ line: '2,000 sat more than the backup, moved to Pool.', red: false });
  });
});

describe('cardsToRepoint', () => {
  const card = (id: string, state: CardInfo['state'], host?: string): CardInfo => ({ id, version: 1, state, counter: 3, name: id, created: 0, updated: 0, host });

  it('lists the cards, not reset, whose URL points at another server', () => {
    const cards = [
      card('a', 'active', 'vm-1012.lnvps.cloud'),
      card('b', 'frozen', 'vm-1012.lnvps.cloud'),
      card('c', 'active', 'vm-1001.lnvps.cloud'),
      card('d', 'reset', 'vm-1012.lnvps.cloud'),
      card('e', 'active', ''),
      card('f', 'active'), // a cardd from before hosts says nothing
    ];
    expect(cardsToRepoint(cards, 'vm-1001.lnvps.cloud').map((c) => c.id)).toEqual(['a', 'b', 'e']);
  });

  // A phone's card needs no hold to point at a rebuilt server.
  it("never lists a phone's card", () => {
    const cards = [card('a', 'active', 'vm-1012.lnvps.cloud'), card('phone', 'active', 'vm-1012.lnvps.cloud'), card('b', 'frozen', '')];
    expect(cardsToRepoint(cards, 'vm-1001.lnvps.cloud', new Set(['phone'])).map((c) => c.id)).toEqual(['a', 'b']);
    expect(cardsToRepoint(cards, 'vm-1001.lnvps.cloud', new Set()).map((c) => c.id)).toEqual(['a', 'phone', 'b']);
  });
});

// LNVPS reporting it running when it wasn't retired over SSH.
describe('oldVmWarning', () => {
  const done = (retire?: NonNullable<OnboardingState['rebuild']>['retire'], oldId = 1012): OnboardingState => ({
    ...initialState('GBR'),
    step: 'done',
    vmId: 1001,
    rebuild: { source: 'server_page', oldVm: { id: oldId }, ...(retire && { retire }) },
  });
  const running = vm({ id: 1012 });
  const text =
    'LNVPS reports the old server (VM 1012) running, and it was never retired over SSH. Two Lightning wallets on one seed ' +
    'can close the channel: retire it now.';

  it('warns when the old VM runs and step 4 recorded it expired, gone or passed over blind', () => {
    for (const result of ['expired', 'gone', 'override'] as const) expect(oldVmWarning(done({ result, at: 1 }), [running])).toEqual({ vmId: 1012, text });
  });

  it('says nothing for one retired over SSH, re-installed, empty, or rebuilt in place, or one not running', () => {
    for (const result of ['retired', 'reinstalled', 'empty', 'in_place'] as const) expect(oldVmWarning(done({ result, at: 1 }), [running])).toBeNull();
    expect(oldVmWarning(done({ result: 'expired', at: 1 }), [{ ...running, status: { state: 'stopped' } }])).toBeNull();
    expect(oldVmWarning(done({ result: 'expired', at: 1 }), [null, 'unreachable'])).toBeNull();
    expect(oldVmWarning(done({ result: 'expired', at: 1 }, 1001), [running])).toBeNull(); // in place: it is this server
    expect(oldVmWarning({ ...initialState('GBR'), step: 'done', vmId: 1001 }, [running])).toBeNull();
  });

  // Each VM step 4 saw to, not only the last: the one LNVPS reports running is named.
  it('names whichever of the old VMs runs', () => {
    const s = done({ result: 'expired', at: 1 });
    const two: OnboardingState = { ...s, rebuild: { ...s.rebuild!, others: [{ id: 1020, result: 'expired', at: 1 }] } };
    const stopped = { ...running, status: { state: 'stopped' as const } };
    expect(oldVmWarning(two, [stopped, vm({ id: 1020 })])).toEqual({ vmId: 1020, text: text.replace('VM 1012', 'VM 1020') });
  });
});
