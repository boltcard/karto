// The wallet's own building blocks: a card's
// face, the sleeve the stack's front card stands in, a card small and as a
// swatch (the account and money screens), a card's photo large, Welcome's card, and the banners. Their colours are the theme's (ui/theme.ts); the
// cards' own colours, their white text and the photo fade are the same in both modes.
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Pattern, Rect, Stop } from 'react-native-svg';
import type { Banner } from '../wallet/banners';
import { CARD_COLOURS } from '../wallet/colours';
import { sleevePath } from '../wallet/sleeve';
import { BoltCardLogo } from './BoltCardLogo';
import { Icon } from './icons';
import { alpha, AMOUNT, FIXED, TYPE, type Theme } from './theme';
import { useStyles, useTheme } from './useTheme';

/** How far a card in the stack sits under the card in front of it: that card's rounded top covers its square foot. */
export const STACK_OVERLAP = 12;

/** How much of a card in the stack shows, in dp: its top band, with its name, balance and tag in one row. */
export const STRIP_HEIGHT = 48;

/** The sleeve is drawn this far past the card's right and bottom edges, under the card's clip, so rounding never shows the card's colour there. */
const OVERDRAW = 1;

/** The Bolt Card logo on the sleeve, in dp tall, and its distance from the sleeve's visible right and bottom edges. */
const BOLT_LOGO_HEIGHT = 44;
const BOLT_LOGO_INSET = 24;

/**
 * A card's face: its name and balance in white on its colour, at a card's
 * shape (1.586:1). Without a photo the colour carries faint diagonal stripes.
 * stack: its place in the wallet's stack. behind: a strip, only its top band
 * (STRIP_HEIGHT dp show, STACK_OVERLAP more lie under the next card). front: a
 * whole card standing in the sleeve, which covers all but its top band; the
 * notch in the sleeve shows the card carrying on. dim: frozen. ring: a card
 * to re-point. tag: a small pill beside the name, amber (tone warn) or quiet
 * (tone plain). photo: a data: URI drawn in place of the colour.
 * A whole card darkens it behind the white text with a soft fade at the top
 * and the foot; in the stack it is shown as it is (the notch too), and the name
 * and balance sit on small dark tags instead.
 */
export function CardFace({ name, colour, balance, stack, dim, ring, tag, tone = 'warn', photo, phone }: {
  name: string; colour: string; balance?: string; stack?: 'behind' | 'front'; dim?: boolean; ring?: boolean; tag?: string;
  tone?: 'warn' | 'plain'; photo?: string;
  /** A phone that is a card: a phone is drawn before its name. */
  phone?: boolean;
}) {
  const s = useStyles(makeStyles);
  const shown = !!photo;
  const front = stack === 'front';
  return (
    <View style={[layout.face, stack === 'behind' ? layout.strip : front ? layout.front : layout.whole, { backgroundColor: colour }, ring && s.ring, dim && !front && layout.frozen]}>
      {shown ? <Image source={{ uri: photo }} style={layout.photo} resizeMode="cover" accessibilityIgnoresInvertColors /> : <Stripes />}
      {shown && !stack && <Fade />}
      <View style={layout.faceRow}>
        {phone && <Icon name="phone" colour={FIXED.onCard} size={18} />}
        <Text style={[s.name, shown && stack && s.pill]} numberOfLines={1}>{name}</Text>
        {tag && <Text style={[s.tag, tone === 'plain' && s.tagPlain]}>{tag}</Text>}
        {stack && balance !== undefined && <Text style={[s.stripBalance, layout.end, shown && s.pill]}>{balance}</Text>}
      </View>
      {!stack && (
        <View style={[layout.faceRow, layout.foot]}>
          {balance !== undefined && <Text style={s.balance}>{balance}</Text>}
        </View>
      )}
      {/* A frozen front card is dimmed under its sleeve by a veil of the page's background (how 55% opacity looks on the page), so the sleeve stays solid. */}
      {front && dim && <View style={[StyleSheet.absoluteFill, s.veil]} />}
      {front && <Sleeve />}
    </View>
  );
}

/**
 * A card at 92 dp wide, beside its balance at the top of its page: its photo as it is, or its
 * colour with the stripes and its name in small white type. dim: frozen. Decorative, as the band carries the name,
 * unless onPress is given (a card with a photo): then it is a button that shows the photo large (CardPhotoView).
 */
