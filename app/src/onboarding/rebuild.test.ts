import { describe, expect, it } from 'vitest';
import type { SnapshotSummary } from '../backup/backups';
import type { Vm } from '../lnvps/client';
import { memoryFiles } from '../testing/memoryFiles';
import { INSTALL_STEPS } from './install';
import { initialState, oldVmsToWatch, overrideOffered, RETIRE_TRIES_BEFORE_OVERRIDE, serversOfThisPhrase, startRebuild, type OnboardingState } from './machine';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import {
  backupButton, backupRows, backupSelection, canCancel, cancelFromScreen, cancelRebuild, chosenLine, importedChoice, inPlaceChoices, keepsAwake, olderNotice,
  paidMeanwhile, rebuildKeeps, vmButton, vmRows, vmSelection, whereButton, whereRows, withConfirm, withoutBackup, withTarget,
} from './rebuild';

const KEPT = { kind: 'kept' as const, name: 'ab-3-1789990000.age', created: 1_789_990_000, cards: 2, totalMsat: 10_088_766 };
const at = (o: Partial<NonNullable<OnboardingState['rebuild']>> = {}): OnboardingState => {
  const s = startRebuild({ ...initialState('GBR'), step: 'done', vmId: 1012 }, 'server_page');
  return { ...s, rebuild: { ...s.rebuild!, ...o }, error: { kind: 'retry', message: 'choose again' } };
};

