// The shop in Karto Wallet: the wallet's wide Shop tile, and the
// line on Shop's page that says beforehand why some sales will read +0. The screens draw these; the words are
// decided here.
import type { SaleDay, Wallet } from '../cardd/client';
import type { Rated } from '../money/fiat';
import { availableMsat, dayStart, thousands } from '../money/format';
import { viewText, type View } from '../money/view';

/** Under this much room, in sat, Shop's page says the channel is nearly full. */
const NEARLY_FULL_SAT = 100_000;

/** Whether the wallet has anything of a shop to show: a PoS phone, a balance or a past sale. */
export function hasShop(wallet: Wallet | null): boolean {
  const shop = wallet?.shop;
  return !!shop && (shop.phones > 0 || shop.balanceMsat > 0 || shop.sales > 0);
}

/** Today's paid sales: cardd's newest day (sales/days, limit 1), only when it is the phone's today. */
export const salesToday = (days: SaleDay[], nowS: number, offsetMin: number): number => (days[0]?.day === dayStart(nowS, offsetMin) ? days[0].count : 0);

/**
 * The Shop tile: what is available (msat; Home draws it in the view, null while the wallet can't be read), and "5 sales today" at its right (none with none, or when the count couldn't
 * be read: today null). Null with nothing of a shop, so a person with none sees the wallet as it is: no wallet yet,
 * an older server, or no PoS phone, balance or past sale. hadShop: this server's last wallet that
 * answered had a shop; while the wallet can't be read the tile then stays, with "…" for its figures, as Pool's does.
 */
export function shopTile(wallet: Wallet | null, today: number | null, hadShop = false): { balanceMsat: number | null; line: string } | null {
  if (!wallet) return hadShop ? { balanceMsat: null, line: '' } : null;
  const shop = wallet.shop;
  if (!shop || !hasShop(wallet)) return null;
  return { balanceMsat: availableMsat(shop), line: today ? `${today} ${today === 1 ? 'sale' : 'sales'} today` : '' };
}

/**
 * Why the next sales may reach Shop as less than their price, or nothing: phoenixd takes every payment, and one
 * that doesn't fit the channel goes toward a channel, or more room, in full (its fee credit) until those add up to
 * the price. Empty while the channel has room, and while phoenixd can't be asked.
 */
export function capacityLine(liquidity: Wallet['liquidity'], v: View = 'sat', r: Rated | null = null): string {
  if (!liquidity) return '';
  if (!liquidity.channel) {
    // phoenixd's estimate is at today's fees, so a floor; what is set aside already counts toward it.
    const left = liquidity.firstChannelFeeSat - liquidity.feeCreditSat;
    const price = left > 0 ? ` (at least ${viewText(left * 1000, v, r)})` : '';
    return `Your server has no channel yet. The first sales go toward it, in full, until they add up to its price${price}, and the sale that completes it pays the rest.`;
  }
  if (liquidity.inboundSat >= NEARLY_FULL_SAT) return '';
  return (
    `Your server's channel is nearly full: about ${viewText(liquidity.inboundSat * 1000, v, r)} more fits. ` +
    'After that the next sales go toward more room, in full, until they add up to its price (about 20,000 sat and a mining fee), and the sale that completes it pays the rest.'
  );
}
