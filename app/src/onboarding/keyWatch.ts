// While the install waits for LNVPS to confirm the server's SSH key (the step host-key, up to about an hour), the
// person may leave the app. This is the watch that tells them when the wait is over: a background check, about every
// 15 minutes on Android, asks LNVPS for the VM's published key and compares it with the one the app pinned, then
// posts a notification. It never logs in to the server and sends it nothing: the install itself carries on only with
// the app in front. Its words, its decision and the record it reads are here; keyWatchTask.ts wires it to the phone.
import type { LnvpsClient } from '../lnvps/client';
import type { SetupNoticeNativeApi } from '../native/api';
import type { SecureStoreApi } from '../store/secrets';
import { verifyHostKey, type OnboardingState } from './machine';

/** The background task's name (expo-task-manager). */
export const KEY_WATCH_TASK = 'karto-host-key-watch';
/** How often Android is asked to run it: 15 minutes is its least. */
export const KEY_WATCH_MINUTES = 15;

/** The notifications: one tag, so the second of two never stands beside the first. */
export const KEY_WATCH_NOTICES = {
  tag: 'host-key',
  confirmed: {
    title: 'Your server is confirmed',
    text: 'LNVPS has confirmed your server. Open Karto Wallet to finish setting it up.',
  },
  mismatch: {
    title: 'Your server can’t be trusted',
    text:
      'The server’s SSH key is not the one LNVPS published. Your wallet seed and card key were not sent to it. ' +
      'Stop using this server, and open Karto Wallet for the details.',
  },
} as const;

/**
 * Whether the setup waits at host-key: at the install, with a key trusted on first use that LNVPS has neither
 * confirmed nor contradicted, and host-key not yet passed. Read from the saved state, so an app killed in the
 * middle of an attempt (its last checkpoint has no waiting) counts too.
 */
export const waitsForHostKey = (s: OnboardingState | null | undefined): s is OnboardingState =>
  !!s && s.step === 'install' && s.host?.keySource === 'first_use' && !s.hostKeyMismatch && !s.installed.includes('host-key');

/** The native calls the watch needs, where the phone has them: Android's module; an iPhone's posts no notification yet. */
export function setupNotices(native: Partial<SetupNoticeNativeApi>): SetupNoticeNativeApi | null {
  if (!native.postSetupNotice || !native.notificationsAllowed || !native.requestNotifications) return null;
  // Called on the module itself, never as loose functions.
  return {
    postSetupNotice: (tag, title, text) => native.postSetupNotice!(tag, title, text),
    notificationsAllowed: () => native.notificationsAllowed!(),
    requestNotifications: () => native.requestNotifications!(),
  };
}

export type KeyWatchOutcome = 'past' | 'not_yet' | 'confirmed' | 'mismatch';

/** What LNVPS says now of the key the setup waits on: 'past' when the setup no longer waits for it. */
export async function keyWatchCheck(s: OnboardingState | null, lnvps: Pick<LnvpsClient, 'getVm'>): Promise<KeyWatchOutcome> {
  if (!waitsForHostKey(s)) return 'past';
  const v = await verifyHostKey(s, lnvps);
  if (v.hostKeyMismatch) return 'mismatch';
  return v.host?.keySource === 'lnvps' ? 'confirmed' : 'not_yet';
}

export type KeyWatchDeps = {
  /** The saved onboarding state (read only: the watch writes nothing to it). */
  state(): Promise<OnboardingState | null>;
  /** LNVPS for the phrase's account, from the watch's record; null when there is no record. */
  lnvps(): Promise<Pick<LnvpsClient, 'getVm'> | null>;
  notify(n: { tag: string; title: string; text: string }): void;
  /** Ends the watch: the task unregistered and its record removed. */
  end(): Promise<void>;
};

/**
 * One run of the background check. LNVPS's answer, either way, is told once: the watch then ends, so a later
 * run, should Android start one before it is unregistered, finds no record and says nothing. A setup past the wait
 * (or a wallet gone) ends it too.
 */
export async function runKeyWatch(d: KeyWatchDeps): Promise<KeyWatchOutcome> {
  const s = await d.state();
  const lnvps = waitsForHostKey(s) ? await d.lnvps() : null;
  if (!lnvps) {
    await d.end();
    return 'past';
  }
  const outcome = await keyWatchCheck(s, lnvps);
  if (outcome === 'not_yet') return outcome;
  if (outcome !== 'past') d.notify({ tag: KEY_WATCH_NOTICES.tag, ...KEY_WATCH_NOTICES[outcome] });
  await d.end();
  return outcome;
}

const RECORD = 'host-key-watch';

/**
 * The watch's record in expo-secure-store: the Nostr key that signs the phrase's LNVPS requests (hex), and nothing
 * else, so the background check reads neither the phrase nor any other key. Removed when the watch ends.
 */
export function keyWatchRecord(ss: Pick<SecureStoreApi, 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync' | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'>) {
  return {
    get: () => ss.getItemAsync(RECORD),
    set: (nostrSecretKey: string) => ss.setItemAsync(RECORD, nostrSecretKey, { keychainAccessible: ss.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
    remove: () => ss.deleteItemAsync(RECORD),
  };
}

/**
 * The wait's offer to be told: unsupported (this phone can't post the notice: an iPhone), offer (the button),
 * asking (the permission's dialog is up), armed (the watch runs), refused (notifications are off), failed (the watch
 * couldn't be started, with why).
 */
export type KeyWaitNotify = { kind: 'unsupported' | 'offer' | 'asking' | 'armed' | 'refused' } | { kind: 'failed'; why: string };

export const NOTIFY_BUTTON = 'Tell me when it’s ready';

/** The words under the wait, and the button, if one. */
export function keyWaitNotifyView(n: KeyWaitNotify): { line: string; button: string | null } {
  const later = 'come back in about an hour: the install carries on when you open the app.';
  switch (n.kind) {
    case 'unsupported':
      return { line: `This phone can’t tell you when it’s ready, so ${later}`, button: null };
    case 'offer':
      return { line: 'Karto Wallet can send you a notification when LNVPS has confirmed your server, so you needn’t wait here.', button: NOTIFY_BUTTON };
    case 'asking':
      return { line: 'Karto Wallet can send you a notification when LNVPS has confirmed your server, so you needn’t wait here.', button: null };
    case 'armed':
      return {
        line:
          'You’ll get a notification when LNVPS has confirmed your server. While the app is closed, Android lets it ' +
          'check about every 15 minutes, or less often to save battery.',
        button: null,
      };
    case 'refused':
      return { line: `Notifications are off for Karto Wallet, so ${later}`, button: null };
    case 'failed':
      return { line: `Karto Wallet couldn’t set up the notification (${n.why}), so ${later}`, button: null };
  }
}
