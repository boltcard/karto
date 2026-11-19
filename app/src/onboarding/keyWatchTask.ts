// The watch over the wait for LNVPS (keyWatch.ts), on the phone: a background task through expo-background-task
// (Android's WorkManager, at most every 15 minutes, and only while the app is in the background), which reads the
// saved onboarding state and the watch's record, asks LNVPS, and posts its answer through the app's own notification
// module. Android only: an iPhone's module posts no notification yet, so nothing is registered there. Imported by
// services/start.ts, as TaskManager.defineTask must run when the JS bundle loads.
import * as BackgroundTask from 'expo-background-task';
import * as SecureStore from 'expo-secure-store';
import type * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import CardNative from '../../modules/card-native';
import { openJobDb } from '../backup/jobDb';
import { BACKUP_TASK, registerBackupTask, unregisterBackupTask } from '../backup/task';
import { withTimeout } from '../lightning/lightning';
import { LnvpsClient } from '../lnvps/client';
import { AppStore } from '../store/store';
import { KEY_WATCH_MINUTES, KEY_WATCH_TASK, keyWatchRecord, runKeyWatch, setupNotices, waitsForHostKey, type KeyWatchOutcome } from './keyWatch';
import type { OnboardingState } from './machine';

const record = keyWatchRecord(SecureStore);

const log = (o: { ended: KeyWatchOutcome | 'failed'; error?: unknown }) =>
  console.log('CARDAPP-KEYWATCH', JSON.stringify({ ended: o.ended, ...(o.error !== undefined && { error: o.error instanceof Error ? o.error.message : String(o.error) }) }));

TaskManager.defineTask(KEY_WATCH_TASK, async () => {
  let db: SQLite.SQLiteDatabase | null = null;
  try {
    db = await openJobDb();
    // Read only: the running app's runner saves the onboarding state, and the watch never writes to it.
    const store = await AppStore.open(db);
    const fetch40 = withTimeout((url, init) => fetch(url, init), 40_000);
    const ended = await runKeyWatch({
      state: () => store.onboarding(),
      lnvps: async () => {
        const key = await record.get();
        return key ? new LnvpsClient({ fetch: fetch40, nostrSecretKey: key }) : null;
      },
      notify: (n) => CardNative.postSetupNotice?.(n.tag, n.title, n.text),
      // The backup job gets its hour back once the app is in front (backupHourAgain): not from inside the worker's run.
      end: async () => {
        if (await endKeyWatch()) await record.noteEnded();
      },
    });
    log({ ended });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    log({ ended: 'failed', error });
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    await db?.closeAsync().catch(() => {});
  }
});

/** Whether the watch runs (its task is registered). */
export const keyWatchArmed = (): Promise<boolean> => TaskManager.isTaskRegisteredAsync(KEY_WATCH_TASK);

/**
 * Starts the watch: the record (the Nostr key LNVPS requests are signed with), then the task. The task shares
 * expo-background-task's one worker with the backup job, whose interval becomes the watch's 15 minutes while it runs
 * (the backup job does nothing while a setup runs); settleKeyWatch gives the backup job its hour back.
 */
export async function armKeyWatch(nostrSecretKey: string): Promise<void> {
  if (!setupNotices(CardNative)) throw new Error("this phone can't post notifications from the background");
  await record.set(nostrSecretKey);
  if (!(await keyWatchArmed())) await BackgroundTask.registerTaskAsync(KEY_WATCH_TASK, { minimumInterval: KEY_WATCH_MINUTES });
  armedHere = true;
}

/** Ends the watch: the task, then the record. Safe to repeat. Returns whether the task was registered. */
export async function endKeyWatch(): Promise<boolean> {
  const armed = await keyWatchArmed();
  if (armed) await BackgroundTask.unregisterTaskAsync(KEY_WATCH_TASK);
  await record.remove();
  return armed;
}

/**
 * The shared worker keeps the last interval a task was registered with, the watch's 15 minutes, until the app's
 * process ends (on the next start each task registers again with its own). A backup job registered now is
 * registered afresh, which sets its hour again. Only with the app in front: inside the worker's own run, dropping
 * the last task would cancel that run. Re-registering a task that is registered changes only its options.
 */
async function backupHourAgain(): Promise<void> {
  if (!(await TaskManager.isTaskRegisteredAsync(BACKUP_TASK))) return;
  await unregisterBackupTask();
  await registerBackupTask();
}

// Once a state past the wait is seen, the watch is ended: on the first state of each run of the app (a watch left
// from before), then after any state in which this run started it.
let settled = false;
let armedHere = false;

/** For each state the onboarding runner hands the screen: ends the watch once the setup no longer waits for LNVPS. */
export function settleKeyWatch(s: OnboardingState): void {
  if (waitsForHostKey(s) || (settled && !armedHere)) return;
  settled = true;
  armedHere = false;
  (async () => {
    const ended = await endKeyWatch();
    // Its own end in the background left a mark (record.noteEnded): taken whichever way, so it doesn't stay.
    if ((await record.takeEnded()) || ended) await backupHourAgain();
  })().catch((error) => log({ ended: 'failed', error }));
}