export function SmallCard({ name, colour, photo, dim, onPress }: { name: string; colour: string; photo?: string; dim?: boolean; onPress?: () => void }) {
  const s = useStyles(makeStyles);
  const face = (
    <>
      {photo ? <Image source={{ uri: photo }} style={layout.photo} resizeMode="cover" accessibilityIgnoresInvertColors /> : <Stripes />}
      {!photo && <Text style={s.smallName} numberOfLines={1}>{name}</Text>}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show the card's photo"
        onPress={onPress}
        hitSlop={4}
        style={({ pressed }) => [layout.small, { backgroundColor: colour }, dim && layout.frozen, pressed && layout.pressed]}
      >
        {face}
      </Pressable>
    );
  }
  return (
    <View style={[layout.small, { backgroundColor: colour }, dim && layout.frozen]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {face}
    </View>
  );
}

/**
 * A card's photo large, over its page: across the window's width at the card's shape, on a dark ground. A tap
 * anywhere, or Back, closes it. The photo is the thumbnail cardd keeps (428 by 270), so it is no sharper here than
 * on the wallet's front card.
 */
export function CardPhotoView({ photo, onClose }: { photo: string; onClose: () => void }) {
  const s = useStyles(makeStyles);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[layout.viewer, s.viewerGround]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the photo">
        <Image source={{ uri: photo }} style={layout.large} resizeMode="cover" accessibilityIgnoresInvertColors />
      </Pressable>
    </Modal>
  );
}

