// The card screens' own parts: a card's outline before it has
// a colour, the picture of a card held to the phone, and a row with a switch. Colours from the theme; the
// picture's card is the palette's first colour, as Welcome's small card.
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Svg, { G, Path, Rect } from 'react-native-svg';
import { CARD_COLOURS } from '../wallet/colours';
import { Icon, type IconName } from './icons';
import { rowLabel } from './look';
import { FIXED, TYPE, type Theme } from './theme';
import { useStyles, useTheme } from './useTheme';

/**
 * A card with no colour yet, at a card's shape: on the name screen, where the name appears on it as it is typed (a
 * card's colour comes from its id, which only the hold reads), and for a blank card on the sheet. placeholder: what
 * stands in the name's place, muted, while there is none. small: three fifths of the page's width, centred (the name
 * screen: at the page's width it pushed Continue under the keyboard). Decoration: the field, or the sheet's title, says it.
 */
export function CardOutline({ name, placeholder, small }: { name: string; placeholder?: string; small?: boolean }) {
  const s = useStyles(makeStyles);
  return (
    <View style={[s.outline, small && layout.outlineSmall]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={[s.outlineName, !name && s.outlineHint]} numberOfLines={1}>
        {name || placeholder || ' '}
      </Text>
    </View>
  );
}

/**
 * The hold screen's picture: a phone seen from behind and a card. on: the card across the phone's back, the
 * reader's two arcs in orange; coming: the card to one side, the arcs grey; away: the card to one side with two
 * short amber strokes, a hold that stopped. It doesn't move. Decoration: the large line says what to do.
 * top: an iPhone, whose reader is at the top edge of its back: the card goes across the top, not the middle.
 */
export function HoldPicture({ pose, top = false }: { pose: 'on' | 'coming' | 'away'; top?: boolean }) {
  const t = useTheme();
  const aside = pose !== 'on';
  if (top) {
    return (
      <View style={layout.picture} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={190} height={150} viewBox="0 0 190 150" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <Rect x={62} y={22} width={66} height={124} rx={12} fill={t.surface} stroke={t.outline} strokeWidth={2.5} />
          <Rect x={70} y={30} width={22} height={22} rx={7} fill={t.bg} stroke={t.outline} strokeWidth={2} />
          <G x={aside ? 34 : 0} y={aside ? -6 : 0}>
            <Rect x={40} y={6} width={110} height={69} rx={8} fill={CARD_COLOURS[0]} />
            <Path d="M52 22h34M52 60h22" stroke={FIXED.onCard} strokeOpacity={0.55} strokeWidth={3} />
          </G>
          {pose === 'away' ? (
            <Path d="M150 84l12 8M142 96l10 12" stroke={t.warnLine} strokeWidth={3} />
          ) : (
            <Path d="M83 96a17 17 0 0 1 24 0M76 88a27 27 0 0 1 38 0" stroke={pose === 'on' ? t.accent : t.outline} strokeWidth={3} />
          )}
        </Svg>
      </View>
    );
  }
  return (
    <View style={layout.picture} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={190} height={150} viewBox="0 0 190 150" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <Rect x={62} y={6} width={66} height={138} rx={12} fill={t.surface} stroke={t.outline} strokeWidth={2.5} />
        <Rect x={72} y={16} width={46} height={16} rx={8} fill={t.bg} stroke={t.outline} strokeWidth={2} />
        <G x={aside ? 36 : 0} y={aside ? 14 : 0}>
          <Rect x={40} y={46} width={110} height={69} rx={8} fill={CARD_COLOURS[0]} />
          <Path d="M52 62h34M52 100h22" stroke={FIXED.onCard} strokeOpacity={0.55} strokeWidth={3} />
        </G>
        {pose === 'away' ? (
          <Path d="M142 42l12-10M150 54l16-5" stroke={t.warnLine} strokeWidth={3} />
        ) : (
          <Path d="M83 72a17 17 0 0 1 24 0M76 64a27 27 0 0 1 38 0" stroke={pose === 'on' ? t.accent : t.outline} strokeWidth={3} />
        )}
      </Svg>
    </View>
  );
}

/**
 * The pay screen's picture: a phone seen from behind, held to a
 * till, the reader's two arcs between them in orange. It doesn't move. Decoration: the large line says what to do.
 */
export function PayPicture() {
  const t = useTheme();
  return (
    <View style={layout.picture} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={200} height={150} viewBox="0 0 200 150" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <Rect x={104} y={36} width={84} height={92} rx={10} fill={t.muted} />
        <Rect x={116} y={48} width={60} height={30} rx={4} fill={t.bg} />
        <Rect x={22} y={14} width={62} height={122} rx={12} fill={t.surface} stroke={t.outline} strokeWidth={2.5} />
        <Rect x={30} y={22} width={22} height={22} rx={7} fill={t.bg} stroke={t.outline} strokeWidth={2} />
        <Path d="M92 62a17 17 0 0 0 0 26M100 68a9 9 0 0 0 0 14" stroke={t.accent} strokeWidth={3} />
      </Svg>
    </View>
  );
}

/**
 * A row with a switch at its end, in a group of one: drawn like a ListRow, which has no place for a control. The
 * whole row is the one switch TalkBack meets (the Switch inside is hidden from it), and a tap anywhere on it turns it.
 */
export function SwitchRow({ icon, name, line, value, onChange }: { icon: IconName; name: string; line: string; value: boolean; onChange: (value: boolean) => void }) {
  const t = useTheme();
  const s = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={rowLabel(name, line)}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [s.switchRow, pressed && layout.dim]}
    >
      <Icon name={icon} colour={t.muted} />
      <View style={layout.rowBody}>
        <Text style={s.rowName}>{name}</Text>
        <Text style={s.rowLine}>{line}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: t.accent, false: t.outline }}
        thumbColor={value ? t.onAccent : t.surface}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    </Pressable>
  );
}

// A style that changes TYPE.body's or TYPE.small's fontSize sets its own lineHeight with it.
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    outline: { aspectRatio: 1.586, borderRadius: 12, borderWidth: 2, borderStyle: 'dashed', borderColor: t.outline, backgroundColor: t.surface, paddingHorizontal: 16, paddingVertical: 12 },
    // The face's own type (ui/wallet.tsx), in the page's text colour: the card has no colour to be white on.
    outlineName: { ...TYPE.body, fontSize: 17, lineHeight: 22, fontWeight: '600', color: t.text },
    outlineHint: { fontWeight: '400', color: t.muted },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12 },
    rowName: { ...TYPE.body, fontWeight: '600', color: t.text },
    rowLine: { ...TYPE.small, color: t.muted },
  });

const layout = StyleSheet.create({
  picture: { alignItems: 'center', paddingTop: 8 },
  outlineSmall: { width: '60%', alignSelf: 'center' },
  rowBody: { flex: 1, gap: 2 },
  dim: { opacity: 0.5 },
});
