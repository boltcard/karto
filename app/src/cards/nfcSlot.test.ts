import { describe, expect, it } from 'vitest';
import type { Nfc, Tag } from '../native/nfc';
import { holdTaps, NfcSlot } from './nfcSlot';

function fakeNfc() {
  const calls: string[] = [];
  const quiets: boolean[] = [];
  let emit: ((t: Tag) => void) | undefined;
  const nfc: Nfc = {
    mode: 'always',
    session: null,
    state: async () => 'on',
    openSettings: async () => {},
    start: async () => void calls.push('start'),
    stop: async () => void calls.push('stop'),
    quiet: (on) => void quiets.push(on),
    onTag: (fn) => {
      emit = fn;
      return { remove: () => void (emit = undefined) };
    },
  };
  const closed: number[] = [];
  const tag = (n: number): Tag => ({ uid: Uint8Array.of(n), transceive: null, close: async () => void closed.push(n) });
  return { nfc, calls, quiets, closed, tap: (n: number) => emit?.(tag(n)) };
}

describe('NfcSlot', () => {
  // Android plays its tag sound for every card it finds, read or not: a card the app drops unread (the till away
  // from a sale, a card held while the camera is open) beeped as though it had been taken.
  // The sound is off while the claim in front drops taps, and on while it reads them.
  it("turns Android's tag sound off while the claim in front drops taps, and on again while one reads them", () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const releaseBase = slot.claimBase((t) => void t.close(), false);
    expect(f.quiets).toEqual([true]);
    const releaseRead = slot.claim(() => {});
    const releaseHold = holdTaps(slot);
    expect(f.quiets).toEqual([true, false, true]);
    releaseHold();
    releaseRead();
    expect(f.quiets).toEqual([true, false, true, false, true]);
    releaseBase();
    expect(f.calls).toEqual(['start', 'stop']);
  });

  it("leaves the sound as it is while the claim in front reads, as the wallet's base and its card screens do", () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    slot.claimBase(() => {});
    const release = slot.claim(() => {});
    release();
    expect(f.quiets).toEqual([false]);
  });

  it('gives the taps to the last screen that claimed it, and reader mode is on while anyone holds a claim', () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const home: number[] = [];
    const hold: number[] = [];
    const releaseHome = slot.claim((t) => home.push(t.uid[0]));
    const releaseHold = slot.claim((t) => hold.push(t.uid[0]));
    f.tap(1);
    releaseHold();
    releaseHold(); // a second release changes nothing
    f.tap(2);
    expect([home, hold]).toEqual([[2], [1]]);
    expect(f.calls).toEqual(['start']);
    releaseHome();
    expect(f.calls).toEqual(['start', 'stop']);
    f.tap(3);
    expect(home).toEqual([2]);
  });

  // The app's own claim, for its life: no tap reaches Android's own handling (Phoenix, the browser).
  it('gives the taps to the base claim while no screen claims, to a screen while it holds its claim, then to the base again', () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const base: number[] = [];
    const card: number[] = [];
    const releaseBase = slot.claimBase((t) => base.push(t.uid[0]));
    expect(f.calls).toEqual(['start']);
    expect(slot.screenClaimed()).toBe(false);
    f.tap(1);
    const releaseCard = slot.claim((t) => card.push(t.uid[0]));
    expect(slot.screenClaimed()).toBe(true);
    f.tap(2);
    releaseCard();
    expect(slot.screenClaimed()).toBe(false);
    f.tap(3);
    expect([base, card]).toEqual([[1, 3], [2]]);
    expect(f.calls).toEqual(['start']); // reader mode stays on under the base claim
    releaseBase();
    releaseBase(); // a second release changes nothing
    expect(f.calls).toEqual(['start', 'stop']);
  });

  it("keeps the base under a screen's claim made before it (a screen's effects run before the provider's)", () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const base: number[] = [];
    const card: number[] = [];
    const releaseCard = slot.claim((t) => card.push(t.uid[0]));
    const releaseBase = slot.claimBase((t) => base.push(t.uid[0]));
    f.tap(1);
    releaseCard();
    expect(f.calls).toEqual(['start']);
    f.tap(2);
    expect([base, card]).toEqual([[2], [1]]);
    releaseBase();
    expect(f.calls).toEqual(['start', 'stop']);
    f.tap(3);
    expect(f.closed).toEqual([]);
  });
});

