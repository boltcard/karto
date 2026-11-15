// "I already have a recovery phrase" : the
// phrase goes in, then onboarding runs as usual. Its order step finds this
// phrase's paid VM on LNVPS and sets that up again instead of ordering one;
// with none left, onboarding becomes a rebuild.
import { usePreventScreenCapture } from 'expo-screen-capture';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { adoptPhrase, phraseProblem, wordCount } from '../onboarding/phrase';
import { useRouteGuard, useServices } from '../services/services';
import { Count } from '../ui/setup';
import { Body, Button, ErrorText, Field, Screen } from '../ui/ui';

/** Back to Welcome: no phrase is saved yet. With nothing behind (a link opened the screen), Welcome all the same. */
const toWelcome = () => (router.canGoBack() ? router.back() : router.replace('/welcome'));

export default function Restore() {
  usePreventScreenCapture();
  const allowed = useRouteGuard('/restore');
  const sv = useServices();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A tap here would be checked against the old server's deps: close it unread.
  useFocusEffect(useCallback(() => sv.nfcSlot.claim((t) => void t.close()), [sv]));

  const restore = async () => {
    const problem = phraseProblem(text);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await adoptPhrase(text, sv, { restoring: true });
      router.replace('/country');
    } catch (e) {
      setError(`Could not save the phrase: ${e instanceof Error ? e.message : e}`);
      setBusy(false);
    }
  };

  if (!allowed) return <Screen busy />;
  const words = wordCount(text);
  return (
    <Screen title="Recovery phrase" back={toWelcome}>
      <Body>Type your 12 words in order, with a space between each.</Body>
      <View style={layout.field}>
        <Field
          style={layout.tall}
          accessibilityLabel="Recovery phrase"
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          // Android: no suggestions, so the keyboard doesn't learn the words.
          keyboardType="visible-password"
          value={text}
          onChangeText={(t) => {
            setText(t);
            setError(null);
          }}
        />
        <Count over={words > 12}>{`${words} of 12 words`}</Count>
      </View>
      <Body muted>
        If a server bought with this phrase is still paid for, Karto Wallet sets this phone up for it. If none is, it rebuilds one: from a
        backup you exported, or from the phrase alone, which brings the money back but not how it was split between the cards.
      </Body>
      {error && <ErrorText>{error}</ErrorText>}
      {/*
        Off while fewer than twelve words are in. What is wrong with twelve or more (a word that isn't one, an order that makes no phrase,
        a thirteenth word) is said when it is pressed: past twelve it stays on, so a pasted list isn't left at a dead button.
      */}
      <Button title="Continue" onPress={restore} disabled={busy || words < 12} />
    </Screen>
  );
}

// Room for the 12 words, typed from the top.
const layout = StyleSheet.create({
  tall: { minHeight: 120, textAlignVertical: 'top' },
  field: { gap: 4 },
});
