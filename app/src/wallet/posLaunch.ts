// "Karto PoS is on this phone": Karto Wallet hands a kartopos:// link to Karto PoS on the same
// phone. A pairing link carries the code, and a bare kartopos:// link is any app's to claim, so Karto PoS is
// started by name: its package and its activity. And a package name is anyone's to take on a phone that has no
// Karto PoS, so the app of that name is first asked of Android: it must be signed with the key this app is signed
// with. The screen passes expo-intent-launcher's startActivityAsync and the card-native module's signedLikeThisApp.

/** expo-intent-launcher's startActivityAsync, as far as this needs it. */
export type StartActivity = (action: string, params: { data: string; packageName: string; className: string; flags: number }) => Promise<unknown>;

/**
 * Who signed another app on this phone, against this app's own signer: 'same', 'other', or 'absent' when no app of
 * that package is installed (or this app's manifest doesn't let it see one: plugins/withPosQuery.js).
 */
export type Signer = (packageName: string) => Promise<'same' | 'other' | 'absent'>;

/**
 * Karto PoS's package and its one activity. Both, always: given the package alone, expo-intent-launcher sets no
 * component and the link would go to whichever app claims the scheme.
 */
export const KARTO_POS = { packageName: 'app.cardapp.pos', className: 'app.cardapp.pos.MainActivity' } as const;

/** Intent.FLAG_ACTIVITY_NEW_TASK: Karto PoS opens as itself, not as a page inside Karto Wallet, and the call ends at once. */
const NEW_TASK = 0x10000000;

export const POS_ON_THIS_PHONE = 'Karto PoS is on this phone';

/**
 * Whether the button is shown: Android's alone. On an iPhone nothing
 * checks which app answers a kartopos:// link, which carries the code, and the module has no signedLikeThisApp.
 */
export const posOnThisPhoneShown = (os: string): boolean => os === 'android';

export type Launched = 'opened' | 'not-installed' | 'not-ours' | 'failed';

/** Android's words, and the launcher's code, for an activity that isn't there. */
const NOT_THERE = /unable to find explicit activity|no activity found|not_?found/i;

/**
 * Starts Karto PoS with a kartopos:// link, once Android says the app of its package is signed as this one is.
 * Nothing else is ever handed over, nothing is started for any other text, and a check that fails is no proof.
 */
export async function openKartoPos(d: { start: StartActivity; signer: Signer }, link: string): Promise<Launched> {
  if (!link.startsWith('kartopos://')) return 'failed';
  try {
    const signed = await d.signer(KARTO_POS.packageName);
    if (signed === 'absent') return 'not-installed';
    if (signed === 'other') return 'not-ours';
    if (signed !== 'same') return 'failed';
  } catch {
    return 'failed';
  }
  try {
    await d.start('android.intent.action.VIEW', { data: link, ...KARTO_POS, flags: NEW_TASK });
    return 'opened';
  } catch (e) {
    const said = e instanceof Error ? `${(e as { code?: unknown }).code ?? ''} ${e.name} ${e.message}` : String(e);
    return NOT_THERE.test(said) ? 'not-installed' : 'failed';
  }
}

/** What the screen says under the button: nothing when Karto PoS opened. */
export function launchLine(l: Launched): string {
  if (l === 'not-installed') return "Karto PoS isn't installed on this phone.";
  if (l === 'not-ours') return "The app on this phone that goes by Karto PoS's name isn't signed as this app is. The code wasn't given to it.";
  return l === 'failed' ? "Karto PoS didn't open." : '';
}
