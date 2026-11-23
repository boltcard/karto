// Settings → Alerts: how alerts stand in one line, Send a
// test alert and Turn off once on; while they are off on the way through ntfy, the checklist that turns them on
// (install ntfy, point it at the server, let it off battery saving, turn on), one step open at a time, each ticking
// itself where the phone can see it done. The Play build with Google's push, and another distributor, turn on with
// one press. With setup=1 it is the step at the end of setup, over the wallet: the question first (Turn on alerts,
// Later), Finish later's "not on yet", and Open the wallet once on. A link with start=1 (Home's offer) goes straight
// to the checklist, or turns alerts on at once on the one-press way. The words are alerts/alertsView.ts's; the work
// is alerts/register.ts's.
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Platform, View, StyleSheet } from 'react-native';
import {
  ASK, alertsChecklist, batteryHow, CHECKLIST, isOn, noPushApi, notYet, NTFY, ON_WORDS, onChecklistPath, PERMISSION_AHEAD, registerError,
  type Checklist, type ChecklistKey,
} from '../alerts/alertsView';
import { alertsSupported, register, routeOf, turnOff, type RegisterDeps } from '../alerts/register';
import { isPlayBuild } from '../alerts/store';
import { useAlerts } from '../alerts/useAlerts';
import { CarddError } from '../cardd/client';
import { useCardDeps } from '../services/server';
import { alertsClient, useRouteGuard, useServices, walletStore } from '../services/services';
import type { NtfyPasted } from '../store/store';
import { Body, Button, Callout, ErrorText, ListGroup, ListRow, Screen, Step, Title, WarnText } from '../ui/ui';

/** What a press just said, beside its button. */
type Said = { error: boolean; text: string } | null;

