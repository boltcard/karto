// The result page both apps end a flow on:
// a ring with its mark, a large line, a muted one, and one button. It reaches nothing but the
// shared ui files, so Karto PoS can use it without Karto Wallet's code coming with it.
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from './icons';
import { toneColour } from './look';
import { AMOUNT, TYPE, type Theme } from './theme';
import { Button, Small } from './ui';
import { useStyles, useTheme } from './useTheme';

/** The result page: its ring's colour and mark, the large line and the muted one under it. */
export type ResultView = { tone: 'ok' | 'error' | 'warn'; mark: 'check' | 'cross' | 'dots' | 'clock'; title: string; line: string };

/**
 * How something ended (a send or a move: money/steps.ts resultView): a ring with its mark, a large line, a muted one, and Done.
 * done: the button's name, for the setup's ready page ("Open the wallet"). note: small words over the button (a
 * paired PoS phone's "if the other phone says…"). Without onDone the page has no button of its own (Karto PoS's
 * Card read, which holds the person for a while). label: what TalkBack announces, when the title and the line
 * read badly together.
 */
export function ResultPage({ view, onDone, done = 'Done', note, label }: { view: ResultView; onDone?: () => void; done?: string; note?: string; label?: string }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const colour = toneColour(view.tone, t) ?? t.muted;
  return (
    <>
      <View style={layout.result} accessible accessibilityLiveRegion="polite" accessibilityLabel={label ?? `${view.title}. ${view.line}`}>
        <View style={[s.ring, { borderColor: colour }]}>
          <Icon name={view.mark} colour={colour} size={30} />
        </View>
        <Text style={s.resultTitle}>{view.title}</Text>
        <Text style={s.resultLine}>{view.line}</Text>
      </View>
      {note !== undefined && <Small>{note}</Small>}
      {onDone && <Button title={done} onPress={onDone} />}
    </>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    ring: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' },
    resultTitle: { ...TYPE.title, color: t.text, textAlign: 'center', ...AMOUNT },
    resultLine: { ...TYPE.body, color: t.muted, textAlign: 'center' },
  });

const layout = StyleSheet.create({
  result: { alignItems: 'center', gap: 8, paddingVertical: 22 },
});
