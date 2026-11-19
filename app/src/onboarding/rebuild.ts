// A rebuild's steps 1, 2 and 4: the parts the
// machine and the screens share. Which snapshots are newer than the one
// chosen and what the warning says, the screen's choices and confirmations,
// and fetching the old server's latest snapshot through cardd's API.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MAX_SNAPSHOT_BYTES, snapshotName, type BackupFiles, type Kept, type ServerLatest, type SnapshotSummary } from '../backup/backups';
import type { CarddClient } from '../cardd/client';
import { getVmOrNull, type LnvpsClient, type Vm } from '../lnvps/client';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import { dateText, shortDate, whenText } from '../money/format';
import { satText } from '../cards/labels';
import { SECRET_STEPS } from './install';
import type { ChosenBackup, Deps, OnboardingState, Rebuild } from './machine';

/** A time (unix seconds) as the phone shows it, in its own time zone. */
export const timeText = (unixS: number) => dateText(unixS, -new Date(unixS * 1000).getTimezoneOffset());

/** Times (unix seconds) of snapshots newer than the one chosen: this phone's newest, and the server's latest as last noted. */
export type Newer = { phone?: number; server?: number };

/**
 * What is newer than the chosen backup, or null if nothing is:
 * a kept snapshot the phrase can't open doesn't count. Anything is newer than the phrase alone.
 */
export function notNewest(chosen: ChosenBackup, kept: Kept[], server: ServerLatest | null): Newer | null {
  const after = chosen.kind === 'kept' ? chosen.created : -1;
  const phone = Math.max(-1, ...kept.filter((k) => k.checked !== 'unreadable').map((k) => k.created));
  const newer: Newer = {};
  if (phone > after) newer.phone = phone;
  if (server && server.created > after) newer.server = server.created;
  return newer.phone === undefined && newer.server === undefined ? null : newer;
}

/** The red warning, naming both times and what an older choice loses. */
export function olderNotice(chosen: ChosenBackup, newer: Newer): string {
  const known = [
    ...(newer.phone !== undefined ? [`this phone holds one of ${timeText(newer.phone)}`] : []),
    ...(newer.server !== undefined ? [`the server last reported one of ${timeText(newer.server)}`] : []),
  ].join(', and ');
  return chosen.kind === 'kept'
    ? `The backup of ${timeText(chosen.created)} isn't the newest: ${known}. Restoring it loses every change since then, and the cards' tap counters go back.`
    : `The phrase alone restores no backup, though ${known}. Without one, the split between the cards is lost: everything goes to Pool.`;
}

/**
 * Step 1's choice from the screen. Refused once step 4 has run: the old server
 * may be retired by then, its final snapshot the newest there is. A new choice is confirmed afresh.
 */
export function withBackup(s: OnboardingState, backup: ChosenBackup): OnboardingState {
  const r = s.rebuild;
  if (!r || r.backupLocked) return s;
  return { ...s, rebuild: { ...r, backup, confirm: { ...r.confirm, older: undefined } }, error: undefined };
}

/** Step 1 again: refused once step 4 has run, as withBackup is. */
export function withoutBackup(s: OnboardingState): OnboardingState {
  const r = s.rebuild;
  if (!r || r.backupLocked) return s;
  return { ...s, rebuild: { ...r, backup: undefined, confirm: { ...r.confirm, older: undefined } }, error: undefined };
}

/** Step 2's choice. The screen's Rebuild on VM button is in place's confirmation, so choosing it is that confirmation. */
export function withTarget(s: OnboardingState, target: NonNullable<Rebuild['target']>): OnboardingState {
  const r = s.rebuild;
  if (!r) return s;
  return { ...s, rebuild: { ...r, target, confirm: { ...r.confirm, inPlace: target.kind === 'in_place' || undefined } }, error: undefined };
}

/** A paid VM of this phrase step 2 offers in place; retired: a rebuild retired it (it is offered all the same). */
export type InPlaceChoice = { id: number; expires: string; retired: boolean };

/**
 * Step 2's VMs for in place: every paid VM of this phrase's SSH key, one a rebuild retired too (going
 * back to it after a rebuild elsewhere: the wipe takes its marker). nowMs: LNVPS's clock.
 */
