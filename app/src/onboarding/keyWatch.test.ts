import { describe, expect, it } from 'vitest';
import { HOST_KEY, world } from '../testing/world';
import { KEY_WATCH_MAX_MS, KEY_WATCH_NOTICES, keyWaitNotifyView, keyWatchRecord, runKeyWatch, waitsForHostKey, type KeyWatchDeps } from './keyWatch';
import { advance, initialState, type OnboardingState } from './machine';

/** A setup waiting at host-key: the key trusted on first use, LNVPS listing none yet. */
async function waiting() {
  const t = world();
  let s = initialState('GBR');
  for (let i = 0; i < 30 && s.step !== 'boot'; i++) {
    s = await advance(s, t.deps);
    if (s.waiting === 'payment') t.lnvps.pay(s.vmId!);
  }
  t.lnvps.boot(s.vmId!);
  s = await advance(s, t.deps);
  s = await advance(s, t.deps);
  expect(s).toMatchObject({ step: 'install', waiting: 'host_key_confirm', host: { keySource: 'first_use' } });
  return { t, s };
}

/** The watch's deps over a saved state and a record that end() removes, with what it posted. */
function watch(t: ReturnType<typeof world>, state: OnboardingState | null) {
  const posted: { tag: string; title: string; text: string }[] = [];
  let record: string | null = t.keys.nostrPrivateKey;
  let ended = 0;
  const deps: KeyWatchDeps = {
    state: async () => state,
    lnvps: async () => (record ? t.deps.lnvps : null),
    notify: (n) => void posted.push(n),
    end: async () => {
      ended++;
      record = null;
    },
    now: () => t.w.nowMs,
  };
  return { deps, posted, ended: () => ended };
}

const impostor = { ...HOST_KEY, public_key: 'AAAAimpostor', fingerprint_sha256: 'SHA256:other' };

