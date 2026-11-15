import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { TagLostError } from '../ntag424/apdu';
import { nativeNfc, type CardNfcApi, type NfcEndEvent, type NfcSession, type NfcTagEvent, type SessionEnd, type Tag } from './nfc';

function fake(answer: (handle: number, hex: string) => Promise<string>) {
  const listeners: ((e: NfcTagEvent) => void)[] = [];
  const closed: number[] = [];
  const api: CardNfcApi = {
    nfcState: async () => 'on',
    nfcSettings: async () => {},
    nfcStart: async () => {},
    nfcStop: async () => {},
    nfcTransceive: answer,
    nfcClose: async (h) => void closed.push(h),
    addListener: ((_event: string, listener: (e: NfcTagEvent) => void) => {
      listeners.push(listener);
      return { remove: () => void listeners.splice(listeners.indexOf(listener), 1) };
    }) as CardNfcApi['addListener'],
  };
  return { api, closed, emit: (e: NfcTagEvent) => listeners.forEach((l) => l(e)), listeners };
}

describe('nativeNfc', () => {
  it("hands Android's module the tag sound's setting, and asks nothing of a module without the call (the iPhone's)", async () => {
    const f = fake(async () => '9000');
    const told: boolean[] = [];
    nativeNfc({ ...f.api, nfcQuiet: async (q) => void told.push(q) }).quiet?.(true);
    nativeNfc({ ...f.api, nfcQuiet: async () => Promise.reject(new Error('no activity')) }).quiet?.(false);
    nativeNfc(f.api).quiet?.(true);
    await Promise.resolve();
    expect(told).toEqual([true]);
  });

  it('turns a tag event into a Tag that sends hex to its handle', async () => {
    const sent: [number, string][] = [];
    const f = fake(async (h, hex) => (sent.push([h, hex]), '9000'));
    const tags: Tag[] = [];
    const sub = nativeNfc(f.api).onTag((t) => tags.push(t));
    f.emit({ handle: 3, uid: '04a39493cc8680' });
    expect(bytesToHex(tags[0].uid)).toBe('04a39493cc8680');
    expect(bytesToHex(await tags[0].transceive!(Uint8Array.of(0x00, 0xa4)))).toBe('9000');
    expect(sent).toEqual([[3, '00a4']]);
    await tags[0].close();
    expect(f.closed).toEqual([3]);
    sub.remove();
    expect(f.listeners).toHaveLength(0);
  });

  it('reports a lifted card as TagLostError and passes other errors on', async () => {
    let fail: Error = Object.assign(new Error('Tag was lost.'), { code: 'ERR_TAG_LOST' });
    const f = fake(async () => {
      throw fail;
    });
    let tag!: Tag;
    nativeNfc(f.api).onTag((t) => (tag = t));
    f.emit({ handle: 1, uid: '08aabbcc' });
    await expect(tag.transceive!(Uint8Array.of(0))).rejects.toBeInstanceOf(TagLostError);
    fail = new Error('something else');
    await expect(tag.transceive!(Uint8Array.of(0))).rejects.toThrow('something else');
  });

  // A MIFARE Classic, an NTAG 215 sticker: Android can't talk ISO-DEP to it, so there is nothing to send to.
  it('reports a tag Android can\'t talk ISO-DEP to', async () => {
    const f = fake(async () => '9000');
    let tag!: Tag;
    nativeNfc(f.api).onTag((t) => (tag = t));
    f.emit({ handle: -1, uid: '04112233445566' });
    expect(tag.transceive).toBeNull();
    await tag.close();
    expect(f.closed).toEqual([]);
  });
});

