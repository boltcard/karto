// A history line's own page: what it was, to or from
// whom, how much, what it cost, when, its proof, the person's note and cardd's own record. It draws the line the
// account page kept at once and fills in from GET …/transactions/{id}; money/payment.ts works out what it shows.
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CarddError, noTransactionRoutes, type Tx } from '../cardd/client';
import { moneyError } from '../money/format';
import { cutNote } from '../money/note';
import { openedLine } from '../money/openedLine';
import { paymentView, type PaymentState, type ProofRow } from '../money/payment';
import { useCardDeps, useServer } from '../services/server';
import { useRouteGuard } from '../services/services';
import { useAmountView } from '../ui/amountView';
import { PaymentAmount, ProofList, ReadBack } from '../ui/money';
import type { Theme } from '../ui/theme';
import { Body, Button, ErrorText, Field, GroupLabel, Label, Screen, Small } from '../ui/ui';
import { useStyles } from '../ui/useTheme';

/** How long "Saved" and "Copied" show. */
const WORD_MS = 2000;

type Timer = { current: ReturnType<typeof setTimeout> | null };
/** Runs fn in WORD_MS, in place of what timer was waiting to run. */
function later(timer: Timer, fn: () => void) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = setTimeout(fn, WORD_MS);
}

export default function Payment() {
  const allowed = useRouteGuard('/payment');
  const deps = useCardDeps();
  const { snap } = useServer();
  const s = useStyles(makeStyles);
  const look = useAmountView();
  const params = useLocalSearchParams<{ account?: string; tx?: string }>();
  const account = params.account ?? '';
  const id = Number(params.tx);
  const [line] = useState<Tx | null>(() => openedLine.get(account, id));
  const [state, setState] = useState<PaymentState>({ at: 'loading' });
  const [text, setText] = useState(line?.comment ?? '');
  /** The note as cardd last said it is. */
  const saved = useRef(line?.comment ?? '');
  /**
   * The trimmed text of the last save cardd took: the again-save runs before the field shows cardd's cleaned note,
   * so text cardd cleaned ("a  b" kept as "a b") isn't sent a second time.
   */
  const lastSent = useRef<string | null>(null);
  const [saveWord, setSaveWord] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // A save can answer after the page has gone (the save on leaving it): nothing is set on a page that isn't there.
  const mounted = useRef(true);
  const savedTimer: Timer = useRef(null);
  const copiedTimer: Timer = useRef(null);

  const load = useCallback(async () => {
    // A link with no account or no line's id: there is nothing to ask for.
    if (!account || !(Number.isInteger(id) && id > 0)) return setState({ at: 'gone' });
    if (!deps) return;
    // Read again on coming back (after a refund the sale says so): what the page shows stays meanwhile.
    setState((s) => (s.at === 'loaded' ? s : { at: 'loading' }));
    try {
      const detail = await deps.cardd.transaction(account, id);
      if (!mounted.current) return;
      // Never over what the person is typing: the details can answer while they are.
      const before = saved.current;
      saved.current = detail.comment ?? '';
      lastSent.current = null; // cardd's note now is the one to compare with
      setText((cur) => (cur === before ? saved.current : cur));
      setState({ at: 'loaded', detail });
    } catch (e) {
      if (!mounted.current) return;
      if (noTransactionRoutes(e)) return setState({ at: 'old-server' });
      if (e instanceof CarddError && e.status === 404) return setState({ at: 'gone' });
      // cardd answered, with an error: its words, not that it can't be reached.
      if (e instanceof CarddError) return setState({ at: 'failed', reason: moneyError(e) });
      setState({ at: 'unreachable' });
    }
  }, [deps, account, id]);
  // Each time the page comes to the front: a refund from it comes back here, and its sale is read again.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // One save at a time (Done on the keyboard fires both onSubmitEditing and onBlur). A save asked for while one is
  // on its way is made when that one answers, with the text as it is then: saveRef holds the latest render's save.
  const saving = useRef(false);
  const again = useRef(false);
  const save = useCallback(async () => {
    const typed = text;
    const note = typed.trim();
    if (!deps || state.at !== 'loaded') return;
    // Asked before the text is compared: saved.current is a moment old while a save is on its way, so text put back
    // to it then still differs from what that save will leave.
    if (saving.current) {
      again.current = true;
      return;
    }
    if (note === saved.current || note === lastSent.current) return;
    saving.current = true;
    const sent = deps.cardd.setComment(account, id, note);
    // The account page's history read waits for it (openedLine.settled).
    openedLine.saving = sent;
    try {
      const detail = await sent;
      saved.current = detail.comment ?? '';
      lastSent.current = note;
      // The account page's kept line carries the note too, for a page opened again before its history reloads.
      openedLine.put(account, detail);
      if (mounted.current) {
        // The field shows the note as cardd keeps it (trimmed, spaces collapsed), unless the person typed on meanwhile.
        setText((cur) => (cur === typed ? saved.current : cur));
        setSaveWord({ ok: true, text: 'Saved' });
        later(savedTimer, () => setSaveWord((w) => (w?.ok ? null : w)));
      }
    } catch (e) {
      if (mounted.current) setSaveWord({ ok: false, text: `Not saved: ${moneyError(e)}` });
    } finally {
      saving.current = false;
      if (openedLine.saving === sent) openedLine.saving = null;
      if (again.current) {
        again.current = false;
        void saveRef.current();
      }
    }
  }, [deps, state.at, text, account, id]);
  const saveRef = useRef(save);
  saveRef.current = save;
  // Leaving the page with an unsaved change saves it too; its outcome has nowhere to show then.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const timer of [savedTimer, copiedTimer]) if (timer.current) clearTimeout(timer.current);
      void saveRef.current();
    };
  }, [savedTimer, copiedTimer]);

  const copy = async (row: ProofRow) => {
    if (!row.full) return;
    try {
      await Clipboard.setStringAsync(row.full);
    } catch {
      return; // Nothing was copied, so "Copied" isn't said.
    }
    if (!mounted.current) return;
    setCopied(true);
    later(copiedTimer, () => setCopied(false));
  };

  if (!allowed) return <Screen busy back />;
  const v = paymentView(line, state, { nowS: Math.floor(Date.now() / 1000), offsetMin: -new Date().getTimezoneOffset(), account, cards: snap.cards ?? [], view: look.view, rated: look.rated });
  // "Saved" is said of the text in the field only: not once the person has typed past it. "Not saved" likewise only
  // while the field differs from what cardd keeps.
  const differs = text.trim() !== saved.current;
  const savedNow = !!saveWord?.ok && !differs;
  const notSaved = saveWord && !saveWord.ok && differs ? saveWord.text : null;
  return (
    <Screen title={v.title} back>
      {v.amount !== '' && <PaymentAmount msat={v.msat} sign={v.sign} now={v.now} incoming={v.incoming} status={v.status} paid={v.paid} />}
      {v.note.shown && (
        <>
          {/* "Saved" in muted beside the label, not part of it. */}
          <View accessibilityLiveRegion="polite" style={layout.labelRow}>
            <Label>Your note</Label>
            {savedNow && <Small>Saved</Small>}
          </View>
          <View>
            <Field
              accessibilityLabel="Your note"
              value={text}
              // Cut by code points, as cardd counts: maxLength counts UTF-16 units, an emoji as two.
              onChangeText={(t) => {
                const cut = cutNote(t);
                setText(cut);
                // Put back to what cardd keeps, a refusal is over: it doesn't come back for what is typed next.
                if (cut.trim() === saved.current) setSaveWord((w) => (w && !w.ok ? null : w));
              }}
              onBlur={save}
              onSubmitEditing={save}
              placeholder="Add a note"
              editable={v.note.editable}
              // Greyed while it can't take a note, as the app greys what is off: muted at full strength, on the page's ground.
              style={!v.note.editable && s.off}
              returnKeyType="done"
            />
            <Said>{notSaved && <ErrorText>{notSaved}</ErrorText>}</Said>
          </View>
          <Small>Only you see it. Kept on your server, in its backups.</Small>
        </>
      )}
      {v.facts.length > 0 && <ReadBack rows={v.facts} />}
      {v.factsNote && <Body muted>{v.factsNote}</Body>}
      {/* A till sale's refund: the button and where the money goes, Refunding… while on its way, the refund's own page, or an older server. */}
      {v.refund?.kind === 'button' && (
        <>
          <Button title="Refund this sale" kind="secondary" onPress={() => router.push({ pathname: '/refund', params: { account, tx: String(id) } })} />
          <Body muted>{v.refund.line}</Body>
        </>
      )}
      {v.refund?.kind === 'pending' && <Body muted>Refunding…</Body>}
      {v.refund?.kind === 'old-server' && <Body muted>Update server to refund sales.</Body>}
      {v.refundLink && (
        <Button
          title="Open the refund"
          kind="secondary"
          onPress={() => router.push({ pathname: '/payment', params: { account: v.refundLink!.account, tx: String(v.refundLink!.txId) } })}
        />
      )}
      {v.proof.length > 0 && (
        <>
          <GroupLabel>Proof</GroupLabel>
          <View>
            <ProofList rows={v.proof} onCopy={copy} />
            <Said>{copied && <Body muted>Copied</Body>}</Said>
          </View>
        </>
      )}
      {v.notice && <Body muted>{v.notice}</Body>}
      {v.retry && <Button title="Try again" kind="secondary" onPress={load} />}
      {v.record && <Small selectable>{v.record}</Small>}
    </Screen>
  );
}

/**
 * A word that comes and goes under what it is about ("Copied", "Not saved: …"): a live region kept mounted, so
 * TalkBack reads the word when it comes (one that appears with its text may not be read); empty, it takes no room.
 */
function Said({ children }: { children: ReactNode }) {
  return (
    <View accessibilityLiveRegion="polite" style={children ? layout.said : undefined}>
      {children}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({ off: { color: t.muted, backgroundColor: t.bg } });

const layout = StyleSheet.create({ said: { paddingTop: 12 }, labelRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 } });
