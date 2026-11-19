// While the setup waits for LNVPS to confirm the server's SSH key (the install's step host-key: usually minutes, at worst about an hour;
// or a rebuild's boot in place on the old server's own VM), the person may leave the app. This is the watch that tells
// them when the wait is over: a background check, about every 15 minutes on Android, asks LNVPS for the VM's
// published key and compares it with the one the app pinned, then posts a notification. It never logs in to the server and sends it nothing: the install itself carries on only with
// the app in front. Its words, its decision and the record it reads are here; keyWatchTask.ts wires it to the phone.
import type { LnvpsClient } from '../lnvps/client';
import type { SetupNoticeNativeApi } from '../native/api';
import type { SecureStoreApi } from '../store/secrets';
import { onOldVm, secretsAt, verifyHostKey, type OnboardingState } from './machine';

/** The background task's name (expo-task-manager). */
export const KEY_WATCH_TASK = 'karto-host-key-watch';
/** How often Android is asked to run it: 15 minutes is its least. */
export const KEY_WATCH_MINUTES = 15;
/** A wait abandoned this long after it began is no longer watched: the watch ends, and its copy of the key goes. */
export const KEY_WATCH_MAX_MS = 6 * 60 * 60 * 1000;

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
  /** For a server an older app set up without waiting for LNVPS (secretsAt 'maybe_sent'). */
  mismatchOlder: {
    title: 'Your server can’t be trusted',
    text:
      'The server’s SSH key is not the one LNVPS published. Your wallet seed and card key may have been sent to it. ' +
      'Stop using this server and this recovery phrase, and open Karto Wallet for the details.',
  },
} as const;

/**
 * A rebuild's boot waiting for LNVPS to publish the key of the old server's own VM, before step 4 retires and wipes
 * it: from what the saved state holds for good (boot, in place on that VM, no key of LNVPS's pinned, none contradicted),
 * not its waiting, which a failed poll (network) or the VM stopped a moment (boot) replaces.
 */
const waitsAtBoot = (s: OnboardingState) =>
  s.step === 'boot' && onOldVm(s) && s.vmId !== undefined && !s.hostKeyMismatch && (!s.host || s.host.keySource === 'first_use');

/**
 * Whether the setup waits for LNVPS to confirm the server: at the install, with a key trusted on first use that
 * LNVPS has neither confirmed nor contradicted, and host-key not yet passed (read from the saved state, so an app
 * killed in the middle of an attempt, whose last checkpoint has no waiting, counts too); or at a rebuild's boot.
 */
export const waitsForHostKey = (s: OnboardingState | null | undefined): s is OnboardingState =>
  !!s && (waitsAtBoot(s) || (s.step === 'install' && s.host?.keySource === 'first_use' && !s.hostKeyMismatch && !s.installed.includes('host-key')));

/** When the wait began (ms), as the state says: host-key's start, boot's, or else when the key was trusted. */
const waitStart = (s: OnboardingState): number | undefined =>
  (s.stepStartedAt?.step === 'host-key' ? s.stepStartedAt.at : s.step === 'boot' ? s.runningSince : undefined) ?? s.host?.trustedAt;

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

export type KeyWatchOutcome = 'past' | 'expired' | 'not_yet' | 'confirmed' | 'mismatch';

/**
 * What LNVPS says now of the key the setup waits on: 'past' when the setup no longer waits for it. At a rebuild's
 * boot, LNVPS's key against the one pinned (boot stops on another: machine.ts inPlaceMismatch); with none pinned, any
 * key LNVPS lists ends the wait.
 */
export async function keyWatchCheck(s: OnboardingState | null, lnvps: Pick<LnvpsClient, 'getVm'>): Promise<KeyWatchOutcome> {
  if (!waitsForHostKey(s)) return 'past';
  if (waitsAtBoot(s)) {
    const published = (await lnvps.getVm(s.vmId!)).host_ssh_keys.find((k) => k.key_type === 'ssh-ed25519');
    if (!published) return 'not_yet';
    return !s.host || published.public_key === s.host.hostKey.publicKey ? 'confirmed' : 'mismatch';
  }
  const v = await verifyHostKey(s, lnvps);
  if (v.hostKeyMismatch) return 'mismatch';
  return v.host?.keySource === 'lnvps' ? 'confirmed' : 'not_yet';
}