describe('holdTaps', () => {
  it('closes every tap unread while a screen holds them (the camera, the name screen, Add card\'s photo step), and gives them back to the app when it lets go', () => {
    let emit: ((t: Tag) => void) | undefined;
    const nfc: Nfc = {
      mode: 'always',
      session: null,
      state: async () => 'on',
      openSettings: async () => {},
      start: async () => {},
      stop: async () => {},
      onTag: (fn) => ((emit = fn), { remove: () => void (emit = undefined) }),
    };
    const closed: number[] = [];
    const tag = (n: number): Tag => ({ uid: Uint8Array.of(n), transceive: null, close: async () => void closed.push(n) });
    const slot = new NfcSlot(nfc);
    const app: number[] = [];
    slot.claimBase((t) => app.push(t.uid[0]));
    const release = holdTaps(slot);
    emit?.(tag(1));
    expect([app, closed, slot.screenClaimed()]).toEqual([[], [1], true]);
    release();
    emit?.(tag(2));
    expect([app, closed, slot.screenClaimed()]).toEqual([[2], [1], false]);
  });
});

// A phone answers as a card or as a reader, never both, so the
// pay screen turns reader mode off whatever claims are held, and on again when the phone stops being a card.
describe('NfcSlot.suspend', () => {
  it('turns reader mode off under the base claim and a screen claim, and on again for the same claims', async () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const base: number[] = [];
    const screen: number[] = [];
    slot.claimBase((t) => base.push(t.uid[0]));
    const release = slot.claim((t) => screen.push(t.uid[0]));
    const resume = await slot.suspend();
    expect(f.calls).toEqual(['start', 'stop']);
    f.tap(1);
    expect([base, screen, f.closed]).toEqual([[], [], []]);
    resume();
    expect(f.calls).toEqual(['start', 'stop', 'start']);
    f.tap(2);
    release();
    f.tap(3);
    expect([base, screen]).toEqual([[3], [2]]);
  });

  it('is told only once reader mode is off', async () => {
    const f = fakeNfc();
    let off: (() => void) | undefined;
    f.nfc.stop = () => new Promise<void>((done) => (off = () => (f.calls.push('stop'), done())));
    const slot = new NfcSlot(f.nfc);
    slot.claimBase(() => {});
    let suspended = false;
    const pending = slot.suspend().then((resume) => ((suspended = true), resume));
    await Promise.resolve();
    expect(suspended).toBe(false);
    off!();
    (await pending)();
    expect(f.calls).toEqual(['start', 'stop', 'start']);
  });

  it('lets a claim made while suspended listen only after the resume', async () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const resume = await slot.suspend();
    // Nothing was listening: nothing to turn off.
    expect(f.calls).toEqual([]);
    const got: number[] = [];
    slot.claim((t) => got.push(t.uid[0]));
    slot.claimBase(() => {});
    expect(f.calls).toEqual([]);
    resume();
    resume(); // a second resume changes nothing
    expect(f.calls).toEqual(['start']);
    f.tap(1);
    expect(got).toEqual([1]);
  });

  it('stays off after the resume when every claim was let go meanwhile', async () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    const release = slot.claim(() => {});
    const resume = await slot.suspend();
    release();
    resume();
    expect(f.calls).toEqual(['start', 'stop']);
  });

  it('stays off until every suspend has resumed', async () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    slot.claimBase(() => {});
    const first = await slot.suspend();
    const second = await slot.suspend();
    first();
    expect(f.calls).toEqual(['start', 'stop']);
    second();
    expect(f.calls).toEqual(['start', 'stop', 'start']);
  });
});