export function inPlaceChoices(vms: Vm[], s: Pick<OnboardingState, 'sshKeyId' | 'retiredVms'>, nowMs: number): InPlaceChoice[] {
  return vms
    .filter((v) => v.ssh_key?.id === s.sshKeyId && v.expires && Date.parse(v.expires) > nowMs)
    .map((v) => ({ id: v.id, expires: v.expires!, retired: !!s.retiredVms?.includes(v.id) }));
}

/** A confirmation given with its button (an older backup, retiring, re-installing, the override), kept with the others. */
export function withConfirm(s: OnboardingState, c: NonNullable<Rebuild['confirm']>): OnboardingState {
  const r = s.rebuild;
  if (!r) return s;
  return { ...s, rebuild: { ...r, confirm: { ...r.confirm, ...c } }, error: undefined };
}

/** A kept snapshot's time, cards and total, as the screens show it. */
/**
 * An imported file (backup/files.ts importExported) as step 1's choice. One the phrase can't open
 * isn't a backup: it is removed again, and the answer is null.
 */
export async function importedChoice(name: string, backups: Pick<Deps['backups'], 'inspect' | 'remove'>): Promise<ChosenBackup | null> {
  const x = await backups.inspect(name);
  if (!x) {
    await backups.remove(name);
    return null;
  }
  return { kind: 'kept', name, created: x.created, cards: x.cards, totalMsat: x.totalMsat };
}

/**
 * The screen stays on while the old server is retired and the new one installed and paired, not through LNVPS's
 * hours: neither the boot's wait for its scan nor the install's for it to confirm the new server's key.
 */
export const keepsAwake = (s: OnboardingState) => (s.step === 'retire' || s.step === 'install' || s.step === 'pair') && s.waiting !== 'host_key_confirm';

/** Before any VM is paid for: the steps at which Cancel rebuild is offered. */
const CANCELLABLE: readonly OnboardingState['step'][] = ['backup', 'where', 'order', 'pay'];

/**
 * Whether Cancel rebuild puts the server page back: a rebuild started
 * there, before step 4 has run (nothing has touched the old server), and before a VM is paid for; or, on a new VM,
 * once its install has stopped on an error before any secret reached it (LNVPS published another key for it, or
 * hasn't confirmed it in 3 hours, say): the old server still runs, and the new VM, paid for, holds no wallet.
 */
export function canCancel(s: OnboardingState): boolean {
  const r = s.rebuild;
  if (!r?.before || r.source !== 'server_page' || r.retire || r.backupLocked) return false;
  if (CANCELLABLE.includes(s.step)) return true;
  return s.step === 'install' && r.target?.kind === 'new' && !!s.error && !s.installed.some((x) => SECRET_STEPS.includes(x));
}

/** The server page as it was before the rebuild; s itself when it can't be cancelled. */
export function cancelRebuild(s: OnboardingState): OnboardingState {
  if (!canCancel(s)) return s;
  return {
    ...s,
    ...s.rebuild!.before!,
    step: 'done',
    rebuild: s.rebuild!.before!.rebuild,
    orderDeadline: undefined,
    invoice: undefined,
    runningSince: undefined,
    hostKeyTypes: undefined,
    waiting: undefined,
    error: undefined,
  };
}

/**
 * Cancel rebuild as the screen runs it. Refused, with its reason, when the VM was paid for meanwhile. Else the screen
 * is told it is leaving before the state changes: the cancelled state's step is done, as an ended rebuild's, and the
 * runner shows it to the screen before it is saved, so nothing may draw it as a rebuild that ended. afterLeaving: the
 * change couldn't be saved after the screen was told (it must say so, and still not draw the ready page).
 */
