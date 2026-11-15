// What the photo probe reads in a JPEG without decoding it: whether it has an
// EXIF (APP1) segment, and its size, by walking the marker segments before
// the picture data (as server/internal/cards hasEXIF does).

type Segment = { marker: number; start: number; length: number };

/** The marker segments from SOI up to the start of scan; [] for what isn't a JPEG. */
function segments(b: Uint8Array): Segment[] {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return [];
  const out: Segment[] = [];
  for (let i = 2; i + 3 < b.length; ) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda) break; // start of scan: the picture data follows
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = (b[i + 2] << 8) | b[i + 3];
    out.push({ marker, start: i + 4, length });
    i += 2 + length;
  }
  return out;
}

export const hasExif = (b: Uint8Array): boolean => segments(b).some((s) => s.marker === 0xe1);

/** The size in a frame header (SOF0–SOF15 but DHT, JPG and DAC); null without one. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  const sof = segments(b).find((s) => s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc);
  if (!sof || sof.start + 5 > b.length) return null;
  return { height: (b[sof.start + 1] << 8) | b[sof.start + 2], width: (b[sof.start + 3] << 8) | b[sof.start + 4] };
}
