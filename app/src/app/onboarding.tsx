// Steps 3–8, one at a time, driven by
// OnboardingRunner; for a new phone with no server left, a rebuild's. It ends on the ready page.
import { useKeepAwake } from 'expo-keep-awake';
import { useOnboardingRunner, useRouteGuard } from '../services/services';
import { SetupDone } from '../ui/SetupDone';
import { SetupSteps } from '../ui/SetupSteps';
import { ErrorText, Screen } from '../ui/ui';

/** The install runs for minutes over SSH: the screen lock mustn't cut it short. */
function KeepAwake() {
  useKeepAwake();
  return null;
}

export default function Onboarding() {
  const allowed = useRouteGuard('/onboarding');
  const { runner, state: s, error, upload } = useOnboardingRunner(allowed);
  const title = s?.rebuild ? 'Rebuilding your server' : 'Setting up your server';

  // The runner couldn't start (the phone's store or its key): its reason, under the screen's band.
  if (error) return <Screen title={title}><ErrorText>{error}</ErrorText></Screen>;
  if (s?.step === 'done') return <SetupDone s={s} title={title} />;
  if (!s || !runner) return <Screen busy />;
  return (
    <Screen title={title}>
      {/* Not through the wait for LNVPS to confirm the server, usually minutes but up to an hour, which the app may be left for. */}
      {s.waiting !== 'host_key_confirm' && <KeepAwake />}
      <SetupSteps s={s} runner={runner} upload={upload} />
    </Screen>
  );
}
