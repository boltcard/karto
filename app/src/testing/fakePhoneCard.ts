// A stand-in for the phone's card service as the app drives it (native/phoneCard.ts over CardNativeModule.kt),
// built on the stand-in for what it answers a reader (phoneCardTag.ts): armed, it hands a till's read the next
// tap and tells the app; the app leaving the front disarms it, as the module does in the activity's pause.
import { Ntag424 } from '../ntag424/card';
import { urlOf } from '../ntag424/ndef';
import { PhoneCardRefused, type PhoneCard, type PhoneCardReadEvent } from '../native/phoneCard';
import { PhoneCardTag } from './phoneCardTag';

export function fakePhoneCard(o: { supported?: boolean } = {}) {
  const tag = new PhoneCardTag();
  /** refuse: Android says no to the preference; refuseNext: to the next that many armings only. calls: what the app asked of the service, in order. */
  const s = { armed: false, refuse: false, refuseNext: 0, calls: [] as string[] };
  const readers = new Set<(e: PhoneCardReadEvent) => void>();
  const enders = new Set<(given: number) => void>();
  tag.onGiven = (given, left) => readers.forEach((fn) => fn({ given, left }));
  const card: PhoneCard = {
    supported: async () => o.supported ?? true,
    arm: async (files) => {
      s.calls.push(`arm ${files.length}`);
      if (s.refuse || s.refuseNext-- > 0) throw new PhoneCardRefused("Android didn't give this app the reader");
      tag.load(files);
      s.armed = true;
    },
    add: async (files) => {
      s.calls.push(`add ${files.length}`);
      if (s.armed) tag.add(files);
    },
    disarm: async () => {
      s.calls.push('disarm');
      s.armed = false;
      return tag.clear();
    },
    onRead: (fn) => (readers.add(fn), { remove: () => void readers.delete(fn) }),
    onEnded: (fn) => (enders.add(fn), { remove: () => void enders.delete(fn) }),
  };
  return {
    card,
    tag,
    s,
    /** A till reads the phone: the link it got, or null when the phone gave it none. */
    async tap(): Promise<string | null> {
      tag.deactivated();
      try {
        return urlOf(await new Ntag424(tag.transceive).readNdefFile());
      } catch {
        return null;
      }
    },
    /** The app left the front while armed: the module disarms by itself, and says how many taps were handed out. */
    leaveFront(): void {
      if (!s.armed) return;
      s.armed = false;
      const given = tag.clear();
      enders.forEach((fn) => fn(given));
    },
    listening: () => readers.size + enders.size,
  };
}
