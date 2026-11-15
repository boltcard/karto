// Step 1: make 12 words, show them to be written
// down, and ask for 3 of them back, each picked from four. A tap on a word is the answer. A wrong pick shows the
// words again and starts the check afresh, with new positions: the check is there to get the paper right.
import { usePreventScreenCapture } from 'expo-screen-capture';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { newPhrase } from '../keys/derive';
import { adoptPhrase, afterPick, checkQuestions, missedLine, wordColumns, type CheckQuestion } from '../onboarding/phrase';
import { useRouteGuard, useServices } from '../services/services';
import { Progress, WordChoices } from '../ui/setup';
import { Body, Button, Callout, ErrorText, Screen, Title, Words } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';

/** Back to Welcome: the phrase isn't saved yet. With nothing behind (a link opened the screen), Welcome all the same. */
const toWelcome = () => (router.canGoBack() ? router.back() : router.replace('/welcome'));

export default function Phrase() {
  usePreventScreenCapture();
  const allowed = useRouteGuard('/phrase');
  const sv = useServices();
  const phrase = useMemo(() => newPhrase(), []);
  const [stage, setStage] = useState<'show' | 'check'>('show');
  // The check's questions and picks: made when it starts, and made again after a wrong word or a look at the words.
  const [questions, setQuestions] = useState<CheckQuestion[]>([]);
  const [picks, setPicks] = useState<(string | null)[]>([null, null, null]);
  const [at, setAt] = useState(0);
  /** The position (0-based) of the word picked wrong, named over the words. */
  const [missed, setMissed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startCheck = () => {
    setQuestions(checkQuestions(phrase));
    setPicks([null, null, null]);
    setAt(0);
    setMissed(null);
    setError(null);
    setStage('check');
  };
  const showWords = (miss: number | null = null) => {
    setMissed(miss);
    setError(null);
    setStage('show');
  };
  const pick = async (word: string) => {
    const result = afterPick(phrase, questions, picks, at, word);
    if (result.step === 'missed') return showWords(result.position);
    setPicks(result.picks);
    if (result.step === 'next') return setAt(result.at);
    // The third right word: the save. Should it fail, the word stays picked and a tap on it tries again.
    setError(null);
    setBusy(true);
    try {
      await adoptPhrase(phrase, sv);
      router.replace('/country');
    } catch (e) {
      setError(`Could not save the phrase: ${e instanceof Error ? e.message : e}\nTap the word again to try once more.`);
      setBusy(false);
    }
  };
  // Android's Back in the check shows the words again, as the arrow does; not while the phrase is being saved.
  useAndroidBack(() => {
    if (stage !== 'check') return false;
    if (!busy) showWords();
    return true;
  });

  if (!allowed) return <Screen busy />;
  if (stage === 'show') {
    return (
      <Screen title="Your recovery phrase" back={toWelcome}>
        <Callout>
          <Body>
            Write these 12 words on paper, in order, and keep the paper safe. They are the only way to get your server, cards and money back
            if this phone is lost. Anyone who has them can take the money.
          </Body>
        </Callout>
        {missed !== null && <ErrorText>{missedLine(missed)}</ErrorText>}
        <Words columns={wordColumns(phrase)} />
        <Button title="I have written them down" onPress={startCheck} />
      </Screen>
    );
  }
  const q = questions[at];
  const word = `Word ${at + 1} of ${questions.length}`;
  return (
    <Screen title="Check your words" back={() => !busy && showWords()}>
      <Progress text={word} n={at + 1} of={questions.length} label={word} />
      <Title>Which is word {q.position + 1} on your paper?</Title>
      <WordChoices choices={q.choices} picked={picks[at]} onPick={pick} disabled={busy} />
      {error && <ErrorText>{error}</ErrorText>}
      <Button title="Show the words again" kind="secondary" onPress={() => showWords()} disabled={busy} />
    </Screen>
  );
}
