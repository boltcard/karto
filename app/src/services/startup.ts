// Opening the app's services when it starts. Back destroys Android's screen,
// and opening the app again at once makes a new one in the same process: JS
// carries on and the app mounts afresh. Opening the database again then got
// expo-sqlite's cached connection, which Expo resets as soon as the first
// open's handle is garbage collected; every statement after that failed
// (NativeDatabase.execAsync → NullPointerException) until the app was
// force-stopped. So the services are opened once per JS run (openOnce). A
// failed open is still tried again before the person sees it; then they can
// try again themselves.
import { AppStore, type SqlDb } from '../store/store';

/**
 * Opens with open(), trying again `wait` ms after a failure, up to `tries`
 * times in all; throws the last try's error. log: each failed try (1-based).
 */
export async function openRetrying<T>(
  open: () => Promise<T>,
  o: { tries?: number; wait?: number; log?: (attempt: number, e: unknown) => void } = {},
): Promise<T> {
  const tries = o.tries ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await open();
    } catch (e) {
      o.log?.(attempt, e);
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, o.wait ?? 500));
    }
  }
}

/**
 * open(), run once and shared by every later call; after a failed open, the
 * next call opens afresh.
 */
export function openOnce<T>(open: () => Promise<T>): () => Promise<T> {
  let opened: Promise<T> | null = null;
  return () => {
    opened ??= open().catch((e) => {
      opened = null;
      throw e;
    });
    return opened;
  };
}

/**
 * The store on db; a db whose first statement fails is closed, so the next
 * open gets a new connection rather than expo-sqlite's cached one.
 */
export async function openStore(db: SqlDb & { closeAsync(): Promise<void> }): Promise<AppStore> {
  try {
    return await AppStore.open(db);
  } catch (e) {
    await db.closeAsync().catch(() => {});
    throw e;
  }
}
