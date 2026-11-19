// Karto PoS's Pair screen rendered with a code in hand. Any app or web page on the phone can send a pairing link:
// a paired till refuses one, says how it is paired and how to unpair it, and marks the link answered; only a code
// its own scanner read offers the other shop. A phone that isn't paired is asked about a link, as before, and told
// a code it answered before is spent.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { router, useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import Pair from '../../pos-app/pair';

const HOST = 'karto.example';
const OTHER = 'vm-1003.lnvps.cloud';
const CODE = 'a'.repeat(32);
const phone: {
  paired: { host: string; name: string; wallet?: string } | null;
  scanned: { current: { host: string; code: string } | null };
  answered: Mock<(code: string) => Promise<boolean>>;
  markAnswered: Mock<(code: string) => Promise<void>>;
} = { paired: null, scanned: { current: null }, answered: vi.fn(), markAnswered: vi.fn() };
// One store for the life of the app, as usePos gives it: the screen reads it again whenever it changes.
const store = { answered: (code: string) => phone.answered(code), markAnswered: (code: string) => phone.markAnswered(code) };

vi.mock('../../pos/app', () => ({
  usePos: () => ({
    paired: phone.paired,
    scanned: phone.scanned,
    sale: null,
    store,
    setPaired: vi.fn(),
  }),
}));

const WHY =
  "A pairing link can't change the shop of a phone that is already paired. To pair it again, with this shop or another, unpair it first (open Sales, then This PoS, then Unpair this phone), then ask Karto Wallet for a new code.";
const SPENT = 'That pairing code was used or turned down already. Ask Karto Wallet for a new one: Shop, then Add a PoS phone.';
const HEADING = 'Pair this phone to take payments';
const link = (host: string) => vi.mocked(useLocalSearchParams).mockReturnValue({ host, code: CODE });

describe('the Pair screen with a pairing code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useLocalSearchParams).mockReturnValue({});
    phone.paired = { host: HOST, name: 'Till 1', wallet: 'Café' };
    phone.scanned.current = null;
    phone.answered.mockResolvedValue(false);
    phone.markAnswered.mockResolvedValue(undefined);
  });

  it('refuses a link on a paired phone: no other shop on offer, how to unpair, and the link answered', async () => {
    link(OTHER);
    render(<Pair />);
    expect(await screen.findByText(`This phone is already paired with Café (${HOST}) as Till 1.`)).toBeTruthy();
    expect(screen.getByText(WHY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pair with the new shop' })).toBeNull();
    expect(screen.queryByText(new RegExp(OTHER.replace(/\./g, '\\.')))).toBeNull();
    // Answered, so Android handing the same link over again opens the app as its icon does.
    await waitFor(() => expect(phone.markAnswered).toHaveBeenCalledWith(CODE));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the till' }));
    expect(router.replace).toHaveBeenCalledWith('/till');
  });

  it('refuses a link for the same shop too', async () => {
    link(HOST);
    render(<Pair />);
    expect(await screen.findByRole('button', { name: 'Back to the till' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pair with the new shop' })).toBeNull();
  });

  it("offers the other shop for a code the till's own scanner read", async () => {
    phone.scanned.current = { host: OTHER, code: CODE };
    render(<Pair />);
    expect(await screen.findByText(`The new code is for ${OTHER}.`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pair with the new shop' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep this shop' })).toBeTruthy();
    expect(phone.markAnswered).not.toHaveBeenCalled();
  });

  // A link can come while Pair is already in front, holding a code the scanner read: the link is the code in hand.
  it('refuses a link that arrives on a Pair screen holding a scanned code', async () => {
    phone.scanned.current = { host: OTHER, code: 'b'.repeat(32) };
    const { rerender } = render(<Pair />);
    expect(await screen.findByRole('button', { name: 'Pair with the new shop' })).toBeTruthy();
    link(OTHER);
    rerender(<Pair />);
    expect(await screen.findByText(WHY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pair with the new shop' })).toBeNull();
    await waitFor(() => expect(phone.markAnswered).toHaveBeenCalledWith(CODE));
  });

  // The wallet's "Karto PoS is on this phone" on a paired till: refused. Unpaired, the same button sends the same
  // code again: it pairs nothing by itself, and the screen says to get a new code.
  it('refuses a link, and after Unpair the same code says it is spent and pairs nothing', async () => {
    const answered = new Set<string>();
    phone.answered.mockImplementation(async (code) => answered.has(code));
    phone.markAnswered.mockImplementation(async (code) => void answered.add(code));
    link(OTHER);
    const first = render(<Pair />);
    expect(await screen.findByText(WHY)).toBeTruthy();
    await waitFor(() => expect(answered.has(CODE)).toBe(true));
    first.unmount();

    // This PoS › Unpair this phone, which opens Pair; then the same link again.
    phone.paired = null;
    render(<Pair />);
    expect(await screen.findByText(SPENT)).toBeTruthy();
    expect(screen.getByText(HEADING)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan the code' })).toBeTruthy();
    expect(screen.queryByText(`Pair this phone with ${OTHER}?`)).toBeNull();
    expect(screen.queryByText('Pairing…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull();
  });

  it("asks about a link on a phone that isn't paired", async () => {
    phone.paired = null;
    link(OTHER);
    render(<Pair />);
    expect(await screen.findByText(`Pair this phone with ${OTHER}?`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pair' })).toBeTruthy();
    await act(async () => {});
    expect(phone.markAnswered).not.toHaveBeenCalled();
  });
});
