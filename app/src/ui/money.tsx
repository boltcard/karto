// The account and money screens' own parts: an
// account's header and pill buttons, its history by day, and the step bar, read-back and result page that Send
// out and Move share. Colours from the theme; what each shows is decided by pure functions (money/format.ts
// historyRows, money/steps.ts, wallet/accountView.ts).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextInputProps } from 'react-native';
import { currencyOf, symbol, typedFiatLine, type CurrencyCode, type Rated } from '../money/fiat';
import { convertTyped, type HistoryDay } from '../money/format';
import type { ProofRow } from '../money/payment';
import { barLabel, type ReadRow } from '../money/steps';
import { ageLine, altText, shown, type View as ViewKind } from '../money/view';
import { useAmountView } from './amountView';
import { Icon, type IconName } from './icons';
import { buttonColours } from './look';
import { AMOUNT, MONO, TYPE, type Theme } from './theme';
import { Field, Tag } from './ui';
import { useStyles, useTheme } from './useTheme';

// The result page is Karto PoS's too: it lives in result.tsx.
export { ResultPage } from './result';

/**
 * The top of an account's page: "Available" over the balance as a large Amount with the other figure under it,
 * beside a small card for a card's page (card, from ui/wallet.tsx's SmallCard). msat: the available
 * balance, or null until the wallet answers ("…"). note: under the balance, a frozen card's tag or a part-way
 * state's name. held: a hold's line.
 */
export function AccountHeader({ card, msat, note, held }: { card?: ReactNode; msat: number | null; note?: { tag: boolean; text: string } | null; held?: string }) {
  const s = useStyles(makeStyles);
  return (
    <View style={layout.header}>
      {card}
      <View style={layout.headerBody}>
        <Text style={s.available}>Available</Text>
        {msat === null ? (
          <Text style={s.balance} accessibilityLabel="Available: not known yet">
            …
          </Text>
        ) : (
          <Amount msat={msat} size="large" alt />
        )}
        {note && (note.tag ? <Tag quiet>{note.text}</Tag> : <Text style={s.available}>{note.text}</Text>)}
        {!!held && <Text style={s.available}>{held}</Text>}
      </View>
    </View>
  );
}

/**
 * An amount in the wallet's view, drawn as Phoenix draws one: the
 * number in the amount's style, its unit (GBP, sat, msat) smaller and muted after it on the same baseline, no unit
 * when hidden. It is text: the view is set in Settings and by the Wallet page's eye; TalkBack reads the figure in
 * words. size: large (a balance), mid (Check's figure), row (a list's, right-aligned). sign: '+' or '−' before the
 * number, never on ***. alt: the other figure small under it ("≈ £8.15" under sat or msat, "13,291 sat" under £).
 * force: drawn in this view whatever the app's (Send out, Move and Renew show the unit while amounts are
 * hidden). incoming: green, as money in. onBand: on the dark title band, in its colours.
 */
export function Amount({ msat, size = 'row', sign, alt, force, incoming, onBand, struck }: {
  msat: number; size?: 'large' | 'mid' | 'row'; sign?: '+' | '−'; alt?: boolean; force?: ViewKind; incoming?: boolean; onBand?: boolean;
  /** Struck through and muted: a till sale given back. */
  struck?: boolean;
}) {
  const s = useStyles(makeStyles);
  const { view, rated } = useAmountView();
  const v = force ?? view;
  const a = shown(msat, v, rated);
  const signed = a.unit === '' ? '' : (sign ?? '');
  const said = `${signed === '+' ? 'plus ' : signed === '−' ? 'minus ' : ''}${a.spoken}`;
  const under = alt ? altText(msat, v, rated) : null;
  const figure = size === 'large' ? s.largeFigure : size === 'mid' ? s.midFigure : s.rowFigure;
  const unit = size === 'large' ? s.largeUnit : size === 'mid' ? s.midUnit : s.rowUnit;
  return (
    <View style={size === 'row' ? layout.amountRow : undefined}>
      <Text
        accessibilityLabel={said}
        style={[figure, incoming && !struck && s.amountIn, onBand && s.onBand, struck && s.struck]}
      >
        {signed}
        {signed && a.number.startsWith('< ') ? `under ${a.number.slice(2)}` : a.number}
        {a.unit !== '' && <Text style={[unit, onBand && s.onBandMuted]}>{` ${a.unit}`}</Text>}
      </Text>
      {under !== null && <Text style={[s.alt, onBand && s.onBandMuted]}>{under}</Text>}
    </View>
  );
}

