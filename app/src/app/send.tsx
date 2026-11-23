// Send out of pool in three steps on one screen:
// To (an invoice, an address, a BOLT12 offer or an LNURL-pay link, pasted, typed or scanned; from schema 10 cardd
// looks all but an invoice up on leaving To), Amount (skipped for an invoice or an offer that carries one)
// and Check, then the screen lock; once per request id, kept through retries and app restarts. money/steps.ts decides
// the steps, the read-backs and where the outcome leads; this holds the state.
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { RecentTo, Wallet } from '../cardd/client';
import { parseDestination } from '../money/destination';
import { symbol, type Rated } from '../money/fiat';
import { availableMsat, moneyError, typedMsat } from '../money/format';
import { cutNote } from '../money/note';
import { requestId, runRequest } from '../money/requests';
import { scanSlot } from '../money/scanSlot';
import { feeBudgetMsat, followSend, sendAllMsat, sendProblem, watchSend } from '../money/send';
import {
  afterSend, afterWatch, destinationPanel, fixedAmount, linkAmountProblem, lookupText, needsLookup, noteWho, oldServerProblem, ownTarget, payableFrom, resultView, sendAllFor,
  sendAt, sendBack, sendNext, sendReadBack, sendToProblem, type Payable, type Ran, type Result, type Step, STEP_NAMES, stepAt,
} from '../money/steps';
import { useCardDeps, useServer } from '../services/server';
import { useRouteGuard } from '../services/services';
import { type View as Shown, viewText } from '../money/view';
import { useAmountView } from '../ui/amountView';
import { screenLock } from '../ui/lock';
import { RecentList } from '../ui/RecentList';
import { AmountField, FromLine, RateAgeLine, ReadBack, ResultPage, StepBar } from '../ui/money';
import { Body, Button, ErrorText, Field, goBack, Label, Panel, Row, Screen } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';

type Phase = { at: 'steps' } | { at: 'sending'; text: string } | { at: 'result'; result: Result };