// The screen's changes to a rebuild, each saved through the runner.
describe('the rebuild screen\'s choices', () => {
  it('takes a new VM, or in place once Rebuild on VM is tapped', () => {
    expect(withTarget(at(), { kind: 'new' })).toMatchObject({ rebuild: { target: { kind: 'new' } }, error: undefined });
    expect(withTarget(at({ confirm: { inPlace: true } }), { kind: 'new' }).rebuild!.confirm!.inPlace).toBeUndefined();
    expect(withTarget(at(), { kind: 'in_place', vmId: 1012 })).toMatchObject({ rebuild: { target: { kind: 'in_place', vmId: 1012 }, confirm: { inPlace: true } } });
  });

  // The real run goes back, in place, to the VM its first rebuild retired.
  it('offers in place every paid VM of this phrase\'s key, one a rebuild retired too, saying so', () => {
    const vm = (id: number, expires: string | null, key = 7) => ({ id, expires, ssh_key: { id: key } }) as Vm;
    const now = Date.parse('2026-10-07T00:00:00Z');
    const vms = [vm(1009, '2026-11-01T00:00:00Z'), vm(1006, '2026-10-20T00:00:00Z'), vm(1004, '2026-10-01T00:00:00Z'), vm(1008, null), vm(1018, '2026-11-01T00:00:00Z', 8)];
    const choices = inPlaceChoices(vms, { sshKeyId: 7, retiredVms: [1009] }, now);
    expect(choices).toEqual([{ id: 1009, expires: '2026-11-01T00:00:00Z', retired: true }, { id: 1006, expires: '2026-10-20T00:00:00Z', retired: false }]);
    // As the screen's rows say them (whereRows, below).
    expect(whereRows(choices, now / 1000, 0).slice(1).map((r) => `${r.name}: ${r.line}`)).toEqual(['VM 1009: Paid until 1 Nov · retired by a rebuild', 'VM 1006: Paid until 20 Oct']);
  });

  it('records each confirmation, keeping the others', () => {
    const s = withConfirm(at({ confirm: { older: true } }), { retire: true });
    expect(s).toMatchObject({ rebuild: { confirm: { older: true, retire: true } }, error: undefined });
  });

  it('lets step 1 be chosen again until step 4 has run', () => {
    expect(withoutBackup(at({ backup: KEPT, confirm: { older: true } }))).toMatchObject({ rebuild: { backup: undefined, confirm: { older: undefined } }, error: undefined });
    const locked = at({ backup: KEPT, backupLocked: true });
    expect(withoutBackup(locked)).toBe(locked);
  });


  // Thinning never removes the snapshot a rebuild restores (backups.ts toRemove).
  it('names the kept snapshot a rebuild chose, for thinning to keep', () => {
    expect(rebuildKeeps(at({ backup: KEPT }))).toBe(KEPT.name);
    expect(rebuildKeeps(at({ backup: { kind: 'phrase_only' } }))).toBeUndefined();
    expect(rebuildKeeps(at())).toBeUndefined();
    expect(rebuildKeeps(initialState('GBR'))).toBeUndefined();
  });

  // Retiring keeps failing while the old server answers SSH (Docker broken on it, say).
  it('offers the override while LNVPS can\'t be reached, or once retiring has failed often enough over SSH', () => {
    const retire = { ...at(), step: 'retire' as const, error: undefined };
    expect(overrideOffered({ ...retire, waiting: 'old_unreachable' })).toBe(true);
    // Any other network failure at step 4 (a blip fetching the final snapshot, say) is the phone's, not the old server's.
    expect(overrideOffered({ ...retire, waiting: 'network' })).toBe(false);
    expect(overrideOffered(retire)).toBe(false);
    const failed = { ...retire, error: { kind: 'retry' as const, message: 'install.sh retire failed (exit 1): Cannot connect to the Docker daemon' } };
    expect(overrideOffered({ ...failed, rebuild: { ...failed.rebuild!, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE - 1 } })).toBe(false);
    expect(overrideOffered({ ...failed, rebuild: { ...failed.rebuild!, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } })).toBe(true);
    expect(overrideOffered({ ...failed, step: 'install', rebuild: { ...failed.rebuild!, retireTries: RETIRE_TRIES_BEFORE_OVERRIDE } })).toBe(false);
  });

  // An exported file whose name parses is kept as it is: one the phrase can't open isn't a backup, so it goes again.
  it('takes an imported backup as step 1\'s choice, and removes one that can\'t be opened', async () => {
    const files = memoryFiles();
    await files.write(KEPT.name, new Uint8Array([1]));
    await files.write('cd-1-1789990000.age', new Uint8Array([2]));
    const summary: SnapshotSummary = { vmId: '1012', userVersion: 4, cards: 2, totalMsat: 10_088_766, created: 1_789_990_000 };
    const backups = { ...files, inspect: async (name: string) => (name === KEPT.name ? summary : null) };
    expect(await importedChoice(KEPT.name, backups)).toEqual(KEPT);
    expect(await importedChoice('cd-1-1789990000.age', backups)).toBeNull();
    expect((await files.list()).map((k) => k.name)).toEqual([KEPT.name]);
  });

  // The backups check takes these as this phrase's servers.
  it("lists this phrase's servers: this one, the rebuild's old VM and others, and every VM a rebuild retired", () => {
    const s: OnboardingState = {
      ...initialState('GBR'), step: 'done', vmId: 1009, retiredVms: [1003, 1019],
      rebuild: { source: 'server_page', oldVm: { id: 1003 }, others: [{ id: 1004, result: 'gone', at: 1 }] },
    };
    expect(serversOfThisPhrase(s)).toEqual(['1009', '1003', '1004', '1019']);
    expect(serversOfThisPhrase({ ...initialState('GBR'), vmId: 1009 })).toEqual(['1009']);
  });

  // Keep the screen on while the old server is retired and the new one installed and paired, not through LNVPS's hour.
  it('keeps the screen awake only while retiring, installing and pairing', () => {
    for (const step of ['retire', 'install', 'pair'] as const) expect(keepsAwake({ ...at(), step })).toBe(true);
    for (const step of ['backup', 'where', 'order', 'pay', 'boot', 'done'] as const) expect(keepsAwake({ ...at(), step })).toBe(false);
  });
});