/**
 * The rate's age at the top of Home, the account pages and Check, while it is over an hour and a £ figure can be
 * on screen: "£ at a rate 2 h old". The clock is read again each minute. unit: the page's own, where it draws its
 * amounts in the chosen unit while they are hidden (a confirm page), so a £ figure there gets the line too.
 */
export function RateAgeLine({ unit }: { unit?: ViewKind } = {}) {
  const s = useStyles(makeStyles);
  const { rated, view: appView } = useAmountView();
  const view = unit ?? appView;
  const [nowS, setNowS] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNowS(Date.now() / 1000), 60_000);
    return () => clearInterval(t);
  }, []);
  const line = ageLine(rated, view, nowS);
  if (line === null) return null;
  return (
    <View style={s.age} accessible accessibilityRole="text" accessibilityLabel={line}>
      <Text style={s.ageText}>{line}</Text>
    </View>
  );
}

/** A figure in the balance's large type: Pay LNVPS's price. */
export function Figure({ children }: { children: string }) {
  const s = useStyles(makeStyles);
  return <Text style={s.balance}>{children}</Text>;
}

/** A row of pill buttons, wrapping onto a second line when it must (hosting's four, a large font). */
export const Pills = ({ children }: { children: ReactNode }) => <View style={layout.pills}>{children}</View>;

/**
 * A pill button: an icon and its label. main: the page's main act (Top up), orange; the others are outlined. Off,
 * it is muted on surface (look.ts buttonColours), readable in both modes. 40 dp tall, pressed over 48.
 */
