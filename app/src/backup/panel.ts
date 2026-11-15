// Settings' backups: the
// server page's BackupsPanel load, moved out for ServerWatch, doing what it
// did. Each check fetches the latest snapshot, then checks it with the phrase;
// it also keeps the phrase's backup recipient for the background job and
// registers it, and notes the server's latest snapshot for a rebuild. The
// files, SQLite and the background job are injected, so it runs in node.
import type { CarddClient } from '../cardd/client';
import type { DerivedKeys } from '../keys/derive';
import { serversOfThisPhrase, type OnboardingState } from '../onboarding/machine';
import { rebuildKeeps } from '../onboarding/rebuild';
import type { AppStore } from '../store/store';
import { backupView, capReason, foregroundBackups, type BackupFiles } from './backups';

/** What Settings › Backups shows, and the wallet's banners read. */
export type BackupsView = {
  /** The last fetch, how many are kept, the last check-in. */
  lines: string[];
  warnings: string[];
  /** Another phone's restore unpaired this one: Export backups stays on offer. */
  revoked: boolean;
  /** The check itself failed. */
  failure: string | null;
  /** The server couldn't be reached: the lines are what this phone keeps. */
  unreachable: boolean;
  /** A server from before backups: Update server fixes it. */
  noApi: boolean;
  /** The last fetch (unix seconds), for the Settings row; null before the first. */
  lastFetch: number | null;
  /** The first check is still running: the row and the page say Checking…. */
  checking: boolean;
};

export const NO_BACKUPS: BackupsView = { lines: [], warnings: [], revoked: false, failure: null, unreachable: false, noApi: false, lastFetch: null, checking: false };

export type BackupsDeps = {
  store: Pick<AppStore, 'revoked' | 'setRevoked' | 'saveBackupRecipient' | 'saveServerLatest'>;
  /** files.ts phoneFiles(). */
  files: BackupFiles;
  /** files.ts openSnapshot: a decrypted snapshot's VM id. */
  openDb: (plain: Uint8Array) => Promise<string | null>;
  /** task.ts registerBackupTask and unregisterBackupTask. */
  registerTask(): Promise<void>;
  unregisterTask(): Promise<void>;
  now(): number;
};

/**
 * One check of the backups. show gets each change to the view: what the
 * phone keeps, at once (checking can take seconds), then the fetch's and the
 * check's. A phone another phone's restore unpaired stops at once; a check
 * that throws shows why. The caller runs one at a time: two must not fetch
 * and write the same snapshot together.
 */
export async function loadBackups(
  d: BackupsDeps,
  o: { state: OnboardingState; keys: Pick<DerivedKeys, 'backupAgeRecipient' | 'backupAgeIdentity'>; cardd: Pick<CarddClient, 'backups' | 'backupFile'> },
  show: (patch: Partial<BackupsView>) => void,
): Promise<void> {
  try {
    if (await d.store.revoked()) return show({ revoked: true, checking: false });
    const { state, keys } = o;
    if (!state.vmId) return;
    await d.store.saveBackupRecipient(keys.backupAgeRecipient);
    await d.registerTask().catch(() => {});
    show({ ...backupView(null, await d.files.list(), keys.backupAgeRecipient, d.now() / 1000), checking: true });
    const r = await foregroundBackups({
      cardd: o.cardd, files: d.files, recipient: keys.backupAgeRecipient, identity: keys.backupAgeIdentity, vmIds: serversOfThisPhrase(state), openDb: d.openDb,
      now: d.now,
      noteLatest: (l) => d.store.saveServerLatest(l),
      keep: rebuildKeeps(state),
      onRevoked: async () => {
        await d.store.setRevoked(true);
        await d.unregisterTask().catch(() => {});
      },
    });
    if (r.result.kind === 'revoked') return show({ revoked: true, checking: false });
    const nowS = d.now() / 1000;
    const v = backupView(r.status, r.kept, keys.backupAgeRecipient, nowS, undefined, r.result.kind === 'fetched' ? nowS : undefined);
    if (r.result.kind === 'bad_download' || r.result.kind === 'failed') v.warnings.push(`Couldn't fetch the latest backup: ${capReason(r.result.reason)}.`);
    show({ ...v, unreachable: r.result.kind === 'unreachable', noApi: r.result.kind === 'no_backups_api', failure: null, checking: false });
  } catch (e) {
    show({ failure: `Couldn't check backups: ${capReason(e instanceof Error ? e.message : String(e))}.`, checking: false });
  }
}
