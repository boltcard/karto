// What the app calls the phone's lock. Android has a
// "screen lock". An iPhone has no such name: it asks for Face ID or Touch ID with the passcode behind it, or for
// the passcode alone, and the app says which, from what is set up on the phone. Apart from ui/lock.ts, which asks
// the phone, so these words are tested.

export type LockKind = 'screen-lock' | 'face' | 'touch' | 'passcode';

/** ios: the phone is an iPhone. biometric: Face ID or Touch ID is set up on it. face: the phone's kind is Face ID. */
export function lockKind(o: { ios: boolean; biometric: boolean; face: boolean }): LockKind {
  if (!o.ios) return 'screen-lock';
  return !o.biometric ? 'passcode' : o.face ? 'face' : 'touch';
}

const NAMES: Record<LockKind, string> = {
  'screen-lock': 'your screen lock',
  face: 'Face ID or your passcode',
  touch: 'Touch ID or your passcode',
  passcode: 'your passcode',
};

/** As it reads after "needs": "Wiping needs Face ID or your passcode, then …". */
export const lockName = (k: LockKind): string => NAMES[k];

/** No lock is set on the phone. needs: what needs it ("rebuilding the server"). */
export const lockMissing = (k: LockKind, needs: string): string => `Set a ${k === 'screen-lock' ? 'screen lock' : 'passcode'} on this phone first: ${needs} needs it.`;

export const lockNotConfirmed = (k: LockKind): string =>
  k === 'screen-lock' ? 'The screen lock was not confirmed.' : `${NAMES[k][0].toUpperCase()}${NAMES[k].slice(1)} was not confirmed.`;
