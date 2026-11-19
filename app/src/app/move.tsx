// Move money between the person's accounts in
// three steps on one screen: To (the other account, from rows), Amount (with All) and Check; the screen lock for
// money moved onto a card but this phone's own, none for money moved off one (money/steps.ts moveLock); once
// per request id, kept through retries and app restarts (src/money/requests.ts). money/steps.ts decides how it
// opens, the read-back and where the outcome leads; this holds the state.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Wallet } from '../cardd/client';
import { symbol } from '../money/fiat';
import { moneyError, moveAmountMsat } from '../money/format';
import { requestId, runRequest } from '../money/requests';
import { afterMove, moveAvailable, moveBack, moveLock, moveReadBack, moveStart, moveTargets, resultView, type MoveAccount, type Ran, type Result, type Step, STEP_NAMES, stepAt } from '../money/steps';
import { useCardDeps, useServer } from '../services/server';
import { useRouteGuard } from '../services/services';
import { confirmView, viewText } from '../money/view';
import { useAmountView } from '../ui/amountView';
import { screenLock } from '../ui/lock';
import { AmountField, RateAgeLine, ReadBack, ResultPage, StepBar } from '../ui/money';
import { Body, Button, ErrorText, goBack, GroupLabel, Label, ListGroup, ListRow, Panel, Row, Screen } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';
import { CardSwatch } from '../ui/wallet';
import { colourOf } from '../wallet/colours';

type Phase = { at: 'steps' } | { at: 'moving' } | { at: 'result'; result: Result };

