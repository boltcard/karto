// The card camera's choices,
// apart from React so they are tested: what the hint says, what Back does,
// what the check view says, and a shot turned into the next state. (The NFC
// claim that closes every tap while the camera is open is cards/nfcSlot.ts's holdTaps.)
import type { ShotSource } from '../native/cardCamera';
import { themeFor } from '../ui/theme';
import { shotError, thumbnailProblem } from './take';

export type CameraState =
  /** The preview; error: why the last shot failed, shown in place of the hint until the next. */
  | { kind: 'looking'; error: string | null }
  | { kind: 'taking' }
  | { kind: 'check'; jpeg: string; source: ShotSource }
  /** The camera couldn't start. */
  | { kind: 'broken'; reason: string };

export const LOOKING: CameraState = { kind: 'looking', error: null };

/**
 * The check view's Use photo: the theme's orange button. The
 * camera is dark whatever the phone's mode, and the two sets give these two the same values.
 */
export function photoColours(): { fill: string; text: string } {
  const t = themeFor('dark');
  return { fill: t.accent, text: t.onAccent };
}

/** The two lines over the preview; found: the card's edges are outlined; name: the card being photographed, which the first line names while it looks (the person held several cards and the screen didn't say which). */
export function hint(s: CameraState, found: boolean, name = ''): { title: string; detail: string } {
  if (s.kind === 'broken') return { title: `The camera couldn't start: ${s.reason}`, detail: '' };
  if (s.kind === 'taking') return { title: 'Taking the photo…', detail: '' };
  if (s.kind === 'looking' && s.error) return { title: s.error, detail: '' };
  if (found) return { title: 'Card found', detail: 'Press the button' };
  return { title: `Hold ${name || 'the card'} inside the frame`, detail: 'Fill the frame with it, on a plain surface lighter or darker than the card, in good light' };
}

/** The check view's second line. */
export const checkLine = (source: ShotSource): string =>
  source === 'frame' ? "No card edges were found: this is the frame's area." : 'This is how the card will look in your wallet.';

/** Android's Back: Retake on the check view, nothing while the shot is made, else Cancel. */
export const backDoes = (s: CameraState): 'cancel' | 'retake' | 'nothing' => (s.kind === 'check' ? 'retake' : s.kind === 'taking' ? 'nothing' : 'cancel');

/** The shutter: the shot's thumbnail to check, or the camera again with the reason it failed (none when the camera closed under it). */
export async function shoot(take: () => Promise<{ jpeg: string; source: ShotSource }>): Promise<CameraState> {
  try {
    const shot = await take();
    const problem = thumbnailProblem(shot.jpeg);
    return problem ? { kind: 'looking', error: problem } : { kind: 'check', jpeg: shot.jpeg, source: shot.source };
  } catch (e) {
    return { kind: 'looking', error: shotError(e) };
  }
}

/** The shutter pressed again while its shot is being made (a quick double tap) does nothing: one press, one shot. */
export function oneShot<T>(fn: () => Promise<T>): () => Promise<T | null> {
  let running = false;
  return async () => {
    if (running) return null;
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
}
