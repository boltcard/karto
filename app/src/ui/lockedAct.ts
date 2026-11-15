// An act on the wallet a phone keeps, behind the lock: carrying a found wallet on, pairing the phone again, taking
// the wallet off the phone.
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { screenLock } from './lock';

/**
 * To where the app starts, with nothing under it: the pages a screen was opened over showed a wallet that is no
 * longer this phone's to show.
 */
export const toStart = () => {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
};

/**
 * press: the lock, the act, then the start. One at a time: a double tap asks for the lock once. busy: the act is running. error: the lock's refusal, or what failed() says of the act's failure.
 * stopped: the act itself failed, so it may have run part-way.
 */
export function useLockedAct(o: { lock: { prompt: string; needs: string }; act(): Promise<void>; failed(e: unknown): string }): {
  press(): void; busy: boolean; error: string | null; stopped: boolean;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  // Set before the first await.
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      const why = await screenLock(o.lock.prompt, o.lock.needs);
      if (why) return setError(why);
      setBusy(true);
      try {
        await o.act();
      } catch (e) {
        setStopped(true);
        setBusy(false);
        return setError(o.failed(e));
      }
      // Still busy: the screen is on its way out.
      toStart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
    }
  };
  return { press: () => void run(), busy, error, stopped };
}
