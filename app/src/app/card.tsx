// Hold the card: add, finish an add, wipe (only the card it was opened for), re-point, or add back a card the
// server doesn't know. All but a re-point are behind the screen lock (cards/hold.ts holdLocked): an add asks for it
// as the screen opens when a press in the app led here, and a wipe, or an add a karto:// link opened, at its page's button.
// Going to the background locks it again; a card held before the lock has passed is closed unread.
// Each tap carries on from the card's own state, so a card pulled away early only needs holding again. What the
// screen shows at each moment, how each job ends and where leaving goes are cards/hold.ts's. On an iPhone a card is
// read only under Apple's sheet: the screen opens it, tells
// it each step and how the hold ended, and offers a button whenever it has closed; what it tells it is hold.ts's too.
import { useKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { addCard } from '../cards/add';
import { adoptCard } from '../cards/adopt';
import {
  ADD_BAR, addIntro, confirmingAfter, endMessage, HOLD_TITLES, holdButton, holdLocked, holdNames, holdParams, holdResult, holdSheet, holdSteps, holdView, leaveTo, sheetOpens, UNLOCK_FIRST,
  wipeIntro,
  type HoldEvent, type HoldOutcome, type HoldView,
} from '../cards/hold';
import { isHoldPress } from '../cards/holdPress';
import { describeError } from '../cards/labels';
import { repointCard } from '../cards/repoint';
import { wipeCard } from '../cards/wipe';
import type { Tag } from '../native/nfc';
import { TagLostError } from '../ntag424/apdu';
import { Ntag424 } from '../ntag424/card';
import { useCardDeps, useServer } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { HoldPicture } from '../ui/cards';
import { screenLock, useLockKind } from '../ui/lock';
import { lockName } from '../ui/lockName';
import { confirmView } from '../money/view';
import { useAmountView } from '../ui/amountView';
import { ResultPage, StepBar } from '../ui/money';
import { DoneFold, Progress } from '../ui/setup';
import { Body, Button, Callout, ErrorText, goBack, Panel, Screen, Title, WarnText } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';
import { SmallCard } from '../ui/wallet';
import { colourOf } from '../wallet/colours';

const log = (event: object) => console.log('CARDAPP-CARD', JSON.stringify(event));

export default function CardScreen() {
  useKeepAwake(); // a card op is a few seconds of holding still; don't let the screen lock
  const allowed = useRouteGuard('/card');
  const sv = useServices();
  const deps = useCardDeps();
  const { snap } = useServer();
  const look = useAmountView();
  const link = useLocalSearchParams<{ op?: string; id?: string; name?: string; randomUid?: string; press?: string }>();
  // Fixed when the screen opens: a link that changes the params of this mounted screen
  // must not turn an unlocked re-point into a job that skips the screen lock, or a wipe into another card's.
  const [params] = useState(() => holdParams(link));
  const op = params?.op ?? 'add';
  const id = params?.id;
  // The name of the card the screen was opened for, from the card list; an add's and an add back's was just typed.
  // sent: the one the server is given with the card held, a typed name only (cards/hold.ts holdNames).
  const row = id ? snap.cards?.find((c) => c.id === id) : undefined;
  const { shown: name, sent } = holdNames(params, row?.name);
  /** What the wallet listed on the card when the screen opened: a wipe's result says where it went. */
  const [balanceMsat] = useState(() => (id ? (snap.wallet?.cards.find((c) => c.id === id)?.balanceMsat ?? null) : null));
  const [unlocked, setUnlocked] = useState(!holdLocked(op));
  const [done, setDone] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ text: string; again: boolean } | null>(null);
  const [outcome, setOutcome] = useState<HoldOutcome | null>(null);
  /** The card an add, a finished add or an add back made active: its photo step comes next. */
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);
  /** A hold has reported a step: from its check on, the card may have been written or the server told. */
  const [reported, setReported] = useState(false);
  const [foldOpen, setFoldOpen] = useState(false);
  const busy = useRef(false);
  const asking = useRef(false);
  /** The card whose add stopped at its last call on this screen: the next hold may find the server took it (cards/hold.ts confirmingAfter). */
  const confirming = useRef<string | null>(null);
  // Apple's sheet, where cards are read in a session (null on Android, which reads them all the time).
  const session = sv.nfc.session;
  const [sheet, setSheet] = useState(() => session?.state() ?? null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const focused = useIsFocused();
  const opened = useRef(false);
  // A press in the app led here, or was made here (the unlock): a link that opened the screen is not one, and never raises Apple's sheet.
  const [pressed, setPressed] = useState(() => isHoldPress(link.press));
  const moment = useRef<HoldView['moment']>('lock');
  const steps = holdSteps(op, params?.randomUid ?? false);
  /** Tells the sheet what happened, if it has anything to hear. A press while a sheet is up or still going asks for nothing. */
  const tell = (e: HoldEvent) => {
    if (!session) return;
    const c = holdSheet(e, { name, steps });
    if (!c) return;
    if (c.call === 'close') session.close();
    else if (c.call !== 'open') session[c.call](c.line);
    else if (session.state() === 'none') {
      // iOS may refuse a sheet (it is busy, or still closing the last): its words show as a refusal, the button on.
      session.open(c.line).catch((err) => {
        setSheet(session.state());
        setMessage({ text: err instanceof Error ? err.message : String(err), again: false });
      });
    }
    setSheet(session.state());
  };
  const telling = useRef(tell);
  telling.current = tell;

  // A wipe with no card to wipe: only a link can ask for one.
  useEffect(() => {
    if (allowed && !params) router.dismissTo('/home');
  }, [allowed, params]);

  const lock = useLockKind();
  // The page before the lock: none for a re-point, which asks for none.
  const intro =
    op === 'wipe'
      ? { ...wipeIntro({ name, state: row?.state, balanceMsat, unreachable: snap.unreachable, lock: lockName(lock) }, confirmView(look.view), look.rated), needs: 'wiping a card', button: 'Unlock to wipe' }
      : op === 'repoint'
        ? null
        : { ...addIntro({ op, name, lock: lockName(lock) }), needs: 'adding a card', button: 'Unlock to add' };

  // The screen lock, for every job but a re-point. Set before the first await: a double tap asks once.
  const unlock = async () => {
    if (asking.current || !intro) return;
    asking.current = true;
    try {
      const why = await screenLock(intro.prompt, intro.needs);
      if (why) return setMessage({ text: why, again: false });
      setMessage(null);
      setPressed(true);
      setUnlocked(true);
    } finally {
      asking.current = false;
    }
  };

  // An add asks for the lock as the screen opens, once, when a press in the app led here (the name screen's
  // Continue, Finish setup): a link that opened it is not one, and its page waits for the button.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (!allowed || !params || op === 'wipe' || unlocked || !pressed || askedOnOpen.current) return;
    askedOnOpen.current = true;
    void unlock();
  }, [allowed, params, op, unlocked, pressed]);

  // The app going to the background locks the job again: whoever has the phone when it comes back is asked for the
  // lock at the page's button, as on a screen a link opened. Not when it is only inactive (Face ID, Apple's sheet),
  // nor while the lock is being asked for (Android's PIN screen, its own activity, may send the app to the background).
  useEffect(() => {
    if (!holdLocked(op)) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' && !asking.current) setUnlocked(false);
    });
    return () => sub.remove();
  }, [op]);

  const onTag = async (tag: Tag) => {
    if (!busy.current && params && !unlocked && !outcome) {
      setMessage({ text: UNLOCK_FIRST, again: false });
      return void tag.close();
    }
    if (busy.current || !deps || !params || !unlocked || outcome) return void tag.close();
    if (!tag.transceive) {
      setMessage({ text: "That isn't a card this app can use.", again: true });
      tell({ on: 'not-a-card' });
      return;
    }
    busy.current = true;
    setRunning(true);
    setMessage(null);
    setDone([]);
    setFoldOpen(false);
    // uid: the length of the id the phone saw, 7 for the card's own and 4 for a random one (its ID is hidden).
    log({ op, uid: tag.uid.length });
    tell({ on: 'card' });
    const reported: string[] = [];
    let cardId: string | null = null;
    const onStep = (step: string, id?: string) => {
      reported.push(step);
      if (id) cardId = id;
      setDone((d) => [...d, step]);
      setReported(true);
      log({ op, step });
      tell({ on: 'step', done: reported });
    };
    try {
      const card = new Ntag424(tag.transceive);
      if (op === 'wipe') {
        const r = await wipeCard(card, deps, { only: { id: id!, name: name || undefined }, onStep });
        setOutcome({ op, name, serverTold: r.serverTold, local: r.local, balanceMsat });
      } else if (op === 'repoint') {
        const c = await repointCard(card, deps, { onStep });
        setOutcome({ op, name: c.name });
      } else if (op === 'adopt') {
        const c = await adoptCard(card, deps, { name: sent, onStep });
        setAdded({ id: c.id, name: c.name });
        setOutcome({ op, name: c.name });
      } else {
        const c = await addCard(card, tag.uid, deps, { name: sent, randomUid: params.randomUid, onStep, confirming: confirming.current ?? undefined });
        if (c.state === 'active') setAdded({ id: c.id, name: c.name });
        setOutcome({ op, name: c.name, active: c.state === 'active' });
      }
      tell({ on: 'finished', op });
    } catch (e) {
      log({ op, error: e instanceof Error ? e.name : 'error', sw: (e as { sw?: number }).sw });
      const why = describeError(e);
      setMessage(why);
      confirming.current = op === 'add' || op === 'finish-add' ? confirmingAfter({ done: reported, id: cardId, again: why.again, before: confirming.current }) : null;
      tell({ on: 'stopped', lost: e instanceof TagLostError, text: why.text });
    } finally {
      busy.current = false;
      setRunning(false);
      await tag.close();
    }
  };
  const handler = useRef(onTag);
  handler.current = onTag;
  useFocusEffect(
    useCallback(() => {
      const release = sv.nfcSlot.claim((t) => void handler.current(t));
      return () => {
        release();
        telling.current({ on: 'leave' });
      };
    }, [sv]),
  );

  const v = holdView({ name, steps, unlocked, running, done, message, finished: !!outcome, sessions: !!session });
  moment.current = v.moment;
  // The sheet opens by itself the first time the screen waits for a card (hold.ts sheetOpens): on arriving, for a
  // wipe once the lock has passed and the app is active again, and only when the last sheet has gone.
  const opens = sheetOpens({ session: sheet, ready: allowed && !!deps && !!params, moment: v.moment, focused, active, opened: opened.current, pressed });
  useEffect(() => {
    if (!opens) return;
    opened.current = true;
    telling.current({ on: 'waiting' });
  }, [opens]);
  useEffect(() => {
    if (!session) return;
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    // An end the screen did not ask for: only iOS's own reason for ending a waiting sheet shows (hold.ts endMessage).
    const stop = session.onEnd((e) => {
      setSheet(session.state());
      const m = endMessage(e, moment.current);
      if (m) setMessage(m);
    });
    // An end reported between this screen's first render and this listening (it arrived as the last sheet went) is caught up with here.
    setSheet(session.state());
    return () => {
      sub.remove();
      stop();
    };
  }, [session]);

  // Back to the wallet with the stack cut back to it: one wallet, whichever screen the flow was opened from.
  const toWallet = () => router.dismissTo('/home');
  const leave = () => {
    const to = leaveTo({ reported, running });
    if (to === 'back') goBack();
    if (to === 'wallet') toWallet();
  };
  // A result page's Back is the wallet (on Card added that passes the photo step by); else Back is ← and Cancel.
  useAndroidBack(() => {
    if (outcome) toWallet();
    else leave();
    return true;
  });

  if (!allowed || !deps || !params) return <Screen busy />;
  const button = holdButton(v, sheet);
  // The button opens the sheet again; after a refusal it also clears the panel, as a new card does.
  const press = () => {
    if (v.moment !== 'waiting' && v.moment !== 'stopped' && v.moment !== 'refused') return;
    if (v.moment === 'refused') setMessage(null);
    tell({ on: 'press', moment: v.moment });
  };
  const bar = op !== 'wipe' && op !== 'repoint' && <StepBar names={ADD_BAR} at={1} />;

  if (outcome) {
    const r = holdResult(outcome, confirmView(look.view), look.rated);
    const onDone = () => {
      if (r.next === 'photo' && added) router.replace({ pathname: '/card-photo', params: { id: added.id, step: r.step, name: added.name } });
      else toWallet();
    };
    return (
      <Screen title={HOLD_TITLES[op]}>
        {bar}
        <ResultPage view={r.view} onDone={onDone} done={r.button} />
      </Screen>
    );
  }

  const fold = 'fold' in v && v.fold && (
    <DoneFold summary={v.fold.summary} rows={v.fold.rows.map((label) => ({ label, line: null }))} open={foldOpen} onToggle={() => setFoldOpen(!foldOpen)} />
  );
  return (
    <Screen title={HOLD_TITLES[op]} back={leave}>
      {bar}
      {v.moment === 'lock' && intro && (
        <>
          {row && (
            <View style={layout.face}>
              <SmallCard name={row.name || 'Unnamed card'} colour={colourOf(snap.cards ?? [], row.id)} photo={snap.photos[row.id]} dim={row.state === 'frozen'} />
            </View>
          )}
          <Title>{intro.lead}</Title>
          <Body>{intro.body}</Body>
          <Body muted>{intro.note}</Body>
          {message && <ErrorText>{message.text}</ErrorText>}
          <Button title={intro.button} kind={op === 'wipe' ? 'danger' : undefined} onPress={() => void unlock()} />
        </>
      )}
      {v.moment !== 'lock' && v.moment !== 'finished' && <HoldPicture pose={v.picture} top={!!session} />}
      {/* One live region for the large line and the panels, kept mounted from waiting to refused: a change inside
          it is read (a stop and its reason, without a swipe); a region that appears with its text may not be. */}
      {v.moment !== 'lock' && (
        <View accessibilityLiveRegion="polite">
          {(v.moment === 'waiting' || v.moment === 'writing') && <Title>{v.lead}</Title>}
          {v.moment === 'stopped' && (
            <Callout>
              <WarnText>{v.reason}</WarnText>
            </Callout>
          )}
          {v.moment === 'refused' && (
            <Panel tone="error">
              <Body>{v.reason}</Body>
            </Panel>
          )}
        </View>
      )}
      {v.moment === 'waiting' && <Body muted>{v.note}</Body>}
      {(v.moment === 'writing' || v.moment === 'stopped') && v.progress && (
        <Progress text={v.progress.text} n={v.progress.n} of={v.progress.of} label={v.progress.label} stopped={v.progress.stopped} />
      )}
      {v.moment === 'writing' && <Body>{v.line}</Body>}
      {fold}
      {button && <Button title={button.title} onPress={press} disabled={!button.on} />}
      <Button title="Cancel" kind="secondary" onPress={leave} disabled={running} />
    </Screen>
  );
}

const layout = StyleSheet.create({
  face: { alignItems: 'center' },
});
