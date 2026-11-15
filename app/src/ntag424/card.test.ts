// Ntag424's commands, byte for byte against fixed vectors (AN12196's session).
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { CardError, TagLostError, type Transceive } from './apdu';
import { Ntag424 } from './card';
import { ZERO_KEY } from './crypto';
import { sunFileSettings, FACTORY_FILE_SETTINGS } from './ndef';

const RNDA = hexToBytes('13C5DB8A5930439FC3DEF9A4C675360F');

/** A card that expects exactly these commands, in order, and gives these answers. */
function script(pairs: [string, string][]): { tx: Transceive; done: () => void } {
  let i = 0;
  const tx: Transceive = async (apdu) => {
    const [want, answer] = pairs[i++] ?? ['(no more commands)', ''];
    expect(bytesToHex(apdu).toUpperCase()).toBe(want);
    if (answer === 'LOST') throw new TagLostError();
    return hexToBytes(answer);
  };
  return { tx, done: () => expect(i).toBe(pairs.length) };
}

const AUTH: [string, string][] = [
  ['00A4040007D276000085010100', '9000'],
  ['9071000005000300000000', 'A04C124213C186F22399D33AC2A3021591AF'],
  ['90AF00002035C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D00',
    '3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100'],
];

const card = (tx: Transceive) => new Ntag424(tx, { random: () => RNDA.slice() });

describe('Ntag424', () => {
  it('runs AN12196\'s session: GetCardUID, SUN settings, random UID, ChangeKey 1, then ChangeKey 0', async () => {
    const s = script([
      ...AUTH,
      ['905100000839D419D352B6385600', 'D21E1B2F95F8219DA0A25C72470020BB534C75D8548AF3039100'],
      ['905F00001902F00AF9A763ACA7646468EA5B2CCC6AEC99D80F98C4AEB48400', '57BFF87B1241E93D9100'],
      ['905C000019009D1976736ADE2D28E4EB44C91F0F2AE43EDC7A2D2E127E9500', '6B3573A7F0F695AB9100'],
      ['90C400002901016A4C57EC3543653627877AAAC77E19895075AE51E29499A2143FE1F2A5CD8D88E0987043FBAE1600', '18141200E0420D1C9100'],
      ['90C400002900BEE1D6108DA10E1EFA8DA4373260596E3DCCDA87276D2133A21CE23B035255395F33A8421DEC16F700', '9100'],
    ]);
    const c = card(s.tx);
    await c.authenticate(0, ZERO_KEY);
    expect(c.authenticated).toBe(true);
    expect(bytesToHex(await c.getCardUid())).toBe('04a39493cc8680');
    await c.changeFileSettings(sunFileSettings(41, 76));
    await c.enableRandomUid();
    await c.changeKey(1, ZERO_KEY, hexToBytes('000102030405060708090A0B0C0D0E0F'), 1);
    await c.changeKey(0, ZERO_KEY, hexToBytes('F0F1F2F3F4F5F6F7F8F9FAFBFCFDFEFF'), 1);
    expect(c.authenticated).toBe(false); // changing the session's own key ends it
    s.done();
  });

  it('resets the file settings in a fresh session', async () => {
    const s = script([...AUTH, ['905F00001902A5231CD6BE0FD8FA6493689585DB571682FA8C6E7CF1070000', 'FC222E5F7A5424529100']]);
    const c = card(s.tx);
    await c.authenticate(0, ZERO_KEY);
    await c.changeFileSettings(FACTORY_FILE_SETTINGS);
    s.done();
  });

  it('reads a key version plainly, or MACed inside a session', async () => {
    const s = script([['90640000010100', '009100'], ...AUTH, ['90640000090152D503AAFACF588C00', '0130663868C0321F4A9100']]);
    const c = card(s.tx);
    expect(await c.getKeyVersion(1)).toBe(0);
    await c.authenticate(0, ZERO_KEY);
    expect(await c.getKeyVersion(1)).toBe(1);
    s.done();
  });

  it('refuses an answer whose MAC is wrong', async () => {
    const s = script([...AUTH, ['90640000090152D503AAFACF588C00', '0130663868C0321F4B9100']]);
    const c = card(s.tx);
    await c.authenticate(0, ZERO_KEY);
    await expect(c.getKeyVersion(1)).rejects.toThrow('failed its MAC check');
  });

  it('reads the SUN file settings, and the factory ones', async () => {
    const s = script([
      ['90F50000010200', '004000E0000100C1FF122900004C00004C00009100'],
      ['90F50000010200', '0000E0EE0001009100'],
    ]);
    const c = card(s.tx);
    expect(await c.getFileSettings()).toEqual({ sdm: true, piccOffset: 41, macOffset: 76 });
    expect(await c.getFileSettings()).toEqual({ sdm: false });
    s.done();
  });

  it('reads the NDEF file: NLEN, then the message', async () => {
    const file = '005AD1015655006C6E75726C773A2F2F766D2D313030392E6C6E7670732E636C6F75642F6C6E3F703D303030303030303030303030303030303030303030303030303030303030303026633D30303030303030303030303030303030';
    const s = script([
      ['00A4040007D276000085010100', '9000'],
      ['00A4000002E10400', '9000'],
      ['00B0000002', '005A9000'],
      ['00B000025A', `${file.slice(4)}9000`],
    ]);
    expect(bytesToHex(await card(s.tx).readNdefFile()).toUpperCase()).toBe(file);
    s.done();
  });

  it('reads an empty NDEF file without a second read', async () => {
    const s = script([['00A4040007D276000085010100', '9000'], ['00A4000002E10400', '9000'], ['00B0000002', '00009000']]);
    expect(bytesToHex(await card(s.tx).readNdefFile())).toBe('0000');
    s.done();
  });

  it('writes the NDEF file with WriteData at offset 0', async () => {
    const s = script([['908D00000A0200000003000000010000', '9100']]);
    await card(s.tx).writeNdef(Uint8Array.of(0, 1, 0));
    s.done();
  });

  it('ends the session and names the status when the card refuses', async () => {
    const s = script([AUTH[0], AUTH[1], [AUTH[2][0], '91AE']]);
    const c = card(s.tx);
    const err = await c.authenticate(0, ZERO_KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CardError);
    expect(err).toMatchObject({ command: 'AuthenticateEV2First', sw: 0x91ae });
    expect(err.message).toBe('AuthenticateEV2First: the card answered 91AE (authentication error)');
    expect(c.authenticated).toBe(false);
  });

  it('passes a lifted card on as TagLostError', async () => {
    const s = script([['00A4040007D276000085010100', 'LOST']]);
    await expect(card(s.tx).selectApp()).rejects.toBeInstanceOf(TagLostError);
  });

  it('reads GetVersion\'s three frames', async () => {
    const s = script([
      ['9060000000', '0404023000110591AF'],
      ['90AF000000', '0404020101110591AF'],
      ['90AF000000', '04A39493CC8680CF39D449803E21209100'],
    ]);
    expect(await card(s.tx).getVersion()).toEqual({ vendor: 0x04, type: 0x04, uid: hexToBytes('04a39493cc8680') });
    s.done();
  });
});
