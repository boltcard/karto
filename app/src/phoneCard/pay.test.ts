import { describe, expect, it } from 'vitest';
import { k1For } from '../boltcard/cardkeys';
import { decryptPicc, parseSun } from '../boltcard/sun';
import type { CardState } from '../cardd/client';
import { HELD_CALL_MS } from '../cards/deps';
import { sunOfUrl } from '../ntag424/ndef';
import { fakePhoneCard } from '../testing/fakePhoneCard';
import { phoneCardWorld } from '../testing/phoneCardWorld';
import { COUNTER_MAX } from './id';
import { ARM_AGAIN_MS, ASK_WAIT_S, CARD_SECONDS, Pay, type PayDeps, type PayView } from './pay';
import type { PhoneCardRecord } from './record';
import { BATCH } from './taps';

const FIRST = 500_000;

/** A phone set up as card 0, active on the server with 6,000 sat, its record's next at FIRST; a pay screen not yet opened. */
async function world(o: { record?: PhoneCardRecord | null; state?: CardState; counter?: number } = {}) {
  const t = await phoneCardWorld(o.record === null ? {} : { record: o.record ?? { n: 0, version: 0, next: FIRST } });
  t.put(0, o.state ?? 'active', { counter: o.counter ?? FIRST - 1, name: 'Pixel 8 Pro' });
  t.cardd.balances.set(t.id(0), 6_000_000);
  const phone = fakePhoneCard();
  const clock = { ms: t.nowMs };
  /** What happened, in order: the lock, the record's writes (with its next), the reader, the arming. */
  const log: string[] = [];
  const lock = { answer: null as string | null, callsBefore: [] as string[] };
  /** Each holds something back until let go: the server's answer about the card, the lock's, the arming's, the history's. */
  const gate = {
    wait: null as Promise<void> | null, lock: null as Promise<void> | null, armed: null as Promise<void> | null, history: null as Promise<void> | null,
    /** A server that holds a read asked with a wait, and the wallet's answer. */
    held: null as Promise<void> | null, wallet: null as Promise<void> | null,
  };
  /** The reads asked with a wait: what each asked for. */
  const asks: unknown[] = [];
  /** The pauses before a second try at arming. */
  const waits: number[] = [];
  /** The server calls in flight. */
  const inflight: Promise<unknown>[] = [];
  const asked = <T>(call: Promise<T>): Promise<T> => (inflight.push(call.catch(() => undefined)), call);
  const views: PayView[] = [];
  const armed: boolean[] = [];
  const buzz = { n: 0 };
  const d: PayDeps = {
    issuer: t.deps.issuer,
    host: t.deps.host,
    cardd: {
      cards: async () => {
        const cards = asked(t.d.cardd.cards());
        if (gate.wait) await gate.wait;
        return cards;
      },
      history: async (account, page) => {
        // A read with a wait is one the server may hold: held here until let go, and only then answered.
        if (page?.wait) {
          asks.push(page);
          if (gate.held) await gate.held;
        }
        const txs = asked(t.d.cardd.history(account, page));
        if (gate.history) await gate.history;
        return txs;
      },
      wallet: async () => {
        if (gate.wallet) await gate.wallet;
        return t.d.cardd.wallet();
      },
    },
    record: {
      read: t.record.read,
      update: async (fn) => {
        const r = await t.record.update(fn);
        log.push(`record ${r ? r.next : 'none'}`);
        return r;
      },
    },
    card: {
      ...phone.card,
      // Held, the service has the taps and the app has not yet heard so.
      arm: async (files) => {
        log.push('arm');
        await phone.card.arm(files);
        if (gate.armed) await gate.armed;
      },
    },
    slot: { suspend: async () => (log.push('reader off'), () => void log.push('reader on')) },
    // The person takes a moment over the lock: by then the server has answered, unless the test holds it back.
    lock: async () => {
      lock.callsBefore = [...t.s.calls];
      log.push('lock');
      if (!gate.wait) {
        await Promise.allSettled(inflight);
        await new Promise((done) => setTimeout(done, 0));
      }
      if (gate.lock) await gate.lock;
      return lock.answer;
    },
    now: () => clock.ms,
    wait: async (ms) => void waits.push(ms),
    onArmed: (a) => void armed.push(a),
    buzz: () => void buzz.n++,
  };
  const pay = new Pay(d, (v) => views.push(v));
  /**
   * What the server has been asked is answered, as it is within any real second: the screen's asks are not waited
   * for by its ticks. An ask a gate holds back has not reached the server, and is not waited for.
   */
  const quiet = async () => {
    await Promise.allSettled(inflight);
    await new Promise((done) => setTimeout(done, 0));
    await pay.settled();
  };
  /** Seconds pass, the screen ticking each one. */
  const pass = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      clock.ms += 1000;
      await pay.tick();
      await quiet();
    }
  };
  const next = async () => ((await t.stored()) as PhoneCardRecord).next;
  /** The counter of the tap a till got, or null when the phone gave it none. */
  const tap = async () => {
    const sun = sunOfUrl(await phone.tap());
    // The ask the read set going is answered.
    await quiet();
    return sun ? decryptPicc(k1For(t.deps.issuer), parseSun(sun.p, sun.c)!.p)!.counter : null;
  };
  const open = (state: CardState = 'active') => pay.open({ state });
  return { ...t, phone, clock, log, lock, gate, asks, waits, views, armed, buzz, pay, pass, next, tap, open, view: () => views[views.length - 1] };
}
/** A promise and the call that lets it go. */
function held() {
  let go = () => {};
  const wait = new Promise<void>((done) => (go = done));
  return { wait, go };
}
/** Until what was asked for has happened, a turn of the event loop at a time. */
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((done) => setTimeout(done, 0));
  expect(ok()).toBe(true);
}

