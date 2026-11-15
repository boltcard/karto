// The phone diagnostics' connection check (make phone-connection-probe): does the backup job's open of
// card-app.db leave the app's own connection alive? Each round opens the database as the job does and closes it,
// then releases the handle's native object as the JavaScript engine does when it collects the handle: Expo's
// SharedObject release() calls the same releaser that the object's native state calls when Hermes destroys it
// (expo-modules-core common/cpp/SharedObject.cpp), so the round does not wait on when a full collection comes.
// Then it reads through the app's own store. With the job's open made the plain way, that read failed with
// "NativeDatabase.prepareAsync … NullPointerException" from then on, until the app was stopped.
import type { CheckResult } from './checks';

/** What the probe needs of the job's handle: expo-sqlite's SQLiteDatabase and its shared native object. */
export type JobHandle = { closeAsync(): Promise<void>; nativeDatabase: { release(): void } };

export type ConnectionProbeDeps = {
  /** A read through the app's own connection (the services' store). */
  read(): Promise<unknown>;
  /** The job's open (backup/jobDb.ts); the probe closes and releases what it gets. */
  openJob(): Promise<JobHandle>;
  /**
   * Last, Try again's way back: an open the plain way (as the job's once was), closed and released,
   * which kills the app's connection on Android; then the store's reconnect (AppStore.reconnect with reopenAppDb).
   */
  recover?: { openShared(): Promise<JobHandle>; reconnect(): Promise<boolean> };
};

export async function probeConnection(d: ConnectionProbeDeps, rounds: number): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const read = async (name: string): Promise<boolean> => {
    try {
      await d.read();
      out.push({ name, ok: true, detail: "the app's connection reads" });
      return true;
    } catch (e) {
      out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  if (!(await read('before'))) return out;
  for (let i = 1; i <= rounds; i++) {
    try {
      const db = await d.openJob();
      await db.closeAsync();
      db.nativeDatabase.release();
    } catch (e) {
      out.push({ name: `round ${i}`, ok: false, detail: `the job's open, close or release failed: ${e instanceof Error ? e.message : String(e)}` });
      return out;
    }
    if (!(await read(`round ${i}`))) return out;
  }
  if (!d.recover) return out;
  try {
    const shared = await d.recover.openShared();
    await shared.closeAsync();
    shared.nativeDatabase.release();
  } catch (e) {
    out.push({ name: 'killed', ok: false, detail: `the shared open, close or release failed: ${e instanceof Error ? e.message : String(e)}` });
    return out;
  }
  // Only a connection that died here shows the way back works: one the shared open left reading proves nothing.
  try {
    await d.read();
    out.push({ name: 'killed', ok: false, detail: 'the shared open left it reading, so the way back was not tried' });
    return out;
  } catch (e) {
    out.push({ name: 'killed', ok: true, detail: e instanceof Error ? e.message : String(e) });
  }
  let replaced: boolean;
  try {
    replaced = await d.recover.reconnect();
  } catch (e) {
    out.push({ name: 'reconnected', ok: false, detail: e instanceof Error ? e.message : String(e) });
    return out;
  }
  out.push({ name: 'reconnected', ok: true, detail: replaced ? 'a new connection' : 'the old one still answered' });
  await read('after reconnect');
  return out;
}
