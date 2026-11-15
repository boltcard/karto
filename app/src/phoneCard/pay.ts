// Paying with the phone as a card: the pay screen's moments and
// what moves between them, with no React in it. The screen (/pay) makes one of these when it opens, calls open,
// then tick each second, and stop when it is left; it draws `view`.
//
// The phone is a card from the arming until a payment shows, 60 seconds pass, or the screen is left. The taps are
// made here, at the arming, and handed to the card service in memory: no key and no unspent link is written.
import type { CardState, CarddClient } from '../cardd/client';
import type { NfcSlot } from '../cards/nfcSlot';
import { PhoneCardRefused, type PhoneCard, type PhoneCardReadEvent } from '../native/phoneCard';
import { lnurlwFor } from '../ntag424/ndef';
import { CounterSpent, checkCounters, phoneCardId } from './id';
import type { PhoneCardRecordStore } from './record';
import { BATCH, tapFiles, type TapCard } from './taps';

/** How long the phone is a card for. */
export const CARD_SECONDS = 60;
/** How long after the last read the screen goes on asking the server for the payment, past the card's time. */
const ASK_SECONDS = 30;
/**
 * How long the server is asked to hold its answer about the card's history, until there is something newer than
 * was remembered: the screen says Paid as the payment settles, not at the next second. A server that doesn't hold
 * answers at once, and is asked once a second. Under the 5 seconds the screen's client gives a call (the one a
 * held card's calls use, cards/deps.ts HELD_CALL_MS), with a second to spare: a longer wait is cut off by the
 * phone each time.
 */
export const ASK_WAIT_S = 4;
/** More taps are made when this many or fewer are left. */
const LOW = 8;
/** Android refused the arming: it is tried once more after this long (the activity may not be in front again yet after the lock). */
export const ARM_AGAIN_MS = 400;

/**
 * What the screen shows.
 * - opening: the lock is being asked.
 * - back: the lock was not confirmed (text: the lock's own words); the screen goes back.
 * - cant: the phone is not made a card. frozen: the card is frozen. gone: the server no longer lists it as one to
 *   pay with. no-record: this phone has no card, or it is being removed. counter: its counter is used up.
 *   refused: Android would not give this app the reader, twice.
 * - ready: a card, not yet read; left: seconds of the 60. server: the server answered before the arming, so a
 *   payment can be told from what came before; without that the screen never says Paid or that nothing was taken.
 * - read: a till read it. left is null once the phone has stopped being a card and the screen is only asking.
 * - paid: a payment from the card newer than the one remembered. leftMsat: null when the server won't say.
 * - over: it ended with no payment seen.
 */
export type PayView =
  | { at: 'opening' }
  | { at: 'back'; text: string }
  | { at: 'cant'; why: 'frozen' | 'gone' | 'no-record' | 'counter' | 'refused' }
  | { at: 'ready'; left: number; server: boolean }
  | { at: 'read'; left: number | null; server: boolean }
  | { at: 'paid'; amountMsat: number; feeMsat: number; leftMsat: number | null }
  | { at: 'over'; read: boolean; server: boolean };

export type PayDeps = {
  issuer: Uint8Array;
  /** The server the wallet is paired with. */
  host: string;
  cardd: Pick<CarddClient, 'cards' | 'history' | 'wallet'>;
  record: Pick<PhoneCardRecordStore, 'read' | 'update'>;
  card: PhoneCard;
  slot: Pick<NfcSlot, 'suspend'>;
  /** The screen lock: null once confirmed, else what to tell the person (ui/lock.ts). */
  lock(): Promise<string | null>;
  /** The phone's clock, in ms. */
  now(): number;
  /** A pause, before the arming is tried a second time. */
  wait(ms: number): Promise<void>;
  /** Told when the phone becomes a card and when it stops: the keeping-in-step job does not run meanwhile. */
  onArmed?(armed: boolean): void;
  /** The buzz a payment gives. */
  buzz?(): void;
  random?: (n: number) => Uint8Array;
};

