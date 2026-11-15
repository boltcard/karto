// How alerts stand, for Settings' row and the Alerts page:
// the phone's side read from the native module, the server's from GET /api/v1/push, both again when the page is
// shown and when the app comes back to the front (from ntfy, or Android's settings).
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { CarddClient, PushState } from '../cardd/client';
import type { AlertsNativeApi } from '../native/api';
import { alertsView, type AlertsInput, type AlertsView } from './alertsView';
import { alertsSupported, readPhone } from './register';
import { isPlayBuild } from './store';

export type Alerts = {
  /** The phone has alerts (Android's module). */
  supported: boolean;
  phone: Omit<AlertsInput, 'server'> | null;
  server: PushState | null;
  /** The server's read failed: its error. */
  error: unknown;
  /** null where the phone has no alerts. */
  view: AlertsView | null;
  reload(): Promise<void>;
};

export function useAlerts(native: Partial<AlertsNativeApi>, cardd: Pick<CarddClient, 'push'> | null): Alerts {
  const supported = alertsSupported(native);
  const [phone, setPhone] = useState(() => (alertsSupported(native) ? readPhone(native, isPlayBuild) : null));
  const [server, setServer] = useState<PushState | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    if (!alertsSupported(native)) return;
    setPhone(readPhone(native, isPlayBuild));
    if (!cardd) return;
    try {
      setServer(await cardd.push());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [native, cardd]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void reload();
    });
    return () => sub.remove();
  }, [reload]);

  return { supported, phone, server, error, view: phone ? alertsView({ server, ...phone }) : null, reload };
}
