// Under the wait for LNVPS to confirm the server (the install's step host-key): the offer to be told when it is
// over, so the person can leave the app. On a phone whose module can post the notice (Android), a button asks for
// Android 13's notification permission and starts the background watch (onboarding/keyWatchTask.ts); elsewhere,
// and when notifications are off, it says to come back in about an hour. onboarding/keyWatch.ts words it.
import { useEffect, useState } from 'react';
import { keyWaitNotifyView, setupNotices, type KeyWaitNotify as Notify } from '../onboarding/keyWatch';
import { armKeyWatch, keyWatchArmed } from '../onboarding/keyWatchTask';
import { useServices } from '../services/services';
import { Body, Button } from './ui';

export function KeyWaitNotify() {
  const sv = useServices();
  const notices = setupNotices(sv.native);
  const supported = notices !== null;
  const [n, setN] = useState<Notify>(supported ? { kind: 'offer' } : { kind: 'unsupported' });
  // A watch started before (the app closed and opened again) still runs while notifications may show.
  useEffect(() => {
    if (!supported) return;
    let live = true;
    keyWatchArmed().then(
      (armed) => live && armed && setupNotices(sv.native)!.notificationsAllowed() && setN({ kind: 'armed' }),
      () => {},
    );
    return () => void (live = false);
  }, [sv, supported]);

  const press = async () => {
    if (!notices) return;
    setN({ kind: 'asking' });
    try {
      if (!(await notices.requestNotifications())) return setN({ kind: 'refused' });
      const phrase = await sv.phrase.get();
      if (!phrase) throw new Error('this phone has no recovery phrase');
      await armKeyWatch(sv.keys(phrase).nostrPrivateKey);
      setN({ kind: 'armed' });
    } catch (e) {
      setN({ kind: 'failed', why: e instanceof Error ? e.message : String(e) });
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
