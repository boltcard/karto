// cardd as onboarding and the app see it: `cardd-ctl meta set` and
// `cardd-ctl device add` over FakeSsh (and install.sh's rebuild commands), and
// the signed HTTPS API, which checks the Device header the way
// server/internal/deviceauth does.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { cardId, deriveCardKeys, k1For } from '../boltcard/cardkeys';
import { decryptPicc, parseSun, verifySun } from '../boltcard/sun';
import type { CardInfo, CardLimits, DnsAnswer, HostingStatus, Lookup, Price, RecentTo, RestoreInfo, Sale, SendAnswer, Sun, Tx, TxDetail, TxPayment } from '../cardd/client';
import { canonical, keyId } from '../cardd/deviceauth';
import { isName } from '../cardd/names';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import { isCode, MAX_MINOR, minorToMsat, limitToMsat, symbol, type CurrencyCode, type Fiat, type Rated } from '../money/fiat';
import { feeBudgetMsat } from '../money/send';
import { deviceKey } from '../native/deviceKey';
import { FakeHttp, HttpError, json } from './http';
import type { FakeSsh } from './fakeSsh';
import { vectors } from './vectors';

/** Undoes shellQuote: 'it'\''s' -> it's */
const unquote = (q: string) => q.slice(1, -1).replace(/'\\''/g, "'");
const QUOTED = `('(?:[^']|'\\\\'')*')`;
/** cards.ValidHost's rule: a bare lower-case DNS name. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** cardd's error reply: {error, message} with a status, as server/internal/api writes it. */
/** A note as cardd keeps it: control and format characters become spaces, runs of space collapse, trimmed; over 200 characters is refused. */
function cleanNote(raw: unknown): string {
  const note = String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').split(/\s+/).filter(Boolean).join(' ');
  if ([...note].length > 200) throw new Refusal(400, 'bad_note', 'a note is 200 characters at most');
  return note;
}

class Refusal {
  constructor(readonly status: number, readonly code: string, readonly message: string) {}
}

export class FakeCardd {
  readonly http = new FakeHttp();
  readonly meta = new Map<string, string>();
  /** key id -> uncompressed public key hex */
  readonly devices = new Map<string, string>();
  revoked = new Set<string>();
  version = 'test';
  /** GET /api/v1/server's schema (store.SchemaVersion()). */
  schema = CARDD_SCHEMA_VERSION;
  /** GET /api/v1/server's dns: null leaves it out, as cardd does before its first answer. */
  dns: DnsAnswer | null = null;
  readonly cards = new Map<string, CardInfo>();
  /** Balances in msat, by card id, 'pool' or 'hosting' (GET /api/v1/wallet). */
  readonly balances = new Map<string, number>();
  /** Transactions by account (GET /api/v1/accounts/{account}/history). */
  readonly history = new Map<string, Tx[]>();
  /** false: a cardd from before schema 8, whose router answers the line routes with a plain-text 404. */
  transactionRoutes = true;
  /** A send's facts by its line's id, as GET …/transactions/{id} gives them. */
  readonly payments = new Map<number, TxPayment>();
  /** phoenixd's fee credit, in sat (GET /api/v1/wallet's liquidity). */
  feeCreditSat = 0;
  /** Spending paused because the books disagree with phoenixd, until POST /api/v1/ledger/reconcile. */
  pausedReason = '';
  /** Held for payments in progress, by account (msat). */
  readonly held = new Map<string, number>();
  /** Each card's limits, in sat (default 20,000 per tap, 50,000 per 24 hours), and kept in a currency when set so. */
  readonly limits = new Map<string, { perTapSat: number; dailySat: number } & Partial<CardLimits>>();
  /** Whether phoenixd has a channel (GET /api/v1/wallet's liquidity). */
  channel = false;
  /** Whether that channel is up (Normal); false: reconnecting after a restore. */
  channelUp = true;
  /** What the next sends do. */
  sendOutcome: { status: SendAnswer['status']; feeMsat?: number; reason?: string } = { status: 'sent', feeMsat: 0 };
  /** What POST /send/lookup answers, by the to it is given; a refusal is bad_destination with its sentence. Unknown: a ₿ name is refused as the server refuses one with no BIP353 record, an address or link reads as LNURL taking 1 sat to 1,000,000 sat, an offer as one with no amount. */
  readonly lookups = new Map<string, Lookup | { refusal: string }>();
  /** Send out's Recent list, as GET /send/recent gives it; DELETE takes an entry off by its to. */
  recent: RecentTo[] = [];
  /** When set, DELETE /send/recent answers 500 with this message. */
  removeRecentFails: string | null = null;
  /** Each send's answer by request id, as GET /send/{id} gives it; endPendingSend moves a pending one on. */
  readonly sends = new Map<string, SendAnswer>();
  /** cardd's refusal of the next sends, before any money is held (as a send's refusals in server/internal/api). */
  sendRefusal: { status: number; code: string; message: string } | null = null;
  /** The last send answered pending, still held: endPendingSend settles or releases it. */
  pendingSend: { id: string; paymentHash: string; amountMsat: number } | null = null;
  /** The hosting estimate, as the app last synced it (PUT /api/v1/hosting); null before the first sync. */
  hostingSync: { expires: number; msatPerDay: number; vatOk: boolean; syncedAt: number } | null = null;
  /** The phone's offset from UTC the last sync gave; null before one did. refuseOffset: be a cardd before it. */
  hostingOffsetMin: number | null = null;
  refuseOffset = false;
  /** The last renewal problem: text and unix seconds; '' when the last renewal went through. */
  hostingProblem = { text: '', at: 0 };
  /** What the next Renew nows do (the fee when sent). */
  renewOutcome: { status: SendAnswer['status']; feeMsat?: number } = { status: 'sent', feeMsat: 0 };
  /** Snapshots by version (GET /api/v1/backups/{version}), as server/internal/backup keeps them. */
  readonly snapshots = new Map<number, Uint8Array>();
  backupInstallId = '00112233445566778899aabbccddeeff';
  backupRecipient = vectors.phrase.backupAgeRecipient;
  backupProblem = '';
  backupLatest: { version: number; created: number; size: number; sha256: string } | null = null;
  lastCheckIn = 0;
  lastDownload = 0;
  /** Serve snapshots without a Content-Length, as cardd never does. */
  backupNoLength = false;
  /** Each card's photo: the base64 JPEG and its tag. Not decoded: cardd's checks are Go-tested. */
  readonly photos = new Map<string, { jpeg: string; photo: string }>();
  /** false: an older cardd, without card photos, whose router answers the photo routes with a plain-text 404. */
  photoRoutes = true;
  /** false: a cardd from before held reads of the wallet: its answers have no rev and it answers at once whatever is asked. */
  holds = true;
  private changes = 0;
  private heldReads: (() => void)[] = [];
  /** false: an older cardd, with no shop in its wallet and a plain-text 404 for the shop's and the sales' routes. */
  shopRoutes = true;
  /** The server's currency (meta currency): null when never set, 'none', or a code. */
  currency: CurrencyCode | 'none' | null = null;
  /** cardd's last rate (internal/rates): its time and whole units of each currency per BTC; null before the first. */
  prices: { time: number; per: Partial<Record<CurrencyCode, number>> } | null = null;
  /** false: an older cardd: no fiat in its wallet, and a plain-text 404 for /currency and /pos/fiat. */
  fiatRoutes = true;
  /** The wallet's name (meta wallet.name): '' until it is named. */
  walletName = '';
  /** false: an older cardd: no name in its wallet, no wallet in /pos/me or the pair answer, a plain 404 for the PUT. */
  nameRoutes = true;
  /** The PoS phones by key id, removed ones too: a sale keeps its phone's name. */
  readonly pos = new Map<string, { name: string; created: number; removed: boolean }>();
  /** The one open pairing code: cardd keeps only its hash, the fake the code. */
  posCode: { code: string; name: string; expires: number } | null = null;
  /** The paid sales, oldest first, as an owner reads them. */
  readonly sold: Sale[] = [];
  /**
   * Every sale by its id, whatever became of it; cardAt: when its phone said a card was read; returnLink: the card's
   * return link its phone sent with that step.
   */
  readonly sales = new Map<string, Sale & { cardAt?: number; returnLink?: string }>();
  /**
   * Refunds of till sales: each request as the wallet sent it; the next one's outcome (sent by default: from
   * the account it names, 3 sat of fee to another server, none to a card of this wallet); this server's own refund
   * links, by link, with the card each pays back.
   */
  readonly refunds: { saleId: string; id: string; amountMsat: number; from: string; to?: string; offset?: string }[] = [];
  nextRefund: { wrongAmount: number } | { otherAmount: number; of: 'invoice' | 'offer' } | { pending: true } | { fail: string } | { refuse: string } | null = null;
  readonly ownLinks = new Map<string, { id: string; name: string }>();
  /** Each paid sale's history entry, whose refund a refund updates (cardd reads it fresh; the fake keeps it). */
  private readonly saleTx = new Map<string, Tx>();
  /** When each PoS phone last made a new sale (ms): cardd takes one a second from a phone. */
  private readonly lastSale = new Map<string, number>();
  /** The device whose signature the request in hand carried. */
  private caller = '';
  /** When this server was last restored (GET /api/v1/shop/phones' restored); 0: never. */
  restoredAt = 0;
  /** Request ids still being handled: the same id answers 409 request_in_progress. */
  readonly busy = new Set<string>();
  /** Answers by request id, with the body they answered. */
  private readonly answered = new Map<string, { body: string; status: number; answer: unknown }>();
  private txID = 1000;
  /** The phrase's issuer key, to check p and c the way cardd does. */
  issuer = new Uint8Array(16);
  host = 'vm-1.lnvps.cloud';
  /** GET /api/v1/wallet's restore: set by a restore, and by tests to any state. */
  restore: RestoreInfo | null = null;
  /** What setting the books after a restore books to pool: phoenixd's balance less what the books owe (msat). */
  restoreDiffMsat = 0;
  /** /data/cardd.db is there: cardd made it at up, or a restore wrote it; wipe deletes it. */
  database = false;
  /** What install.sh restore or restore-fresh last put in place, with the database's bytes as they arrived. */
  restored: { kind: 'db'; db: Uint8Array; device: string; from?: string; final?: true } | { kind: 'fresh'; device: string } | null = null;
  /** The RETIRED marker beside phoenixd's seed (install.sh retire). */
  retired: { at: string; replacedBy: number } | null = null;
  /** phoenixd's seed is there (false: never installed, or re-installed through LNVPS); install.sh retired exits 9 without it. */
  seeded = true;

  constructor(private readonly nowMs: () => number) {
    this.http.date = () => new Date(this.nowMs()).toUTCString();
    this.http.on('GET', /^https:\/\/[^/]+\/api\/v1\/server$/, (req) => {
      this.authorize(req.init, 'GET', '/api/v1/server', req.body ?? '');
      return { version: this.version, bundle: this.meta.get('bundle.sha256') ?? '', schema: this.schema, ...(this.dns ? { dns: this.dns } : {}) };
    });
    this.cardRoutes();
  }

  /** Answers onboarding's cardd-ctl commands on `ssh`. */
  serve(ssh: FakeSsh): this {
    ssh.when(new RegExp(`cardd-ctl meta set ${QUOTED} ${QUOTED}$`), (cmd) => {
      const [, k, v] = new RegExp(`meta set ${QUOTED} ${QUOTED}$`).exec(cmd)!;
      this.meta.set(unquote(k), unquote(v));
      return {};
    });
    ssh.when(new RegExp(`cardd-ctl device revoke-others -keep ${QUOTED}$`), (cmd) => {
      const keep = unquote(new RegExp(`-keep ${QUOTED}$`).exec(cmd)![1]);
      if (!this.devices.has(keep) || this.revoked.has(keep)) return { code: 1, stderr: `cardd: store: not found: device "${keep}"` };
      const others = [...this.devices.keys()].filter((id) => id !== keep && !this.revoked.has(id));
      for (const id of others) this.revoked.add(id);
      return { stdout: `${others.length}\n` };
    });
    ssh.when(/cardd-ctl device add/, (cmd) => {
      const pub = unquote(new RegExp(`-pubkey ${QUOTED}`).exec(cmd)![1]);
      const id = keyId(hexToBytes(pub));
      if (this.revoked.has(id)) return { code: 5, stderr: `cardd: device ${id} was revoked; generate a new key on the phone` };
      this.devices.set(id, pub);
      return { stdout: `${id}\n` };
    });
    // A rebuild's commands (deploy/install.sh), with their exit codes.
    // install.sh restore DEVICE VMID HOST IPV4 [FROM [final]], and restore-fresh DEVICE VMID HOST IPV4.
    const VM = `${QUOTED} ${QUOTED} ${QUOTED}`;
    const vmOf = (id: string, host: string, ipv4: string) => ({ id: unquote(id), host: unquote(host), ipv4: unquote(ipv4) });
    ssh.when(new RegExp(`install\\.sh restore ${QUOTED} ${VM}(?: ${QUOTED}( final)?)?$`), (cmd, stdin) => {
      const [, device, id, host, ipv4, from, final] = new RegExp(`restore ${QUOTED} ${VM}(?: ${QUOTED}( final)?)?$`).exec(cmd)!;
      // GNU base64 -d takes any line wrapping.
      const db = base64.decode((stdin ?? '').replace(/\s+/g, ''));
      return this.restoreDatabase(
        { kind: 'db', db, device: unquote(device), ...(from ? { from: unquote(from) } : {}), ...(final && { final: true as const }) }, vmOf(id, host, ipv4));
    });
    ssh.when(new RegExp(`install\\.sh restore-fresh ${QUOTED} ${VM}$`), (cmd) => {
      const [, device, id, host, ipv4] = new RegExp(`restore-fresh ${QUOTED} ${VM}$`).exec(cmd)!;
      return this.restoreDatabase({ kind: 'fresh', device: unquote(device) }, vmOf(id, host, ipv4));
    });
    ssh.when(/install\.sh final-snapshot$/, () => {
      if (this.retired) return { code: 1, stderr: 'service "cardd" is not running' };
      const latest = this.backupLatest;
      if (!latest || this.backupProblem) return { code: 1, stderr: `cardd: no snapshot${this.backupProblem ? `: ${this.backupProblem}` : ''}` };
      return { stdout: `${JSON.stringify({ version: latest.version, created: latest.created })}\n` };
    });
    ssh.when(new RegExp(`install\\.sh retire ${QUOTED}$`), (cmd) => {
      const at = new Date(this.nowMs()).toISOString().replace(/\.\d+Z$/, 'Z');
      this.retired = { at, replacedBy: Number(unquote(new RegExp(`retire ${QUOTED}$`).exec(cmd)![1])) };
      return { stdout: 'retired\n' };
    });
    ssh.when(/install\.sh retired$/, () => {
      if (!this.seeded) return { code: 9, stderr: 'install.sh: no phoenixd seed here (no seed.dat)\n' };
      return this.retired ? { stdout: `${this.retired.at} ${this.retired.replacedBy}\n` } : { code: 1 };
    });
    ssh.when(/install\.sh seed$/, () => void (this.seeded = true)); // passed on: install.sh seed itself answers 0
    ssh.when(/install\.sh wipe$/, () => (this.wipe(), {}));
    ssh.when(/install\.sh up$/, () => {
      if (this.retired) return { code: 8, stderr: `install.sh up: this server was retired (replaced by VM ${this.retired.replacedBy})\n` };
      this.database = true;
      return {};
    });
    return this;
  }

  /** As cardd restore: only where no database is, or a repeat of the restore that wrote it; the new VM in meta from the start. */
  private restoreDatabase(r: NonNullable<FakeCardd['restored']>, vm: { id: string; host: string; ipv4: string }) {
    if (this.database) {
      if (this.meta.has('restore.from')) return { stdout: 'already restored\n' };
      return { code: 7, stderr: 'cardd: /data/cardd.db: a database is already there' };
    }
    if (r.kind === 'db' && r.db.length === 0) return { code: 1, stderr: "cardd: the backup isn't a cardd database: it has no meta table" };
    const from = r.kind === 'fresh' ? 'phrase' : (r.from ?? 'backup');
    this.database = true;
    this.restored = r;
    this.meta.set('vm.id', vm.id);
    this.meta.set('vm.host', vm.host);
    this.meta.set('vm.ipv4', vm.ipv4);
    this.meta.set('restore.from', from);
    const final = r.kind === 'db' && r.final === true;
    if (final) this.meta.set('restore.final', '1');
    else this.meta.delete('restore.final');
    this.restore = { state: 'pending', from, ...(final && { final }) };
    // The phrase that drove the SSH session is proof enough: the backup's revocation of this phone is undone.
    this.revoked.delete(keyId(hexToBytes(r.device)));
    return {};
  }

  /** As install.sh wipe: cardd's database and snapshots go, and phoenixd's data but its seed, the marker too. */
  private wipe() {
    for (const m of [this.meta, this.devices, this.revoked, this.cards, this.balances, this.history, this.payments, this.held, this.limits, this.snapshots, this.answered, this.sends]) m.clear();
    this.database = false;
    // The currency is in meta, the rate in the data directory's rates.json: both go.
    this.currency = null;
    this.prices = null;
    this.restore = this.retired = this.hostingSync = this.backupLatest = this.hostingOffsetMin = null;
    this.channel = false;
    this.channelUp = true;
    this.lastCheckIn = this.lastDownload = 0;
  }

  private authorize(init: RequestInit, method: string, path: string, body: string) {
    const header = ((init.headers ?? {}) as Record<string, string>).authorization ?? '';
    const m = /^Device ([0-9a-f]{16})\.(\d+)\.([0-9a-f]+)$/.exec(header);
    if (!m) throw new HttpError(401, 'unauthorized');
    const [, id, ts, sig] = m;
    const pub = this.devices.get(id);
    // As server/internal/deviceauth's Middleware answers.
    if (!pub || this.revoked.has(id) || this.pos.get(id)?.removed) {
      throw new HttpError(401, 'unknown device', { error: 'unauthorized', message: 'deviceauth: unknown or revoked device' });
    }
    if (Math.abs(Number(ts) - Math.floor(this.nowMs() / 1000)) > 60) throw new HttpError(401, 'timestamp out of range');
    // The Keystore makes high-S signatures about half the time; cardd accepts them.
    const ok = p256.verify(hexToBytes(sig), utf8ToBytes(canonical(method, path, Number(ts), body)), hexToBytes(pub), { format: 'der', lowS: false });
    if (!ok) throw new HttpError(401, 'bad signature');
    // deviceauth's boundary: a PoS phone is refused every path outside /api/v1/pos/, before any handler.
    if (this.pos.has(id) && !path.startsWith('/api/v1/pos/')) throw new HttpError(403, 'not allowed', { error: 'not_allowed', message: "a PoS phone can't do this" });
    this.caller = id;
  }

  private cardRoutes() {
    const card = (method: string, tail: string, fn: (id: string, body: Record<string, string>) => unknown) => {
      const re = new RegExp(`^https://[^/]+/api/v1/cards${tail}$`);
      this.http.on(method, re, (req) => {
        this.authorize(req.init, method, req.url.pathname, req.body ?? '');
        try {
          return fn(re.exec(req.url.origin + req.url.pathname)?.[1] ?? '', req.body ? JSON.parse(req.body) : {});
        } catch (e) {
          if (e instanceof Refusal) return json(e.status, { error: e.code, message: e.message });
          throw e;
        }
      });
    };
    card('GET', '', () => ({ cards: [...this.cards.values()].map((c) => ({ ...c, photo: this.photos.get(c.id)?.photo ?? '' })) }));
    this.moneyRoutes();
    card('POST', '', (_id, b) => this.reserve(b.id, b.name ?? ''));
    card('POST', '/adopt', (_id, b) => this.adopt(b as unknown as { version: unknown; name: unknown } & Sun));
    card('PUT', '/([0-9a-f]{32})/host', (id, b) => this.setHost(id, b.host));
    card('POST', '/check', (_id, b) => this.check(b as unknown as Sun & { proved?: boolean }));
    card('PATCH', '/([0-9a-f]{32})', (id, b) => this.rename(id, b.name ?? ''));
    card('POST', '/([0-9a-f]{32})/confirm', (id, b) => this.confirm(id, b as Sun));
    card('POST', '/([0-9a-f]{32})/wipe', (id) => this.startCardWipe(id));
    card('POST', '/([0-9a-f]{32})/wiped', (id) => this.move(id, 'reset', ['wiping', 'reset']));
    this.photoRoutesOn(card);
  }

  /** PUT, DELETE and GET /cards/{id}/photo, as server/internal/api's photo.go answers them. */
  private photoRoutesOn(card: (method: string, tail: string, fn: (id: string, body: Record<string, string>) => unknown) => void) {
    const older = () => new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const changeable = (id: string) => {
      const c = this.get(id);
      if (c.state === 'reset') throw new Refusal(409, 'conflict', 'store: conflicting state: card is reset');
      return c;
    };
    card('PUT', '/([0-9a-f]{32})/photo', (id, b) => {
      if (!this.photoRoutes) return older();
      const c = changeable(id);
      const photo = bytesToHex(sha256(base64.decode(b.jpeg ?? ''))).slice(0, 16);
      this.photos.set(id, { jpeg: b.jpeg, photo });
      c.updated = this.now();
      return { photo };
    });
    card('DELETE', '/([0-9a-f]{32})/photo', (id) => {
      if (!this.photoRoutes) return older();
      const c = changeable(id);
      if (this.photos.delete(id)) c.updated = this.now();
      return { photo: '' };
    });
    card('GET', '/([0-9a-f]{32})/photo', (id) => {
      if (!this.photoRoutes) return older();
      const p = this.photos.get(id);
      if (!p) throw new Refusal(404, 'not_found', 'store: not found');
      return { ...p };
    });
  }

  private moneyRoutes() {
    const route = (method: string, re: RegExp, fn: (req: { url: URL; body: string }) => unknown) =>
      this.http.on(method, re, (req) => {
        this.authorize(req.init, method, req.url.pathname + req.url.search, req.body ?? '');
        try {
          return fn({ url: req.url, body: req.body ?? '' });
        } catch (e) {
          // wrong_amount carries the figure cardd would pay.
          if (e instanceof Refusal && 'amountMsat' in e) {
            const x = e as Refusal & { amountMsat: number; of?: string };
            return json(e.status, { error: e.code, message: e.message, amountMsat: x.amountMsat, ...(x.of ? { of: x.of } : {}) });
          }
          if (e instanceof Refusal) return json(e.status, { error: e.code, message: e.message });
          throw e;
        }
      });
    const limits = (id: string) => this.cardLimits(id);
    // POST /api/v1/sales/{id}/refund: the whole sale, once, from the account named, never switched.
    route('POST', /^https:\/\/[^/]+\/api\/v1\/sales\/([0-9a-zA-Z-]+)\/refund$/, ({ url, body }) => {
      const saleId = /\/sales\/([^/]+)\/refund$/.exec(url.pathname)![1];
      return this.once(body, (b) => {
        const req = b as unknown as { id: string; amountMsat: number; from: string; to?: string };
        const tx = this.saleTx.get(saleId);
        if (!tx?.sale) throw new Refusal(409, 'not_paid', "store: the sale isn't paid");
        if (tx.sale.refund) throw new Refusal(409, 'already_refunded', 'store: the sale is refunded, or a refund of it is on its way');
        this.refunds.push({ saleId, ...req, ...(url.searchParams.has('offset') ? { offset: url.searchParams.get('offset')! } : {}) });
        const next = this.nextRefund;
        this.nextRefund = null;
        if (next && 'wrongAmount' in next) throw Object.assign(new Refusal(409, 'wrong_amount', "api: not the sale's amount"), { amountMsat: next.wrongAmount });
        // other_amount: the customer's invoice or offer is for another amount.
        if (next && 'otherAmount' in next) throw Object.assign(new Refusal(409, 'other_amount', `the ${next.of} is for another amount`), { amountMsat: next.otherAmount, of: next.of });
        if (next && 'refuse' in next) throw new Refusal(400, next.refuse, `lnaddr: the card's server refused: it is down`);
        if (next && 'fail' in next) return { status: 'failed', paymentHash: '', amountMsat: req.amountMsat, reason: next.fail };
        if (next && 'pending' in next) {
          tx.sale.refund = { state: 'pending' };
          this.changed();
          return { status: 'pending', paymentHash: '', amountMsat: req.amountMsat };
        }
        const toCard = !req.to && tx.sale.returnAddress && 'card' in tx.sale.returnAddress;
        const feeMsat = toCard ? 0 : 3_000;
        const refund = this.add(req.from, -(req.amountMsat + feeMsat), 'refund', `refund of sale ${saleId}`, feeMsat, { sale: tx.sale });
        tx.sale.refund = { state: 'paid', txId: refund.id, at: this.now(), amountMsat: req.amountMsat, from: req.from as 'shop' | 'pool' };
        this.changed();
        return { status: 'sent', paymentHash: '', amountMsat: req.amountMsat, feeMsat };
      });
    });
    route('GET', /^https:\/\/[^/]+\/api\/v1\/wallet$/, async ({ url }) => {
      // A held read (?since=<rev>&wait=seconds): with nothing new since that rev, the answer waits for a change to
      // the books, or for waitOver(), which is the wait running out.
      if (this.holds && Number(url.searchParams.get('wait') ?? 0) > 0 && url.searchParams.get('since') === this.rev()) {
        await new Promise<void>((go) => this.heldReads.push(go));
      }
      const account = (key: string, address: string) => ({ balanceMsat: this.balances.get(key) ?? 0, heldMsat: this.held.get(key) ?? 0, address });
      return {
        ...(this.holds ? { rev: this.rev() } : {}),
        cards: [...this.cards.values()].filter((c) => c.state !== 'reset').map((c) => ({
          id: c.id, name: c.name, state: c.state, version: c.version, spent24hMsat: 0, ...limits(c.id),
          ...account(c.id, `c${c.id.slice(0, 10)}@${this.host}`),
        })),
        pool: account('pool', `pool@${this.host}`),
        hosting: account('hosting', `hosting@${this.host}`),
        paused: this.paused() !== '', pausedReason: this.paused(),
        liquidity: { channel: this.channel, usable: this.channel && this.channelUp, inboundSat: this.channel ? 1_900_000 : 0, feeCreditSat: this.feeCreditSat,
          firstChannelFeeSat: this.channel ? 0 : 21_411 },
        restore: this.restore && { ...this.restore },
        ...(this.shopRoutes ? { shop: { ...account('shop', ''), phones: this.posPhones().length, sales: this.sold.length } } : {}),
        ...(this.fiatRoutes ? { fiat: this.fiat() } : {}),
        ...(this.nameRoutes ? { name: this.walletName } : {}),
      };
    });
    route('PUT', /^https:\/\/[^/]+\/api\/v1\/wallet\/name$/, ({ body }) => {
      if (!this.nameRoutes) return new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      const name = String((JSON.parse(body || '{}') as { name?: unknown }).name ?? '').trim();
      if (!isName(name)) throw new Refusal(400, 'bad_name', "store: a wallet's name is 1 to 24 characters, none of them hidden");
      this.walletName = name;
      // Bell.Changed(nil), as for the currency: every wallet phone hears of it at once.
      this.changed();
      return { name };
    });
    route('PUT', /^https:\/\/[^/]+\/api\/v1\/currency$/, ({ body }) => {
      if (!this.fiatRoutes) return new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      const code = String((JSON.parse(body || '{}') as { currency?: unknown }).currency ?? '');
      if (code !== 'none' && !isCode(code)) throw new Refusal(400, 'malformed', 'api: bad request: currency is none or one of USD EUR GBP CAD CHF AUD JPY');
      this.currency = code as CurrencyCode | 'none';
      // Bell.Changed(nil): the rev moves, so a held read of the wallet answers at once on every wallet phone.
      this.changed();
      return { fiat: this.fiat() };
    });
    route('GET', /^https:\/\/[^/]+\/api\/v1\/accounts\/([^/]+)\/history$/, ({ url }) => {
      const before = Number(url.searchParams.get('before') ?? 0) || Infinity;
      const limit = Number(url.searchParams.get('limit') ?? 0) || 50;
      const all = this.history.get(url.pathname.split('/')[4]) ?? [];
      // A sale's line names its phone as it is called now (store's History joins devices).
      const named = (t: Tx): Tx => (t.sale ? { ...t, sale: { ...t.sale, device: this.sold.find((s) => s.id === t.sale!.id)!.device.name } } : t);
      return { transactions: all.filter((t) => t.id < before).slice(0, limit).map(named) };
    });
    const older = () => new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const findLine = (account: string, id: number) => {
      const t = (this.history.get(account) ?? []).find((x) => x.id === id);
      if (!t) throw new Refusal(404, 'not_found', 'store: not found');
      return t;
    };
    const lineOut = (t: Tx): TxDetail => ({ ...t, comment: t.comment ?? '', ...(this.payments.has(t.id) ? { payment: this.payments.get(t.id) } : {}) });
    route('GET', /^https:\/\/[^/]+\/api\/v1\/accounts\/([^/]+)\/transactions\/(\d+)$/, ({ url }) => {
      if (!this.transactionRoutes) return older();
      const p = url.pathname.split('/');
      return lineOut(findLine(p[4], Number(p[6])));
    });
    route('PATCH', /^https:\/\/[^/]+\/api\/v1\/accounts\/([^/]+)\/transactions\/(\d+)$/, ({ url, body }) => {
      if (!this.transactionRoutes) return older();
      const p = url.pathname.split('/');
      const t = findLine(p[4], Number(p[6]));
      t.comment = cleanNote((JSON.parse(body) as { comment?: string }).comment);
      this.changed();
      return lineOut(t);
    });
    route('POST', /^https:\/\/[^/]+\/api\/v1\/ledger\/reconcile$/, () => {
      if (this.restore && this.restore.state !== 'done') {
        throw new Refusal(409, 'restore_pending', "ledger: after a restore the books are set to phoenixd's balance once its channel is back");
      }
      this.pausedReason = '';
      return { bookedMsat: 0 };
    });
    route('POST', /^https:\/\/[^/]+\/api\/v1\/ledger\/restore-books$/, () => {
      const r = this.restore;
      if (r?.state !== 'no_channel') throw new Refusal(409, 'not_no_channel', 'ledger: the books are set by hand after a restore only when no channel came back');
      if (this.channel && !this.channelUp) throw new Refusal(409, 'channel_not_up', "ledger: phoenixd has a channel that isn't up yet: wait for it");
      const diff = this.restoreDiffMsat;
      if (diff) this.add('pool', diff, 'adjust', "restore: the books set to phoenixd's balance");
      this.restore = { state: 'done', from: r.from, reconciledMsat: diff, reconciledAt: this.now() };
      return { bookedMsat: diff };
    });
    route('POST', /^https:\/\/[^/]+\/api\/v1\/move$/, ({ body }) =>
      this.once(body, (b) => {
        const amount = Number(b.amountMsat);
        if (!(amount > 0) || b.from === b.to) throw new Refusal(400, 'malformed', 'api: bad request: a move needs an amount and two different accounts');
        // Shop is paid by its sales alone (store.ErrCannotReceive).
        if (b.to === 'shop') throw new Refusal(409, 'cannot_receive', "store: this account can't receive money");
        if ((this.balances.get(b.from) ?? 0) - (this.held.get(b.from) ?? 0) < amount) throw new Refusal(409, 'insufficient', 'store: not enough money available');
        this.add(b.from, -amount, 'move', 'moved by the phone', 0, this.shopRoutes ? { other: b.to } : {});
        this.add(b.to, amount, 'move', 'moved by the phone', 0, this.shopRoutes ? { other: b.from } : {});
        return { status: 'moved' };
      }));
    this.shopRoutesOn(route);
    this.pushRoutesOn(route);
    route('POST', /^https:\/\/[^/]+\/api\/v1\/send\/lookup$/, ({ body }) => {
      const to = String((JSON.parse(body) as { to: string }).to);
      const l = this.lookups.get(to);
      if (l && 'refusal' in l) throw new Refusal(400, 'bad_destination', l.refusal);
      if (l) return l;
      if (/^lno1/i.test(to)) return { kind: 'offer', offer: to.toLowerCase(), amountMsat: null, description: '', issuer: '' };
      const named = /^₿([^@]+)@(.+)$/.exec(to);
      // A ₿ name is tried as BIP353 alone (server/internal/sendto): with no record it doesn't exist, never LNURL.
      if (named) throw new Refusal(400, 'bad_destination', `${to} doesn't exist: ${named[2]} has no BIP353 record for ${named[1]}.`);
      return { kind: 'payurl', to, minMsat: 1_000, maxMsat: 1_000_000_000, description: '' };
    });
    // Before GET /send/{id}, whose pattern would take recent for an id.
    route('GET', /^https:\/\/[^/]+\/api\/v1\/send\/recent$/, () => ({ recent: this.recent }));
    route('DELETE', /^https:\/\/[^/]+\/api\/v1\/send\/recent$/, ({ body }) => {
      if (this.removeRecentFails !== null) throw new Refusal(500, 'internal', this.removeRecentFails);
      const to = String((JSON.parse(body) as { to: string }).to).toLowerCase();
      this.recent = this.recent.filter((r) => r.to.toLowerCase() !== to);
      return new Response(null, { status: 204 });
    });
    route('GET', /^https:\/\/[^/]+\/api\/v1\/send\/([^/?]+)/, ({ url }) => {
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const s = this.sends.get(id);
      if (!s) throw new Refusal(404, 'not_found', 'store: not found');
      return s;
    });
    route('POST', /^https:\/\/[^/]+\/api\/v1\/send$/, ({ body }) =>
      this.once(body, (b) => {
        const amountMsat = Number(b.amountMsat ?? 1_000_000);
        // An offer's hash is phoenixd's, known only once it pays: '' until then.
        const offer = /^lno1/i.test(String(b.to));
        const paymentHash = bytesToHex(sha256(utf8ToBytes(`send:${b.id}`)));
        const comment = cleanNote(b.comment);
        if (this.sendRefusal) throw new Refusal(this.sendRefusal.status, this.sendRefusal.code, this.sendRefusal.message);
        const { status, feeMsat = 0, reason } = this.sendOutcome;
        if (status === 'sent') {
          const tx = this.add('pool', -(amountMsat + feeMsat), 'send', `paid ${paymentHash}`, feeMsat, comment ? { comment } : {});
          const to = String(b.to);
          const link = to.includes('@') || /^https?:\/\//i.test(to);
          // A name is the destination the person gave; an offer's line keeps the offer.
          const destination = b.name || (offer ? 'an offer' : link ? to : undefined);
          this.payments.set(tx.id, {
            hash: paymentHash, preimage: bytesToHex(sha256(utf8ToBytes(`pre:${b.id}`))), ...(offer ? { offer: to } : { invoice: link ? `lnbcfake${paymentHash}` : to }), ...(destination ? { destination } : {}),
          });
        }
        if (status === 'pending') {
          this.held.set('pool', (this.held.get('pool') ?? 0) + amountMsat + feeBudgetMsat(amountMsat));
          this.pendingSend = { id: b.id, paymentHash, amountMsat };
        }
        const answer: SendAnswer =
          status === 'sent' ? { status, paymentHash, amountMsat, feeMsat }
          : status === 'pending' ? { status, paymentHash: offer ? '' : paymentHash, amountMsat }
          : { status, paymentHash: offer ? '' : paymentHash, amountMsat, ...(reason ? { reason } : {}) };
        this.sends.set(b.id, answer);
        return answer;
      }));
    route('GET', /^https:\/\/[^/]+\/api\/v1\/hosting$/, () => this.hostingStatus());
    route('PUT', /^https:\/\/[^/]+\/api\/v1\/hosting$/, ({ body }) => {
      const b = JSON.parse(body) as { expires: number; satPerDay: number; vatOk: boolean; utcOffsetMin?: number };
      if (b.utcOffsetMin !== undefined && this.refuseOffset) throw new Refusal(400, 'malformed', 'unknown field "utcOffsetMin"');
      if (b.utcOffsetMin !== undefined && !(b.utcOffsetMin >= -720 && b.utcOffsetMin <= 840)) {
        throw new Refusal(400, 'bad_sync', 'renew: the sync\'s values are out of range');
      }
      if (b.utcOffsetMin !== undefined) this.hostingOffsetMin = b.utcOffsetMin;
      if (!(b.satPerDay >= 20 && b.satPerDay <= 20_000) || Math.abs(b.expires - this.now()) > 2 * 365 * 86400) {
        throw new Refusal(400, 'bad_sync', 'renew: the sync\'s values are out of range');
      }
      this.hostingSync = { expires: b.expires, msatPerDay: Math.round(b.satPerDay * 1000), vatOk: b.vatOk, syncedAt: this.now() };
      return this.hostingStatus();
    });
    route('POST', /^https:\/\/[^/]+\/api\/v1\/hosting\/renew$/, ({ body }) =>
      this.once(body, (b) => {
        const days = Number(b.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Refusal(400, 'bad_days', 'renew: days must be a whole number from 1 to 365');
        const h = this.hostingSync;
        if (!h) throw new Refusal(409, 'not_synced', "renew: the app hasn't synced the VM's expiry from LNVPS yet");
        if (!h.vatOk) throw new Refusal(409, 'vat', 'renew: LNVPS charges VAT for a country other than this account\'s');
        const amountMsat = Math.ceil((days * h.msatPerDay) / 1000) * 1000;
        const paymentHash = bytesToHex(sha256(utf8ToBytes(`renew:${b.id}`)));
        const { status, feeMsat = 0 } = this.renewOutcome;
        if (status === 'sent') {
          this.add('hosting', -(amountMsat + feeMsat), 'renew', `paid ${paymentHash}`, feeMsat);
          h.expires += days * 86400;
        }
        if (status === 'pending') this.held.set('hosting', (this.held.get('hosting') ?? 0) + amountMsat + feeBudgetMsat(amountMsat));
        return status === 'sent' ? { status, paymentHash, amountMsat, feeMsat } : { status, paymentHash, amountMsat };
      }));
    // As server/internal/backup's CheckIn: the status as it was, with the check-in before this one.
    route('GET', /^https:\/\/[^/]+\/api\/v1\/backups$/, () => {
      const before = this.lastCheckIn;
      this.lastCheckIn = this.now();
      return {
        installId: this.backupInstallId, recipient: this.backupRecipient, latest: this.backupLatest,
        lastCheckIn: before, lastDownload: this.lastDownload, problem: this.backupProblem,
      };
    });
    route('GET', /^https:\/\/[^/]+\/api\/v1\/backups\/[^/]+$/, ({ url }) => {
      const file = this.snapshots.get(Number(url.pathname.split('/').pop()));
      if (!file) throw new Refusal(404, 'no_snapshot', 'backup: no such snapshot');
      this.lastDownload = this.now();
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (!this.backupNoLength) headers['content-length'] = String(file.length);
      return new Response(file.slice(), { status: 200, headers });
    });
    const cardRoute = (method: string, tail: string, fn: (c: CardInfo, b: Record<string, number>) => unknown) =>
      route(method, new RegExp(`^https://[^/]+/api/v1/cards/([0-9a-f]{32})${tail}$`), ({ url, body }) =>
        fn(this.get(url.pathname.split('/')[4]), body ? JSON.parse(body) : {}));
    cardRoute('POST', '/freeze', (c) => this.move(c.id, 'frozen', ['active', 'frozen']));
    cardRoute('POST', '/unfreeze', (c) => this.move(c.id, 'active', ['active', 'frozen']));
    cardRoute('PATCH', '/limits', (c, raw) => {
      const b = raw as unknown as { perTapSat?: number; dailySat?: number; currency?: string; perTapMinor?: number; dailyMinor?: number };
      const bad = () => new Refusal(400, 'bad_limits', 'cards: limits are 1 to 2,000,000 sat, and the 24-hour limit is at least the per-tap one');
      if (b.currency === undefined) {
        const per = Number(b.perTapSat);
        const day = Number(b.dailySat);
        if (!(per > 0) || !(day > 0) || per > day || day > 2_000_000) throw bad();
        // Sat limits clear any currency.
        this.limits.set(c.id, { perTapSat: per, dailySat: day });
        return { ...c, ...limits(c.id) };
      }
      if (!isCode(b.currency)) throw new Refusal(400, 'malformed', 'api: bad request: limits are in sat or in one of the seven currencies');
      const r = this.rate(b.currency);
      if (!r) throw new Refusal(409, 'no_rate', `No ${symbol(b.currency).trim()} rate yet: set the limits in sat.`);
      const per = Number(b.perTapMinor);
      const day = Number(b.dailyMinor);
      if (!Number.isInteger(per) || !Number.isInteger(day) || per < 1 || day < per || day > MAX_MINOR || limitToMsat(day, r) > 2_000_000_000) throw bad();
      // The stored sats stay as they were, unused while the currency is set.
      const was = this.limits.get(c.id) ?? { perTapSat: 20_000, dailySat: 50_000 };
      this.limits.set(c.id, { perTapSat: was.perTapSat, dailySat: was.dailySat, currency: b.currency, perTapMinor: per, dailyMinor: day });
      return { ...c, ...limits(c.id) };
    });
  }

  /** The shop as its owner manages it and reads its sales (server/internal/api's shop.go and pos.go). */
  private shopRoutesOn(route: (method: string, re: RegExp, fn: (req: { url: URL; body: string }) => unknown) => void) {
    const older = () => new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const shop = (method: string, tail: string, fn: (req: { url: URL; body: Record<string, string> }) => unknown) =>
      route(method, new RegExp(`^https://[^/]+/api/v1/${tail}$`), ({ url, body }) => (this.shopRoutes ? fn({ url, body: body ? JSON.parse(body) : {} }) : older()));
    const none = () => new Response(null, { status: 204 });
    shop('POST', 'shop/codes', ({ body }) => {
      const code = this.newCode(body.name ?? '');
      return json(201, { code, expires: this.posCode!.expires });
    });
    shop('DELETE', 'shop/codes', () => {
      this.posCode = null;
      return none();
    });
    shop('GET', 'shop/phones', () => ({
      phones: this.posPhones().map(([keyId, p]) => {
        const mine = this.sold.filter((s) => s.device.keyId === keyId);
        return { keyId, name: p.name, created: p.created, sales: mine.length, ...(mine.length ? { lastSale: mine[mine.length - 1].paidAt } : {}) };
      }),
      ...(this.restoredAt ? { restored: this.restoredAt } : {}),
    }));
    const phone = (keyId: string) => {
      const p = this.pos.get(keyId);
      if (!p || p.removed) throw new Refusal(404, 'not_found', 'store: not found');
      return p;
    };
    shop('PATCH', 'shop/phones/[^/]+', ({ url, body }) => {
      const keyId = url.pathname.split('/')[5];
      // The name is judged first, as store's RenamePosPhone does.
      const name = this.phoneName(body.name ?? '', keyId);
      this.renamePhone(keyId, phone(keyId), name);
      return { keyId, name };
    });
    shop('DELETE', 'shop/phones/[^/]+', ({ url }) => {
      phone(url.pathname.split('/')[5]).removed = true;
      return none();
    });
    // A PoS phone lists the sales it took, the owner every phone's (api's salesOf).
    const listed = () => (this.pos.has(this.caller) ? this.sold.filter((s) => s.device.keyId === this.caller) : this.sold);
    shop('GET', 'pos/sales', ({ url }) => {
      const before = Number(url.searchParams.get('before') ?? 0) || Infinity;
      const limit = Number(url.searchParams.get('limit') ?? 0);
      const paid = listed().filter((s) => s.txId! < before).reverse();
      return { sales: paid.slice(0, limit > 0 && limit <= 100 ? limit : 50).map((s) => this.saleJson(s)) };
    });
    this.posRoutesOn(shop);
    shop('GET', 'pos/sales/days', ({ url }) => {
      const offset = Number(url.searchParams.get('offset') ?? NaN);
      if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
        throw new Refusal(400, 'malformed', "api: bad request: offset is the phone's minutes east of UTC, -840 to 840");
      }
      const limit = Number(url.searchParams.get('limit') ?? 0);
      const days = new Map<number, { day: number; count: number; totalMsat: number }>();
      for (const s of listed()) {
        const day = Math.floor((s.paidAt! + offset * 60) / 86400) * 86400 - offset * 60;
        const d = days.get(day) ?? { day, count: 0, totalMsat: 0 };
        days.set(day, { day, count: d.count + 1, totalMsat: d.totalMsat + s.amountMsat });
      }
      return { days: [...days.values()].sort((a, b) => b.day - a.day).slice(0, limit > 0 && limit <= 90 ? limit : 30) };
    });
  }

  /** What a PoS phone calls (server/internal/api's pos.go), and the public pairing call. */
  private posRoutesOn(shop: (method: string, tail: string, fn: (req: { url: URL; body: Record<string, string> }) => unknown) => void) {
    const posOnly = () => {
      if (!this.pos.has(this.caller)) throw new Refusal(403, 'not_allowed', 'only a PoS phone does this');
    };
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const read = (url: URL) => {
      const id = url.pathname.split('/')[5];
      if (!UUID.test(id)) throw new Refusal(400, 'malformed', "api: bad request: a sale's id is a UUID");
      const s = this.sales.get(id);
      if (!s) throw new Refusal(404, 'not_found', 'store: not found');
      // An open sale past its time reads as expired, and is from then on.
      if (s.state === 'open' && s.expires < this.now()) s.state = 'expired';
      return s;
    };
    const own = (url: URL) => {
      posOnly();
      const s = read(url);
      if (s.device.keyId !== this.caller) throw new Refusal(403, 'not_allowed', "store: this sale is another phone's");
      return s;
    };
    this.http.on('POST', /^https:\/\/[^/]+\/pos\/pair$/, (req) => {
      if (!this.shopRoutes) return new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      try {
        const b = JSON.parse(req.body ?? '{}') as { code?: string; publicKey?: string };
        const pub = String(b.publicKey ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(b.code ?? '')) throw new Refusal(403, 'bad_code', 'store: this pairing code is unknown, used or run out');
        if (!/^04[0-9a-f]{128}$/.test(pub)) throw new Refusal(400, 'malformed', 'public key: not an uncompressed P-256 point');
        const id = keyId(hexToBytes(pub));
        // An owner's key never becomes a PoS phone's.
        if (this.devices.has(id) && !this.pos.has(id)) throw new Refusal(409, 'key_known', 'store: this key is already a device of this server');
        this.pair(b.code!, id);
        this.devices.set(id, pub);
        return json(201, { keyId: id, name: this.pos.get(id)!.name, ...(this.nameRoutes ? { wallet: this.walletName } : {}) });
      } catch (e) {
        if (e instanceof Refusal) return json(e.status, { error: e.code, message: e.message });
        throw e;
      }
    });
    shop('GET', 'pos/fiat', () => {
      if (!this.fiatRoutes) return new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return { fiat: this.fiat() };
    });
    shop('GET', 'pos/me', () => {
      const p = this.pos.get(this.caller);
      return { keyId: this.caller, name: p ? p.name : 'phone', role: p ? 'pos' : 'owner', ...(this.nameRoutes ? { wallet: this.walletName } : {}) };
    });
    shop('DELETE', 'pos/me', () => {
      posOnly();
      this.pos.get(this.caller)!.removed = true;
      return new Response(null, { status: 204 });
    });
    shop('POST', 'pos/sales', ({ body }) => {
      posOnly();
      const b = body as unknown as { id?: string; amountSat?: number; price?: { currency?: unknown; minor?: unknown } };
      const id = String(b.id ?? '');
      if (!UUID.test(id)) throw new Refusal(400, 'malformed', "api: bad request: a sale's id is a UUID");
      if ((b.amountSat === undefined) === (b.price === undefined)) throw new Refusal(400, 'malformed', 'api: bad request: a sale has amountSat or price');
      let sat = Number(b.amountSat);
      let price: Price | undefined;
      if (b.price) {
        const code = String(b.price.currency ?? '');
        const minor = Number(b.price.minor);
        if (!isCode(code) || !Number.isInteger(minor) || minor < 1 || minor > MAX_MINOR) throw new Refusal(400, 'malformed', 'api: bad request: a price is one of the seven currencies and 1 to 10^10 minor units');
        price = { currency: code, minor };
      } else if (!Number.isInteger(sat) || sat < 1 || sat > 2_000_000) {
        throw new Refusal(400, 'malformed', 'api: bad request: a sale is for 1 to 2,000,000 sat');
      }
      // The same request again finds its sale before anything is converted: by its price, or by its sats.
      const had = this.sales.get(id);
      if (had) {
        const same = price ? had.price?.currency === price.currency && had.price.minor === price.minor : !had.price && had.amountMsat === sat * 1000;
        if (had.device.keyId !== this.caller || !same) throw new Refusal(409, 'sale_exists', 'store: this sale id is already another sale');
        return this.saleJson(had, true);
      }
      if (price) {
        if (price.currency !== this.currency) throw new Refusal(409, 'wrong_currency', "The shop's currency changed: start the sale again.");
        const r = this.rate(price.currency);
        if (!r) throw new Refusal(409, 'no_rate', `No ${symbol(price.currency).trim()} rate yet: type the price in sat.`);
        sat = minorToMsat(price.minor, r) / 1000;
        if (sat < 1 || sat > 2_000_000) throw new Refusal(400, 'malformed', 'api: bad request: a sale is for 1 to 2,000,000 sat');
      }
      const last = this.lastSale.get(this.caller);
      if (last !== undefined && this.nowMs() - last < 1000) throw new Refusal(429, 'slow_down', 'api: one new sale a second from a phone');
      this.lastSale.set(this.caller, this.nowMs());
      // A phone has one open sale: the earlier one is cancelled, or expired if its time has passed.
      for (const s of this.sales.values()) {
        if (s.device.keyId === this.caller && s.state === 'open') s.state = s.expires < this.now() ? 'expired' : 'cancelled';
      }
      const at = this.now();
      // BOLT 11's amount: u is a millionth of a bitcoin (100 sat), n a thousandth of that.
      const invoice = `lnbc${sat % 100 === 0 ? `${sat / 100}u` : `${sat * 10}n`}1${bytesToHex(sha256(utf8ToBytes(`sale:${id}`))).slice(0, 40)}`;
      const sale: Sale = {
        id, amountMsat: sat * 1000, state: 'open', method: '', device: { keyId: this.caller, name: this.pos.get(this.caller)!.name }, created: at, expires: at + 600, invoice,
        ...(price ? { price } : {}),
      };
      this.sales.set(id, sale);
      return json(201, this.saleJson(sale, true));
    });
    // Not /pos/sales/days, which Go's mux gives to its own handler.
    shop('GET', 'pos/sales/(?!days$)[0-9a-zA-Z-]+', ({ url }) => this.saleJson(read(url), true));
    shop('POST', 'pos/sales/[0-9a-zA-Z-]+/card', ({ url, body }) => {
      const s = own(url);
      if (s.state === 'open' && s.cardAt === undefined) {
        s.cardAt = this.now();
        const link = (body as { returnLink?: unknown } | undefined)?.returnLink;
        if (typeof link === 'string') s.returnLink = link;
      }
      return this.saleJson(s, true);
    });
    shop('POST', 'pos/sales/[0-9a-zA-Z-]+/cancel', ({ url }) => {
      const s = own(url);
      if (s.state === 'open') s.state = 'cancelled';
      return this.saleJson(s, true);
    });
  }

  /** A sale as cardd answers it (saleJSON): its phone's name as it is now; the invoice only while open; what Shop received for an owner only. */
  private saleJson(s: Sale & { cardAt?: number; returnLink?: string }, wrapped = false): unknown {
    const { cardAt: _cardAt, returnLink: _returnLink, invoice, receivedMsat, ...rest } = s;
    const out = {
      ...rest,
      device: { ...s.device, name: this.pos.get(s.device.keyId)?.name ?? s.device.name },
      ...(s.state === 'open' && invoice ? { invoice } : {}),
      ...(s.state === 'paid' && !this.pos.has(this.caller) ? { receivedMsat } : {}),
    };
    return wrapped ? { sale: out } : out;
  }

  /**
   * A sale is paid, whatever it was before (open, cancelled or run out: a wallet that has the invoice can still pay
   * it): Shop is credited what reached the balance, and the sale is "by card" when its phone said a card was read.
   */
  paySale(id: string, receivedMsat?: number): void {
    const s = this.sales.get(id)!;
    const got = receivedMsat ?? s.amountMsat;
    const method = s.cardAt !== undefined ? 'card' : 'qr';
    const own = s.returnLink ? this.ownLinks.get(s.returnLink) : undefined;
    const returnAddress = own ? { card: own } : s.returnLink ? { host: new URL(s.returnLink).hostname } : undefined;
    const tx = this.add('shop', got, 'sale', `received ${s.amountMsat / 1000} sat`, 0, {
      sale: { id, method, device: s.device.name, priceMsat: s.amountMsat, ...(s.price ? { price: s.price } : {}), paidAt: this.now(), refund: null, ...(returnAddress ? { returnAddress } : {}) },
    });
    this.saleTx.set(id, tx);
    Object.assign(s, { state: 'paid', method, paidAt: this.now(), txId: this.txID, receivedMsat: got });
    delete s.invoice;
    this.sold.push(s);
  }

  /** The PoS phones that aren't removed, oldest first. */
  private posPhones() {
    return [...this.pos].filter(([, p]) => !p.removed).sort(([a, p], [b, q]) => p.created - q.created || (a < b ? -1 : 1));
  }

  /** store's phoneName and nameFree: trimmed, 1 to 24 characters, no other PoS phone's name. */
  private phoneName(name: string, except = ''): string {
    const trimmed = name.trim();
    // eslint-disable-next-line no-control-regex
    if ([...trimmed].length < 1 || [...trimmed].length > 24 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
      throw new Refusal(400, 'bad_name', "store: a PoS phone's name is 1 to 24 characters");
    }
    if (this.posPhones().some(([keyId, p]) => p.name === trimmed && keyId !== except)) throw new Refusal(409, 'name_taken', 'store: a PoS phone already has this name');
    return trimmed;
  }

  /** POST /api/v1/shop/codes, as the owner's phone asks it: a code for a phone to be called name, replacing any earlier one. */
  newCode(name: string): string {
    const named = this.phoneName(name);
    const code = bytesToHex(sha256(utf8ToBytes(`code:${++this.txID}`))).slice(0, 32);
    this.posCode = { code, name: named, expires: this.now() + 600 };
    return code;
  }

  /**
   * POST /pos/pair, as Karto PoS makes it (store's PairPos): the code used once, the key a PoS phone under the
   * code's name. A removed phone's key is that phone again, added when it first was; an active one's is refused and
   * the code stays open.
   */
  pair(code: string, keyId: string): void {
    const c = this.posCode;
    if (!c || c.code !== code || c.expires < this.now()) throw new Refusal(403, 'bad_code', 'store: this pairing code is unknown, used or run out');
    const name = this.phoneName(c.name, keyId);
    const had = this.pos.get(keyId);
    if (had && !had.removed) throw new Refusal(409, 'key_known', 'store: this key is already a device of this server');
    if (had) this.renamePhone(keyId, Object.assign(had, { removed: false }), name);
    else this.pos.set(keyId, { name, created: this.now(), removed: false });
    this.posCode = null;
  }

  /** A phone's new name, on its sales too: a sale carries no name of its own. */
  private renamePhone(keyId: string, p: { name: string }, name: string) {
    p.name = name;
    for (const s of this.sold) if (s.device.keyId === keyId) s.device.name = name;
  }

  /** A sale by a PoS phone, made and paid now: Shop is credited what reached the balance (the price, unless some went toward more room). */
  sell(keyId: string, priceMsat: number, method: 'card' | 'qr', receivedMsat = priceMsat, price?: Price, returnLink?: string): string {
    const name = this.pos.get(keyId)!.name;
    const id = `00000000-0000-4000-8000-${String(this.sales.size + 1).padStart(12, '0')}`;
    const at = this.now();
    this.sales.set(id, {
      id, amountMsat: priceMsat, state: 'open', method: '', device: { keyId, name }, created: at, expires: at + 600,
      ...(method === 'card' ? { cardAt: at } : {}), ...(price ? { price } : {}), ...(returnLink ? { returnLink } : {}),
    });
    this.paySale(id, receivedMsat);
    return id;
  }

  /** A money request once per id, as server/internal/api's once does. */
  private once(body: string, fn: (b: Record<string, string>) => unknown): unknown {
    const b = JSON.parse(body) as Record<string, string>;
    if (!b.id) throw new Refusal(400, 'malformed', 'api: bad request: a request id is required');
    if (this.busy.has(b.id)) throw new Refusal(409, 'request_in_progress', 'store: a request with this id is still being handled');
    const prev = this.answered.get(b.id);
    if (prev && prev.body !== body) throw new Refusal(409, 'request_mismatch', 'store: this request id was used with a different body');
    if (prev) return prev.status === 200 ? prev.answer : json(prev.status, prev.answer);
    try {
      const answer = fn(b);
      this.answered.set(b.id, { body, status: 200, answer });
      return answer;
    } catch (e) {
      if (e instanceof Refusal && e.status !== 400) this.answered.set(b.id, { body, status: e.status, answer: { error: e.code, message: e.message } });
      throw e;
    }
  }

  /** GET /api/v1/hosting's answer, as server/internal/renew's Status. */
  private hostingStatus(): HostingStatus {
    const p = { problem: this.hostingProblem.text, problemAt: this.hostingProblem.at };
    const h = this.hostingSync;
    if (!h) return { synced: false, expires: 0, syncedAt: 0, daysLeft: 0, msatPerDay: 0, fundingDays: 0, vatOk: false, willRenew: false, ...p };
    const available = (this.balances.get('hosting') ?? 0) - (this.held.get('hosting') ?? 0);
    const affordable = Math.floor((available - 5_000) / 1005) >= 100;
    // Too little to renew is over once hosting can pay (renew.go's Status).
    const q = affordable && p.problem.includes('not enough for a renewal') ? { problem: '', problemAt: 0 } : p;
    return {
      synced: true, expires: h.expires, syncedAt: h.syncedAt, daysLeft: (h.expires - this.nowMs() / 1000) / 86400, msatPerDay: h.msatPerDay,
      fundingDays: available / h.msatPerDay, vatOk: h.vatOk, willRenew: h.vatOk && !this.paused() && !q.problem && affordable, ...q,
    };
  }

  /**
   * The pending send ends, as ledger's Resolve ends a hold later: settled at feeMsat (pool pays the amount and the
   * fee, "paid <hash>" in its history), or, with null, released (nothing left pool, no history line).
   */
  endPendingSend(feeMsat: number | null) {
    const p = this.pendingSend;
    if (!p) throw new Error('no send is pending');
    this.held.set('pool', (this.held.get('pool') ?? 0) - p.amountMsat - feeBudgetMsat(p.amountMsat));
    if (feeMsat !== null) this.add('pool', -(p.amountMsat + feeMsat), 'send', `paid ${p.paymentHash}`, feeMsat);
    this.sends.set(p.id, feeMsat !== null ? { status: 'sent', paymentHash: p.paymentHash, amountMsat: p.amountMsat, feeMsat } : { status: 'failed', paymentHash: p.paymentHash, amountMsat: p.amountMsat });
    this.pendingSend = null;
  }

  /** Why spending is paused: pausedReason, or a restore waiting for its books, as ledger's Reconcile pauses. */
  private paused(): string {
    if (this.restore?.state === 'pending') return 'waiting for the channel to come back after a restore';
    if (this.restore?.state === 'no_channel') return "no channel came back after the restore: the books wait to be set to phoenixd's balance";
    return this.pausedReason;
  }

  /** A new snapshot, as cardd's hourly job makes one (created now unless given). */
  addSnapshot(file: Uint8Array, created = this.now()): number {
    const version = (this.backupLatest?.version ?? 0) + 1;
    this.snapshots.set(version, file);
    this.backupLatest = { version, created, size: file.length, sha256: bytesToHex(sha256(file)) };
    return version;
  }

  /**
   * A till's payment from a card, settled, as cardd records one (store's spend): the card's leg is the amount and
   * the fee together, the fee also said on its own.
   */
  spend(id: string, amountMsat: number, feeMsat = 0): void {
    this.add(id, -(amountMsat + feeMsat), 'spend', 'paid 00ff', feeMsat);
  }

  /** A top-up of an account, credited: as cardd records one (store's Credit), with a payer's note if given. */
  topUp(account: string, amountMsat: number, more: Pick<Tx, 'comment' | 'payerNote'> = {}): void {
    this.add(account, amountMsat, 'topup', `received ${amountMsat / 1000} sat`, 0, more);
  }

  /** One leg of a transaction on an account, and its history line. */
  private add(account: string, amountMsat: number, kind: string, note: string, feeMsat = 0, more: Pick<Tx, 'other' | 'sale' | 'comment' | 'payerNote'> = {}) {
    this.balances.set(account, (this.balances.get(account) ?? 0) + amountMsat);
    const tx: Tx = { id: ++this.txID, kind, note, amountMsat, feeMsat, created: this.now(), ...more };
    this.history.set(account, [tx, ...(this.history.get(account) ?? [])]);
    this.changed();
    return tx;
  }

  /** GET /api/v1/wallet's and GET /api/v1/pos/fiat's fiat (api fiatJSON): price and time only with a code and a rate. */
  fiat(): Fiat {
    const c = this.currency;
    const r = c !== null && c !== 'none' ? this.rate(c) : null;
    return r ? { currency: c, price: r.price, time: r.time } : { currency: c };
  }

  /** The last rate for a currency, as cardd's rates.Price gives it; null with none. */
  rate(currency: CurrencyCode): Rated | null {
    const price = this.prices?.per[currency];
    return this.prices && price ? { currency, price, time: this.prices.time } : null;
  }

  /**
   * A card's limits as its JSON says them: in sat; or kept in a currency, with perTapSat and dailySat its
   * conversion at the last rate, half up to the whole sat and held to 2,000,000 sat (0 and 0 while there is no rate).
   */
  private cardLimits(id: string): { perTapSat: number; dailySat: number; limits?: CardLimits } {
    const l = this.limits.get(id) ?? { perTapSat: 20_000, dailySat: 50_000 };
    if (!l.currency) return { perTapSat: l.perTapSat, dailySat: l.dailySat };
    const kept: CardLimits = { currency: l.currency, perTapMinor: l.perTapMinor!, dailyMinor: l.dailyMinor! };
    const r = this.rate(l.currency);
    // No rate: cardd says 0 and 0, what a tap would take (it refuses every tap until the first fetch).
    if (!r) return { perTapSat: 0, dailySat: 0, limits: kept };
    const sat = (minor: number) => Math.min(2_000_000, limitToMsat(minor, r) / 1000);
    return { perTapSat: sat(kept.perTapMinor), dailySat: sat(kept.dailyMinor), limits: kept };
  }

  /** The books' count of changes, as the wallet's answer says it (server/internal/api Bell.Rev). */
  rev(): string {
    return `fa4eca4d-${this.changes}`;
  }

  /** The books changed: the count rises and the held reads of the wallet are answered. A test calls it for a change it made by hand. */
  changed(): void {
    this.changes++;
    this.waitOver();
  }

  /** This server's own ntfy (GET /api/v1/push's ntfy; "" for none) and its VAPID public key. */
  pushNtfy = 'https://vm-1.lnvps.cloud:8443';
  pushVapid = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
  /** Each owner phone's endpoint, by its key id. */
  readonly pushEndpoints = new Map<string, { endpoint: string; p256dh: string; auth: string; transport: string; createdAt: number; failure: string; failures: number; deliveredAt: number | null; failedAt: number | null }>();
  /** What the endpoint says to the next test alert: "" takes it. */
  pushTestFailure = '';

  /** The push API (server/internal/api's push.go), with alerts.CheckEndpoint's ntfy.sh rule. */
  private pushRoutesOn(route: (method: string, re: RegExp, fn: (req: { url: URL; body: string }) => unknown) => void) {
    const state = () => {
      const e = this.pushEndpoints.get(this.caller);
      return {
        vapidPublicKey: this.pushVapid, ntfy: this.pushNtfy,
        // As push.go gives it: scheme and host as the endpoint has them, a default port kept.
        endpoint: e ? { transport: e.transport, origin: /^[^:]+:\/\/[^/?#]*/.exec(e.endpoint)![0], createdAt: e.createdAt, deliveredAt: e.deliveredAt, failedAt: e.failedAt, failure: e.failure, failures: e.failures } : null,
      };
    };
    route('GET', /^https:\/\/[^/]+\/api\/v1\/push$/, state);
    route('PUT', /^https:\/\/[^/]+\/api\/v1\/push$/, ({ body }) => {
      const b = JSON.parse(body) as { endpoint: string; p256dh: string; auth: string; transport: string };
      if (b.transport !== 'unifiedpush' && b.transport !== 'fcm') throw new Refusal(400, 'bad_transport', 'transport must be unifiedpush or fcm');
      if (!/^https:\/\/[^/]/.test(b.endpoint)) throw new Refusal(400, 'bad_endpoint', 'alerts: bad endpoint: not an https URL');
      if (this.pushNtfy && new URL(b.endpoint).hostname === 'ntfy.sh') throw new Refusal(400, 'ntfy_sh', 'alerts: an ntfy.sh endpoint, where this server has its own ntfy');
      if (!b.p256dh || !b.auth) throw new Refusal(400, 'bad_keys', 'p256dh must be a 65-byte P-256 point and auth 16 bytes, base64url');
      this.pushEndpoints.set(this.caller, { ...b, createdAt: this.now(), failure: '', failures: 0, deliveredAt: null, failedAt: null });
      return state();
    });
    route('DELETE', /^https:\/\/[^/]+\/api\/v1\/push$/, () => {
      this.pushEndpoints.delete(this.caller);
      return new Response(null, { status: 204 });
    });
    route('POST', /^https:\/\/[^/]+\/api\/v1\/push\/test$/, () => {
      const e = this.pushEndpoints.get(this.caller);
      if (!e) throw new Refusal(404, 'not_found', 'store: not found');
      if (this.pushTestFailure) {
        Object.assign(e, { failedAt: this.now(), failure: this.pushTestFailure, failures: e.failures + 1 });
        return json(502, { error: 'push_failed', detail: this.pushTestFailure });
      }
      Object.assign(e, { deliveredAt: this.now(), failure: '', failures: 0 });
      return { delivered: true };
    });
  }

  /** The held reads' wait runs out: each is answered as the wallet then reads. */
  waitOver(): void {
    for (const go of this.heldReads.splice(0)) go();
  }

  private now(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  private get(id: string): CardInfo {
    const c = this.cards.get(id);
    if (!c) throw new Refusal(404, 'not_found', 'store: not found');
    return c;
  }

  private reserve(id: string, name: string) {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Refusal(400, 'malformed', 'cards: id must be 32 lower-case hex characters');
    name = name.trim();
    const c = this.cards.get(id);
    const host = this.host;
    if (!c) this.cards.set(id, { id, version: 0, state: 'programming', counter: -1, name, host, created: this.now(), updated: this.now() });
    else if (c.state === 'programming') Object.assign(c, { host }, name ? { name, updated: this.now() } : {});
    else if (c.state === 'reset') {
      Object.assign(c, { version: c.version + 1, state: 'programming', counter: -1, name: name || c.name, host, updated: this.now() });
      delete c.needsCheck; // new keys: the taps recorded before are another version's
    } else throw new Refusal(409, 'conflict', 'store: conflicting state');
    return { ...this.cards.get(id)!, lnurlw: `lnurlw://${this.host}/ln` };
  }

  /** As cards.Service.Adopt: the tap checked at the version given, then the card added as active at its counter, with no host until a re-point sets it. */
  private adopt(b: { version: unknown; name: unknown } & Sun) {
    if (typeof b.version !== 'number' || typeof b.name !== 'string') throw new Refusal(400, 'malformed', 'api: bad request: version and name are needed');
    const name = b.name.trim();
    if ([...name].length > 40 || /[\r\n]/.test(name)) throw new Refusal(400, 'bad_name', 'cards: a name is one line of at most 40 characters');
    const parsed = parseSun(b.p ?? '', b.c ?? '');
    if (!parsed) throw new Refusal(400, 'malformed', 'sun: malformed p or c');
    const picc = decryptPicc(k1For(this.issuer), parsed.p);
    if (!picc) throw new Refusal(422, 'not_ours', 'sun: not one of our cards');
    if (!verifySun(deriveCardKeys(this.issuer, picc.uid, b.version).k2, picc, parsed.c)) throw new Refusal(422, 'bad_mac', 'sun: bad MAC');
    const id = bytesToHex(cardId(this.issuer, picc.uid));
    if (this.cards.has(id)) throw new Refusal(409, 'conflict', 'store: conflicting state: the card is already known');
    const card: CardInfo = { id, version: b.version, state: 'active', counter: picc.counter, name, host: '', created: this.now(), updated: this.now() };
    this.cards.set(id, card);
    return { ...card };
  }

  private setHost(id: string, host: string) {
    if (typeof host !== 'string' || host.length > 253 || !HOST.test(host)) {
      throw new Refusal(400, 'bad_host', 'cards: a host is a bare lower-case hostname such as vm-1.lnvps.cloud');
    }
    const c = this.get(id);
    if (c.state === 'reset') throw new Refusal(409, 'conflict', 'store: conflicting state: card is reset');
    Object.assign(c, { host, updated: this.now() });
    return { ...c };
  }

  private rename(id: string, name: string) {
    name = name.trim();
    if (!name || name.length > 40 || /[\r\n]/.test(name)) throw new Refusal(400, 'bad_name', 'cards: a name is one line of at most 40 characters');
    const c = this.get(id);
    if (c.state === 'reset') throw new Refusal(409, 'conflict', 'store: conflicting state: card is reset');
    Object.assign(c, { name, updated: this.now() });
    return { ...c };
  }

  private move(id: string, to: CardInfo['state'], from: CardInfo['state'][]) {
    const c = this.get(id);
    if (!from.includes(c.state)) throw new Refusal(409, 'conflict', `store: conflicting state: card is ${c.state}`);
    Object.assign(c, { state: to, updated: this.now() });
    return { ...c };
  }

  /** As store.StartWipe: refused while a payment holds some of the card's balance; the balance moves to pool. */
  private startCardWipe(id: string) {
    const c = this.get(id);
    if (!['active', 'frozen', 'programming', 'wiping'].includes(c.state)) throw new Refusal(409, 'conflict', `store: conflicting state: card is ${c.state}`);
    if ((this.held.get(id) ?? 0) > 0) throw new Refusal(409, 'conflict', 'store: conflicting state: a payment is in progress on this card');
    const balance = this.balances.get(id) ?? 0;
    if (balance !== 0) {
      this.add(id, -balance, 'wipe', 'card wiped: its balance moved to pool', 0, { other: 'pool' });
      this.add('pool', balance, 'wipe', 'card wiped: its balance moved to pool', 0, { other: id });
    }
    Object.assign(c, { state: 'wiping', updated: this.now() });
    return { ...c };
  }

  /** Decrypts p, finds the card and checks c, as server/internal/cards verify does. */
  private verify(sun: Sun): { card: CardInfo; counter: number } {
    const parsed = parseSun(sun.p ?? '', sun.c ?? '');
    if (!parsed) throw new Refusal(400, 'malformed', 'sun: malformed p or c');
    const picc = decryptPicc(k1For(this.issuer), parsed.p);
    if (!picc) throw new Refusal(422, 'not_ours', 'sun: not one of our cards');
    const card = this.cards.get(bytesToHex(cardId(this.issuer, picc.uid)));
    if (!card) throw new Refusal(404, 'unknown_card', 'cards: card not registered');
    if (!verifySun(deriveCardKeys(this.issuer, picc.uid, card.version).k2, picc, parsed.c)) throw new Refusal(422, 'bad_mac', 'sun: bad MAC');
    return { card, counter: picc.counter };
  }

  private confirm(id: string, sun: Sun) {
    const { card, counter } = this.verify(sun);
    if (card.id !== id) throw new Refusal(422, 'id_mismatch', 'cards: tap is from a different card');
    if (card.state !== 'programming') throw new Refusal(409, 'conflict', `store: conflicting state: card is ${card.state}`);
    if (counter <= card.counter) throw new Refusal(409, 'replayed', 'store: counter not above last seen');
    Object.assign(card, { state: 'active', counter, updated: this.now() });
    return { ...card };
  }

  /** As cards.Service.Check: a card that needs the check after a restore takes only a proved one. */
  private check(b: Sun & { proved?: boolean }) {
    const { card, counter } = this.verify(b);
    if (card.state === 'reset') throw new Refusal(422, 'card_reset', 'cards: card has been wiped');
    if (card.state !== 'active' && card.state !== 'frozen') throw new Refusal(409, 'not_active', 'cards: card setup has not finished or it is being wiped');
    if (card.needsCheck && !b.proved) throw new Refusal(409, 'needs_check', "cards: card needs its owner's check after a restore");
    if (counter <= card.counter) throw new Refusal(409, 'replayed', 'store: counter not above last seen');
    Object.assign(card, { counter, updated: this.now() });
    if (b.proved) delete card.needsCheck; // the owner's check, after a restore
    return { ...card };
  }
}

/** A DeviceKey holding testvectors' deviceAuth key, signing with noble instead of the Keystore. */
export const vectorDeviceKey = () =>
  deviceKey({
    deviceKeyCreate: async () => vectors.deviceAuth.publicKey,
    devicePublicKey: async () => vectors.deviceAuth.publicKey,
    deviceSign: async (m) => bytesToHex(p256.sign(utf8ToBytes(m), hexToBytes(vectors.deviceAuth.privateKey), { format: 'der' })),
  });
