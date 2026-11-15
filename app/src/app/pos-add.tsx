// Add a PoS phone: its name, then a code for Karto PoS on the other
// phone to scan, good once and for 10 minutes; the phones are read every 2 seconds until one of that name is
// listed. No screen lock: a PoS phone can only bring money in. wallet/posPhones.ts addStep decides each step.
import { router } from 'expo-router';
import { startActivityAsync } from 'expo-intent-launcher';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import CardNative from '../../modules/card-native';
import type { PosPhone } from '../cardd/client';
import { poll } from '../cards/poll';
import { useCardDeps, useWatcher } from '../services/server';
import { useRouteGuard } from '../services/services';
import { ResultPage, StepBar } from '../ui/money';
import { useTheme } from '../ui/useTheme';
import { Body, Button, ErrorText, Field, goBack, Label, QrTile, Screen, Small } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';
import { moneyOff } from '../wallet/banners';
import {
  ADD_START, addStep, codeLine, LATE_READS_MS, nameProblem, nextTillName, pairedView, pairLink, posError, posGate, UPDATE_FIRST, type AddEvent, type AddState,
} from '../wallet/posPhones';
import { launchLine, openKartoPos, POS_ON_THIS_PHONE, posOnThisPhoneShown, type Launched } from '../wallet/posLaunch';
import { serverView } from '../wallet/serverView';

const BAR = ['Name', 'Code'] as const;

