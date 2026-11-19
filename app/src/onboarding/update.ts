// "Update server": the app carries the server it installs (deploy/ and cardd
// in the APK), so a new app version can bring a new server. Updating re-runs
// every install step with this app's bundle; each step is safe to repeat,
// phoenixd's seed and the issuer key are never replaced, and `up` only
// recreates containers whose image changed (deploy/README.md). An update cut
// by a dropped connection is run again with the steps it had finished (done).
import type { DerivedKeys } from '../keys/derive';
import { install, type BundleFile, type InstallStep, type UploadProgress } from './install';
import { connectToServer, installOptions, type OnboardingState } from './machine';
import type { SshConnect } from './ssh';

export async function updateServer(
  s: OnboardingState,
  d: { ssh: SshConnect; keys: DerivedKeys; bundle: BundleFile[] },
  onStep: (step: InstallStep) => void,
  onUpload?: (p: UploadProgress) => void,
  done: readonly InstallStep[] = [],
  onStart?: (step: InstallStep) => void,
): Promise<void> {
  // The seed and the issuer key go again (install.sh keeps the ones there), only over the key pinned for this server
  // (connectToServer): a finished setup's key is LNVPS's, as onboarding sends no secret before LNVPS confirms it
  // (host-key). An older wallet's key may still be one trusted on first use, but its server had both from its first
  // install over that same key, so nothing goes anywhere it hadn't gone. A key LNVPS contradicted is refused there.
  const session = await connectToServer(s, d.ssh, d.keys);
  try {
    await install(session, { ...installOptions(s, d.keys, d.bundle), done, onStep: async (step) => onStep(step), onUpload, onStart });
  } finally {
    await session.close().catch(() => {}); // the work is done or has failed; a failed close changes neither
  }
}