/** What the server said of the card before the arming: its state, its counter, and the newest id in its history (0: none). */
type Server = { state: CardState | 'unlisted'; counter: number; newest: number };

export class Pay {
  view: PayView = { at: 'opening' };
  private card?: TapCard & { id: string };
  /** The first counter of this arming, and how many taps were made from it. */
  private first = 0;
  private made = 0;
  /** How many taps a reader was handed: never lowered, whoever reports it. */
  private given = 0;
  /** The card service has the taps, or is being given them. */
  private armed = false;
  /** When the arming went through; 0 until then. */
  private armedAt = 0;
  private lastRead: number | null = null;
  /** The newest id in the card's history before the arming; null when the server had not answered by then. */
  private baseline: number | null = null;
  /** The newest id an ask has brought: the next asks past it, so the server holds that one too. */
  private seen = 0;
  /** The screen was left, or it has said how it ended. */
  private done = false;
  private adding = false;
  private ticking = false;
  /** An ask of the server is under way: one at a time. */
  private watching = false;
  private resume?: () => void;
  private subs: { remove(): void }[] = [];
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly d: PayDeps, private readonly onView: (v: PayView) => void) {}

  /**
   * state: the card's, as the Wallet page knows it. A stop that comes while this waits (on the lock, on Android)
   * ends it there: the phone is not made a card behind a screen that has gone.
   */
  async open(known: { state: CardState }): Promise<void> {
    const d = this.d;
    if (this.done) return;
    if (known.state === 'frozen') return this.show({ at: 'cant', why: 'frozen' });
    const read = await d.record.read();
    if (!read.ok || !read.record || read.record.removing) return this.show({ at: 'cant', why: 'no-record' });
    const rec = read.record;
    const id = phoneCardId(d.issuer, rec.n);
    // The server and the lock, together. What the server has answered by the time the lock is confirmed is used;
    // what arrives later is dropped, since it might already hold this payment.
    let server: Server | null = null;
    void this.askServer(id).then((s) => void (server = s), () => {});
    const refused = await d.lock();
    if (this.done) return;
    if (refused !== null) return this.show({ at: 'back', text: refused });
    const s = server as Server | null;
    if (s?.state === 'frozen') return this.show({ at: 'cant', why: 'frozen' });
    if (s && s.state !== 'active') return this.show({ at: 'cant', why: 'gone' });

    // The record first: a counter is never handed out that the record does not already count as used. Its next is
    // taken as it stands now, not as it was read before the lock: the keeping-in-step job may have raised it since.
    let first = 0;
    try {
      const reserved = await d.record.update((r) => {
        if (!r) return r;
        first = Math.max(r.next, s ? s.counter + 1 : 0);
        checkCounters(first, BATCH);
        return { ...r, next: first + BATCH };
      });
      if (!reserved) return this.show({ at: 'cant', why: 'no-record' });
    } catch (e) {
      if (e instanceof CounterSpent) return this.show({ at: 'cant', why: 'counter' });
      throw e;
    }
    const card = { issuer: d.issuer, n: rec.n, version: rec.version, lnurlw: lnurlwFor(d.host), id };
    const files = tapFiles(card, first, BATCH, d.random);
    this.card = card;
    this.first = first;
    this.made = BATCH;
    this.resume = await d.slot.suspend();
    // Listening before the service has the taps: a read, or the app leaving the front, in the moment after the
    // arming is heard too.
    this.subs = [d.card.onRead((e) => this.onRead(e)), d.card.onEnded((given) => this.onEnded(given))];
    this.armed = true;
    d.onArmed?.(true);
    const armed = !this.done && (await this.arm(files));
    if (this.done || !armed || !this.armed) {
      // Left meanwhile, refused twice, or the app left the front as it was armed: the service is emptied, the
      // reader on again, the record as it was but for what a reader was handed in between.
      if (this.armed) await this.queue(() => this.disarm());
      this.unsubscribe();
      if (!this.done) this.show({ at: 'cant', why: 'refused' });
      return;
    }
    this.armedAt = d.now();
    this.baseline = s ? s.newest : null;
    this.showLive(CARD_SECONDS);
  }

  /** Arms the service: true once armed, false when Android refused twice or the screen was left between the two tries. */
  private async arm(files: string[]): Promise<boolean> {
    for (const again of [true, false]) {
      try {
        await this.d.card.arm(files);
        return true;
      } catch (e) {
        if (!(e instanceof PhoneCardRefused)) {
          if (this.armed) await this.queue(() => this.disarm());
          this.unsubscribe();
          throw e;
        }
        if (!again || this.done) return false;
        await this.d.wait(ARM_AGAIN_MS);
        if (this.done) return false;
      }
    }
    return false;
  }

  /**
   * Each second while the screen shows: the card's time, what the screen says, and an ask of the server when none
   * is under way. The seconds never wait for the server's answer, which it may hold.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.work;
      if (this.done || this.armedAt === 0) return;
      const now = this.d.now();
      const cardEnds = this.armedAt + CARD_SECONDS * 1000;
      if (this.armed && now >= cardEnds) await this.queue(() => this.disarm());
      if (this.done) return;
      // Past the card's time the screen only asks: until 30 seconds after the last read, when it can tell at all.
      if (!this.armed && !this.asks(now)) return this.over();
      this.showLive(this.armed ? Math.ceil((cardEnds - now) / 1000) : null);
    } finally {
      this.ticking = false;
    }
    await this.watch();
  }

  /** Whether the server is still asked what was paid: once a till has read the phone, while it is a card and until 30 seconds after the last read. */
  private asks(now: number): boolean {
    if (this.lastRead === null || this.baseline === null) return false;
    return this.armed || now < Math.max(this.armedAt + CARD_SECONDS * 1000, this.lastRead + ASK_SECONDS * 1000);
  }

  /**
   * Asks the server for the payment, one ask at a time, from a read on. An answer the server held (a second or more)
   * is followed by the next ask at once, so no payment settles between two; after one that came at once the next
   * second's tick asks again.
   */
  private async watch(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      while (!this.done && this.asks(this.d.now())) {
        const started = this.d.now();
        if (await this.paid()) return;
        if (this.d.now() - started < 1000) return;
      }
    } finally {
      this.watching = false;
    }
  }

  /**
   * Stop, Back, or the screen being left: the phone stops being a card and the screen says how it stands, at once.
   * Before the arming it ends the opening: the phone does not become a card.
   */
  stop(): Promise<void> {
    const opening = !this.done && this.armedAt === 0;
    if (opening) this.done = true;
    return this.queue(async () => {
      if (this.armed) await this.disarm();
      if (opening || this.done) return;
      this.over();
    });
  }

  /** Resolves once what a read, a stop or the module's own ending set going has finished. */
  settled(): Promise<void> {
    return this.work;
  }

  private queue(job: () => Promise<void>): Promise<void> {
    this.work = this.work.then(job, job);
    return this.work;
  }

  private show(view: PayView): void {
    this.view = view;
    this.onView(view);
  }

  private showLive(left: number | null): void {
    const server = this.baseline !== null;
    const view: PayView = this.lastRead === null ? { at: 'ready', left: left ?? 0, server } : { at: 'read', left, server };
    if (JSON.stringify(view) !== JSON.stringify(this.view)) this.show(view);
  }

  private over(): void {
    this.finish({ at: 'over', read: this.lastRead !== null, server: this.baseline !== null });
  }

  private finish(view: PayView): void {
    this.done = true;
    this.unsubscribe();
    this.show(view);
  }

  private unsubscribe(): void {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }

  private async askServer(id: string): Promise<Server> {
    const [cards, newest] = await Promise.all([this.d.cardd.cards(), this.d.cardd.history(id, { limit: 1 })]);
    const card = cards.find((c) => c.id === id);
    return { state: card?.state ?? 'unlisted', counter: card?.counter ?? -1, newest: newest[0]?.id ?? 0 };
  }

  private onRead(e: PhoneCardReadEvent): void {
    if (!this.armed) return;
    this.given = Math.max(this.given, e.given);
    this.lastRead = this.d.now();
    // Before the arming has answered, the screen still says it is opening: the read is shown once it is ready.
    if (this.armedAt !== 0) this.showLive(Math.max(0, Math.ceil((this.armedAt + CARD_SECONDS * 1000 - this.lastRead) / 1000)));
    // The till has the link: its payment is a moment away, and the server is asked now, not at the next second.
    if (this.armedAt !== 0) void this.watch().catch(() => undefined);
    if (e.left <= LOW && !this.adding) {
      this.adding = true;
      void this.queue(() => this.addTaps().finally(() => void (this.adding = false)));
    }
  }

  /** Sixteen more, the record first, carrying on from the last made. Past the counter's end the phone gives what it has. */
  private async addTaps(): Promise<void> {
    if (!this.armed || !this.card) return;
    const from = this.first + this.made;
    let files: string[];
    try {
      files = tapFiles(this.card, from, BATCH, this.d.random);
    } catch (e) {
      if (e instanceof CounterSpent) return;
      throw e;
    }
    if (!(await this.d.record.update((r) => r && { ...r, next: Math.max(r.next, from + BATCH) }))) return;
    this.made += BATCH;
    if (this.armed) await this.d.card.add(files);
  }

  /** The module disarmed by itself: the app left the front. */
  private onEnded(given: number): void {
    // Told at once, whatever is queued: a disarm of this screen's own, running beside it, must not count fewer.
    this.given = Math.max(this.given, given);
    void this.queue(async () => {
      if (!this.armed) return;
      await this.afterDisarm();
      if (!this.done && this.armedAt !== 0) this.over();
    });
  }

  private async disarm(): Promise<void> {
    if (!this.armed) return;
    // The module may have emptied itself a moment before (the app left the front) and then answers 0: what the
    // reads and its own ending reported stands.
    this.given = Math.max(this.given, await this.d.card.disarm());
    await this.afterDisarm();
  }

  /** The reader on again, and the record's next as the first counter plus the taps handed out: one that never left the phone is used again. */
  private async afterDisarm(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.resume?.();
    const used = this.first + this.given;
    const reserved = this.first + this.made;
    await this.d.record.update((r) => (r && r.next === reserved ? { ...r, next: used } : r));
    this.d.onArmed?.(false);
  }

  /**
   * Whether a payment from the card newer than the one remembered has shown; if so the phone stops being a card
   * and the screen says Paid at once, and what is left when the server has said (the wallet asks phoenixd: Paid
   * doesn't wait for it).
   */
  private async paid(): Promise<boolean> {
    // Asked past the newest seen, not past the baseline: with money come in since (a top-up, a move onto the card)
    // the server would answer every ask at once, and the payment would wait for the next second's.
    const after = Math.max(this.baseline!, this.seen);
    const txs = await this.d.cardd.history(this.card!.id, { limit: 5, after, wait: ASK_WAIT_S }).catch(() => null);
    this.seen = Math.max(after, ...(txs ?? []).map((t) => t.id));
    const spend = txs?.find((t) => t.id > this.baseline! && t.kind === 'spend');
    if (!spend || this.done) return false;
    if (this.armed) await this.queue(() => this.disarm());
    this.d.buzz?.();
    if (this.done) return true;
    // The card's leg is the amount and the fee together; the fee is said on its own too.
    const paid: PayView = { at: 'paid', amountMsat: -spend.amountMsat - spend.feeMsat, feeMsat: spend.feeMsat, leftMsat: null };
    this.finish(paid);
    const mine = await this.d.cardd.wallet().then((w) => w.cards.find((c) => c.id === this.card!.id), () => undefined);
    if (mine && this.view === paid) this.show({ ...paid, leftMsat: mine.balanceMsat - mine.heldMsat });
    return true;
  }
}
