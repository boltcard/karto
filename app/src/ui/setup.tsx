// The setup screens' own parts: where a run of steps stands, the
// line under a step's heading, the word check's choices, the folded Done line, Welcome's numbers, the country
// search and a count. Colours from the theme; what each shows is decided by pure functions
// (onboarding/progress.ts, onboarding/phrase.ts).
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Icon } from './icons';
import { partLook } from './look';
import { alpha, AMOUNT, TYPE, type Theme } from './theme';
import { useStyles, useTheme } from './useTheme';

/**
 * Where a run of steps stands: text ("Step 4 of 7", "Word 2 of 3") over a bar with a part for each step, those up
 * to n in orange. stopped (a hold whose card moved away): part n, where it stopped, is amber
 * (look.ts partLook). One element for TalkBack, read once as label.
 */
export function Progress({ text, n, of, label, stopped = false }: { text: string; n: number; of: number; label: string; stopped?: boolean }) {
  const s = useStyles(makeStyles);
  return (
    <View style={layout.progress} accessible accessibilityRole="text" accessibilityLabel={label}>
      <Text style={s.progressText}>{text}</Text>
      <View style={layout.bar}>
        {Array.from({ length: of }, (_, i) => {
          const look = partLook(i, n, stopped);
          return <View key={i} style={[s.part, look === 'done' && s.partDone, look === 'stopped' && s.partStopped]} />;
        })}
      </View>
    </View>
  );
}

/** The line under a step's heading: what it waits for or is doing, a small spinner before it while Karto works. */
export function StatusLine({ text, spinning }: { text: string; spinning: boolean }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={layout.status}>
      {spinning && <ActivityIndicator size="small" color={t.muted} />}
      <Text style={s.statusText}>{text}</Text>
    </View>
  );
}

/**
 * The word check's four choices, two to a row: outlined, the picked one orange (seen while the third is saved).
 * A tap is the answer, so they are buttons for TalkBack.
 */
export function WordChoices({ choices, picked, onPick, disabled }: { choices: string[]; picked: string | null; onPick: (word: string) => void; disabled?: boolean }) {
  const s = useStyles(makeStyles);
  return (
    <View style={layout.choices}>
      {choices.map((word) => {
        const on = word === picked;
        return (
          <Pressable
            key={word}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: !!disabled }}
            onPress={() => onPick(word)}
            disabled={disabled}
            style={({ pressed }) => [s.choice, on && s.choiceOn, pressed && layout.dim]}
          >
            <Text selectable={false} style={[s.choiceText, on && s.choiceTextOn]}>
              {word}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * What is done, at the foot of the setup screen: one line ("Done: country, email, order") that unfolds into a panel
 * with a row for each finished step, its label and what it settled (onboarding/progress.ts doneSummary, doneSteps).
 */
export function DoneFold({ summary, rows, open, onToggle }: { summary: string; rows: { label: string; line: string | null }[]; open: boolean; onToggle: () => void }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={layout.fold}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [layout.foldLine, pressed && layout.dim]}
      >
        <Icon name="check" colour={t.ok} size={18} />
        <Text style={s.foldText}>{summary}</Text>
        <Icon name={open ? 'up' : 'down'} colour={t.muted} size={20} />
      </Pressable>
      {open && (
        <View style={s.foldPanel}>
          {rows.map((r, i) => (
            <View key={r.label} style={[layout.foldRow, i > 0 && s.divider]} accessible accessibilityRole="text" accessibilityLabel={r.line === null ? r.label : `${r.label}, ${r.line}`}>
              <Text style={s.foldLabel}>{r.label}</Text>
              {r.line !== null && <Text style={s.foldRowLine}>{r.line}</Text>}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** A number in a small circle at the start of a row (Welcome's "What happens next"). Decoration: the rows read in order. */
export function NumberLead({ n }: { n: number }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.number} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={s.numberText}>{n}</Text>
    </View>
  );
}

/** Your country's search: a field as Field draws them, with a magnifier at its start. */
export function SearchField(props: TextInputProps) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={s.search}>
      <Icon name="search" colour={t.muted} size={20} />
      <TextInput
        {...props}
        style={s.searchInput}
        placeholderTextColor={t.muted}
        cursorColor={t.accent}
        selectionHandleColor={t.accent}
        selectionColor={alpha(t.accent, 0.4)}
      />
    </View>
  );
}

/** A count in small type under a field ("9 of 12 words"); over: red, when it has gone past what is wanted. */
export function Count({ children, over }: { children: string; over?: boolean }) {
  const s = useStyles(makeStyles);
  return <Text style={[s.count, over && s.countOver]}>{children}</Text>;
}

// A style that changes TYPE.body's or TYPE.small's fontSize sets its own lineHeight with it.
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    progressText: { ...TYPE.small, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted },
    part: { flex: 1, height: 4, borderRadius: 2, backgroundColor: t.line },
    partDone: { backgroundColor: t.accent },
    partStopped: { backgroundColor: t.warnLine },
    statusText: { ...TYPE.body, color: t.muted, flex: 1 },
    // 48 dp tall at the least: a word is picked with a thumb.
    choice: { flexBasis: '45%', flexGrow: 1, minHeight: 48, borderWidth: 1, borderColor: t.outline, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
    choiceOn: { backgroundColor: t.accent, borderColor: t.accent },
    choiceText: { ...TYPE.button, color: t.outlineText },
    choiceTextOn: { color: t.onAccent },
    foldText: { ...TYPE.small, color: t.muted, flex: 1 },
    foldPanel: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, overflow: 'hidden' },
    divider: { borderTopWidth: 1, borderTopColor: t.line },
    foldLabel: { ...TYPE.body, fontWeight: '600', color: t.text },
    foldRowLine: { ...TYPE.small, color: t.muted },
    number: { width: 26, height: 26, borderRadius: 13, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' },
    numberText: { ...TYPE.small, fontWeight: '700', color: t.text, ...AMOUNT },
    search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 6, paddingHorizontal: 12 },
    searchInput: { ...TYPE.body, fontSize: 18, lineHeight: 24, color: t.text, flex: 1, paddingVertical: 10 },
    count: { ...TYPE.small, color: t.muted, paddingHorizontal: 2 },
    countOver: { color: t.error },
  });

const layout = StyleSheet.create({
  progress: { gap: 6 },
  bar: { flexDirection: 'row', gap: 4 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dim: { opacity: 0.5 },
  fold: { gap: 8 },
  // 48 dp tall: the whole line is the press target.
  foldLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 4 },
  foldRow: { paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
});
