// Refunding a till sale from its page, in steps on one screen: Which
// amount (only when there is a choice), To (only when the sale has no return address, or the card's can't take it:
// the customer's invoice or Lightning address, pasted, typed or scanned), then Check and the screen lock. The whole
// sale, once: cardd checks the amount, the account and that it isn't refunded already. money/refund.ts has the rules.
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { CarddError, type TxDetail, type Wallet } from '../cardd/client';
import { parseDestination } from '../money/destination';
import { availableMsat, moneyError } from '../money/format';
import { refundChoices, refundFrom, returnAddressTo } from '../money/refund';
import { requestId } from '../money/requests';
import { scanSlot } from '../money/scanSlot';
import { feeEstimateSat, followSend } from '../money/send';
import type { ReadRow } from '../money/steps';
import { aboutText, confirmView, viewText } from '../money/view';
import { localTime } from '../money/words';
import { fiatText } from '../money/fiat';
import { useCardDeps } from '../services/server';
import { useRouteGuard } from '../services/services';
import { useAmountView } from '../ui/amountView';
import { screenLock } from '../ui/lock';
import { ReadBack } from '../ui/money';
import { Body, Button, ErrorText, Field, goBack, Label, Panel, Row, Screen } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';

type Step = 'amount' | 'to' | 'check';
/** Refusals about the wallet, not the card's return address: these stay on Check whatever the destination. */
const WALLETS_OWN = new Set(['not_paid', 'payment_in_progress', 'insufficient', 'paused', 'request_in_progress', 'request_mismatch', 'wrong_amount', 'malformed', 'internal']);
type Phase = { at: 'steps' } | { at: 'sending' } | { at: 'done'; text: string };

