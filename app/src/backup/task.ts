// The background backup job: about hourly through
// expo-background-task (Android's WorkManager; Doze and battery limits can
// hold it back), it fetches the server's latest snapshot, signing with the
// device key alone, and notes it, and whether cardd answered at all, for a
// rebuild; it never reads the phrase. Imported by index.ts, as
// TaskManager.defineTask must run when the JS bundle loads.
import * as BackgroundTask from 'expo-background-task';
import type * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import CardNative from '../../modules/card-native';
import { CarddClient } from '../cardd/client';
import { withDownloadTimeout, withTimeout } from '../lightning/lightning';
import { deviceKey } from '../native/deviceKey';
import { rebuildKeeps } from '../onboarding/rebuild';
import { walletEpoch } from '../services/walletEpoch';
import { AppStore, STORE_WRITES } from '../store/store';
import { backupJob, FILE_WRITES } from './backups';
import { openJobDb } from './jobDb';
import { phoneFiles } from './files';
import { jobLine, type JobEnd } from './jobLog';

export const BACKUP_TASK = 'card-app-backups';

const log = (end: JobEnd) => console.log('CARDAPP-JOB', jobLine(end));

TaskManager.defineTask(BACKUP_TASK, async () => {
  let db: SQLite.SQLiteDatabase | null = null;
  try {
    db = await openJobDb();
    // A connection of its own (jobDb.ts). Run inside the running app, the job still writes through the
    // wallet's epoch as the app's own work does: a wallet taken off the phone while the job is fetching gets no
    // note and no snapshot written after it (services/walletEpoch.ts).
    const store = walletEpoch.bind(await AppStore.open(db), STORE_WRITES);
    const [state, recipient] = await Promise.all([store.onboarding(), store.backupRecipient()]);
    if (!state?.host || state.step !== 'done' || !recipient || (await store.revoked())) {
      log({ ended: 'idle' });
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    const fetch40 = withTimeout((url, init) => fetch(url, init), 40_000);
    const cardd = new CarddClient({
      fetch: fetch40,
      slowFetch: fetch40,
      download: withDownloadTimeout((url, init) => fetch(url, init), 300_000),
      host: state.host.hostname,
      key: deviceKey(CardNative),
    });
    const result = await backupJob({
      cardd,
      files: walletEpoch.bind(phoneFiles(), FILE_WRITES),
      recipient,
      noteLatest: (l) => store.saveServerLatest(l),
      keep: rebuildKeeps(state),
      noteAnswered: (answered) => store.noteCarddAnswered(answered, Date.now()),
      onRevoked: async () => {
        await store.setRevoked(true);
        await BackgroundTask.unregisterTaskAsync(BACKUP_TASK);
      },
    });
    log({ ended: 'done', kind: result.kind });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    log({ ended: 'failed', error });
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    await db?.closeAsync().catch(() => {});
  }
});

/** Asks Android to run the job about hourly (60 minutes; 15 is its least). */
export async function registerBackupTask(): Promise<void> {
  if (!(await TaskManager.isTaskRegisteredAsync(BACKUP_TASK))) await BackgroundTask.registerTaskAsync(BACKUP_TASK, { minimumInterval: 60 });
}

export async function unregisterBackupTask(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(BACKUP_TASK)) await BackgroundTask.unregisterTaskAsync(BACKUP_TASK);
}