export default function Alerts() {
  const allowed = useRouteGuard('/alerts');
  const sv = useServices();
  const deps = useCardDeps();
  const { start, setup: setupParam } = useLocalSearchParams<{ start?: string; setup?: string }>();
  const setup = setupParam === '1';
  // The step at the end of setup leaves for the wallet, which is under it.
  const toWallet = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const host = deps?.host;
  const cardd = useMemo(() => (host ? alertsClient(sv, host) : null), [sv, host]);
  const alerts = useAlerts(sv.native, cardd);
  const native = sv.native;
  // One for the page: walletStore binds a new one each call, and the read of "I've pasted it" runs once per store.
  const store = useMemo(() => walletStore(sv), [sv]);
  /** Set-up's question, the checklist, or Finish later's "not on yet". */
  const [mode, setMode] = useState<'ask' | 'steps' | 'later'>(setup && start !== '1' ? 'ask' : 'steps');
  const [busy, setBusy] = useState<'on' | 'test' | 'off' | null>(null);
  const [said, setSaid] = useState<Said>(null);
  /** Android's question was refused: it won't ask again, so the next press opens Android's settings. */
  const [refused, setRefused] = useState(false);
  /** The person's "I've pasted it", kept; undefined until read. */
  const [pasted, setPasted] = useState<NtfyPasted | null | undefined>(undefined);
  /** The battery setting was opened from here (batteryOpened), and the app has been back since (batteryBack). */
  const batteryOpened = useRef(false);
  const [batteryBack, setBatteryBack] = useState(false);
  /** "My phone doesn't have this setting": on this page only. */
  const [batteryPassed, setBatteryPassed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    let live = true;
    void store.ntfyPasted().then((p) => live && setPasted(p), () => live && setPasted(null));
    return () => {
      live = false;
    };
  }, [store]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && batteryOpened.current) setBatteryBack(true);
    });
    return () => sub.remove();
  }, []);

  const reg: RegisterDeps | null = cardd && alertsSupported(native) ? { native, cardd, store, play: isPlayBuild } : null;
  const phone = alerts.phone;
  const v = alerts.view;
  const ntfy = alerts.server?.ntfy ?? '';
  const checklistWay = !!phone && onChecklistPath(phone);
  // The phone's endpoint now: read on each render, as alerts are read again on focus and on coming back.
  const endpoint = alerts.supported && alerts.server ? (native.pushEndpoint?.()?.endpoint ?? null) : null;
  const list: Checklist | null =
    phone && alerts.server && pasted !== undefined ? alertsChecklist({ ...phone, server: alerts.server }, { endpoint, pasted, batteryPassed }) : null;

  const savePasted = (p: NtfyPasted) => {
    setPasted(p);
    void store.saveNtfyPasted(p).catch(() => {});
  };

  /** blocked: the page says notifications are blocked, so a refusal opens Android's settings. */
  const turnOn = async (blocked = false) => {
    if (!reg) return;
    // Refused once already: Android asks no more, and its settings are the only place they can be allowed.
    if (refused && !reg.native.notificationsAllowed()) {
      void Linking.openSettings().catch(() => {});
      return;
    }
    const serverDone = list?.items.find((i) => i.key === 'server')?.done ?? false;
    const way = routeOf(reg.native, reg.play);
    setBusy('on');
    setSaid(null);
    try {
      const r = await register(reg);
      if (!r.ok && r.why === 'permission') {
        setRefused(true);
        if (blocked) void Linking.openSettings().catch(() => {});
      }
      const text = !r.ok && r.why === 'permission' ? "Allow notifications in Android's settings" : registerError(r, way?.transport === 'fcm' ? 'fcm' : 'ntfy');
      setSaid(text ? { error: true, text } : null);
      // Step 2 stays as the result says: done once alerts came through the server's ntfy (and after a Turn off), and
      // still done after a press that got no answer (a fresh registration drops the endpoint the person's "I've pasted
      // it" was said with). After ntfy-sh it is to do again: the endpoint ntfy gave says so.
      if (way?.ntfy && ntfy !== '') {
        if (r.ok) savePasted({ address: ntfy, endpoint: null });
        else if (serverDone && r.why !== 'ntfy-sh') savePasted({ address: ntfy, endpoint: reg.native.pushEndpoint()?.endpoint ?? null });
      }
    } finally {
      // Read again before the page is let go: the checklist's last step doesn't come back for a moment as On loads.
      await alerts.reload();
      setBusy(null);
    }
  };

  // Home's offer's Turn on alerts: on the one-press way, turn on once the page knows alerts are off.
  const status = alerts.server ? v?.status : undefined;
  useEffect(() => {
    if (start !== '1' || started.current || status === undefined) return;
    started.current = true;
    if (status === 'off' && !checklistWay) void turnOn();
  }, [start, status]);

  if (!allowed || !cardd) return <Screen busy back />;
  if (!alerts.supported || !v || !phone) {
    return (
      <Screen title="Alerts" back>
        <Body>Alerts aren&apos;t on the iPhone yet.</Body>
      </Screen>
    );
  }
  if (busy === 'on') return <Screen title="Alerts" busy busyText="Turning on alerts…" back />;

  const test = async () => {
    setBusy('test');
    setSaid(null);
    try {
      await cardd.testPush();
      setSaid({ error: false, text: 'Test alert sent: it should show in a moment.' });
    } catch (e) {
      // The endpoint refused it: the status line says what it said, once read again. Anything else is said here.
      if (!(e instanceof CarddError && e.code === 'push_failed')) setSaid({ error: true, text: `Couldn't send a test alert: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      void alerts.reload();
    }
  };
  const off = async () => {
    if (!reg) return;
    setBusy('off');
    setSaid(null);
    try {
      await turnOff(reg);
      // The checklist starts afresh: what the battery button did on the On page is not its step's.
      batteryOpened.current = false;
      setBatteryBack(false);
      setBatteryPassed(false);
    } catch (e) {
      setSaid({ error: true, text: `Couldn't turn off alerts: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      void alerts.reload();
    }
  };
  const openBattery = () => {
    batteryOpened.current = true;
    setBatteryBack(false);
    try {
      native.openBatterySettings?.(NTFY);
    } catch {
      // Nothing opened it: the way past shows at once, as there is no setting to come back from.
      setBatteryBack(true);
    }
  };
  /** ntfy, or its store page; said beside the button when nothing on the phone opens either. */
  const openNtfy = () => {
    try {
      native.openNtfySettings?.();
    } catch (e) {
      setSaid({ error: true, text: `Couldn't open ntfy: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  /** Android's question, said before it comes: not once it was refused, as Android won't ask again. */
  const ahead = !phone.allowed && !refused && <Body>{PERMISSION_AHEAD}</Body>;
  const saidText = said && (said.error ? <ErrorText>{said.text}</ErrorText> : <Body>{said.text}</Body>);
  const on = isOn(v.status);

  // Finish later, at the end of set-up: how far the person got, and where to carry on.
  if (setup && mode === 'later' && !on) {
    const n = notYet(list?.done ?? 0, list?.items.length ?? 4);
    return (
      <Screen title="Alerts" back>
        <Title>{n.title}</Title>
        <Body>{n.text}</Body>
        <Button title="Open the wallet" onPress={toWallet} />
        <Button title={CHECKLIST.back} kind="secondary" onPress={() => setMode('steps')} />
      </Screen>
    );
  }

  // The question at the end of set-up, until the person answers it.
  if (setup && mode === 'ask' && !on) {
    const yes = () => (checklistWay ? setMode('steps') : void turnOn());
    return (
      <Screen title="Alerts" back>
        <Title>{ASK.title}</Title>
        <Body>{ASK.what}</Body>
        {checklistWay ? <Body>{ASK.ntfy}</Body> : v.note && <Body>{v.note}</Body>}
        {!checklistWay && ahead}
        <Button title={ASK.yes} onPress={yes} disabled={busy !== null} />
        {saidText}
        <Button title={ASK.later} kind="secondary" onPress={toWallet} disabled={busy !== null} />
        <Body muted>{ASK.where}</Body>
      </Screen>
    );
  }

  const loading = !alerts.server;
  const checking = (
    <>
      {alerts.error === null && <ListGroup><ListRow icon="bell" name="Alerts" line="Checking…" /></ListGroup>}
      {alerts.error !== null && (
        noPushApi(alerts.error) ? (
          <Body>Your server needs Update server before it can send alerts.</Body>
        ) : (
          <>
            <ErrorText>{`Couldn't check alerts: ${alerts.error instanceof Error ? alerts.error.message : String(alerts.error)}`}</ErrorText>
            <Button title="Try again" kind="secondary" onPress={() => void alerts.reload()} />
          </>
        )
      )}
    </>
  );

  // Off, on the way through ntfy: the checklist, once the server has said its ntfy's address, and while it answers
  // (a read that failed after a good one leaves the last answer, which may no longer hold).
  if (!on && checklistWay) {
    if (loading || !list || alerts.error !== null) {
      return (
        <Screen title="Alerts" back>
          {checking}
          {setup && <Button title={CHECKLIST.later} kind="secondary" onPress={() => setMode('later')} />}
        </Screen>
      );
    }
    const of = list.items.length;
    const n = list.items.findIndex((i) => i.key === list.current) + 1;
    const body = (key: ChecklistKey) => {
      const item = list.items.find((i) => i.key === key)!;
      switch (key) {
        case 'install':
          return (
            <>
              <Body>{CHECKLIST.install.text}</Body>
              <Button title={CHECKLIST.install.button} onPress={openNtfy} />
              {saidText}
            </>
          );
        case 'server':
          return (
            <>
              {item.warn && (
                <Callout>
                  <WarnText>{item.warn.title}</WarnText>
                  <Body>{item.warn.text}</Body>
                </Callout>
              )}
              <Body>{CHECKLIST.server.text}</Body>
              <Body selectable>{ntfy}</Body>
              <Button
                title={CHECKLIST.server.button}
                onPress={() => void Clipboard.setStringAsync(ntfy).finally(openNtfy)}
              />
              <Button title={CHECKLIST.server.pasted} kind="secondary" onPress={() => savePasted({ address: ntfy, endpoint })} />
              {saidText}
            </>
          );
        case 'battery':
          return (
            <>
              <Body>{`${CHECKLIST.battery.why} ${batteryHow(Number(Platform.Version))}`}</Body>
              <Button title={CHECKLIST.battery.button} onPress={openBattery} />
              {batteryBack && <Button title={CHECKLIST.battery.passed} kind="secondary" onPress={() => setBatteryPassed(true)} />}
            </>
          );
        case 'on':
          return (
            <>
              {ahead}
              <Button title={CHECKLIST.on.button} onPress={() => void turnOn()} disabled={busy !== null} />
              {saidText}
            </>
          );
      }
    };
    return (
      <Screen title="Alerts" back>
        <Title>{CHECKLIST.title}</Title>
        <Body muted>{list.done === 0 ? CHECKLIST.intro(of) : CHECKLIST.stepOf(n, of)}</Body>
        <View style={layout.steps}>
          {list.items.map((i) => (
            <Step key={i.key} label={i.title} status={i.done ? 'done' : i.key === list.current ? 'current' : 'todo'} time={i.done ? i.doneLine : null}>
              {i.key === list.current && <View style={layout.body}>{body(i.key)}</View>}
            </Step>
          ))}
        </View>
        {setup && <Button title={CHECKLIST.later} kind="secondary" onPress={() => setMode('later')} />}
      </Screen>
    );
  }

  // On (or off on the one-press way): the status line and what can be done about it.
  return (
    <Screen title="Alerts" back>
      {setup && on && (
        <>
          <Title>{ON_WORDS.title}</Title>
          <Body>{ON_WORDS.text}</Body>
        </>
      )}
      {loading ? checking : <ListGroup><ListRow icon="bell" name="Alerts" line={v.line} tone={v.tone} /></ListGroup>}
      {v.note && <Body muted>{v.note}</Body>}
      {!loading && alerts.error !== null && checking}
      {v.status === 'late-battery' && (
        <>
          <Body>{`${CHECKLIST.battery.why} ${batteryHow(Number(Platform.Version))}`}</Body>
          <Button title={CHECKLIST.battery.button} kind="secondary" onPress={openBattery} />
        </>
      )}
      {v.status === 'off' && ahead}
      {v.status === 'off' && <Button title={ASK.yes} onPress={() => void turnOn()} disabled={loading || busy !== null} />}
      {v.status === 'needs-permission' && <Button title={ASK.yes} onPress={() => void turnOn(true)} disabled={busy !== null} />}
      {v.canTest && <Button title={busy === 'test' ? 'Sending…' : 'Send a test alert'} onPress={() => void test()} disabled={busy !== null} />}
      {saidText}
      {on && !setup && <Button title="Turn off" kind="secondary" onPress={() => void off()} disabled={busy !== null} />}
      {setup && (on ? <Button title="Open the wallet" onPress={toWallet} /> : <Button title={ASK.later} kind="secondary" onPress={toWallet} disabled={busy !== null} />)}
    </Screen>
  );
}

const layout = StyleSheet.create({
  steps: { gap: 16 },
  body: { gap: 8, marginTop: 8 },
});
