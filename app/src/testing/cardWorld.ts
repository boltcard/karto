// A simulated card, a fake cardd and the phone's card cache, wired the way the
// card screens wire the real ones: the world of the card flow tests.
import { hexToBytes } from '@noble/hashes/utils.js';
import { deriveCardKeys } from '../boltcard/cardkeys';
import { CarddClient } from '../cardd/client';
import { heldFetch, type CardDeps } from '../cards/deps';
import { withTimeout, type FetchFn } from '../lightning/lightning';
import { Ntag424 } from '../ntag424/card';
import { cardUrl, lnurlwFor } from '../ntag424/ndef';
import { AppStore } from '../store/store';
import { FakeCardd, vectorDeviceKey } from './fakeCardd';
import { Ntag424Sim } from './ntag424Sim';
import { nodeSqlite } from './nodeSqlite';
import { vectors } from './vectors';

export async function cardWorld() {
  const w: { nowMs: number; carddDown: boolean; stall: ((method: string, path: string) => boolean) | null; stalled: (() => void) | null } = {
    nowMs: 1_790_000_000_000,
    carddDown: false,
    /** The calls cardd gives no answer to, until they are given up. */
    stall: null,
    /** Told when a call met no answer. */
    stalled: null,
  };
  const cardd = new FakeCardd(() => w.nowMs);
  cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  cardd.issuer = hexToBytes(vectors.phrase.issuerKey);
  // What expo/fetch does when cardd is unreachable (lightning.ts isNetworkFailure).
  const fetch: FetchFn = async (url, init) => {
    if (w.carddDown) throw new TypeError(`fetch failed: no answer from ${new URL(url).host}`);
    if (w.stall?.(init?.method ?? 'GET', new URL(url).pathname)) {
      w.stalled?.();
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return cardd.http.fetch(url, init);
  };
  // As the app builds them (services.tsx cardDeps): every call gives up after 30 seconds, a card job's after HELD_CALL_MS.
  const answering = withTimeout(fetch, 30_000);
  const cache = await AppStore.open(nodeSqlite());
  const deps: CardDeps = {
    issuer: cardd.issuer,
    cardd: new CarddClient({ fetch: answering, host: cardd.host, key: vectorDeviceKey(), now: () => w.nowMs }),
    held: new CarddClient({ fetch: heldFetch(answering), host: cardd.host, key: vectorDeviceKey(), now: () => w.nowMs }),
    cache,
    host: cardd.host,
  };
  let sim = new Ntag424Sim();
  return {
    w,
    cardd,
    cache,
    deps,
    get sim() {
      return sim;
    },
    /** Puts another card in the field (a blank one by default). */
    use(next: Ntag424Sim) {
      sim = next;
    },
    /** A fresh tap: a new client over the card, and the id Android reports for it. */
    tap: () => ({ card: new Ntag424(sim.transceive), tagUid: sim.tagId() }),
  };
}

/** A card set up with this issuer at `version`: keys whose version is 1 are derived, the others still zero; SUN on. */
export function cardAt(issuer: Uint8Array, version: number, o: { versions?: number[]; host?: string; uid?: Uint8Array } = {}): Ntag424Sim {
  const uid = o.uid ?? hexToBytes('04a39493cc8680');
  const k = deriveCardKeys(issuer, uid, version);
  const versions = o.versions ?? [1, 1, 1, 1, 1];
  const keys = [k.k0, k.k1, k.k2, k.k3, k.k4].map((key, i) => (versions[i] ? key : new Uint8Array(16)));
  return Ntag424Sim.programmed({ uid, versions, keys, url: cardUrl(lnurlwFor(o.host ?? 'vm-1.lnvps.cloud')) });
}
