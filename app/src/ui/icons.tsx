// The app's icons: Settings' rows and the band's back arrow, then the account pages' buttons, the
// sheets' rows, the history's kinds and the result's marks. Strokes on a 24 grid, coloured by the caller from the
// theme. Decorative: the words beside each carry its meaning.
import type { ReactNode } from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { HistoryIcon } from '../money/format';

export type IconName =
  | 'back' | 'server' | 'backup' | 'phone' | 'key' | 'rebuild'
  // An account's buttons, and the band's ⋯.
  | 'topup' | 'freeze' | 'unfreeze' | 'send' | 'pay' | 'more'
  // The sheets' rows and buttons, and Send's.
  | 'photo' | 'limits' | 'copy' | 'share' | 'paste' | 'scan'
  // The history's kinds (move, renew and wipe are buttons' and rows' too).
  | HistoryIcon
  // The result's ring.
  | 'check' | 'cross' | 'dots' | 'clock'
  // Karto PoS's band: the list of sales.
  | 'list'
  // Onboarding: the country search, and the Done line's fold.
  | 'search' | 'down' | 'up'
  // The card screens: hiding a card's ID from readers.
  | 'hide'
  // Settings: the currency, and Show msat amounts.
  | 'currency'
  // Settings → Alerts.
  | 'bell';

/** Icons made of dots: a round-capped stroke this wide draws each. */
const DOTTED: Partial<Record<IconName, number>> = { more: 3, dots: 3, dot: 4 };

const SHAPES: Record<IconName, ReactNode> = {
  back: <Path d="M19 12H5M11 6l-6 6 6 6" />,
  server: (
    <>
      <Rect x={3} y={4} width={18} height={7} rx={2} />
      <Rect x={3} y={13} width={18} height={7} rx={2} />
      <Path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  backup: (
    <>
      <Path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" />
      <Path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  phone: (
    <>
      <Rect x={6} y={2.5} width={12} height={19} rx={2.5} />
      <Path d="M11 18.5h2" />
    </>
  ),
  key: (
    <>
      <Circle cx={8} cy={15} r={4} />
      <Path d="M11 12l9-9M16 7l3 3" />
    </>
  ),
  rebuild: <Path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />,
  topup: <Path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  move: <Path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4" />,
  freeze: <Path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5" />,
  unfreeze: (
    <>
      <Circle cx={12} cy={12} r={4} />
      <Path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M5.6 18.4l1.5-1.5M16.9 7.1l1.5-1.5" />
    </>
  ),
  send: <Path d="M12 20V9M7 14l5-5 5 5M5 4h14" />,
  pay: <Path d="M7 17L17 7M9 7h8v8" />,
  more: <Path d="M5 12h.01M12 12h.01M19 12h.01" />,
  photo: (
    <>
      <Path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <Circle cx={12} cy={13} r={3.5} />
    </>
  ),
  limits: <Path d="M4 16a8 8 0 0 1 16 0M12 16l4-5" />,
  copy: (
    <>
      <Rect x={9} y={9} width={11} height={11} rx={2} />
      <Path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  share: (
    <>
      <Circle cx={18} cy={5} r={2.5} />
      <Circle cx={6} cy={12} r={2.5} />
      <Circle cx={18} cy={19} r={2.5} />
      <Path d="M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5" />
    </>
  ),
  paste: (
    <>
      <Rect x={5} y={4.5} width={14} height={16.5} rx={2} />
      <Rect x={9} y={3} width={6} height={3} rx={1} />
    </>
  ),
  scan: <Path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />,
  in: <Path d="M12 4v15M6 13l6 6 6-6" />,
  out: <Path d="M12 20V5M6 11l6-6 6 6" />,
  spend: (
    <>
      <Rect x={6} y={3} width={12} height={18} rx={2} />
      <Path d="M9 7h6M9 11h6M9 15h2" />
    </>
  ),
  wipe: <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  renew: (
    <>
      <Rect x={3} y={5} width={18} height={16} rx={2} />
      <Path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  fee: (
    <>
      <Path d="M6 18L18 6" />
      <Circle cx={7.5} cy={7.5} r={2} />
      <Circle cx={16.5} cy={16.5} r={2} />
    </>
  ),
  books: <Path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11" />,
  sale: <Path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
  dot: <Path d="M12 12h.01" />,
  check: <Path d="M5 12.5l4.5 4.5L19 7" />,
  cross: <Path d="M6 6l12 12M18 6L6 18" />,
  dots: <Path d="M6 12h.01M12 12h.01M18 12h.01" />,
  clock: (
    <>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="M12 7.5V12l3 2" />
    </>
  ),
  list: <Path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />,
  search: (
    <>
      <Circle cx={11} cy={11} r={6} />
      <Path d="M20 20l-4.5-4.5" />
    </>
  ),
  down: <Path d="M6 9l6 6 6-6" />,
  up: <Path d="M6 15l6-6 6 6" />,
  hide: (
    <>
      <Path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
      <Path d="M4 4l16 16" />
    </>
  ),
  bell: (
    <>
      <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5z" />
      <Path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  currency: (
    <>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="M14.5 9.5c-.4-.9-1.3-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.1-.6-2.5-1.5M12 6.5V8M12 16v1.5" />
    </>
  ),
};

export function Icon({ name, colour, size = 22 }: { name: IconName; colour: string; size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colour}
      strokeWidth={DOTTED[name] ?? (name === 'back' ? 2 : 1.8)}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {SHAPES[name]}
    </Svg>
  );
}
