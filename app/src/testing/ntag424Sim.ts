// A simulated NTAG 424 DNA for tests, written from the datasheet (NT4H2421Gx):
// five keys and their versions, file 2 (the NDEF file) with its settings and
// SUN mirroring, random UID, EV2First sessions with CommMode.MAC and Full, and
// the card's status words. It can drop the connection before or after any
// command, as a card lifted off the phone does.
import { cbc } from '@noble/ciphers/aes.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { sunMac } from '../boltcard/sun';
import { TagLostError, type Transceive } from '../ntag424/apdu';
import {
  cmdMac, decryptCmd, encryptRsp, equalBytes, jamcrc32, le24, rotl, rspMac, sessionKeys, type Session,
} from '../ntag424/crypto';
import { ndefFile, sunFileSettings } from '../ntag424/ndef';

type Sdm = { options: number; access: [number, number]; picc: number; macInput: number; mac: number };
type Settings = { option: number; access: [number, number]; sdm?: Sdm };

const ZERO_IV = new Uint8Array(16);
const ok = (data: Uint8Array = new Uint8Array(0), sw = 0x9100) => concatBytes(data, Uint8Array.of(sw >> 8, sw & 0xff));
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const le24At = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const NAMES: Record<number, string> = {
  0x60: 'GetVersion', 0x64: 'GetKeyVersion', 0xf5: 'GetFileSettings', 0xad: 'ReadData', 0x71: 'AuthenticateEV2First',
  0xaf: 'AdditionalFrame', 0x51: 'GetCardUID', 0xc4: 'ChangeKey', 0x5f: 'ChangeFileSettings', 0x5c: 'SetConfiguration', 0x8d: 'WriteData',
};

/** A refusal: the card answers this status word, and any session ends. */
class Refuse extends Error {
  constructor(readonly sw: number) {
    super(sw.toString(16));
  }
}

export class Ntag424Sim {
  keys: Uint8Array[] = Array.from({ length: 5 }, () => new Uint8Array(16));
  versions = [0, 0, 0, 0, 0];
  file = new Uint8Array(256);
  randomUid = false;
  readCounter = 0;
  readonly log: string[] = [];
  lift?: { at: number; when: 'before' | 'after' };
  commands = 0;
  private settings: Settings = { option: 0x00, access: [0xe0, 0xee] };
  private selected: 'none' | 'app' | 'ndef' = 'none';
  private session?: Session;
  private auth?: { keyNo: number; rndB: Uint8Array };
  private versionFrame = 0;

  constructor(readonly uid: Uint8Array = hexToBytes('04a39493cc8680')) {}

  static programmed(o: { keys: Uint8Array[]; versions: number[]; url: string; uid?: Uint8Array }): Ntag424Sim {
    const sim = new Ntag424Sim(o.uid);
    sim.keys = o.keys.map((k) => k.slice());
    sim.versions = [...o.versions];
    const n = ndefFile(o.url);
    sim.file.set(n.file);
    sim.applySettings(sunFileSettings(n.piccOffset, n.macOffset));
    return sim;
  }

  tagId(): Uint8Array {
    return this.randomUid ? concatBytes(Uint8Array.of(0x08), random(3)) : this.uid.slice();
  }

  sdm(): { piccOffset: number; macOffset: number } | null {
    return this.settings.sdm ? { piccOffset: this.settings.sdm.picc, macOffset: this.settings.sdm.mac } : null;
  }

  snapshot(): string {
    return JSON.stringify({
      keys: this.keys.map((k) => bytesToHex(k)), versions: this.versions, file: bytesToHex(this.file),
      settings: this.settings, randomUid: this.randomUid,
    });
  }

  transceive: Transceive = async (apdu) => {
    const n = this.commands++;
    const lifted = this.lift?.at === n ? this.lift.when : undefined;
    if (lifted === 'before') this.leaveField();
    if (lifted === 'before') throw new TagLostError();
    const answer = this.handle(apdu);
    if (lifted === 'after') {
      this.leaveField();
      throw new TagLostError();
    }
    return answer;
  };

