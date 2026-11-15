import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { askCamera, cameraPermission, MAX_PHOTO_BYTES, PhotoTooBig, shotError, thumbnailFault, thumbnailProblem } from './take';

/** A JPEG's marker segments around a frame header of w×h; extra bytes of picture data make it n bytes long. */
function jpeg(w: number, h: number, o: { exif?: boolean; bytes?: number } = {}): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const app1 = o.exif ? [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0, 0] : [];
  const head = [0xff, 0xd8, ...app1, ...sof, 0xff, 0xda, 0x00, 0x02];
  const out = new Uint8Array(Math.max(o.bytes ?? 0, head.length + 2));
  out.set(head);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

describe('cameraPermission', () => {
  it('reads PermissionsAndroid: granted, refused, and refused for good', () => {
    expect(['granted', 'denied', 'never_ask_again'].map(cameraPermission)).toEqual(['granted', 'refused', 'refused_for_good']);
  });
});

describe('askCamera', () => {
  it("is the module's own answer where the module can ask (an iPhone), and React Native is not asked", async () => {
    let asked = 0;
    const android = async () => (asked++, 'granted');
    expect(await askCamera({ cameraPermission: async () => 'granted' }, android)).toBe('granted');
    expect(await askCamera({ cameraPermission: async () => 'refused_for_good' }, android)).toBe('refused_for_good');
    expect(asked).toBe(0);
  });

  it("is PermissionsAndroid's answer where the module has no such call (Android)", async () => {
    expect(await askCamera({}, async () => 'granted')).toBe('granted');
    expect(await askCamera({}, async () => 'denied')).toBe('refused');
    expect(await askCamera({}, async () => 'never_ask_again')).toBe('refused_for_good');
  });

  it('takes anything else a module says for a refusal only Settings can undo, never for a yes', async () => {
    expect(await askCamera({ cameraPermission: async () => 'denied' as never }, async () => 'granted')).toBe('refused_for_good');
  });
});

describe('shotError', () => {
  it("words the camera's codes: the size as PhotoTooBig, a failed capture as it is, a closed camera not at all", () => {
    expect(shotError(Object.assign(new Error('the photo is over 64 KB at quality 60'), { code: 'ERR_PHOTO_TOO_BIG' }))).toBe(new PhotoTooBig().message);
    expect(shotError(Object.assign(new Error('the shot failed'), { code: 'ERR_CAPTURE' }))).toBe('the shot failed');
    expect(shotError(Object.assign(new Error('closed'), { code: 'ERR_CAMERA_CLOSED' }))).toBeNull();
    expect(shotError('odd')).toBe('odd');
  });

  // The iPhone's module rejects with Expo's dressing round its words (native/words.ts).
  it("shows the iPhone's words without the class in front and the file behind", () => {
    const e = Object.assign(new Error('CardCameraException: the camera gave no picture (at CardCameraView.swift:204)'), { code: 'ERR_CAPTURE' });
    expect(shotError(e)).toBe('the camera gave no picture');
    expect(shotError(Object.assign(new Error('CardCameraException: the camera closed before the photo was taken (at CardCameraView.swift:260)'), { code: 'ERR_CAMERA_CLOSED' }))).toBeNull();
    expect(shotError(Object.assign(new Error('CardCameraException: the photo is over 64 KB at quality 60 (at CardCameraView.swift:330)'), { code: 'ERR_PHOTO_TOO_BIG' }))).toBe(new PhotoTooBig().message);
  });

  it("shows Android's words without what Expo puts in front", () => {
    const e = Object.assign(new Error("Call to function 'CardNative.takePhoto' has been rejected.\n→ Caused by: the camera isn't ready"), { code: 'ERR_CAPTURE' });
    expect(shotError(e)).toBe("the camera isn't ready");
  });
});

describe('thumbnailProblem', () => {
  const b64 = (b: Uint8Array) => base64.encode(b);

  it('passes a 428×270 JPEG of at most 64 KB without EXIF', () => {
    expect(thumbnailProblem(b64(jpeg(428, 270, { bytes: 30_000 })))).toBeNull();
    expect(thumbnailProblem(b64(jpeg(428, 270, { bytes: MAX_PHOTO_BYTES })))).toBeNull();
  });

  it('refuses one off 428×270, over 64 KB, with an EXIF segment, not a JPEG, or not base64', () => {
    expect(thumbnailProblem(b64(jpeg(428, 269)))).toBe('The photo came out wrong (428×269).');
    expect(thumbnailProblem(b64(jpeg(428, 270, { bytes: MAX_PHOTO_BYTES + 1 })))).toBe(new PhotoTooBig().message);
    expect(thumbnailProblem(b64(jpeg(428, 270, { exif: true })))).toBe('The photo came out wrong (it has EXIF).');
    expect(thumbnailProblem(b64(Uint8Array.of(1, 2, 3, 4)))).toBe('The photo came out wrong (not a JPEG).');
    expect(thumbnailProblem('not base64!')).toBe("The photo couldn't be read back.");
  });

  it('thumbnailFault says what is wrong in a few words, for the photo probe too', () => {
    expect(thumbnailFault(jpeg(428, 270))).toBeNull();
    expect(thumbnailFault(jpeg(640, 480))).toBe('640×480');
  });
});
