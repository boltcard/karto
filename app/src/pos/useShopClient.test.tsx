// The till's client lives as long as its shop: a pairing record
// that changes only its names (a wallet or a till renamed) keeps the same client, so the currency it read and the
// sales it watches aren't started again.
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useShopClient } from './useShopClient';

describe('useShopClient', () => {
  it('is the same client for the same host, a new one for another, and none unpaired', () => {
    const make = vi.fn((host: string) => ({ host }));
    const { result, rerender } = renderHook(({ host }: { host: string | undefined }) => useShopClient(host, make), { initialProps: { host: 'vm-1009.lnvps.cloud' as string | undefined } });
    const first = result.current;
    expect(first).toEqual({ host: 'vm-1009.lnvps.cloud' });
    rerender({ host: 'vm-1009.lnvps.cloud' });
    expect(result.current).toBe(first);
    expect(make).toHaveBeenCalledTimes(1);
    rerender({ host: 'vm-1003.lnvps.cloud' });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ host: 'vm-1003.lnvps.cloud' });
    rerender({ host: undefined });
    expect(result.current).toBeNull();
  });
});
