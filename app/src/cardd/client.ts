// cardd's API (server/internal/api), every request signed by the phone's
// device key.
import type { FetchFn } from '../lightning/lightning';
import type { CurrencyCode, Fiat } from '../money/fiat';
import type { DeviceKey } from '../native/deviceKey';
import { CarddError } from './error';
import { readJson, refusal, SignedCalls } from './signed';

export { CarddError, isRevoked } from './error';

/**
 * An older cardd has no photo routes: Go's router answers them
 * with a plain-text 404, which reads as a bad_response; cardd's own 404 (an
 * unknown card, no photo) is JSON.
 */
export const noPhotoRoutes = (e: unknown) => e instanceof CarddError && e.status === 404 && e.code === 'bad_response';

/**
 * An older cardd has no shop: its wallet names none, and Go's
 * router answers the shop's and the sales' routes as it does the photo's.
 */
export const noShopRoutes = noPhotoRoutes;
/**
 * A cardd from before schema 8 has no line routes: Go's router answers them with a plain-text 404, as the
 * photo routes; cardd's own 404 for a line it doesn't have is JSON (not_found).
 */
export const noTransactionRoutes = noPhotoRoutes;

/** One encrypted snapshot (server/internal/backup Snapshot); created is unix seconds. */
export type BackupSnapshot = { version: number; created: number; size: number; sha256: string };
/** GET /api/v1/backups (server/internal/backup Status): times in unix seconds, 0 for never. */
export type BackupStatus = {
  installId: string; recipient: string; latest: BackupSnapshot | null;
  lastCheckIn: number; lastDownload: number; problem: string;
};

/** A price kept in a currency: minor units (pence; yen have none). */
export type Price = { currency: CurrencyCode; minor: number };
/** A card's limits kept in a currency: cardd converts them at each tap, at its last rate. */
export type CardLimits = { currency: CurrencyCode; perTapMinor: number; dailyMinor: number };
/** PATCH /api/v1/cards/{id}/limits: limits in sat, or in a currency (which saving sat limits clears). */
export type LimitsRequest = { perTapSat: number; dailySat: number } | CardLimits;

/** schema: cardd's database schema (store.SchemaVersion); an older cardd doesn't say. */
/** Whether the server's name has an IPv4 address pointing at it: got is what it points to instead, for other. */
export type DnsAnswer = { ipv4: 'ok' | 'missing' | 'other'; got?: string[] };
/** dns: absent from an older cardd, and until cardd's first look-up of its name has an answer. */
export type ServerInfo = { version: string; bundle: string; schema?: number; dns?: DnsAnswer };
export type CardState = 'programming' | 'active' | 'frozen' | 'wiping' | 'reset';
/** A card as cardd reports it (server/internal/api cardJSON); counter is -1 until the first tap. */
export type CardInfo = {
  id: string; version: number; state: CardState; counter: number; name: string; created: number; updated: number;
  /** The card's limits, in sat: with limits kept in a currency, cardd's conversion of them at its last rate. */
  perTapSat?: number; dailySat?: number;
  /** Set when the card's limits are kept in a currency. */
  limits?: CardLimits;
  /** The server the card's URL points at, set when it is added or re-pointed ('' if unknown). */
  host?: string;
  /**
   * Set after a restore from a backup: the card can't pay until it is held to the phone, whose tap check (or a
   * re-point's) moves the server's counter to the card's own. Absent otherwise.
   */
  needsCheck?: boolean;
  /** GET /cards only: the card's photo's tag, '' without one; an older cardd doesn't say. */
  photo?: string;
};
/** A card's photo: a 428×270 JPEG in base64, and its tag (the first 16 hex digits of its SHA-256). */
export type CardPhoto = { jpeg: string; photo: string };
/** A tap's p= and c=, as the card wrote them. */
export type Sun = { p: string; c: string };
/** A tap of a card cardd doesn't know, and the version its keys were found at (phrase-only rebuild). */
export type AdoptRequest = { version: number; name: string } & Sun;

/**
 * One card in GET /api/v1/wallet (server/internal/api/money.go). Amounts are msat; limits are sat, which for limits
 * kept in a currency (limits) are cardd's conversion at its last rate: what a tap would be held to.
 */
