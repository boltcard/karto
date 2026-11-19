// Under the wait for LNVPS to confirm the server (the install's step host-key, or a rebuild's boot in place on the
// old server's own VM): being told when it is over, so the person can leave the app. On a phone whose module can post the notice (Android), the background watch
// (onboarding/keyWatchTask.ts) starts by itself where notifications are allowed already; otherwise a button asks for
// Android 13's notification permission first. Elsewhere, and when notifications stay off, it says to come back in about
// an hour. onboarding/keyWatch.ts words it.
import { useEffect, useState } from 'react';
import { keyWaitNotifyView, setupNotices, type KeyWaitNotify as Notify } from '../onboarding/keyWatch';
import { armKeyWatch, keyWatchArmed } from '../onboarding/keyWatchTask';
import { useServices, type Services } from '../services/services';
import { Body, Button } from './ui';

/** Starts the watch, signing LNVPS requests with the phrase's Nostr key, unless it runs already. */
async function arm(sv: Pick<Services, 'phrase' | 'keys'>): Promise<void> {
  if (await keyWatchArmed()) return;
  const phrase = await sv.phrase.get();
  if (!phrase) throw new Error('this phone has no recovery phrase');
  await armKeyWatch(sv.keys(phrase).nostrPrivateKey);
}

const failed = (e: unknown): Notify => ({ kind: 'failed', why: e instanceof Error ? e.message : String(e) });

export function KeyWaitNotify() {
  const sv = useServices();
  const supported = setupNotices(sv.native) !== null;
  const [n, setN] = useState<Notify>(supported ? { kind: 'asking' } : { kind: 'unsupported' });
  // Notifications allowed already: the watch starts (or runs on, after the app was closed) with no press.
  useEffect(() => {
    const notices = setupNotices(sv.native);
    if (!notices) return;
    let live = true;
    const set = (x: Notify) => live && setN(x);
    if (!notices.notificationsAllowed()) set({ kind: 'offer' });
    else arm(sv).then(() => set({ kind: 'armed' }), (e) => set(failed(e)));
    return () => void (live = false);
    // Once for the phone's module: sv itself is the same object throughout the app's run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sv.native]);

  const press = async () => {
    const notices = setupNotices(sv.native);
    if (!notices) return;
    setN({ kind: 'asking' });
    try {
      if (!(await notices.requestNotifications())) return setN({ kind: 'refused' });
      await arm(sv);
      setN({ kind: 'armed' });
    } catch (e) {
      setN(failed(e));
    }
  };

  const view = keyWaitNotifyView(n);
  return (
    <>
      <Body muted>{view.line}</Body>
      {view.button && <Button title={view.button} kind="secondary" onPress={() => void press()} />}
    </>
  );
}
