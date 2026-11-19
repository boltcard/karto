// Rebuild server: behind the screen lock, then its
// steps one at a time, driven by the onboarding runner, as onboarding is.
// A rebuild started here carries on here when the app is opened again.
import { useKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { startRebuild, type OnboardingState } from '../onboarding/machine';
import { canCancel, cancelFromScreen, keepsAwake } from '../onboarding/rebuild';
import { useOnboardingRunner, useRouteGuard, useServices } from '../services/services';
import { screenLock, useLockKind } from '../ui/lock';
import { lockName } from '../ui/lockName';
import { SetupDone } from '../ui/SetupDone';
import { SetupSteps } from '../ui/SetupSteps';
import { Body, Button, Callout, ErrorText, Screen } from '../ui/ui';

/** From the server page's finished setup; a rebuild in progress carries on as it is. */
const begin = (s: OnboardingState) => (s.step === 'done' ? startRebuild(s, 'server_page') : s);

/** Retiring, the install and pairing run for minutes over SSH: the screen lock mustn't cut them short. */
function KeepAwake() {
  useKeepAwake();
  return null;
}

export default function Rebuild() {
  const allowed = useRouteGuard('/rebuild');
  const sv = useServices();
  const [saved, setSaved] = useState<OnboardingState | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const lock = useLockKind();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Cancel rebuild: leaving for the wallet, or failed, its change not saved (the message says why). */
  const [cancelled, setCancelled] = useState<'no' | 'leaving' | 'failed'>('no');
  useEffect(() => {
    if (allowed) sv.store.onboarding().then(setSaved);
  }, [sv, allowed]);
  // A tap here would be checked against the old server's deps: close it unread.
  useFocusEffect(useCallback(() => sv.nfcSlot.claim((t) => void t.close()), [sv]));
  const inProgress = !!saved && saved.step !== 'done';
  const { runner, state: s, error, upload } = useOnboardingRunner(allowed && unlocked && (inProgress || confirmed), begin);

  // Before step 4 and before a VM is paid for, the server page goes back as it was.
  // The cancelled state's step is done, as the finished setup it puts back: that is not a rebuild that ended, so the
  // screen is marked as leaving before the state changes (the runner shows the state before it is saved), and no
  // ready page is drawn. Then to the wallet, as before (Settings cut the stack when it opened this screen).
  const cancel = async () => {
    if (!runner || !s) return;
    setMessage(null);
    const result = await cancelFromScreen(s, { lnvps: runner.deps.lnvps, leaving: () => setCancelled('leaving'), update: (f) => runner.update(f) });
    if (result.left) return router.replace('/home');
    setMessage(result.message);
    // Not saved after all: the state in hand is the cancelled one, which must not be drawn as a finished rebuild.
    if (result.afterLeaving) setCancelled('failed');
  };

  // The screen lock is required for Rebuild server.
  const unlock = async () => {
    const why = await screenLock('Rebuild server', 'rebuilding the server');
    setMessage(why);
    if (!why) setUnlocked(true);
  };

  if (!allowed || !saved) return <Screen busy />;
  if (!unlocked) {
    return (
      // The arrow goes back to where the person came from; a rebuild in progress has none (it had no Cancel either).
      <Screen title="Rebuild server" back={!inProgress}>
        <Body>Rebuilding the server needs {lockName(lock)}.</Body>
        <Button title="Unlock to rebuild" onPress={unlock} />
        {message && <ErrorText>{message}</ErrorText>}
      </Screen>
    );
  }
  if (!inProgress && !confirmed) {
    return (
      <Screen title="Rebuild server" back>
        <Body>
          This sets your server up again from a backup, on a new VM or in place on a paid one, after retiring the old server so that two
          Lightning wallets never run on one seed.
        </Body>
        {/* What the rebuild costs the person, set apart. */}
        <Callout>
          <Body>
            The old server keeps running while a new server is prepared and waits for LNVPS to confirm it, which usually takes a few
            minutes, sometimes up to an hour. Then the old server is retired, and cards can&apos;t pay for the few minutes the rest of
            the install takes. Rebuilt in place on the old server&apos;s own VM, it stops at the start. Each card then needs a tap to
            point it at the new server.
          </Body>
        </Callout>
        <Button title="Rebuild server" onPress={() => setConfirmed(true)} />
      </Screen>
    );
  }
  // The runner couldn't start (the phone's store or its key): its reason, under the screen's band.
  if (error) return <Screen title="Rebuilding your server"><ErrorText>{error}</ErrorText></Screen>;
  if (cancelled === 'leaving') return <Screen busy />;
  // The cancel couldn't be saved: its reason, and nothing else. Opened again, the app carries on from what is saved.
  if (cancelled === 'failed') return <Screen title="Rebuilding your server"><ErrorText>{message}</ErrorText></Screen>;
  if (s?.step === 'done') return <SetupDone s={s} title="Rebuilding your server" />;
  if (!s || !runner) return <Screen busy />;
  return (
    <Screen title="Rebuilding your server">
      {keepsAwake(s) && <KeepAwake />}
      <SetupSteps s={s} runner={runner} upload={upload}>
        {canCancel(s) && <Button title="Cancel rebuild" kind="secondary" onPress={cancel} />}
        {message && <ErrorText>{message}</ErrorText>}
      </SetupSteps>
    </Screen>
  );
}
