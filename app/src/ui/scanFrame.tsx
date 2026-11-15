// The framed square over the QR scanner's camera,
// which both apps' scanners draw: Karto Wallet's for an invoice or an address, Karto PoS's for a pairing code.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { FIXED } from './theme';
import { useTheme } from './useTheme';

/** The framed square's side and its corners' radius, in dp. */
const SIDE = 220;
const CORNER = 16;

/** The framed square over the camera, in the highlight yellow, the picture around it dimmed. Drawn at its measured size. */
export function ScanFrame() {
  const t = useTheme();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const x = size ? (size.width - SIDE) / 2 : 0;
  const y = size ? (size.height - SIDE) / 2 : 0;
  const edge = SIDE - 2 * CORNER;
  const arc = `a${CORNER} ${CORNER} 0 0 1`;
  return (
    <View
      style={[StyleSheet.absoluteFill, layout.untouched]}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {size && (
        <Svg width={size.width} height={size.height}>
          {/* The whole view, less the square (even-odd): the dimmed surround. */}
          <Path
            fillRule="evenodd"
            fill={FIXED.fade}
            fillOpacity={0.45}
            d={`M0 0H${size.width}V${size.height}H0Z M${x + CORNER} ${y}h${edge}${arc} ${CORNER} ${CORNER}v${edge}${arc} ${-CORNER} ${CORNER}h${-edge}${arc} ${-CORNER} ${-CORNER}v${-edge}${arc} ${CORNER} ${-CORNER}Z`}
          />
          <Rect x={x} y={y} width={SIDE} height={SIDE} rx={CORNER} fill="none" stroke={t.highlight} strokeWidth={3} />
        </Svg>
      )}
    </View>
  );
}

const layout = StyleSheet.create({
  // Taps pass through the frame.
  untouched: { pointerEvents: 'none' },
});
