// Settings' and This PoS's line under the build label: what GitHub last said about a newer release (appUpdate.ts's
// updateLine), a link to the releases page when it names one. Nothing in a build that doesn't ask GitHub.
import { Linking, Pressable, StyleSheet } from 'react-native';
import { Small } from '../ui/ui';
import { RELEASES_PAGE, updateLine } from './appUpdate';
import { useUpdateStatus } from './useAppUpdate';

export function UpdateLine({ app }: { app: 'Karto Wallet' | 'Karto PoS' }) {
  const u = useUpdateStatus();
  const line = u && updateLine(u.status, u.current, app, Date.now());
  if (!line) return null;
  if (!line.link) return <Small>{line.text}</Small>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={line.text.replace(/ ›$/, '')}
      hitSlop={12}
      onPress={() => void Linking.openURL(RELEASES_PAGE).catch(() => {})}
      style={({ pressed }) => pressed && layout.dim}
    >
      <Small>{line.text}</Small>
    </Pressable>
  );
}

const layout = StyleSheet.create({ dim: { opacity: 0.5 } });