export async function cancelFromScreen(
  s: OnboardingState,
  o: { lnvps: Pick<LnvpsClient, 'getVm'>; leaving: () => void; update: (f: (s: OnboardingState) => OnboardingState) => Promise<void> },
): Promise<{ left: true } | { left: false; message: string; afterLeaving: boolean }> {
  let afterLeaving = false;
  try {
    if (await paidMeanwhile(s, o.lnvps)) return { left: false, message: `VM ${s.vmId} is paid for now, so the rebuild goes on.`, afterLeaving };
    o.leaving();
    afterLeaving = true;
    await o.update(cancelRebuild);
    return { left: true };
  } catch (e) {
    return { left: false, message: `Couldn't cancel the rebuild: ${e instanceof Error ? e.message : String(e)}`, afterLeaving };
  }
}

/** At the pay step, whether LNVPS shows the new VM paid though the machine hasn't seen it yet. */
export async function paidMeanwhile(s: OnboardingState, lnvps: Pick<LnvpsClient, 'getVm'>): Promise<boolean> {
  if (s.step !== 'pay' || s.vmId === undefined) return false;
  return !!(await getVmOrNull(lnvps, s.vmId))?.expires;
}

/** The kept snapshot a rebuild restores, which thinning never removes (backups.ts toRemove). */
export const rebuildKeeps = (s: OnboardingState) => (s.rebuild?.backup?.kind === 'kept' ? s.rebuild.backup.name : undefined);

/** A snapshot the server describes so that no second try can fetch it: not this phrase's, described oddly, too big. */
export class SnapshotRefused extends Error {}

/**
 * Fetches a server's latest snapshot into the phone's backups, unless it is held already, checked
 * as the backup job checks one: encrypted to this phrase, named only from cardd's own shapes,
 * within the cap, and the size and hash the server described. Returns its name; throws the reason.
 */
export async function downloadLatest(
  cardd: Pick<CarddClient, 'backups' | 'backupFile'>,
  files: Pick<BackupFiles, 'list' | 'write'>,
  recipient: string,
): Promise<string> {
  const status = await cardd.backups();
  const l = status.latest;
  if (!l) throw new Error('it has no snapshot');
  if (status.recipient !== recipient) throw new SnapshotRefused("its snapshots aren't encrypted to your recovery phrase");
  if (!/^[0-9a-f]{32}$/.test(status.installId) || !Number.isSafeInteger(l.version) || l.version < 1 || !Number.isSafeInteger(l.created) || l.created < 0) {
    throw new SnapshotRefused('it described its snapshot oddly');
  }
  const name = snapshotName(status.installId, l.version, l.created);
  if ((await files.list()).some((k) => k.name === name && k.size === l.size)) return name;
  if (l.size > MAX_SNAPSHOT_BYTES) throw new SnapshotRefused(`snapshot ${l.version} is too big (${l.size} bytes)`);
  const bytes = await cardd.backupFile(l.version, MAX_SNAPSHOT_BYTES);
  if (bytes.length !== l.size || bytesToHex(sha256(bytes)) !== l.sha256) throw new Error(`snapshot ${l.version} doesn't match what the server described`);
  await files.write(name, bytes);
  return name;
}

// A rebuild's choices as rows: a row chosen, then one button.
// Times are the phone's (nowS: now, unix seconds; offsetMin: minutes east of UTC), as Settings' pages write them.

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const cardsAndMoney = (x: { cards: number; totalMsat: number }) => `${x.cards} ${x.cards === 1 ? 'card' : 'cards'} · ${satText(x.totalMsat)}`;

/** A backup as the screen has it: undefined until opened, null if the phrase can't open it, 'failed' if the phone couldn't. */
export type BackupOpened = SnapshotSummary | null | 'failed' | undefined;
/** choice: what choosing the row chooses; null for a row that can't be chosen (its line says why). */
export type BackupRow = { key: string; name: string; line: string; choice: ChosenBackup | null };

const PHRASE_ONLY_ROW: BackupRow = {
  key: 'phrase_only', name: 'No backup: phrase only', line: 'The server starts with no cards and all its money in Pool', choice: { kind: 'phrase_only' },
};

