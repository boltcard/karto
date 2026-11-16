// Which screen the app opens on, and which screens may open at all: every
// screen is reachable by a karto:// deep link, so each one only opens in
// the state it belongs to.
import type { OnboardingState } from '../onboarding/machine';

export type Route = '/diagnostics' | '/welcome' | '/country' | '/onboarding' | '/rebuild' | '/home' | '/found';
export type Screen =
  | Route | '/phrase' | '/restore' | '/settings' | '/server' | '/backups' | '/show-phrase' | '/remove'
  | '/card-add' | '/card' | '/card-photo' | '/account' | '/payment' | '/move' | '/send' | '/scan' | '/pay-lnvps' | '/pos-phones' | '/pos-add'
  // The phone as a card: its set-up page and the pay screen.
  | '/phone-card' | '/pay'
  // Settings → Alerts.
  | '/alerts'
  // Setup's Name this wallet page.
  | '/wallet-name'
  // Refunding a till sale from its page.
  | '/refund';
/** outlivesApp: the phrase stays on the phone when the app is deleted (an iPhone's Keychain; store/secrets.ts). */
export type RouteContext = { diagnostics: boolean; hasPhrase: boolean; state: OnboardingState | null; outlivesApp?: boolean };

/**
 * A wallet from before: a phrase with no saved state at
 * all, on a phone whose phrase outlives the app. adoptPhrase saves the first state straight after the phrase, so
 * no state means the app's memory went, which there means the app was deleted and installed again. On Android
 * the phrase goes with the app, and a phrase with no state is one typed a moment ago.
 */
export const foundWallet = (o: RouteContext): boolean => !!o.outlivesApp && o.hasPhrase && !o.state;

export function startRoute(o: RouteContext): Route {
  if (o.diagnostics) return '/diagnostics';
  // Welcome offers a new phrase or the one the person has (a minimal restore).
  if (!o.hasPhrase) return '/welcome';
  // The phone says what it found and asks, before anything is done with it.
  if (foundWallet(o)) return '/found';
  if (!o.state?.country) return '/country';
  if (o.state.step === 'done') return '/home';
  return fromServerPage(o.state) ? '/rebuild' : '/onboarding';
}

/** A rebuild started with Rebuild server, which is behind the screen lock: it carries on on its own screen. */
const fromServerPage = (s: OnboardingState) => s.rebuild?.source === 'server_page';

/** Welcome's warning when Android's backup brought back progress but not the phrase (kept out of backups). */
export function restoredNote(o: RouteContext): string | null {
  if (o.hasPhrase || !o.state || o.state.step === 'country') return null;
  return (
    'This phone has an earlier setup, but not its recovery phrase. If that setup paid for a server, choose ' +
    '“I already have a recovery phrase” and enter its words: a new server is ordered and paid for separately.'
  );
}

export function routeAllowed(screen: Screen, o: RouteContext): boolean {
  if (o.diagnostics) return screen === '/diagnostics';
  // Until the person has chosen, nothing else opens; the words can be read first (behind the lock, as always).
  if (foundWallet(o)) return screen === '/found' || screen === '/show-phrase';
  switch (screen) {
    case '/diagnostics':
    case '/found':
      return false;
    case '/welcome':
    case '/phrase':
    case '/restore':
      return !o.hasPhrase;
    case '/country':
      // Until LNVPS has taken a country, it can still be changed (e.g. after a VAT refusal).
      return o.hasPhrase && (!o.state || o.state.step === 'country');
    case '/onboarding':
      return o.hasPhrase && !!o.state?.country && o.state.step !== 'done' && !fromServerPage(o.state);
    case '/rebuild':
      // The server page's Rebuild server, or the rebuild it started.
      return o.hasPhrase && !!o.state && (o.state.step === 'done' || fromServerPage(o.state));
    case '/remove':
      // Removing a wallet from the phone is for a phone that would otherwise keep it.
      return !!o.outlivesApp && o.hasPhrase && o.state?.step === 'done';
    case '/home':
    case '/settings':
    case '/server':
    case '/backups':
    case '/show-phrase':
    case '/card-add':
    case '/card':
    case '/card-photo':
    case '/account':
    // A history line's own page.
    case '/payment':
    case '/move':
    case '/send':
    case '/scan':
    case '/pay-lnvps':
    case '/pos-phones':
    case '/pos-add':
    // Each of these two decides for itself whether this phone can be a card: a link opens no more than the page.
    case '/phone-card':
    case '/pay':
    case '/alerts':
    case '/wallet-name':
    case '/refund':
      return o.hasPhrase && o.state?.step === 'done';
  }
}

/** Both phones: an iPhone not unlocked since it was started, or a keystore or database that can't answer. */
export const CANT_READ = "Karto Wallet can't read what it keeps on this phone. Unlock the phone and open the app again.";

/**
 * Where the app opens, from a read of the phrase and the saved state. A read that fails is not "no phrase":
 * the app says so and opens no screen, least of all Welcome, where a
 * new phrase could be made over the one it couldn't read. log: the failure, for adb logcat or the Mac's console.
 */
export async function startFrom(read: () => Promise<RouteContext>, log?: (e: unknown) => void): Promise<{ route: Route } | { cantRead: string }> {
  try {
    return { route: startRoute(await read()) };
  } catch (e) {
    log?.(e);
    return { cantRead: CANT_READ };
  }
}

/** A screen's guard: it opens, or the app goes where it starts; on a read that fails, to the start, which says why. */
export async function guardFrom(screen: Screen, read: () => Promise<RouteContext>): Promise<{ allowed: true } | { allowed: false; go: Route | '/' }> {
  let ctx: RouteContext;
  try {
    ctx = await read();
  } catch {
    return { allowed: false, go: '/' };
  }
  return routeAllowed(screen, ctx) ? { allowed: true } : { allowed: false, go: startRoute(ctx) };
}