  private leaveField() {
    this.selected = 'none';
    this.session = undefined;
    this.auth = undefined;
    this.versionFrame = 0;
  }

  private handle(a: Uint8Array): Uint8Array {
    try {
      if (a[0] === 0x00) return this.iso(a);
      if (a[0] !== 0x90) throw new Refuse(0x6e00);
      const data = a.length > 5 ? a.subarray(5, 5 + a[4]) : new Uint8Array(0);
      return this.native(a[1], data);
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      this.session = undefined;
      this.auth = undefined;
      return ok(new Uint8Array(0), e.sw);
    }
  }

  // --- ISO 7816-4 commands ---

  private iso(a: Uint8Array): Uint8Array {
    const ins = a[1];
    const data = a.subarray(5, 5 + a[4]);
    if (ins === 0xa4 && a[2] === 0x04) {
      this.log.push('SelectApplication');
      if (bytesToHex(data) !== 'd2760000850101') throw new Refuse(0x6a82);
      this.leaveField();
      this.selected = 'app';
      return ok(new Uint8Array(0), 0x9000);
    }
    if (ins === 0xa4 && a[2] === 0x00) {
      this.log.push('SelectNdefFile');
      if (this.selected === 'none' || bytesToHex(data) !== 'e104') throw new Refuse(0x6a82);
      this.session = undefined;
      this.selected = 'ndef';
      return ok(new Uint8Array(0), 0x9000);
    }
    if (ins === 0xb0) {
      this.log.push('ReadBinary');
      if (this.selected !== 'ndef') throw new Refuse(0x6a82);
      if (this.settings.access[1] >> 4 !== 0xe) throw new Refuse(0x6982);
      const offset = (a[2] << 8) | a[3];
      const length = a[4] === 0 ? 256 : a[4];
      return ok(this.view().slice(offset, offset + length), 0x9000);
    }
    if (ins === 0xd6) {
      this.log.push('UpdateBinary');
      if (this.selected !== 'ndef') throw new Refuse(0x6a82);
      if ((this.settings.access[1] & 0x0f) !== 0xe) throw new Refuse(0x6982);
      this.file.set(data, (a[2] << 8) | a[3]);
      return ok(new Uint8Array(0), 0x9000);
    }
    throw new Refuse(0x6d00);
  }

  /** File 2 as a read returns it: with SDM on, the counter moves on and p and c are mirrored in. */
  private view(): Uint8Array {
    const out = this.file.slice();
    const sdm = this.settings.sdm;
    if (!sdm) return out;
    this.readCounter = (this.readCounter + 1) & 0xffffff;
    const metaKey = this.keys[sdm.access[1] >> 4];
    const fileKey = this.keys[sdm.access[1] & 0x0f];
    const picc = concatBytes(Uint8Array.of(0xc7), this.uid, le24(this.readCounter), random(5));
    const p = bytesToHex(cbc(metaKey, ZERO_IV, { disablePadding: true }).encrypt(picc)).toUpperCase();
    const c = bytesToHex(sunMac(fileKey, this.uid, this.readCounter)).toUpperCase();
    out.set(Uint8Array.from(p, (ch) => ch.charCodeAt(0)), sdm.picc);
    out.set(Uint8Array.from(c, (ch) => ch.charCodeAt(0)), sdm.mac);
    return out;
  }

  // --- native commands ---

