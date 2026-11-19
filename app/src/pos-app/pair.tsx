// Pair: the phone is paired by a code Karto Wallet shows. The code comes one of two
// ways. This app's scanner read it: it is handed over in memory (pos.scanned) and used at once. Or a link brought
// it (kartopos://pair?host=…&code=…, which the router opens as this screen with the link's parts): any app or web
// page on the phone can send one, so the person is asked first, with the server it names. On a phone that is
// already paired only the scanner's code asks (the old shop or the new): a link is refused, and the screen says how
// to unpair. Android hands a link over again whenever it remakes the app, so a link the person has answered, or
// that was refused, is remembered (PosStore.answered): on a paired phone it opens the app as its icon does, on one
// that isn't the plain page says the code is spent. Only a pairing link reaches this screen, or any, from outside
// (+native-intent.tsx). pos/pairing.ts has the words and the rule, and does the pairing.
import { Redirect, router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePos } from '../pos/app';
import { PosClient } from '../pos/client';
import { linkOf } from '../pos/links';
import { alreadyPaired, ANSWER_AFTER_MS, canAnswer, codeInHand, codeKey, linkQuestion, linkRefused, PAIR_WORDS, pairStep, pairWith, SPENT_CODE } from '../pos/pairing';
import { Body, Button, ErrorText, Screen, Small, Title, WarnText } from '../ui/ui';