// The iPhone's way: cards are read only inside a session.
function fakeSession() {
  const calls: string[] = [];
  const tagListeners: ((e: NfcTagEvent) => void)[] = [];
  const endListeners: ((e: NfcEndEvent) => void)[] = [];
  const closed: number[] = [];
  const sent: number[] = [];
  /** How the next nfcScan answers: iOS says the session is active, or ends it before that. */
  let scan: { resolve(): void; reject(e: Error): void } | null = null;
  const api: CardNfcApi = {
    nfcMode: 'session',
    nfcState: async () => 'on',
    nfcStart: async () => {},
    nfcStop: async () => {},
    nfcTransceive: async (h) => (sent.push(h), '9000'),
    nfcClose: async (h) => void closed.push(h),
    nfcScan: (line) => (calls.push(`scan ${line}`), new Promise<void>((resolve, reject) => (scan = { resolve, reject }))),
    nfcSay: async (line) => void calls.push(`say ${line}`),
    nfcAgain: async (line) => void calls.push(`again ${line}`),
    nfcDone: async (line) => void calls.push(`done ${line}`),
    nfcFail: async (line) => void calls.push(`fail ${line}`),
    addListener: ((event: string, listener: never) => {
      const list = (event === 'nfcTag' ? tagListeners : endListeners) as unknown[];
      list.push(listener);
      return { remove: () => void list.splice(list.indexOf(listener), 1) };
    }) as CardNfcApi['addListener'],
  };
  return {
    api, calls, closed, sent,
    active: () => scan!.resolve(),
    refuse: (text: string) => scan!.reject(new Error(text)),
    tag: (e: NfcTagEvent) => tagListeners.forEach((l) => l(e)),
    end: (code: number, text = '') => endListeners.forEach((l) => l({ code, text })),
  };
}
/** An open session, iOS having said it is active. */
async function opened() {
  const f = fakeSession();
  const nfc = nativeNfc(f.api);
  const session = nfc.session!;
  const ends: SessionEnd[] = [];
  session.onEnd((e) => ends.push(e));
  const open = session.open('Hold the card.');
  f.active();
  await open;
  return { f, nfc, session, ends };
}

describe('nativeNfc, the mode', () => {
  it('reads cards all the time where the module names no mode, and has no session', () => {
    const nfc = nativeNfc(fake(async () => '9000').api);
    expect(nfc.mode).toBe('always');
    expect(nfc.session).toBeNull();
  });
  it('reads cards in a session where the module says so', () => {
    const nfc = nativeNfc(fakeSession().api);
    expect(nfc.mode).toBe('session');
    expect(nfc.session!.state()).toBe('none');
  });
  it('has no NFC settings to open where the module offers none (an iPhone)', async () => {
    await expect(nativeNfc(fakeSession().api).openSettings()).resolves.toBeUndefined();
  });
});