describe('opening the pay screen', () => {
  it('asks the server and the screen lock together, then writes the record, turns the reader off and arms 16 taps, in that order', async () => {
    const t = await world();
    expect(t.pay.view).toEqual({ at: 'opening' });
    await t.open();
    expect(t.lock.callsBefore).toEqual(expect.arrayContaining(['cards', 'history']));
    expect(t.log).toEqual(['lock', `record ${FIRST + 16}`, 'reader off', 'arm']);
    expect([BATCH, CARD_SECONDS]).toEqual([16, 60]);
    expect(t.phone.tag.left).toBe(16);
    expect(t.view()).toEqual({ at: 'ready', left: 60, server: true });
    expect(t.armed).toEqual([true]);
    // The first tap a till gets is the record's next as it stood.
    expect(await t.tap()).toBe(FIRST);
  });

  it("begins past the server's counter when that is at or past the record's next", async () => {
    const t = await world({ counter: FIRST + 40 });
    await t.open();
    expect(await t.next()).toBe(FIRST + 41 + 16);
    expect(await t.tap()).toBe(FIRST + 41);
  });

  it('makes its taps at the record\'s key version, for the server the wallet is paired with', async () => {
    const t = await world({ record: { n: 0, version: 3, next: FIRST } });
    t.cardd.cards.get(t.id(0))!.version = 3;
    await t.open();
    const url = (await t.phone.tap())!;
    expect(url.startsWith(`lnurlw://${t.cardd.host}/ln?p=`)).toBe(true);
    // The server's own check takes it: the right card, at version 3.
    const sun = sunOfUrl(url)!;
    expect(await t.deps.cardd.checkCard(sun)).toMatchObject({ id: t.id(0), counter: FIRST });
  });

  it('says a frozen card at once, without asking for the lock', async () => {
    const t = await world({ state: 'frozen' });
    await t.open('frozen');
    expect(t.view()).toEqual({ at: 'cant', why: 'frozen' });
    expect(t.log).toEqual([]);
    expect(t.phone.s.calls).toEqual([]);
  });

  it('goes back when the lock is not confirmed, with nothing written and nothing armed', async () => {
    const t = await world();
    t.lock.answer = 'The screen lock was not confirmed.';
    await t.open();
    expect(t.view()).toEqual({ at: 'back', text: 'The screen lock was not confirmed.' });
    expect(t.log).toEqual(['lock']);
    expect(await t.next()).toBe(FIRST);
    expect(t.phone.s.calls).toEqual([]);
  });

  it("stops after the lock when the server says the card is frozen, or is no longer this phone's to pay with", async () => {
    const frozen = await world({ state: 'frozen' });
    await frozen.open('active');
    expect(frozen.view()).toEqual({ at: 'cant', why: 'frozen' });
    for (const state of ['reset', 'wiping', 'programming'] as const) {
      const gone = await world({ state });
      await gone.open();
      expect(gone.view(), state).toEqual({ at: 'cant', why: 'gone' });
      expect(gone.phone.s.calls).toEqual([]);
      expect(await gone.next()).toBe(FIRST);
    }
    const unlisted = await world();
    unlisted.cardd.cards.delete(unlisted.id(0));
    await unlisted.open();
    expect(unlisted.view()).toEqual({ at: 'cant', why: 'gone' });
  });

  it('is not a card on a phone with no record, one being removed, or one that can not be read', async () => {
    const none = await world({ record: null });
    await none.open();
    expect(none.view()).toEqual({ at: 'cant', why: 'no-record' });
    const removing = await world({ record: { n: 0, version: 0, next: FIRST, removing: true } });
    await removing.open();
    expect(removing.view()).toEqual({ at: 'cant', why: 'no-record' });
    const unreadable = await world();
    unreadable.s.unreadable = true;
    await unreadable.open();
    expect(unreadable.view()).toEqual({ at: 'cant', why: 'no-record' });
    for (const t of [none, removing, unreadable]) expect(t.log).toEqual([]);
  });

  // After the lock's own screen the activity may not be in front again yet, and Android then refuses.
  it('when Android refuses, tries once more after a moment; refused again, it turns the reader on, puts the record back, and says so', async () => {
    const t = await world();
    t.phone.s.refuse = true;
    await t.open();
    expect(t.view()).toEqual({ at: 'cant', why: 'refused' });
    expect(t.waits).toEqual([ARM_AGAIN_MS]);
    expect(t.log).toEqual(['lock', `record ${FIRST + 16}`, 'reader off', 'arm', 'arm', 'reader on', `record ${FIRST}`]);
    expect(t.armed).toEqual([true, false]);
    expect(await t.tap()).toBeNull();
    expect(t.phone.listening()).toBe(0);
  });

  it('is a card when Android takes the second try', async () => {
    const t = await world();
    t.phone.s.refuseNext = 1;
    await t.open();
    expect(t.view()).toEqual({ at: 'ready', left: 60, server: true });
    expect(t.phone.s.calls).toEqual(['arm 16', 'arm 16']);
    expect(await t.tap()).toBe(FIRST);
  });

  // The screen can be left while the lock is asked, or in the moment Android is asked: a phone that became a card
  // then would be one behind the Wallet page, with nothing to stop it.
  it('does not become a card when the screen is left while the lock is being asked', async () => {
    const t = await world();
    const lock = held();
    t.gate.lock = lock.wait;
    const opening = t.open();
    await until(() => t.log.includes('lock'));
    await t.pay.stop();
    lock.go();
    await opening;
    expect(t.views).toEqual([]);
    expect(t.log).toEqual(['lock']);
    expect(t.phone.s.calls).toEqual([]);
    expect(await t.next()).toBe(FIRST);
    expect(t.armed).toEqual([]);
  });

  it('stops being a card at once when the screen is left as it is armed, and puts the record back', async () => {
    const t = await world();
    const armed = held();
    t.gate.armed = armed.wait;
    const opening = t.open();
    await until(() => t.phone.s.armed);
    const stopping = t.pay.stop();
    armed.go();
    await Promise.all([opening, stopping]);
    expect(t.views).toEqual([]);
    expect(await t.tap()).toBeNull();
    expect(await t.next()).toBe(FIRST);
    expect(t.log.slice(-2)).toEqual(['reader on', `record ${FIRST}`]);
    expect(t.armed).toEqual([true, false]);
    expect(t.phone.listening()).toBe(0);
  });

  it('does not miss a read in the moment after the arming, before the app has heard it is armed', async () => {
    const t = await world();
    const armed = held();
    t.gate.armed = armed.wait;
    const opening = t.open();
    await until(() => t.phone.s.armed);
    expect(await t.tap()).toBe(FIRST);
    armed.go();
    await opening;
    expect(t.view()).toEqual({ at: 'read', left: 60, server: true });
    await t.pay.stop();
    expect(await t.next()).toBe(FIRST + 1);
  });

  it('is over, the record right, when the app leaves the front in that same moment', async () => {
    const t = await world();
    const armed = held();
    t.gate.armed = armed.wait;
    const opening = t.open();
    await until(() => t.phone.s.armed);
    await t.tap();
    t.phone.leaveFront();
    armed.go();
    await opening;
    await t.pay.settled();
    expect(t.view()).toEqual({ at: 'cant', why: 'refused' });
    expect(await t.next()).toBe(FIRST + 1);
    expect(t.armed).toEqual([true, false]);
    expect(t.log.filter((l) => l === 'reader on')).toHaveLength(1);
  });

  it("never writes the record's next lower: where the keeping-in-step job raised it while the lock was asked, the taps begin there", async () => {
    const t = await world();
    const lock = held();
    t.gate.lock = lock.wait;
    const opening = t.open();
    await until(() => t.log.includes('lock'));
    // A run of the job that began before the screen opened reaches its last step now.
    await t.record.update((r) => r && { ...r, next: FIRST + 100 });
    lock.go();
    await opening;
    expect(await t.next()).toBe(FIRST + 100 + 16);
    expect(await t.tap()).toBe(FIRST + 100);
  });

  it("refuses a batch that would pass the counter's end, before anything is written", async () => {
    const t = await world({ record: { n: 0, version: 0, next: COUNTER_MAX - 14 }, counter: 5 });
    await t.open();
    expect(t.view()).toEqual({ at: 'cant', why: 'counter' });
    expect(t.log).toEqual(['lock']);
  });
});