// Until step 4 has run and while no VM has been paid for, the server page goes back as it was.
describe('Cancel rebuild', () => {
  const host = {
    ipv4: '45.67.89.170', hostname: 'vm-1012.lnvps.cloud', user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' }, keySource: 'lnvps' as const,
  };
  const page: OnboardingState = {
    ...initialState('GBR'), step: 'done', vmId: 1012, host, installed: [...INSTALL_STEPS], deviceKeyId: 'aaaaaaaaaaaaaaaa', othersRevoked: true,
    notice: 'VM 1020 was replaced by VM 1012 in a rebuild: it can\'t be used again.',
  };
  const rebuilding = (o: Partial<OnboardingState> = {}, r: Partial<NonNullable<OnboardingState['rebuild']>> = {}): OnboardingState => {
    const s = startRebuild(page, 'server_page');
    return { ...s, ...o, rebuild: { ...s.rebuild!, ...r } };
  };

  // The real run: the second rebuild showed the first one's final-snapshot note under step 1's new choice.
  it('starts with no note an earlier rebuild left, and Cancel rebuild puts it back', () => {
    const notice = "The old server's final snapshot, of 2026-10-07 09:34, replaces the backup of 2026-10-07 08:50 chosen in step 1.";
    const s = startRebuild({ ...initialState('GBR'), step: 'done', vmId: 1003, notice }, 'server_page');
    expect(s.notice).toBeUndefined();
    expect(cancelRebuild(s).notice).toBe(notice);
  });

  it('puts the server page back from steps 1 and 2, the order and an unpaid invoice', () => {
    const invoice = { vmId: 1001, sat: 1550, days: 7, bolt11: 'lnbc1', expiresAt: 1 };
    for (const s of [
      rebuilding({ waiting: 'choose_backup' }),
      rebuilding({ step: 'where', notice: 'The backup of … isn\'t the newest' }, { backup: { kind: 'phrase_only' } }),
      rebuilding({ step: 'order', error: { kind: 'retry', message: 'LNVPS said no' } }, { target: { kind: 'new' } }),
      rebuilding({ step: 'pay', vmId: 1001, invoice, orderDeadline: 2, waiting: 'payment' }, { target: { kind: 'new' } }),
    ]) {
      expect(canCancel(s)).toBe(true);
      expect(cancelRebuild(s)).toEqual(page);
    }
  });

  it('is refused once a VM is paid for or step 4 has run, and on a new phone', () => {
    for (const s of [
      rebuilding({ step: 'boot', vmId: 1001 }),
      rebuilding({ step: 'retire', vmId: 1001 }),
      rebuilding({ step: 'where' }, { backupLocked: true }),
      rebuilding({ step: 'pay', vmId: 1001 }, { retire: { result: 'gone', at: 1 } }),
      rebuilding({}, { source: 'new_phone' }),
      page,
    ]) {
      expect(canCancel(s)).toBe(false);
      expect(cancelRebuild(s)).toBe(s);
    }
  });

  // After a finished rebuild the record stays, so the old VM keeps being watched: a cancelled second rebuild mustn't lose it.
  it('puts back an earlier rebuild\'s record, and with it the watch on its old VM', () => {
    const earlier: OnboardingState = { ...page, vmId: 1001, rebuild: { source: 'server_page', oldVm: { id: 1020 }, retire: { result: 'expired', at: 1 } } };
    const s = { ...startRebuild(earlier, 'server_page'), waiting: 'choose_backup' as const };
    expect(oldVmsToWatch(earlier)).toEqual([1020]);
    expect(canCancel(s)).toBe(true);
    const back = cancelRebuild(s);
    expect(back).toEqual(earlier);
    expect(oldVmsToWatch(back)).toEqual([1020]);
  });

  it('asks LNVPS at the pay step whether the new VM was paid meanwhile', async () => {
    const vm = (expires?: string) => ({ getVm: async () => ({ id: 1001, expires }) as Vm });
    const paying = rebuilding({ step: 'pay', vmId: 1001 });
    expect(await paidMeanwhile(paying, vm())).toBe(false);
    expect(await paidMeanwhile(paying, vm('2026-11-02T12:00:00Z'))).toBe(true);
    expect(await paidMeanwhile(rebuilding({ step: 'order' }), vm('2026-11-02T12:00:00Z'))).toBe(false);
  });
});