describe('the session', () => {
  it('is open from the call, and answers once iOS says it is active', async () => {
    const f = fakeSession();
    const session = nativeNfc(f.api).session!;
    let answered = false;
    const open = session.open('Hold Daily against the top of the back of the phone.').then(() => (answered = true));
    expect(session.state()).toBe('open');
    expect(f.calls).toEqual(['scan Hold Daily against the top of the back of the phone.']);
    await Promise.resolve();
    expect(answered).toBe(false);
    f.active();
    await open;
    expect(session.state()).toBe('open');
  });

  it('is one at a time: a second open is refused without asking iOS', async () => {
    const { f, session } = await opened();
    await expect(session.open('Again.')).rejects.toThrow('A card is already being read.');
    expect(f.calls).toHaveLength(1);
  });

  it('fails the open with iOS\'s words when iOS ends it before it is active, and reports no end', async () => {
    const f = fakeSession();
    const session = nativeNfc(f.api).session!;
    const ends: SessionEnd[] = [];
    session.onEnd((e) => ends.push(e));
    const open = session.open('Hold the card.');
    f.refuse('System resource unavailable');
    await expect(open).rejects.toThrow('System resource unavailable');
    expect(session.state()).toBe('none');
    expect(ends).toEqual([]);
  });

  // The words go on the hold screen: iOS's own, not what Expo puts around them (seen on the iPhone 12).
  it('fails the open with iOS\'s words alone, without the class name and the file and line Expo adds', async () => {
    const f = fakeSession();
    const session = nativeNfc(f.api).session!;
    const open = session.open('Hold the card.');
    f.refuse('NfcScanException: System resource unavailable (at CardNative/CardNativeModule.swift:163)');
    const e = await open.catch((x) => x);
    expect(e.message).toBe('System resource unavailable');
  });

  it('passes its calls through in order, and none once it is not open', async () => {
    const { f, session } = await opened();
    session.say('Step 1 of 7.');
    session.again('The card moved away.');
    session.done('Card added.');
    session.say('late');
    session.again('late');
    session.fail('late');
    session.close();
    expect(f.calls.slice(1)).toEqual(['say Step 1 of 7.', 'again The card moved away.', 'done Card added.']);
  });

  it('is ending from the call that ends it until iOS reports the end, and can open again after', async () => {
    const { f, session } = await opened();
    session.done('Card added.');
    expect(session.state()).toBe('ending');
    await expect(session.open('Too soon.')).rejects.toThrow('A card is already being read.');
    f.end(200);
    expect(session.state()).toBe('none');
    const again = session.open('Hold the card.');
    f.active();
    await again;
    expect(session.state()).toBe('open');
  });

  // iOS reports the app's own ending and the person's Cancel with one code (200): why is what the app asked for.
  it.each([
    ['done', (s: NfcSession) => s.done('Card added.'), 200, 'done'],
    ['fail', (s: NfcSession) => s.fail('This card is already one of yours.'), 200, 'failed'],
    ['close', (s: NfcSession) => s.close(), 200, 'closed'],
    ['done, whatever iOS then says', (s: NfcSession) => s.done('Card added.'), 202, 'done'],
  ] as const)('says why it ended after %s', async (_name, call, code, why) => {
    const { f, session, ends } = await opened();
    call(session);
    f.end(code, 'Session invalidated by user');
    expect(ends).toEqual([{ why }]);
  });
  it.each([
    [200, 'cancelled'],
    [201, 'timeout'],
    [202, 'interrupted'],
  ] as const)('says why iOS ended it by itself with code %i', async (code, why) => {
    const { f, ends } = await opened();
    f.end(code, 'whatever iOS says');
    expect(ends).toEqual([{ why }]);
  });
  it('passes on iOS\'s words for any other end', async () => {
    const { f, ends } = await opened();
    f.end(2, 'Missing required entitlement');
    expect(ends).toEqual([{ why: 'error', error: 'Missing required entitlement' }]);
  });

  it('ends a left screen\'s session with a line of its own', async () => {
    const { f, session } = await opened();
    session.close();
    expect(f.calls.at(-1)).toBe('fail Card reading stopped.');
  });

  it('reports each end once, to every listener still listening', async () => {
    const { f, session, ends } = await opened();
    const second: SessionEnd[] = [];
    const third: SessionEnd[] = [];
    session.onEnd((e) => second.push(e));
    session.onEnd((e) => third.push(e))();
    f.end(200);
    f.end(200);
    expect(ends).toEqual([{ why: 'cancelled' }]);
    expect(second).toEqual([{ why: 'cancelled' }]);
    expect(third).toEqual([]);
  });

  // A screen left while the sheet was still coming up: iOS ends it before it was active, which fails the scan.
  it('reports the end of a session closed before it was active, and does not fail its open', async () => {
    const f = fakeSession();
    const session = nativeNfc(f.api).session!;
    const ends: SessionEnd[] = [];
    session.onEnd((e) => ends.push(e));
    const open = session.open('Hold the card.');
    session.close();
    f.refuse('Session invalidated');
    await open;
    expect(ends).toEqual([{ why: 'closed' }]);
    expect(session.state()).toBe('none');
  });

  it('fails a card\'s command as a lost card once the session has ended, without asking the module', async () => {
    const { f, nfc, session } = await opened();
    let tag!: Tag;
    nfc.onTag((t) => (tag = t));
    f.tag({ handle: 4, uid: '08aabbcc' });
    expect(bytesToHex(await tag.transceive!(Uint8Array.of(0)))).toBe('9000');
    session.done('Card added.');
    await expect(tag.transceive!(Uint8Array.of(0))).rejects.toBeInstanceOf(TagLostError);
    expect(f.sent).toEqual([4]);
  });

  it('fails the command of a card it was told to let go of', async () => {
    const { f, nfc, session } = await opened();
    const tags: Tag[] = [];
    nfc.onTag((t) => tags.push(t));
    f.tag({ handle: 4, uid: '08aabbcc' });
    session.again('The card moved away.');
    await expect(tags[0].transceive!(Uint8Array.of(0))).rejects.toBeInstanceOf(TagLostError);
    f.tag({ handle: 5, uid: '08aabbcc' });
    expect(bytesToHex(await tags[1].transceive!(Uint8Array.of(0)))).toBe('9000');
  });

  it('leaves the session open when a tag is closed', async () => {
    const { f, nfc, session } = await opened();
    let tag!: Tag;
    nfc.onTag((t) => (tag = t));
    f.tag({ handle: 4, uid: '08aabbcc' });
    await tag.close();
    expect(f.closed).toEqual([4]);
    expect(session.state()).toBe('open');
    expect(f.calls).toHaveLength(1);
  });
});
