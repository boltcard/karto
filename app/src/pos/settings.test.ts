import { describe, expect, it } from 'vitest';
import { PosStore, type KeyValue } from './settings';

/** expo-secure-store, as far as the till uses it. */
function memory(): KeyValue & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItemAsync: async (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => void items.set(k, v),
    deleteItemAsync: async (k) => void items.delete(k),
  };
}

// The server's host, its own name and the sound switch.
describe('PosStore', () => {
  it('has no shop until the phone is paired, and then keeps its host and this phone\'s name', async () => {
    const kv = memory();
    const store = new PosStore(kv);
    expect(await store.paired()).toBeNull();
    await store.savePaired({ host: 'vm-1001.lnvps.cloud', name: 'Till 1' });
    expect(await new PosStore(kv).paired()).toEqual({ host: 'vm-1001.lnvps.cloud', name: 'Till 1', wallet: '' });
  });

  // The wallet's name: kept with the pairing; a record kept before it, or one that isn't a name, reads as none.
  it("keeps the wallet's name, and reads an older record as having none", async () => {
    const kv = memory();
    const store = new PosStore(kv);
    await store.savePaired({ host: 'vm-1001.lnvps.cloud', name: 'Till 1', wallet: 'Café' });
    expect(await new PosStore(kv).paired()).toEqual({ host: 'vm-1001.lnvps.cloud', name: 'Till 1', wallet: 'Café' });
    await store.setHost('vm-1003.lnvps.cloud');
    expect(await store.paired()).toEqual({ host: 'vm-1003.lnvps.cloud', name: 'Till 1', wallet: 'Café' });
    for (const old of [{ host: 'vm-1001.lnvps.cloud', name: 'Till 1' }, { host: 'vm-1001.lnvps.cloud', name: 'Till 1', wallet: 7 }]) {
      await kv.setItemAsync('pos.paired', JSON.stringify(old));
      expect(await store.paired(), JSON.stringify(old)).toEqual({ host: 'vm-1001.lnvps.cloud', name: 'Till 1', wallet: '' });
    }
  });

  it("takes a server's new address, keeping the name, and nothing while unpaired", async () => {
    const store = new PosStore(memory());
    await store.setHost('vm-1003.lnvps.cloud');
    expect(await store.paired()).toBeNull();
    await store.savePaired({ host: 'vm-1001.lnvps.cloud', name: 'Till 1' });
    await store.setHost('vm-1003.lnvps.cloud');
    expect(await store.paired()).toEqual({ host: 'vm-1003.lnvps.cloud', name: 'Till 1', wallet: '' });
  });

  it('forgets the shop when unpaired, and keeps the sound switch', async () => {
    const store = new PosStore(memory());
    await store.savePaired({ host: 'vm-1001.lnvps.cloud', name: 'Till 1' });
    await store.setSound(false);
    await store.forget();
    expect(await store.paired()).toBeNull();
    expect(await store.sound()).toBe(false);
  });

  it('plays the sound unless it was turned off', async () => {
    const store = new PosStore(memory());
    expect(await store.sound()).toBe(true);
    await store.setSound(false);
    expect(await store.sound()).toBe(false);
    await store.setSound(true);
    expect(await store.sound()).toBe(true);
  });

  it("reads as unpaired what isn't a shop: a host that is no host, a name that is none, or text that isn't JSON", async () => {
    for (const kept of ['{"host":"evil.example.com/x","name":"Till 1"}', '{"host":"vm-1001.lnvps.cloud"}', '{"host":"vm-1001.lnvps.cloud","name":""}', 'not json', '[]', 'null']) {
      const kv = memory();
      kv.items.set('pos.paired', kept);
      expect(await new PosStore(kv).paired(), kept).toBeNull();
    }
  });

  it('refuses to keep a host that is no host', async () => {
    const store = new PosStore(memory());
    await expect(store.savePaired({ host: 'https://vm-1001.lnvps.cloud', name: 'Till 1' })).rejects.toThrow('not a server');
    await store.savePaired({ host: 'vm-1001.lnvps.cloud', name: 'Till 1' });
    await expect(store.setHost('localhost')).rejects.toThrow('not a server');
    expect(await store.paired()).toEqual({ host: 'vm-1001.lnvps.cloud', name: 'Till 1', wallet: '' });
  });

  // Android keeps the link that first opened the app and hands it over again whenever it remakes the app (from
  // Recents, or from the icon after it killed the app): a link the person has answered is never put to them twice.
  it('remembers the pairing links that were answered, by a mark and never the code, the last eight of them', async () => {
    const kv = memory();
    const store = new PosStore(kv);
    const code = (n: number) => String(n).padStart(32, '0');
    expect(await store.answered(code(1))).toBe(false);
    await store.markAnswered(code(1));
    expect(await new PosStore(kv).answered(code(1))).toBe(true);
    expect(await store.answered(code(2))).toBe(false);
    expect([...kv.items.values()].join(' ')).not.toContain(code(1));
    for (let n = 2; n <= 9; n++) await store.markAnswered(code(n));
    expect(await store.answered(code(9))).toBe(true);
    expect(await store.answered(code(2))).toBe(true);
    expect(await store.answered(code(1))).toBe(false);
    await store.markAnswered(code(9));
    expect(await store.answered(code(2))).toBe(true);
  });

  it('reads anything else kept there as no links answered, and outlives Unpair', async () => {
    const kv = memory();
    const store = new PosStore(kv);
    kv.items.set('pos.answered', '{"not":"a list"}');
    expect(await store.answered('a'.repeat(32))).toBe(false);
    kv.items.set('pos.answered', 'not json');
    expect(await store.answered('a'.repeat(32))).toBe(false);
    await store.markAnswered('a'.repeat(32));
    await store.forget();
    expect(await store.answered('a'.repeat(32))).toBe(true);
  });
});
