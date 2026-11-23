// The few building blocks the screens share, in the app's look: every
// colour from the theme (ui/theme.ts, picked by ui/useTheme.ts from the phone's setting), every font from its
// type styles.
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type TextInputProps,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './icons';
import { BESIDE_DOT, buttonColours, type ButtonKind, rowColours, rowEnd, rowLabel, type RowTone, statusBarGround, toneColour, wordNumberWidth } from './look';
import { alpha, AMOUNT, FIXED, TYPE, type Theme } from './theme';
import { useStyles, useTheme } from './useTheme';

/**
 * A screen: the title band, then the page, which scrolls. The band reaches up under the status bar, so the bar's
 * light icons always sit on it. It holds the screen's title, a subtitle under the title (only the welcome
 * screen's) and, at its end, right (the wallet's ⚙︎). It is drawn on every screen at the same height, empty
 * without a title, busy screens included. busyText: what a busy screen is doing, under the spinner, when the wait can be long.
 * back: an arrow at the band's start that goes back, or to the wallet when a link opened the screen;
 * given a function, the arrow calls it instead (Send's and Move's steps: a step back). fill: the page is one view
 * that fills the screen, with no scroll and no padding (the QR scanner's camera).
 */
export function Screen({ title, titleAfter, subtitle, right, children, busy, busyText, back, fill }: {
  title?: string; titleAfter?: string; subtitle?: string; right?: ReactNode; children?: ReactNode; busy?: boolean; busyText?: string; back?: boolean | (() => void);
  fill?: boolean;
}) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const foot = { paddingBottom: 20 + insets.bottom };
  return (
    <View style={[s.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={[s.band, { paddingTop: insets.top + 8 }]}>
        {/* Always a title's line, so the band doesn't grow when a busy screen's page, or a name, arrives. */}
        <View style={layout.bandRow}>
          {back && <Back onPress={typeof back === 'function' ? back : undefined} />}
          {/* titleAfter: Home's "Wallet · <the wallet's name>", dimmer, on the one line, cut short at its end. */}
          <Text style={s.bandTitle} accessibilityRole="header" numberOfLines={titleAfter ? 1 : undefined}>
            {title ?? ' '}
            {titleAfter ? <Text style={s.bandTitleAfter}>{` · ${titleAfter}`}</Text> : null}
          </Text>
          {right}
        </View>
        {subtitle !== undefined && <Text style={s.bandSubtitle}>{subtitle}</Text>}
      </View>
      {busy ? (
        <View style={[layout.busy, foot]}>
          <ActivityIndicator size="large" color={t.muted} />
          {busyText && <Text style={[s.body, s.muted, layout.centred]}>{busyText}</Text>}
        </View>
      ) : fill ? (
        <View style={layout.fill}>{children}</View>
      ) : (
        <ScrollView contentContainerStyle={[layout.content, foot]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      )}
    </View>
  );
}

/** Back, or to the wallet when a link opened the screen, as the phrase screen's Done does. */
// On Home's band, the eye's and the gear's reach past their edges, and the gap between them: the gap holds both reaches,
// so a press between them is never taken by the wrong one.
export const BAND_END = { eyeSlop: 10, gearSlop: 12, gap: 24 };

export const goBack = () => (router.canGoBack() ? router.back() : router.replace('/home'));

/** The band's back arrow: goBack, or the screen's own handler. */
function Back({ onPress }: { onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={onPress ?? goBack} style={({ pressed }) => pressed && layout.dim}>
      <Icon name="back" colour={t.headerText} size={24} />
    </Pressable>
  );
}

/** ⋯ at the band's end (Screen's right): a card's More. */
export function BandMenu({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="More" hitSlop={12} onPress={onPress} style={({ pressed }) => pressed && layout.dim}>
      <Icon name="more" colour={t.headerText} size={24} />
    </Pressable>
  );
}

/** A heading in the page: Settings' sections, an account's History, a sheet's title, a result line. The screen's own title is Screen's. */
export function Title({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <Text style={s.title}>{children}</Text>;
}

/** selectable: the person can select and copy it (an address). */
export function Body({ children, muted, selectable }: { children: ReactNode; muted?: boolean; selectable?: boolean }) {
  const s = useStyles(makeStyles);
  return (
    <Text style={[s.body, muted && s.muted]} selectable={selectable}>
      {children}
    </Text>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <Text style={[s.body, s.error]}>{children}</Text>;
}

/** Words that need doing something about, but aren't an error: amber (the cards to re-point). */
export function WarnText({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <Text style={[s.body, s.warn]}>{children}</Text>;
}

/** An amber box that stands out from the page around it. */
export function Callout({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <View style={s.callout}>{children}</View>;
}

/**
 * A yellow tag: something ready for the person, or the tap that puts a warning right (Update ready, Turn on).
 * quiet: muted on surface with a line border, a state that asks for nothing (a frozen card's Frozen).
 */
export function Tag({ children, quiet }: { children: string; quiet?: boolean }) {
  const s = useStyles(makeStyles);
  return <Text style={[s.tag, quiet && s.tagQuiet]}>{children}</Text>;
}

/**
 * A group's small heading in capitals, over its panel (History, From, Move to). action: a word at its right that
 * acts on the group (Recent's Edit), in accentText.
 */
export function GroupLabel({ children, action }: { children: string; action?: { title: string; onPress: () => void } }) {
  const s = useStyles(makeStyles);
  const label = (
    <Text style={s.groupLabel} accessibilityRole="header">
      {children}
    </Text>
  );
  if (!action) return label;
  return (
    <View style={layout.groupLabelRow}>
      {label}
      <Pressable accessibilityRole="button" accessibilityLabel={action.title} onPress={action.onPress} hitSlop={12} style={({ pressed }) => pressed && layout.dim}>
        <Text style={s.groupAction}>{action.title}</Text>
      </Pressable>
    </View>
  );
}

/** A field's label, over it ("How much (sat)"). */
export function Label({ children }: { children: string }) {
  const s = useStyles(makeStyles);
  return <Text style={s.label}>{children}</Text>;
}

/**
 * A card on a page: surface with a line border, amber or red for a warning or an error. title: its
 * heading, after a dot in its tone's colour; tag: a yellow tag in the heading (Update ready). flat: the tone
 * colours the dot alone and the card stays surface (hosting's server panel: its red lines say what is wrong).
 */
export function Panel({ tone = 'none', title, tag, flat, children }: { tone?: RowTone; title?: string; tag?: string; flat?: boolean; children?: ReactNode }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const dot = toneColour(tone, t);
  return (
    <View style={[s.panel, !flat && tone === 'warn' && s.panelWarn, !flat && tone === 'error' && s.panelError]}>
      {(title !== undefined || tag !== undefined) && (
        <View style={layout.panelHead}>
          {dot && title !== undefined && <View style={[layout.dot, { backgroundColor: dot }]} />}
          <View style={BESIDE_DOT}>
            {title !== undefined && (
              <Text style={s.panelTitle} accessibilityRole="header">
                {title}
              </Text>
            )}
            {tag !== undefined && <Tag>{tag}</Tag>}
          </View>
        </View>
      )}
      {children}
    </View>
  );
}

/**
 * A QR code on its white tile, centred: the quiet zone stays white in both modes, or it won't scan. label: what
 * TalkBack calls it ("QR code for this address"). size: the code's side, in dp.
 */
export function QrTile({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  return (
    <View style={layout.qrTile} accessible accessibilityLabel={label}>
      <QRCode value={value} size={size} />
    </View>
  );
}

/** A group of rows, as the phone's own settings draw them. */
export function ListGroup({ children }: { children: ReactNode }) {
  const s = useStyles(makeStyles);
  return <View style={s.group}>{children}</View>;
}

/**
 * One row of a group: an icon (or lead, drawn in its place: a card's swatch), the name, and how it stands in one
 * line with a dot in its tone's colour (the line too, for a warning or an error), a yellow tag, and › when a tap
 * goes somewhere. A row that opens nothing is a plain view that reads as text, so TalkBack doesn't call it
 * disabled. disabled: greyed (muted at full strength, look.ts rowColours), a tap does
 * nothing. danger: the name and icon in red (Rebuild server, Wipe the card). divider: a line above, for every row
 * but a group's first. Rows grow with their text: no line is ever cut.
 * Line may be left out (Your country); end: a short text at the row's end (a country's VAT), amber
 * with endWarn; selected (given at all): the row is one of a set to choose from, a radio button for TalkBack, tinted
 * and ticked when it is the chosen one, with no ›. acts: the row acts at once and opens nothing (Remove photo), so it has no › either.
 * after: a control at the end of a row that opens nothing (Recent's ✕ in Edit), apart from the row's text.
 */
export function ListRow({ icon, lead, name, line, tone = 'none', tag, end, endWarn, selected, onPress, disabled, danger, divider, acts, after }: {
  icon?: IconName; lead?: ReactNode; name: string; line?: string; tone?: RowTone; tag?: string; end?: string; endWarn?: boolean; selected?: boolean;
  onPress?: () => void; disabled?: boolean; danger?: boolean; divider?: boolean; acts?: boolean; after?: ReactNode;
}) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const c = rowColours(tone, !!disabled, !!danger, t);
  const label = rowLabel(name, line, tag, end);
  const inside = (
    <>
      {lead}
      {icon && <Icon name={icon} colour={c.icon} />}
      <View style={layout.listBody}>
        <Text style={[s.rowName, { color: c.name }]}>{name}</Text>
        {(line !== undefined || tag !== undefined) && (
          <View style={layout.listLine}>
            {c.dot && <View style={[layout.dot, { backgroundColor: c.dot }]} />}
            <View style={BESIDE_DOT}>
              {line !== undefined && <Text style={[s.rowLine, { color: c.line }]}>{line}</Text>}
              {tag !== undefined && <Tag>{tag}</Tag>}
            </View>
          </View>
        )}
      </View>
      {end !== undefined && <Text style={[s.rowEnd, endWarn && s.rowEndWarn]}>{end}</Text>}
    </>
  );
  if (!onPress && after) {
    // A control at the row's end (Recent's remove button), outside the row's text, so TalkBack reaches both.
    return (
      <View style={[layout.listRow, divider && s.divider]}>
        <View accessible accessibilityRole="text" accessibilityLabel={label} style={layout.listRowText}>
          {inside}
        </View>
        {after}
      </View>
    );
  }
  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={label} style={[layout.listRow, divider && s.divider]}>
        {inside}
      </View>
    );
  }
  const choice = selected !== undefined;
  const ending = rowEnd({ choice, acts: !!acts });
  return (
    <Pressable
      accessibilityRole={choice ? 'radio' : 'button'}
      accessibilityLabel={label}
      accessibilityState={choice ? { checked: selected, disabled: !!disabled } : { disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [layout.listRow, divider && s.divider, selected && s.rowSelected, pressed && layout.dim]}
    >
      {inside}
      {/* The tick's room is kept on every row of a set, so the end texts line up. */}
      {ending === 'tick' && <View style={layout.tick}>{selected && <Icon name="check" colour={t.accentText} size={20} />}</View>}
      {ending === 'chevron' && <Text style={s.chevron}>›</Text>}
    </Pressable>
  );
}

/** Small print, such as the app's build at the foot of Settings. selectable: the person can select and copy it (a payment's server's record). */
export function Small({ children, selectable }: { children: ReactNode; selectable?: boolean }) {
  const s = useStyles(makeStyles);
  return (
    <Text style={s.small} selectable={selectable}>
      {children}
    </Text>
  );
}

/**
 * primary: orange, the screen's main act. secondary: outlined. danger: outlined in red, for an act that can't be
 * undone (Wipe). Disabled, any kind is muted on surface (look.ts buttonColours), readable in both modes.
 */
export function Button({ title, onPress, disabled, kind = 'primary' }: {
  title: string; onPress: () => void; disabled?: boolean; kind?: ButtonKind;
}) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const c = buttonColours(kind, !!disabled, t);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.button, { backgroundColor: c.fill, borderColor: c.border }, pressed && layout.dim]}
    >
      <Text style={[s.buttonText, { color: c.text }]}>{title}</Text>
    </Pressable>
  );
}

/**
 * A text field: on surface with a line border, the typed text in text, its placeholder muted (set here: a Pixel's
 * default hid it), the cursor and handles orange and the selection a pale orange. style: added
 * to the field's own (restore's tall one).
 */
export function Field({ style, ...props }: TextInputProps) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <TextInput
      {...props}
      style={[s.field, style]}
      placeholderTextColor={t.muted}
      cursorColor={t.accent}
      selectionHandleColor={t.accent}
      selectionColor={alpha(t.accent, 0.4)}
    />
  );
}

