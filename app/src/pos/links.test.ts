import { describe, expect, it } from 'vitest';
import { linkOf, NOT_A_CODE, readLink, validCode, validHost } from './links';

const CODE = '0123456789abcdef0123456789abcdef';
const HOST = 'vm-1001.lnvps.cloud';

// The two links Karto PoS takes, from a scan or from Karto Wallet on the same phone.
describe('readLink', () => {
  it('reads a pairing link: the server and the one-use code', () => {
    expect(readLink(`kartopos://pair?host=${HOST}&code=${CODE}`)).toEqual({ kind: 'pair', host: HOST, code: CODE });
    expect(readLink(`kartopos://pair?code=${CODE}&host=${HOST}`)).toEqual({ kind: 'pair', host: HOST, code: CODE });
    expect(readLink(`  kartopos://pair?host=${HOST}&code=${CODE}\n`)).toEqual({ kind: 'pair', host: HOST, code: CODE });
  });

  it("reads a server link: the server's new address, with no secret in it", () => {
    expect(readLink(`kartopos://server?host=${HOST}`)).toEqual({ kind: 'server', host: HOST });
  });

  it('reads a host that was written with its dots and hyphens escaped', () => {
    expect(readLink(`kartopos://server?host=vm%2D1001.lnvps.cloud`)).toEqual({ kind: 'server', host: HOST });
  });

  it('takes nothing else as a link', () => {
    for (const text of [
      '', 'hello', `https://${HOST}/pair?host=${HOST}&code=${CODE}`, `cardapp://pair?host=${HOST}&code=${CODE}`, `KARTOPOS://pair?host=${HOST}&code=${CODE}`,
      `kartopos://pair`, `kartopos://pair?host=${HOST}`, `kartopos://pair?code=${CODE}`, `kartopos://server`, `kartopos://server?code=${CODE}`,
      `kartopos://till?host=${HOST}`, `kartopos://pair/x?host=${HOST}&code=${CODE}`,
      // A part more than once, or one that isn't the link's.
      `kartopos://pair?host=${HOST}&host=evil.example.com&code=${CODE}`, `kartopos://pair?host=${HOST}&code=${CODE}&next=x`, `kartopos://server?host=${HOST}&code=${CODE}`,
      // An escape that isn't one.
      `kartopos://server?host=%E0%A4%A`,
      'lnbc10u1p4ve2ulpp5t5hem9khy8cdarpeq88vsn9xftelvkxyn3m30adas8skdltr96dq',
    ]) {
      expect(readLink(text), text).toBeNull();
    }
  });

  it("says what the scanner shows for anything that isn't one", () => {
    expect(NOT_A_CODE).toBe("That isn't a Karto PoS code.");
  });
});

describe('validHost', () => {
  it('is lowercase letters, digits, dots and hyphens, with at least one dot', () => {
    for (const host of [HOST, 'a.b', 'shop.example.co.uk', '45.67.89.213', 'xn--bcher-kva.example']) expect(validHost(host), host).toBe(true);
  });

  it("is never anything that would change where https://<host> goes", () => {
    for (const host of [
      '', 'localhost', 'VM-1001.lnvps.cloud', 'vm_1001.lnvps.cloud', '-vm.lnvps.cloud', 'vm-.lnvps.cloud', 'vm.lnvps.cloud.', '.lnvps.cloud', 'vm..cloud',
      `${HOST}:8443`, `${HOST}/path`, `user@${HOST}`, `${HOST}?x=1`, `${HOST}#x`, `evil.example.com\\@${HOST}`, ` ${HOST}`, `${HOST}\n`, 'vm 1001.lnvps.cloud',
      'a'.repeat(64) + '.cloud', ('a'.repeat(60) + '.').repeat(5) + 'cloud',
    ]) {
      expect(validHost(host), JSON.stringify(host)).toBe(false);
    }
  });
});

describe('validCode', () => {
  it('is 32 hex characters, as cardd makes them', () => {
    expect(validCode(CODE)).toBe(true);
    for (const code of ['', CODE.slice(1), CODE + '0', CODE.toUpperCase(), CODE.replace('0', 'g'), ` ${CODE}`]) expect(validCode(code), code).toBe(false);
  });
});

// The router opens a link's own route with the link's parts as the route's parameters.
describe('linkOf', () => {
  it("makes a link of a route's parameters, checked as a scanned one is", () => {
    expect(linkOf('pair', { host: HOST, code: CODE })).toEqual({ kind: 'pair', host: HOST, code: CODE });
    expect(linkOf('server', { host: HOST })).toEqual({ kind: 'server', host: HOST });
  });

  it('drops a link whose parts are missing, wrong, or given more than once', () => {
    expect(linkOf('pair', {})).toBeNull();
    expect(linkOf('pair', { host: HOST })).toBeNull();
    expect(linkOf('pair', { host: 'localhost', code: CODE })).toBeNull();
    expect(linkOf('pair', { host: HOST, code: 'short' })).toBeNull();
    expect(linkOf('pair', { host: [HOST, 'evil.example.com'], code: CODE })).toBeNull();
    expect(linkOf('server', {})).toBeNull();
    expect(linkOf('server', { host: `${HOST}/x` })).toBeNull();
  });
});
