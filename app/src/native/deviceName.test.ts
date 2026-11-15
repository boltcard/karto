import { describe, expect, it } from 'vitest';
import { deviceName } from './deviceName';

describe('deviceName', () => {
  it('uses the model name, tidied', () => {
    expect(deviceName('Pixel 9a')).toBe('Pixel 9a');
    expect(deviceName('  Pixel\t9a \n')).toBe('Pixel 9a');
    expect(deviceName('Pixel\u0000 9a')).toBe('Pixel 9a');
  });
  it('falls back when the phone does not say', () => {
    expect(deviceName(null)).toBe('Android phone');
    expect(deviceName('   ')).toBe('Android phone');
  });
  it('keeps it short', () => {
    expect(deviceName('x'.repeat(100))).toHaveLength(40);
  });
});
