import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { readCard } from '../cards/read';
import { CardError } from '../ntag424/apdu';
import { Ntag424 } from '../ntag424/card';
import { ndefFile, urlOf } from '../ntag424/ndef';
import { PhoneCardTag } from './phoneCardTag';

const url = (i: number) => `lnurlw://vm-1.lnvps.cloud/ln?p=${String(i).padStart(32, '0')}&c=${String(i).padStart(16, '0')}`;
const files = (n: number, from = 0) => Array.from({ length: n }, (_, i) => bytesToHex(ndefFile(url(from + i)).file));
const SELECT_APP = '00a4040007d276000085010100';
const SELECT_CC = '00a4000c02e103';
const SELECT_NDEF = '00a4000c02e104';

function tag(n = 3) {
  const t = new PhoneCardTag();
  t.load(files(n));
  const send = async (hex: string) => bytesToHex(await t.transceive(hexToBytes(hex)));
  return { t, send };
}

// The rules of the card service's Kotlin class, in TypeScript:
// card-native's own tests hold the Kotlin to the same answers.
describe("the stand-in for a phone's card service", () => {
  it('answers as an NFC Forum Type 4 tag: the application, its capability file, its NDEF file', async () => {
    const { send } = tag();
    expect(await send(SELECT_APP)).toBe('9000');
    expect(await send(SELECT_CC)).toBe('9000');
    // CCLEN 15, mapping 2.0, MLe 255, MLc 52; the NDEF file E104, up to 256 bytes, read free, never written.
    expect(await send('00b000000f')).toBe('000f2000ff00340406e104010000ff9000');
    expect(await send(SELECT_NDEF)).toBe('9000');
    const file = ndefFile(url(0)).file;
    expect(await send('00b0000002')).toBe(`${bytesToHex(file.subarray(0, 2))}9000`);
    expect(await send(`00b00002${(file.length - 2).toString(16).padStart(2, '0')}`)).toBe(`${bytesToHex(file.subarray(2))}9000`);
  });

  it('takes the select with or without its last byte, and any P2 for a file', async () => {
    const { send } = tag();
    expect(await send('00a4040007d2760000850101')).toBe('9000');
    expect(await send('00a4000002e10400')).toBe('9000');
    expect(await send('00a4000c02e103')).toBe('9000');
  });

  it('hands out the next file at each select of the NDEF file, and counts them', async () => {
    const { t } = tag(3);
    const read = async () => urlOf(await new Ntag424(t.transceive).readNdefFile());
    expect([t.given, t.left]).toEqual([0, 3]);
    expect(await read()).toBe(url(0));
    expect([t.given, t.left]).toEqual([1, 2]);
    expect(await read()).toBe(url(1));
    expect(await read()).toBe(url(2));
    expect([t.given, t.left]).toEqual([3, 0]);
  });

  it('tells each file it hands out, with how many were given and are left', async () => {
    const { t, send } = tag(2);
    const told: [number, number][] = [];
    t.onGiven = (given, left) => told.push([given, left]);
    await send(SELECT_APP);
    await send(SELECT_CC);
    expect(told).toEqual([]);
    await send(SELECT_NDEF);
    await send(SELECT_NDEF);
    expect(told).toEqual([[1, 1], [2, 0]]);
  });

  it('refuses the NDEF file when none is left, and then the application too: a reader finds no Bolt Card', async () => {
    const { t, send } = tag(1);
    await send(SELECT_APP);
    await send(SELECT_NDEF);
    expect(await send(SELECT_NDEF)).toBe('6a82');
    // What was selected is gone with the refusal: nothing is read twice.
    expect(await send('00b0000002')).toBe('6986');
    expect(await send(SELECT_APP)).toBe('6a82');
    expect(await send(SELECT_CC)).toBe('6a82');
    expect(t.given).toBe(1);
  });

  it('has nothing to give before it is loaded, and after it is cleared', async () => {
    const empty = new PhoneCardTag();
    expect(bytesToHex(await empty.transceive(hexToBytes(SELECT_APP)))).toBe('6a82');
    const { t, send } = tag(3);
    await send(SELECT_APP);
    await send(SELECT_NDEF);
    expect(t.clear()).toBe(1);
    expect([t.given, t.left]).toEqual([0, 0]);
    expect(await send('00b0000002')).toBe('6986');
    expect(await send(SELECT_APP)).toBe('6a82');
  });

  it('adds files after the ones it has, and a load replaces them and starts the count again', async () => {
    const { t } = tag(1);
    const read = async () => urlOf(await new Ntag424(t.transceive).readNdefFile());
    t.add(files(1, 7));
    expect(t.left).toBe(2);
    expect([await read(), await read()]).toEqual([url(0), url(7)]);
    expect(t.given).toBe(2);
    t.load(files(2, 20));
    expect([t.given, t.left]).toEqual([0, 2]);
    expect(await read()).toBe(url(20));
  });

  it('reads zeros past the end of a file, and refuses a read that begins past it or with no file selected', async () => {
    const { send } = tag();
    await send(SELECT_APP);
    expect(await send('00b0000002')).toBe('6986');
    await send(SELECT_CC);
    expect(await send('00b0000d04')).toBe('00ff00009000');
    expect(await send('00b0000f02')).toBe('00009000');
    expect(await send('00b0001002')).toBe('6b00');
  });

  it('refuses everything else: another application, a file before the application, another file, and the NTAG 424 commands', async () => {
    const { send } = tag();
    expect(await send(SELECT_NDEF)).toBe('6a82');
    expect(await send('00a4040007a000000003101000')).toBe('6a82');
    await send(SELECT_APP);
    expect(await send('00a4000c02e105')).toBe('6a82');
    expect(await send('00a4000c01e1')).toBe('6a82');
    expect(await send('90640000010000')).toBe('6e00');
    expect(await send('90f50000010200')).toBe('6e00');
    expect(await send('9060000000')).toBe('6e00');
    expect(await send('00d6000002abcd')).toBe('6d00');
    expect(await send('00')).toBe('6700');
  });

  it('forgets what was selected when the reader goes, and keeps its files', async () => {
    const { t, send } = tag(2);
    await send(SELECT_APP);
    await send(SELECT_NDEF);
    t.deactivated();
    expect(await send('00b0000002')).toBe('6986');
    expect([t.given, t.left]).toEqual([1, 1]);
  });

  it("is read in four commands by a plain read, and refused by the app's readCard at the first key version", async () => {
    const { t } = tag();
    expect(urlOf(await new Ntag424(t.transceive).readNdefFile())).toBe(url(0));
    expect(t.seen).toHaveLength(4);
    t.seen.length = 0;
    const refused = await readCard(new Ntag424(t.transceive)).catch((e) => e);
    expect(refused).toBeInstanceOf(CardError);
    expect((refused as CardError).command).toBe('GetKeyVersion');
    expect(t.seen).toEqual([SELECT_APP, '9064000001' + '00' + '00']);
  });
});
