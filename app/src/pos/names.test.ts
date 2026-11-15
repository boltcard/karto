import { describe, expect, it } from 'vitest';
import { refreshPaired, tillLine, walletFact } from './names';

// What the till shows of whose it is, and how a read of /pos/me
// updates what it keeps.
const P = { host: 'vm-1009.lnvps.cloud', name: 'Till 1', wallet: 'Pixel 9a' };

describe('the till line', () => {
  it('names the wallet and the till, or the server when the wallet has no name', () => {
    expect(tillLine(P)).toBe('Pixel 9a · Till 1');
    expect(tillLine({ ...P, wallet: '' })).toBe('vm-1009.lnvps.cloud · Till 1');
    expect(tillLine({ host: P.host, name: 'Till 1' })).toBe('vm-1009.lnvps.cloud · Till 1');
  });

  it("says This PoS's wallet, or that it has no name yet", () => {
    expect(walletFact(P)).toBe('Pixel 9a');
    expect(walletFact({ ...P, wallet: '' })).toBe('Not named yet');
  });
});

describe('refreshPaired', () => {
  it('changes nothing when nothing changed, or an older server says nothing of the wallet', () => {
    expect(refreshPaired(P, { name: 'Till 1', wallet: 'Pixel 9a' })).toBeNull();
    expect(refreshPaired(P, { name: 'Till 1' })).toBeNull();
  });

  it("takes a renamed wallet, a wallet's name gone, and a renamed till", () => {
    expect(refreshPaired(P, { name: 'Till 1', wallet: 'Shop 2' })).toEqual({ ...P, wallet: 'Shop 2' });
    expect(refreshPaired(P, { name: 'Till 1', wallet: '' })).toEqual({ ...P, wallet: '' });
    expect(refreshPaired(P, { name: 'Front', wallet: 'Pixel 9a' })).toEqual({ ...P, name: 'Front' });
    expect(refreshPaired({ host: P.host, name: 'Till 1' }, { name: 'Till 1', wallet: 'Pixel 9a' })).toEqual(P);
  });

  it("ignores what isn't a name, keeping what it had", () => {
    expect(refreshPaired(P, { name: 'Till 1', wallet: 'a\u200bb' })).toBeNull();
    expect(refreshPaired(P, { name: '', wallet: 'Pixel 9a' })).toBeNull();
    expect(refreshPaired(P, { name: 7, wallet: 7 })).toBeNull();
    expect(refreshPaired(P, { name: 'Till\u202e1', wallet: 'Shop 2' })).toEqual({ ...P, wallet: 'Shop 2' });
  });
});