export const Row = ({ children }: { children: ReactNode }) => <View style={layout.row}>{children}</View>;

/** A line that shrinks to fit rather than wrap, down to 70% of its size (Step's oneLine). */
const ONE_LINE = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.7 } as const;

/**
 * One row of a vertical step list: a mark, the label and its time, and what the current step is doing.
 * spoken: the row's words for a screen reader, which don't change as the time ticks; the row is then one element.
 * oneLine: the name and its time always share one line (an install's steps, whose names are kept short for it:
 * progress.test.ts): on a large font or a narrow phone the line shrinks, down to 70%, rather than wrap. Held with or
 * without a time, so a row keeps its height as its time comes and goes. Without it the line wraps (the alerts
 * checklist, whose words after a name are a sentence, not a time).
 */
export function Step({ label, status, time, spoken, oneLine, children }: {
  label: string; status: 'done' | 'current' | 'todo'; time?: string | null; spoken?: string; oneLine?: boolean; children?: ReactNode;
}) {
  const s = useStyles(makeStyles);
  return (
    <View style={layout.step} accessible={!!spoken} accessibilityLabel={spoken}>
      <Text style={[s.mark, status === 'done' && s.markDone, status === 'current' && s.markCurrent]}>
        {status === 'done' ? '✓' : status === 'current' ? '●' : '○'}
      </Text>
      <View style={layout.stepBody}>
        <Text style={[s.stepLabel, status === 'todo' && s.stepTodo]} {...(oneLine ? ONE_LINE : {})}>
          {label}
          {time ? <Text style={s.stepTime}>{` · ${time}`}</Text> : null}
        </Text>
        {children}
      </View>
    </View>
  );
}