describe('while the phone is a card', () => {
  it('counts down from 60, and stops being a card at 60 seconds when no till read it', async () => {
    const t = await world();
    await t.open();
    await t.pass(1);
    expect(t.view()).toEqual({ at: 'ready', left: 59, server: true });
    await t.pass(58);
    expect(t.view()).toEqual({ at: 'ready', left: 1, server: true });
    await t.pass(1);
    expect(t.view()).toEqual({ at: 'over', read: false, server: true });
    expect(await t.tap()).toBeNull();
    // No counter left the phone: all sixteen are used again.
    expect(await t.next()).toBe(FIRST);
    expect(t.log.slice(-2)).toEqual(['reader on', `record ${FIRST}`]);
    expect(t.armed).toEqual([true, false]);
    expect(t.phone.listening()).toBe(0);
    // Nothing more happens however long the screen stays.
    const views = t.views.length;
    await t.pass(100);
    expect(t.views).toHaveLength(views);
  });

  it('says it was read, and asks the server at the read and then each second for a payment newer than the one remembered', async () => {
    const t = await world();
    await t.open();
    await t.pass(5);
    expect(t.s.calls.filter((c) => c === 'history')).toHaveLength(1);
    expect(await t.tap()).toBe(FIRST);
    expect(t.view()).toEqual({ at: 'read', left: 55, server: true });
    await until(() => t.asks.length === 1);
    await t.pass(3);
    expect(t.view()).toEqual({ at: 'read', left: 52, server: true });
    // One ask before the lock; then, of a server that answers at once (one from before it held its answer), one at
    // the read and one a second, never a run of them; never the wallet, which asks phoenixd.
    expect(t.s.calls.filter((c) => c === 'history')).toHaveLength(5);
    expect(t.s.calls).not.toContain('wallet');
    // Each asks the server to hold its answer until the card's history has something newer than was remembered.
    const baseline = (await t.d.cardd.history(t.id(0), { limit: 1 }))[0]?.id ?? 0;
    expect(t.asks).toEqual(Array(4).fill({ limit: 5, after: baseline, wait: ASK_WAIT_S }));
    // The wait must end before the screen's own client gives the call up (the pay screen asks with the client a
    // held card's calls use: cards/deps.ts), with a second to spare for the answer's way back: a longer wait is
    // cut off by the phone every time, and the server never holds it out.
    expect(ASK_WAIT_S * 1000).toBeLessThanOrEqual(HELD_CALL_MS - 1000);
    expect(ASK_WAIT_S).toBe(4);
  });

  it('shows Paid the moment a held answer comes, between two seconds, and goes on counting while it is held', async () => {
    const t = await world();
    await t.open();
    const server = held();
    t.gate.held = server.wait;
    await t.pass(4);
    await t.tap();
    // The server holds the answer: the seconds still pass on the screen, and no second ask is made beside it.
    await t.pass(3);
    expect(t.view()).toEqual({ at: 'read', left: 53, server: true });
    expect(t.asks).toHaveLength(1);
    t.cardd.spend(t.id(0), 2_500_000, 12_000);
    server.go();
    await until(() => t.view().at === 'paid');
    expect(t.view()).toEqual({ at: 'paid', amountMsat: 2_500_000, feeMsat: 12_000, leftMsat: 6_000_000 - 2_512_000 });
    expect(t.buzz.n).toBe(1);
  });

  it('asks again at once when a held answer comes with no payment, and not in the same second as one that came at once', async () => {
    const t = await world();
    await t.open();
    let server = held();
    t.gate.held = server.wait;
    await t.tap();
    await until(() => t.asks.length === 1);
    // Eight seconds on, the server answers with nothing new: the next ask is made without waiting for a second to pass.
    t.clock.ms += 8_000;
    const first = server;
    server = held();
    t.gate.held = server.wait;
    first.go();
    await until(() => t.asks.length === 2);
    // That one is answered at once (a server that doesn't hold): no third until the next second's tick.
    server.go();
    await new Promise((done) => setTimeout(done, 5));
    expect(t.asks).toHaveLength(2);
    t.gate.held = null;
    await t.pass(1);
    expect(t.asks).toHaveLength(3);
  });

  it('asks past the newest transaction it has seen, so money that comes in while it is a card is told once and the server holds the next ask', async () => {
    const t = await world();
    t.cardd.balances.set('pool', 1_000_000);
    await t.open();
    await t.tap();
    await until(() => t.asks.length === 1);
    // Money is moved onto the card: newer than the payment remembered, and not a payment.
    await t.d.cardd.move({ id: '6f0e3a52-7c1d-4b8e-9a43-2d5c8e1f7b90', from: 'pool', to: t.id(0), amountMsat: 5_000 });
    const moved = (await t.d.cardd.history(t.id(0), { limit: 1 }))[0].id;
    await t.pass(2);
    expect(t.view().at).toBe('read');
    // Asked past the remembered payment for ever, the server would answer every ask at once with that move.
    expect((t.asks[t.asks.length - 1] as { after: number }).after).toBe(moved);
    // The payment is still one newer than the payment remembered, whatever came between.
    t.cardd.spend(t.id(0), 2_500_000, 12_000);
    await t.pass(1);
    expect(t.view()).toMatchObject({ at: 'paid', amountMsat: 2_500_000, feeMsat: 12_000 });
  });

  it('shows Paid before the server has said what is left, then what is left', async () => {
    const t = await world();
    await t.open();
    await t.tap();
    t.cardd.spend(t.id(0), 1_000_000);
    const wallet = held();
    t.gate.wallet = wallet.wait;
    const second = t.pass(1);
    await until(() => t.view().at === 'paid');
    expect(t.view()).toEqual({ at: 'paid', amountMsat: 1_000_000, feeMsat: 0, leftMsat: null });
    expect(t.buzz.n).toBe(1);
    wallet.go();
    await second;
    expect(t.view()).toEqual({ at: 'paid', amountMsat: 1_000_000, feeMsat: 0, leftMsat: 5_000_000 });
  });

  it('shows Paid for a payment from the card newer than the one remembered, buzzes, and stops being a card at once', async () => {
    const t = await world();
    await t.open();
    await t.pass(4);
    await t.tap();
    await t.pass(2);
    t.cardd.spend(t.id(0), 2_500_000, 12_000);
    await t.pass(1);
    expect(t.view()).toEqual({ at: 'paid', amountMsat: 2_500_000, feeMsat: 12_000, leftMsat: 6_000_000 - 2_512_000 });
    expect(t.buzz.n).toBe(1);
    expect(await t.tap()).toBeNull();
    expect(await t.next()).toBe(FIRST + 1);
    expect(t.armed).toEqual([true, false]);
    expect(t.s.calls.filter((c) => c === 'wallet')).toHaveLength(1);
    await t.pass(60);
    expect(t.view().at).toBe('paid');
    expect(t.buzz.n).toBe(1);
  });

  it('shows Paid without what is left when the server will not say', async () => {
    const t = await world();
    await t.open();
    await t.tap();
    t.cardd.spend(t.id(0), 1_000_000);
    t.s.failAt = t.s.calls.length + 2; // the history answers, the wallet does not
    await t.pass(1);
    expect(t.view()).toEqual({ at: 'paid', amountMsat: 1_000_000, feeMsat: 0, leftMsat: null });
  });

  it('does not show a payment made before the screen opened, or money that came in, as Paid', async () => {
    const t = await world();
    t.cardd.spend(t.id(0), 900_000);
    await t.open();
    await t.tap();
    await t.pass(3);
    expect(t.view().at).toBe('read');
    // A top-up of the card while the screen is open is not a payment from it.
    t.cardd.history.set(t.id(0), [{ id: 99_999, kind: 'topup', note: '', amountMsat: 5_000, feeMsat: 0, created: 0 }, ...(t.cardd.history.get(t.id(0)) ?? [])]);
    await t.pass(3);
    expect(t.view().at).toBe('read');
  });

  it('goes on asking when the server can not be reached for a second', async () => {
    const t = await world();
    await t.open();
    await t.tap();
    t.w.carddDown = true;
    await t.pass(2);
    expect(t.view().at).toBe('read');
    t.w.carddDown = false;
    t.cardd.spend(t.id(0), 700_000);
    await t.pass(1);
    expect(t.view().at).toBe('paid');
  });

  it('read and not paid, stops being a card at 60 seconds and goes on asking until 30 seconds after the last read', async () => {
    const t = await world();
    await t.open();
    await t.pass(50);
    await t.tap();
    await t.pass(8);
    await t.tap();
    // Read at 50 and 58 seconds: a card until 60, asking until 88.
    await t.pass(2);
    expect(t.view()).toEqual({ at: 'read', left: null, server: true });
    expect(await t.tap()).toBeNull();
    expect(await t.next()).toBe(FIRST + 2);
    await t.pass(27);
    expect(t.view()).toEqual({ at: 'read', left: null, server: true });
    await t.pass(1);
    expect(t.view()).toEqual({ at: 'over', read: true, server: true });
    expect(t.buzz.n).toBe(0);
  });

  it('read early and not paid, is over at 60 seconds', async () => {
    const t = await world();
    await t.open();
    await t.pass(2);
    await t.tap();
    await t.pass(57);
    expect(t.view()).toEqual({ at: 'read', left: 1, server: true });
    await t.pass(1);
    expect(t.view()).toEqual({ at: 'over', read: true, server: true });
  });

  it('shows a payment that settles after the phone stopped being a card, while it is still asking', async () => {
    const t = await world();
    await t.open();
    await t.pass(59);
    await t.tap();
    await t.pass(10);
    expect(t.view()).toEqual({ at: 'read', left: null, server: true });
    t.cardd.spend(t.id(0), 300_000);
    await t.pass(1);
    expect(t.view().at).toBe('paid');
  });
});

