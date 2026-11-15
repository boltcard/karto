// Keeping the VM paid, the app's side: the
// sync from LNVPS to cardd, what the Hosting screen says, the warnings on the
// server page, Renew now's amount, and Pay LNVPS from any wallet's invoice.
import { CarddError, type CarddClient, type HostingStatus, type HostingSync } from '../cardd/client';
import { bolt11ExpiresAtMs } from '../lightning/lightning';
import { vatGuard, type LnvpsClient } from '../lnvps/client';
import type { Rated } from './fiat';
import { msatText, shortDate } from './format';
import { feeBudgetMsat } from './send';
import { apartText, feeViewText, viewText, type View } from './view';

const DAY = 86400;

/** What a sync knew: LNVPS's own expiry (unix seconds) if LNVPS answered, and cardd's estimate if cardd did. */
export type HostingSnapshot = { lnvpsExpires: number | null; status: HostingStatus | null };

/**
 * A day's price from LNVPS's renewal quote, or, when LNVPS refuses to quote
 * (it won't once the VM is paid over 365 days ahead, though its Lightning
 * address still takes payments), the price cardd last had.
 */
async function priceOfADay(lnvps: Pick<LnvpsClient, 'satPerDay'>, vmId: number, cardd: Pick<CarddClient, 'hosting'>): Promise<number> {
  try {
    return await lnvps.satPerDay(vmId);
  } catch (e) {
    const s = await cardd.hosting().catch(() => null);
    if (!s?.synced) throw e;
    return s.msatPerDay / 1000;
  }
}

/** The VM's expiry, a day's price and the VAT guard, as LNVPS says now (the price may be cardd's: see priceOfADay). */
export async function readLnvps(
  lnvps: Pick<LnvpsClient, 'getVm' | 'satPerDay' | 'getAccount'>,
  vmId: number,
  cardd: Pick<CarddClient, 'hosting'>,
): Promise<HostingSync> {
  const [vm, account] = await Promise.all([lnvps.getVm(vmId), lnvps.getAccount()]);
  const expiresMs = Date.parse(vm.expires ?? '');
  if (!Number.isFinite(expiresMs)) throw new Error(`LNVPS has no expiry for VM ${vmId}`);
  return { expires: Math.floor(expiresMs / 1000), satPerDay: await priceOfADay(lnvps, vmId, cardd), vatOk: vatGuard(account).ok };
}

/**
 * Reads LNVPS with the Nostr key and sends it to cardd (PUT /hosting). If
 * LNVPS can't be reached it skips quietly; if cardd can't, LNVPS's expiry is
 * still there for the screen.
 */
export async function syncHosting(
  deps: { lnvps: Pick<LnvpsClient, 'getVm' | 'satPerDay' | 'getAccount'>; cardd: Pick<CarddClient, 'syncHosting' | 'hosting'> },
  vmId: number,
  utcOffsetMin = -new Date().getTimezoneOffset(),
): Promise<HostingSnapshot> {
  let read: HostingSync;
  try {
    read = await readLnvps(deps.lnvps, vmId, deps.cardd);
  } catch {
    return { lnvpsExpires: null, status: null };
  }
  // The phone's offset from UTC sets hosting's daily alert at 09:00 here. A cardd before it refuses a field it
  // doesn't know (400 malformed): the sync goes again without it, until Update server.
  const status = await deps.cardd
    .syncHosting({ ...read, utcOffsetMin })
    .catch((e) => (e instanceof CarddError && e.status === 400 && e.code === 'malformed' ? deps.cardd.syncHosting(read) : Promise.reject(e)))
    .catch(() => null);
  return { lnvpsExpires: read.expires, status };
}

/** The app syncs on a cold start and back in the foreground 10 minutes or more after the last sync. */
export const SYNC_EVERY_MS = 10 * 60_000;

/**
 * After a payment to LNVPS, a forced sync every 10 seconds until LNVPS's date
 * moves, for up to 3 minutes: LNVPS has taken over 20 s to credit a payment
 * from another wallet.
 */
export const SYNC_AFTER_PAYMENT = { everyMs: 10_000, forMs: 180_000 } as const;

/** Finishing onboarding or a rebuild waits this long at most for a sync before the server page shows. */
export const DONE_SYNC_MS = 15_000;

/**
 * When to sync, and LNVPS's expiry from the last sync that reached it, for
 * every screen. The 10 minutes count from a sync that reached LNVPS, so one
 * made offline is tried again at the next open. The expiry is one VM's: a
 * sync for another VM (a rebuild's new server) forgets it at once and is due
 * (the real run showed the test VM's date on 1009 until a cold start).
 */
export class HostingSyncer {
  private last: number | null = null;
  private running = false;
  private vmId: number | null = null;
  lnvpsExpires: number | null = null;

