// Walks a module's imports: from an entry file, every file of
// the project that would be bundled with it. Imports of types alone are left out: they leave no code. Used by
// pos/boundary.test.ts to hold Karto PoS to the files it may reach.
import { posix } from 'node:path';
import ts from 'typescript';

/** A file's text by its path from app/ ("src/pos/start.ts"), or null when there is no such file. */
export type ReadFile = (path: string) => string | null;

/** A text is parsed once: pos/boundary.test.ts walks the same files a dozen times over, and parsing is what takes the time. */
const parsed = new Map<string, readonly string[]>();

/**
 * The module names a file imports with code, in the order written: `import … from`, a bare `import '…'`,
 * `export … from`, `require('…')` and `import('…')`, relative ones only (a package isn't the project's).
 */
export function codeImports(source: string, file: string): string[] {
  const key = `${file}\n${source}`;
  const had = parsed.get(key);
  if (had) return [...had];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const add = (node: ts.Expression | undefined) => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith('.')) out.push(node.text);
  };
  const typesOnly = (c: ts.ImportClause | undefined): boolean => {
    if (!c) return false; // import './side': code
    if (c.isTypeOnly) return true;
    const named = c.namedBindings;
    return !c.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!typesOnly(node.importClause)) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  parsed.set(key, out);
  return [...out];
}

const ENDINGS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
/** A file that is bundled as it is and imports nothing. */
const ASSET = /\.(png|jpe?g|svg|ttf|mp3|wav|ogg|json)$/;

/**
 * Every file reached from the entries by code imports, the entries among them: each with the file that first led
 * to it ('' for an entry), so a failure can say how a module got in.
 */
export function walk(entries: string[], read: ReadFile): Map<string, string> {
  const reached = new Map<string, string>();
  const queue: [string, string][] = entries.map((e) => [e, '']);
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [file, from] = next;
    if (reached.has(file)) continue;
    const source = read(file);
    if (source === null) throw new Error(`${file} isn't a file here`);
    reached.set(file, from);
    for (const name of codeImports(source, file)) {
      if (ASSET.test(name)) continue;
      const base = posix.join(posix.dirname(file), name);
      const found = ENDINGS.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && read(p) !== null);
      if (!found) throw new Error(`${file} imports '${name}', which isn't a file here`);
      queue.push([found, file]);
    }
  }
  return reached;
}
