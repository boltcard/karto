// The Hosting account's server panel on its page:
// how long the VM is paid for, whether it renews itself, what hosting pays for after
// that, what needs doing in amber, and what is wrong in red. wallet/accountView.ts hostingCard decides the words and the dot. Renew now is the
// page's pill, which opens ui/RenewSheet.tsx.
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState } from 'react-native';
import type { HostingStatus } from '../cardd/client';
import type { CardDeps } from '../cards/deps';
import { poll } from '../cards/poll';
import type { HostingCard } from '../wallet/accountView';
import { Body, ErrorText, Panel, WarnText } from './ui';

/**
 * cardd's hosting status while the page shows, read every 5 seconds; null before the first answer and while cardd
 * can't be reached. on: only Hosting's page asks. load: read it again now (after a renewal).
 */
export function useHostingStatus(deps: CardDeps | null, on: boolean): { status: HostingStatus | null; load: () => Promise<void> } {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const load = useCallback(async () => {
    if (deps && on) setStatus(await deps.cardd.hosting().catch(() => null));
  }, [deps, on]);
  useFocusEffect(
    useCallback(() => {
      if (!deps || !on) return;
      load();
      return poll(load, 5000, () => AppState.currentState === 'active');
    }, [deps, on, load]),
  );
  return { status, load };
}

export function HostingPanel({ card }: { card: HostingCard }) {
  return (
    <Panel tone={card.tone} title={card.title} flat>
      {card.lines.map((l) => (
        <Body key={l} muted>
          {l}
        </Body>
      ))}
      {card.warnings.map((x) => (
        <WarnText key={x}>{x}</WarnText>
      ))}
      {card.problems.map((p) => (
        <ErrorText key={p}>{p}</ErrorText>
      ))}
    </Panel>
  );
}
