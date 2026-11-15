// A read-only look at a real blank card, run by `make phone-card-probe`:
// the NFC layer, the session crypto, and what the card allows without
// authentication, checked before anything writes to a card. It never writes,
// and never reports the UID.
import { Ntag424 } from '../ntag424/card';
import { equalBytes, ZERO_KEY } from '../ntag424/crypto';
import type { Transceive } from '../ntag424/apdu';
import type { CheckResult } from './checks';

export async function probeCard(tx: Transceive, tagUid: Uint8Array): Promise<CheckResult[]> {
  const card = new Ntag424(tx);
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  };
  const random = tagUid.length === 4;
  await check('tag', async () => `Android shows a ${tagUid.length}-byte id${random ? ' (random UID is on)' : ''}`);
  await check('select', async () => (await card.selectApp(), 'the NTAG 424 application answers'));
  await check('get-version', async () => {
    const v = await card.getVersion();
    if (v.vendor !== 0x04) throw new Error(`vendor ${v.vendor} is not NXP`);
    return `NXP, type ${v.type}`;
  });
  await check('key-versions', async () => {
    const v: number[] = [];
    for (let k = 0; k < 5; k++) v.push(await card.getKeyVersion(k));
    return `without authentication: ${v.join(' ')}`;
  });
  await check('file-settings', async () => `without authentication: ${JSON.stringify(await card.getFileSettings())}`);
  await check('ndef', async () => {
    const f = await card.readNdefFile();
    return `NDEF file read, NLEN ${(f[0] << 8) | f[1]}`;
  });
  await check('auth-zero', async () => (await card.authenticate(0, ZERO_KEY), 'the zero key opens key 0: the card is blank'));
  await check('card-uid', async () => {
    const uid = await card.getCardUid();
    if (uid.length !== 7) throw new Error(`GetCardUID gave ${uid.length} bytes`);
    if (!random && !equalBytes(uid, tagUid)) throw new Error('GetCardUID does not match the tag id');
    return random ? 'GetCardUID decrypts and its MAC checks' : 'GetCardUID decrypts, its MAC checks, and it matches the tag id';
  });
  await check('plain-in-session', async () => {
    await card.readData(0, 2);
    const v = await card.getKeyVersion(0);
    return `a plain ReadData inside the session moves the counter: the MACed GetKeyVersion after it checks (${v})`;
  });
  return results;
}
