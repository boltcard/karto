import { describe, expect, it } from 'vitest';
import { noPhoneCardRecord, phoneCardRecord, RecordUnreadable, type PhoneCardRecord, type RecordStoreApi } from './record';

/** A secure store in memory: `fail` makes the next reads throw, as Android's does when its key can't be used. */
function fake() {
  const items = new Map<string, string>();
  const f = { items, fail: false, slow: 0, writes: 0 };
  const wait = () => (f.slow ? new Promise((r) => setTimeout(r, f.slow)) : Promise.resolve());
  const ss: RecordStoreApi = {
    getItemAsync: async (key) => {
      await wait();
      if (f.fail) throw new Error('Could not decrypt the value');
      return items.get(key) ?? null;
    },
    setItemAsync: async (key, value) => {
      await wait();
      f.writes++;
      items.set(key, value);
    },
    deleteItemAsync: async (key) => {
      await wait();
      f.writes++;
      items.delete(key);
    },
  };
  return { f, record: phoneCardRecord(ss) };
}
const REC: PhoneCardRecord = { n: 0, version: 0, next: 412_346 };

describe("the phone's record of its card", () => {
  it('is none until one is written, and reads back what was written, beside the phrase', async () => {
    const { f, record } = fake();
    expect(await record.read()).toEqual({ ok: true, record: null });
    expect(await record.update(() => REC)).toEqual(REC);
    expect(await record.read()).toEqual({ ok: true, record: REC });
    expect([...f.items.keys()]).toEqual(['phone-card']);
    expect(JSON.parse(f.items.get('phone-card')!)).toEqual(REC);
  });

  it('keeps that a removal has begun, and is gone when the update gives nothing', async () => {
    const { f, record } = fake();
    await record.update(() => REC);
    expect(await record.update((r) => ({ ...r!, removing: true }))).toEqual({ ...REC, removing: true });
    expect(await record.read()).toEqual({ ok: true, record: { ...REC, removing: true } });
    expect(await record.update(() => null)).toBeNull();
    expect(await record.read()).toEqual({ ok: true, record: null });
    expect(f.items.size).toBe(0);
  });

  it('says a read that failed is not a missing record, and writes nothing over it', async () => {
    const { f, record } = fake();
    await record.update(() => REC);
    f.fail = true;
    expect(await record.read()).toEqual({ ok: false });
    await expect(record.update((r) => ({ ...(r ?? REC), next: 1 }))).rejects.toBeInstanceOf(RecordUnreadable);
    f.fail = false;
    expect(await record.read()).toEqual({ ok: true, record: REC });
  });

  it('reads a value that is no record as none', async () => {
    for (const stored of ['', 'not json', '[]', '{"n":0}', '{"n":-1,"version":0,"next":0}', '{"n":0,"version":0,"next":1.5}', '{"n":0,"version":0,"next":16777217}', '{"n":0,"version":0,"next":1,"removing":"yes"}']) {
      const { f, record } = fake();
      f.items.set('phone-card', stored);
      expect(await record.read(), stored).toEqual({ ok: true, record: null });
    }
    // The counter's end plus one is a record: every counter has been handed out.
    const { f, record } = fake();
    f.items.set('phone-card', '{"n":3,"version":1,"next":16777216,"extra":1}');
    expect(await record.read()).toEqual({ ok: true, record: { n: 3, version: 1, next: 16_777_216 } });
  });

  it('refuses to write what is no record', async () => {
    const { f, record } = fake();
    await expect(record.update(() => ({ n: 0, version: 0, next: -1 }))).rejects.toThrow("not a phone's card record");
    expect(f.writes).toBe(0);
  });

  it('writes one at a time, each update seeing the last one written, however slow the store', async () => {
    const { f, record } = fake();
    await record.update(() => REC);
    f.slow = 5;
    const raise = () => record.update((r) => ({ ...r!, next: r!.next + 16 }));
    const all = await Promise.all([raise(), raise(), raise()]);
    expect(all.map((r) => r!.next)).toEqual([REC.next + 16, REC.next + 32, REC.next + 48]);
    expect((await record.read())).toEqual({ ok: true, record: { ...REC, next: REC.next + 48 } });
  });

  it('carries on after an update that threw, and leaves the record as it was', async () => {
    const { record } = fake();
    await record.update(() => REC);
    const bad = record.update(() => {
      throw new Error('no');
    });
    const good = record.update((r) => ({ ...r!, next: r!.next + 1 }));
    await expect(bad).rejects.toThrow('no');
    expect((await good)!.next).toBe(REC.next + 1);
  });

  it('writes nothing when the update leaves the record as it is', async () => {
    const { f, record } = fake();
    await record.update(() => REC);
    const before = f.writes;
    expect(await record.update((r) => r)).toEqual(REC);
    expect(await record.update(() => ({ ...REC }))).toEqual(REC);
    expect(f.writes).toBe(before);
    expect(await fake().record.update(() => null)).toBeNull();
  });
});

describe('the record of a phone that is never a card', () => {
  it('is always none, and can not be written', async () => {
    expect(await noPhoneCardRecord.read()).toEqual({ ok: true, record: null });
    expect(await noPhoneCardRecord.update((r) => r)).toBeNull();
    expect(await noPhoneCardRecord.update(() => null)).toBeNull();
    await expect(noPhoneCardRecord.update(() => REC)).rejects.toThrow('this phone keeps no record of a card');
  });
});
