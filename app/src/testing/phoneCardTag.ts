// A stand-in for the phone's card service: what a reader gets
// from a phone that is a card, by the rules of card-native's PhoneCardTag.kt, whose own tests hold the Kotlin to
// the same answers. A plain NFC Forum Type 4 tag: the NDEF application, its capability file and an NDEF file,
// and nothing of an NTAG 424.
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Transceive } from '../ntag424/apdu';

const NDEF_APP = 'd2760000850101';
const CC_FILE = 0xe103;
const NDEF_FILE = 0xe104;
/** CCLEN 15, mapping 2.0, MLe 255, MLc 52; then the NDEF file: E104, up to 256 bytes, read free, never written. */
const CC = hexToBytes('000f2000ff00340406e104010000ff');

const sw = (n: number) => Uint8Array.of(n >> 8, n & 0xff);

export class PhoneCardTag {
  /** Every command a reader sent, in hex. */
  readonly seen: string[] = [];
  /** Files handed to a reader since the last load. */
  given = 0;
  /** Told each time a file is handed to a reader. */
  onGiven?: (given: number, left: number) => void;
  private files: Uint8Array[] = [];
  private app = false;
  private file: Uint8Array | null = null;

  get left(): number {
    return this.files.length;
  }

  /** Takes the NDEF files (hex) to hand out, one per tap, replacing any it has. */
  load(files: string[]): void {
    this.files = files.map(hexToBytes);
    this.given = 0;
    this.deactivated();
  }

  add(files: string[]): void {
    this.files.push(...files.map(hexToBytes));
  }

  /** Drops what is left and answers how many were handed out. */
  clear(): number {
    const given = this.given;
    this.load([]);
    return given;
  }

  /** The reader left the field: what it had selected is forgotten. */
  deactivated(): void {
    this.app = false;
    this.file = null;
  }

  transceive: Transceive = async (apdu) => {
    this.seen.push(bytesToHex(apdu));
    return this.answer(apdu);
  };

  private answer(apdu: Uint8Array): Uint8Array {
    if (apdu.length < 4) return sw(0x6700);
    const [cla, ins, p1, p2] = apdu;
    if (cla !== 0x00) return sw(0x6e00);
    const data = apdu.length > 5 ? apdu.subarray(5, 5 + apdu[4]) : new Uint8Array(0);
    if (ins === 0xa4 && p1 === 0x04) {
      this.deactivated();
      // With nothing to give, the phone is no Bolt Card to a reader.
      if (bytesToHex(data) !== NDEF_APP || this.files.length === 0) return sw(0x6a82);
      this.app = true;
      return sw(0x9000);
    }
    if (ins === 0xa4 && p1 === 0x00) {
      this.file = null;
      const id = data.length === 2 ? (data[0] << 8) | data[1] : -1;
      if (!this.app) return sw(0x6a82);
      if (id === CC_FILE) this.file = CC;
      else if (id === NDEF_FILE && this.files.length > 0) {
        // Each select of the NDEF file is a new tap, as each read of a plastic card is.
        this.file = this.files.shift()!;
        this.given++;
        this.onGiven?.(this.given, this.files.length);
      } else return sw(0x6a82);
      return sw(0x9000);
    }
    if (ins === 0xb0) {
      if (!this.file) return sw(0x6986);
      const offset = (p1 << 8) | p2;
      if (offset > this.file.length) return sw(0x6b00);
      // Past its end the file reads as zeros, as a card's 256-byte file does.
      const out = new Uint8Array(apdu.length > 4 && apdu[4] !== 0 ? apdu[4] : 256);
      out.set(this.file.subarray(offset, offset + out.length));
      return concatBytes(out, sw(0x9000));
    }
    return sw(0x6d00);
  }
}
