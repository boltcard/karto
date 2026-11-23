// Settings' Wallet name row and its sheet: the row says the name,
// opens a sheet that saves a new one, keeps the sheet open with the reason on a refusal, and on a server before
// names says it needs an update. The watch's snapshot and cardd are the test's.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUpdateCheckerForTests } from '../../appUpdate/useAppUpdate';
import Settings from '../../app/settings';
import { CarddError } from '../../cardd/error';
import { WalletNameSheet } from '../../ui/WalletNameSheet';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.1' } } }));

const snap: { wallet: { name?: string } | null } = { wallet: { name: '' } };
const setWalletName = vi.fn(async (name: string) => name.trim());

vi.mock('../../services/server', () => ({
  useWatcher: () => ({ snap, watch: {} }),
  useCardDeps: () => ({ host: 'karto.example', cardd: { setWalletName } }),
}));
vi.mock('../../services/services', () => ({
  useRouteGuard: () => true,
  useServices: () => ({ phrase: { outlivesApp: false }, build: {}, nfc: { openSettings: vi.fn() } }),
  alertsClient: () => ({}),
}));
vi.mock('../../alerts/useAlerts', () => ({ useAlerts: () => ({ supported: false }) }));
vi.mock('../../deploy/bundle', () => ({ buildLabel: (_b: unknown, version?: string) => `build ${version}` }));
vi.mock('../../wallet/serverView', () => ({ serverView: () => ({ keyNotice: { kind: 'ok' } }) }));
// The amounts group, where the row is, is drawn under the server's group: it needs a row of its own.
vi.mock('../../wallet/settingsRows', () => ({ settingsRows: () => [{ key: 'server', name: 'Server', line: '', tone: 'none', opens: null }] }));
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({ fiat: { currency: 'none' }, unit: 'sat', hidden: false, setUnit: () => {}, setHidden: () => {}, chooseCurrency: async () => {} }),
}));

const row = () => screen.getByRole('button', { name: /Wallet name/ });

describe("Settings' Wallet name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snap.wallet = { name: '' };
  });

  it("shows the wallet's name and changes it", async () => {
    render(<Settings />);
    expect(row().textContent).toContain('Not named yet');
    fireEvent.click(row());
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'Café' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(setWalletName).toHaveBeenCalledWith('Café');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(row().textContent).toContain('Café');
  });

  it('says an older server needs an update, and opens nothing', () => {
    snap.wallet = {};
    render(<Settings />);
    expect(row().textContent).toContain('Needs a server update');
    fireEvent.click(row());
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the sheet open, with the reason, when the server refuses the name', async () => {
    setWalletName.mockRejectedValueOnce(new CarddError(400, 'bad_name', "store: a wallet's name is 1 to 24 characters, none of them hidden"));
    snap.wallet = { name: 'Old' };
    render(<Settings />);
    fireEvent.click(row());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByText("A name can't hold hidden characters.")).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

describe('WalletNameSheet', () => {
  it("won't save an empty name or one with a hidden character, and says why", () => {
    render(<WalletNameSheet start="" onSave={vi.fn()} onClose={vi.fn()} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled') === 'true' || (save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a\u200bb' } });
    expect(screen.getByText("A name can't hold hidden characters.")).toBeTruthy();
  });
});

// Settings / This PoS in a GitHub build: the update line is drawn under the build label.
describe('the update line', () => {
  afterEach(() => setUpdateCheckerForTests({ os: 'android', release: undefined, store: 'play' }, { getItemAsync: async () => null, setItemAsync: async () => {} }, vi.fn()));

  it('is drawn on the page, naming Karto Wallet', async () => {
    const github = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ tag_name: 'v9.0.0' }) }) as Response);
    setUpdateCheckerForTests({ os: 'android', release: '1', store: '' }, { getItemAsync: async () => null, setItemAsync: async () => {} }, github);
    render(<Settings />);
    expect(await screen.findByRole('link', { name: 'Karto Wallet 9.0.0 is out on GitHub' })).toBeTruthy();
    expect(github).toHaveBeenCalledTimes(1);
    expect(screen.getByText('build 1.0.1')).toBeTruthy();
  });
});
