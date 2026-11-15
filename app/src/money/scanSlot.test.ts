import { describe, expect, it } from 'vitest';
import { scanSlot } from './scanSlot';

describe('scanSlot', () => {
  it('hands a scanned text over once', () => {
    expect(scanSlot.take()).toBeNull();
    scanSlot.put('lnbc1…');
    expect(scanSlot.take()).toBe('lnbc1…');
    expect(scanSlot.take()).toBeNull();
  });
});