describe('the background check while the setup waits for LNVPS', () => {
  it('says nothing, and keeps watching, while LNVPS lists no key', async () => {
    const { t, s } = await waiting();
    const w = watch(t, s);
    expect(await runKeyWatch(w.deps)).toBe('not_yet');
    expect(w.posted).toEqual([]);
    expect(w.ended()).toBe(0);
  });

  it('tells the person once when LNVPS publishes the key the app pinned, and ends', async () => {
    const { t, s } = await waiting();
    t.lnvps.publishHostKeys(s.vmId!, [{ key_type: 'ssh-rsa', public_key: 'AAAAB3', fingerprint_sha256: 'SHA256:x' }, HOST_KEY]);
    const w = watch(t, s);
    expect(await runKeyWatch(w.deps)).toBe('confirmed');
    expect(w.posted).toEqual([
      { tag: 'host-key', title: 'Your server is confirmed', text: 'LNVPS has confirmed your server. Open Karto Wallet to finish setting it up.' },
    ]);
    expect(w.ended()).toBe(1);
    // A run Android starts before the task is gone finds no record: nothing posted again.
    expect(await runKeyWatch(w.deps)).toBe('past');
    expect(w.posted).toHaveLength(1);
  });

  it('says the server can\'t be trusted when LNVPS publishes a different key, and ends', async () => {
    const { t, s } = await waiting();
    t.lnvps.publishHostKeys(s.vmId!, [impostor]);
    const w = watch(t, s);
    expect(await runKeyWatch(w.deps)).toBe('mismatch');
    expect(w.posted).toEqual([{ tag: 'host-key', ...KEY_WATCH_NOTICES.mismatch }]);
    expect(w.posted[0].text).toContain('The server’s SSH key is not the one LNVPS published');
    expect(w.posted[0].text).toContain('Stop using this server');
    expect(w.ended()).toBe(1);
  });

  // An older app's install, which didn't wait for LNVPS: the seed may have gone, and the notice says so.
  it('says the seed may have been sent when an older app set the server up', async () => {
    const { t, s } = await waiting();
    t.lnvps.publishHostKeys(s.vmId!, [impostor]);
    const older: OnboardingState = { ...s, host: { ...s.host!, secretsHeld: undefined }, installed: [...s.installed, 'seed', 'issuer-key'] };
    const w = watch(t, older);
    expect(await runKeyWatch(w.deps)).toBe('mismatch');
    expect(w.posted).toEqual([{ tag: 'host-key', ...KEY_WATCH_NOTICES.mismatchOlder }]);
    expect(w.posted[0].text).toContain('may have been sent to it');
    expect(w.posted[0].text).not.toContain('were not sent');
  });

  it('ends untold, its key copy gone, once the wait began 6 hours ago', async () => {
    const { t, s } = await waiting();
    t.w.nowMs += KEY_WATCH_MAX_MS - 1;
    const w = watch(t, s);
    expect(await runKeyWatch(w.deps)).toBe('not_yet');
    t.w.nowMs += 1;
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    expect(await runKeyWatch(w.deps)).toBe('expired');
    expect(w.posted).toEqual([]);
    expect(w.ended()).toBe(1);
  });

  // A rebuild in place on the old server's own VM waits at boot, before anything there is retired or wiped.
  it('watches a rebuild\'s boot waiting for LNVPS, and says so once LNVPS lists the VM\'s key', async () => {
    const { t, s } = await waiting();
    const atBoot: OnboardingState = {
      ...s, step: 'boot', waiting: 'host_key_confirm', installed: [], runningSince: t.w.nowMs, stepStartedAt: undefined,
      rebuild: { source: 'server_page', target: { kind: 'in_place', vmId: s.vmId! }, oldVm: { id: s.vmId! } },
    };
    expect(waitsForHostKey(atBoot)).toBe(true);
    const w = watch(t, atBoot);
    expect(await runKeyWatch(w.deps)).toBe('not_yet');
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    expect(await runKeyWatch(w.deps)).toBe('confirmed');
    expect(w.posted).toEqual([{ tag: 'host-key', ...KEY_WATCH_NOTICES.confirmed }]);
  });

  it('logs in to nothing and sends the server nothing', async () => {
    const { t, s } = await waiting();
    const connects = t.ssh.connects.length;
    const sent = t.ssh.sent.length;
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    await runKeyWatch(watch(t, s).deps);
    expect([t.ssh.connects.length, t.ssh.sent.length]).toEqual([connects, sent]);
  });

  it.each([
    ['the install is past host-key', (s: OnboardingState): OnboardingState | null => ({ ...s, installed: [...s.installed, 'host-key'], waiting: undefined })],
    ['the setup is at pair', (s: OnboardingState): OnboardingState | null => ({ ...s, step: 'pair', waiting: undefined })],
    ['the key is LNVPS\'s', (s: OnboardingState): OnboardingState | null => ({ ...s, host: { ...s.host!, keySource: 'lnvps' } })],
    ['the setup stopped on a mismatch', (s: OnboardingState): OnboardingState | null => ({ ...s, hostKeyMismatch: 'LNVPS published SHA256:other' })],
    ['the wallet is gone', (): OnboardingState | null => null],
  ])('says nothing and ends when %s', async (_why, at) => {
    const { t, s } = await waiting();
    t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    const w = watch(t, at(s));
    expect(await runKeyWatch(w.deps)).toBe('past');
    expect(w.posted).toEqual([]);
    expect(w.ended()).toBe(1);
  });

  it('watches a setup killed in the middle of an attempt, whose last state saved has no wait', async () => {
    const { s } = await waiting();
    expect(waitsForHostKey({ ...s, waiting: undefined })).toBe(true);
    expect(waitsForHostKey(null)).toBe(false);
  });

  it('keeps only the Nostr key that signs LNVPS requests, and removes it', async () => {
    const items = new Map<string, string>();
    const options: unknown[] = [];
    const record = keyWatchRecord({
      getItemAsync: async (k) => items.get(k) ?? null,
      setItemAsync: async (k, v, o) => void (items.set(k, v), options.push(o)),
      deleteItemAsync: async (k) => void items.delete(k),
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    });
    expect(await record.get()).toBeNull();
    await record.set('ab'.repeat(32));
    expect(await record.get()).toBe('ab'.repeat(32));
    expect([...items.keys()]).toEqual(['host-key-watch']);
    expect(options).toEqual([{ keychainAccessible: 7 }]);
    await record.remove();
    expect(await record.get()).toBeNull();
    // The mark of a watch that ended itself, taken once.
    expect(await record.takeEnded()).toBe(false);
    await record.noteEnded();
    expect(await record.takeEnded()).toBe(true);
    expect(await record.takeEnded()).toBe(false);
    expect(items.size).toBe(0);
  });
});

describe('the wait\'s offer to be told', () => {
  it('offers the button where the phone can post the notice, and promises none where it can\'t', () => {
    expect(keyWaitNotifyView({ kind: 'offer' })).toEqual({
      line: 'Karto Wallet can send you a notification when LNVPS has confirmed your server, so you needn’t wait here.',
      button: 'Tell me when it’s ready',
    });
    expect(keyWaitNotifyView({ kind: 'unsupported' })).toEqual({
      line: 'This phone can’t tell you when it’s ready, so come back in about an hour: the install carries on when you open the app.',
      button: null,
    });
    expect(keyWaitNotifyView({ kind: 'unsupported' }).line).not.toContain('notification');
    expect(keyWaitNotifyView({ kind: 'armed' }).line).toContain('You’ll get a notification when LNVPS has confirmed your server.');
    expect(keyWaitNotifyView({ kind: 'refused' })).toEqual({
      line: 'Notifications are off for Karto Wallet, so come back in about an hour: the install carries on when you open the app.',
      button: 'Tell me when it’s ready', // to ask again, where Android still shows the question
    });
    expect(keyWaitNotifyView({ kind: 'failed', why: 'no record' }).line).toContain('(no record)');
  });
});