export type KeyWatchDeps = {
  /** The saved onboarding state (read only: the watch writes nothing to it). */
  state(): Promise<OnboardingState | null>;
  /** LNVPS for the phrase's account, from the watch's record, and when the watch was started; null with no record. */
  watch(): Promise<{ lnvps: Pick<LnvpsClient, 'getVm'>; armedAt: number } | null>;
  notify(n: { tag: string; title: string; text: string }): void;
  /**
   * Ends the watch from inside its own run: its record removed first, then the end marked for the app, which
   * unregisters the task once in front (unregistering it here would cancel the run itself).
   */
  end(): Promise<void>;
  now(): number;
};

/**
 * One run of the background check. LNVPS's answer, either way, is told once: the watch then ends, so a later
 * run, should Android start one before it is unregistered, finds no record and says nothing. A setup past the wait
 * (or a wallet gone), or a wait begun KEY_WATCH_MAX_MS ago (by the state, or else since the watch was started), ends
 * it too, untold.
 */
export async function runKeyWatch(d: KeyWatchDeps): Promise<KeyWatchOutcome> {
  const s = await d.state();
  const watch = waitsForHostKey(s) ? await d.watch() : null;
  if (!watch) {
    await d.end();
    return 'past';
  }
  if (d.now() - (waitStart(s!) ?? watch.armedAt) >= KEY_WATCH_MAX_MS) {
    await d.end();
    return 'expired';
  }
  const outcome = await keyWatchCheck(s, watch.lnvps);
  if (outcome === 'not_yet') return outcome;
  if (outcome === 'confirmed') d.notify({ tag: KEY_WATCH_NOTICES.tag, ...KEY_WATCH_NOTICES.confirmed });
  if (outcome === 'mismatch') {
    d.notify({ tag: KEY_WATCH_NOTICES.tag, ...(secretsAt(s!) === 'maybe_sent' ? KEY_WATCH_NOTICES.mismatchOlder : KEY_WATCH_NOTICES.mismatch) });
  }
  await d.end();
  return outcome;
}

const RECORD = 'host-key-watch';
const ENDED = 'host-key-watch-ended';

/**
 * The watch's record in expo-secure-store: the Nostr key that signs the phrase's LNVPS requests (hex), and nothing
 * else secret, so the background check reads neither the phrase nor any other key; and when the watch was started
 * (ms), so that its end after KEY_WATCH_MAX_MS can always come. Removed when the watch ends.
 * noteEnded and takeEnded: a mark that the watch ended itself in the background, so the app, once in front, gives the
 * backup job its own interval back (keyWatchTask.ts).
 */
export function keyWatchRecord(ss: Pick<SecureStoreApi, 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync' | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'>) {
  return {
    /** The record, or null for none (or one this app can't read). */
    get: async (): Promise<{ key: string; armedAt: number } | null> => {
      const raw = await ss.getItemAsync(RECORD);
      try {
        const r = raw === null ? null : (JSON.parse(raw) as { key?: unknown; armedAt?: unknown });
        return r && typeof r.key === 'string' && typeof r.armedAt === 'number' ? { key: r.key, armedAt: r.armedAt } : null;
      } catch {
        return null;
      }
    },
    set: (nostrSecretKey: string, armedAt: number) =>
      ss.setItemAsync(RECORD, JSON.stringify({ key: nostrSecretKey, armedAt }), { keychainAccessible: ss.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
    remove: () => ss.deleteItemAsync(RECORD),
    noteEnded: () => ss.setItemAsync(ENDED, '1'),
    /** Whether the mark was there; it is removed. */
    takeEnded: async () => {
      const ended = (await ss.getItemAsync(ENDED)) !== null;
      if (ended) await ss.deleteItemAsync(ENDED);
      return ended;
    },
  };
}

/**
 * The wait's offer to be told: unsupported (this phone can't post the notice: an iPhone), offer (notifications aren't
 * allowed yet: the button asks), asking (the permission's dialog is up), armed (the watch runs: started by itself
 * where notifications were allowed already), refused (notifications are off: the button asks again, which Android
 * shows only while it still may), failed (the watch couldn't be started, with why).
 */
export type KeyWaitNotify = { kind: 'unsupported' | 'offer' | 'asking' | 'armed' | 'refused' } | { kind: 'failed'; why: string };

export const NOTIFY_BUTTON = 'Tell me when it’s ready';

/** The words under the wait, and the button, if one. */
export function keyWaitNotifyView(n: KeyWaitNotify): { line: string; button: string | null } {
  const later = 'come back later: the install carries on when you open the app.';
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
      return { line: `Notifications are off for Karto Wallet, so ${later}`, button: NOTIFY_BUTTON };
    case 'failed':
      return { line: `Karto Wallet couldn’t set up the notification (${n.why}), so ${later}`, button: null };
  }
}
