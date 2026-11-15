// The Backups page, from Settings' Backups row and the wallet's backup banners:
// how the backups stand, what needs the person (with Pair this iPhone again where another phone's restore unpaired
// an iPhone), and Export backups. backupsCards says what shows; ServerWatch's check (backup/panel.ts) does the work.
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { exportBackups, phoneFiles } from '../backup/files';
import { useWatcher } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { PairAgain } from '../ui/PairAgain';
import type { Theme } from '../ui/theme';
import { useStyles } from '../ui/useTheme';
import { Body, Button, ErrorText, Panel, Screen } from '../ui/ui';
import { backupsCards } from '../wallet/backupsCards';

export default function Backups() {
  const allowed = useRouteGuard('/backups');
  const { snap } = useWatcher(allowed);
  const sv = useServices();
  const s = useStyles(makeStyles);
  const files = useMemo(phoneFiles, []);
  const [exported, setExported] = useState<string | null>(null);

  const exportAll = async () => {
    setExported(null);
    try {
      const n = await exportBackups(files);
      if (n !== null) setExported(`Exported ${n} ${n === 1 ? 'backup' : 'backups'}, still encrypted: your recovery phrase opens them.`);
    } catch (e) {
      setExported(`The export stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!allowed) return <Screen busy back />;
  const c = backupsCards(snap.backups, { outlivesApp: sv.phrase.outlivesApp });
  return (
    <Screen title="Backups" back>
      <Panel tone={c.state.tone} title={c.state.title}>
        {c.lines.map((l) => (
          <Body key={l} muted>
            {l}
          </Body>
        ))}
        {c.note === 'unreachable' && <Body muted>Showing what this phone keeps.</Body>}
        {c.note === 'no-api' && (
          <Body muted>
            Update it on the{' '}
            <Text style={s.link} accessibilityRole="link" onPress={() => router.push('/server')}>
              Server page
            </Text>
            .
          </Body>
        )}
      </Panel>
      <Body muted>
        Your server makes encrypted copies of its cards and balances, and this phone keeps them, so a new server can take over if this one is lost.
      </Body>
      {c.problems.map((p, i) => (
        <Panel key={p} tone="error">
          <Body>{p}</Body>
          {/* Another phone's restore is the first problem when it is one: the way back sits with it. */}
          {c.pairAgain && i === 0 && <PairAgain />}
        </Panel>
      ))}
      <Panel title="Export">
        <Body muted>Copy the backups off this phone, to a computer or a drive. They stay encrypted: only your recovery phrase opens them.</Body>
        <Button title="Export backups" kind="secondary" onPress={exportAll} />
        {c.failure && <ErrorText>{c.failure}</ErrorText>}
        {exported && <Body muted>{exported}</Body>}
      </Panel>
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    link: { color: t.accentText, textDecorationLine: 'underline' },
  });