export default function Refund() {
  const allowed = useRouteGuard('/refund');
  const deps = useCardDeps();
  const params = useLocalSearchParams<{ account?: string; tx?: string }>();
  const account = params.account ?? 'shop';
  const txId = Number(params.tx);
  const look = useAmountView();
  const cv = confirmView(look.view);
  const r = look.rated;
  const [line, setLine] = useState<TxDetail | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  // The balances couldn't be read: Check says why, with Try again.
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoiceNow] = useState(0);
  // cardd's own figure, after a wrong_amount: Check shows it, and it is what the next press sends, until the owner
  // picks an amount again.
  const [figure, setFigure] = useState<number | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [raw, setRawNow] = useState('');
  // The customer's invoice or offer is for another amount (other_amount): said at To until it is changed.
  const [toRefusal, setToRefusal] = useState<string | null>(null);
  const setRaw = (t: string) => {
    setRawNow(t);
    setToRefusal(null);
  };
  const setChoice = (i: number) => {
    setChoiceNow(i);
    setFigure(null);
    setError(null);
  };
  // The card's return address couldn't take it: the reason, and from then on the refund goes to what is typed.
  const [fellBack, setFellBack] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: 'steps' });
  const sending = useRef(false);

  const readWallet = useCallback(() => {
    if (!deps) return;
    setWalletError(null);
    deps.cardd.wallet().then(setWallet, (e) => {
      setWallet(null);
      setWalletError(moneyError(e));
    });
  }, [deps]);

  useFocusEffect(
    useCallback(() => {
      const scanned = scanSlot.take();
      if (scanned) {
        setRawNow(scanned.trim());
        setToRefusal(null);
      }
      if (!deps || !(Number.isInteger(txId) && txId > 0)) return;
      deps.cardd.transaction(account, txId).then(setLine, (e) => setLoadError(moneyError(e)));
      readWallet();
    }, [deps, account, txId, readWallet]),
  );

  const stepBack = (): boolean => {
    if (phase.at !== 'steps' || !step) return false;
    const choices = line?.sale ? refundChoices(line.sale, r) : [];
    const needsTo = !line?.sale?.returnAddress || fellBack !== null;
    const prev: Step | null = step === 'check' ? (needsTo ? 'to' : choices.length > 1 ? 'amount' : null) : step === 'to' ? (choices.length > 1 ? 'amount' : null) : null;
    if (!prev) return false;
    setError(null);
    // Back at the amount, the owner picks again: cardd's figure from a wrong_amount no longer holds.
    if (prev === 'amount') setFigure(null);
    setStep(prev);
    return true;
  };
  useAndroidBack(stepBack);
  const back = () => {
    if (!stepBack()) goBack();
  };

  if (!allowed || !deps) return <Screen busy />;
  const sale = line?.sale;
  if (!sale) {
    return (
      <Screen title="Refund" back>
        {loadError ? <ErrorText>{loadError}</ErrorText> : <Body muted>Reading the sale…</Body>}
      </Screen>
    );
  }

  const choices = refundChoices(sale, r);
  const picked = choices[Math.min(choice, choices.length - 1)];
  const msat = figure ?? picked.msat;
  const ra = sale.returnAddress;
  const toCard = !!ra && 'card' in ra && fellBack === null;
  const needsTo = !ra || fellBack !== null;
  const first: Step = choices.length > 1 ? 'amount' : needsTo ? 'to' : 'check';
  const at: Step = step ?? first;
  const shop = wallet?.shop ? availableMsat(wallet.shop) : null;
  const pool = wallet ? availableMsat(wallet.pool) : null;
  const from = shop !== null && pool !== null ? refundFrom(shop, pool, msat, !toCard) : null;
  const soldAt = sale.paidAt ? localTime(sale.paidAt, Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset()) : null;
  const saleWhen = soldAt ? `${soldAt.date === localTime(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset()).date ? 'today' : soldAt.date} ${soldAt.time}` : '';
  const priceText = choices.length > 1 && choice === 0 && !figure ? picked.title : r && sale.price ? fiatText(msat, r) : '';

  // To: the customer's invoice or address, checked here for an invoice's amount (cardd checks again).
  const dest = raw && deps ? parseDestination(raw, deps.host) : null;
  const invoiceMsat = dest?.kind === 'invoice' ? dest.amountMsat : null;
  const toProblem =
    !raw ? null
    : dest?.kind === 'own' ? 'That is an account of this wallet: give the customer’s own invoice or address.'
    : dest?.kind === 'unsupported' ? "That can't be paid."
    : invoiceMsat !== null && invoiceMsat !== msat ? `This invoice is for ${viewText(invoiceMsat, 'sat', null)}; the refund is ${viewText(msat, 'sat', null)}.`
    : null;

  const title = `Refund ${viewText(msat, cv, r)}`;
  const toRow: ReadRow = ['To', needsTo ? raw : returnAddressTo(ra!)];
  const rows: ReadRow[] = [
    toRow,
    ['Amount', { msat }],
    ['Fee', toCard ? 'none' : aboutText(feeEstimateSat(msat) * 1000, cv, r)],
    ...(from && 'from' in from ? [['From', from.from === 'shop' ? 'Shop' : 'Pool'] as ReadRow] : []),
  ];

  const refund = async () => {
    if (!from || !('from' in from) || sending.current || (needsTo && (!raw || toProblem))) return;
    sending.current = true;
    setError(null);
    try {
      const why = await screenLock(title, 'sending out');
      if (why) return setError(why);
      setPhase({ at: 'sending' });
      const id = requestId();
      let out;
      try {
        // The note's time is the sale's clock: the phone's offset at the sale, not now (a refund after the clocks change).
        const offsetMin = -new Date((sale.paidAt ?? Math.floor(Date.now() / 1000)) * 1000).getTimezoneOffset();
        out = await deps.cardd.refund(sale.id, { id, amountMsat: msat, from: from.from, ...(needsTo ? { to: raw } : {}) }, offsetMin);
      } catch (e) {
        setPhase({ at: 'steps' });
        // Refunded already (another phone, or a press that got through): its page says so.
        if (e instanceof CarddError && e.code === 'already_refunded') return router.back();
        // The card's return address refused (its server down, or not taking this amount, or a card of this wallet
        // that can't take money now): there is always the scan. Refusals about the wallet itself stay on Check.
        if (!needsTo && !(e instanceof CarddError && WALLETS_OWN.has(e.code))) {
          setFellBack(moneyError(e).replace(/\.$/, ''));
          return setStep('to');
        }
        return setError(moneyError(e));
      }
      if (out.status === 'wrong_amount') {
        setPhase({ at: 'steps' });
        setFigure(out.amountMsat);
        setStep('check');
        return setError(`Your server's figure is ${viewText(out.amountMsat, cv, r)} now: check it and press again.`);
      }
      if (out.status === 'other_amount') {
        // The customer's invoice or offer is for another amount: back to To for one that fits.
        setPhase({ at: 'steps' });
        const want = viewText(msat, 'sat', null);
        setToRefusal(`The customer's ${out.of} is for ${viewText(out.amountMsat, 'sat', null)}; the refund is ${want}. Ask for one for ${want}, or for no amount.`);
        return setStep('to');
      }
      let status = out.status;
      let feeMsat = out.feeMsat ?? 0;
      let reason = out.reason;
      if (status === 'pending') {
        const w = await followSend(deps.cardd, id);
        status = w.kind === 'sent' ? 'sent' : w.kind === 'failed' ? 'failed' : 'pending';
        feeMsat = w.kind === 'sent' ? w.feeMsat : 0;
        reason = w.kind === 'failed' ? w.reason : undefined;
      }
      if (status === 'sent') {
        const price = priceText ? ` (${priceText})` : '';
        const fee = feeMsat ? ` Fee ${viewText(feeMsat, 'sat', null)}.` : '';
        return setPhase({ at: 'done', text: `Refunded ${viewText(msat, cv, r)}${price} for the sale of ${soldAt?.time ?? ''}.${fee}` });
      }
      if (status === 'pending') return setPhase({ at: 'done', text: 'Still on its way: the sale says Refunding… until it is paid.' });
      setPhase({ at: 'steps' });
      // The card's return address couldn't take it: on to the customer's invoice or address.
      if (!needsTo) {
        setFellBack(reason ?? 'it refused the payment');
        return setStep('to');
      }
      setError(reason ? `It wasn't sent: ${reason}.` : "It wasn't sent.");
    } finally {
      sending.current = false;
    }
  };

  const noAddress = !ra ? (sale.method === 'qr' ? 'This sale was paid from the QR, so it has no return address.' : "This card's server sent no return address.") : null;

  return (
    <Screen title="Refund" back={back}>
      {phase.at === 'steps' && at === 'amount' && (
        <>
          <Body>{`How much to give back for the sale of ${saleWhen}${sale.price ? `, priced ${choices[0].title}` : ''}?`}</Body>
          {choices.map((c, i) => (
            <Panel key={c.title}>
              <Button title={c.title} kind={i === choice ? 'primary' : 'secondary'} onPress={() => setChoice(i)} />
              {c.line !== '' && <Body muted>{c.line}</Body>}
            </Panel>
          ))}
          <Button title="Next" onPress={() => setStep(needsTo ? 'to' : 'check')} />
          <Body muted>Always the whole sale.</Body>
        </>
      )}
      {phase.at === 'steps' && at === 'to' && (
        <>
          {fellBack !== null ? <ErrorText>{`The card's return address couldn't take it: ${fellBack}.`}</ErrorText> : noAddress && <Body>{`${noAddress} Scan the customer's invoice or Lightning address.`}</Body>}
          {fellBack !== null && <Body>Scan the customer&apos;s invoice or Lightning address.</Body>}
          <Body muted>{`An invoice must be for ${viewText(msat, 'sat', null)}, or for no amount.`}</Body>
          <Label>To</Label>
          <Field value={raw} onChangeText={(t) => setRaw(t.trim())} placeholder="Invoice or Lightning address" autoCapitalize="none" autoCorrect={false} />
          <Row>
            <Button title="Paste" kind="secondary" onPress={() => Clipboard.getStringAsync().then((t) => setRaw(t.trim()))} />
            <Button title="Scan QR" kind="secondary" onPress={() => router.push('/scan')} />
          </Row>
          {toProblem && <ErrorText>{toProblem}</ErrorText>}
          {!toProblem && toRefusal && <ErrorText>{toRefusal}</ErrorText>}
          <Button title="Next" disabled={!raw || toProblem !== null} onPress={() => setStep('check')} />
        </>
      )}
      {phase.at === 'steps' && at === 'check' && (
        <>
          <Body>{`${priceText || viewText(msat, cv, r)} back for the sale of ${saleWhen}`}</Body>
          <ReadBack rows={rows} force={cv} />
          {!wallet && !walletError && <Body muted>Reading your balances…</Body>}
          {walletError && (
            <>
              <ErrorText>{walletError}</ErrorText>
              <Button title="Try again" kind="secondary" onPress={readWallet} />
            </>
          )}
          {from && 'from' in from && from.warning && <Panel tone="warn"><Body>{from.warning}</Body></Panel>}
          {from && 'short' in from && <ErrorText>{from.short}</ErrorText>}
          <Button title={title} disabled={!from || !('from' in from)} onPress={refund} />
          {error && <ErrorText>{error}</ErrorText>}
          <Body muted>Your fingerprint or screen lock first, as for every payment out.</Body>
        </>
      )}
      {phase.at === 'sending' && <Body>Refunding… keep this screen open.</Body>}
      {phase.at === 'done' && (
        <>
          <Body>{phase.text}</Body>
          <Button title="Done" onPress={goBack} />
        </>
      )}
    </Screen>
  );
}
