import { describe, expect, it } from 'vitest';
import type { ServerStatus } from '../cardd/status';
import { NO_KEY_HERE, PAIR_AGAIN, pairAgain, REVOKED_HERE } from './pairAgain';

const OK: ServerStatus = { kind: 'ok', version: '0.7.0', updateAvailable: false };
const NO_KEY: ServerStatus = { kind: 'not_paired', noKey: true, message: 'This phone has no device key (was the app restored from a backup?). Pairing again comes with restore.' };
const REFUSED: ServerStatus = { kind: 'not_paired', message: "The server does not accept this phone's key: unknown key" };
const here = (status: ServerStatus | null, revoked = false) => pairAgain({ outlivesApp: true, status, revoked });

// A phone whose phrase outlives the app says what happened and offers one button.
describe('pairAgain', () => {
  it('says the key is lost, which no backup holds, on a phone with its phrase and no key', () => {
    expect(here(NO_KEY)).toEqual({ text: 'This iPhone has your recovery phrase but has lost its own key, which no backup holds.' });
    expect(NO_KEY_HERE).toBe(here(NO_KEY)!.text);
  });

  it("says another phone restored the server once that is known, whatever the server's answer was", () => {
    const text = 'Another phone restored this server, and this iPhone is no longer paired with it.';
    expect(here(REFUSED, true)).toEqual({ text });
    expect(here(OK, true)).toEqual({ text });
    expect(here(null, true)).toEqual({ text });
    expect(here({ kind: 'unreachable', message: 'no answer' }, true)).toEqual({ text });
    expect(REVOKED_HERE).toBe(text);
  });

  // A phone with no key can't have been told anything by the server: the lost key is what it can put right.
  it('names the lost key first when both are so', () => {
    expect(here(NO_KEY, true)).toEqual({ text: NO_KEY_HERE });
  });

  it("gives the server's own refusal before the backups check has named the restore", () => {
    expect(here(REFUSED)).toEqual({ text: "The server does not accept this phone's key: unknown key" });
  });

  it('offers nothing to a paired phone, one not yet checked or one out of reach', () => {
    expect(here(OK)).toBeNull();
    expect(here(null)).toBeNull();
    expect(here({ kind: 'unreachable', message: 'no answer' })).toBeNull();
  });

  it("offers nothing where the phrase goes with the app: Android's words stand", () => {
    for (const status of [NO_KEY, REFUSED, OK, null]) {
      expect(pairAgain({ outlivesApp: false, status, revoked: false })).toBeNull();
      expect(pairAgain({ outlivesApp: false, status, revoked: true })).toBeNull();
    }
  });

  it('names its button, the line under it and the lock', () => {
    expect(PAIR_AGAIN).toEqual({
      button: 'Pair this iPhone again',
      line: 'Your other phones are unpaired; Karto PoS phones stay.',
      lockTitle: 'Pair this iPhone again',
    });
  });
});