  /** Runs the sync for vmId if it is due (or forced) and none is running; null if it didn't run. */
  async maybe(nowMs: number, vmId: number, run: () => Promise<HostingSnapshot>, o: { force?: boolean } = {}): Promise<HostingSnapshot | null> {
    // Before anything is awaited: no screen may show another VM's expiry.
    if (vmId !== this.vmId) {
      this.vmId = vmId;
      this.lnvpsExpires = null;
      this.last = null;
    }
    if (this.running || (!o.force && this.last !== null && nowMs - this.last < SYNC_EVERY_MS)) return null;
    this.running = true;
    try {
      const snap = await run();
      // An answer for a VM the screens have moved on from is dropped.
      if (snap.lnvpsExpires !== null && this.vmId === vmId) {
        this.lnvpsExpires = snap.lnvpsExpires;
        this.last = nowMs;
      }
      return snap;
    } finally {
      this.running = false;
    }
  }

  /**
   * After a payment to LNVPS: `sync` (a forced sync, giving LNVPS's expiry or
   * null) every 10 seconds until LNVPS's expiry is later than `before` (or,
   * with `before` unknown, until LNVPS gives one), for up to 3 minutes.
   * Whether it moved.
   */
  async afterPayment(
    sync: () => Promise<number | null>,
    o: { before: number | null; sleep?: (ms: number) => Promise<void> },
  ): Promise<boolean> {
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; waited < SYNC_AFTER_PAYMENT.forMs; ) {
      await sleep(SYNC_AFTER_PAYMENT.everyMs);
      waited += SYNC_AFTER_PAYMENT.everyMs;
      const expires = await sync().catch(() => null);
      if (expires !== null && (o.before === null || expires > o.before)) return true;
    }
    return false;
  }
}

/** The one syncer, for as long as the app runs: a cold start begins with a sync. */
export const hostingSyncer = new HostingSyncer();

export type PaidUntil = { expires: number; days: number; estimated: boolean };

/**
 * The VM's paid-until date: cardd's estimate (estimated once its last sync is
 * over 7 days old), or, while cardd can't be reached, LNVPS's own expiry.
 */