export type WalletCard = {
  id: string; name: string; state: CardState; version: number;
  balanceMsat: number; heldMsat: number; spent24hMsat: number; perTapSat: number; dailySat: number;
  limits?: CardLimits;
  /** The card's Lightning address for top-ups. */
  address: string;
};
/** One transaction in an account's history: this account's leg and the transaction's routing fee, in msat. */
export type Tx = {
  id: number; kind: string; note: string; amountMsat: number; feeMsat: number; created: number;
  /**
   * A move's or a refund's other account of this wallet: a card's id, 'pool', 'hosting' or 'shop' (a refund paid over
   * Lightning has none; a cardd before schema 15 gives it for a move only).
   */
  other?: string;
  /** How a top-up's money came, when more than a top-up: 'refund', through one of this server's refund links (schema 15). */
  via?: 'refund';
  /**
   * A sale's facts (kind 'sale', and a refund's: the sale it gave back): how it was paid, the PoS phone's name and the
   * price, which amountMsat is under by what went toward more room; when it was paid, its refund (null for none,
   * absent from a cardd with no refunds) and where a refund would go.
   */
  sale?: { id: string; method: 'card' | 'qr'; device: string; priceMsat: number; price?: Price; paidAt?: number; refund?: RefundState; returnAddress?: ReturnAddress };
  /** The person's own note on the line; a cardd before schema 8 doesn't say. */
  comment?: string;
  /** A top-up's payer's note (LUD-12): someone else's words, cleaned and cut by cardd; a cardd before schema 11 doesn't say. */
  payerNote?: string;
};
/** A sale's refund: on its way, or paid (its line, when, what reached the customer, and the account it came from). */
export type RefundState = null | { state: 'pending' | 'paid'; txId?: number; at?: number; amountMsat?: number; from?: 'shop' | 'pool' };
/** Where a sale's refund would go: the card's server, by host, or a card of this wallet. */
export type ReturnAddress = { host: string } | { card: { id: string; name: string } };
/** A refund refused for its amount: cardd's own figure for the sale (wrong_amount), or the customer's invoice's or offer's (other_amount). */
export type RefundAmountAnswer = { status: 'wrong_amount'; amountMsat: number } | { status: 'other_amount'; amountMsat: number; of: 'invoice' | 'offer' };
/** A refund's request: the whole sale, from Shop or Pool, to the sale's return link (no to) or to what the owner gives. */
export type RefundRequest = { id: string; amountMsat: number; from: 'shop' | 'pool'; to?: string };

/** A Lightning payment's facts on its line (GET …/transactions/{id}): preimage '' when phoenixd didn't know it, absent while not yet asked. */
export type TxPayment = { hash?: string; preimage?: string; invoice?: string; offer?: string; description?: string; destination?: string };
/** One line as its page shows it. */
export type TxDetail = Tx & { payment?: TxPayment };
/** A move between two of the person's accounts: a card's id, 'pool' or 'hosting'. */
export type MoveRequest = { id: string; from: string; to: string; amountMsat: number };
/**
 * Send out's lookup: what a destination will pay. An offer's amountMsat is null when the person chooses it;
 * name is the BIP353 name it came from (₿user@domain). A payurl is an LNURL address or link and what it takes.
 */
export type Lookup =
  | { kind: 'offer'; offer: string; name?: string; amountMsat: number | null; description: string; issuer: string }
  | { kind: 'payurl'; to: string; minMsat: number; maxMsat: number; description: string };
