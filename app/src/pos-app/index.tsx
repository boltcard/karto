// Start: a paired phone opens the till, one that isn't opens Pair.
import { Redirect } from 'expo-router';
import { usePos } from '../pos/app';
import { Screen } from '../ui/ui';

export default function Start() {
  const { paired } = usePos();
  if (paired === undefined) return <Screen busy />;
  return <Redirect href={paired ? '/till' : '/pair'} />;
}
