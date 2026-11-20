// The payment page rendered, over the card tests' fake cardd: a send's facts at once from the line the
// account page kept, then its details; a note saved on leaving the field, refused, and cleared; the account page's
// history read after a note's save on leaving the page; an old server; a server that can't be reached, then can. Only what needs a phone is replaced: the clipboard and the app's services.
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Account from '../../app/account';
import Payment from '../../app/payment';
import type { CardDeps } from '../../cards/deps';
import { CarddError } from '../../cardd/error';
import type { Rated } from '../../money/fiat';
import { openedLine } from '../../money/openedLine';
import type { View } from '../../money/view';
import { cardWorld } from '../cardWorld';

const deps: { now: CardDeps | null } = { now: null };

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
// The account page (one test) reads more of the server's state: the same objects every render, as the app's are.
const server = {
  snap: { cards: [], phoneCard: { own: null, ids: [] }, photos: {} },
  watch: { reportRefresh: () => {}, reloadCards: async () => {}, seenWallet: vi.fn() },
};
vi.mock('../../services/server', () => ({ useCardDeps: () => deps.now, useServer: () => server, useTapCheck: () => null }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({}), phoneCardDeps: () => ({}) }));
// The app's view: sat with no rate, as a new phone's, unless a test says otherwise.
const look: { view: View; rated: Rated | null } = { view: 'sat', rated: null };
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({
    view: look.view, rated: look.rated, fiat: look.rated, unit: 'sat', hidden: false, setUnit: () => {}, setHidden: () => {},
    typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: async () => {},
  }),
}));

async function sentOne(comment?: string) {
  const world = await cardWorld();
  world.cardd.balances.set('pool', 100_000_000);
  await world.deps.cardd.send({ id: 's1', to: 'sam@example.com', amountMsat: 21_000, ...(comment ? { comment } : {}) });
  const [line] = await world.deps.cardd.history('pool', { limit: 1 });
  deps.now = world.deps;
  vi.mocked(useLocalSearchParams).mockReturnValue({ account: 'pool', tx: String(line.id) });
  return { world, line };
}

