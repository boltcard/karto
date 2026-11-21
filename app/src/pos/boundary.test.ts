import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { walk, type ReadFile } from '../testing/importWalk';

/** app/ */
const APP = new URL('../../', import.meta.url);
const read: ReadFile = (path) => {
  const url = new URL(path, APP);
  return existsSync(url) && statSync(url).isFile() ? readFileSync(url, 'utf8') : null;
};
const under = (dir: string) => (readdirSync(new URL(dir, APP), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => `${dir}/${f}`);

/** The shared ui files Karto PoS may use: these and no other file of ui/. */
const UI = ['ui.tsx', 'theme.ts', 'useTheme.ts', 'icons.tsx', 'look.ts', 'useBack.ts', 'result.tsx', 'scanFrame.tsx'].map((f) => `src/ui/${f}`);
/** Single files of shared folders. A leaf file may be added here, never a folder. */
// boltcard/sun.ts reads a tap's p and c out of a card's link (ntag424/ndef.ts uses it); it holds no key and imports nothing of the project.
// cards/read.ts, the wallet's read of a card's key versions and settings, left the list when the till came to read
// only the link.
// money/fiat.ts, the currency module, imports words.ts alone.
// money/view.ts, the wallet's view of an amount, imports fiat.ts and words.ts alone: the till may draw a figure with it.
// cardd/names.ts, the rule for a name cardd keeps, imports nothing.
// appUpdate/appUpdate.ts, useAppUpdate.ts and UpdateLine.tsx, a GitHub build's notice of a newer release: they
// import lightning/, money/words.ts and ui/ui.tsx alone.
const FILES = [...UI, 'src/appUpdate/appUpdate.ts', 'src/appUpdate/useAppUpdate.ts', 'src/appUpdate/UpdateLine.tsx', 'src/boltcard/sun.ts', 'src/money/words.ts', 'src/money/fiat.ts', 'src/money/view.ts', 'src/cards/nfcSlot.ts', 'src/cardd/deviceauth.ts', 'src/cardd/error.ts', 'src/cardd/signed.ts', 'src/cardd/names.ts'];
const allowed = (path: string) =>
  path.startsWith('src/pos/') || path.startsWith('src/pos-app/') || FILES.includes(path) ||
  (path.startsWith('src/native/') && path !== 'src/native/ssh.ts') || path.startsWith('src/ntag424/') || path.startsWith('src/lightning/') ||
  // The native module is shared whole: its SSH code is in the binary and nothing of the PoS calls it.
  path.startsWith('modules/card-native/');

/** What Karto PoS's bundle starts from: the entry's PoS branch and the router's root, every screen in it. */
const ENTRIES = ['src/native/polyfills.ts', 'src/pos/start.ts', ...under('src/pos-app')];
/** A module the walk reached that it may not, with the file that led to it. */
const outside = (entries: string[], readFile: ReadFile = read) => [...walk(entries, readFile)].filter(([path]) => !allowed(path)).map(([path, from]) => `${path} (from ${from})`);

// Karto PoS takes payments and nothing more, so none of Karto
// Wallet's keys, server installer, backups or screens may be in its bundle.
describe("what Karto PoS's code reaches", () => {
  it('is on the list: pos/, pos-app/, eight ui files, the words, the native layer but SSH, the card reader, lightning, and of cardd/ the signing, the signed calls and the error', () => {
    expect(outside(ENTRIES)).toEqual([]);
  });

  it('holds each shared ui file to the same list, so one of them gaining a wallet import fails at once', () => {
    for (const file of UI) expect(outside([file]), file).toEqual([]);
  });

  it('holds the currency module to the list: fiat.ts reaches words.ts and nothing else', () => {
    expect(outside(['src/money/fiat.ts'])).toEqual([]);
    expect([...walk(['src/money/fiat.ts'], read).keys()].sort()).toEqual(['src/money/fiat.ts', 'src/money/words.ts']);
    expect([...walk(['src/money/view.ts'], read).keys()].sort()).toEqual(['src/money/fiat.ts', 'src/money/view.ts', 'src/money/words.ts']);
  });

  it('starts from real files, and reaches the shared ones', () => {
    const reached = [...walk(ENTRIES, read).keys()];
    expect(reached).toContain('src/pos-app/_layout.tsx');
    expect(reached).toContain('src/ui/ui.tsx');
    expect(reached).toContain('src/ui/theme.ts');
  });

  it("fails when a PoS module is given an import of a forbidden folder, and names the wallet's client", () => {
    const withImport = (line: string): ReadFile => (path) => (path === 'src/pos/start.ts' ? `${read(path)}\n${line}\n` : read(path));
    const found = outside(ENTRIES, withImport("import { deriveKeys } from '../keys/derive';"));
    expect(found).toContain('src/keys/derive.ts (from src/pos/start.ts)');
    const client = outside(ENTRIES, withImport("import { CarddClient } from '../cardd/client';"));
    expect(client).toContain('src/cardd/client.ts (from src/pos/start.ts)');
    for (const folder of ['onboarding/machine', 'backup/task', 'lnvps/client', 'store/store', 'services/services', 'wallet/shop', 'app/home', 'deploy/bundle', 'native/ssh', 'cards/read', 'phoneCard/taps']) {
      expect(outside(ENTRIES, withImport(`import '../${folder}';`)).some((f) => f.startsWith(`src/${folder}.ts`)), folder).toBe(true);
    }
    // A type alone leaves no code, and is let through.
    expect(outside(ENTRIES, withImport("import type { Wallet } from '../cardd/client';"))).toEqual([]);
    // Twelve walks, some through all of the wallet: room for a machine that is busy with something else.
  }, 30_000);
});
