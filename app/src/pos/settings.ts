// What Karto PoS keeps on the phone: the shop's server, this phone's name in the shop, the
// sound switch, and a mark of each pairing link the person has answered, in the phone's secure store. Its key is
// in the Keystore; sales are read from the server every time.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isName } from '../cardd/names';
import { validHost } from './links';

/** expo-secure-store, as far as this uses it. */
export type KeyValue = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/**
 * The shop this phone is paired with: its server, only ever asked as https://<host>, the phone's name there, and the
 * wallet's name: '' when it has none or the server is older. Read back, it is always there.
 */
export type Paired = { host: string; name: string; wallet?: string };

const PAIRED = 'pos.paired';
const SOUND = 'pos.sound';
const ANSWERED = 'pos.answered';
/** How many answered links are remembered: Android hands over one old link, the one that first opened the app. */
const ANSWERED_KEPT = 8;

/** A pairing code's mark: enough to know the code again, and nothing to pair with. */
const markOf = (code: string) => bytesToHex(sha256(utf8ToBytes(code))).slice(0, 16);

export class PosStore {
  constructor(private readonly kv: KeyValue) {}

  /** The shop, or null when the phone isn't paired: anything kept that isn't a shop reads as unpaired. */
  async paired(): Promise<Paired | null> {
    try {
      const p = JSON.parse((await this.kv.getItemAsync(PAIRED)) ?? 'null') as Partial<Paired> | null;
      if (!(p && typeof p.host === 'string' && validHost(p.host) && typeof p.name === 'string' && p.name !== '')) return null;
      return { host: p.host, name: p.name, wallet: isName(p.wallet) ? p.wallet : '' };
    } catch {
      return null;
    }
  }

  async savePaired(p: Paired): Promise<void> {
    if (!validHost(p.host)) throw new Error(`"${p.host}" is not a server`);
    await this.kv.setItemAsync(PAIRED, JSON.stringify({ host: p.host, name: p.name, wallet: p.wallet ?? '' }));
  }

  /** The server's new address, for the shop this phone is paired with; nothing while it is unpaired. */
  async setHost(host: string): Promise<void> {
    if (!validHost(host)) throw new Error(`"${host}" is not a server`);
    const p = await this.paired();
    if (p) await this.savePaired({ ...p, host });
  }

  /** Unpaired: the host and the name are forgotten. The key stays, so pairing again with the same shop is the same phone. */
  async forget(): Promise<void> {
    await this.kv.deleteItemAsync(PAIRED);
  }

  /** Sound when paid: on unless it was turned off. */
  async sound(): Promise<boolean> {
    return (await this.kv.getItemAsync(SOUND)) !== 'off';
  }

  async setSound(on: boolean): Promise<void> {
    await this.kv.setItemAsync(SOUND, on ? 'on' : 'off');
  }

  private async marks(): Promise<string[]> {
    try {
      const kept: unknown = JSON.parse((await this.kv.getItemAsync(ANSWERED)) ?? '[]');
      return Array.isArray(kept) ? kept.filter((m): m is string => typeof m === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Whether the person has already answered a pairing link with this code (paired by it, or turned it down).
   * Android keeps the link that first opened the app and hands it over again whenever it remakes the app, from
   * Recents or from the icon: such a link is not put to the person twice.
   */
  async answered(code: string): Promise<boolean> {
    return (await this.marks()).includes(markOf(code));
  }

  /** The person answered a link with this code. Kept through Unpair: the old link is Android's to hand over still. */
  async markAnswered(code: string): Promise<void> {
    const mark = markOf(code);
    const rest = (await this.marks()).filter((m) => m !== mark);
    await this.kv.setItemAsync(ANSWERED, JSON.stringify([...rest, mark].slice(-ANSWERED_KEPT)));
  }
}