/** One address on Send out's Recent list: what the field gets, what the row shows, when it was last paid (unix seconds). */
export type RecentTo = { to: string; shown: string; paidAt: number };
/** A send out of pool: to an invoice, an address, an LNURL-pay URL or an offer (with the BIP353 name it came from). The comment is the person's own private note; a cardd before schema 8 refuses the field (400 malformed). */
export type SendRequest = { id: string; to: string; name?: string; amountMsat?: number; comment?: string };
/** POST /send's answer: pending is resolved later, like a tap's hold; an offer's hash is '' until phoenixd gives it. reason: why it wasn't sent, in the person's words, when phoenixd said. */
export type SendAnswer = { status: 'sent' | 'failed' | 'pending'; paymentHash: string; amountMsat: number; feeMsat?: number; reason?: string };
export type WalletAccount = { balanceMsat: number; heldMsat: number; address: string };
/** One PoS phone: times are unix seconds; lastSale only once it has made a sale that was paid. */
export type PosPhone = { keyId: string; name: string; created: number; sales: number; lastSale?: number };
/** The PoS phones, oldest first; restored: when the server was last restored, if it ever was. */
export type ShopPhones = { phones: PosPhone[]; restored?: number };
/**
 * A sale as cardd answers it to an owner (server/internal/api saleJSON):
 * amountMsat is the price, receivedMsat what reached Shop; txId, its place in
 * the ledger, is what the list's next page is asked before.
 */
export type Sale = {
  id: string; amountMsat: number; state: 'open' | 'paid' | 'expired' | 'cancelled'; method: '' | 'card' | 'qr';
  device: { keyId: string; name: string }; created: number; expires: number;
  invoice?: string; paidAt?: number; txId?: number; receivedMsat?: number;
  /** The price it was rung up at, in the shop's currency then; absent for a sale typed in sats. */
  price?: Price;
};
/** One local day's paid sales: day is its first second (unix), totalMsat the prices. */
export type SaleDay = { day: number; count: number; totalMsat: number };
/**
 * The VM's paid-until estimate (server/internal/renew Status).
 * Times are unix seconds (0 before the first sync); fundingDays is what
 * hosting's available balance pays for; willRenew: cardd will renew the VM
 * when it is due (synced, no VAT, not paused, no problem, hosting can pay;
 * too little to renew is over, and not reported, once hosting can pay).
 */
export type HostingStatus = {
  synced: boolean; expires: number; syncedAt: number; daysLeft: number; msatPerDay: number; fundingDays: number;
  vatOk: boolean; willRenew: boolean; problem: string; problemAt: number;
};
/** What the app read from LNVPS: the VM's expiry (unix seconds), a day's price, and no VAT; the phone's offset from UTC in minutes. */
export type HostingSync = { expires: number; satPerDay: number; vatOk: boolean; utcOffsetMin?: number };
/** Renew now: days of the VM paid from hosting, once per request id. */
export type RenewRequest = { id: string; days: number };
/**
 * A restored server's books: pending until phoenixd's
 * channel is back, no_channel when none came back in time, done once set (reconciledMsat went to pool).
 * from is the backup's name, or 'phrase'; times are unix seconds.
 */
export type RestoreInfo = { state: 'pending' | 'no_channel' | 'done'; from: string; reconciledMsat?: number; reconciledAt?: number };
/** The money side of the server. liquidity is null while phoenixd can't be asked. */
export type Wallet = {
  cards: WalletCard[]; pool: WalletAccount; hosting: WalletAccount;
  paused: boolean; pausedReason: string;
  /** channel: phoenixd has one (it may be reconnecting); usable: it is up. feeCreditSat can't be spent and is on no card. */
  liquidity: { channel: boolean; usable: boolean; inboundSat: number; feeCreditSat: number; firstChannelFeeSat: number } | null;
  /** null unless this server was restored. */
  restore: RestoreInfo | null;
  /** The shop: its account, the PoS phones paired now and the paid sales ever. Absent from an older cardd. */
  shop?: WalletAccount & { phones: number; sales: number };
  /** How many times the books have changed, as the server counts ("<boot>-<n>"): given back to ask for a held read. Absent from a cardd before held Wallet reads. */
  rev?: string;
  /** The server's currency and its rate; absent from a cardd before it. */
  fiat?: Fiat;
  /** The wallet's name, which its tills show: '' until it is named; absent from a cardd before it. */
  name?: string;
};

/**
 * How this phone's alerts stand on the server: the server's
 * VAPID public key, its own ntfy's address ("https://<host>:8443"; "" for none), and this phone's endpoint, null for
 * none. The endpoint's path is a secret, so only its origin comes back; times are unix seconds, failures the
 * failures in a row since the last delivery.
 */
