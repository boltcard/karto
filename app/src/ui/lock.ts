// The screen lock before an act that needs it. What the lock is called is ui/lockName.ts's.
import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { lockKind, lockMissing, lockNotConfirmed, type LockKind } from './lockName';

const ios = Platform.OS === 'ios';

/** Which lock this phone will ask for: from what is set up on it, not from what it has. */
async function kindNow(): Promise<LockKind> {
  if (!ios) return 'screen-lock';
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  const biometric = level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK || level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
  const face = (await LocalAuthentication.supportedAuthenticationTypesAsync()).includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  return lockKind({ ios, biometric, face });
}

/** The lock's kind for a screen's words: the passcode on an iPhone until the phone has answered. */
export function useLockKind(): LockKind {
  const [kind, setKind] = useState<LockKind>(ios ? 'passcode' : 'screen-lock');
  useEffect(() => {
    let gone = false;
    kindNow().then((k) => !gone && setKind(k), () => {});
    return () => {
      gone = true;
    };
  }, []);
  return kind;
}

/** Asks for the screen lock: null once confirmed, else what to tell the person. needs: what needs it ("rebuilding the server"). */
export async function screenLock(promptMessage: string, needs: string): Promise<string | null> {
  if ((await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE) return lockMissing(ios ? 'passcode' : 'screen-lock', needs);
  const kind = await kindNow();
  const r = await LocalAuthentication.authenticateAsync({ promptMessage });
  return r.success ? null : lockNotConfirmed(kind);
}
