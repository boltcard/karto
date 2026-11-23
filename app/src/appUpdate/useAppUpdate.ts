// The newer release a GitHub build should mention (appUpdate.ts), from one checker the whole app shares. Home's
// banner and the till's link ask on opening, each time the app comes back to the front, and on a tick while it is in
// front (a till can sit in front all day), the hour's rhythm deciding when GitHub is asked: GitHub APKs only.
// Settings' and This PoS's line asks each time the page comes into view, no more than once a minute: GitHub APKs and
// .dev builds (showsLatest). Nothing in a Play or App Store build.
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { withTimeout, type FetchFn } from '../lightning/lightning';
import { asksGithub, newerOf, ON_OPEN, showsLatest, updateChecker, type Build, type KeyValue, type UpdateChecker, type UpdateStatus } from './appUpdate';

/** How often Home and the till give the hour's rhythm a chance while in front: GitHub is asked only when it is due. */
export const TICK_MS = 5 * 60 * 1000;

// Metro inlines these two where they are written out in full.
let build: Build = { os: Platform.OS, release: process.env.EXPO_PUBLIC_KARTO_RELEASE, store: process.env.EXPO_PUBLIC_KARTO_STORE };
let checker: UpdateChecker = updateChecker(SecureStore, withTimeout((url, init) => fetch(url, init), 15_000));

/** For screen tests (a test page is Platform 'web', which never asks): this build, store and GitHub. */
export function setUpdateCheckerForTests(b: Build, kv: KeyValue, f: FetchFn): void {
  build = b;
  checker = updateChecker(kv, f);
}

/** This app's version (app.json's), as the build lines on Settings and This PoS name it. */
export const appVersion = (): string | undefined => Constants.expoConfig?.version;
/** This app's version when it is a build whose Home asks GitHub; null otherwise. */
const asking = (): string | null => (asksGithub(build) && appVersion()) || null;
/** This app's version when it is a build whose Settings or This PoS names the latest release; null otherwise. */
const showing = (): string | null => (showsLatest(build) && appVersion()) || null;
const useStatus = (): UpdateStatus => useSyncExternalStore(checker.subscribe, checker.status);

export function useAppUpdate(): string | null {
  const status = useStatus();
  useEffect(() => {
    const current = asking();
    if (!current) return;
    const c = checker;
    const ask = () => void c.check(current, Date.now()).catch(() => {});
    ask();
    // Not tied to focus: Home under Settings and the till under This PoS keep ticking. That is harmless (the hour's
    // rhythm decides, the answer is shared) and is what keeps a till that never leaves the front asking.
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') ask();
    }, TICK_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && ask());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
  const current = asking();
  return current ? newerOf(status, current) : null;
}

/** What Settings' and This PoS's line draws from, asking as the page comes into view; null in a build that doesn't show it. */
export function useUpdateStatus(): { status: UpdateStatus; current: string } | null {
  const status = useStatus();
  useFocusEffect(
    useCallback(() => {
      const current = showing();
      if (!current) return;
      const c = checker;
      const ask = () => void c.check(current, Date.now(), ON_OPEN).catch(() => {});
      ask();
      const sub = AppState.addEventListener('change', (s) => s === 'active' && ask());
      return () => sub.remove();
    }, []),
  );
  const current = showing();
  return current ? { status, current } : null;
}