export default function Pair() {
  const pos = usePos();
  const params = useLocalSearchParams<{ host?: string | string[]; code?: string | string[] }>();
  // The scanner's code, taken once when the screen opens; a link's, as the router has it now (one whose parts are
  // wrong is dropped): it may come while this screen is already in front.
  const [scanned] = useState(() => pos.scanned.current);
  useEffect(() => {
    pos.scanned.current = null;
  }, [pos]);
  const host = typeof params.host === 'string' ? params.host : '';
  const code = typeof params.code === 'string' ? params.code : '';
  const linked = useMemo(() => {
    const l = linkOf('pair', { host, code });
    return l?.kind === 'pair' ? { host: l.host, code: l.code } : null;
  }, [host, code]);
  const inHand = codeInHand(scanned, linked);
  const key = codeKey(inHand);

  // Whether a link was answered before: read each time this screen comes to the front or the link changes; unknown until then.
  const linkCode = inHand && !inHand.scanned ? inHand.link.code : null;
  const [read, setRead] = useState<{ code: string; answered: boolean } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!linkCode) return;
      let on = true;
      pos.store.answered(linkCode).then((answered) => on && setRead({ code: linkCode, answered }), () => on && setRead({ code: linkCode, answered: false }));
      return () => {
        on = false;
      };
    }, [linkCode, pos.store]),
  );
  const answered = linkCode ? (read?.code === linkCode ? read.answered : undefined) : false;
  const given = inHand && { ...inHand, answered };
  /** The person answered this link: Android may hand it over again, and it isn't asked twice. */
  const answer = async () => {
    if (linkCode) await pos.store.markAnswered(linkCode).catch(() => undefined);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The code this screen has used or the person turned down, and the one it began pairing with by itself.
  const [usedKey, setUsedKey] = useState('');
  const started = useRef('');
  const used = key !== '' && usedKey === key;

  const step = pos.paired === undefined || answered === undefined ? 'wait' : pairStep(pos.paired, given, used, pos.sale !== null);
  // A question can't be answered until it has been there to see, unchanged, for a second: a link can put it under
  // a finger, or leave it waiting behind another screen or in the app while that isn't showing.
  const focused = useIsFocused();
  const [open, setOpen] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setOpen(s === 'active'));
    return () => sub.remove();
  }, []);
  const paired = pos.paired ? `${pos.paired.host} ${pos.paired.name}` : '';
  const question = focused && open && (step === 'ask' || step === 'choose') ? `${step} ${key} ${paired}` : '';
  const shown = useRef<{ key: string; sinceMs: number } | null>(null);
  const [armed, setArmed] = useState('');
  useEffect(() => {
    shown.current = question === '' ? null : { key: question, sinceMs: Date.now() };
    if (question === '') return;
    const timer = setTimeout(() => setArmed(question), ANSWER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [question]);
  const ready = question !== '' && armed === question;

  /** by: a press of the question's button, held to the second's wait; the scanner's own code needs no press. */
  const pair = async (by: 'press' | 'scan' = 'press') => {
    if (!given || busy) return;
    if (by === 'press' && (question === '' || !canAnswer(shown.current, question, Date.now()))) return;
    setBusy(true);
    setError(null);
    await answer();
    const was = pos.paired;
    // The old shop is told by a client of its own: its answer to a phone it has removed is no news here.
    const old = was ? { host: was.host, forget: () => new PosClient({ fetch: pos.fetch, host: was.host, key: pos.key }).forget() } : undefined;
    const out = await pairWith({ fetch: pos.fetch, key: pos.key, store: pos.store, old }, given.link);
    setUsedKey(key);
    setBusy(false);
    if (out.ok) {
      pos.setPaired({ host: given.link.host, name: out.name, wallet: out.wallet });
      router.replace('/till');
    } else setError(out.text);
  };

  // A link that came while a sale is open: answered for good, and the sale is in front again.
  useEffect(() => {
    if (step !== 'in-sale') return;
    void answer().then(() => (router.canGoBack() ? router.back() : router.replace('/sale')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, key]);
  // A link refused on a paired phone: answered for good, so it isn't put to the person again.
  useEffect(() => {
    if (step === 'refused') void answer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, key]);
  useEffect(() => {
    if (step === 'pair' && started.current !== key) {
      started.current = key;
      void pair('scan');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, key]);

  if (step === 'wait') return <Screen busy />;
  if (step === 'stale') return <Redirect href="/" />;
  if (step === 'in-sale') return <Screen busy />;
  if (busy || step === 'pair') return <Screen title={PAIR_WORDS.title} busy busyText={PAIR_WORDS.pairing} />;
  if (given && step === 'ask') {
    const w = linkQuestion(given.link.host);
    return (
      <Screen title={PAIR_WORDS.title}>
        <Title>{w.line}</Title>
        <Body>{w.why}</Body>
        <Button title={w.pair} onPress={() => void pair()} disabled={!ready} />
        <Button title={w.no} kind="secondary" onPress={() => void answer().then(() => setUsedKey(key))} />
      </Screen>
    );
  }
  if (pos.paired && step === 'refused') {
    const w = linkRefused(pos.paired);
    return (
      <Screen title={PAIR_WORDS.title}>
        <Body>{w.line}</Body>
        <Body>{w.why}</Body>
        <Button title={w.back} onPress={() => router.replace('/till')} />
      </Screen>
    );
  }
  if (given && pos.paired && step === 'choose') {
    const w = alreadyPaired(pos.paired, given.link.host);
    return (
      <Screen title={PAIR_WORDS.title}>
        <Body>{w.line}</Body>
        <Body>{w.to}</Body>
        <Button title={w.pair} onPress={() => void pair()} disabled={!ready} />
        <Button title={w.keep} kind="secondary" onPress={() => void answer().then(() => router.replace('/till'))} />
      </Screen>
    );
  }
  return (
    <Screen title={PAIR_WORDS.title}>
      <Title>{PAIR_WORDS.heading}</Title>
      <Body>{PAIR_WORDS.how}</Body>
      {error && <ErrorText>{error}</ErrorText>}
      {step === 'spent' && <WarnText>{SPENT_CODE}</WarnText>}
      <Button title={PAIR_WORDS.scan} onPress={() => router.push('/scan')} />
      {pos.paired && <Button title="Back to the till" kind="secondary" onPress={() => router.replace('/till')} />}
      <Small>{PAIR_WORDS.limits}</Small>
    </Screen>
  );
}