export default function Send() {
  const allowed = useRouteGuard('/send');
  const deps = useCardDeps();
  const [raw, setRaw] = useState('');
  const [amount, setAmount] = useState('');
  // All: the amount is the most Pool can send to this destination (money/steps.ts sendAllFor), as Pool is last read.
  const [all, setAll] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  // Send out's Recent list: asked for on every focus, whatever the server's status says yet (an older cardd
  // answers 404, so none); shown from schema 13.
  const [recent, setRecent] = useState<RecentTo[]>([]);
  // The step last reached, and the destination's text it was reached with (money/steps.ts sendAt).
  const [reached, setReached] = useState<{ step: Step; raw: string }>({ step: 'to', raw: '' });
  const [phase, setPhase] = useState<Phase>({ at: 'steps' });
  // Why the last try came back to Check: a refused screen lock, or cardd's refusal.
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // The lookup's answer for the text it was asked with; again: a send refused since, so Next asks afresh
  // (a ₿ name's record may have changed). Its refusal is kept with the text it was for, and shows on To.
  const [looked, setLooked] = useState<{ raw: string; payable: Payable; again?: boolean } | null>(null);
  const [looking, setLooking] = useState(false);
  // A second press of Next before the screen draws again finds the lookup already asked (the state is a render late).
  const lookingNow = useRef(false);
  const [toError, setToError] = useState<{ raw: string; text: string } | null>(null);
  const { snap } = useServer();
  // An older cardd refuses the field with `malformed`, so it is offered from schema 8 only.
  const notes = snap.status?.kind === 'ok' && (snap.status.schema ?? 0) >= 8;
  // A cardd from schema 10 looks names, links and offers up before Amount; an older one can't pay offers or ₿ names.
  const canLookUp = snap.status?.kind === 'ok' && (snap.status.schema ?? 0) >= 10;
  const hasRecent = snap.status?.kind === 'ok' && (snap.status.schema ?? 0) >= 13;
  // Until cardd's status says which it is (not checked yet, or the server out of reach), a name, link or offer waits
  // at To with the reason: it is never told to update a server that may well be new.
  const serverWait =
    !snap.status ? 'Checking your server…'
    : snap.status.kind === 'unreachable' ? "Can't reach your server."
    : snap.status.kind === 'not_paired' ? "This phone isn't paired."
    : null;
  const sending = useRef(false);
  // The amount's unit, and what Next took from Amount: a price in
  // the currency becomes whole sats there, once; Check and the request carry those sats, so the rate can't move between them.
  const look = useAmountView();
  const { rated, typingUnit } = look;
  // Send out shows its amounts in the app's view, and in the chosen unit while it is *** (rule 5): here money is being confirmed.
  const cv = look.unit;
  const [taken, setTaken] = useState<number | null>(null);

  // The destination as it is now, for the focus effect, whose closure keeps the first render's.
  const rawNow = useRef(raw);
  rawNow.current = raw;
  useFocusEffect(
    useCallback(() => {
      // A scanned code fills the field and stays on To, as a paste does. The same code scanned again changes nothing:
      // the note given for it is kept, and Check stays where it was.
      const scanned = scanSlot.take();
      if (scanned && scanned.trim() !== rawNow.current.trim()) {
        setRaw(scanned);
        setAll(false);
        setNote('');
        setError(null);
      }
      deps?.cardd.wallet().then(setWallet, () => setWallet(null));
      deps?.cardd.recentSends().then(setRecent, () => setRecent([]));
    }, [deps]),
  );

  const dest = raw.trim() && deps ? parseDestination(raw, deps.host) : null;
  const nowMs = Date.now();
  // A name, link or offer: what the lookup is for, on a server that has it.
  const lookable = dest !== null && needsLookup(dest);
  const tooOld = serverWait ? null : oldServerProblem(dest, canLookUp);
  const next = tooOld ? null : sendNext(dest, nowMs);
  // The lookup's answer for this text: kept while the status is checked again, so Check isn't sent back to To.
  const answer = looked?.raw === raw ? looked.payable : null;
  // Why Next waits: the server's status, for a name, link or offer with no answer to go on (or one to look up again).
  const waiting = serverWait && lookable && (!answer || looked?.again) ? serverWait : null;
  // Something to pay: an invoice as it is, the lookup's answer for this text, else an older server's address or link as typed.
  const payable: Payable | null =
    !dest || !next ? null : !lookable ? (dest as Payable) : answer ?? (snap.status?.kind === 'ok' && !canLookUp ? (dest as Payable) : null);
  // A step past To needs something to pay, and the destination it was reached with: an invoice can expire while Check shows.
  const at: Step = sendAt(reached, raw, payable);
  const setStep = (step: Step) => setReached({ step, raw });
  // A new destination starts afresh: the last one's refusal isn't its own.
  const setDest = (text: string) => {
    setRaw(text);
    setAll(false);
    setNote('');
    setError(null);
  };
  // What is typed keeps its unit: the field empties itself when the unit changes under it (ui/money.tsx AmountField);
  // a change while Amount isn't showing (a rate going on Check) empties it here. Check keeps the sats Next took.
  const amountUnit = useRef(typingUnit);
  useEffect(() => {
    if (amountUnit.current === typingUnit) return;
    amountUnit.current = typingUnit;
    if (at !== 'amount') setAmount('');
  }, [typingUnit, at]);
  const fixed = payable ? fixedAmount(payable) : null;
  const available = wallet ? availableMsat(wallet.pool) : null;
  // A server that says what a Send out can take allows all of Pool but phoenixd's fee and 1 sat; an older one, the full budget.
  const sendable = wallet?.pool.sendableMsat;
  const tight = sendable !== undefined;
  const most = payable && available !== null ? sendAllFor(payable, sendable ?? sendAllMsat(available)) : null;
  const typed = all ? most?.msat || null : typedMsat(amount, typingUnit, rated);
  // All follows Pool, and goes off once there is none to follow: a wallet that can't be read, or a Pool that can send
  // nothing now. The field is then empty for an amount, not "All" over nothing.
  const allGone = all && !most?.msat;
  useEffect(() => {
    if (allGone) setAll(false);
  }, [allGone]);
  // What Pool holds as Amount shows, each time it does: Back to To and Next again doesn't keep All from the last read.
  useEffect(() => {
    if (at === 'amount') deps?.cardd.wallet().then(setWallet, () => {});
  }, [at, deps]);
  const amountMsat = fixed ?? (at === 'check' && taken !== null ? taken : typed);
  const unitWord = rated && typingUnit === 'fiat' ? symbol(rated.currency).trim() : 'sat';
  // Before the wallet answers, only the amount itself is checked: cardd checks it against pool. What the address
  // takes comes first: no amount outside it can be sent, whatever Pool holds (an empty field still says Enter an amount).
  const problem = payable
    ? (amountMsat ? linkAmountProblem(payable, amountMsat) : null) ?? sendProblem(available ?? Number.MAX_SAFE_INTEGER, amountMsat ?? 0, { typed: fixed === null, tight }, cv, rated)
    : null;

  // A step back; from To, and while sending or on the result, Back leaves the screen (the request goes on).
  const stepBack = (): boolean => {
    const to = phase.at === 'steps' ? sendBack(at, fixed !== null) : null;
    if (!to) return false;
    setError(null);
    setStep(to);
    return true;
  };
  useAndroidBack(stepBack);
  const back = () => {
    if (!stepBack()) goBack();
  };

  if (!allowed || !deps) return <Screen busy />;

  // Next from To: a name, link or offer is looked up first; its answer decides Amount or Check.
  const goNext = async () => {
    if (!dest || !next || waiting || lookingNow.current) return;
    setError(null);
    if (!lookable) return setStep(next);
    // Back at To with the same text (after Back): its answer is still here, unless a send was refused since.
    if (answer && !looked?.again) return setReached({ step: fixedAmount(answer) !== null ? 'check' : 'amount', raw });
    // An older server: an address or link goes as typed, as before the lookup (offers and ₿ names have no Next there).
    if (!canLookUp) return setStep(next);
    lookingNow.current = true;
    setLooking(true);
    setToError(null);
    const askedFor = raw;
    try {
      const p = payableFrom(await deps.cardd.lookup(lookupText(dest)));
      setLooked({ raw: askedFor, payable: p });
      // The step is for the text asked about: one typed since stays on To (money/steps.ts sendAt).
      setReached({ step: fixedAmount(p) !== null ? 'check' : 'amount', raw: askedFor });
    } catch (e) {
      // The answer from before is no longer this text's: it isn't shown above the refusal, nor paid.
      setLooked((l) => (l?.raw === askedFor ? null : l));
      setToError({ raw: askedFor, text: moneyError(e) });
    } finally {
      lookingNow.current = false;
      setLooking(false);
    }
  };

  // Check's button, and the screen lock's prompt: the lock confirms the figure the person saw.
  const sendTitle = `Send ${viewText(amountMsat ?? 0, cv, rated)}`;
  const send = async () => {
    if (!payable || problem || !amountMsat || sending.current) return;
    sending.current = true;
    setError(null);
    try {
      const why = await screenLock(sendTitle, 'sending out');
      if (why) return setError(why);
      setPhase({ at: 'sending', text: 'Sending… keep this screen open.' });
      // cardd refuses over 200 characters (bad_note) and that spends the request id: cut by code points again, as the field does.
      const comment = notes ? cutNote(note.trim()).trim() : '';
      // A new id for each press: a refused send has spent its own. An offer carries the ₿ name it was looked up by.
      const id = requestId();
      // A looked-up destination's server follows a send by its id (schema 10), whatever its status says by the time it is pending.
      const byId = canLookUp || payable === answer;
      const out: Ran = await runRequest(
        { cardd: deps.cardd, store: deps.cache },
        {
          kind: 'send', id, to: payable.to, ...(payable.kind === 'offer' && payable.name ? { name: payable.name } : {}), amountMsat,
          ...(comment ? { comment } : {}), started: Date.now(),
        },
      ).catch((e) => ({ at: 'failed' as const, e }));
      const after = afterSend(out, payable);
      if (after.at === 'check') {
        setPhase({ at: 'steps' });
        setError(after.error);
        // The refusal may be the destination's (a ₿ name's record changed since): Next from To looks it up again.
        setLooked((l) => l && { ...l, again: true });
        // Back at Check after a refusal: what Pool holds may be why, so it is read again (the last stands if that fails).
        deps.cardd.wallet().then(setWallet, () => {});
        return;
      }
      if (after.at === 'result') return setPhase(after);
      setPhase({ at: 'sending', text: 'Still on its way…' });
      // From schema 10 the send is followed by its request id: an offer's pending send has no hash to watch for.
      const w = byId ? await followSend(deps.cardd, id) : await watchSend(deps.cardd, after.answer.paymentHash);
      setPhase({ at: 'result', result: afterWatch(w, after.answer, payable) });
    } finally {
      sending.current = false;
    }
  };

  const toProblem = sendToProblem(dest, nowMs);
  // The lookup's refusal, for the text still in the field.
  const refusal = toError?.raw === raw ? toError.text : null;
  const target = dest?.kind === 'own' ? ownTarget(dest, wallet) : null;
  // On To, a looked-up answer to be looked up again (or being looked up) isn't shown as where the money goes.
  const stale = at === 'to' && payable !== null && payable === answer && (looked?.again || looking);
  const where = payable && !stale ? destinationPanel(payable) : null;
  const whereTo = where && (
    <Panel>
      <Label>{where.label}</Label>
      {where.value !== '' && <Body>{where.value}</Body>}
      {at === 'to' && fixed !== null && <Body>{viewText(fixed, cv, rated)}</Body>}
    </Panel>
  );

  return (
    <Screen title="Send out" back={back}>
      {phase.at === 'steps' && <StepBar names={STEP_NAMES} at={stepAt(at)} />}
      {phase.at === 'steps' && at === 'to' && (
        <>
          <FromLine label="From Pool" figure={available === null ? '…' : `${viewText(available, cv, rated)} available`} />
          <Label>To</Label>
          <Field value={raw} onChangeText={setDest} placeholder="Invoice, address, offer or link" autoCapitalize="none" autoCorrect={false} />
          <Row>
            <Button title="Paste" kind="secondary" onPress={() => Clipboard.getStringAsync().then(setDest)} />
            <Button title="Scan QR" kind="secondary" onPress={() => router.push('/scan')} />
          </Row>
          {whereTo}
          {(toProblem || tooOld || refusal) && <ErrorText>{toProblem ?? tooOld ?? refusal}</ErrorText>}
          {dest?.kind === 'own' && (
            <Panel>
              <Body>That is {dest.address}, an account on this server: moving to it is free.</Body>
              {target && <Button title="Move to it instead" onPress={() => router.replace({ pathname: '/move', params: { from: 'pool', to: target } })} />}
            </Panel>
          )}
          {!dest && <Body muted>Paste, type or scan where to send it.</Body>}
          {hasRecent && deps && raw.trim() === '' && (
            <RecentList
              items={recent.filter((i) => parseDestination(i.to, deps.host).kind !== 'own')}
              nowS={Math.floor(nowMs / 1000)}
              offsetMin={-new Date().getTimezoneOffset()}
              onPick={setDest}
              // Dropped here once the server agrees, so the list drawn again (after the field is typed in) keeps it off.
              onRemove={(to) => deps.cardd.removeRecent(to).then(() => setRecent((r) => r.filter((i) => i.to !== to)))}
            />
          )}
          {next && <Button title="Next" disabled={looking || waiting !== null} onPress={goNext} />}
          {looking && <Body muted>Looking up…</Body>}
          {waiting && <Body muted>{waiting}</Body>}
        </>
      )}
      {phase.at === 'steps' && at === 'amount' && (
        <>
          {whereTo}
          <Label>{`How much (${unitWord})`}</Label>
          <Row>
            <View style={layout.grow}>
              <AmountField
                value={all ? '' : amount}
                placeholder={all && most ? 'All' : `Amount in ${unitWord}`}
                onChangeText={(t) => (setAll(false), setAmount(t))}
                autoFocus
              />
            </View>
            {available !== null && (
              <Button
                title="All"
                kind="secondary"
                disabled={!most?.msat}
                onPress={() => {
                  setAll(true);
                  setAmount('');
                  // What Pool holds now, not when the screen last read it.
                  deps?.cardd.wallet().then(setWallet, () => {});
                }}
              />
            )}
          </Row>
          {available !== null && <Body muted>{`${viewText(available, cv, rated)} available in Pool.`}</Body>}
          {all && most && <Body>{allText(most, payable, cv, rated)}</Body>}
          {all && most && most.msat > 0 && (
            <Body muted>{`Up to ${viewText(Math.ceil(keptMsat(most.msat, available, tight) / 1000) * 1000, cv, rated)} kept for routing fees; what isn't used stays in Pool.`}</Body>
          )}
          {problem && <Body muted>{problem}</Body>}
          <Button
            title="Next"
            disabled={problem !== null}
            onPress={() => {
              setTaken(typed);
              setStep('check');
            }}
          />
        </>
      )}
      {phase.at === 'steps' && at === 'check' && payable && (
        <>
          <RateAgeLine unit={cv} />
          <ReadBack rows={sendReadBack(payable, amountMsat ?? 0, available, cv, rated)} force={cv} />
          {notes && (
            <>
              <Label>Note (optional)</Label>
              {/* Cut by code points, as cardd counts: maxLength counts UTF-16 units, an emoji as two. */}
              <Field accessibilityLabel="Note (optional)" value={note} onChangeText={(t) => setNote(cutNote(t))} placeholder="Add a note" />
              <Body muted>{`For you only: ${noteWho(payable)} doesn't see it.`}</Body>
            </>
          )}
          {problem && <Body muted>{problem}</Body>}
          <Button title={sendTitle} disabled={problem !== null} onPress={send} />
          {error && <ErrorText>{error}</ErrorText>}
          <Button title="Back" kind="secondary" onPress={back} />
        </>
      )}
      {phase.at === 'sending' && <Body>{phase.text}</Body>}
      {phase.at === 'result' && <ResultPage view={resultView(phase.result, cv, rated)} onDone={goBack} />}
    </Screen>
  );
}

/** All's line under the amount: the most Pool can send, or the most an address or link takes when that is less. */
function allText(most: { msat: number; capped: boolean }, p: Payable | null, v: Shown, r: Rated | null): string {
  const figure = viewText(most.msat, v, r);
  return most.capped ? `Most this ${p?.kind === 'address' ? 'address' : 'link'} takes: ${figure}` : `All: ${figure}`;
}

const layout = StyleSheet.create({
  grow: { flex: 1 },
});

/** What cardd sets aside beside an All of all: the full budget, or on a tight server all that is left when the full one doesn't fit. */
const keptMsat = (all: number, available: number | null, tight: boolean) =>
  tight && available !== null ? Math.min(feeBudgetMsat(all), available - all) : feeBudgetMsat(all);