// Cancel rebuild's state has step done, as an ended rebuild's: the screen is told it is leaving before the state
// changes, so nothing draws the ready page for a rebuild that never ran.
describe('cancelFromScreen', () => {
  const unpaid = { getVm: async () => ({ id: 1001 }) as Vm };
  const s = (): OnboardingState => ({ ...at(), error: undefined, step: 'pay', vmId: 1001 });

  it('tells the screen it is leaving before the state changes, and cancels', async () => {
    const order: string[] = [];
    let state = s();
    const result = await cancelFromScreen(state, {
      lnvps: unpaid,
      leaving: () => void order.push('leaving'),
      update: async (f) => {
        order.push('update');
        state = f(state);
      },
    });
    expect(order).toEqual(['leaving', 'update']);
    expect(result).toEqual({ left: true });
    expect(state).toMatchObject({ step: 'done', vmId: 1012 });
    expect(state.rebuild).toBeUndefined();
  });

  it('stays, with its reason, when the VM was paid for meanwhile: nothing is cancelled', async () => {
    const order: string[] = [];
    const result = await cancelFromScreen(s(), {
      lnvps: { getVm: async () => ({ id: 1001, expires: '2026-11-02T12:00:00Z' }) as Vm },
      leaving: () => void order.push('leaving'),
      update: async () => void order.push('update'),
    });
    expect(result).toEqual({ left: false, message: 'VM 1001 is paid for now, so the rebuild goes on.', afterLeaving: false });
    expect(order).toEqual([]);
  });

  it("says so when the cancelled state couldn't be saved, after the screen was told it was leaving", async () => {
    const order: string[] = [];
    const result = await cancelFromScreen(s(), {
      lnvps: unpaid,
      leaving: () => void order.push('leaving'),
      update: async () => {
        order.push('update');
        throw new Error('disk full');
      },
    });
    expect(result).toEqual({ left: false, message: "Couldn't cancel the rebuild: disk full", afterLeaving: true });
    expect(order).toEqual(['leaving', 'update']);
  });

  it("says so when LNVPS couldn't be asked, before anything changed", async () => {
    const order: string[] = [];
    const result = await cancelFromScreen(s(), {
      lnvps: { getVm: async () => { throw new Error('LNVPS said 502'); } },
      leaving: () => void order.push('leaving'),
      update: async () => void order.push('update'),
    });
    expect(result).toEqual({ left: false, message: "Couldn't cancel the rebuild: LNVPS said 502", afterLeaving: false });
    expect(order).toEqual([]);
  });
});

