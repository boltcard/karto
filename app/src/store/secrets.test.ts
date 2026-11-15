import { describe, expect, it } from 'vitest';
import { phraseStore, type SecureStoreApi } from './secrets';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

/**
 * expo-secure-store, as much of it as the phrase store uses. deletes: false makes its delete do nothing. android: its
 * Kotlin module exports no constants, so the rule's name is undefined there.
 */
function fake(o: { deletes?: boolean; android?: boolean } = {}) {
  const items = new Map<string, string>();
  const rules: (number | undefined)[] = [];
  const ss: SecureStoreApi = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: o.android ? undefined : 7,
    getItemAsync: async (key) => items.get(key) ?? null,
    setItemAsync: async (key, value, options) => {
      items.set(key, value);
      rules.push(options?.keychainAccessible);
    },
    deleteItemAsync: async (key) => {
      if (o.deletes !== false) items.delete(key);
    },
  };
  return { ss, items, rules };
}

describe('phraseStore', () => {
  it('keeps the phrase so it never leaves the phone it is on', async () => {
    const f = fake();
    await phraseStore(f.ss).set(`  ${PHRASE.toUpperCase()} `);
    expect([...f.items]).toEqual([['recovery-phrase', PHRASE]]);
    expect(f.rules).toEqual([7]);
    expect(await phraseStore(f.ss).get()).toBe(PHRASE);
  });

  // Android has no such rule and no such constant: the phrase is stored as it always was there.
  it('stores the phrase on a phone whose secure store names no rule', async () => {
    const f = fake({ android: true });
    await phraseStore(f.ss).set(PHRASE);
    expect([...f.items]).toEqual([['recovery-phrase', PHRASE]]);
    expect(f.rules).toEqual([undefined]);
  });

  it('never replaces a phrase, and takes only a valid one', async () => {
    const f = fake();
    const store = phraseStore(f.ss);
    await expect(store.set('not twelve words')).rejects.toThrow('not a valid recovery phrase');
    await store.set(PHRASE);
    await expect(store.set(PHRASE)).rejects.toThrow('this app already has a recovery phrase');
  });

  // An iPhone's Keychain keeps it when the app is deleted.
  it('says whether what it holds outlives the app, as it was built', () => {
    expect(phraseStore(fake().ss).outlivesApp).toBe(false);
    expect(phraseStore(fake().ss, { outlivesApp: true }).outlivesApp).toBe(true);
  });

  it('removes the phrase and reads it back gone', async () => {
    const f = fake();
    const store = phraseStore(f.ss, { outlivesApp: true });
    await store.set(PHRASE);
    await store.remove();
    expect(await store.get()).toBeNull();
    // With none to remove it is as done.
    await store.remove();
  });

  it('fails a removal that left the phrase where it was', async () => {
    const f = fake({ deletes: false });
    const store = phraseStore(f.ss, { outlivesApp: true });
    await store.set(PHRASE);
    await expect(store.remove()).rejects.toThrow('the recovery phrase is still on this phone');
    expect(await store.get()).toBe(PHRASE);
  });
});