describe('A payment page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openedLine.clear();
    look.view = 'sat';
    look.rated = null;
  });

  // The page's amount large with the other figure under
  // it, today's value marked "now" in £ view, the fee in the view; *** hides them.
  it("draws its amounts in the app's view", async () => {
    const world = await cardWorld();
    world.cardd.balances.set('pool', 100_000_000);
    await world.deps.cardd.send({ id: 's2', to: 'sam@example.com', amountMsat: 50_000_000 });
    const [line] = await world.deps.cardd.history('pool', { limit: 1 });
    deps.now = world.deps;
    vi.mocked(useLocalSearchParams).mockReturnValue({ account: 'pool', tx: String(line.id) });
    openedLine.put('pool', line);
    look.rated = { currency: 'GBP', price: 61_352, time: Math.floor(Date.now() / 1000) };
    look.view = 'fiat';
    const fiat = render(<Payment />);
    await screen.findByText('sam@example.com');
    expect(screen.getByLabelText("30 pounds 68 at today's rate")).toBeTruthy();
    const text = fiat.container.textContent ?? '';
    for (const shown of ['30.68 GBP', 'now', '50,000 sat']) expect(text).toContain(shown);
    // "now" under the figure it marks, before the sats.
    expect(text.indexOf('now')).toBeLessThan(text.indexOf('50,000 sat'));
    fiat.unmount();
    look.view = 'hidden';
    const hidden = render(<Payment />);
    await screen.findByText('sam@example.com');
    const shown = hidden.container.textContent ?? '';
    expect(shown).toContain('***');
    for (const amount of ['50,000', '£', 'GBP', ' sat']) expect(shown).not.toContain(amount);
  });

  it("shows the line at once, then its details and proof; Copy copies the whole value", async () => {
    const { line } = await sentOne('Coffee with Sam');
    openedLine.put('pool', line);
    render(<Payment />);
    expect(screen.getByText('Sent out')).toBeTruthy();
    expect(screen.getByLabelText('21 sat')).toBeTruthy(); // an Amount in the app's view
    expect(await screen.findByText('sam@example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('Coffee with Sam')).toBeTruthy();
    expect(screen.getByText(/^Server's record: paid /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the payment hash' }));
    expect(vi.mocked(Clipboard.setStringAsync).mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('gives TalkBack the shown characters of a proof, never the whole value', async () => {
    const { world, line } = await sentOne();
    openedLine.put('pool', line);
    render(<Payment />);
    await screen.findByText('sam@example.com');
    const p = (await world.deps.cardd.transaction('pool', line.id)).payment;
    const whole = [p?.hash, p?.invoice, p?.preimage].filter((v): v is string => !!v);
    expect(whole.length).toBeGreaterThan(1);
    const labels = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? '');
    for (const v of whole) expect(labels.filter((l) => l.includes(v))).toEqual([]);
    expect(screen.getByLabelText(`Payment hash: starts ${p?.hash?.slice(0, 8)}, ends ${p?.hash?.slice(-6)}`)).toBeTruthy();
  });

  it('saves a note on leaving the field, says a refusal, and clears it', async () => {
    const { world, line } = await sentOne();
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /); // loaded: the field takes notes now
    const field = screen.getByPlaceholderText('Add a note');
    fireEvent.change(field, { target: { value: 'rent' } });
    fireEvent.blur(field);
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('rent');
    vi.spyOn(world.deps.cardd, 'setComment').mockRejectedValueOnce(new CarddError(400, 'bad_note', 'a note is 200 characters at most'));
    fireEvent.change(field, { target: { value: 'rent, March' } });
    fireEvent.blur(field);
    expect(await screen.findByText(/^Not saved: a note is 200 characters at most/)).toBeTruthy();
    expect(screen.getByDisplayValue('rent, March')).toBeTruthy();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    await screen.findByText('Saved');
    expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('');
  });

  it('takes 200 emoji, not 100, and saves them', async () => {
    const { world, line } = await sentOne();
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note') as HTMLInputElement;
    expect(field.maxLength).toBe(-1); // no UTF-16 cap: the field cuts by code points
    fireEvent.change(field, { target: { value: '\u{1F600}'.repeat(201) } });
    expect(field.value).toBe('\u{1F600}'.repeat(200));
    fireEvent.blur(field);
    await screen.findByText('Saved');
    expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('\u{1F600}'.repeat(200));
  });

  it("Done's two events save a note cardd cleans once, not twice", async () => {
    const { world } = await sentOne();
    const release = holdNextSave(world);
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note');
    fireEvent.change(field, { target: { value: 'a  b' } }); // cardd keeps it as "a b"
    fireEvent.blur(field); // Done: onSubmitEditing, then onBlur while the first save is on its way
    fireEvent.blur(field);
    await act(async () => release());
    await screen.findByText('Saved');
    expect(screen.getByDisplayValue('a b')).toBeTruthy();
    expect(world.deps.cardd.setComment).toHaveBeenCalledTimes(1);
  });

  it('drops "Not saved" once the field holds what the server keeps again', async () => {
    const { world } = await sentOne('rent');
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note');
    vi.spyOn(world.deps.cardd, 'setComment').mockRejectedValueOnce(new CarddError(500, 'internal', 'disk full'));
    fireEvent.change(field, { target: { value: 'rent, March' } });
    fireEvent.blur(field);
    expect(await screen.findByText(/^Not saved: /)).toBeTruthy();
    fireEvent.change(field, { target: { value: 'rent' } });
    expect(screen.queryByText(/^Not saved: /)).toBeNull();
    // Nor does it come back for what is typed next, before that is saved.
    fireEvent.change(field, { target: { value: 'rent, April' } });
    expect(screen.queryByText(/^Not saved: /)).toBeNull();
  });

  it('says "Saved" beside the label, in its own words, not as part of it', async () => {
    await sentOne();
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note');
    fireEvent.change(field, { target: { value: 'rent' } });
    fireEvent.blur(field);
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByText('Your note')).toBeTruthy();
    expect(screen.queryByText(/^Your note ·/)).toBeNull();
  });

  it("a server that answered with an error: its words, not that it can't be reached, and Try again", async () => {
    const { world, line } = await sentOne();
    openedLine.put('pool', line);
    vi.spyOn(world.deps.cardd, 'transaction').mockRejectedValueOnce(new CarddError(500, 'internal', 'database is locked'));
    render(<Payment />);
    expect(await screen.findByText("Your server couldn't give this payment's details. The server refused: database is locked")).toBeTruthy();
    expect(screen.queryByText(/^Can't reach your server/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByText('sam@example.com')).toBeTruthy();
  });

  it('saves a changed note when the page goes before the field is left', async () => {
    const { world, line } = await sentOne();
    const page = render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    fireEvent.change(screen.getByPlaceholderText('Add a note'), { target: { value: 'gift' } });
    page.unmount();
    await vi.waitFor(async () => expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('gift'));
  });

  /** Holds cardd's answer to the next PATCH of a note until release() is called. */
  function holdNextSave(world: Awaited<ReturnType<typeof cardWorld>>) {
    const cardd = world.deps.cardd;
    const real = cardd.setComment.bind(cardd);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(cardd, 'setComment').mockImplementationOnce(async (...a) => {
      await gate;
      return real(...a);
    });
    return () => release();
  }

  it('saves an edit made while a save was on its way, when the page goes before that save answers', async () => {
    const { world, line } = await sentOne();
    const release = holdNextSave(world);
    const page = render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note');
    fireEvent.change(field, { target: { value: 'a' } });
    fireEvent.blur(field); // the PATCH for "a" is held
    fireEvent.change(field, { target: { value: 'ab' } });
    fireEvent.blur(field);
    page.unmount();
    release();
    await vi.waitFor(async () => expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('ab'));
  });

  it('does not say Saved beside text typed after the save left, and saves that text when the field is left', async () => {
    const { world, line } = await sentOne();
    const release = holdNextSave(world);
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note');
    fireEvent.change(field, { target: { value: 'a' } });
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: 'ab' } });
    await act(async () => release());
    await vi.waitFor(async () => expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('a'));
    await act(async () => {});
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByDisplayValue('ab')).toBeTruthy();
    fireEvent.blur(field);
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('ab');
  });

  it('saves text put back to the saved note while a save was on its way', async () => {
    const { world, line } = await sentOne('x');
    const release = holdNextSave(world);
    render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    const field = screen.getByPlaceholderText('Add a note');
    fireEvent.change(field, { target: { value: 'y' } });
    fireEvent.blur(field); // the PATCH for "y" is held
    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.blur(field);
    await act(async () => release());
    // Saved is said once cardd keeps what the field shows: "x" saved again after "y".
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect((await world.deps.cardd.transaction('pool', line.id)).comment).toBe('x');
    expect(world.deps.cardd.setComment).toHaveBeenCalledTimes(2);
  });

  it("the account page come back to while the note's save on leaving is on its way reads its history after that save", async () => {
    const { world, line } = await sentOne();
    const cardd = world.deps.cardd;
    const order: string[] = [];
    const setComment = cardd.setComment.bind(cardd);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(cardd, 'setComment').mockImplementationOnce(async (...a) => {
      await gate;
      const detail = await setComment(...a);
      order.push('saved');
      return detail;
    });
    const history = cardd.history.bind(cardd);
    vi.spyOn(cardd, 'history').mockImplementation(async (...a) => {
      order.push('history');
      return history(...a);
    });
    openedLine.put('pool', line);
    const page = render(<Payment />);
    await screen.findByText(/^Server's record: paid /);
    fireEvent.change(screen.getByPlaceholderText('Add a note'), { target: { value: 'gift' } });
    // The back key: the keyboard closed without leaving the field, so the page saves as it goes, and the account
    // page under it comes into focus in the same moment.
    vi.mocked(useLocalSearchParams).mockReturnValue({ id: 'pool' });
    await act(async () => {
      page.unmount();
      render(<Account />);
    });
    expect(order).toEqual([]);
    await act(async () => release());
    await vi.waitFor(() => expect(order.slice(0, 2)).toEqual(['saved', 'history']));
    expect(await screen.findByText('gift')).toBeTruthy();
  });

  it('a failed save does not stop the history read that waited for it', async () => {
    const reject = (async () => {
      throw new Error('down');
    })();
    openedLine.saving = reject;
    const read = openedLine.settled().then(() => 'read');
    expect(await read).toBe('read');
    expect(openedLine.saving).toBeNull();
  });

  it("a line the server's books don't have: the words for it, no note", async () => {
    const { line } = await sentOne();
    vi.mocked(useLocalSearchParams).mockReturnValue({ account: 'pool', tx: String(line.id + 99) });
    render(<Payment />);
    expect(await screen.findByText("This payment isn't in your server's books any more.")).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add a note')).toBeNull();
  });

  it('an old server: the line, the words to update, no note', async () => {
    const { world, line } = await sentOne();
    world.cardd.transactionRoutes = false;
    openedLine.put('pool', line);
    render(<Payment />);
    expect(await screen.findByText("Update server to see this payment's details.")).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add a note')).toBeNull();
    expect(screen.getByText('Sent out')).toBeTruthy();
  });

  it("a server that can't be reached, then can: Try again", async () => {
    const { world, line } = await sentOne();
    openedLine.put('pool', line);
    world.w.carddDown = true; // the card world's switch: every request to cardd fails as expo/fetch does
    render(<Payment />);
    expect(await screen.findByText("Can't reach your server: the details show when it can.")).toBeTruthy();
    world.w.carddDown = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByText('sam@example.com')).toBeTruthy();
  });
});