export default function Move() {
  const allowed = useRouteGuard('/move');
  const deps = useCardDeps();
  const { snap } = useServer();
  const params = useLocalSearchParams<{ from?: string; to?: string }>();
  // Fixed when the screen opens: a link can't change a move under way.
  const [link] = useState(() => ({ from: params.from, to: params.to }));
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('to');
  const [amount, setAmount] = useState('');
  const [all, setAll] = useState(false);
  const [phase, setPhase] = useState<Phase>({ at: 'steps' });
  // cardd's refusal, when the last try came back to Check.
  const [error, setError] = useState<string | null>(null);
  const moving = useRef(false);
  // The amount's unit, and what Next took from Amount: a price in
  // the currency becomes whole sats there, once; Check and the move carry those sats.
  const look = useAmountView();
  const { rated, typingUnit } = look;
  // Move shows its amounts in the app's view, and in sat while it is *** (rule 5): here money is being confirmed.
  const cv = confirmView(look.view);
  const [taken, setTaken] = useState<number | null>(null);

  useEffect(() => {
    if (!deps) return;
    deps.cardd.wallet().then(
      (w) => {
        setWallet(w);
        // Send's Move to it instead names the target: straight to Amount.
        const start = moveStart(link, w);
        if (start?.to) {
          setToId(start.to.id);
          setStep('amount');
        }
      },
      (e) => setLoadError(moneyError(e)),
    );
  }, [deps, link]);

  const from = wallet ? (moveStart(link, wallet)?.from ?? null) : null;
  const targets = wallet && from ? moveTargets(wallet, from.id) : [];
  const to = targets.find((a) => a.id === toId) ?? null;
  // A step past To needs a target.
  const at: Step = to ? step : 'to';
  // What is typed keeps its unit: the field empties itself when the unit changes under it (ui/money.tsx AmountField);
  // a change while Amount isn't showing (a rate going on Check) empties it here. Check keeps the sats Next took.
  const amountUnit = useRef(typingUnit);
  useEffect(() => {
    if (amountUnit.current === typingUnit) return;
    amountUnit.current = typingUnit;
    if (at !== 'amount') setAmount('');
  }, [typingUnit, at]);
  const typed = from ? moveAmountMsat(all, amount, from.availableMsat, typingUnit, rated) : null;
  const amountMsat = at === 'check' && taken !== null ? taken : typed;
  const unitWord = rated && typingUnit === 'fiat' ? symbol(rated.currency).trim() : 'sat';
  const problem = !from || !amountMsat ? 'Enter an amount.' : amountMsat > from.availableMsat ? `${from.name} has ${viewText(from.availableMsat, cv, rated)} available.` : null;

  // A step back; from To, and while moving or on the result, Back leaves the screen (the request goes on).
  const stepBack = (): boolean => {
    const back = phase.at === 'steps' ? moveBack(at) : null;
    if (!back) return false;
    setError(null);
    setStep(back);
    return true;
  };
  useAndroidBack(stepBack);
  const back = () => {
    if (!stepBack()) goBack();
  };

  if (!allowed || !deps) return <Screen busy />;
  if (!wallet) return <Screen title="Move" back>{loadError ? <ErrorText>{loadError}</ErrorText> : <Body muted>Loading…</Body>}</Screen>;
  if (!from) {
    return (
      <Screen title="Move" back>
        <Body>There is no such account.</Body>
      </Screen>
    );
  }

  // Check's button, and the screen lock's prompt for money moved onto a card: the lock confirms the figure the person saw.
  const moveTitle = `Move ${viewText(amountMsat ?? 0, cv, rated)}`;
  const move = async () => {
    if (problem || !to || !amountMsat || moving.current) return;
    moving.current = true;
    setError(null);
    try {
      const lock = moveLock(to, moveTitle, snap.phoneCard.own);
      if (lock) {
        const why = await screenLock(lock.prompt, lock.needs);
        if (why) return setError(why);
      }
      setPhase({ at: 'moving' });
      const out: Ran = await runRequest({ cardd: deps.cardd, store: deps.cache }, { kind: 'move', id: requestId(), from: from.id, to: to.id, amountMsat, started: Date.now() }).catch(
        (e) => ({ at: 'failed' as const, e }),
      );
      const after = afterMove(out, from, to, amountMsat);
      if (after.at === 'result') return setPhase(after);
      setPhase({ at: 'steps' });
      if (after.at === 'check') setError(after.error);
      // Back at Check after a refusal: what is available may be why, so it is read again (the last stands if that fails).
      deps.cardd.wallet().then(setWallet, () => {});
    } finally {
      moving.current = false;
    }
  };

  const swatch = (a: MoveAccount) => (a.card ? <CardSwatch colour={colourOf(snap.cards ?? [], a.id)} photo={snap.photos[a.id]} /> : undefined);

  return (
    <Screen title="Move" back={back}>
      {phase.at === 'steps' && <StepBar names={STEP_NAMES} at={stepAt(at)} />}
      {phase.at === 'steps' && at === 'to' && (
        <>
          <GroupLabel>From</GroupLabel>
          <ListGroup>
            <ListRow lead={swatch(from)} name={from.name} line={`${viewText(from.availableMsat, cv, rated)} available`} />
          </ListGroup>
          <GroupLabel>Move to</GroupLabel>
          <ListGroup>
            {targets.map((a, i) => (
              <ListRow
                key={a.id}
                lead={swatch(a)}
                name={a.name}
                line={`${a.frozen ? 'Frozen · ' : ''}${viewText(a.availableMsat, cv, rated)}`}
                divider={i > 0}
                onPress={() => {
                  setError(null);
                  setToId(a.id);
                  setStep('amount');
                }}
              />
            ))}
          </ListGroup>
        </>
      )}
      {phase.at === 'steps' && at === 'amount' && to && (
        <>
          <Panel>
            <Label>{`${from.name} to`}</Label>
            <Body>{to.name}</Body>
          </Panel>
          <Label>{`How much (${unitWord})`}</Label>
          <Row>
            <View style={layout.grow}>
              <AmountField
                value={all ? '' : amount}
                placeholder={all ? `All: ${viewText(from.availableMsat, cv, rated)}` : `Amount in ${unitWord}`}
                onChangeText={(t) => (setAll(false), setAmount(t))}
                autoFocus
              />
            </View>
            <Button title="All" kind="secondary" onPress={() => setAll(true)} />
          </Row>
          <Body muted>{moveAvailable(from, cv, rated)}</Body>
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
      {phase.at === 'steps' && at === 'check' && to && (
        <>
          <RateAgeLine />
          <ReadBack rows={moveReadBack(from, to, amountMsat ?? 0, cv, rated)} force={cv} />
          {problem && <Body muted>{problem}</Body>}
          <Button title={moveTitle} disabled={problem !== null} onPress={move} />
          {error && <ErrorText>{error}</ErrorText>}
          <Button title="Back" kind="secondary" onPress={back} />
        </>
      )}
      {phase.at === 'moving' && <Body>Moving… keep this screen open.</Body>}
      {phase.at === 'result' && <ResultPage view={resultView(phase.result, cv, rated)} onDone={goBack} />}
    </Screen>
  );
}

const layout = StyleSheet.create({
  grow: { flex: 1 },
});
