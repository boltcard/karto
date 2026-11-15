// Steps 3–8, one at a time, driven by
// OnboardingRunner; for a new phone with no server left, a rebuild's. It ends on the ready page.
import { useKeepAwake } from 'expo-keep-awake';
import { useOnboardingRunner, useRouteGuard } from '../services/services';
import { SetupDone } from '../ui/SetupDone';
import { SetupSteps } from '../ui/SetupSteps';
import { ErrorText, Screen } from '../ui/ui';

export default function Onboarding() {
  useKeepAwake(); // the install runs for minutes over SSH; don't let the screen lock cut it short
  const allowed = useRouteGuard('/onboarding');
  const { runner, state: s, error, upload } = useOnboardingRunner(allowed);
  const title = s?.rebuild ? 'Rebuilding your server' : 'Setting up your server';

  // The runner couldn't start (the phone's store or its key): its reason, under the screen's band.
  if (error) return <Screen title={title}><ErrorText>{error}</ErrorText></Screen>;
  if (s?.step === 'done') return <SetupDone s={s} title={title} />;
  if (!s || !runner) return <Screen busy />;
  return (
    <Screen title={title}>
      <SetupSteps s={s} runner={runner} upload={upload} />
    </Screen>
  );
}
