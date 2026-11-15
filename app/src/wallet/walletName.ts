// The wallet's name: what Karto PoS phones show beside their own, so a till
// says which wallet it takes payments for. Kept by cardd (PUT /api/v1/wallet/name), asked at the end of setup, in
// Settings, and once per start of the app while the wallet has none. The rule is cardd's and the till's
// (cardd/names.ts).
import { isName, NAME_MAX, NOT_IN_A_NAME } from '../cardd/names';

export const NAME_PAGE = {
  title: 'Name this wallet',
  // Customers see it too, in a refund's note.
  body: "Karto PoS phones show this name, and a refund's note to the customer names it.",
  save: 'Save',
} as const;

/** The field's first text: the phone's model (native/deviceName.ts), cut to 24 characters and trimmed. */
export const namePrefill = (model: string): string => [...model].slice(0, NAME_MAX).join('').trim();

/** Whether a typed name can be kept (it is trimmed when sent), and the line that says why not: none for an empty field. */
export function walletNameProblem(typed: string): { ok: boolean; line: string } {
  const name = typed.trim();
  if (name === '') return { ok: false, line: '' };
  if ([...name].length > NAME_MAX) return { ok: false, line: `A name is up to ${NAME_MAX} characters.` };
  if (NOT_IN_A_NAME.test(name)) return { ok: false, line: "A name can't hold hidden characters." };
  return { ok: isName(name), line: '' };
}

/**
 * Settings' Wallet name row. wallet: the watch's last wallet answer (null: none yet, or the server can't be read
 * now); saved: a name this screen just saved, shown until a wallet answer says it.
 */
export function walletNameRow(wallet: { name?: string } | null, saved: string | null): { line: string; off: boolean } {
  if (wallet && wallet.name === undefined) return { line: 'Needs a server update', off: true };
  const name = saved ?? wallet?.name ?? null;
  if (name === null) return { line: 'Checking…', off: true };
  return { line: name || 'Not named yet', off: wallet === null };
}

/** The wallets asked their name in this run of the app, by host: the ask is once per start. */
export const askedThisRun = new Set<string>();

/** Whether to ask the wallet on host its name now: it has none (a server with names that answered ''), and it wasn't asked in this run. */
export const nameAskDue = (wallet: { name?: string } | null, host: string, asked: ReadonlySet<string>): boolean =>
  wallet?.name === '' && !asked.has(host);
