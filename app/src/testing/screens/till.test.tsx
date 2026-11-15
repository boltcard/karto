// Karto PoS's till rendered: with the shop's
// currency and rate the pad types pounds, "≈ N sat" under the figure, and Charge sends the price; the sat key types one
// sale in sats, and the next starts in pounds again; with a currency but no rate it types sats and says so. Charge
// reads nothing first: the rate is read as the till shows. The shop's server is a stand-in for pos.ask.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { router } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fiat } from '../../money/fiat';
import type { PosSale } from '../../pos/client';
import Till from '../../pos-app/till';
import { refocus } from './focus';

const ID = '00000000-0000-4000-8000-000000000001';
const NOW_S = Math.floor(Date.now() / 1000);
const SALE = { id: ID, amountMsat: 4_075_000, state: 'open', method: '', device: { keyId: 'k', name: 'Till 1' }, created: NOW_S, expires: NOW_S + 600, invoice: 'lnbc1example' } as unknown as PosSale;
const till: {
  fiat: Fiat | null; newSale: ReturnType<typeof vi.fn>; readFiat: ReturnType<typeof vi.fn>; readMe: ReturnType<typeof vi.fn>; setSale: ReturnType<typeof vi.fn>;
  paired: { host: string; name: string; wallet?: string };
} = {
  fiat: null, newSale: vi.fn(), readFiat: vi.fn(async () => {}), readMe: vi.fn(async () => {}), setSale: vi.fn(), paired: { host: 'karto.example', name: 'Till 1' },
};

vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
vi.mock('../../pos/app', () => ({
  usePos: () => ({
    paired: till.paired,
    fiat: till.fiat,
    readFiat: till.readFiat,
    readMe: till.readMe,
    ask: (call: (c: { newSale: typeof till.newSale }) => Promise<unknown>) => call({ newSale: till.newSale }),
    setSale: till.setSale,
  }),
}));

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('the till with a shop currency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    till.fiat = { currency: 'GBP', price: 61_352, time: NOW_S };
    till.newSale.mockResolvedValue(SALE);
  });

  it('types pounds, shows the sats they come to, and charges the price, reading no rate on the way', async () => {
    render(<Till />);
    expect(till.readFiat).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0.00')).toBeTruthy();
    for (const k of ['2', '5', '0']) press(k);
    expect(screen.getByText('2.50')).toBeTruthy();
    expect(screen.getByText('GBP')).toBeTruthy();
    expect(screen.getByText('≈ 4,075 sat')).toBeTruthy();
    till.readFiat.mockClear();
    press('Charge £2.50');
    await waitFor(() => expect(till.setSale).toHaveBeenCalledWith(SALE));
    expect(till.newSale).toHaveBeenCalledWith(ID, { price: { currency: 'GBP', minor: 250 } });
    expect(router.push).toHaveBeenCalledWith('/sale');
    // Nothing on the Charge path waits on a fetch of the rate.
    expect(till.readFiat).not.toHaveBeenCalled();
  });

  it('types a price from its last digit, as a cash register does, with no point key', () => {
    render(<Till />);
    expect(screen.queryByRole('button', { name: 'Decimal point' })).toBeNull();
    press('1');
    expect(screen.getByText('0.01')).toBeTruthy();
    press('2');
    expect(screen.getByText('0.12')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Charge £0.12' })).toBeTruthy();
    press('5');
    expect(screen.getByText('1.25')).toBeTruthy();
    press('Delete');
    expect(screen.getByText('0.12')).toBeTruthy();
    press('Delete');
    press('Delete');
    expect(screen.getByText('0.00')).toBeTruthy();
    // 00: 5 then 00 is £5.00.
    for (const k of ['5', 'Double zero']) press(k);
    expect(screen.getByText('5.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Charge £5.00' })).toBeTruthy();
  });

  it('ignores a penny that would take the price over 2,000,000 sat at its rate', () => {
    render(<Till />);
    for (const k of ['1', '2', '2', '7', '0', '5']) press(k);
    // £1,227.05 is a penny over the cap (£1,227.04 = 2,000,000 sat): the 5 is ignored.
    expect(screen.getByText('122.70')).toBeTruthy();
    press('4');
    expect(screen.getByText('1,227.04')).toBeTruthy();
    expect(screen.getByText('≈ 2,000,000 sat')).toBeTruthy();
  });

  it('types one sale in sats with its sat key, and starts the next in pounds again', async () => {
    render(<Till />);
    press('sat');
    for (const k of '4075') press(k);
    expect(screen.getByText('4,075')).toBeTruthy();
    // The 00 key in sats: two 0s after the amount; deleted again for this sale.
    press('Double zero');
    expect(screen.getByText('407,500')).toBeTruthy();
    press('Delete');
    press('Delete');
    press('Charge 4,075 sat');
    await waitFor(() => expect(till.setSale).toHaveBeenCalledWith(SALE));
    expect(till.newSale).toHaveBeenCalledWith(ID, { sat: 4075 });
    // Back at the till after the sale: pounds again, the figure cleared.
    act(refocus);
    expect(await screen.findByRole('button', { name: 'sat' })).toBeTruthy();
    expect(screen.getByText('0.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Charge' }).getAttribute('aria-disabled')).toBe('true');
  });

  it("says the shop's currency changed, and reads the currency again, when cardd refuses the price", async () => {
    const { CarddError } = await import('../../cardd/error');
    till.newSale.mockRejectedValue(new CarddError(409, 'wrong_currency', "The shop's currency changed: start the sale again."));
    render(<Till />);
    for (const k of ['1', '5', '0']) press(k);
    till.readFiat.mockClear();
    press('Charge £1.50');
    expect(await screen.findByText("The shop's currency changed: start the sale again.")).toBeTruthy();
    // Read after the refusal, not before the Charge.
    expect(till.newSale).toHaveBeenCalledTimes(1);
    expect(till.readFiat).toHaveBeenCalledTimes(1);
    expect(till.setSale).not.toHaveBeenCalled();
  });

  it('says "No £ rate yet" once, not twice, after cardd refuses a price for want of a rate', async () => {
    const { CarddError } = await import('../../cardd/error');
    const words = 'No £ rate yet: type the price in sat.';
    till.newSale.mockRejectedValue(new CarddError(409, 'no_rate', words));
    // The read after the refusal finds the shop's currency with no rate: the till's own note says the same.
    till.readFiat.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => void (till.fiat = { currency: 'GBP' }));
    render(<Till />);
    for (const k of ['2', '5', '0']) press(k);
    press('Charge £2.50');
    await waitFor(() => expect(till.readFiat).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Charge' })).toBeTruthy());
    expect(screen.getAllByText(words)).toHaveLength(1);
  });

  it("types sats, and says why, while the shop's currency has no rate yet", () => {
    till.fiat = { currency: 'GBP' };
    render(<Till />);
    expect(screen.getByText('No £ rate yet: type the price in sat.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sat' })).toBeNull();
    for (const k of '2500') press(k);
    expect(screen.getByRole('button', { name: 'Charge 2,500 sat' })).toBeTruthy();
  });
});

// The till says whose it is under the pad, the wallet's name and
// its own, or the server's address while the wallet has no name; and reads who it is when it reads the currency.
describe("the till's name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    till.fiat = null;
  });

  it("shows the wallet's name with its own", () => {
    till.paired = { host: 'karto.example', name: 'Till 1', wallet: 'Café' };
    render(<Till />);
    expect(screen.getByText('Café · Till 1')).toBeTruthy();
  });

  it('shows the server when the wallet has no name', () => {
    till.paired = { host: 'karto.example', name: 'Till 1', wallet: '' };
    render(<Till />);
    expect(screen.getByText('karto.example · Till 1')).toBeTruthy();
  });

  it('reads who it is as it shows, and again as it comes back, with the currency', async () => {
    render(<Till />);
    expect(till.readMe).toHaveBeenCalledTimes(1);
    expect(till.readFiat).toHaveBeenCalledTimes(1);
    await act(async () => refocus());
    expect(till.readMe).toHaveBeenCalledTimes(2);
  });
});
