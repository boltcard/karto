// One owner of NFC taps at a time: the card screen in front claims the slot,
// the last claim gets the taps, and reader mode is on while anyone holds one.
// So the app's own handler and the hold-the-card screen never both act on one
// tap. Under the screens' claims sits the base claim, the app's for its life
//: it gets a tap no screen claims, so reader
// mode is on whenever the app is in front and no tap reaches Android's own
// handling (Phoenix, the browser). A claim says whether it reads its taps: while the one in front drops them,
// Android's tag sound is off, so a card the app closes unread doesn't beep as though it had been taken.
import type { Nfc, Tag } from '../native/nfc';

type Claim = { onTag: (tag: Tag) => void; reads: boolean };

export class NfcSlot {
  private owners: Claim[] = [];
  private base?: Claim;
  private sub?: { remove(): void };
  private suspended = 0;
  /** What the reader was last told: true while its tag sound is off. */
  private quietNow?: boolean;

  constructor(private readonly nfc: Nfc) {}

  /** A screen's claim: it gets the taps while it is the last one held. reads: false when it closes them unread. */
  claim(onTag: (tag: Tag) => void, reads = true): () => void {
    const c = { onTag, reads };
    this.owners.push(c);
    this.sound();
    this.listen();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.owners.splice(this.owners.lastIndexOf(c), 1);
      this.sound();
      this.quiet();
    };
  }

  /** The base claim: it gets the taps while no screen holds a claim, whichever was made first. */
  claimBase(onTag: (tag: Tag) => void, reads = true): () => void {
    const c = { onTag, reads };
    this.base = c;
    this.sound();
    this.listen();
    return () => {
      if (this.base !== c) return;
      this.base = undefined;
      this.quiet();
    };
  }

  /** Whether a screen's claim is over the base: a tap the base was reading is then dropped. */
  screenClaimed(): boolean {
    return this.owners.length > 0;
  }

  /**
   * Turns reader mode off whatever claims are held, and answers once it is off with the call that turns it on
   * again for the claims held then: a phone answers a reader as
   * a card only while it is not reading cards itself. It stays off until every suspend has resumed.
   */
  async suspend(): Promise<() => void> {
    this.suspended++;
    if (this.sub) {
      this.sub.remove();
      this.sub = undefined;
      await this.nfc.stop().catch(() => {});
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.suspended--;
      if (this.owners.length > 0 || this.base) this.listen();
    };
  }

  private listen() {
    if (this.sub || this.suspended > 0) return;
    this.sub = this.nfc.onTag((t) => this.route(t));
    this.nfc.start().catch(() => {});
  }

  /** Android's tag sound off while the claim in front drops its taps, on while it reads them. */
  private sound() {
    const front = this.owners.at(-1) ?? this.base;
    if (!front || this.quietNow === !front.reads) return;
    this.quietNow = !front.reads;
    this.nfc.quiet?.(this.quietNow);
  }

  private quiet() {
    if (this.owners.length > 0 || this.base || !this.sub) return;
    this.sub.remove();
    this.sub = undefined;
    this.nfc.stop().catch(() => {});
  }

  private route(tag: Tag) {
    const owner = this.owners.at(-1) ?? this.base;
    if (owner) owner.onTag(tag);
    else void tag.close();
  }
}

/**
 * A screen's claim that closes every tap unread, until the function it returns is called: while the card camera
 * is open (a card that close to the phone is read, and its account page or the tap sheet would open over the
 * camera and lose the shot), and on Add card's name screen and photo step (the card being
 * added is in the person's hand, and read early or again it would open its sheet or its page over the step). As the
 * rebuild and restore screens do. The release lets the app's own handling have the taps again.
 */
export const holdTaps = (slot: Pick<NfcSlot, 'claim'>): (() => void) => slot.claim((t) => void t.close(), false);
