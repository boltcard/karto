import { describe, expect, it } from 'vitest';
import { CANT_READ, foundWallet, guardFrom, restoredNote, routeAllowed, startFrom, startRoute, type RouteContext, type Screen } from './startRoute';
import { initialState, startRebuild } from '../onboarding/machine';

describe('startRoute', () => {
  const s = initialState();
  it('opens the diagnostics in a diagnostics build', () => {
    expect(startRoute({ diagnostics: true, hasPhrase: true, state: { ...s, step: 'done' } })).toBe('/diagnostics');
  });
  // expo-secure-store keeps the phrase out of Android's backup: a restored app has state but no phrase.
  it('starts from the welcome screen without a phrase, whatever state is saved', () => {
    expect(startRoute({ diagnostics: false, hasPhrase: false, state: null })).toBe('/welcome');
    expect(startRoute({ diagnostics: false, hasPhrase: false, state: { ...s, step: 'install' } })).toBe('/welcome');
  });
  // A backup brought the progress back but not the phrase; "Set up a new server"
  // would order and pay for a second one, so welcome points to the phrase the person has.
  it('says when progress came back without its phrase', () => {
    expect(restoredNote({ diagnostics: false, hasPhrase: false, state: { ...s, country: 'GBR', step: 'pay', vmId: 7 } })).toContain('I already have a recovery phrase');
    expect(restoredNote({ diagnostics: false, hasPhrase: false, state: { ...s, step: 'done' } })).not.toBeNull();
    expect(restoredNote({ diagnostics: false, hasPhrase: false, state: null })).toBeNull();
    expect(restoredNote({ diagnostics: false, hasPhrase: false, state: s })).toBeNull(); // nothing sent to LNVPS yet
  });
  it('asks for the country before anything is sent to LNVPS', () => {
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: null })).toBe('/country');
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: s })).toBe('/country');
  });
  // Rebuild server is behind the screen lock: one started on the server page resumes on its own screen.
  it('resumes a rebuild started on the server page on its screen, and a new phone\'s in onboarding', () => {
    const done = { ...s, country: 'GBR', step: 'done' as const, vmId: 1012 };
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: startRebuild(done, 'server_page') })).toBe('/rebuild');
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: startRebuild(done, 'new_phone') })).toBe('/onboarding');
    // Once done, the rebuild's record stays (the old VM is watched): home again.
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: { ...startRebuild(done, 'server_page'), step: 'done' } })).toBe('/home');
  });
  it('resumes onboarding where it stopped, and goes home once done', () => {
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: initialState('GBR') })).toBe('/onboarding');
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: { ...s, country: 'GBR', step: 'pay' } })).toBe('/onboarding');
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: { ...s, country: 'GBR', step: 'done' } })).toBe('/home');
  });

  // Every screen is reachable by a karto:// deep link: each one only opens in the state it belongs to.
  describe('routeAllowed', () => {
    const ctx = (hasPhrase: boolean, state: typeof s | null, diagnostics = false) => ({ diagnostics, hasPhrase, state });
    it('never offers a new phrase once there is one', () => {
      expect(routeAllowed('/phrase', ctx(false, null))).toBe(true);
      expect(routeAllowed('/phrase', ctx(true, s))).toBe(false);
      expect(routeAllowed('/welcome', ctx(true, null))).toBe(false);
    });
    it('takes an existing phrase only while there is none', () => {
      expect(routeAllowed('/restore', ctx(false, null))).toBe(true);
      expect(routeAllowed('/restore', ctx(false, { ...s, step: 'install' }))).toBe(true);
      expect(routeAllowed('/restore', ctx(true, s))).toBe(false);
    });
    it('lets the country change only before LNVPS has taken it', () => {
      expect(routeAllowed('/country', ctx(true, s))).toBe(true);
      expect(routeAllowed('/country', ctx(true, { ...initialState('IRL'), error: { kind: 'fatal', message: 'VAT' } }))).toBe(true);
      expect(routeAllowed('/country', ctx(true, { ...s, country: 'GBR', step: 'pay' }))).toBe(false);
      expect(routeAllowed('/country', ctx(false, s))).toBe(false);
    });
    it('opens diagnostics only in a diagnostics build, and nothing else there', () => {
      expect(routeAllowed('/diagnostics', ctx(true, null))).toBe(false);
      expect(routeAllowed('/diagnostics', ctx(true, null, true))).toBe(true);
      expect(routeAllowed('/home', ctx(true, { ...s, country: 'GBR', step: 'done' }, true))).toBe(false);
    });
    it('opens onboarding and home only at their stage', () => {
      expect(routeAllowed('/onboarding', ctx(true, { ...s, country: 'GBR', step: 'pay' }))).toBe(true);
      expect(routeAllowed('/onboarding', ctx(true, { ...s, country: 'GBR', step: 'done' }))).toBe(false);
      expect(routeAllowed('/home', ctx(true, { ...s, country: 'GBR', step: 'pay' }))).toBe(false);
    });
    it('opens Rebuild server from the server page, or for the rebuild it started; never onboarding for that one', () => {
      const done = { ...s, country: 'GBR', step: 'done' as const, vmId: 1012 };
      const page = startRebuild(done, 'server_page');
      const phone = startRebuild(done, 'new_phone');
      expect(routeAllowed('/rebuild', ctx(true, done))).toBe(true);
      expect(routeAllowed('/rebuild', ctx(true, page))).toBe(true);
      expect(routeAllowed('/onboarding', ctx(true, page))).toBe(false);
      expect(routeAllowed('/rebuild', ctx(true, phone))).toBe(false);
      expect(routeAllowed('/onboarding', ctx(true, phone))).toBe(true);
      expect(routeAllowed('/rebuild', ctx(true, { ...s, country: 'GBR', step: 'pay' }))).toBe(false);
      expect(routeAllowed('/rebuild', ctx(false, done))).toBe(false);
      expect(routeAllowed('/rebuild', ctx(true, done, true))).toBe(false);
    });
    it('always allows where startRoute sends you', () => {
      const done = { ...s, country: 'GBR', step: 'done' as const, vmId: 1012 };
      const states = [
        null, s, initialState('GBR'), { ...s, country: 'GBR', step: 'install' as const }, done,
        startRebuild(done, 'server_page'), startRebuild(done, 'new_phone'), { ...startRebuild(done, 'server_page'), step: 'done' as const },
      ];
      for (const diagnostics of [false, true]) for (const hasPhrase of [false, true]) for (const state of states) {
        const c = { diagnostics, hasPhrase, state };
        expect(routeAllowed(startRoute(c) as Screen, c)).toBe(true);
      }
    });
    it('opens the card screens only once the server is set up', () => {
      const done = { ...s, country: 'GBR', step: 'done' as const };
      // /phone-card and /pay: the phone as a card, its set-up page and the pay screen.
      for (const screen of ['/card-add', '/card', '/card-photo', '/account', '/move', '/send', '/scan', '/pay-lnvps', '/pos-phones', '/pos-add', '/phone-card', '/pay', '/payment'] as const) {
        expect(routeAllowed(screen, ctx(true, done))).toBe(true);
        expect(routeAllowed(screen, ctx(true, { ...s, country: 'GBR', step: 'pay' }))).toBe(false);
        expect(routeAllowed(screen, ctx(false, done))).toBe(false);
        expect(routeAllowed(screen, ctx(true, done, true))).toBe(false);
      }
    });
    // Settings and Show recovery phrase are the wallet's own screens: a deep link opens them exactly where it opens the wallet.
    it('opens Settings and Show recovery phrase exactly where it opens the wallet', () => {
      const done = { ...s, country: 'GBR', step: 'done' as const, vmId: 1012 };
      for (const screen of ['/settings', '/show-phrase', '/server', '/backups', '/alerts'] as const) {
        expect(routeAllowed(screen, ctx(true, done))).toBe(true);
        expect(routeAllowed(screen, ctx(true, { ...startRebuild(done, 'server_page'), step: 'done' }))).toBe(true);
        expect(routeAllowed(screen, ctx(true, { ...s, country: 'GBR', step: 'pay' }))).toBe(false);
        expect(routeAllowed(screen, ctx(true, startRebuild(done, 'server_page')))).toBe(false);
        expect(routeAllowed(screen, ctx(true, startRebuild(done, 'new_phone')))).toBe(false);
        expect(routeAllowed(screen, ctx(true, s))).toBe(false);
        expect(routeAllowed(screen, ctx(true, null))).toBe(false);
        expect(routeAllowed(screen, ctx(false, done))).toBe(false);
        expect(routeAllowed(screen, ctx(false, null))).toBe(false);
        expect(routeAllowed(screen, ctx(true, done, true))).toBe(false);
      }
      const states = [
        null, s, initialState('GBR'), { ...s, country: 'GBR', step: 'install' as const }, done,
        startRebuild(done, 'server_page'), startRebuild(done, 'new_phone'), { ...startRebuild(done, 'server_page'), step: 'done' as const },
      ];
      for (const diagnostics of [false, true]) for (const hasPhrase of [false, true]) for (const state of states) {
        const c = { diagnostics, hasPhrase, state };
        expect(routeAllowed('/settings', c)).toBe(routeAllowed('/home', c));
        expect(routeAllowed('/show-phrase', c)).toBe(routeAllowed('/home', c));
        expect(routeAllowed('/server', c)).toBe(routeAllowed('/home', c));
        expect(routeAllowed('/backups', c)).toBe(routeAllowed('/home', c));
        expect(routeAllowed('/alerts', c)).toBe(routeAllowed('/home', c));
      }
    });
  });
});

