// What a phone keeps of its own card: one record in
// expo-secure-store, beside the phrase, so Android's backup never carries it to another phone and two phones are
// never the same card. Everything that writes it goes through update, one write at a time, and writes it before
// the server is asked or a tap is handed over.
import type { SecureStoreApi } from '../store/secrets';
import { COUNTER_MAX } from './id';

/**
 * n: the card's number (phoneCard/id.ts). version: the key version reserveCard answered. next: the lowest counter
 * this phone has not yet handed to the card service. removing: the person asked for the card to be removed.
 */
export type PhoneCardRecord = { n: number; version: number; next: number; removing?: true };

/** A read that failed is not a missing record: the keeping-in-step job stops on it, where none would have it remove this phone's own card. */
export type RecordRead = { ok: true; record: PhoneCardRecord | null } | { ok: false };

export type RecordStoreApi = Pick<SecureStoreApi, 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'>;

export class RecordUnreadable extends Error {
  constructor() {
    super("This phone's record of its card couldn't be read.");
    this.name = 'RecordUnreadable';
  }
}

const KEY = 'phone-card';
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/** The record in a stored value, or null for anything that is not one. */
function parse(stored: string | null): PhoneCardRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(stored ?? 'null');
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { n, version, next, removing } = v as Record<string, unknown>;
  // next may be one past the counter's end: every counter has been handed out.
  if (!whole(n, 0xffffffff) || !whole(version, 0xffffffff) || !whole(next, COUNTER_MAX + 1) || (removing !== undefined && removing !== true)) return null;
  return { n, version, next, ...(removing && { removing }) };
}

const same = (a: PhoneCardRecord | null, b: PhoneCardRecord | null) =>
  a === b || (!!a && !!b && a.n === b.n && a.version === b.version && a.next === b.next && !!a.removing === !!b.removing);

export type PhoneCardRecordStore = ReturnType<typeof phoneCardRecord>;

/**
 * The record store of a phone that is never a card (an iPhone): it has none, and its secure store is not asked.
 * The keeping-in-step job, given this, removes every phone's card it finds and registers nothing.
 */
export const noPhoneCardRecord: PhoneCardRecordStore = {
  read: async () => ({ ok: true, record: null }),
  update: async (fn) => {
    if (fn(null) !== null) throw new Error('this phone keeps no record of a card');
    return null;
  },
};

export function phoneCardRecord(ss: RecordStoreApi) {
  let last: Promise<unknown> = Promise.resolve();

  async function read(): Promise<RecordRead> {
    try {
      return { ok: true, record: parse(await ss.getItemAsync(KEY)) };
    } catch {
      return { ok: false };
    }
  }

  return {
    read,
    /**
     * Changes the record: fn is given it as it stands (null: none) and gives what it becomes (null: none). One at
     * a time, in the order asked. Throws RecordUnreadable, writing nothing, when the record can't be read.
     */
    update(fn: (r: PhoneCardRecord | null) => PhoneCardRecord | null): Promise<PhoneCardRecord | null> {
      const run = async () => {
        const now = await read();
        if (!now.ok) throw new RecordUnreadable();
        const asked = fn(now.record);
        // What is stored and answered is the record's own fields, whatever else the update's object carried.
        const next = asked === null ? null : parse(JSON.stringify(asked));
        if (asked !== null && !same(next, asked)) throw new Error("not a phone's card record");
        if (same(next, now.record)) return next;
        if (next === null) await ss.deleteItemAsync(KEY);
        else await ss.setItemAsync(KEY, JSON.stringify(next));
        return next;
      };
      const result = last.then(run, run);
      last = result.catch(() => undefined);
      return result;
    },
  };
}
