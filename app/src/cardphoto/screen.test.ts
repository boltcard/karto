import { describe, expect, it } from 'vitest';
import { CarddError } from '../cardd/client';
import { finishTo, photoStep, photoSwipe, photoView, removePhoto, saveError, savePhoto, validCardId } from './screen';

const ID = 'a'.repeat(32);

describe('the photo screen', () => {
  it('goes back to the wallet from the add step, and back to the account page from More', () => {
    expect(finishTo(true, true)).toBe('wallet');
    expect(finishTo(false, true)).toBe('back');
    // Opened cold by a karto:// link, there is nothing to go back to.
    expect(finishTo(false, false)).toBe('wallet');
  });

  // A karto:// link can open it with any id.
  it("opens only for a card's id", () => {
    expect(validCardId(ID)).toBe(true);
    for (const bad of [undefined, '', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}/x`, 'pool']) expect(validCardId(bad)).toBe(false);
  });

  it("tells an older server's missing route from cardd's own refusals and a network failure", () => {
    expect(saveError(new CarddError(404, 'bad_response', 'PUT … → HTTP 404: 404 page not found'))).toBe(
      "Your server can't keep photos yet: update it in Settings.",
    );
    expect(saveError(new CarddError(409, 'conflict', 'store: conflicting state: card is reset'))).toBe(
      "Your server didn't keep the photo: store: conflicting state: card is reset",
    );
    expect(saveError(new Error('fetch failed: no answer from vm-1001.lnvps.cloud in 30 s'))).toBe("Can't reach your server, so the photo wasn't saved.");
    // Caddy's answer while cardd restarts (Update server): not cardd's refusal.
    expect(saveError(new CarddError(502, 'bad_response', 'PUT … → HTTP 502: <html>'))).toBe("Can't reach your server, so the photo wasn't saved.");
    expect(saveError(new Error('The photo came out 428×269, not 428×270.'))).toBe('The photo came out 428×269, not 428×270.');
  });

  it('words a failed removal as a removal', () => {
    expect(saveError(new CarddError(404, 'bad_response', 'DELETE … → HTTP 404: 404 page not found'), 'remove')).toBe(
      "Your server can't keep photos yet: update it in Settings.",
    );
    expect(saveError(new CarddError(409, 'conflict', 'store: conflicting state: card is reset'), 'remove')).toBe(
      "Your server didn't remove the photo: store: conflicting state: card is reset",
    );
    expect(saveError(new Error('fetch failed: no answer from vm-1001.lnvps.cloud in 30 s'), 'remove')).toBe("Can't reach your server, so the photo wasn't removed.");
    expect(saveError(new CarddError(502, 'bad_response', 'DELETE … → HTTP 502: <html>'), 'remove')).toBe("Can't reach your server, so the photo wasn't removed.");
    expect(saveError(new Error('plain'), 'remove')).toBe('plain');
  });

  it('saves to cardd, then to the cache and the faces with the tag cardd gave', async () => {
    const calls: string[] = [];
    const cardd = { setCardPhoto: async (id: string, jpeg: string) => (calls.push(`put ${id} ${jpeg}`), { photo: '0123456789abcdef' }) };
    const watch = { photoSaved: async (id: string, p: { tag: string; jpeg: string }) => void calls.push(`saved ${id} ${p.tag} ${p.jpeg}`) };
    await savePhoto(cardd, watch, ID, '/9j/AA');
    expect(calls).toEqual([`put ${ID} /9j/AA`, `saved ${ID} 0123456789abcdef /9j/AA`]);
  });

  it("keeps nothing on the phone when cardd refuses it, so Try again sends the same photo", async () => {
    const calls: string[] = [];
    const cardd = { setCardPhoto: async () => Promise.reject(new CarddError(400, 'bad_photo', 'cards: bad photo')) };
    const watch = { photoSaved: async () => void calls.push('saved') };
    await expect(savePhoto(cardd, watch, ID, '/9j/AA')).rejects.toMatchObject({ code: 'bad_photo' });
    expect(calls).toEqual([]);
  });

  it('removes from cardd, then from the cache and the faces', async () => {
    const calls: string[] = [];
    const cardd = { removeCardPhoto: async (id: string) => void calls.push(`delete ${id}`) };
    const watch = { photoRemoved: async (id: string) => void calls.push(`removed ${id}`) };
    await removePhoto(cardd, watch, ID);
    expect(calls).toEqual([`delete ${ID}`, `removed ${ID}`]);
  });
});

// What stands under the face follows the state.
describe('photoView', () => {
  const idle = { step: null, hasPhoto: false, busy: null, failed: null, noCamera: null } as const;
  const titles = (v: { buttons: { title: string; kind: string }[] }) => v.buttons.map((b) => `${b.title}/${b.kind}`);

  it("reads Add card's step from the link, and nothing else as one", () => {
    expect(photoStep('add')).toBe('add');
    expect(photoStep('adopt')).toBe('adopt');
    expect(photoStep(undefined)).toBeNull();
    expect(photoStep('wipe')).toBeNull();
  });

  it("is Add card's third step, with its bar and no way back, or Change photo from More", () => {
    expect(photoView({ ...idle, step: 'add' })).toMatchObject({ band: 'Add a card', bar: true, back: false });
    expect(photoView({ ...idle, step: 'adopt' })).toMatchObject({ band: 'Add the card back', bar: true, back: false });
    expect(photoView(idle)).toMatchObject({ band: 'Change photo', bar: false, back: true });
  });

  it('leads with Take photo while the card has none', () => {
    expect(photoView({ ...idle, step: 'add' })).toEqual({
      band: 'Add a card', bar: true, back: false, veil: null, panels: [], settings: false, remove: false, off: false,
      buttons: [{ key: 'take', title: 'Take photo', kind: 'primary' }, { key: 'finish', title: 'Skip for now', kind: 'secondary' }],
    });
    expect(titles(photoView(idle))).toEqual(['Take photo/primary', 'Done/secondary']);
  });

  it("says Skip for now only in Add card's step and only while the card has no photo (a card added back keeps its own)", () => {
    const last = (step: 'add' | 'adopt' | null, hasPhoto: boolean) => photoView({ ...idle, step, hasPhoto }).buttons.find((b) => b.key === 'finish')?.title;
    expect([last('add', false), last('adopt', false), last('add', true), last(null, false), last(null, true)]).toEqual(['Skip for now', 'Skip for now', 'Done', 'Done', 'Done']);
  });

  it('leads with Done once it has one, with Retake photo and the row to remove it', () => {
    for (const step of ['add', null] as const) {
      const v = photoView({ ...idle, step, hasPhoto: true });
      expect(titles(v)).toEqual(['Done/primary', 'Retake photo/secondary']);
      expect(v.buttons.map((b) => b.key)).toEqual(['finish', 'take']);
      expect(v.remove).toBe(true);
    }
  });

  it('leads with Try again after a save that failed, the same photo sent again', () => {
    const failed = { text: "Can't reach your server, so the photo wasn't saved.", retry: true };
    const v = photoView({ ...idle, step: 'add', failed });
    expect(v.panels).toEqual([failed.text]);
    expect(v.buttons).toEqual([
      { key: 'retry', title: 'Try again', kind: 'primary' }, { key: 'take', title: 'Retake photo', kind: 'secondary' }, { key: 'finish', title: 'Skip for now', kind: 'secondary' },
    ]);
    expect(v.remove).toBe(false);
    // The card still has its earlier photo: the row stays, and the last button is Done.
    const kept = photoView({ ...idle, hasPhoto: true, failed });
    expect(titles(kept)).toEqual(['Try again/primary', 'Retake photo/secondary', 'Done/secondary']);
    expect(kept.remove).toBe(true);
  });

  it("puts any other failure over the state's own buttons", () => {
    const failed = { text: "Can't reach your server, so the photo wasn't removed.", retry: false };
    const v = photoView({ ...idle, hasPhoto: true, failed });
    expect(v.panels).toEqual([failed.text]);
    expect(titles(v)).toEqual(['Done/primary', 'Retake photo/secondary']);
  });

  it('says the camera was not allowed, with Open settings', () => {
    expect(photoView({ ...idle, noCamera: { canAskAgain: true } })).toMatchObject({ panels: ["The camera wasn't allowed, so no photo was taken."], settings: true });
    expect(photoView({ ...idle, noCamera: { canAskAgain: false } }).panels).toEqual(["This app isn't allowed to use the camera. Allow it in Android's settings."]);
    // An iPhone has no "Android's settings".
    expect(photoView({ ...idle, noCamera: { canAskAgain: false }, ios: true }).panels).toEqual(["This app isn't allowed to use the camera. Allow it in Settings."]);
    expect(photoView({ ...idle, noCamera: { canAskAgain: false }, ios: false }).panels).toEqual(["This app isn't allowed to use the camera. Allow it in Android's settings."]);
    expect(photoView(idle).settings).toBe(false);
    // A removal that failed after the camera was refused: both are said, the failure first.
    const both = photoView({ ...idle, hasPhoto: true, failed: { text: 'x', retry: false }, noCamera: { canAskAgain: true } });
    expect(both.panels).toEqual(['x', "The camera wasn't allowed, so no photo was taken."]);
  });

  it('says what it is doing over the face, with everything off', () => {
    expect(photoView({ ...idle, busy: 'saving' })).toMatchObject({ veil: 'Saving the photo…', off: true });
    expect(photoView({ ...idle, hasPhoto: true, busy: 'removing' })).toMatchObject({ veil: 'Removing the photo…', off: true });
    expect(photoView({ ...idle, busy: 'asking' })).toMatchObject({ veil: null, off: true });
    expect(photoView(idle)).toMatchObject({ veil: null, off: false });
  });
});

// The iPhone's swipe from the left edge leaves a screen as its ← does.
describe('photoSwipe', () => {
  const idle = { step: null, busy: null, camera: false } as const;

  it('is allowed from More, where the band has its arrow', () => {
    expect(photoSwipe(idle)).toBe(true);
  });

  it("is off in Add card's step, which has no arrow: an add is not left half way by a stray thumb", () => {
    expect(photoSwipe({ ...idle, step: 'add' })).toBe(false);
    expect(photoSwipe({ ...idle, step: 'adopt' })).toBe(false);
  });

  it('is off while the screen is busy, as the arrow is', () => {
    for (const busy of ['asking', 'saving', 'removing'] as const) expect(photoSwipe({ ...idle, busy })).toBe(false);
  });

  it('is off while the camera or its check view is up: Cancel and Retake are the ways out', () => {
    expect(photoSwipe({ ...idle, camera: true })).toBe(false);
  });

  it('is on exactly where the screen draws a working arrow', () => {
    for (const step of [null, 'add', 'adopt'] as const) for (const busy of [null, 'asking', 'saving', 'removing'] as const) {
      const v = photoView({ step, hasPhoto: false, busy, failed: null, noCamera: null });
      expect(photoSwipe({ step, busy, camera: false })).toBe(v.back && !v.off);
    }
  });
});
