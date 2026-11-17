// Settings → Alerts: how alerts stand in one line;
// Turn on alerts, through the server's own ntfy (after its server step) or the Play build's own push; ntfy's steps
// where they are needed; Send a test alert and Turn off once on. A link with start=1 (the offer's Turn on alerts)
// starts turning them on at once. With setup=1 it is the step at the end of setup, over the wallet: the
// offer's question with Turn on alerts and Not now, and Open the wallet once on. The words are
// alerts/alertsView.ts's; the work is alerts/register.ts's.
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { NOT_ON_YET, NTFY, noPushApi, ntfySteps, registerError, type Step } from '../alerts/alertsView';
import { OFFER } from '../alerts/offer';
import { alertsSupported, register, routeOf, turnOff, type RegisterDeps } from '../alerts/register';
import { isPlayBuild } from '../alerts/store';
import { CarddError } from '../cardd/client';
import { useAlerts } from '../alerts/useAlerts';
import { useCardDeps } from '../services/server';
import { alertsClient, useRouteGuard, useServices, walletStore } from '../services/services';
import { NumberLead } from '../ui/setup';
import { Body, Button, ErrorText, ListGroup, ListRow, Screen } from '../ui/ui';

/** The server step on its way: done once the person has set ntfy's server; stop when the page goes. */
type OpenStep = { address: string; done(): void; stop(): void };

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
  const [step, setStep] = useState<OpenStep | null>(null);
  const [busy, setBusy] = useState<'on' | 'test' | 'off' | null>(null);
  const [said, setSaid] = useState<{ error: boolean; text: string } | null>(null);
  const started = useRef(false);
  const stepRef = useRef<OpenStep | null>(null);
  stepRef.current = step;
  // A server step left open when the page goes ends its registration, so the check on open isn't held up.
  useEffect(() => () => stepRef.current?.stop(), []);

  const native = sv.native;
  const reg: RegisterDeps | null = cardd && alertsSupported(native) ? { native, cardd, store: walletStore(sv), play: isPlayBuild } : null;

  /**
   * withStep: show ntfy's server step first (from Off); the steps already on the page need it no more. blocked: the
   * page says notifications are blocked, so a refusal opens Android's settings, the only place they can be allowed.
   */
  const turnOn = async (withStep: boolean, blocked = false) => {
    if (!reg) return;
    setBusy('on');
    setSaid(null);
    try {
      const ntfyStep = (address: string) => new Promise<void>((done, stop) => setStep({ address, done, stop: () => stop(new Error('left')) }));
      const r = await register(reg, withStep ? { ntfyStep } : {});
      if (!r.ok && r.why === 'permission' && blocked) void Linking.openSettings().catch(() => {});
      const text = !r.ok && r.why === 'permission' ? "Allow notifications in Android's settings" : registerError(r, routeOf(reg.native, reg.play)?.transport === 'fcm' ? 'fcm' : 'ntfy');
      setSaid(text ? { error: true, text } : null);
    } catch {
      // The page went in the middle of the server step.
    } finally {
      setStep(null);
      setBusy(null);
      void alerts.reload();
    }
  };

  // The offer's Turn on alerts: once, as soon as the page knows alerts are off.
  const status = alerts.server ? alerts.view?.status : undefined;
  useEffect(() => {
    if (start !== '1' || started.current || status === undefined) return;
    started.current = true;
    if (status === 'off') void turnOn(true);
  }, [start, status]);

  if (!allowed || !cardd) return <Screen busy back />;
  if (!alerts.supported || !alerts.view) {
    return (
      <Screen title="Alerts" back>
        <Body>Alerts aren&apos;t on the iPhone yet.</Body>
      </Screen>
    );
  }
  const v = alerts.view;
  const ntfyInstalled = !!alerts.phone?.distributors.includes(NTFY);
  const openNtfy = () => native.openNtfySettings?.();

  if (step) {
    return (
      <Screen title="Alerts" back>
        <Steps steps={ntfySteps(step.address, alerts.phone?.ntfyExempt ?? null)} />
        {ntfyInstalled && <Button title="Open ntfy" kind="secondary" onPress={openNtfy} />}
        <Button title="Done, turn on" onPress={() => step.done()} />
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
    } catch (e) {
      setSaid({ error: true, text: `Couldn't turn off alerts: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      void alerts.reload();
    }
  };

  const loading = !alerts.server;
  const on = v.status === 'on-ntfy' || v.status === 'on-play' || v.status === 'late-battery' || v.status === 'failing' || v.status === 'needs-permission';
  return (
    <Screen title="Alerts" back>
      {/* At the end of setup, the question until alerts are on, unless a turn on went to another ntfy server (the why
          says what happened); an "Off" line before they ever were says nothing. */}
      {setup && !on && v.status !== 'needs-ntfy-server' && <Body>{OFFER.text}</Body>}
      {!(setup && (loading || v.status === 'off')) && (
        <ListGroup>
          <ListRow icon="bell" name="Alerts" line={loading && !alerts.error ? 'Checking…' : v.line} tone={loading ? 'none' : v.tone} />
        </ListGroup>
      )}
      {v.why && <Body>{v.why}</Body>}
      {v.note && <Body muted>{v.note}</Body>}
      {alerts.error !== null && (
        noPushApi(alerts.error) ? (
          <Body>Your server needs Update server before it can send alerts.</Body>
        ) : (
          <ErrorText>{`Couldn't check alerts: ${alerts.error instanceof Error ? alerts.error.message : String(alerts.error)}`}</ErrorText>
        )
      )}
      {v.steps.length > 0 && <Steps steps={v.steps} />}
      {v.steps.some((s) => s.n > 1) && ntfyInstalled && <Button title="Open ntfy" kind="secondary" onPress={openNtfy} />}
      {v.status === 'off' && <Button title="Turn on alerts" onPress={() => void turnOn(true)} disabled={loading || busy !== null} />}
      {(v.status === 'needs-distributor' || v.status === 'needs-ntfy-server') && (
        <Button title="Done, turn on" onPress={() => void turnOn(false)} disabled={loading || busy !== null} />
      )}
      {v.status === 'needs-permission' && <Button title="Turn on alerts" onPress={() => void turnOn(false, true)} disabled={busy !== null} />}
      {v.canTest && <Button title={busy === 'test' ? 'Sending…' : 'Send a test alert'} onPress={() => void test()} disabled={busy !== null} />}
      {/* What a press just did, beside its button: a test alert's, or why alerts didn't turn on or off. */}
      {said && (said.error ? <ErrorText>{said.text}</ErrorText> : <Body>{said.text}</Body>)}
      {on && !setup && <Button title="Turn off" kind="secondary" onPress={() => void off()} disabled={busy !== null} />}
      {setup && v.status === 'needs-ntfy-server' && <Body muted>{NOT_ON_YET}</Body>}
      {setup && (on ? <Button title="Open the wallet" onPress={toWallet} /> : <Button title={OFFER.no} kind="secondary" onPress={toWallet} disabled={busy !== null} />)}
    </Screen>
  );
}

/** ntfy's numbered steps: its store links, the server's address with Copy, its battery setting. Numbered as shown,
 * from 1: with ntfy installed the install step is left out, and the rest close up. */
function Steps({ steps }: { steps: Step[] }) {
  return (
    <View style={layout.steps}>
      {steps.map((s, i) => (
        <View key={s.n} style={layout.step}>
          <NumberLead n={i + 1} />
          <View style={layout.stepBody}>
            <Body>{s.text}</Body>
            {s.links?.map((l) => <Button key={l.url} title={l.label} kind="secondary" onPress={() => void Linking.openURL(l.url).catch(() => {})} />)}
            {s.address && (
              <>
                <Body selectable>{s.address}</Body>
                <Button title="Copy" kind="secondary" onPress={() => void Clipboard.setStringAsync(s.address!)} />
              </>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const layout = StyleSheet.create({
  steps: { gap: 16 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepBody: { flex: 1, gap: 8 },
});
