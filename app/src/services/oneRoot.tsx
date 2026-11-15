// Wraps every root React Native starts (index.ts): only the newest draws the
// app (see rootSlot.ts).
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RootSlot } from './rootSlot';

const roots = new RootSlot();

export function OneRoot({ children }: { children?: ReactNode }) {
  const [mine] = useState(() => roots.take());
  const newest = useSyncExternalStore(roots.subscribe, roots.newest);
  useEffect(() => roots.mounted(), []);
  return mine === newest ? children : null;
}