  private native(ins: number, data: Uint8Array): Uint8Array {
    this.log.push(ins === 0xc4 ? `ChangeKey ${data[0]}` : NAMES[ins] ?? `0x${ins.toString(16)}`);
    switch (ins) {
      case 0x60:
        this.versionFrame = 1;
        return ok(hexToBytes('04040230001105'), 0x91af);
      case 0xaf:
        if (this.versionFrame === 1) {
          this.versionFrame = 2;
          return ok(hexToBytes('04040201011105'), 0x91af);
        }
        if (this.versionFrame === 2) {
          this.versionFrame = 0;
          return ok(concatBytes(this.randomUid ? new Uint8Array(7) : this.uid, hexToBytes('cf39d449803e2120')));
        }
        return this.authSecond(data);
      case 0x64:
        return this.getKeyVersion(data);
      case 0xf5:
        return this.getFileSettings(data);
      case 0xad:
        return this.readData(data);
      case 0x71:
        return this.authFirst(data);
      case 0x51:
        return this.getCardUid(data);
      case 0xc4:
        return this.changeKey(data);
      case 0x5f:
        return this.fullCommand(0x5f, data, (header, plain) => {
          if (header[0] !== 0x02) throw new Refuse(0x91f0);
          this.applySettings(plain);
        }, (this.settings.access[0] & 0x0f));
      case 0x5c:
        return this.fullCommand(0x5c, data, (header, plain) => {
          if (header[0] === 0x00 && plain[0] & 0x02) this.randomUid = true;
        }, 0);
      case 0x8d:
        return this.writeData(data);
      default:
        throw new Refuse(0x911c);
    }
  }

  private need(keyNo?: number): Session {
    if (!this.session) throw new Refuse(0x919d);
    if (keyNo !== undefined && this.session.keyNo !== keyNo) throw new Refuse(0x919d);
    return this.session;
  }

  /** Checks a CommMode.MAC command's MAC (the last 8 bytes) over header; moves the counter on. */
  private checkCmdMac(s: Session, ins: number, body: Uint8Array, mac: Uint8Array) {
    if (!equalBytes(mac, cmdMac(s, s.ctr, ins, body))) throw new Refuse(0x911e);
    s.ctr++;
  }

  private getKeyVersion(data: Uint8Array): Uint8Array {
    const keyNo = data[0];
    if (keyNo > 4) throw new Refuse(0x9140);
    const v = Uint8Array.of(this.versions[keyNo]);
    if (!this.session) return ok(v);
    const s = this.session;
    this.checkCmdMac(s, 0x64, data.subarray(0, 1), data.subarray(1, 9));
    return ok(concatBytes(v, rspMac(s, s.ctr, v)));
  }

  private settingsBytes(): Uint8Array {
    const s = this.settings;
    const head = Uint8Array.of(0x00, s.option, ...s.access, 0x00, 0x01, 0x00);
    if (!s.sdm) return head;
    return concatBytes(head, Uint8Array.of(s.sdm.options, ...s.sdm.access), le24(s.sdm.picc), le24(s.sdm.macInput), le24(s.sdm.mac));
  }

  private getFileSettings(data: Uint8Array): Uint8Array {
    if (data[0] !== 0x02) throw new Refuse(0x91f0);
    const body = this.settingsBytes();
    if (!this.session) return ok(body);
    const s = this.session;
    this.checkCmdMac(s, 0xf5, data.subarray(0, 1), data.subarray(1, 9));
    return ok(concatBytes(body, rspMac(s, s.ctr, body)));
  }

  private readData(data: Uint8Array): Uint8Array {
    if (data[0] !== 0x02) throw new Refuse(0x91f0);
    if (this.settings.access[1] >> 4 !== 0xe) throw new Refuse(0x919d);
    const offset = le24At(data, 1);
    const length = le24At(data, 4) || 256 - offset;
    if (this.session) this.session.ctr++;
    return ok(this.view().slice(offset, offset + length));
  }

  private authFirst(data: Uint8Array): Uint8Array {
    if (this.selected === 'none') throw new Refuse(0x91ca);
    const keyNo = data[0];
    if (keyNo > 4) throw new Refuse(0x9140);
    this.session = undefined;
    const rndB = random(16);
    this.auth = { keyNo, rndB };
    return ok(cbc(this.keys[keyNo], ZERO_IV, { disablePadding: true }).encrypt(rndB), 0x91af);
  }

