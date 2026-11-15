import { describe, expect, it } from 'vitest';
import { codeImports, walk } from './importWalk';

const tree = (files: Record<string, string>) => (path: string) => files[path] ?? null;

// A test walks the imports from the PoS's entry. This is the walk.
describe('codeImports', () => {
  it('finds what a file imports with code: imports, exports from, requires and import()', () => {
    const source = `
      import a from './a';
      import { b } from '../b';
      import * as c from './c';
      import './side';
      export { d } from './d';
      export * from './e';
      if (x) require('./f');
      const g = await import('./g');
      import React from 'react';
    `;
    expect(codeImports(source, 'src/x/file.ts')).toEqual(['./a', '../b', './c', './side', './d', './e', './f', './g']);
  });

  it('leaves out an import of types alone: it leaves no code', () => {
    const source = `
      import type { A } from './types';
      import { type B, type C } from './more';
      export type { D } from './exported';
      import { type E, real } from './mixed';
      import F, { type G } from './default';
    `;
    expect(codeImports(source, 'src/x/file.tsx')).toEqual(['./mixed', './default']);
  });

  it("isn't fooled by a comment or a string that looks like an import", () => {
    expect(codeImports(`// import x from './no';\nconst s = "require('./no')";\n/* export * from './no' */`, 'a.ts')).toEqual([]);
  });
});

describe('walk', () => {
  const files = {
    'src/pos/start.ts': `import '../ui/ui'; if (__DEV__) require('./dev');`,
    'src/pos/dev.ts': `export {};`,
    'src/ui/ui.tsx': `import { theme } from './theme'; import type { Wallet } from '../cardd/client'; export * from './look';`,
    'src/ui/theme.ts': `export const theme = 1;`,
    'src/ui/look/index.ts': `import '../theme';`,
    'src/cardd/client.ts': `import '../services/services';`,
    'src/services/services.tsx': `export {};`,
  };

  it('reaches every module an entry imports with code, through .ts, .tsx and a folder with an index', () => {
    expect([...walk(['src/pos/start.ts'], tree(files)).keys()].sort()).toEqual(['src/pos/dev.ts', 'src/pos/start.ts', 'src/ui/look/index.ts', 'src/ui/theme.ts', 'src/ui/ui.tsx']);
  });

  it('follows a new code import into a forbidden folder, and says how it got there', () => {
    const bad = { ...files, 'src/pos/dev.ts': `import { CarddClient } from '../cardd/client';` };
    const reached = walk(['src/pos/start.ts'], tree(bad));
    expect([...reached.keys()]).toContain('src/services/services.tsx');
    expect(reached.get('src/services/services.tsx')).toBe('src/cardd/client.ts');
    expect(reached.get('src/cardd/client.ts')).toBe('src/pos/dev.ts');
    expect(reached.get('src/pos/start.ts')).toBe('');
  });

  it('passes over a picture, a sound or a JSON file: none of them imports anything', () => {
    const reached = walk(['src/a.ts'], tree({ 'src/a.ts': `require('../assets/chime.mp3'); import data from './data.json'; import './b';`, 'src/b.ts': '' }));
    expect([...reached.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it("says so when a relative import can't be found", () => {
    expect(() => walk(['src/a.ts'], tree({ 'src/a.ts': `import './gone';` }))).toThrow("src/a.ts imports './gone', which isn't a file here");
  });
});
