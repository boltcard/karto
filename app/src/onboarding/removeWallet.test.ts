import { describe, expect, it } from 'vitest';
import { deviceKey } from '../native/deviceKey';
import { phraseStore } from '../store/secrets';
import { AppStore } from '../store/store';
import { nodeSqlite } from '../testing/nodeSqlite';
import { initialState } from './machine';
import { adoptPhrase } from './phrase';
import { removalFailed, RemovalError, removeWallet } from './removeWallet';
import { RunnerSlot } from './runner';

// Taking a wallet off an iPhone, which keeps it when the app is deleted.
/** The things a removal acts on, each of which can be made to fail; did: what was done, in order. */
function phone(failing: string[] = []) {
  const did: string[] = [];
  const step = (name: string) => async () => {
    if (failing.includes(name)) throw new Error(`${name}: no`);
    did.push(name);
  };
  return {
    did,
    failing,
    job: { unregister: step('the job') },
    store: { clear: step('the database') },
    backups: { removeAll: step('the backups') },
    deviceKey: { remove: step('the key') },
    phrase: { remove: step('the phrase') },
    forget: () => void did.push('forget'),
  };
}

describe('removeWallet', () => {
  it('takes what the app remembers, then the key, then the phrase last', async () => {
    const p = phone();
    await removeWallet(p);
    expect(p.did).toEqual(['forget', 'the job', 'the database', 'the backups', 'the key', 'the phrase']);
  });

  it.each([
    ['the job', 'memory', ['forget']],
    ['the database', 'memory', ['forget', 'the job']],
    ['the backups', 'memory', ['forget', 'the job', 'the database']],
    ['the key', 'key', ['forget', 'the job', 'the database', 'the backups']],
    ['the phrase', 'phrase', ['forget', 'the job', 'the database', 'the backups', 'the key']],
  ] as const)('stops where %s fails, says which step, and touches nothing after it', async (fails, step, done) => {
    const p = phone([fails]);
    const e = await removeWallet(p).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RemovalError);
    expect((e as RemovalError).step).toBe(step);
    expect(p.did).toEqual(done);
    expect(p.did).not.toContain('the phrase');
  });

  // Before anything is removed: the watch and the onboarding runner drop the answers still on their way to them,
  // so none is written back into a database just emptied, and no screen goes on showing the wallet.
  it('first lets go of what the running app holds, whatever happens after', async () => {
    for (const fails of [[], ['the job'], ['the database'], ['the backups'], ['the key'], ['the phrase']]) {
      const p = phone(fails);
      await removeWallet(p).catch(() => {});
      expect(p.did[0]).toBe('forget');
      expect(p.did.filter((x) => x === 'forget')).toHaveLength(1);
    }
  });

  it('finishes when it is run again after a failure', async () => {
    const p = phone(['the key']);
    await expect(removeWallet(p)).rejects.toBeInstanceOf(RemovalError);
    p.failing.length = 0;
    p.did.length = 0;
    await removeWallet(p);
    expect(p.did).toEqual(['forget', 'the job', 'the database', 'the backups', 'the key', 'the phrase']);
  });

  it('says what could not be removed, and that the phrase is still there', async () => {
    const said = async (fails: string) => removalFailed(await removeWallet(phone([fails])).then(() => null, (x: unknown) => x));
    expect(await said('the database')).toBe(
      "Couldn't remove everything from this iPhone: what the app remembers (the database: no). Your recovery phrase is still here. Try again.",
    );
    expect(await said('the key')).toBe("Couldn't remove everything from this iPhone: this phone's key (the key: no). Your recovery phrase is still here. Try again.");
    expect(await said('the phrase')).toBe("Couldn't remove everything from this iPhone: the recovery phrase (the phrase: no). Your recovery phrase is still here. Try again.");
    expect(removalFailed(new Error('odd'))).toBe("Couldn't remove everything from this iPhone: odd. Your recovery phrase is still here. Try again.");
  });
});

// The real store, phrase store and key, over stand-ins for the phone beneath them.
describe('a new wallet after a removal, in one run of the app', () => {
  const OLD = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const NEW = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

  /** An iPhone: a Keychain that holds the phrase, a key that can be deleted and is another one when made again, the app's database. */
  async function iphone() {
    const keychain = new Map<string, string>();
    const secure = {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
      getItemAsync: async (k: string) => keychain.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => void keychain.set(k, v),
      deleteItemAsync: async (k: string) => void keychain.delete(k),
    };
    const enclave = { key: null as string | null, made: 0 };
    const key = deviceKey({
      deviceKeyCreate: async () => (enclave.key ??= `04${String(++enclave.made).padStart(2, '0').repeat(64)}`),
      devicePublicKey: async () => {
        if (enclave.key === null) throw Object.assign(new Error('no device key'), { code: 'ERR_NO_DEVICE_KEY' });
        return enclave.key;
      },
      deviceSign: async () => '30',
      deviceKeyDelete: async () => void (enclave.key = null),
    });
    const store = await AppStore.open(nodeSqlite());
    const phrase = phraseStore(secure, { outlivesApp: true });
    const runners = new RunnerSlot();
    const kept = { backups: ['cardd-1.age'], job: true };
    const remove = () =>
      removeWallet({
        job: { unregister: async () => void (kept.job = false) },
        store,
        backups: { removeAll: async () => void (kept.backups = []) },
        deviceKey: key,
        phrase,
        forget: () => runners.reset(),
      });
    return { store, phrase, deviceKey: key, kept, remove };
  }

  it('is saved with none of the old wallet: its server, its cards, its pairing, its key', async () => {
    const p = await iphone();
    await adoptPhrase(OLD, p);
    const oldKey = await p.deviceKey.publicKeyHex();
    await p.store.saveOnboarding({ ...initialState('GBR'), step: 'done', vmId: 1001 });
    await p.store.saveCard({ id: 'ab'.repeat(16), version: 0, name: 'Groceries', state: 'active' });
    await p.store.saveBackupRecipient('age1old');
    await p.store.setRevoked(true);

    await p.remove();
    expect(await p.phrase.get()).toBeNull();
    await expect(p.deviceKey.publicKeyHex()).rejects.toThrow('no device key');
    expect(p.kept).toEqual({ backups: [], job: false });

    await adoptPhrase(NEW, p);
    expect(await p.phrase.get()).toBe(NEW);
    expect(await p.store.onboarding()).toEqual(initialState());
    expect([await p.store.cards(), await p.store.backupRecipient(), await p.store.revoked()]).toEqual([{}, null, false]);
    const newKey = await p.deviceKey.publicKeyHex();
    expect(newKey).not.toBe(oldKey);
  });

  // The phrase store never replaces a phrase: a removal that stopped before it leaves the old wallet's, and no new one can be laid over it.
  it('cannot be started over a removal that stopped before the phrase', async () => {
    const p = await iphone();
    await adoptPhrase(OLD, p);
    await p.remove();
    await adoptPhrase(OLD, p);
    const phrase = { remove: async () => Promise.reject(new Error('errSecInteractionNotAllowed')) };
    await expect(removeWallet({ job: { unregister: async () => {} }, store: p.store, backups: { removeAll: async () => {} }, deviceKey: p.deviceKey, phrase, forget: () => {} }))
      .rejects.toMatchObject({ step: 'phrase' });
    await expect(adoptPhrase(NEW, p)).rejects.toThrow();
    expect(await p.phrase.get()).toBe(OLD);
    expect(await p.store.onboarding()).toBeNull();
  });
});
