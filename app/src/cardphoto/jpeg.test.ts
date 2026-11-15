import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { PROBE_JPEG_BASE64 } from '../diagnostics/probePhoto';
import { hasExif, jpegSize } from './jpeg';

const probe = base64.decode(PROBE_JPEG_BASE64);
/** The probe JPEG without its EXIF segment (the APP1 straight after SOI). */
const withoutExif = () => {
  const n = (probe[4] << 8) | probe[5];
  return new Uint8Array([...probe.slice(0, 2), ...probe.slice(4 + n)]);
};

describe('hasExif', () => {
  it('finds the EXIF (APP1) segment a camera writes, and none in a JPEG without one', () => {
    expect(hasExif(probe)).toBe(true);
    expect(hasExif(withoutExif())).toBe(false);
  });

  it("isn't fooled by the bytes FF E1 inside the picture data", () => {
    const sos = withoutExif();
    const fake = new Uint8Array([...sos.slice(0, sos.length - 2), 0xff, 0xe1, 0x00, 0x08, 0xff, 0xd9]);
    expect(hasExif(fake)).toBe(false);
  });

  it('says no for what isn\'t a JPEG', () => {
    expect(hasExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(hasExif(new Uint8Array([]))).toBe(false);
  });
});

describe('jpegSize', () => {
  it("reads a JPEG's width and height from its frame header", () => {
    expect(jpegSize(probe)).toEqual({ width: 400, height: 252 });
    expect(jpegSize(withoutExif())).toEqual({ width: 400, height: 252 });
  });

  it('is null for what isn\'t a JPEG, or one cut before its frame header', () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(jpegSize(probe.slice(0, 10))).toBeNull();
  });
});