export function PillButton({ icon, label, onPress, disabled, main }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; main?: boolean }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const c = buttonColours(main ? 'primary' : 'secondary', !!disabled, t);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => [layout.pill, { backgroundColor: c.fill, borderColor: c.border }, pressed && layout.dim]}
    >
      <Icon name={icon} colour={c.text} size={18} />
      <Text style={[s.pillText, { color: c.text }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * An account's history, grouped by day (money/format.ts historyRows): one panel, a small heading for each day; each
 * figure an Amount in the app's view. Each row opens its line's page when onOpen is given; a row with a
 * payer's note shows it in quotes as a third line, and the person's own note after it.
 */
export function HistoryList({ days, onOpen }: { days: HistoryDay[]; onOpen?: (id: number) => void }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <View style={s.history}>
      {days.map((d, i) => (
        <View key={`${i}-${d.day}`}>
          <Text style={[s.day, i > 0 && s.divider]} accessibilityRole="header">
            {d.day}
          </Text>
          {d.rows.map((r) => {
            const content = (
              <>
                <View style={s.entryIcon}>
                  <Icon name={r.icon} colour={t.muted} size={18} />
                </View>
                <View style={layout.entryBody}>
                  <View style={layout.nameRow}>
                    <Text style={s.entryName}>{r.name}</Text>
                    {/* A till sale refunded from this wallet: the tag, and the figure struck through. */}
                    {r.refunded && <Text style={s.tag}>Refunded</Text>}
                  </View>
                  <Text style={s.entryLine}>{r.line}</Text>
                  {/* A top-up's payer's note: someone else's words, in quotes; plain text, never a link. */}
                  {r.payerNote !== '' && (
                    <Text style={s.entryNote} numberOfLines={3}>
                      {r.payerNote}
                    </Text>
                  )}
                  {r.comment !== '' && (
                    <Text style={s.entryNote} numberOfLines={3}>
                      {r.comment}
                    </Text>
                  )}
                </View>
                {/* The figure in the app's view; in £ view it is today's value, marked "now". */}
                <View style={layout.entryEnd}>
                  <Amount msat={r.msat} size="row" sign={r.sign === '' ? undefined : r.sign} incoming={r.incoming} struck={r.refunded} />
                  {r.now && <Text style={s.now}>now</Text>}
                </View>
              </>
            );
            // Without onOpen a row is plain text: a disabled Pressable would be announced as disabled.
            return onOpen ? (
              <Pressable
                key={r.id}
                onPress={() => onOpen(r.id)}
                accessible
                accessibilityRole="button"
                accessibilityLabel={r.label}
                accessibilityHint="Opens its page"
                style={({ pressed }) => [layout.entry, s.divider, pressed && layout.dim]}
              >
                {content}
              </Pressable>
            ) : (
              <View key={r.id} accessible accessibilityRole="text" accessibilityLabel={r.label} style={[layout.entry, s.divider]}>
                {content}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * A step bar: its steps' names (Send out's and Move's To, Amount, Check; Add card's Name, Hold, Photo), the current
 * one in bold and the bars before it orange. at: the current step, from 0. One element for TalkBack.
 */
export function StepBar({ names, at }: { names: readonly string[]; at: number }) {
  const s = useStyles(makeStyles);
  return (
    <View style={layout.steps} accessible accessibilityRole="text" accessibilityLabel={barLabel(names, at)}>
      {names.map((name, i) => (
        <View key={name} style={[layout.steps, i > 0 && layout.stepGrow]}>
          {i > 0 && <View style={[s.stepBar, i <= at && s.stepBarDone]} />}
          <Text style={[s.stepName, i === at && s.stepNow]}>{name}</Text>
        </View>
      ))}
    </View>
  );
}

/** The unit an amount is typed in, beside its field: "£ GBP" or "sat"; a tap switches it. */
export function UnitChip({ unit, currency, onPress }: { unit: 'fiat' | 'sat'; currency: CurrencyCode; onPress: () => void }) {
  const s = useStyles(makeStyles);
  const sign = symbol(currency).trim();
  const [now, other] = unit === 'fiat' ? [currency, 'sat'] : ['sat', currency];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Typing in ${now}. Tap to type in ${other}.`} onPress={onPress} hitSlop={8} style={({ pressed }) => [s.chip, pressed && layout.dim]}>
      <Text style={s.chipText}>{unit === 'sat' ? 'sat' : sign === currency ? currency : `${sign} ${currency}`}</Text>
    </Pressable>
  );
}

/**
 * The Amount step's field, in large type: whole sats; or, with the server's currency and a rate, the unit
 * the phone last typed in, with its chip (a tap switches the unit for every field and turns what is typed into it)
 * and, while in the currency, the sats it comes to at the rate under it. No chip with the currency none or no rate.
 * What is typed keeps its unit: when the unit changes without the chip (a rate arriving or going), the field is
 * emptied, never its figure read in the other unit ("5" typed in £ is not 5 sat).
 */
export function AmountField({ value = '', onChangeText, ...props }: TextInputProps) {
  const s = useStyles(makeStyles);
  const { rated, typingUnit, setTypingUnit } = useAmountView();
  // The rate the field types at: none while it types sat.
  const r = typingUnit === 'fiat' ? rated : null;
  // The unit what is in the field was typed in, or the chip turned it into.
  const textUnit = useRef(typingUnit);
  useEffect(() => {
    if (textUnit.current === typingUnit) return;
    textUnit.current = typingUnit;
    if (value !== '') onChangeText?.('');
  }, [typingUnit, value, onChangeText]);
  const flip = () => {
    if (!rated) return;
    const to = typingUnit === 'fiat' ? 'sat' : 'fiat';
    // The chip's own change: what is typed is turned into the new unit, not emptied.
    textUnit.current = to;
    setTypingUnit(to);
    if (value !== '') onChangeText?.(convertTyped(value, to, rated));
  };
  return (
    <View style={layout.amountBox}>
      <View style={layout.amountLine}>
        <View style={layout.grow}>
          <Field
            keyboardType={r && currencyOf(r.currency).decimals > 0 ? 'decimal-pad' : 'number-pad'}
            value={value}
            onChangeText={onChangeText}
            {...props}
            style={s.amountField}
          />
        </View>
        {rated && <UnitChip unit={typingUnit} currency={rated.currency} onPress={flip} />}
      </View>
      {r && <Text style={s.available}>{typedFiatLine(value, r)}</Text>}
    </View>
  );
}

/** Where the money comes from, at the top of Send's To step: a small label over a figure in large type ("48,500 sat available"). */
export function FromLine({ label, figure }: { label: string; figure: string }) {
  const s = useStyles(makeStyles);
  return (
    <View accessible accessibilityLabel={`${label}: ${figure}`}>
      <Text style={s.available}>{label}</Text>
      <Text style={s.fromFigure}>{figure}</Text>
    </View>
  );
}

/** A read-back amount row as a screen reader hears it: "Amount: 13,291 sat, ≈ £8.15", the other figure too. */
const readAmountLabel = (label: string, msat: number, v: ViewKind, r: Rated | null) => {
  const under = altText(msat, v, r);
  return `${label}: ${shown(msat, v, r).spoken}${under ? `, ${under}` : ''}`;
};

/**
 * Label and value lines in a panel: Check's read-back (money/steps.ts sendReadBack, moveReadBack), a card's limits on
 * its page, the pay screen's balance. A value that is an amount is drawn as one, with the other figure under it,
 * in force's view (Check's: the chosen unit, also while amounts are hidden).
 */
export function ReadBack({ rows, force }: { rows: ReadRow[]; force?: ViewKind }) {
  const s = useStyles(makeStyles);
  const { view, rated } = useAmountView();
  return (
    <View style={s.readBack}>
      {rows.map(([label, value]) =>
        typeof value === 'string' ? (
          <View key={label} style={layout.readRow} accessible accessibilityLabel={`${label}: ${value}`}>
            <Text style={s.readLabel}>{label}</Text>
            <Text style={s.readValue}>{value}</Text>
          </View>
        ) : (
          // One element, as a string row: the amount is text.
          <View key={label} style={layout.readRow} accessible accessibilityLabel={readAmountLabel(label, value.msat, force ?? view, rated)}>
            <Text style={s.readLabel}>{label}</Text>
            <View style={layout.readAmount}>
              <Amount msat={value.msat} size="mid" alt force={force} />
            </View>
          </View>
        ),
      )}
    </View>
  );
}

/**
 * A payment page's amount: a large Amount in the app's view with the other figure under it,
 * "+" and green when it came in; in £ view, today's value, "now" right under it and the sats under that; then
 * the status, green with a tick when it was paid.
 */
export function PaymentAmount({ msat, sign, now, incoming, status, paid }: { msat: number; sign: '+' | ''; now: boolean; incoming: boolean; status: string; paid: boolean }) {
  const s = useStyles(makeStyles);
  const { view, rated } = useAmountView();
  // In £ view "now" goes right under the figure it marks, then the sats.
  const sats = now ? altText(msat, view, rated) : null;
  return (
    <View>
      <Amount msat={msat} size="large" alt={!now} sign={sign || undefined} incoming={incoming} />
      {now && <Text style={s.alt}>now</Text>}
      {sats !== null && <Text style={s.alt}>{sats}</Text>}
      {status !== '' && <Text style={paid ? s.statusPaid : s.available}>{paid ? `✓ ${status}` : status}</Text>}
    </View>
  );
}

/** PROOF's rows: each value shortened in a monospaced face, with Copy (44 dp tall) when there's something to copy. */
export function ProofList({ rows, onCopy }: { rows: ProofRow[]; onCopy: (row: ProofRow) => void }) {
  const s = useStyles(makeStyles);
  return (
    <View style={s.readBack}>
      {rows.map((r) => (
        <View key={r.label} style={layout.readRow}>
          <View style={layout.entryBody} accessible accessibilityLabel={`${r.label}: ${r.spoken}`}>
            <Text style={s.readLabel}>{r.label}</Text>
            <Text style={r.full ? s.proofValue : s.readLabel}>{r.short}</Text>
          </View>
          {r.full && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${r.copyName}`} onPress={() => onCopy(r)} style={({ pressed }) => [s.copyButton, pressed && layout.dim]}>
              <Text style={s.copyText}>Copy</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

// A style that changes TYPE.body's or TYPE.small's fontSize sets its own lineHeight with it.
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    available: { ...TYPE.small, color: t.muted },
    // The unit shares the figure's line: with TYPE.body's own line height it squeezed the line and cut the figure's foot (seen on the phone).
    balance: { ...TYPE.title, fontSize: 32, lineHeight: 40, fontWeight: '600', color: t.text, ...AMOUNT },
    pillText: { ...TYPE.small, fontSize: 14, lineHeight: 19, fontWeight: '600' },
    history: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, overflow: 'hidden' },
    divider: { borderTopWidth: 1, borderTopColor: t.line },
    day: { ...TYPE.small, fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted, backgroundColor: t.bg, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
    entryIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' },
    entryName: { ...TYPE.body, fontWeight: '600', color: t.text },
    tag: { ...TYPE.small, fontSize: 12, lineHeight: 16, fontWeight: '600', color: t.muted, borderWidth: 1, borderColor: t.line, borderRadius: 999, paddingHorizontal: 8 },
    struck: { textDecorationLine: 'line-through', color: t.muted },
    entryLine: { ...TYPE.small, color: t.muted },
    entryNote: { ...TYPE.small, color: t.text },
    amount: { ...TYPE.body, fontWeight: '600', color: t.text, textAlign: 'right', ...AMOUNT },
    amountIn: { color: t.ok },
    now: { ...TYPE.small, fontSize: 11, lineHeight: 14, color: t.muted, textAlign: 'right' },
    // Amount's three sizes: the unit's line height is its figure's, so the two share a baseline without cutting the figure's foot.
    largeFigure: { ...TYPE.title, fontSize: 32, lineHeight: 40, fontWeight: '600', color: t.text, ...AMOUNT },
    largeUnit: { ...TYPE.body, fontSize: 20, lineHeight: 40, fontWeight: '600', color: t.muted },
    midFigure: { ...TYPE.title, fontSize: 20, lineHeight: 26, fontWeight: '700', color: t.text, ...AMOUNT },
    midUnit: { ...TYPE.small, fontSize: 13, lineHeight: 26, fontWeight: '600', color: t.muted },
    rowFigure: { ...TYPE.body, fontWeight: '600', color: t.text, textAlign: 'right', ...AMOUNT },
    rowUnit: { ...TYPE.small, fontSize: 11, lineHeight: 21, fontWeight: '600', color: t.muted },
    alt: { ...TYPE.small, color: t.muted, ...AMOUNT },
    onBand: { color: t.headerText },
    onBandMuted: { color: t.headerMuted },
    age: { backgroundColor: t.warnBg, borderWidth: 1, borderColor: t.warnLine, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
    ageText: { ...TYPE.small, color: t.text },
    stepBar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: t.line },
    stepBarDone: { backgroundColor: t.accent },
    stepName: { ...TYPE.small, fontWeight: '600', color: t.muted },
    stepNow: { color: t.text },
    amountField: { ...TYPE.title, fontSize: 24, lineHeight: 30 },
    chip: { borderWidth: 1, borderColor: t.line, backgroundColor: t.selected, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
    chipText: { ...TYPE.small, fontWeight: '600', color: t.text },
    fromFigure: { ...TYPE.title, fontSize: 24, lineHeight: 30, fontWeight: '600', color: t.text, ...AMOUNT },
    readBack: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 14, gap: 8 },
    readLabel: { ...TYPE.small, color: t.muted, width: '38%' },
    readValue: { ...TYPE.small, color: t.text, flex: 1, ...AMOUNT },
    statusPaid: { ...TYPE.small, color: t.ok },
    proofValue: { ...TYPE.small, color: t.text, ...Platform.select(MONO) },
    copyButton: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: t.outline, borderRadius: 8, justifyContent: 'center' },
    copyText: { ...TYPE.small, color: t.outlineText },
  });

const layout = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerBody: { flex: 1, gap: 4 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  dim: { opacity: 0.5 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 52 },
  entryBody: { flex: 1, gap: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entryEnd: { alignItems: 'flex-end' },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepGrow: { flex: 1 },
  readRow: { flexDirection: 'row', gap: 12 },
  readAmount: { flex: 1, alignItems: 'flex-start' },
  amountRow: { alignItems: 'flex-end' },
  amountBox: { gap: 6 },
  amountLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
});
