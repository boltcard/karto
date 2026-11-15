// Send out's Recent list: the addresses last paid, each with
// when; a tap fills the field. Edit puts a remove button on each row, which takes it off at once and asks the server
// after; a refusal brings it back with the reason.
import { useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { RecentTo } from '../cardd/client';
import { whenText } from '../money/words';
import { ErrorText, GroupLabel, ListGroup, ListRow } from './ui';
import { useStyles } from './useTheme';
import { TYPE, type Theme } from './theme';

export function RecentList({ items, nowS, offsetMin, onPick, onRemove }: {
  items: RecentTo[];
  nowS: number;
  offsetMin: number;
  onPick: (to: string) => void;
  /** Rejects with the reason when the server refuses. */
  onRemove: (to: string) => Promise<void>;
}): ReactElement | null {
  const s = useStyles(makeStyles);
  const [editing, setEditing] = useState(false);
  // Taken off at once, before the server answers.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const shown = items.filter((i) => !gone.has(i.to));
  if (shown.length === 0) return error ? <ErrorText>{error}</ErrorText> : null;

  const remove = (to: string) => {
    setError(null);
    setGone((g) => new Set(g).add(to));
    if (shown.length === 1) setEditing(false);
    onRemove(to).catch((e: unknown) => {
      setGone((g) => {
        const back = new Set(g);
        back.delete(to);
        return back;
      });
      setError(`Couldn't remove it: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  return (
    <>
      <GroupLabel action={{ title: editing ? 'Done' : 'Edit', onPress: () => setEditing(!editing) }}>Recent</GroupLabel>
      <ListGroup>
        {shown.map((i, n) => {
          const line = `Paid ${whenText(i.paidAt, nowS, offsetMin)}`;
          return editing ? (
            <ListRow
              key={i.to}
              icon="send"
              name={i.shown}
              line={line}
              divider={n > 0}
              after={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${i.shown} from Recent`}
                  hitSlop={8}
                  onPress={() => remove(i.to)}
                  style={({ pressed }) => [s.remove, pressed && s.pressed]}
                >
                  <Text style={s.removeText}>✕</Text>
                </Pressable>
              }
            />
          ) : (
            <ListRow key={i.to} icon="send" name={i.shown} line={line} divider={n > 0} acts onPress={() => onPick(i.to)} />
          );
        })}
      </ListGroup>
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    remove: { width: 32, height: 32, borderRadius: 16, borderWidth: 1.5, borderColor: t.error, alignItems: 'center', justifyContent: 'center' },
    removeText: { ...TYPE.body, fontWeight: '700', color: t.error },
    pressed: { opacity: 0.5 },
  });
