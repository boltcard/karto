// NTAG 424 DNA commands (NT4H2421Gx datasheet) over a Transceive. One instance
// per tap: it holds the authenticated session, if any. Native commands are
// wrapped ISO 7816-4 style: 90 INS 00 00 Lc data 00.
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { CardError, splitResponse, SW, type Transceive } from './apdu';
import {
  authReply, authTi, cmdMac, decryptRsp, encryptCmd, equalBytes, jamcrc32, le24, rspMac, sessionKeys, type Session,
} from './crypto';

export type FileSettings = { sdm: boolean; piccOffset?: number; macOffset?: number };

const native = (ins: number, data: Uint8Array = new Uint8Array(0)) =>
  data.length === 0 ? Uint8Array.of(0x90, ins, 0, 0, 0) : concatBytes(Uint8Array.of(0x90, ins, 0, 0, data.length), data, Uint8Array.of(0));

const xor = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v ^ b[i]);

export class Ntag424 {
  private session?: Session;
  private readonly random: (n: number) => Uint8Array;

  constructor(private readonly tx: Transceive, o: { random?: (n: number) => Uint8Array } = {}) {
    this.random = o.random ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  }

  get authenticated(): boolean {
    return this.session !== undefined;
  }

  /** Sends a command; any status but the expected ones is a CardError, and ends the session. */
  private async send(command: string, apdu: Uint8Array, ok: number[] = [SW.OK]): Promise<{ data: Uint8Array; sw: number }> {
    const r = splitResponse(command, await this.tx(apdu));
    if (!ok.includes(r.sw)) {
      this.session = undefined;
      throw new CardError(command, r.sw);
    }
    return r;
  }

  private need(command: string): Session {
    if (!this.session) throw new Error(`${command} needs an authenticated session`);
    return this.session;
  }

  private checkMac(s: Session, body: Uint8Array, mac: Uint8Array) {
    if (!equalBytes(mac, rspMac(s, s.ctr, body))) {
      this.session = undefined;
      throw new Error("the card's answer failed its MAC check");
    }
  }

  /** CommMode.MAC: command MACed, answer MACed. Returns the answer's data. */
  private async macCommand(command: string, ins: number, header: Uint8Array): Promise<Uint8Array> {
    const s = this.need(command);
    const { data } = await this.send(command, native(ins, concatBytes(header, cmdMac(s, s.ctr, ins, header))));
    s.ctr++;
    const body = data.subarray(0, data.length - 8);
    this.checkMac(s, body, data.subarray(data.length - 8));
    return body;
  }

  /** CommMode.Full: data encrypted, command MACed. Returns the raw answer (the caller checks it). */
  private async fullCommand(command: string, ins: number, header: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const s = this.need(command);
    const enc = encryptCmd(s, s.ctr, data);
    const mac = cmdMac(s, s.ctr, ins, concatBytes(header, enc));
    const r = await this.send(command, native(ins, concatBytes(header, enc, mac)));
    s.ctr++;
    return r.data;
  }

  /** A CommMode.Full command whose answer is only a MAC. */
  private async fullNoData(command: string, ins: number, header: Uint8Array, data: Uint8Array): Promise<void> {
    const r = await this.fullCommand(command, ins, header, data);
    this.checkMac(this.need(command), new Uint8Array(0), r);
  }

  async selectApp(): Promise<void> {
    this.session = undefined;
    await this.send('SelectApplication', hexToBytes('00a4040007d276000085010100'), [SW.ISO_OK]);
  }

  async getVersion(): Promise<{ vendor: number; type: number; uid: Uint8Array }> {
    const hw = await this.send('GetVersion', native(0x60), [SW.MORE]);
    await this.send('GetVersion', native(0xaf), [SW.MORE]);
    const prod = await this.send('GetVersion', native(0xaf));
    return { vendor: hw.data[0], type: hw.data[1], uid: prod.data.slice(0, 7) };
  }

  async getKeyVersion(keyNo: number): Promise<number> {
    if (this.session) return (await this.macCommand('GetKeyVersion', 0x64, Uint8Array.of(keyNo)))[0];
    return (await this.send('GetKeyVersion', native(0x64, Uint8Array.of(keyNo)))).data[0];
  }

