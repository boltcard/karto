import { describe, expect, it } from 'vitest';
import { nativePhoneCard, PhoneCardRefused, type PhoneCardNativeApi } from './phoneCard';

/** A stand-in for the card-native module's card calls (CardNativeModule.kt). */
function fake(o: { supported?: boolean; refuse?: unknown } = {}) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(e: never) => void>>();
  const native: PhoneCardNativeApi = {
    phoneCardSupported: async () => o.supported ?? true,
    phoneCardArm: async (files) => {
      calls.push(`arm ${files.join(',')}`);
      if (o.refuse) throw o.refuse;
    },
    phoneCardAdd: async (files) => void calls.push(`add ${files.join(',')}`),
    phoneCardDisarm: async () => (calls.push('disarm'), 3),
    addListener: (event: string, listener: (e: never) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set.add(listener));
      return { remove: () => void set.delete(listener) };
    },
  };
  const emit = (event: string, e: unknown) => listeners.get(event)?.forEach((fn) => fn(e as never));
  return { native, calls, emit, listening: (event: string) => listeners.get(event)?.size ?? 0 };
}
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("the phone's card service, from the app", () => {
  it('asks the module whether this phone can be a card', async () => {
    expect(await nativePhoneCard(fake().native).supported()).toBe(true);
    expect(await nativePhoneCard(fake({ supported: false }).native).supported()).toBe(false);
  });

  it('arms with the files, adds more, and disarms, answering how many were handed out', async () => {
    const f = fake();
    const card = nativePhoneCard(f.native);
    await card.arm(['aa', 'bb']);
    await card.add(['cc']);
    expect(await card.disarm()).toBe(3);
    expect(f.calls).toEqual(['arm aa,bb', 'add cc', 'disarm']);
  });

  it("makes Android's refusal to arm a refusal of its own, and lets any other failure through", async () => {
    const refused = nativePhoneCard(fake({ refuse: coded('ERR_PHONE_CARD_REFUSED', "Android didn't give this app the reader") }).native);
    const e = await refused.arm(['aa']).catch((x) => x);
    expect(e).toBeInstanceOf(PhoneCardRefused);
    expect((e as Error).message).toBe("Android didn't give this app the reader");
    const broken = nativePhoneCard(fake({ refuse: coded('ERR_UNEXPECTED', 'boom') }).native);
    const other = await broken.arm(['aa']).catch((x) => x);
    expect(other).not.toBeInstanceOf(PhoneCardRefused);
    expect((other as Error).message).toBe('boom');
  });

  it('tells each tap handed to a reader, and the module disarming by itself, until the listening is stopped', () => {
    const f = fake();
    const card = nativePhoneCard(f.native);
    const read: unknown[] = [];
    const ended: number[] = [];
    const a = card.onRead((e) => read.push(e));
    const b = card.onEnded((given) => ended.push(given));
    f.emit('phoneCardRead', { given: 1, left: 15 });
    f.emit('phoneCardEnded', { given: 2 });
    expect([read, ended]).toEqual([[{ given: 1, left: 15 }], [2]]);
    a.remove();
    b.remove();
    f.emit('phoneCardRead', { given: 2, left: 14 });
    expect(read).toHaveLength(1);
    expect([f.listening('phoneCardRead'), f.listening('phoneCardEnded')]).toEqual([0, 0]);
  });

  it("is no card on a module without the calls, as the iPhone's is: nothing is asked of it", async () => {
    const card = nativePhoneCard({});
    expect(await card.supported()).toBe(false);
    await expect(card.arm(['aa'])).rejects.toBeInstanceOf(PhoneCardRefused);
    await card.add(['bb']);
    expect(await card.disarm()).toBe(0);
    card.onRead(() => {}).remove();
    card.onEnded(() => {}).remove();
  });
});
