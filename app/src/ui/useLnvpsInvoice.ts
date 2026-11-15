// Pay LNVPS's invoice for the days chosen (as setup's pay step does): LNVPS allows about five
// invoices a minute for a VM, so a press of a day button shows what the days cost at once, at the price of a day
// already asked for, and the invoice is asked for once the presses stop. An answer for days no longer chosen is
// dropped, and a 429 is a minute's wait said in plain words, not an error.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CarddClient } from '../cardd/client';
import { LnurlHttpError } from '../lightning/lightning';
import { LnvpsError, type LnvpsClient } from '../lnvps/client';
import { lnvpsDayPrice, lnvpsInvoiceAt, lnvpsSat, type LnvpsInvoice } from '../money/hosting';
import { INVOICE_BUSY_WAIT_MS, PAY_DAYS_SETTLE_MS } from '../onboarding/machine';

/** What the screen asks LNVPS with, or null when this phone has no server set up. */
export type LnvpsConnection = {
  lnvps: Pick<LnvpsClient, 'satPerDay' | 'vmInvoice'>;
  vmId: number;
  cardd: Pick<CarddClient, 'hosting'>;
} | null;

export type LnvpsInvoiceView = {
  /** What the days chosen cost, once a price of a day is known: shown before their invoice comes. */
  sat: number | null;
  /** The invoice for the days chosen now, never for days chosen before. */
  invoice: LnvpsInvoice | null;
  error: string | null;
  /** LNVPS answered 429: the invoice is asked for again by itself when its minute is up. */
  busy: boolean;
  /** Try again after an error: at once, at the price of a day kept. */
  retry: () => void;
  /** A new invoice for one that ran out: the price of a day is asked again too. */
  renew: () => void;
};

export const NO_SERVER = 'This phone has no server set up.';
export const LNVPS_BUSY = 'LNVPS is busy. Asking for the invoice again in a minute…';

const isBusy = (e: unknown) => (e instanceof LnurlHttpError || e instanceof LnvpsError) && e.status === 429;

/** connect is null until the screen may ask (its route guard); it must keep its identity between renders. */
export function useLnvpsInvoice(days: number, connect: (() => Promise<LnvpsConnection>) | null): LnvpsInvoiceView {
  const [price, setPrice] = useState<number | null>(null);
  const [invoice, setInvoice] = useState<LnvpsInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to ask again for the same days: Try again, New invoice, and when a 429's minute is up.
  const [attempt, setAttempt] = useState(0);
  // One question for the price of a day, shared by every run while it is out (a press during it asks no second).
  const priceAsk = useRef<Promise<number> | null>(null);
  const busyUntil = useRef(0);
  // The first invoice, and one asked for by a button, go at once; one after a day press waits for the presses to stop.
  const atOnce = useRef(true);
  const asking = useRef(0);

  useEffect(() => {
    // A run's answer counts only while it is the latest: one from before the route guard turned off doesn't.
    const mine = ++asking.current;
    if (!connect) return;
    setInvoice(null);
    setError(null);
    const settle = atOnce.current ? 0 : PAY_DAYS_SETTLE_MS;
    atOnce.current = false;
    const t = setTimeout(async () => {
      const current = () => mine === asking.current;
      // An earlier run's 429 that came after this run was set: wait out its minute too.
      if (Date.now() < busyUntil.current) {
        setBusy(true);
        return setAttempt((a) => a + 1);
      }
      try {
        const c = await connect();
        if (!current()) return;
        if (!c) {
          setBusy(false);
          return setError(NO_SERVER);
        }
        const ask = (priceAsk.current ??= lnvpsDayPrice(c.lnvps, c.vmId, c.cardd).catch((e: unknown) => {
          priceAsk.current = null;
          throw e;
        }));
        const satPerDay = await ask;
        if (!current()) return;
        setPrice(satPerDay);
        const inv = await lnvpsInvoiceAt(c.lnvps, c.vmId, days, satPerDay, Date.now());
        if (!current()) return;
        setBusy(false);
        setInvoice(inv);
      } catch (e) {
        // LNVPS's limit is the VM's, whichever days the 429 answered.
        if (isBusy(e)) busyUntil.current = Date.now() + INVOICE_BUSY_WAIT_MS;
        if (!current()) return;
        if (isBusy(e)) {
          setBusy(true);
          setAttempt((a) => a + 1);
          return;
        }
        setBusy(false);
        setError(`Couldn't get an invoice from LNVPS: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, Math.max(settle, busyUntil.current - Date.now()));
    return () => clearTimeout(t);
  }, [connect, days, attempt]);

  const retry = useCallback(() => {
    atOnce.current = true;
    setAttempt((a) => a + 1);
  }, []);
  const renew = useCallback(() => {
    priceAsk.current = null;
    retry();
  }, [retry]);

  return { sat: price === null ? null : lnvpsSat(days, price), invoice, error, busy, retry, renew };
}