// A rebuild's choices as rows, a row chosen and then one button.
describe("a rebuild's rows", () => {
  // 10 Oct 2026, 15:00 UTC, on a phone at UTC.
  const NOW = Date.UTC(2026, 9, 10, 15, 0) / 1000;
  const time = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m) / 1000;
  const sum = (created: number, o: Partial<SnapshotSummary> = {}): SnapshotSummary => ({ vmId: '1012', userVersion: CARDD_SCHEMA_VERSION, cards: 3, totalMsat: 48_210_999, created, ...o });
  const kept = (created: number) => ({ name: `ab-1-${created}.age`, created });
  const opened = [
    { kept: kept(time(10, 13, 2)), summary: sum(time(10, 13, 2)) },
    { kept: kept(time(9, 22, 52)), summary: sum(time(9, 22, 52), { cards: 1, totalMsat: 999 }) },
    { kept: kept(time(7, 9, 15)), summary: sum(time(7, 9, 15)) },
  ];

  it('names a backup by its time, with its cards and money on the line', () => {
    expect(backupRows(opened, false, NOW, 0)).toEqual([
      { key: opened[0].kept.name, name: 'Today at 13:02', line: '3 cards · 48,210 sat', choice: { kind: 'kept', name: opened[0].kept.name, created: time(10, 13, 2), cards: 3, totalMsat: 48_210_999 } },
      { key: opened[1].kept.name, name: 'Yesterday at 22:52', line: '1 card · 0 sat', choice: { kind: 'kept', name: opened[1].kept.name, created: time(9, 22, 52), cards: 1, totalMsat: 999 } },
      { key: opened[2].kept.name, name: '7 Oct at 09:15', line: '3 cards · 48,210 sat', choice: { kind: 'kept', name: opened[2].kept.name, created: time(7, 9, 15), cards: 3, totalMsat: 48_210_999 } },
    ]);
    // The phone's time zone, as every time on screen.
    expect(backupRows([opened[1]], false, NOW, 120)[0].name).toBe('Today at 00:52');
  });

  it("says why a backup can't be chosen, and gives it no choice", () => {
    const k = kept(time(10, 13, 2));
    const line = (summary: SnapshotSummary | null | 'failed' | undefined) => backupRows([{ kept: k, summary }], false, NOW, 0)[0];
    expect(line(undefined)).toEqual({ key: k.name, name: 'Today at 13:02', line: 'Opening…', choice: null });
    expect(line(null)).toMatchObject({ line: 'Can’t be opened with your recovery phrase', choice: null });
    expect(line('failed')).toMatchObject({ line: 'Couldn’t be opened on this phone just now', choice: null });
    expect(line(sum(k.created, { userVersion: CARDD_SCHEMA_VERSION + 1 }))).toMatchObject({ line: 'Made by a newer server: update the app first', choice: null });
  });

  // The tick's rule is "the newest that can be chosen": the rows are newest first whatever order they are handed in.
  it('lists the backups newest first, whatever order it is given them in', () => {
    const shuffled = [opened[2], opened[0], opened[1]];
    expect(backupRows(shuffled, true, NOW, 0).map((r) => r.key)).toEqual([opened[0].kept.name, opened[1].kept.name, opened[2].kept.name, 'phrase_only']);
    expect(backupSelection(backupRows(shuffled, false, NOW, 0), null)?.key).toBe(opened[0].kept.name);
    // The list it was given is left as it was.
    expect(shuffled.map((x) => x.kept.name)).toEqual([opened[2].kept.name, opened[0].kept.name, opened[1].kept.name]);
  });

  it('adds the phrase alone as the last row only when it is offered', () => {
    expect(backupRows(opened, false, NOW, 0)).toHaveLength(3);
    const rows = backupRows(opened, true, NOW, 0);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({ key: 'phrase_only', name: 'No backup: phrase only', line: 'The server starts with no cards and all its money in Pool', choice: { kind: 'phrase_only' } });
    expect(backupRows([], true, NOW, 0)).toHaveLength(1);
  });

  it('ticks the newest backup that can be chosen until another row is tapped', () => {
    const rows = backupRows([{ kept: kept(time(10, 14, 0)), summary: undefined }, ...opened], true, NOW, 0);
    // The newest is still opening: the next one down.
    expect(backupSelection(rows, null)?.key).toBe(opened[0].kept.name);
    expect(backupSelection(rows, opened[2].kept.name)?.key).toBe(opened[2].kept.name);
    expect(backupSelection(rows, 'phrase_only')?.choice).toEqual({ kind: 'phrase_only' });
    // A tapped row that can't be chosen (or is gone) is given up for the newest.
    expect(backupSelection(rows, rows[0].key)?.key).toBe(opened[0].kept.name);
    expect(backupSelection(rows, 'no-such-row')?.key).toBe(opened[0].kept.name);
  });

  it('never ticks the phrase alone by itself', () => {
    const rows = backupRows([{ kept: kept(time(10, 13, 2)), summary: null }], true, NOW, 0);
    expect(backupSelection(rows, null)).toBeNull();
    expect(backupSelection(backupRows([], true, NOW, 0), null)).toBeNull();
    expect(backupSelection([], null)).toBeNull();
  });

  it("names the button by the choice", () => {
    const rows = backupRows(opened, true, NOW, 0);
    expect(backupButton(null, NOW, 0)).toBe('Choose a backup');
    expect(backupButton(rows[0], NOW, 0)).toBe('Restore the backup from today at 13:02');
    expect(backupButton(rows[2], NOW, 0)).toBe('Restore the backup from 7 Oct at 09:15');
    expect(backupButton(rows[3], NOW, 0)).toBe('Rebuild from the phrase alone');
  });

  it("says what was chosen on the Done line's row", () => {
    expect(chosenLine(KEPT, 1_789_990_000 + 60, 0)).toMatch(/^Today at \d\d:\d\d · 2 cards · 10,088 sat$/);
    expect(chosenLine({ ...KEPT, cards: 1 }, 1_789_990_000 + 2 * 86_400, 0)).toMatch(/^\d+ \w{3} at \d\d:\d\d · 1 card · 10,088 sat$/);
    expect(chosenLine({ kind: 'phrase_only' }, NOW, 0)).toBe('No backup: the recovery phrase alone');
  });

  it('offers a new server and each paid VM, nothing chosen by itself', () => {
    const rows = whereRows([{ id: 1009, expires: '2026-10-17T08:00:00Z', retired: false }, { id: 1006, expires: '2027-01-03T08:00:00Z', retired: true }], NOW, 0);
    expect(rows).toEqual([
      { key: 'new', name: 'A new server', line: 'LNVPS rents a new one, ordered and paid here as at first setup', target: { kind: 'new' } },
      { key: 'vm-1009', name: 'VM 1009', line: 'Paid until 17 Oct', target: { kind: 'in_place', vmId: 1009 } },
      { key: 'vm-1006', name: 'VM 1006', line: 'Paid until 3 Jan 2027 · retired by a rebuild', target: { kind: 'in_place', vmId: 1006 } },
    ]);
    expect(whereRows([], NOW, 0)).toHaveLength(1);
    expect(whereButton(null)).toBe('Choose where');
    expect(whereButton(rows[0].target)).toBe('Continue with a new server');
    expect(whereButton(rows[1].target)).toBe('Rebuild on VM 1009');
  });

  it("lists a new phone's servers the same way", () => {
    expect(vmRows([{ id: 1009, expires: '2026-10-17T08:00:00Z' }, { id: 1006, expires: '2026-11-02T08:00:00Z' }], NOW, 0)).toEqual([
      { key: 'vm-1009', id: 1009, name: 'VM 1009', line: 'Paid until 17 Oct' },
      { key: 'vm-1006', id: 1006, name: 'VM 1006', line: 'Paid until 2 Nov' },
    ]);
    expect(vmButton(null)).toBe('Choose a server');
    expect(vmButton(1006)).toBe('Set up VM 1006');
  });

  it('ticks no server by itself, and drops one that is no longer offered', () => {
    const rows = vmRows([{ id: 1009, expires: '2026-10-17T08:00:00Z' }, { id: 1006, expires: '2026-11-02T08:00:00Z' }], NOW, 0);
    expect(vmSelection(rows, null)).toBeNull();
    expect(vmSelection(rows, 1006)).toBe(1006);
    // It expired while the screen showed: the tap no longer chooses it.
    expect(vmSelection(rows.slice(0, 1), 1006)).toBeNull();
    expect(vmSelection([], 1009)).toBeNull();
  });

  it('writes Pool with a capital in the phrase alone\'s warning', () => {
    expect(olderNotice({ kind: 'phrase_only' }, { phone: NOW })).toContain('everything goes to Pool.');
  });
});