/**
 * A recovery phrase's words in one panel, numbered down two columns (onboarding/phrase.ts wordColumns): 1 to 6, then
 * 7 to 12. Not selectable, so nothing offers to copy them. Each column is one group for TalkBack, which so reads
 * the words in number order.
 */
export function Words({ columns }: { columns: { n: number; word: string }[][] }) {
  const s = useStyles(makeStyles);
  // The numbers' column grows with the font, so two figures keep one line (look.ts wordNumberWidth).
  const numberWidth = { width: wordNumberWidth(useWindowDimensions().fontScale) };
  return (
    <View style={[s.panel, layout.wordColumns]}>
      {columns.map((column, i) => (
        <View key={i} style={layout.wordColumn} accessible accessibilityLabel={column.map((w) => `${w.n}, ${w.word}`).join('. ')}>
          {column.map((w, j) => (
            <View key={w.n} style={[layout.wordRow, j > 0 && s.divider]}>
              <Text style={[s.wordNumber, numberWidth]}>{w.n}</Text>
              <Text selectable={false} style={s.word}>
                {w.word}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * A sheet that slides up from the bottom over the screen, under a small handle; tapping above it or Back closes it.
 * Taller than the window, its content scrolls; with the keyboard up it moves above it, so its fields and buttons
 * stay in reach. solid: the screen behind is hidden (the page's background), as the tap sheet wants: only the card
 * held to the phone shows. locked: tapping above it and Back do nothing (Renew now while it renews: its result
 * must be seen).
 */
export function Sheet({ visible, solid, locked, onClose, children }: {
  visible: boolean; solid?: boolean; locked?: boolean; onClose: () => void; children: ReactNode;
}) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const close = () => {
    if (!locked) onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      {/* A solid sheet covers the whole window: the band's colour stays under the status bar's light icons. */}
      {solid && <View style={{ height: insets.top, backgroundColor: statusBarGround(t) }} />}
      <KeyboardAvoidingView behavior="padding" style={layout.fill}>
        <Pressable style={[s.backdrop, solid && s.solidBackdrop]} onPress={close} accessibilityLabel="Close" />
        {/* Clear of the navigation bar, which the edge-to-edge Modal draws under; never taller than the window below the status bar. */}
        <View style={[s.sheet, { paddingBottom: 20 + insets.bottom, maxHeight: height - insets.top - 24 }]}>
          <View style={s.handle} />
          <ScrollView style={layout.sheetScroll} contentContainerStyle={layout.sheetContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// A style that changes TYPE.body's or TYPE.small's fontSize sets its own lineHeight with it.
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    band: { backgroundColor: t.header, paddingHorizontal: 20, paddingBottom: 12, gap: 2 },
    bandTitle: { ...TYPE.title, flex: 1, color: t.headerText },
    bandTitleAfter: { color: t.headerMuted },
    bandSubtitle: { ...TYPE.body, color: t.headerMuted },
    // Headings carry amounts too (an invoice's, a charge's): figures of one width.
    title: { ...TYPE.heading, ...AMOUNT, color: t.text, marginBottom: 4 },
    body: { ...TYPE.body, color: t.text },
    muted: { color: t.muted },
    error: { color: t.error },
    warn: { color: t.warn },
    callout: { borderWidth: 2, borderColor: t.warnLine, backgroundColor: t.warnBg, borderRadius: 8, padding: 12, gap: 8 },
    small: { ...TYPE.small, color: t.muted },
    // Every kind has a border (a primary's is its fill), so all are the same height.
    button: { borderWidth: 1, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center' },
    buttonText: { ...TYPE.button },
    field: { ...TYPE.body, fontSize: 18, lineHeight: 24, color: t.text, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10 },
    mark: { ...TYPE.heading, width: 20, fontWeight: '400', color: t.muted, textAlign: 'center' },
    markDone: { color: t.ok },
    markCurrent: { color: t.accentText },
    stepLabel: { ...TYPE.body, fontSize: 17, lineHeight: 23, fontWeight: '600', color: t.text },
    stepTodo: { color: t.muted, fontWeight: '400' },
    stepTime: { color: t.muted, fontWeight: '400', fontVariant: ['tabular-nums'] },
    word: { ...TYPE.body, fontSize: 17, lineHeight: 23, fontWeight: '600', color: t.text, flexShrink: 1 },
    wordNumber: { ...TYPE.small, ...AMOUNT, textAlign: 'right', color: t.muted },
    backdrop: { flex: 1, backgroundColor: alpha(FIXED.fade, 0.3) },
    solidBackdrop: { backgroundColor: t.bg },
    // It shrinks when the keyboard takes the room under it, so its page scrolls rather than its foot sliding under the keys.
    sheet: { flexShrink: 1, backgroundColor: t.surface, borderTopWidth: 1, borderColor: t.line, paddingHorizontal: 20, paddingTop: 8, gap: 8, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
    handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: t.line },
    // Settings' groups and rows, the pages' panels and the yellow tag.
    group: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, overflow: 'hidden' },
    divider: { borderTopWidth: 1, borderTopColor: t.line },
    rowName: { ...TYPE.body, fontWeight: '600', color: t.text },
    rowLine: { ...TYPE.small, color: t.muted, flexShrink: 1 },
    rowEnd: { ...TYPE.small, color: t.muted },
    rowEndWarn: { color: t.warn, fontWeight: '600' },
    rowSelected: { backgroundColor: t.selected },
    chevron: { ...TYPE.heading, fontWeight: '400', color: t.muted },
    panel: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 14, gap: 8 },
    panelWarn: { backgroundColor: t.warnBg, borderColor: t.warnLine },
    panelError: { backgroundColor: t.errorBg, borderColor: t.errorLine },
    panelTitle: { ...TYPE.body, fontWeight: '600', color: t.text, flexShrink: 1 },
    tag: { ...TYPE.small, fontWeight: '600', color: t.onHighlight, backgroundColor: t.highlight, borderRadius: 999, paddingHorizontal: 8, overflow: 'hidden' },
    tagQuiet: { alignSelf: 'flex-start', color: t.muted, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line },
    groupLabel: { ...TYPE.small, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted, paddingHorizontal: 4 },
    groupAction: { ...TYPE.small, fontWeight: '600', color: t.accentText, paddingHorizontal: 4 },
    label: { ...TYPE.small, fontWeight: '600', color: t.muted, paddingHorizontal: 2 },
  });

const layout = StyleSheet.create({
  qrTile: { alignSelf: 'center', padding: 12, backgroundColor: FIXED.qrTile },
  bandRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  busy: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 20 },
  centred: { textAlign: 'center' },
  content: { padding: 20, gap: 12 },
  fill: { flex: 1 },
  // The sheet's page: as tall as its content, up to the sheet's own limit, then it scrolls.
  sheetScroll: { flexGrow: 0 },
  sheetContent: { gap: 12, paddingTop: 4 },
  dim: { opacity: 0.5 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  step: { flexDirection: 'row', gap: 12 },
  stepBody: { flex: 1, gap: 4, paddingBottom: 8 },
  wordColumns: { flexDirection: 'row', gap: 18, paddingVertical: 4 },
  wordColumn: { flex: 1 },
  wordRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingVertical: 9 },
  tick: { width: 20, height: 20 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52 },
  listRowText: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  groupLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  listBody: { flex: 1, gap: 2 },
  // The dot, then the line and its tag wrapping beside it (look.ts BESIDE_DOT).
  listLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
