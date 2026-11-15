// Karto PoS's own parts: the till's figure and pad, the line with a dot under a
// sale, the Paid page, and the row with a switch. The wallet's Screen, buttons, panels and theme are used as they
// are (ui/ui.tsx); colours come from the theme and text scales.
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Icon } from '../ui/icons';
import { ResultPage } from '../ui/result';
import { AMOUNT, TYPE, type Theme } from '../ui/theme';
import { Small } from '../ui/ui';
import { useStyles, useTheme } from '../ui/useTheme';
import type { PosSale } from './client';
import { KEYS } from './keypad';
import { paidView, saleFigure, type PaidHow } from './sale';

/**
 * The amount being typed, large and centred, its unit smaller after it on the baseline ("2.50" GBP, "2,500" sat), and
 * for a price the sats it comes to under it; TalkBack reads it as one ("2 pounds 50, about 4,075 sat").
 */
export function Figure({ figure, unit, label, under }: { figure: string; unit: string; label: string; under: string | null }) {
  const s = useStyles(makeStyles);
  return (
    <View
      style={layout.figureBlock}
      accessible
      accessibilityRole="text"
      accessibilityLabel={under === null ? label : `${label}, ${under.replace('≈ ', 'about ')}`}
      accessibilityLiveRegion="polite"
    >
      <View style={layout.figure}>
        <Text style={s.figure}>{figure}</Text>
        <Text style={s.unit}>{` ${unit}`}</Text>
      </View>
      {under !== null && <Text style={s.under}>{under}</Text>}
    </View>
  );
}

/** The pad: twelve keys in three columns, each at least 54 dp tall, named by its digit ("Double zero" for 00, "Delete" for ⌫). */
export function Keypad({ onKey, disabled }: { onKey: (key: string) => void; disabled?: boolean }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={layout.pad}>
      {KEYS.map((k) => (
        <Pressable
          key={k}
          accessibilityRole="button"
          accessibilityLabel={k === 'delete' ? 'Delete' : k === '00' ? 'Double zero' : k}
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled}
          onPress={() => onKey(k)}
          style={({ pressed }) => [s.key, (pressed || disabled) && layout.dim]}
        >
          {k === 'delete' ? <Icon name="back" colour={t.text} size={22} /> : <Text style={s.keyText}>{k}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

/** A line beside a dot: "Waiting for payment · 9:41 left". */
export function DotLine({ children }: { children: string }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={layout.dotLine}>
      <View style={[layout.dot, { backgroundColor: t.accent }]} />
      <Text style={s.line}>{children}</Text>
    </View>
  );
}

/** A sale's figure over its pages: 34, bold, its unit smaller after it, and a priced sale's sats under it (pos/sale.ts saleFigure). */
export function SaleAmount({ sale }: { sale: Pick<PosSale, 'amountMsat' | 'price'> }) {
  const s = useStyles(makeStyles);
  const f = saleFigure(sale);
  return (
    <View style={layout.figureBlock} accessible accessibilityRole="text" accessibilityLabel={f.label}>
      <View style={layout.figure}>
        <Text style={s.amount}>{f.figure}</Text>
        <Text style={s.saleUnit}>{` ${f.unit}`}</Text>
      </View>
      {f.under !== null && <Text style={s.under}>{f.under}</Text>}
    </View>
  );
}

/**
 * Paid: a green ring, ✓, "Paid", the amount, how and when and by which phone, and New sale. It is announced when
 * it opens. how: how a sale that had ended came to be paid.
 */
export function PaidPage({ sale, how, onNewSale }: { sale: PosSale; how: PaidHow; onNewSale: () => void }) {
  const v = paidView(sale, how, Date.now() / 1000, -new Date().getTimezoneOffset());
  return (
    <>
      <ResultPage view={{ tone: 'ok', mark: 'check', title: 'Paid', line: [v.amount, v.line].join('\n') }} label={v.label} note={v.how || undefined} onDone={onNewSale} done="New sale" />
    </>
  );
}

/** A row with a switch: Sound when paid. One switch for TalkBack. */
export function SwitchLine({ name, value, onChange }: { name: string; value: boolean; onChange: (value: boolean) => void }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={name} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={({ pressed }) => [s.switchRow, pressed && layout.dim]}>
      <Text style={s.switchName}>{name}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.accent, false: t.outline }} thumbColor={value ? t.onAccent : t.surface} accessibilityElementsHidden importantForAccessibility="no" />
    </Pressable>
  );
}

/** A label over its value, in a panel: "This phone's name in the shop" over "Till 1". */
export function Fact({ label, value }: { label: string; value: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={layout.fact}>
      <Small>{label}</Small>
      <Text style={s.factValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    figure: { ...TYPE.title, fontSize: 48, lineHeight: 58, color: t.text, ...AMOUNT },
    unit: { ...TYPE.body, fontSize: 20, lineHeight: 58, color: t.muted },
    key: { flexBasis: '30%', flexGrow: 1, minHeight: 58, borderRadius: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, alignItems: 'center', justifyContent: 'center' },
    keyText: { ...TYPE.title, fontSize: 24, lineHeight: 30, fontWeight: '600', color: t.text, ...AMOUNT },
    line: { ...TYPE.body, color: t.text, flex: 1 },
    under: { ...TYPE.body, color: t.muted, textAlign: 'center', ...AMOUNT },
    saleUnit: { ...TYPE.body, fontSize: 18, lineHeight: 42, color: t.muted },
    amount: { ...TYPE.title, fontSize: 34, lineHeight: 42, color: t.text, textAlign: 'center', ...AMOUNT },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
    switchName: { ...TYPE.body, fontWeight: '600', color: t.text, flex: 1 },
    factValue: { ...TYPE.body, fontWeight: '600', color: t.text },
  });

const layout = StyleSheet.create({
  figure: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center' },
  figureBlock: { alignItems: 'center', paddingVertical: 12, gap: 2 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  dim: { opacity: 0.5 },
  dotLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  fact: { gap: 2 },
});