describe('ending it', () => {
  it('on Stop or Back, is over at once: never read, or read with no payment yet', async () => {
    const never = await world();
    await never.open();
    await never.pass(3);
    await never.pay.stop();
    expect(never.view()).toEqual({ at: 'over', read: false, server: true });
    expect(await never.tap()).toBeNull();
    expect(await never.next()).toBe(FIRST);
    const read = await world();
    await read.open();
    await read.tap();
    await read.tap();
    await read.tap();
    await read.pay.stop();
    expect(read.view()).toEqual({ at: 'over', read: true, server: true });
    expect(await read.next()).toBe(FIRST + 3);
    expect(read.log.slice(-2)).toEqual(['reader on', `record ${FIRST + 3}`]);
    // A second Stop, and the seconds after, change nothing.
    const views = read.views.length;
    await read.pay.stop();
    await read.pass(40);
    expect(read.views).toHaveLength(views);
  });

  it('on Stop after the card time, while still asking, is over at once', async () => {
    const t = await world();
    await t.open();
    await t.pass(59);
    await t.tap();
    await t.pass(5);
    await t.pay.stop();
    expect(t.view()).toEqual({ at: 'over', read: true, server: true });
  });

  it('when the app leaves the front, is over at once: the module disarmed by itself, and is not asked to again', async () => {
    const t = await world();
    await t.open();
    await t.tap();
    t.phone.leaveFront();
    await t.pass(0);
    await Promise.resolve();
    await t.pay.settled();
    expect(t.view()).toEqual({ at: 'over', read: true, server: true });
    expect(t.phone.s.calls).toEqual(['arm 16']);
    expect(await t.next()).toBe(FIRST + 1);
    expect(t.log.slice(-2)).toEqual(['reader on', `record ${FIRST + 1}`]);
    expect(t.armed).toEqual([true, false]);
  });

  it('before it was opened, a Stop shows nothing, and the opening after it does nothing', async () => {
    const t = await world();
    await t.pay.stop();
    await t.open();
    expect(t.views).toEqual([]);
    expect(t.log).toEqual([]);
    expect(t.phone.s.calls).toEqual([]);
  });

  // The module empties itself when the app leaves the front, and then answers a disarm with 0. What the reads
  // reported stands: a counter that left the phone is never handed out again.
  it('does not count fewer taps than the reads reported, when the service answers fewer at the disarm', async () => {
    const t = await world();
    await t.open();
    await t.tap();
    await t.tap();
    await t.tap();
    expect(t.phone.tag.clear()).toBe(3);
    await t.pay.stop();
    expect(await t.next()).toBe(FIRST + 3);
  });

  it('does not ask twice at once when a second passes before the server has answered the last', async () => {
    const t = await world();
    await t.open();
    await t.tap();
    t.cardd.spend(t.id(0), 400_000);
    const slow = held();
    t.gate.history = slow.wait;
    t.clock.ms += 1000;
    const first = t.pay.tick();
    t.clock.ms += 1000;
    const second = t.pay.tick();
    await second;
    slow.go();
    await first;
    expect(t.view().at).toBe('paid');
    expect(t.buzz.n).toBe(1);
    expect(t.s.calls.filter((c) => c === 'wallet')).toHaveLength(1);
    // Paid once: shown at the payment, then again with what is left.
    expect(t.views.filter((v) => v.at === 'paid')).toEqual([
      { at: 'paid', amountMsat: 400_000, feeMsat: 0, leftMsat: null },
      { at: 'paid', amountMsat: 400_000, feeMsat: 0, leftMsat: 5_600_000 },
    ]);
  });
});