export type PushState = {
  vapidPublicKey: string;
  ntfy: string;
  endpoint: {
    transport: 'unifiedpush' | 'fcm'; origin: string; createdAt: number;
    deliveredAt: number | null; failedAt: number | null; failure: string; failures: number;
  } | null;
};
/** Where this phone's alerts go, with its Web Push keys (RFC 8291, base64url): through a UnifiedPush distributor such as ntfy, or the Play build's FCM. */
export type PushRequest = { endpoint: string; p256dh: string; auth: string; transport: 'unifiedpush' | 'fcm' };

const REV = /^([0-9a-f]{8})-([0-9]+)$/;

/** Whether a wallet's rev is behind the one shown: the same start of the server, and fewer changes to the books counted. An answer that is behind is not shown over a newer one. */
export function revBehind(rev: string | undefined, shown: string | undefined): boolean {
  const [a, b] = [REV.exec(rev ?? ''), REV.exec(shown ?? '')];
  return !!a && !!b && a[1] === b[1] && Number(a[2]) < Number(b[2]);
}

export class CarddClient {
  private readonly signed: SignedCalls;

  /**
   * slowFetch, if set, is for POST /send, which may take the server's whole 25 s deadline.
   * download, if set, is for snapshot downloads: must not buffer the body.
   */
  constructor(private readonly o: { fetch: FetchFn; slowFetch?: FetchFn; download?: FetchFn; host: string; key: Pick<DeviceKey, 'authorize'>; now?: () => number }) {
    this.signed = new SignedCalls(o);
  }

  private call<T>(method: string, path: string, body?: unknown, fetchFn = this.o.fetch): Promise<T> {
    return this.signed.call(method, path, body, fetchFn);
  }

  /** cardd's version and the deploy bundle the app last installed (meta bundle.sha256). */
  server(): Promise<ServerInfo> {
    return this.call('GET', '/api/v1/server');
  }

  /** Picks the version to program a card at; an empty name keeps the stored one. */
  reserveCard(id: string, name = ''): Promise<CardInfo & { lnurlw: string }> {
    return this.call('POST', '/api/v1/cards', name ? { id, name } : { id });
  }

  /**
   * Balances, top-up addresses and limits. With held (the rev a wallet was
   * answered with, and seconds to wait) the server may hold its answer until the books have changed since that rev:
   * money shows as it arrives. A server from before answers at once.
   */
  wallet(held?: { since: string; wait: number }): Promise<Wallet> {
    const query = held ? `?${new URLSearchParams({ since: held.since, wait: String(held.wait) })}` : '';
    return this.call('GET', `/api/v1/wallet${query}`);
  }

  /**
   * An account's transactions (a card's id, 'pool' or 'hosting'), newest first: up to limit (50; at most 100) before
   * the id before. With wait (seconds) and after (a transaction's id; 0: none yet), the server may hold its answer
   * until the account has one newer than after; a server that doesn't hold answers at once.
   */
  async history(account: string, page: { before?: number; limit?: number; after?: number; wait?: number } = {}): Promise<Tx[]> {
    const q = new URLSearchParams();
    if (page.before) q.set('before', String(page.before));
    if (page.limit) q.set('limit', String(page.limit));
    if (page.wait) {
      q.set('after', String(page.after ?? 0));
      q.set('wait', String(page.wait));
    }
    const query = q.size ? `?${q}` : '';
    return (await this.call<{ transactions: Tx[] }>('GET', `/api/v1/accounts/${account}/history${query}`)).transactions;
  }

  /** Moves money once per request id; the same id again answers from the first time. */
  move(req: MoveRequest): Promise<{ status: 'moved' }> {
    return this.call('POST', '/api/v1/move', { id: req.id, from: req.from, to: req.to, amountMsat: req.amountMsat });
  }

  /** Sends out of pool once per request id. The body's keys keep one order, so a retry's body is the same (cardd refuses a different body under the same id). */
  send(req: SendRequest): Promise<SendAnswer> {
    const body = {
      id: req.id, to: req.to, ...(req.name ? { name: req.name } : {}), ...(req.amountMsat ? { amountMsat: req.amountMsat } : {}), ...(req.comment ? { comment: req.comment } : {}),
    };
    return this.call('POST', '/api/v1/send', body, this.o.slowFetch);
  }

