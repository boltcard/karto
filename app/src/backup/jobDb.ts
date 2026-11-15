// How the background backup job opens the app's database (backup/task.ts), kept apart so the phone diagnostics'
// connection probe (diagnostics/connectionProbe.ts, make phone-connection-probe) opens it exactly as the job does.
//
// A connection of its own. Opened the plain way, inside the running app expo-sqlite hands the job the
// app's own native connection under a second handle; on Android, releasing that handle (the job's, once the
// JavaScript engine collects it) closes the native binding both share, and every later read of the app's fails
// with "NativeDatabase.prepareAsync … NullPointerException" until the app is stopped. The same in the other order:
// a job started by Android before the app would hand the app its connection. With useNewConnection neither open
// matches the other in expo-sqlite's cache, so closing or freeing the job's touches nothing of the app's.
import * as SQLite from 'expo-sqlite';

export function openJobDb(): Promise<SQLite.SQLiteDatabase> {
  return SQLite.openDatabaseAsync('card-app.db', { useNewConnection: true });
}