describe('without the server', () => {
  it("is a card all the same, says it can't tell what was paid, and never says Paid or that nothing was taken", async () => {
    const t = await world();
    t.w.carddDown = true;
    await t.open();
    expect(t.view()).toEqual({ at: 'ready', left: 60, server: false });
    expect(await t.tap()).toBe(FIRST);
    expect(t.view()).toEqual({ at: 'read', left: 60, server: false });
    // The server comes back with a payment: this screen has nothing to tell it from an earlier one by.
    t.w.carddDown = false;
    t.cardd.spend(t.id(0), 500_000);
    const asked = t.s.calls.length;
    await t.pass(60);
    expect(t.s.calls).toHaveLength(asked);
    expect(t.view()).toEqual({ at: 'over', read: true, server: false });
    expect(t.buzz.n).toBe(0);
  });

  it('never read, is over at 60 seconds', async () => {
    const t = await world();
    t.w.carddDown = true;
    await t.open();
    await t.pass(60);
    expect(t.view()).toEqual({ at: 'over', read: false, server: false });
  });

  it('drops an answer that comes after the phone is armed: it might already hold this payment', async () => {
    const t = await world();
    let letGo = () => {};
    t.gate.wait = new Promise<void>((done) => (letGo = done));
    await t.open();
    expect(t.view()).toEqual({ at: 'ready', left: 60, server: false });
    await t.tap();
    t.cardd.spend(t.id(0), 500_000);
    letGo();
    await t.pass(5);
    expect(t.view()).toEqual({ at: 'read', left: 55, server: false });
    // And the record's next was the record's own: the server's counter came too late to be used.
    expect(await t.next()).toBe(FIRST + 16);
  });
});

