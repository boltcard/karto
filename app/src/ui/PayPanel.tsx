// Step 5: pay the VM's invoice from any
// wallet. The invoice part also pays a day on an expired old server during a rebuild.
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { thousands } from '../money/format';
import { INVOICE_RENEW_BEFORE_MS, MAX_PAY_DAYS, MIN_PAY_DAYS, PAY_DAY_PRESETS, paySat, withPayDays, type OnboardingState } from '../onboarding/machine';
import { countdown, payFoot, payWithin } from '../onboarding/progress';
import type { OnboardingRunner } from '../onboarding/runner';
import { buttonColours } from './look';
import { Figure } from './money';
// PayPanel stays in sat on purpose: onboarding and rebuild have no server, so no currency or rate.
import { TYPE } from './theme';
import { Body, Button, QrTile, Small } from './ui';
import { useTheme } from './useTheme';

/** LNVPS's clock, ticking each second, for the invoice's countdown. */
function useServerNow(serverTime: () => number): number {
  const [now, setNow] = useState(serverTime());
  useEffect(() => {
    const t = setInterval(() => setNow(serverTime()), 1000);
    return () => clearInterval(t);
  }, [serverTime]);
  return now;
}

export function PayPanel({ s, runner, serverTime }: { s: OnboardingState; runner: OnboardingRunner; serverTime: () => number }) {
  const now = useServerNow(serverTime);
  // Each press is timed, so the invoice waits until the presses stop.
  const days = (n: number) => runner.update((x) => withPayDays(x, n, runner.deps.now()));

  // An order about to expire: the line under the heading says so, and nothing is offered to pay.
  if (s.waiting === 'order_expiring') return null;
  const inv = s.invoice;
  const paidFor = inv?.days ?? s.payDays;
  // Before the invoice comes, what the days cost at the price of a day already asked for: the figure the invoice has.
  const price = s.payPrice?.vmId === s.vmId ? s.payPrice : undefined;
  const sat = inv?.sat ?? (price ? paySat(s.payDays, price.satPerDay) : null);
  return (
    <>
      <View>
        <Figure>{sat !== null ? `${thousands(sat)} sat` : '…'}</Figure>
        <Body muted>
          for {paidFor} {paidFor === 1 ? 'day' : 'days'} of hosting
        </Body>
      </View>
      <View style={styles.days}>
        <DayButton label="−" spoken="One day fewer" onPress={() => days(s.payDays - 1)} disabled={s.payDays <= MIN_PAY_DAYS} />
        {PAY_DAY_PRESETS.map((n) => (
          <DayButton key={n} label={String(n)} spoken={`${n} days`} on={n === s.payDays} onPress={() => days(n)} />
        ))}
        <DayButton label="+" spoken="One day more" onPress={() => days(s.payDays + 1)} disabled={s.payDays >= MAX_PAY_DAYS} />
      </View>
      {inv && <Invoice bolt11={inv.bolt11} within={payWithin(s, now)} />}
    </>
  );
}

/** An expired old server's day: its invoice, renewed by the machine as onboarding's is. */
export function OldServerPayPanel({ s, serverTime }: { s: OnboardingState; serverTime: () => number }) {
  const now = useServerNow(serverTime);
  const inv = s.rebuild?.oldInvoice;
  return (
    <>
      <View>
        <Figure>{inv ? `${thousands(inv.sat)} sat` : '…'}</Figure>
        <Body muted>for a day of hosting on the old server (VM {s.rebuild?.oldVm?.id}), from any wallet</Body>
      </View>
      {inv && <Invoice bolt11={inv.bolt11} within={countdown(inv.expiresAt - INVOICE_RENEW_BEFORE_MS, now)} />}
    </>
  );
}

/**
 * One of the days row's five buttons: −, a preset (7, 14, 30) or +. Outlined, as a secondary button; the chosen
 * preset orange, as a primary. spoken: what TalkBack reads ("One day fewer", "7 days").
 */
function DayButton({ label, spoken, on, onPress, disabled }: { label: string; spoken: string; on?: boolean; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  const c = buttonColours(on ? 'primary' : 'secondary', !!disabled, t);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ selected: !!on, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.day, { backgroundColor: c.fill, borderColor: c.border }, pressed && styles.dim]}
    >
      <Text style={[styles.dayText, { color: c.text }]}>{label}</Text>
    </Pressable>
  );
}

/** A Lightning invoice to pay from any wallet: its QR code, a wallet to open it in, a copy, and how long it shows. */
function Invoice({ bolt11, within }: { bolt11: string; within: string | null }) {
  const open = async () => {
    try {
      await Linking.openURL(`lightning:${bolt11}`);
    } catch {
      Alert.alert('No Lightning wallet', 'No app on this phone opens Lightning invoices. Copy the invoice, or scan the QR code with another phone.');
    }
  };
  return (
    <>
      <QrTile value={bolt11.toUpperCase()} label="QR code for this invoice" />
      <View style={styles.pair}>
        <View style={styles.half}>
          <Button title="Open wallet" onPress={open} />
        </View>
        <View style={styles.half}>
          <Button title="Copy invoice" kind="secondary" onPress={() => Clipboard.setStringAsync(bolt11)} />
        </View>
      </View>
      <Small>{payFoot(within)}</Small>
    </>
  );
}

const styles = StyleSheet.create({
  days: { flexDirection: 'row', gap: 6 },
  // 44 dp tall; − and + as wide as a preset, so the five share the row.
  day: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dayText: { ...TYPE.button },
  dim: { opacity: 0.5 },
  // The QR code's quiet zone stays white in both modes, or it won't scan.
  pair: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
});
