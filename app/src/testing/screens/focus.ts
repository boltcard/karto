// Expo Router's useFocusEffect for screen tests: the effect runs when the screen mounts, as it comes into focus,
// and again at refocus(), as when the person comes back to it from a screen it opened (Send out from the scanner).
// blur() is another screen opening over it: the effect's cleanup runs, and it waits for refocus().
import { useEffect, useState } from 'react';

const screens = new Set<(on: boolean) => void>();

export function useFocusEffect(effect: () => void | (() => void)) {
  const [focus, setFocus] = useState({ on: true, n: 0 });
  useEffect(() => {
    const set = (on: boolean) => setFocus((f) => ({ on, n: f.n + 1 }));
    screens.add(set);
    return () => void screens.delete(set);
  }, []);
  useEffect(() => (focus.on ? effect() : undefined), [effect, focus]);
}

/** Every screen still mounted comes into focus again. Call it inside act(). */
export function refocus() {
  for (const set of screens) set(true);
}

/** Every screen still mounted loses focus, as when a page opens over it. Call it inside act(). */
export function blur() {
  for (const set of screens) set(false);
}
