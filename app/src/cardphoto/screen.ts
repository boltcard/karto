// The photo screen's decisions, apart
// from React so they are tested: its buttons in each state, where its last
// one goes, the words for a failed save, and saving or removing through
// cardd, then the phone.
import { CarddError, noPhotoRoutes, type CarddClient } from '../cardd/client';
import { isNetworkFailure } from '../lightning/lightning';
import { isGatewayError } from '../money/requests';
import type { ServerWatch } from '../services/serverWatch';
import { settingsPlace } from './take';

/** A card's id, as a cardapp:// link may name one (as /account checks). */
export const validCardId = (id: string | undefined): id is string => /^[0-9a-f]{32}$/.test(id ?? '');

/** The photo screen as Add card's last step, after an add ('add') or after adding a card back ('adopt'); null from More. */
export type PhotoStep = 'add' | 'adopt' | null;
export const photoStep = (step: string | undefined): PhotoStep => (step === 'add' || step === 'adopt' ? step : null);

/** take: open the camera; retry: send the same thumbnail again; finish: leave (to the wallet from the step, back from More). */
export type PhotoButton = { key: 'take' | 'retry' | 'finish'; title: string; kind: 'primary' | 'secondary' };

/**
 * What the photo screen shows around the card's face. band,
 * bar, back: the band's title, whether Add card's step bar stands under it, and whether the band has ←. veil:
 * what it is doing, over the face. panels: what went wrong, each in a red panel. settings: Open settings under
 * them. buttons: in order, the first the main one. remove: the red Remove photo row. off: every button and the
 * row are off, and Back does nothing.
 */
export type PhotoView = { band: string; bar: boolean; back: boolean; veil: string | null; panels: string[]; settings: boolean; buttons: PhotoButton[]; remove: boolean; off: boolean };

/**
 * failed.retry: a save failed and its thumbnail is kept to send again. noCamera.canAskAgain: false when only the
 * phone's settings can allow the camera now. ios: the phone is an iPhone, whose settings are not "Android's".
 */
export function photoView(o: {
  step: PhotoStep; hasPhoto: boolean; busy: 'asking' | 'saving' | 'removing' | null; failed: { text: string; retry: boolean } | null; noCamera: { canAskAgain: boolean } | null;
  ios?: boolean;
}): PhotoView {
  // Skip in Add card's step while the card has no photo; Done otherwise (a card added back keeps its photo).
  const finish = (kind: PhotoButton['kind']): PhotoButton => ({ key: 'finish', title: o.step && !o.hasPhoto ? 'Skip for now' : 'Done', kind });
  const retake: PhotoButton = { key: 'take', title: 'Retake photo', kind: 'secondary' };
  const buttons: PhotoButton[] = o.failed?.retry
    ? [{ key: 'retry', title: 'Try again', kind: 'primary' }, retake, finish('secondary')]
    : o.hasPhoto
      ? [finish('primary'), retake]
      : [{ key: 'take', title: 'Take photo', kind: 'primary' }, finish('secondary')];
  const refused = o.noCamera && (o.noCamera.canAskAgain ? "The camera wasn't allowed, so no photo was taken." : `This app isn't allowed to use the camera. Allow it in ${settingsPlace(!!o.ios)}.`);
  return {
    band: o.step === 'add' ? 'Add a card' : o.step === 'adopt' ? 'Add the card back' : 'Change photo',
    bar: o.step !== null,
    back: o.step === null,
    veil: o.busy === 'saving' ? 'Saving the photo…' : o.busy === 'removing' ? 'Removing the photo…' : null,
    panels: [...(o.failed ? [o.failed.text] : []), ...(refused ? [refused] : [])],
    settings: !!o.noCamera,
    buttons,
    remove: o.hasPhoto,
    off: o.busy !== null,
  };
}

/**
 * Whether the iPhone's swipe from the left edge leaves the screen:
 * exactly where the band has its ← and the screen is not busy, so from More and never from Add card's step;
 * and never while the card camera or its check view is up, where Cancel and Retake are the ways out.
 */
export const photoSwipe = (o: { step: PhotoStep; busy: 'asking' | 'saving' | 'removing' | null; camera: boolean }): boolean => !o.camera && o.step === null && o.busy === null;

/**
 * The add step ends at the wallet, as the card flow did; from More, back to the
 * account page, or to the wallet when a cardapp:// link opened it cold (nothing to go back to).
 */
export const finishTo = (fromAdd: boolean, canGoBack: boolean): 'wallet' | 'back' => (fromAdd || !canGoBack ? 'wallet' : 'back');

/**
 * Why a photo wasn't saved or removed. An older cardd has no photo routes (a
 * plain-text 404); a gateway error (Caddy while cardd restarts) is no answer
 * from cardd, as the money screens count it.
 */
export function saveError(e: unknown, action: 'save' | 'remove' = 'save'): string {
  if (noPhotoRoutes(e)) return "Your server can't keep photos yet: update it in Settings.";
  if (isNetworkFailure(e) || isGatewayError(e)) return `Can't reach your server, so the photo wasn't ${action === 'save' ? 'saved' : 'removed'}.`;
  if (e instanceof CarddError) return action === 'save' ? `Your server didn't keep the photo: ${e.message}` : `Your server didn't remove the photo: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** cardd first; only once it kept the photo, the phone's cache and the faces, with cardd's tag. */
export async function savePhoto(
  cardd: Pick<CarddClient, 'setCardPhoto'>,
  watch: Pick<ServerWatch, 'photoSaved'>,
  id: string,
  jpeg: string,
): Promise<void> {
  const { photo } = await cardd.setCardPhoto(id, jpeg);
  await watch.photoSaved(id, { tag: photo, jpeg });
}

export async function removePhoto(cardd: Pick<CarddClient, 'removeCardPhoto'>, watch: Pick<ServerWatch, 'photoRemoved'>, id: string): Promise<void> {
  await cardd.removeCardPhoto(id);
  await watch.photoRemoved(id);
}