// An iPhone's Keychain keeps the phrase when the app is deleted.
describe('a wallet found on a phone whose phrase outlives the app', () => {
  const s = initialState();
  const done = { ...s, country: 'GBR', step: 'done' as const, vmId: 1012 };
  const found = { diagnostics: false, hasPhrase: true, state: null, outlivesApp: true };
  const SCREENS: Screen[] = [
    '/diagnostics', '/welcome', '/country', '/onboarding', '/rebuild', '/home', '/found', '/phrase', '/restore', '/settings', '/server', '/backups',
    '/show-phrase', '/remove', '/card-add', '/card', '/card-photo', '/account', '/move', '/send', '/scan', '/pay-lnvps', '/pos-phones', '/pos-add',
    '/phone-card', '/pay', '/payment', '/alerts',
  ];

  it('is a phrase with no saved state at all, where the phrase outlives the app', () => {
    expect(foundWallet(found)).toBe(true);
    expect(foundWallet({ ...found, state: s })).toBe(false);
    expect(foundWallet({ ...found, hasPhrase: false })).toBe(false);
    expect(foundWallet({ ...found, outlivesApp: false })).toBe(false);
    expect(foundWallet({ diagnostics: false, hasPhrase: true, state: null })).toBe(false);
  });

  it('opens on the screen that says so and asks', () => {
    expect(startRoute(found)).toBe('/found');
  });

  it('still goes to the country on Android, where a phrase with no state was typed a moment ago', () => {
    expect(startRoute({ ...found, outlivesApp: false })).toBe('/country');
    expect(startRoute({ diagnostics: false, hasPhrase: true, state: null })).toBe('/country');
  });

  it('allows that screen and Show recovery phrase, and no other, while the wallet is only found', () => {
    expect(SCREENS.filter((screen) => routeAllowed(screen, found))).toEqual(['/found', '/show-phrase']);
  });

  it('closes that screen once the wallet is carried on, and on any phone that found none', () => {
    expect(routeAllowed('/found', { ...found, state: { ...s, restoring: true } })).toBe(false);
    expect(routeAllowed('/found', { ...found, state: done })).toBe(false);
    expect(routeAllowed('/found', { ...found, hasPhrase: false })).toBe(false);
    expect(routeAllowed('/found', { ...found, outlivesApp: false })).toBe(false);
    expect(startRoute({ ...found, state: { ...s, restoring: true } })).toBe('/country');
  });

  it('opens Remove this wallet only with a phrase, onboarding done, and a phrase that outlives the app', () => {
    expect(routeAllowed('/remove', { ...found, state: done })).toBe(true);
    expect(routeAllowed('/remove', { ...found, state: done, outlivesApp: false })).toBe(false);
    expect(routeAllowed('/remove', { diagnostics: false, hasPhrase: true, state: done })).toBe(false);
    expect(routeAllowed('/remove', { ...found, state: { ...s, country: 'GBR', step: 'install' } })).toBe(false);
    expect(routeAllowed('/remove', { ...found, state: done, hasPhrase: false })).toBe(false);
    expect(routeAllowed('/remove', found)).toBe(false);
  });

  it('opens nothing but the diagnostics in a diagnostics build, found wallet or not', () => {
    expect(startRoute({ ...found, diagnostics: true })).toBe('/diagnostics');
    expect(SCREENS.filter((screen) => routeAllowed(screen, { ...found, diagnostics: true }))).toEqual(['/diagnostics']);
  });
});

