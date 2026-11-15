// Pay LNVPS from any wallet: LNVPS's own
// invoice for 7, 14 or 30 days of the VM, from its Lightning address. It
// needs nothing from the server, so it works when the server is down or out
// of money (only the price comes from the server, if LNVPS won't quote it).
// A press shows what the days cost at once; the invoice comes once the presses
// stop (useLnvpsInvoice).
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { CarddClient } from '../cardd/client';
import { LnvpsClient } from '../lnvps/client';
import { hostingSyncer, PAY_PRESETS } from '../money/hosting';
import { confirmView } from '../money/view';
import { countdown } from '../onboarding/progress';
import { fetchFn, syncHostingIfDue, useRouteGuard, useServices } from '../services/services';
import { useAmountView } from '../ui/amountView';
import { Amount } from '../ui/money';
import { LNVPS_BUSY, useLnvpsInvoice, type LnvpsConnection } from '../ui/useLnvpsInvoice';
import { FIXED } from '../ui/theme';
import { Body, Button, ErrorText, goBack, Panel, Row, Screen } from '../ui/ui';

export default function PayLnvps() {
  const allowed = useRouteGuard('/pay-lnvps');
  const sv = useServices();
  const look = useAmountView();
  const [days, setDays] = useState<number>(PAY_PRESETS[0]);
  const [now, setNow] = useState(Date.now());
  // LNVPS's expiry as it stood when the first invoice showed: a payment moves it on.
  const shown = useRef<{ before: number | null } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const connect = useCallback(async (): Promise<LnvpsConnection> => {
    const [phrase, state] = await Promise.all([sv.phrase.get(), sv.store.onboarding()]);
    if (!phrase || !state?.vmId || !state.host) return null;
    const lnvps = new LnvpsClient({ fetch: fetchFn, nostrSecretKey: sv.keys(phrase).nostrPrivateKey });
    const cardd = new CarddClient({ fetch: fetchFn, host: state.host.hostname, key: sv.deviceKey });
    return { lnvps, vmId: state.vmId, cardd };
  }, [sv]);
  const { sat, invoice: inv, error, busy, retry, renew } = useLnvpsInvoice(days, allowed ? connect : null);
  useEffect(() => {
    if (inv) shown.current ??= { before: hostingSyncer.lnvpsExpires };
  }, [inv]);

  const open = async (bolt11: string) => {
    try {
      await Linking.openURL(`lightning:${bolt11}`);
    } catch {
      Alert.alert('No Lightning wallet', 'No app on this phone opens Lightning invoices. Copy the invoice, or scan the QR code with another phone.');
    }
  };
  // However the screen is left once an invoice has shown (Done, the band's arrow or Android's Back): LNVPS's new
  // expiry, read every 10 s until it moves (up to 3 minutes), as LNVPS may be slow to apply the payment. So
  // Hosting's date moves after a payment whichever way the person leaves.
  useEffect(
    () => () => {
      const invoice = shown.current;
      if (invoice) void hostingSyncer.afterPayment(() => syncHostingIfDue(sv, { force: true }), { before: invoice.before });
    },
    [sv],
  );

  if (!allowed) return <Screen busy />;
  const expired = inv !== null && now >= inv.expiresAt;
  return (
    // The pill's own name: the full one doesn't fit the band beside its arrow.
    <Screen title="Pay LNVPS" back>
      <Body muted>LNVPS&apos;s own invoice for your server, paid from any Lightning wallet. It works even when your server is down.</Body>
      <Row>
        {PAY_PRESETS.map((n) => (
          <Button key={n} title={`${n} days`} kind={n === days ? 'primary' : 'secondary'} onPress={() => setDays(n)} />
        ))}
      </Row>
      {error && (
        <>
          <ErrorText>{error}</ErrorText>
          <Button title="Try again" kind="secondary" onPress={retry} />
        </>
      )}
      {!inv && !error && sat === null && <Body muted>{busy ? LNVPS_BUSY : 'Asking LNVPS for an invoice…'}</Body>}
      {!inv && !error && sat !== null && (
        <Panel>
          <Amount msat={sat * 1000} size="large" alt force={confirmView(look.view)} />
          <Body>for {days} days of hosting</Body>
          <Body muted>{busy ? LNVPS_BUSY : 'Getting the invoice for the days chosen…'}</Body>
        </Panel>
      )}
      {inv && !expired && (
        <Panel>
          <Amount msat={inv.sat * 1000} size="large" alt force={confirmView(look.view)} />
          <Body>for {inv.days} days of hosting</Body>
          <View style={styles.qr} accessible accessibilityLabel="QR code for this invoice">
            <QRCode value={inv.bolt11.toUpperCase()} size={220} />
          </View>
          <Button title="Open wallet" onPress={() => open(inv.bolt11)} />
          <Button title="Copy invoice" kind="secondary" onPress={() => Clipboard.setStringAsync(inv.bolt11)} />
          <Body muted>Pay within {countdown(inv.expiresAt, now)}.</Body>
        </Panel>
      )}
      {expired && (
        <Panel>
          <Body>This invoice has expired.</Body>
          <Button title="New invoice" onPress={renew} />
        </Panel>
      )}
      <Button title="Done" kind="secondary" onPress={goBack} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The QR code's quiet zone stays white in both modes, or it won't scan.
  qr: { alignSelf: 'center', padding: 12, backgroundColor: FIXED.qrTile },
});