/** Step 1's rows: the phone's backups, newest first whatever order they come in, then the phrase alone when it is offered. */
export function backupRows(backups: { kept: Pick<Kept, 'name' | 'created'>; summary: BackupOpened }[], phraseOnly: boolean, nowS: number, offsetMin: number): BackupRow[] {
  const newestFirst = [...backups].sort((a, b) => b.kept.created - a.kept.created);
  const rows = newestFirst.map(({ kept, summary: x }): BackupRow => {
    const row = { key: kept.name, name: capital(whenText(kept.created, nowS, offsetMin)) };
    if (x === undefined) return { ...row, line: 'Opening…', choice: null };
    if (x === null) return { ...row, line: 'Can’t be opened with your recovery phrase', choice: null };
    if (x === 'failed') return { ...row, line: 'Couldn’t be opened on this phone just now', choice: null };
    if (x.userVersion > CARDD_SCHEMA_VERSION) return { ...row, line: 'Made by a newer server: update the app first', choice: null };
    return { ...row, line: cardsAndMoney(x), choice: { kind: 'kept', name: kept.name, created: x.created, cards: x.cards, totalMsat: x.totalMsat } };
  });
  return phraseOnly ? [...rows, PHRASE_ONLY_ROW] : rows;
}

/**
 * The row that is ticked: the one tapped while it can still be chosen; else the newest backup that can be. The
 * phrase alone is only ever ticked by a tap: it loses the split between the cards.
 */
export function backupSelection(rows: BackupRow[], tapped: string | null): BackupRow | null {
  return rows.find((r) => r.key === tapped && r.choice) ?? rows.find((r) => r.choice?.kind === 'kept') ?? null;
}

/** Step 1's button, naming the choice; with none it is off. */
export function backupButton(row: BackupRow | null, nowS: number, offsetMin: number): string {
  if (!row?.choice) return 'Choose a backup';
  return row.choice.kind === 'kept' ? `Restore the backup from ${whenText(row.choice.created, nowS, offsetMin)}` : 'Rebuild from the phrase alone';
}

/** What step 1 settled, under its row in the Done line's panel. */
export const chosenLine = (b: ChosenBackup, nowS: number, offsetMin: number): string =>
  b.kind === 'kept' ? `${capital(whenText(b.created, nowS, offsetMin))} · ${cardsAndMoney(b)}` : 'No backup: the recovery phrase alone';

export type WhereTarget = NonNullable<Rebuild['target']>;
export type WhereRow = { key: string; name: string; line: string; target: WhereTarget };

const paidUntil = (expires: string, nowS: number, offsetMin: number) => `Paid until ${shortDate(Date.parse(expires) / 1000, nowS, offsetMin)}`;

/** Step 2's rows: a new server, then each paid VM of the phrase (inPlaceChoices). */
export function whereRows(vms: InPlaceChoice[], nowS: number, offsetMin: number): WhereRow[] {
  return [
    { key: 'new', name: 'A new server', line: 'LNVPS rents a new one, ordered and paid here as at first setup', target: { kind: 'new' } },
    ...vms.map((v): WhereRow => ({
      key: `vm-${v.id}`, name: `VM ${v.id}`, line: `${paidUntil(v.expires, nowS, offsetMin)}${v.retired ? ' · retired by a rebuild' : ''}`, target: { kind: 'in_place', vmId: v.id },
    })),
  ];
}

/** Step 2's button: off with nothing chosen; in place, it is the wipe's confirmation. */
export function whereButton(target: WhereTarget | null): string {
  if (!target) return 'Choose where';
  return target.kind === 'new' ? 'Continue with a new server' : `Rebuild on VM ${target.vmId}`;
}

/** A new phone's paid servers as rows, when its phrase has more than one. */
export const vmRows = (choices: { id: number; expires: string }[], nowS: number, offsetMin: number) =>
  choices.map((v) => ({ key: `vm-${v.id}`, id: v.id, name: `VM ${v.id}`, line: paidUntil(v.expires, nowS, offsetMin) }));

/** The server that is ticked: the one tapped, while it is still offered (one can expire while the screen shows); none by itself. */
export const vmSelection = (rows: { id: number }[], tapped: number | null): number | null => (rows.some((r) => r.id === tapped) ? tapped : null);

export const vmButton = (id: number | null): string => (id === null ? 'Choose a server' : `Set up VM ${id}`);