  /** What a destination will pay: read before Check. A cardd before schema 10 has no such route. */
  lookup(to: string): Promise<Lookup> {
    return this.call('POST', '/api/v1/send/lookup', { to });
  }

  /** Send out's Recent list: the addresses last paid from Pool, newest first. A cardd before schema 13 has no such route. */
  async recentSends(): Promise<RecentTo[]> {
    return (await this.call<{ recent: RecentTo[] }>('GET', '/api/v1/send/recent')).recent;
  }

  /** Takes an address off the Recent list until it is paid again. */
  async removeRecent(to: string): Promise<void> {
    await this.call('DELETE', '/api/v1/send/recent', { to });
  }

  /** A send's state now, by its request id; with wait (seconds, at most 20) cardd holds its answer until the send ends. */
  /**
   * Refunds a till sale (POST /api/v1/sales/{id}/refund), answered as a send; wrong_amount (the rate moved, or
   * the amount isn't the sale's) comes back as the figure cardd would pay, for Check to show again; other_amount (the
   * customer's invoice or offer is for another amount) as that amount and which it was.
   */
  async refund(saleId: string, req: RefundRequest, offsetMin?: number): Promise<SendAnswer | RefundAmountAnswer> {
    // The phone's offset east of UTC, for the note's time: in the query, which an older cardd ignores.
    const q = offsetMin === undefined ? '' : `?offset=${offsetMin}`;
    try {
      return await this.call<SendAnswer>('POST', `/api/v1/sales/${saleId}/refund${q}`, req);
    } catch (e) {
      const figure = e instanceof CarddError && (e.code === 'wrong_amount' || e.code === 'other_amount') ? e.body?.amountMsat : undefined;
      if (typeof figure === 'number' && e instanceof CarddError) {
        if (e.code === 'wrong_amount') return { status: 'wrong_amount', amountMsat: figure };
        return { status: 'other_amount', amountMsat: figure, of: e.body?.of === 'offer' ? 'offer' : 'invoice' };
      }
      throw e;
    }
  }

  sendState(id: string, wait = 0): Promise<SendAnswer> {
    return this.call('GET', `/api/v1/send/${encodeURIComponent(id)}${wait ? `?wait=${wait}` : ''}`, undefined, this.o.slowFetch);
  }

  /** One line as account sees it, with its payment's facts. */
  transaction(account: string, id: number): Promise<TxDetail> {
    return this.call('GET', `/api/v1/accounts/${account}/transactions/${id}`);
  }

  /** Sets the person's note on a line ('' removes it); answers the line. */
  setComment(account: string, id: number, comment: string): Promise<TxDetail> {
    return this.call('PATCH', `/api/v1/accounts/${account}/transactions/${id}`, { comment });
  }

  freezeCard(id: string): Promise<CardInfo> {
    return this.call('POST', `/api/v1/cards/${id}/freeze`);
  }

  unfreezeCard(id: string): Promise<CardInfo> {
    return this.call('POST', `/api/v1/cards/${id}/unfreeze`);
  }

  /** A card's limits, in sat or in a currency; cardd refuses bad_limits, or no_rate for a currency it has no rate for. */
  setLimits(id: string, limits: LimitsRequest): Promise<CardInfo> {
    const body = 'currency' in limits
      ? { currency: limits.currency, perTapMinor: limits.perTapMinor, dailyMinor: limits.dailyMinor }
      : { perTapSat: limits.perTapSat, dailySat: limits.dailySat };
    return this.call('PATCH', `/api/v1/cards/${id}/limits`, body);
  }

  /** The server's one currency, for this and every PoS phone; answers what the phones now read. An older cardd, without currencies, answers a plain 404. */
  async setCurrency(code: CurrencyCode | 'none'): Promise<Fiat> {
    return (await this.call<{ fiat: Fiat }>('PUT', '/api/v1/currency', { currency: code })).fiat;
  }

  /**
   * Names the wallet, for this and every phone of it and its tills; answers the name as kept (trimmed). Refused:
   * bad_name. An older cardd, without the wallet's name, answers a plain 404.
   */
  async setWalletName(name: string): Promise<string> {
    return (await this.call<{ name: string }>('PUT', '/api/v1/wallet/name', { name })).name;
  }

