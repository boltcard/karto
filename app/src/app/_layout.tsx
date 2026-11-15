// The app's root: the services, the stack of screens on the theme's background, and the status bar's light
// icons over every screen's dark title band.
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { ServerProvider } from '../services/server';
import { checkAlertsOnOpen, ServicesProvider, useServices } from '../services/services';
import { useTheme } from '../ui/useTheme';

export default function Layout() {
  const t = useTheme();
  // The window under the screens shows during transitions and behind the keyboard: the background colour, so
  // nothing flashes white in dark mode. Only a colour: a refusal changes nothing else.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(t.bg).catch(() => undefined);
  }, [t.bg]);
  return (
    <ServicesProvider>
      <ServerProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
        <AlertsOnOpen />
      </ServerProvider>
      <StatusBar style="light" />
    </ServicesProvider>
  );
}

/**
 * Alerts' check on each open: as the app starts and each time it
 * comes back to the front. It does nothing before the wallet is set up, and nothing it meets reaches the screens.
 */
function AlertsOnOpen() {
  const sv = useServices();
  useEffect(() => {
    const check = () => void checkAlertsOnOpen(sv).catch(() => {});
    check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, [sv]);
  return null;
}