describe('more taps', () => {
  it('are made when 8 or fewer are left, the record written first, and carry on from the last batch', async () => {
    const t = await world();
    await t.open();
    for (let i = 0; i < 7; i++) expect(await t.tap()).toBe(FIRST + i);
    expect(t.phone.s.calls).toEqual(['arm 16']);
    expect(await t.tap()).toBe(FIRST + 7);
    await t.pay.settled();
    expect(t.phone.s.calls).toEqual(['arm 16', 'add 16']);
    expect(t.log.slice(-1)).toEqual([`record ${FIRST + 32}`]);
    expect(t.phone.tag.left).toBe(24);
    for (let i = 8; i < 20; i++) expect(await t.tap()).toBe(FIRST + i);
    await t.pay.settled();
    // Not one more batch for each tap under 8 left: one is made at a time.
    expect(t.phone.s.calls.filter((c) => c === 'add 16')).toHaveLength(1);
    await t.pay.stop();
    expect(await t.next()).toBe(FIRST + 20);
  });

  it("never write the record's next lower than it stands", async () => {
    const t = await world();
    await t.open();
    // A run of the job that began before the phone was armed reaches its last step now.
    await t.record.update((r) => r && { ...r, next: FIRST + 100 });
    for (let i = 0; i < 8; i++) await t.tap();
    await t.pay.settled();
    expect(t.phone.tag.left).toBe(8 + 16);
    expect(await t.next()).toBe(FIRST + 100);
  });

  it("are not made past the counter's end: the phone gives what it has", async () => {
    const t = await world({ record: { n: 0, version: 0, next: COUNTER_MAX - 15 }, counter: 5 });
    await t.open();
    for (let i = 0; i < 8; i++) await t.tap();
    await t.pay.settled();
    expect(t.phone.s.calls).toEqual(['arm 16']);
    expect(t.phone.tag.left).toBe(8);
    await t.pay.stop();
    expect(await t.next()).toBe(COUNTER_MAX - 15 + 8);
  });
});