/** A card as a 22 by 14 dp swatch at the start of a row (Move's accounts): its photo, or its colour and stripes. */
export function CardSwatch({ colour, photo }: { colour: string; photo?: string }) {
  return (
    <View style={[layout.swatch, { backgroundColor: colour }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {photo ? <Image source={{ uri: photo }} style={layout.photo} resizeMode="cover" accessibilityIgnoresInvertColors /> : <Stripes />}
    </View>
  );
}

/** Welcome's small card: the palette's first colour with the stripes and the Bolt Card logo. Decoration. */
export function WelcomeCard() {
  return (
    <View style={[layout.welcome, { backgroundColor: CARD_COLOURS[0] }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Stripes />
      <BoltCardLogo height={40} />
    </View>
  );
}

/** Faint diagonal stripes over a card's colour: 14% of the cards' white, at 45 degrees, 10 dp stripes with 10 dp gaps. */
function Stripes() {
  return (
    <Svg style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id="stripes" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <Rect x="0" y="0" width="10" height="20" fill={FIXED.onCard} fillOpacity={0.14} />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#stripes)" />
    </Svg>
  );
}

/** The dark fade behind a whole card's text: 55% black at the top, clear through the middle, 60% at the foot. */
function Fade() {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 1 1" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={FIXED.fade} stopOpacity={0.55} />
          <Stop offset="0.35" stopColor={FIXED.fade} stopOpacity={0} />
          <Stop offset="0.55" stopColor={FIXED.fade} stopOpacity={0} />
          <Stop offset="1" stopColor={FIXED.fade} stopOpacity={0.6} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="1" height="1" fill="url(#fade)" />
    </Svg>
  );
}

/**
 * The card sleeve over the front card, from under its top band to its foot,
 * with the thumb notch cut from its top edge (wallet/sleeve.ts). Its outline
 * is drawn at its measured size, so the notch stays round; until then it is
 * a plain dark rectangle. It reaches 1 dp past the card's right and bottom edges (the card's rounded clip rounds its foot), so no card colour shows there. No shadow.
 */
function Sleeve() {
  const t = useTheme();
  const s = useStyles(makeStyles);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <View
      style={[layout.sleeve, !size && s.sleeveFill]}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {size && (
        <Svg width={size.width} height={size.height}>
          <Path d={sleevePath(size.width, size.height, OVERDRAW)} fill={t.sleeve} />
        </Svg>
      )}
      <SleeveMark />
    </View>
  );
}

/** The sleeve's mark in its bottom-right corner: the Bolt Card logo. Decorative. */
function SleeveMark() {
  return (
    <View style={layout.mark}>
      <BoltCardLogo height={BOLT_LOGO_HEIGHT} />
    </View>
  );
}

/** One of the wallet's banners (wallet/banners.ts): red or amber, with a › when it opens somewhere. */
export function BannerView({ banner, onPress }: { banner: Banner; onPress: () => void }) {
  const s = useStyles(makeStyles);
  const red = banner.tone === 'red';
  const opens = banner.target !== null;
  return (
    <Pressable
      accessibilityRole={opens ? 'button' : 'text'}
      onPress={onPress}
      disabled={!opens}
      style={({ pressed }) => [layout.banner, red ? s.bannerRed : s.bannerAmber, pressed && layout.pressed]}
    >
      <Text style={[s.bannerText, red ? s.danger : s.warn]}>{banner.text}</Text>
      {opens && <Text style={[s.chevron, red ? s.danger : s.warn]}>›</Text>}
    </Pressable>
  );
}

// A style that changes TYPE.body's or TYPE.small's fontSize sets its own lineHeight with it.
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    ring: { borderWidth: 3, borderColor: t.warnLine },
    // A photo card's name and balance in the stack: a small dark tag.
    pill: { backgroundColor: alpha(FIXED.fade, 0.55), borderRadius: 7, paddingHorizontal: 7, paddingVertical: 1, overflow: 'hidden' },
    veil: { backgroundColor: t.veil },
    // The same in both modes, as the photo's fade is: a photo shows best on dark.
    viewerGround: { backgroundColor: alpha(FIXED.fade, 0.92) },
    sleeveFill: { backgroundColor: t.sleeve },
    name: { ...TYPE.body, fontSize: 17, lineHeight: 22, fontWeight: '600', flexShrink: 1, color: FIXED.onCard },
    smallName: { ...TYPE.small, fontSize: 11, lineHeight: 14, fontWeight: '600', color: FIXED.onCard },
    stripBalance: { ...TYPE.body, fontSize: 16, lineHeight: 21, fontWeight: '600', color: FIXED.onCard, ...AMOUNT },
    balance: { ...TYPE.body, fontSize: 26, lineHeight: 32, fontWeight: '600', color: FIXED.onCard, ...AMOUNT },
    // The amber tag on a card face keeps its colours in both modes: it sits on the card's own colour (theme.ts FIXED).
    tag: { ...TYPE.small, fontSize: 12, lineHeight: 16, fontWeight: '600', color: FIXED.tagText, backgroundColor: FIXED.tagBg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
    tagPlain: { color: FIXED.onCard, backgroundColor: alpha(FIXED.fade, 0.45) },
    danger: { color: t.error },
    warn: { color: t.warn },
    bannerRed: { backgroundColor: t.errorBg, borderColor: t.errorLine },
    bannerAmber: { backgroundColor: t.warnBg, borderColor: t.warnLine },
    bannerText: { ...TYPE.body, flex: 1, lineHeight: 20 },
    chevron: { ...TYPE.body, fontSize: 22, lineHeight: 26 },
  });

const layout = StyleSheet.create({
  // Clipped to its rounded corners: the stripes, the photo and the sleeve stay inside them.
  face: { borderRadius: 12, paddingHorizontal: 16, elevation: 3, overflow: 'hidden' },
  whole: { aspectRatio: 1.586, paddingVertical: 16, justifyContent: 'space-between' },
  // Square at the foot: the card in front of it covers that edge. The row sits at the top of the band.
  strip: { height: STRIP_HEIGHT + STACK_OVERLAP, paddingTop: 12, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  // A whole card, its row in the same top band as a strip's; the sleeve covers the rest.
  front: { aspectRatio: 1.586, paddingTop: 12 },
  // The photo is drawn at the whole card's size from the top: a strip shows its top.
  photo: { position: 'absolute', top: 0, left: 0, right: 0, aspectRatio: 1.586 },
  frozen: { opacity: 0.55 },
  small: { width: 92, aspectRatio: 1.586, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, overflow: 'hidden' },
  swatch: { width: 22, height: 14, borderRadius: 3, overflow: 'hidden' },
  welcome: { alignSelf: 'center', width: 148, aspectRatio: 1.586, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', elevation: 3 },
  viewer: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
  large: { width: '100%', aspectRatio: 1.586, borderRadius: 12 },
  sleeve: { position: 'absolute', top: STRIP_HEIGHT, left: 0, right: -OVERDRAW, bottom: -OVERDRAW },
  // The sleeve's measured size includes the overdraw, so the inset starts that much further in (and the notch is centred without it).
  mark: { position: 'absolute', right: BOLT_LOGO_INSET + OVERDRAW, bottom: BOLT_LOGO_INSET + OVERDRAW },
  faceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  foot: { alignItems: 'flex-end' },
  end: { marginLeft: 'auto' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  pressed: { opacity: 0.7 },
});
