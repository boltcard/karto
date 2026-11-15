// The world of the phone's card's tests (phoneCard/): the card world's stand-in server, a secure store in memory
// holding the phone's record, every call made of the server by name with a way to cut one off, and phones' cards
// put on the server by number.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId } from '../boltcard/cardkeys';
import type { CardInfo, CardState, CarddError } from '../cardd/client';
import { firstCounter, phoneCardId } from '../phoneCard/id';
import type { KeepDeps, Removed } from '../phoneCard/keep';
import { phoneCardRecord, type PhoneCardRecord, type RecordStoreApi } from '../phoneCard/record';
import { cardWorld } from './cardWorld';

const PLASTIC = hexToBytes('04a39493cc8680');

export async function phoneCardWorld(o: { record?: PhoneCardRecord; nowMs?: number } = {}) {
  const t = await cardWorld();
  const items = new Map<string, string>();
  /**
   * unreadable: the secure store's reads throw. failAt: the call of that number, counted from the last run, fails
   * as an unreachable server does. refuse: the server's refusal of a call, by its name, or its name and a card's
   * id ("wipedCard:<id>").
   */
  const s = { unreadable: false, failAt: 0, refuse: new Map<string, CarddError>(), calls: [] as string[], names: new Map<string, string>(), noted: [] as Removed[] };
  const ss: RecordStoreApi = {
    getItemAsync: async (key) => {
      if (s.unreadable) throw new Error('Could not decrypt the value');
      return items.get(key) ?? null;
    },
    setItemAsync: async (key, value) => void items.set(key, value),
    deleteItemAsync: async (key) => void items.delete(key),
  };
  const record = phoneCardRecord(ss);
  if (o.record) await record.update(() => o.record!);
  const cardd = new Proxy(t.deps.cardd, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        s.calls.push(String(prop));
        if (s.failAt && s.calls.length === s.failAt) throw new TypeError('fetch failed: no answer from vm-1.lnvps.cloud');
        const refusal = s.refuse.get(String(prop)) ?? s.refuse.get(`${String(prop)}:${String(args[0])}`);
        if (refusal) throw refusal;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const nowMs = o.nowMs ?? t.w.nowMs;
  // The job's deps, with every call the card screens' client has: set-up and the pay screen ask for more than the job.
  const d: KeepDeps & { cardd: typeof t.deps.cardd } = {
    issuer: t.deps.issuer, host: t.deps.host, cardd, record, phoneName: 'Pixel 8 Pro', now: () => nowMs,
    rememberedName: async (id) => s.names.get(id),
    noteRemoved: async (r) => void s.noted.push(r),
  };
  const id = (n: number) => phoneCardId(t.deps.issuer, n);
  /** A phone's card on the server, numbered n. */
  const put = (n: number, state: CardState, more: Partial<CardInfo> = {}) =>
    t.cardd.cards.set(id(n), { id: id(n), version: 0, state, counter: 100, name: `Phone ${n}`, host: t.cardd.host, created: 0, updated: 0, ...more });
  // A plastic card with money on it, which nothing here may touch.
  const plasticId = bytesToHex(cardId(t.deps.issuer, PLASTIC));
  t.cardd.cards.set(plasticId, { id: plasticId, version: 0, state: 'active', counter: 5, name: 'Daily', host: t.cardd.host, created: 0, updated: 0 });
  t.cardd.balances.set(plasticId, 7_000_000);
  /** The phones' cards' states on the server, by number: { n0: 'active', … }. */
  const states = () => {
    const out: Record<string, CardState> = {};
    for (let n = 0; n < 8; n++) {
      const c = t.cardd.cards.get(id(n));
      if (c) out[`n${n}`] = c.state;
    }
    return out;
  };
  const stored = async (): Promise<PhoneCardRecord | null | 'unreadable'> => {
    const r = await record.read();
    return r.ok ? r.record : 'unreadable';
  };
  /** The server's own list, asked for outside the count of calls. */
  const list = () => t.deps.cardd.cards();
  /** The clock's counter (phoneCard/id.ts firstCounter). */
  const floor = firstCounter(undefined, nowMs);
  // t.cardd is the stand-in server itself; d.cardd the counted client of it.
  return { ...t, s, d, id, put, states, stored, list, record, plasticId, floor, nowMs };
}