export default function PosAdd() {
  const allowed = useRouteGuard('/pos-add');
  const deps = useCardDeps();
  // The watch runs under this screen, as under Settings: it holds the server's state, which the gate below reads.
  const { snap, watch } = useWatcher(allowed);
  const [phones, setPhones] = useState<PosPhone[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<AddState | null>(null);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  // The step as it stands now, for answers that come later than the render that asked.
  const current = useRef<AddState | null>(null);

  const drop = useCallback(() => void deps?.cardd.dropShopCode().catch(() => {}), [deps]);
  const send = useCallback(
    (e: AddEvent) => {
      // The screen was left: a code that lands now was never shown, so it isn't left open.
      if (!current.current) return void (e.kind === 'code' && drop());
      const next = addStep(current.current, e);
      if (next.drop) drop();
      current.current = next.state;
      if (next.state) setState(next.state);
      else goBack();
    },
    [drop],
  );

  // The phones as cardd lists them now; each answer, or the failure to get one, tells the watch whether cardd can be reached.
  const readPhones = useCallback(async () => {
    try {
      const list = await deps!.cardd.shopPhones();
      watch.reportRefresh({ ok: true });
      return list.phones;
    } catch (error) {
      watch.reportRefresh({ ok: false, error });
      throw error;
    }
  }, [deps, watch]);

  // The phones, for the name it offers and the names taken.
  useEffect(() => {
    if (!deps) return;
    readPhones().then(
      (list) => {
        setPhones(list);
        current.current = ADD_START(nextTillName(list));
        setState(current.current);
      },
      (e) => setLoadError(posError(e)),
    );
  }, [deps, readPhones]);

  const at = state?.at;
  // At Code: the clock for the countdown, and the phones every 2 seconds.
  useEffect(() => {
    if (at !== 'code' || !deps) return;
    const clock = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setNowS(now);
      send({ kind: 'tick', nowS: now });
    }, 1000);
    const stop = poll(async () => send({ kind: 'phones', phones: await readPhones() }), 2000, () => AppState.currentState === 'active');
    return () => {
      clearInterval(clock);
      stop();
    };
  }, [at, deps, send, readPhones]);
  // After it ran out: a phone that scanned in the code's last second is paired a moment later.
  useEffect(() => {
    if (at !== 'ran-out' || !deps) return;
    const timers = LATE_READS_MS.map((ms) => setTimeout(() => void readPhones().then((list) => send({ kind: 'phones', phones: list }), () => {}), ms));
    return () => timers.forEach(clearTimeout);
  }, [at, deps, send, readPhones]);

  const back = () => send({ kind: 'back' });
  useAndroidBack(() => {
    if (!current.current) return false;
    back();
    return true;
  });

  if (!allowed || !deps) return <Screen busy />;
  // A server that may not be the person's shows nothing of its shop, by the row or by a link; until the watch knows the server, the page waits.
  const gate = posGate(serverView(snap, Date.now()));
  if (gate === 'wait') return <Screen title="Add a PoS phone" busy back />;
  if (gate !== 'open') {
    return (
      <Screen title="Add a PoS phone" back>
        <ErrorText>{gate.stopped}</ErrorText>
      </Screen>
    );
  }
  // A server that hasn't had Update server has no shop (a link opened this screen: the PoS phones page says the same).
  if (loadError === UPDATE_FIRST) {
    return (
      <Screen title="Add a PoS phone" back>
        <Body>{UPDATE_FIRST}</Body>
        <Button title="Open Server" kind="secondary" onPress={() => router.push('/server')} />
      </Screen>
    );
  }
  if (!state || !phones) return <Screen title="Add a PoS phone" back>{loadError ? <ErrorText>{loadError}</ErrorText> : <Body muted>Loading…</Body>}</Screen>;

  const ask = () => {
    send({ kind: 'asked' });
    const asked = current.current;
    if (!asked?.asking) return;
    // addStep knows the answer by its ask: one that lands late is dropped, or left alone when a newer one replaced it.
    deps.cardd.shopCode(asked.name).then(
      (c) => {
        setNowS(Math.floor(Date.now() / 1000));
        send({ kind: 'code', ask: asked.ask, code: c.code, expires: c.expires });
      },
      (e) => send({ kind: 'refused', ask: asked.ask, text: posError(e) }),
    );
  };
  const off = moneyOff({ unreachable: snap.unreachable, updating: snap.update?.running ? snap.update : null });
  const problem = nameProblem(state.name, phones);

  if (state.at === 'paired') {
    const view = pairedView(state.name);
    return (
      <Screen title="Add a PoS phone">
        <ResultPage view={view} note={view.note} onDone={back} />
      </Screen>
    );
  }
  return (
    <Screen title="Add a PoS phone" back={back}>
      <StepBar names={BAR} at={state.at === 'name' ? 0 : 1} />
      {state.at === 'name' && (
        <>
          <Body>Give the phone a name. Sales will say which phone took them.</Body>
          <View style={layout.field}>
            <Label>Name</Label>
            <Field value={state.name} onChangeText={(name) => send({ kind: 'typed', name })} editable={!state.asking} autoFocus />
          </View>
          {problem.line !== '' && <Body muted>{problem.line}</Body>}
          {state.error !== '' && <ErrorText>{state.error}</ErrorText>}
          <Button title={state.asking ? 'Asking your server…' : 'Continue'} onPress={ask} disabled={!problem.ok || state.asking || off} />
        </>
      )}
      {state.at === 'code' && <Code link={pairLink(deps.host, state.code)} line={codeLine(state.name, state.expires, nowS)} />}
      {state.at === 'ran-out' && (
        <>
          <Body>This code ran out.</Body>
          {state.error !== '' && <ErrorText>{state.error}</ErrorText>}
          <Button title={state.asking ? 'Asking your server…' : 'New code'} onPress={ask} disabled={state.asking || off} />
        </>
      )}
    </Screen>
  );
}

/**
 * The code, while it shows: no screenshots, as the recovery words' screens. Karto PoS is on this phone hands the
 * link to Karto PoS itself, by name (wallet/posLaunch.ts).
 */
function Code({ link, line }: { link: string; line: string }) {
  usePreventScreenCapture();
  const t = useTheme();
  const [launched, setLaunched] = useState<Launched | null>(null);
  const said = launched ? launchLine(launched) : '';
  return (
    <>
      <Body>Open Karto PoS on the other phone and scan this code.</Body>
      <QrTile value={link} label="Pairing code for Karto PoS" />
      <View style={layout.wait}>
        <View style={[layout.dot, { backgroundColor: t.accent }]} />
        <View style={layout.waitText}>
          <Body>{line}</Body>
        </View>
      </View>
      {posOnThisPhoneShown(Platform.OS) && (
        <Button title={POS_ON_THIS_PHONE} kind="secondary" onPress={() => void openKartoPos({ start: startActivityAsync, signer: (name) => CardNative.signedLikeThisApp(name) }, link).then(setLaunched)} />
      )}
      {said !== '' && <Body muted>{said}</Body>}
      <Small>Whoever scans this within 10 minutes becomes a PoS phone of your shop. Show it only to that phone.</Small>
    </>
  );
}

const layout = StyleSheet.create({
  field: { gap: 4 },
  wait: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  waitText: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
