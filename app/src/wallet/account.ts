// An account page's pill buttons: which each
// account has, and which are off while cardd can't be reached. A card's More is the band's ⋯. Shop
// has Move and PoS phones.
import type { CardState } from '../cardd/client';
import type { IconName } from '../ui/icons';

export type AccountAction = 'pay' | 'top-up' | 'move' | 'freeze' | 'unfreeze' | 'send' | 'pay-lnvps' | 'renew' | 'pos-phones';
/** main: the page's main act, drawn orange. off: greyed, a tap does nothing. */
export type AccountButton = { action: AccountAction; icon: IconName; label: string; main: boolean; off: boolean };
/** ownPhone: the card is this phone's own. nfcOff: the phone's NFC is off, so it can't be a card. */
export type AccountKind = { kind: 'card'; state: CardState; ownPhone?: boolean; nfcOff?: boolean } | { kind: 'pool' } | { kind: 'hosting' } | { kind: 'shop' };

const BUTTONS: Record<AccountAction, { icon: IconName; label: string }> = {
  pay: { icon: 'phone', label: 'Pay' },
  'top-up': { icon: 'topup', label: 'Top up' },
  move: { icon: 'move', label: 'Move' },
  freeze: { icon: 'freeze', label: 'Freeze' },
  unfreeze: { icon: 'unfreeze', label: 'Unfreeze' },
  send: { icon: 'send', label: 'Send out' },
  'pay-lnvps': { icon: 'pay', label: 'Pay LNVPS' },
  renew: { icon: 'renew', label: 'Renew now' },
  'pos-phones': { icon: 'phone', label: 'PoS phones' },
};

/** These need cardd: off while it can't be reached. Top up and Pay LNVPS stay on. */
const NEEDS_CARDD: readonly AccountAction[] = ['move', 'freeze', 'unfreeze', 'send', 'renew'];

/**
 * A card's Top up, Move and Freeze or Unfreeze (neither while it is being added or wiped: cardd refuses them);
 * pool's Top up, Move and Send out; hosting's Top up, Move, Pay LNVPS and Renew now; Shop's Move, its main one,
 * and PoS phones: its sales alone pay it, so it has no Top up.
 */
export function accountButtons(a: AccountKind, moneyOff: boolean): AccountButton[] {
  if (a.kind === 'shop') {
    return (['move', 'pos-phones'] as const).map((action) => ({ action, ...BUTTONS[action], main: action === 'move', off: moneyOff && NEEDS_CARDD.includes(action) }));
  }
  const own: AccountAction[] =
    a.kind === 'pool' ? ['send'] : a.kind === 'hosting' ? ['pay-lnvps', 'renew'] : a.state === 'frozen' ? ['unfreeze'] : a.state === 'active' ? ['freeze'] : [];
  // This phone's own card pays from its page too: Pay first, and the page's main act. A frozen one's Pay says so.
  const pays = a.kind === 'card' && !!a.ownPhone && (a.state === 'active' || a.state === 'frozen');
  const actions: AccountAction[] = [...(pays ? (['pay'] as const) : []), 'top-up', 'move', ...own];
  // Pay is off with NFC off, as Pay with this phone is on the Wallet page, which says why.
  const payOff = a.kind === 'card' && !!a.nfcOff;
  return actions.map((action) => ({ action, ...BUTTONS[action], main: action === (pays ? 'pay' : 'top-up'), off: action === 'pay' ? payOff : moneyOff && NEEDS_CARDD.includes(action) }));
}

/** An account id a karto:// link may name: pool, hosting, shop or a card's id; '' for anything else. */
export const accountId = (param: string | undefined): string => (/^(pool|hosting|shop|[0-9a-f]{32})$/.test(param ?? '') ? param! : '');

/** The name of an account that isn't a card; null for a card, which has its own. */
export const fixedName = (id: string): string | null => (id === 'pool' ? 'Pool' : id === 'hosting' ? 'Hosting' : id === 'shop' ? 'Shop' : null);