// A read that fails is not "no phrase". Both phones.
describe('a start whose read fails', () => {
  const done: RouteContext = { diagnostics: false, hasPhrase: true, state: { ...initialState(), country: 'GBR', step: 'done' } };
  const fails = async (): Promise<RouteContext> => {
    throw new Error('User interaction is not allowed.');
  };

  it('opens where startRoute says once the phone has answered', async () => {
    expect(await startFrom(async () => done)).toEqual({ route: '/home' });
    expect(await startFrom(async () => ({ diagnostics: false, hasPhrase: false, state: null }))).toEqual({ route: '/welcome' });
  });

  it("says the app can't read what it keeps, and opens no screen, least of all Welcome", async () => {
    expect(await startFrom(fails)).toEqual({ cantRead: "Karto Wallet can't read what it keeps on this phone. Unlock the phone and open the app again." });
    expect(CANT_READ).toBe("Karto Wallet can't read what it keeps on this phone. Unlock the phone and open the app again.");
  });

  it('hands the failure to the log, for whoever debugs the phone', async () => {
    const logged: unknown[] = [];
    await startFrom(fails, (e) => logged.push(e));
    await startFrom(async () => done, (e) => logged.push(e));
    expect(logged).toEqual([new Error('User interaction is not allowed.')]);
  });

  it('lets a screen open, or sends the app where it starts, from what the phone answered', async () => {
    expect(await guardFrom('/home', async () => done)).toEqual({ allowed: true });
    expect(await guardFrom('/welcome', async () => done)).toEqual({ allowed: false, go: '/home' });
  });

  // The start screen then says so: a screen a link opened never shows its own page on a read that failed.
  it('sends a screen whose read fails to the start, which says why', async () => {
    for (const screen of ['/home', '/welcome', '/show-phrase', '/found', '/remove'] as const) {
      expect(await guardFrom(screen, fails)).toEqual({ allowed: false, go: '/' });
    }
  });
});