  /**
   * File 2's settings: FileType, FileOption, AccessRights(2), FileSize(3), then
   * with SDM on: SDMOptions, SDMAccessRights(2), PICCDataOffset(3) (meta read
   * is a key), SDMMACInputOffset(3) and SDMMACOffset(3) (file read is a key).
   */
  async getFileSettings(): Promise<FileSettings> {
    const d = this.session
      ? await this.macCommand('GetFileSettings', 0xf5, Uint8Array.of(0x02))
      : (await this.send('GetFileSettings', native(0xf5, Uint8Array.of(0x02)))).data;
    if (!(d[1] & 0x40)) return { sdm: false };
    const metaRead = d[9] >> 4;
    const fileRead = d[9] & 0x0f;
    if (metaRead > 4 || fileRead > 4) return { sdm: true };
    const at = (i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
    return { sdm: true, piccOffset: at(10), macOffset: at(16) };
  }

  /**
   * NLEN, then that many bytes (or up to minLength, if more): indexes in the
   * result are file offsets. minLength lets a reader reach SUN offsets past a
   * shorter URL (a re-point cut between its two writes). Selecting ends any session.
   */
  async readNdefFile(minLength = 0): Promise<Uint8Array> {
    await this.selectApp();
    await this.send('SelectNdefFile', hexToBytes('00a4000002e10400'), [SW.ISO_OK]);
    const head = (await this.send('ReadBinary', hexToBytes('00b0000002'), [SW.ISO_OK])).data;
    const n = Math.max((head[0] << 8) | head[1], minLength - 2);
    if (n <= 0) return head.slice(0, 2);
    if (n > 254) throw new CardError('ReadBinary', 0x6700);
    const body = (await this.send('ReadBinary', Uint8Array.of(0x00, 0xb0, 0x00, 0x02, n), [SW.ISO_OK])).data;
    return concatBytes(head.subarray(0, 2), body);
  }

  async readData(offset: number, length: number): Promise<Uint8Array> {
    const r = await this.send('ReadData', native(0xad, concatBytes(Uint8Array.of(0x02), le24(offset), le24(length))));
    if (this.session) this.session.ctr++;
    return r.data;
  }

  /** AuthenticateEV2First with keyNo (selects the application first). */
  async authenticate(keyNo: number, key: Uint8Array): Promise<void> {
    await this.selectApp();
    const rndA = this.random(16);
    const first = await this.send('AuthenticateEV2First', native(0x71, Uint8Array.of(keyNo, 0x03, 0, 0, 0)), [SW.MORE]);
    const { rndB, message } = authReply(key, rndA, first.data);
    const second = await this.send('AuthenticateEV2First', native(0xaf, message));
    const ti = authTi(key, rndA, second.data);
    this.session = { keyNo, ...sessionKeys(key, rndA, rndB), ti, ctr: 0 };
  }

  async getCardUid(): Promise<Uint8Array> {
    const s = this.need('GetCardUID');
    const { data } = await this.send('GetCardUID', native(0x51, cmdMac(s, s.ctr, 0x51, new Uint8Array(0))));
    s.ctr++;
    const enc = data.subarray(0, data.length - 8);
    this.checkMac(s, enc, data.subarray(data.length - 8));
    return decryptRsp(s, s.ctr, enc).slice(0, 7);
  }

  /** Needs a key 0 session. Changing the session's own key ends the session (no MAC comes back). */
  async changeKey(keyNo: number, oldKey: Uint8Array, newKey: Uint8Array, version: number): Promise<void> {
    const s = this.need('ChangeKey');
    const own = keyNo === s.keyNo;
    const data = own
      ? concatBytes(newKey, Uint8Array.of(version))
      : concatBytes(xor(newKey, oldKey), Uint8Array.of(version), jamcrc32(newKey));
    const r = await this.fullCommand('ChangeKey', 0xc4, Uint8Array.of(keyNo), data);
    if (own) {
      this.session = undefined;
      return;
    }
    this.checkMac(s, new Uint8Array(0), r);
  }

  changeFileSettings(settings: Uint8Array): Promise<void> {
    return this.fullNoData('ChangeFileSettings', 0x5f, Uint8Array.of(0x02), settings);
  }

  /** SetConfiguration option 00, bit 1: random UID. Permanent. */
  enableRandomUid(): Promise<void> {
    return this.fullNoData('SetConfiguration', 0x5c, Uint8Array.of(0x00), Uint8Array.of(0x02));
  }

  /** WriteData to file 2 at offset 0, CommMode.Plain (the file's mode). Inside a session it still counts. */
  async writeNdef(file: Uint8Array): Promise<void> {
    await this.send('WriteData', native(0x8d, concatBytes(Uint8Array.of(0x02), le24(0), le24(file.length), file)));
    if (this.session) this.session.ctr++;
  }
}