export function paidUntil(status: HostingStatus | null, lnvpsExpires: number | null, nowS: number): PaidUntil | null {
  if (status?.synced) return { expires: status.expires, days: (status.expires - nowS) / DAY, estimated: nowS - status.syncedAt > 7 * DAY };
  if (lnvpsExpires !== null) return { expires: lnvpsExpires, days: (lnvpsExpires - nowS) / DAY, estimated: false };
  return null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Hosting covers about 58 more days after that": what hosting's available balance pays for. */
export const coversText = (s: HostingStatus) => `Hosting covers about ${plural(Math.floor(s.fundingDays), 'more day')} after that`;

/**
 * banner: the wallet's paid-until banner. Amber with 3 days or more left, red under 3 (it was
 * red from 7 days down, which a new server, paid for 7 days, met at once). forFunding: it speaks for the funding line
 * too, so the wallet shows one banner, not two. fundingTone: the funding line's own colour: amber, red under 7 days of
 * funding.
 */
export type HostingWarnings = {
  funding: string | null; fundingTone: 'red' | 'amber'; vat: string | null;
  banner: { text: string; tone: 'red' | 'amber'; forFunding: boolean } | null;
};

/** The paid-until banner turns red with fewer days than this left. */
const PAID_RED_DAYS = 3;

/**
 * Hosting's funding line shows with a runway of fewer days than this (from 60 days it asked for a
 * top-up with 36 days in hosting), amber, and red under FUNDING_RED_DAYS, when cardd also alerts once a day. The
 * runway is Hosting's days plus the days paid beyond the 7 the daily renewal keeps (a VM paid to 17 Nov with 8
 * days in Hosting said "Hosting covers about 8 days").
 */
const FUNDING_LOW_DAYS = 14;
const FUNDING_RED_DAYS = 7;
/** The days the daily renewal keeps the VM paid ahead (cardd's renew.RenewTo). */
const RENEW_TO_DAYS = 7;

/**
 * The server page's warnings: under 14 days of runway, Hosting's days plus the days paid beyond 7 (on the Hosting
 * row);
 * LNVPS charging VAT; and the wallet's banner, under 7 days of VM time when
 * cardd says it won't renew it, or, without cardd's status, under 3 days (the
 * VM is kept at about 7 days, so a blip mustn't warn). When Hosting being low is why it won't renew (funding under 14 days
 * and no VAT stop), the banner says what to do about both in one sentence.
 */
export function hostingWarnings(status: HostingStatus | null, lnvpsExpires: number | null, nowS: number, offsetMin = -new Date().getTimezoneOffset()): HostingWarnings {
  const synced = status?.synced ? status : null;
  const p = paidUntil(status, lnvpsExpires, nowS);
  const runway = synced && p ? synced.fundingDays + Math.max(0, p.days - RENEW_TO_DAYS) : null;
  const funding =
    synced && runway !== null && runway < FUNDING_LOW_DAYS
      ? `Hosting covers about ${plural(Math.floor(synced.fundingDays), 'more day')} after ${shortDate(synced.expires, nowS, offsetMin)}: top it up or move from Pool`
      : null;
  const vat =
    synced && !synced.vatOk
      ? 'Automatic renewal is stopped: LNVPS now charges you VAT. Renew by hand (you will pay the VAT), or check your LNVPS account.'
      : null;
  const fundingTone = runway !== null && runway < FUNDING_RED_DAYS ? 'red' : 'amber';
  // The VM is kept at about 7 days: without cardd's status (a blip, an update) only a close date says so.
  const due = p && (synced ? p.days < RENEW_TO_DAYS && !synced.willRenew : p.days < PAID_RED_DAYS);
  return { funding, fundingTone, vat, banner: p && due ? paidBanner(p, funding !== null && vat === null, nowS, offsetMin) : null };
}

function paidBanner(p: PaidUntil, forFunding: boolean, nowS: number, offsetMin: number): NonNullable<HostingWarnings['banner']> {
  const date = shortDate(p.expires, nowS, offsetMin);
  const tone = p.days < PAID_RED_DAYS ? 'red' : 'amber';
  if (!forFunding) return { text: `Your server is paid only until ${date}`, tone, forFunding };
  const text =
    tone === 'red'
      ? `Your server is paid only until ${date}. Top up Hosting, or pay LNVPS from any wallet.`
      : `Your server is paid until ${date}. Top up Hosting and it renews itself.`;
  return { text, tone, forFunding };
}

export const RENEW_PRESETS = [1, 7, 30] as const;
export const MAX_RENEW_DAYS = 365;

/** Days typed for Renew now: a whole number from 1 to 365, or null. */
export function renewDays(text: string): number | null {
  const t = text.trim();
  return /^[0-9]+$/.test(t) && Number(t) >= 1 && Number(t) <= MAX_RENEW_DAYS ? Number(t) : null;
}

/** What Renew now pays for days: days × the price of a day, rounded up to a whole sat, as cardd does. */
export const renewSat = (days: number, msatPerDay: number) => Math.ceil((days * msatPerDay) / 1000);

export const daysText = (d: number) => `${d} ${d === 1 ? 'day' : 'days'}`;

/** Renew now's result: what was paid, for how long, and the fee, in the view Renew shows (confirmView's). */
export const renewedText = (amountMsat: number, days: number, feeMsat: number, v: View = 'sat', r: Rated | null = null) =>
  `Renewed: ${viewText(amountMsat, v, r)} for ${daysText(days)} (${feeViewText(feeMsat, v, r)}).`;

/** Why hosting can't pay sat now, or null: the amount and its fee budget must fit what is available. */
export function renewProblem(hostingAvailableMsat: number, sat: number, v: View = 'sat', r: Rated | null = null): string | null {
  const need = sat * 1000 + feeBudgetMsat(sat * 1000);
  if (need <= hostingAvailableMsat) return null;
  const [has, needs] = apartText(hostingAvailableMsat, need, v, r);
  return `Hosting has ${has}; this needs up to ${needs} with routing fees.`;
}

/** Pay LNVPS from any wallet's choices of days. */
export const PAY_PRESETS = [7, 14, 30] as const;
/** LNVPS's smallest renewal through the Lightning address. */
const MIN_SAT = 100;

/** What days of the VM cost at a price of a day (sat): whole sats, at least LNVPS's smallest renewal. */
export const lnvpsSat = (days: number, satPerDay: number): number => Math.max(MIN_SAT, Math.ceil(days * satPerDay));

/** The VM's price of a day (sat), from LNVPS's quote, or cardd's if LNVPS won't quote it (see priceOfADay). */
export const lnvpsDayPrice = priceOfADay;

export type LnvpsInvoice = { sat: number; days: number; bolt11: string; expiresAt: number };

/** LNVPS's own invoice for days of the VM at a price of a day already asked for: one request to LNVPS's Lightning address. */
export async function lnvpsInvoiceAt(
  lnvps: Pick<LnvpsClient, 'vmInvoice'>,
  vmId: number,
  days: number,
  satPerDay: number,
  nowMs: number,
): Promise<LnvpsInvoice> {
  const sat = lnvpsSat(days, satPerDay);
  const bolt11 = await lnvps.vmInvoice(vmId, sat);
  return { sat, days, bolt11, expiresAt: bolt11ExpiresAtMs(bolt11) ?? nowMs + 600_000 };
}

/**
 * LNVPS's own invoice for days of the VM, through its Lightning address, the
 * way onboarding's pay step makes one: it needs nothing from cardd, unless
 * LNVPS refuses to quote (a VM paid over 365 days ahead), when the price is
 * cardd's.
 */
export async function lnvpsInvoice(
  lnvps: Pick<LnvpsClient, 'satPerDay' | 'vmInvoice'>,
  vmId: number,
  days: number,
  nowMs: number,
  cardd: Pick<CarddClient, 'hosting'>,
): Promise<LnvpsInvoice> {
  return lnvpsInvoiceAt(lnvps, vmId, days, await priceOfADay(lnvps, vmId, cardd), nowMs);
}
