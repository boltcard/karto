// The newer release a GitHub build should mention (appUpdate.ts): checked when the screen opens and each time the app
// comes back to the front, which asks GitHub at most once a day. Null in every other build.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { withTimeout } from '../lightning/lightning';
import { asksGithub, newerRelease } from './appUpdate';

const githubFetch = withTimeout((url, init) => fetch(url, init), 15_000);
// Metro inlines these two where they are written out in full.
const BUILD = { os: Platform.OS, release: process.env.EXPO_PUBLIC_KARTO_RELEASE, store: process.env.EXPO_PUBLIC_KARTO_STORE };

export function useAppUpdate(): string | null {
  const [newer, setNewer] = useState<string | null>(null);
  useEffect(() => {
    const current = Constants.expoConfig?.version;
    if (!asksGithub(BUILD) || !current) return;
    let live = true;
    const check = () =>
      void newerRelease(SecureStore, githubFetch, current, Date.now())
        .then((v) => live && setNewer(v))
        .catch(() => {});
    check();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && check());
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return newer;
}