  /** The latest snapshot and the last fetches; asking records this phone's check-in. */
  backups(): Promise<BackupStatus> {
    return this.call('GET', '/api/v1/backups');
  }

  /**
   * One encrypted snapshot's bytes, on the download fetch. A reply with no
   * Content-Length, or one over maxBytes, is refused (too_big) before its
   * body is read (cardd always states the length), and reading stops once
   * the body itself passes maxBytes, whatever was stated.
   */
  async backupFile(version: number, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    const path = `/api/v1/backups/${version}`;
    const res = await this.signed.request('GET', path, undefined, this.o.download ?? this.o.slowFetch ?? this.o.fetch);
    if (!res.ok) throw refusal(res, await readJson(res, 'GET', path));
    const stated = res.headers.get('content-length');
    if (stated === null || !(Number(stated) <= maxBytes)) {
      await res.body?.cancel().catch(() => {});
      throw new CarddError(res.status, 'too_big', `snapshot ${version} is ${stated ?? 'of no stated'} bytes, over the ${maxBytes} allowed`);
    }
    const over = () => new CarddError(res.status, 'too_big', `snapshot ${version} ran past the ${maxBytes} bytes allowed`);
    const reader = res.body?.getReader();
    if (!reader) {
      // A fetch without streams reads the whole body before this can check it, so here the cap bounds
      // what is kept, not what is read; the phone's expo/fetch streams.
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.length > maxBytes) throw over();
      return all;
    }
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) {
        await reader.cancel().catch(() => {});
        throw over();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /** The VM's paid-until estimate. */
  hosting(): Promise<HostingStatus> {
    return this.call('GET', '/api/v1/hosting');
  }

  /** Overwrites the estimate with what LNVPS says; cardd refuses values out of range (bad_sync). */
  syncHosting(s: HostingSync): Promise<HostingStatus> {
    const offset = s.utcOffsetMin === undefined ? {} : { utcOffsetMin: s.utcOffsetMin };
    return this.call('PUT', '/api/v1/hosting', { expires: s.expires, satPerDay: s.satPerDay, vatOk: s.vatOk, ...offset });
  }

  /** Renews the VM now from hosting, once per request id; answers like a send. */
  renewNow(req: RenewRequest): Promise<SendAnswer> {
    return this.call('POST', '/api/v1/hosting/renew', { id: req.id, days: req.days }, this.o.slowFetch);
  }

  /** Sets the books to phoenixd's balance, the way out of a pause; the difference goes to pool. */
  reconcileBooks(): Promise<{ bookedMsat: number }> {
    return this.call('POST', '/api/v1/ledger/reconcile');
  }

  /** After a restore with no channel back: sets the books to phoenixd's balance both ways, the person's choice. */
  restoreBooks(): Promise<{ bookedMsat: number }> {
    return this.call('POST', '/api/v1/ledger/restore-books');
  }

  async cards(): Promise<CardInfo[]> {
    return (await this.call<{ cards: CardInfo[] }>('GET', '/api/v1/cards')).cards;
  }

  renameCard(id: string, name: string): Promise<CardInfo> {
    return this.call('PATCH', `/api/v1/cards/${id}`, { name });
  }

  /** The end-to-end check after programming: cardd checks p and c with its own derivation. */
  confirmCard(id: string, sun: Sun): Promise<CardInfo> {
    return this.call('POST', `/api/v1/cards/${id}/confirm`, sun);
  }

  /**
   * Tap to check: verifies the tap and moves the counter on. proved: the card proved its key 0 in the read the tap
   * came from (or it is this phone's own card): only such a check lets a card that needsCheck pay again (otherwise
   * 409 needs_check). Sent only for such a card, so a cardd from before it, which knows no such card, never sees it.
   */
  checkCard(sun: Sun, o: { proved?: boolean } = {}): Promise<CardInfo> {
    return this.call('POST', '/api/v1/cards/check', o.proved ? { p: sun.p, c: sun.c, proved: true } : sun);
  }

  /** Adds a card cardd doesn't know as active, once cardd has checked the tap at that version (phrase-only rebuild). */
  adoptCard(req: AdoptRequest): Promise<CardInfo> {
    return this.call('POST', '/api/v1/cards/adopt', { version: req.version, name: req.name, p: req.p, c: req.c });
  }

  /** Records which server the card's URL points at, once a re-point is checked. */
  setCardHost(id: string, host: string): Promise<CardInfo> {
    return this.call('PUT', `/api/v1/cards/${id}/host`, { host });
  }

  wipeCard(id: string): Promise<CardInfo> {
    return this.call('POST', `/api/v1/cards/${id}/wipe`);
  }

  wipedCard(id: string): Promise<CardInfo> {
    return this.call('POST', `/api/v1/cards/${id}/wiped`);
  }

  /** A card's photo; a CarddError 404 not_found when it has none. */
  cardPhoto(id: string): Promise<CardPhoto> {
    return this.call('GET', `/api/v1/cards/${id}/photo`);
  }

  /** Keeps jpeg (base64) as the card's photo; answers its tag. */
  setCardPhoto(id: string, jpeg: string): Promise<{ photo: string }> {
    return this.call('PUT', `/api/v1/cards/${id}/photo`, { jpeg });
  }

  /** Removes the card's photo; none is fine. */
  async removeCardPhoto(id: string): Promise<void> {
    await this.call('DELETE', `/api/v1/cards/${id}/photo`);
  }

  /** Opens a pairing code for a PoS phone to be called name: good once, until expires (unix seconds); it replaces any earlier one. */
  shopCode(name: string): Promise<{ code: string; expires: number }> {
    return this.call('POST', '/api/v1/shop/codes', { name });
  }

  /** Drops the open pairing code; none is fine. */
  async dropShopCode(): Promise<void> {
    await this.call('DELETE', '/api/v1/shop/codes');
  }

  shopPhones(): Promise<ShopPhones> {
    return this.call('GET', '/api/v1/shop/phones');
  }

  renameShopPhone(keyId: string, name: string): Promise<{ keyId: string; name: string }> {
    return this.call('PATCH', `/api/v1/shop/phones/${keyId}`, { name });
  }

  /** Removes a PoS phone: its key is refused from then on. */
  async removeShopPhone(keyId: string): Promise<void> {
    await this.call('DELETE', `/api/v1/shop/phones/${keyId}`);
  }

  /** The shop's paid sales, from every phone (to the owner; a PoS phone gets its own), newest first: up to limit (50; at most 100) before the txId before. */
  async sales(page: { before?: number; limit?: number } = {}): Promise<Sale[]> {
    const q = new URLSearchParams();
    if (page.before) q.set('before', String(page.before));
    if (page.limit) q.set('limit', String(page.limit));
    const query = q.size ? `?${q}` : '';
    return (await this.call<{ sales: Sale[] }>('GET', `/api/v1/pos/sales${query}`)).sales;
  }

  /** The paid sales counted by this phone's local day, newest first: offsetMin is its minutes east of UTC; up to limit days (30; at most 90). */
  async salesDays(offsetMin: number, limit?: number): Promise<SaleDay[]> {
    const q = new URLSearchParams({ offset: String(offsetMin) });
    if (limit) q.set('limit', String(limit));
    return (await this.call<{ days: SaleDay[] }>('GET', `/api/v1/pos/sales/days?${q}`)).days;
  }

  /** How this phone's alerts stand (server/internal/api's push.go). */
  push(): Promise<PushState> {
    return this.call('GET', '/api/v1/push');
  }

  /**
   * Sends this phone's alerts to req's endpoint, replacing any earlier one; answers as push() does. Refused 400 with
   * bad_transport, bad_endpoint, bad_keys, or ntfy_sh: an endpoint on ntfy.sh where the server has its own ntfy.
   */
  setPush(req: PushRequest): Promise<PushState> {
    return this.call('PUT', '/api/v1/push', req);
  }

  /** No more alerts for this phone; none is fine. */
  async dropPush(): Promise<void> {
    await this.call('DELETE', '/api/v1/push');
  }

  /**
   * Sends this phone a test alert now: done when the endpoint took it. A 404 not_found without an endpoint; a 502
   * push_failed, its message what the endpoint said, when it didn't.
   */
  async testPush(): Promise<void> {
    await this.call('POST', '/api/v1/push/test');
  }
}
