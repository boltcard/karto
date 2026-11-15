import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { contrast, themeFor } from '../ui/theme';
import { backDoes, checkLine, hint, LOOKING, oneShot, shoot, photoColours, type CameraState } from './camera';
import { PhotoTooBig } from './take';

/** A 428×270 JPEG's head: what thumbnailProblem reads. */
const GOOD = base64.encode(Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x0e, 0x01, 0xac, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9));
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('hint', () => {
  it('says what to do while looking, that the card is found, that the shot is being made, and why the camera or a shot failed', () => {
    expect(hint(LOOKING, false)).toEqual({ title: 'Hold the card inside the frame', detail: 'Fill the frame with it, on a plain surface lighter or darker than the card, in good light' });
    expect(hint(LOOKING, true)).toEqual({ title: 'Card found', detail: 'Press the button' });
    expect(hint({ kind: 'taking' }, true)).toEqual({ title: 'Taking the photo…', detail: '' });
    expect(hint({ kind: 'looking', error: 'the shot failed' }, true)).toEqual({ title: 'the shot failed', detail: '' });
    expect(hint({ kind: 'broken', reason: 'in use' }, false)).toEqual({ title: "The camera couldn't start: in use", detail: '' });
  });

  // Without the name, the screen does not say which card is to be photographed.
  it('names the card to photograph while it looks, when the card has a name', () => {
    expect(hint(LOOKING, false, 'Kids')).toEqual({ title: 'Hold Kids inside the frame', detail: 'Fill the frame with it, on a plain surface lighter or darker than the card, in good light' });
    expect(hint(LOOKING, false, '').title).toBe('Hold the card inside the frame');
    expect(hint(LOOKING, true, 'Kids').title).toBe('Card found');
    expect(hint({ kind: 'taking' }, false, 'Kids').title).toBe('Taking the photo…');
  });
});

describe('checkLine', () => {
  it("says when the photo is only the frame's area", () => {
    expect(checkLine('frame')).toBe("No card edges were found: this is the frame's area.");
    expect(checkLine('shot')).toBe('This is how the card will look in your wallet.');
    expect(checkLine('outline')).toBe('This is how the card will look in your wallet.');
  });
});

describe('backDoes', () => {
  it('is Cancel while looking or broken, Retake on the check view, and nothing while the shot is made', () => {
    const states: CameraState[] = [LOOKING, { kind: 'broken', reason: 'x' }, { kind: 'check', jpeg: GOOD, source: 'shot' }, { kind: 'taking' }];
    expect(states.map(backDoes)).toEqual(['cancel', 'cancel', 'retake', 'nothing']);
  });
});

describe('shoot', () => {
  it('hands a good thumbnail on to the check view, with where its corners came from', async () => {
    expect(await shoot(async () => ({ jpeg: GOOD, source: 'frame' }))).toEqual({ kind: 'check', jpeg: GOOD, source: 'frame' });
  });

  it('keeps the camera open with the reason when the shot fails or its thumbnail would be refused', async () => {
    expect(await shoot(() => Promise.reject(coded('ERR_PHOTO_TOO_BIG', 'over')))).toEqual({ kind: 'looking', error: new PhotoTooBig().message });
    expect(await shoot(() => Promise.reject(coded('ERR_CAPTURE', 'the shot failed')))).toEqual({ kind: 'looking', error: 'the shot failed' });
    expect(await shoot(async () => ({ jpeg: base64.encode(Uint8Array.of(1, 2)), source: 'shot' }))).toEqual({ kind: 'looking', error: 'The photo came out wrong (not a JPEG).' });
  });

  it('drops a shot the camera closed under without a word', async () => {
    expect(await shoot(() => Promise.reject(coded('ERR_CAMERA_CLOSED', 'closed')))).toEqual(LOOKING);
  });
});

describe('oneShot', () => {
  it('ignores a second press while the first shot is being made, and takes the next one after', async () => {
    let shots = 0;
    let finish = () => {};
    const press = oneShot(() => new Promise<number>((done) => ((shots += 1), (finish = () => done(shots)))));
    const first = press();
    expect(await press()).toBeNull();
    finish();
    expect(await first).toBe(1);
    const second = press();
    finish();
    expect([await second, shots]).toEqual([2, 2]);
  });
});

// The check view's Use photo is orange, as the app's other buttons.
describe('photoColours', () => {
  it("is the theme's orange button, the same whichever mode the phone is in (the camera is always dark)", () => {
    const c = photoColours();
    for (const scheme of ['light', 'dark']) expect(c).toEqual({ fill: themeFor(scheme).accent, text: themeFor(scheme).onAccent });
    expect(contrast(c.text, c.fill)).toBeGreaterThanOrEqual(4.5);
  });
});
