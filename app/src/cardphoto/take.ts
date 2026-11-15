// The card's photo around our own camera:
// the camera permission, the camera's errors in words, and a
// guard on the thumbnail before it goes to cardd, which refuses anything but
// a 428×270 JPEG of at most 64 KB with no EXIF.
import { base64 } from '@scure/base';
import { nativeWords } from '../native/words';
import { hasExif, jpegSize } from './jpeg';

export const PHOTO_WIDTH = 428;
export const PHOTO_HEIGHT = 270;
/** cardd's limit (server/internal/cards MaxPhotoBytes). */
export const MAX_PHOTO_BYTES = 64 * 1024;
/** The camera's frame: its width as a fraction of the camera's, and its centre's fraction of the way down (CardCameraView's props). */
export const FRAME_WIDTH = 0.86;
export const FRAME_CENTRE_Y = 0.45;

export class PhotoTooBig extends Error {
  constructor() {
    super("The photo couldn't be made small enough for your server (64 KB). Try again with less around the card.");
    this.name = 'PhotoTooBig';
  }
}

// Asking for the camera lives in the native layer, where Karto PoS's scanner may reach it too.
export { askCamera, cameraPermission, settingsPlace, type CameraPermission } from '../native/camera';

/**
 * What a failed shot says, from the camera's error codes; null for one dropped without a word (the camera closed
 * under it). The module's own words, without what Expo puts around them (native/words.ts).
 */
export function shotError(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERR_CAMERA_CLOSED') return null;
  if (code === 'ERR_PHOTO_TOO_BIG') return new PhotoTooBig().message;
  return nativeWords(e);
}

/** What's wrong with a thumbnail, as cardd would see it, or null. */
export function thumbnailFault(b: Uint8Array): string | null {
  const size = jpegSize(b);
  if (!size) return 'not a JPEG';
  if (size.width !== PHOTO_WIDTH || size.height !== PHOTO_HEIGHT) return `${size.width}×${size.height}`;
  if (b.length > MAX_PHOTO_BYTES) return `${b.length} bytes`;
  if (hasExif(b)) return 'it has EXIF';
  return null;
}

/** Why the camera's thumbnail (base64) can't go to cardd, in words; null when it can. */
export function thumbnailProblem(jpeg: string): string | null {
  let b: Uint8Array;
  try {
    b = base64.decode(jpeg);
  } catch {
    return "The photo couldn't be read back.";
  }
  if (b.length > MAX_PHOTO_BYTES) return new PhotoTooBig().message;
  const fault = thumbnailFault(b);
  return fault && `The photo came out wrong (${fault}).`;
}