// A top-up's payer's note in quotes, first on its page and on
// its history row before the person's own note; plain text, nothing to press.
describe("A payer's note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openedLine.clear();
    look.view = 'sat';
    look.rated = null;
  });

  it("is the first fact on a top-up's page, and nothing pressable carries it", async () => {
    const world = await cardWorld();
    world.cardd.topUp('pool', 2_000_000, { payerNote: 'thanks for the talk' });
    const [line] = await world.deps.cardd.history('pool', { limit: 1 });
    deps.now = world.deps;
    vi.mocked(useLocalSearchParams).mockReturnValue({ account: 'pool', tx: String(line.id) });
    openedLine.put('pool', line);
    render(<Payment />);
    expect(await screen.findByText('“thanks for the talk”')).toBeTruthy();
    expect(screen.getByText("Payer's note")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /thanks for the talk/ })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it("is on its history row in quotes, before the person's own note, and read out", async () => {
    const world = await cardWorld();
    world.cardd.topUp('pool', 1_000_000);
    world.cardd.topUp('pool', 5_000_000, { payerNote: 'refund, order 1043', comment: 'from the meetup' });
    deps.now = world.deps;
    vi.mocked(useLocalSearchParams).mockReturnValue({ id: 'pool' });
    const page = render(<Account />);
    expect(await screen.findByText('“refund, order 1043”')).toBeTruthy();
    const text = page.container.textContent ?? '';
    expect(text.indexOf('“refund, order 1043”')).toBeLessThan(text.indexOf('from the meetup'));
    expect(text.split('“').length - 1).toBe(1); // the other top-up has no quotes
    expect(screen.getByRole('button', { name: /plus 5,000 sat, note from the payer, refund, order 1043, from the meetup/ })).toBeTruthy();
  });
});

describe("the account page's wallet keeps the app's rate fresh", () => {
  it('hands each wallet it reads to the watch, with its own clients', async () => {
    const world = await cardWorld();
    deps.now = world.deps;
    server.watch.seenWallet.mockClear();
    vi.mocked(useLocalSearchParams).mockReturnValue({ id: 'pool' });
    render(<Account />);
    await vi.waitFor(() => expect(server.watch.seenWallet).toHaveBeenCalled());
    const [given, wallet] = server.watch.seenWallet.mock.calls[0];
    expect(given).toBe(world.deps);
    expect(wallet).toEqual(await world.deps.cardd.wallet());
  });
});
