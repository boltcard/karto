import { describe, expect, it } from 'vitest';
import { KARTO_POS, launchLine, openKartoPos, POS_ON_THIS_PHONE, posOnThisPhoneShown, type Signer, type StartActivity } from './posLaunch';

const LINK = `kartopos://pair?host=vm-1001.lnvps.cloud&code=${'a'.repeat(32)}`;

const same: Signer = async () => 'same';

// The code is a secret, and a bare kartopos:// link is any app's to
// claim, so Karto PoS is started by its package and its activity, by name, and only when the app of that name is
// signed as this one is: a package name is anyone's to take on a phone that has no Karto PoS.
describe('openKartoPos', () => {
  it('hands the code only to an app signed as this one is', async () => {
    let started = 0;
    const asked: string[] = [];
    const start: StartActivity = async () => void started++;
    const signer = (answer: 'same' | 'other' | 'absent'): Signer => async (name) => (asked.push(name), answer);
    expect(await openKartoPos({ start, signer: signer('other') }, LINK)).toBe('not-ours');
    expect(await openKartoPos({ start, signer: signer('absent') }, LINK)).toBe('not-installed');
    expect(started).toBe(0);
    expect(await openKartoPos({ start, signer: signer('same') }, LINK)).toBe('opened');
    expect(started).toBe(1);
    expect(asked).toEqual(['tech.whitewolf.kartopos.dev', 'tech.whitewolf.kartopos.dev', 'tech.whitewolf.kartopos.dev']);
    // A check that fails, or says anything else, is no proof.
    const broken: Signer = async () => Promise.reject(new Error('no context'));
    expect(await openKartoPos({ start, signer: broken }, LINK)).toBe('failed');
    expect(await openKartoPos({ start, signer: (async () => 'yes') as unknown as Signer }, LINK)).toBe('failed');
    expect(started).toBe(1);
  });

  it("starts Karto PoS itself, by its package and activity, with the link as the intent's data, in its own task", async () => {
    const started: unknown[] = [];
    const start: StartActivity = async (action, params) => void started.push([action, params]);
    expect(await openKartoPos({ start, signer: same }, LINK)).toBe('opened');
    expect(started).toEqual([
      ['android.intent.action.VIEW', { data: LINK, packageName: 'tech.whitewolf.kartopos.dev', className: 'tech.whitewolf.kartopos.dev.MainActivity', flags: 0x10000000 }],
    ]);
    // Both names, always: with the package alone the launcher sends a link any app could claim.
    expect(KARTO_POS).toEqual({ packageName: 'tech.whitewolf.kartopos.dev', className: 'tech.whitewolf.kartopos.dev.MainActivity' });
  });

  it("says so when Karto PoS isn't on the phone, and when it is but didn't open", async () => {
    const missing: StartActivity = async () => {
      throw new Error('Unable to find explicit activity class {tech.whitewolf.kartopos.dev/tech.whitewolf.kartopos.dev.MainActivity}; have you declared this activity in your AndroidManifest.xml, or does your intent not match its declared <intent-filter>?');
    };
    expect(await openKartoPos({ start: missing, signer: same }, LINK)).toBe('not-installed');
    const coded: StartActivity = async () => {
      throw Object.assign(new Error('No Activity found to handle Intent'), { code: 'ERR_ACTIVITY_NOT_FOUND' });
    };
    expect(await openKartoPos({ start: coded, signer: same }, LINK)).toBe('not-installed');
    const busy: StartActivity = async () => {
      throw new Error('IntentLauncher activity is already started. You need to wait for its result before starting another activity.');
    };
    expect(await openKartoPos({ start: busy, signer: same }, LINK)).toBe('failed');
  });

  it('never starts anything for a link that is not Karto PoS\'s', async () => {
    let started = 0;
    const start: StartActivity = async () => void started++;
    expect(await openKartoPos({ start, signer: same }, 'https://example.com/?kartopos://pair')).toBe('failed');
    expect(await openKartoPos({ start, signer: same }, 'lightning:lnbc1')).toBe('failed');
    expect(started).toBe(0);
  });
});

describe('the words', () => {
  it('names the button, and says what happened only when Karto PoS did not open', () => {
    expect(POS_ON_THIS_PHONE).toBe('Karto PoS is on this phone');
    expect(launchLine('opened')).toBe('');
    expect(launchLine('not-installed')).toBe("Karto PoS isn't installed on this phone.");
    expect(launchLine('failed')).toBe("Karto PoS didn't open.");
    expect(launchLine('not-ours')).toBe("The app on this phone that goes by Karto PoS's name isn't signed as this app is. The code wasn't given to it.");
  });
});

// On an iPhone nothing checks which app answers a kartopos://
// link (the code is in it), and the module has no signedLikeThisApp: the button is Android's alone.
describe('posOnThisPhoneShown', () => {
  it('is shown on Android and not on an iPhone', () => {
    expect(posOnThisPhoneShown('android')).toBe(true);
    expect(posOnThisPhoneShown('ios')).toBe(false);
  });
});
