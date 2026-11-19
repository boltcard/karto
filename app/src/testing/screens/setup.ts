// Setup for the screen tests: each test's render is unmounted after it, and the native-only packages
// every screen reaches through ui/ui.tsx are replaced by what a test needs of them.
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(cleanup);

// No safe area on a test page: the screens draw as if the phone had no notch and no navigation bar.
vi.mock('react-native-safe-area-context', () => {
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    useSafeAreaInsets: () => insets,
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
  };
});

// react-native-web hands a Pressable its new props (enabled again, the new onPress) in an effect run after the
// screen is drawn. A test presses as soon as it sees the new screen, and on a busy machine React's scheduler can stop
// between the drawing and that effect: the press came to a button still disabled, and was dropped (the alerts
// tests, 3 runs in 32 under load). Here the props are handed over as the screen is drawn, before a test can see it.
// A person can't press inside that gap, so this changes nothing a test proves. Its PressResponder is the package's
// own: if react-native-web moves it, this import fails, rather than the old hook coming back unnoticed.
vi.mock('react-native-web/dist/modules/usePressEvents', async () => {
  const { useLayoutEffect, useRef } = await import('react');
  type Responder = { configure(config: unknown): void; reset(): void; getEventHandlers(): unknown };
  const { default: PressResponder } = await vi.importActual<{ default: new (config: unknown) => Responder }>(
    'react-native-web/dist/modules/usePressEvents/PressResponder',
  );
  return {
    default: function usePressEvents(_hostRef: unknown, config: unknown) {
      const ref = useRef<Responder | null>(null);
      ref.current ??= new PressResponder(config);
      const responder = ref.current;
      useLayoutEffect(() => responder.configure(config), [config, responder]);
      useLayoutEffect(() => () => responder.reset(), [responder]);
      return responder.getEventHandlers();
    },
  };
});

// Expo Router's navigator is native; a screen test sees where a screen sends the person through these calls.
// useFocusEffect is focus.ts's: on mount, and again at its refocus().
vi.mock('expo-router', async () => {
  const { useFocusEffect } = await import('./focus');
  return {
    router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), navigate: vi.fn(), dismissTo: vi.fn(), canGoBack: vi.fn(() => true) },
    useFocusEffect,
    // A screen under test is the one in front.
    useIsFocused: vi.fn(() => true),
    useLocalSearchParams: vi.fn(() => ({})),
    useGlobalSearchParams: vi.fn(() => ({})),
    usePathname: vi.fn(() => '/'),
    // A screen's own navigator options (the swipe back) and a redirect draw nothing here.
    Stack: { Screen: () => null },
    Redirect: () => null,
  };
});
