// The recovery phrase, in expo-secure-store (encrypted with an Android
// Keystore key). expo-secure-store keeps its data out of Android's backup,
// since a restored copy could never be decrypted: after a restore the app
// has state but no phrase, and must ask for it. On an iPhone
// it is a Keychain item, which stays when the app is deleted.
import { isValidPhrase, normalisePhrase } from '../keys/derive';

/** The part of expo-secure-store this module uses. */
export type SecureStoreApi = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  /**
   * The iPhone Keychain's rule "readable while the phone is unlocked, and never off this phone". Android has no such
   * choice: its module exports no such constant (undefined at run time, whatever the library's types say) and takes
   * no notice of the option.
   */
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: number | undefined;
};

const PHRASE = 'recovery-phrase';

/**
 * outlivesApp: what the store holds stays when the app is deleted (an iPhone's Keychain), where Android deletes it
 * with the app. Everything the two phones do differently about the phrase hangs on it.
 * 
 */
export function phraseStore(ss: SecureStoreApi, o: { outlivesApp: boolean } = { outlivesApp: false }) {
  return {
    outlivesApp: o.outlivesApp,
    get: () => ss.getItemAsync(PHRASE),
    /** Stores the phrase, never to leave this phone. Never replaces one: the server, its keys and its money belong to it. */
    async set(phrase: string): Promise<void> {
      if (!isValidPhrase(phrase)) throw new Error('not a valid recovery phrase');
      if ((await ss.getItemAsync(PHRASE)) !== null) throw new Error('this app already has a recovery phrase');
      await ss.setItemAsync(PHRASE, normalisePhrase(phrase), { keychainAccessible: ss.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    },
    /** Removes the phrase, and reads it back: it must be gone, or the removal failed. */
    async remove(): Promise<void> {
      await ss.deleteItemAsync(PHRASE);
      if ((await ss.getItemAsync(PHRASE)) !== null) throw new Error('the recovery phrase is still on this phone');
    },
  };
}
