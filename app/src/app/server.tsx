// The Server page, from Settings' Server row and the wallet's server banners:
// how the server stands, what needs the person with today's buttons, Update server, a restore's lines, and the
// builder's details. serverCards says which cards show; ServerWatch does the work (useWatcher); the acts that need
// the screen lock ask for it here, as Settings did.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { installStepsFor } from '../onboarding/install';
import { elapsed, stepRows, UPDATE_STEP_LABELS, uploadLine } from '../onboarding/progress';
import { useWatcher } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { screenLock } from '../ui/lock';
import { detailsLabelWidth } from '../ui/look';
import { PairAgain } from '../ui/PairAgain';
import { TYPE, type Theme } from '../ui/theme';
import { useStyles } from '../ui/useTheme';
import { Body, Button, ErrorText, Panel, Screen, Step } from '../ui/ui';
import { serverCards, type ServerCard } from '../wallet/serverCards';
import { serverView } from '../wallet/serverView';

/** Update server's steps as listed: it wipes and restores nothing. */
const UPDATE_STEPS = installStepsFor({});

export default function Server() {
  const allowed = useRouteGuard('/server');
  const { snap, watch } = useWatcher(allowed);
  const sv = useServices();
  const s = useStyles(makeStyles);
  // Details' label column, wide enough for "Hosted by" at the phone's font size.
  const labelWidth = detailsLabelWidth(useWindowDimensions().fontScale);
  const [now, setNow] = useState(Date.now());
  // The screen lock refused, for the act that asked.
  const [refused, setRefused] = useState<{ act: 'retire' | 'books'; text: string } | null>(null);
  const asking = useRef(false);

  // Update server's elapsed time, ticking while it runs (the watch holds when it started and ended).
  const updating = !!snap.update?.running;
  useEffect(() => {
    if (!updating) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [updating]);

  // Set before the first await, as the server page's busy flag was: a double tap asks for the lock once.
  const afterLock = async (act: 'retire' | 'books', prompt: string, needs: string, then: () => Promise<void>) => {
    if (asking.current) return;
    asking.current = true;
    setRefused(null);
    try {
      const why = await screenLock(prompt, needs);
      if (why) return setRefused({ act, text: why });
      await then();
    } finally {
      asking.current = false;
    }
  };

  // The old server runs again though step 4 never retired it over SSH.
  const retire = (vmId: number) => afterLock('retire', 'Retire the old server', 'retiring the old server', () => watch.retireOld(vmId));

  // The way out of a pause: the difference is recorded in pool.
  const setBooks = () =>
    Alert.alert("Set the books to the server's balance?", "The difference goes to pool, recorded in its history. Do this only if the server's Lightning balance is right.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Set the books', onPress: () => void watch.setBooks() },
    ]);

  // No channel back after a restore: setting the books both ways is the person's deliberate act.
  const restoreBooks = () => afterLock('books', "Set the books to phoenixd's balance", 'setting the books', () => watch.restoreBooks());

  const view = serverView(snap, Date.now());
  if (!allowed || !view) return <Screen busy back />;
  const { update, retire: retiring } = snap;
  const cards = serverCards(snap, view, { outlivesApp: sv.phrase.outlivesApp });
  const restoreShown = cards.some((c) => c.kind === 'restore');

  // Where a refused Set the books says why (ServerWatch puts it with the card list's error, as CardsPanel did).
  const booksNotes = (
    <>
      {refused?.act === 'books' && <ErrorText>{refused.text}</ErrorText>}
      {snap.cardsError && <ErrorText>{snap.cardsError}</ErrorText>}
    </>
  );
  const retireNotes = (
    <>
      {refused?.act === 'retire' && <ErrorText>{refused.text}</ErrorText>}
      {retiring.outcome && (retiring.outcome.ok ? <Body>{retiring.outcome.text}</Body> : <ErrorText>{retiring.outcome.text}</ErrorText>)}
    </>
  );
  const oldVmShown = cards.some((c) => c.kind === 'old-vm');

  const card = (c: ServerCard, i: number) => {
    switch (c.kind) {
      case 'running':
        return (
          <Panel key="state" tone="ok" title="Running">
            <Body muted>This phone is paired with it.</Body>
            {!oldVmShown && retireNotes}
          </Panel>
        );
      case 'checking':
        return (
          <Panel key="state" title="Checking the server…">
            {!oldVmShown && retireNotes}
          </Panel>
        );
      case 'unreachable':
        return (
          <Panel key="state" tone="error" title="Can't reach your server">
            <Body>{c.reason}</Body>
            <Button title="Check again" kind="secondary" onPress={() => void watch.checkAgain()} />
            {!oldVmShown && retireNotes}
          </Panel>
        );
      case 'not-paired':
        return (
          <Panel key="state" tone="error" title="This phone isn't paired">
            <Body>{c.text}</Body>
            {c.pairAgain && <PairAgain />}
            {!oldVmShown && retireNotes}
          </Panel>
        );
      case 'stop':
        return (
          <Panel key="stop" tone="error" title="Stop using this server">
            <Body>{c.text}</Body>
          </Panel>
        );
      case 'old-vm':
        return (
          <Panel key="old-vm" tone="error" title="The old server is still running">
            <Body>{c.text}</Body>
            {retiring.running ? (
              <Body muted>Retiring the old server…</Body>
            ) : (
              <Button title={`Retire VM ${c.vmId}`} onPress={() => retire(c.vmId)} disabled={view.sshBusy} />
            )}
            {retireNotes}
          </Panel>
        );
      case 'paused':
        return (
          <Panel key="paused" tone="error" title="Payments are paused">
            <Body>{c.text}</Body>
            {c.setBooks && <Button title="Set the books to the server's balance" kind="secondary" onPress={setBooks} disabled={view.moneyOff} />}
            {!restoreShown && booksNotes}
          </Panel>
        );
      case 'overdue':
        return (
          <Panel key="overdue" tone="error" title="LNVPS hasn't confirmed its identity">
            <Body>{c.text}</Body>
          </Panel>
        );
      case 'dns':
        return (
          <Panel key="dns" tone="warn" title={c.title}>
            <Body selectable>{c.text}</Body>
          </Panel>
        );
      case 'disk':
        return (
          <Panel key="disk" tone={c.critical ? 'error' : 'warn'} title={c.title}>
            <Body selectable>{c.text}</Body>
            {/* As Settings' row: home under it, so Rebuild server's way back is home. */}
            {c.rebuild && (
              <Button
                title="Rebuild server"
                disabled={view.sshBusy}
                onPress={() => {
                  router.dismissTo('/home');
                  router.replace('/rebuild');
                }}
              />
            )}
          </Panel>
        );
      case 'update':
        return (
          <Panel key="update" tone="warn" tag="Update ready">
            <Body>This app carries a newer version of your server.</Body>
            <Button title="Update server" onPress={() => void watch.update()} disabled={view.sshBusy} />
          </Panel>
        );
      case 'update-run':
        return (
          <Panel key="update-run" title={`${update!.running ? 'Updating the server' : 'Server update'} · ${elapsed(update!.startedAt, update!.endedAt ?? now)}`}>
            {stepRows(UPDATE_STEPS, update!.done, update!, now, update!.running, UPDATE_STEP_LABELS).map((r) => {
              const live = r.status === 'current' && update!.running;
              return (
                <Step key={r.step} label={r.label} status={r.status} time={r.time} spoken={r.spoken} oneLine>
                  {live && r.step === 'upload' && <Body muted>{update!.upload ? uploadLine(update!.upload) : 'Connecting to the server…'}</Body>}
                </Step>
              );
            })}
            {/* Waiting to connect again after the connection dropped: it carries on by itself. */}
            {c.waiting && <Body muted>{c.waiting}</Body>}
            {update!.outcome && (update!.outcome.ok ? <Body>{update!.outcome.text}</Body> : <ErrorText>{update!.outcome.text}</ErrorText>)}
            {c.error && <ErrorText>{c.error}</ErrorText>}
          </Panel>
        );
      case 'restore': {
        const r = c.restore;
        return (
          <Panel key="restore" tone={r.red ? 'error' : 'none'} title="After a restore">
            <Body muted>{r.from}</Body>
            {r.red ? <ErrorText>{r.line}</ErrorText> : <Body muted>{r.line}</Body>}
            {r.phoenixd && <Body muted>{r.phoenixd}</Body>}
            {r.refreeze && <Body>{r.refreeze}</Body>}
            {r.setBooks && <Button title="Set the books to phoenixd's balance" kind="secondary" onPress={restoreBooks} disabled={c.booksOff} />}
            {r.notUp && <Body muted>{r.notUp}</Body>}
            {booksNotes}
          </Panel>
        );
      }
      case 'details':
        return (
          <View key="details" style={layout.details}>
            <Text style={s.group}>Details</Text>
            <Panel>
              {c.rows.map(([k, v]) => (
                <View key={k} style={layout.detail}>
                  <Text style={[s.dt, { width: labelWidth }]}>{k}</Text>
                  <Text style={s.dd}>{v}</Text>
                </View>
              ))}
              {c.identityNote && <Body muted>{c.identityNote}</Body>}
            </Panel>
          </View>
        );
      default:
        return <View key={i} />;
    }
  };

  return (
    <Screen title="Server" back>
      {cards.map(card)}
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    group: { ...TYPE.small, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted, paddingHorizontal: 4 },
    dt: { ...TYPE.small, color: t.muted },
    dd: { ...TYPE.small, color: t.text, flex: 1, fontVariant: ['tabular-nums'] },
  });

const layout = StyleSheet.create({
  details: { gap: 8 },
  detail: { flexDirection: 'row', gap: 12 },
});