  private authSecond(data: Uint8Array): Uint8Array {
    const pending = this.auth;
    this.auth = undefined;
    if (!pending || data.length !== 32) throw new Refuse(0x91ca);
    const key = this.keys[pending.keyNo];
    const d = cbc(key, ZERO_IV, { disablePadding: true }).decrypt(data);
    const rndA = d.slice(0, 16);
    if (!equalBytes(d.subarray(16, 32), rotl(pending.rndB))) throw new Refuse(0x91ae);
    const ti = random(4);
    this.session = { keyNo: pending.keyNo, ...sessionKeys(key, rndA, pending.rndB), ti, ctr: 0 };
    const reply = concatBytes(ti, rotl(rndA), new Uint8Array(12));
    return ok(cbc(key, ZERO_IV, { disablePadding: true }).encrypt(reply));
  }

  private getCardUid(data: Uint8Array): Uint8Array {
    const s = this.need();
    this.checkCmdMac(s, 0x51, new Uint8Array(0), data.subarray(0, 8));
    const enc = encryptRsp(s, s.ctr, this.uid);
    return ok(concatBytes(enc, rspMac(s, s.ctr, enc)));
  }

  /** CommMode.Full: header bytes, the encrypted data, then the MAC; needs a session with key `keyNo`. */
  private fullCommand(ins: number, data: Uint8Array, apply: (header: Uint8Array, plain: Uint8Array) => void, keyNo: number): Uint8Array {
    const s = this.need(keyNo);
    const header = data.subarray(0, 1);
    const enc = data.subarray(1, data.length - 8);
    const ctr = s.ctr;
    this.checkCmdMac(s, ins, data.subarray(0, data.length - 8), data.subarray(data.length - 8));
    apply(header, decryptCmd(s, ctr, enc));
    return ok(rspMac(s, s.ctr, new Uint8Array(0)));
  }

  private changeKey(data: Uint8Array): Uint8Array {
    const s = this.need(0);
    const keyNo = data[0];
    if (keyNo > 4) throw new Refuse(0x9140);
    const enc = data.subarray(1, data.length - 8);
    const ctr = s.ctr;
    this.checkCmdMac(s, 0xc4, data.subarray(0, data.length - 8), data.subarray(data.length - 8));
    const plain = decryptCmd(s, ctr, enc);
    if (keyNo === s.keyNo) {
      this.keys[keyNo] = plain.slice(0, 16);
      this.versions[keyNo] = plain[16];
      this.session = undefined; // the key the session was opened with has changed
      return ok();
    }
    const newKey = plain.subarray(0, 16).map((v, i) => v ^ this.keys[keyNo][i]);
    if (!equalBytes(plain.subarray(17, 21), jamcrc32(newKey))) throw new Refuse(0x911e);
    this.keys[keyNo] = newKey;
    this.versions[keyNo] = plain[16];
    return ok(rspMac(s, s.ctr, new Uint8Array(0)));
  }

  private applySettings(p: Uint8Array) {
    const option = p[0];
    const access: [number, number] = [p[1], p[2]];
    if (!(option & 0x40)) {
      this.settings = { option, access };
      return;
    }
    const sdmAccess: [number, number] = [p[4], p[5]];
    if (sdmAccess[1] >> 4 > 4 || (sdmAccess[1] & 0x0f) > 4) throw new Refuse(0x919e); // only the keyed layout bolt cards use
    const sdm: Sdm = { options: p[3], access: sdmAccess, picc: le24At(p, 6), macInput: le24At(p, 9), mac: le24At(p, 12) };
    if (sdm.picc + 32 > 256 || sdm.mac + 16 > 256) throw new Refuse(0x919e);
    this.settings = { option, access, sdm };
  }

  private writeData(data: Uint8Array): Uint8Array {
    if (data[0] !== 0x02) throw new Refuse(0x91f0);
    const writeKey = this.settings.access[1] & 0x0f;
    if (writeKey !== 0xe) this.need(writeKey);
    const offset = le24At(data, 1);
    const length = le24At(data, 4);
    if (offset + length > 256) throw new Refuse(0x91be);
    this.file.set(data.subarray(7, 7 + length), offset);
    if (this.session) this.session.ctr++;
    return ok();
  }
}
