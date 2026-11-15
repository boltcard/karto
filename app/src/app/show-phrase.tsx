// Settings › Recovery phrase: the screen lock first; only
// then are the words read from the secure store, into this screen's state and
// nowhere else. Numbered, not selectable, no Copy, no screenshots. Done,
// leaving the screen or the app leaving the foreground drops them, and
// showing them again asks for the lock again. Nothing logs them.
import { usePreventScreenCapture } from 'expo-screen-capture';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { SHOW_PHRASE, wordColumns } from '../onboarding/phrase';
import { useRouteGuard, useServices } from '../services/services';
import { screenLock } from '../ui/lock';
import { Body, Button, Callout, ErrorText, Screen, Small, Words } from '../ui/ui';

export default function ShowPhrase() {
  usePreventScreenCapture();
  const allowed = useRouteGuard('/show-phrase');
  const sv = useServices();
  const [words, setWords] = useState<{ n: number; word: string }[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asking = useRef(false);
  // Counts each drop: a read still under way when the words are dropped shows nothing.
  const drops = useRef(0);

  const drop = useCallback(() => {
    drops.current += 1;
    setWords(null);
  }, []);
  useFocusEffect(
    useCallback(() => {
      const sub = AppState.addEventListener('change', (s) => s !== 'active' && drop());
      return () => {
        sub.remove();
        drop();
      };
    }, [drop]),
  );

  // Set before the first await: a double tap asks for the lock once.
  const show = async () => {
    if (asking.current) return;
    asking.current = true;
    setError(null);
    try {
      const why = await screenLock('Show your recovery phrase', 'showing the phrase');
      if (why) return setError(why);
      // Counted from after the lock: its PIN screen may take the app out of the foreground for a moment.
      const at = drops.current;
      const phrase = await sv.phrase.get();
      if (at !== drops.current) return;
      if (!phrase) return setError('This phone holds no recovery phrase.');
      setWords(wordColumns(phrase));
    } catch (e) {
      setError(`Couldn't read the recovery phrase: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      asking.current = false;
    }
  };

  const done = () => {
    drop();
    if (router.canGoBack()) router.back();
    else router.replace('/home'); // opened by a link: nothing to go back to
  };

  if (!allowed) return <Screen busy />;
  if (!words) {
    return (
      <Screen title={SHOW_PHRASE.band} back>
        <Body>{SHOW_PHRASE.intro}</Body>
        <Callout>
          <Body>{SHOW_PHRASE.warning}</Body>
        </Callout>
        <Button title={SHOW_PHRASE.button} onPress={show} />
        {error && <ErrorText>{error}</ErrorText>}
      </Screen>
    );
  }
  return (
    <Screen title={SHOW_PHRASE.band} back={done}>
      <Body>{SHOW_PHRASE.write}</Body>
      <Words columns={words} />
      <Small>{SHOW_PHRASE.foot}</Small>
      <Button title="Done" onPress={done} />
    </Screen>
  );
}
