// The skin (the active bungalow) is state. A door changes it in place, with no
// reload, so a skin read at module scope is frozen at the chunk's first import
// and paints the previous room. This parses every source file and fails on a
// skin read outside a function body; an IIFE body counts as module scope.
// pageArt on a shared surface never follows the skin and is exempt.

import { describe, it, expect, afterEach } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { BUNGALOW_STORAGE_KEY, bungalowArtContext } from './bungalows';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Functions that read the skin directly. Callers of these are found below. */
const SEED_READERS = [
  'getActiveBungalow',
  'getBungalowIdentity',
  'bungalowArtContext',
  'bungalowArtPool',
  'hasChosenBungalow',
  'pageArt',
  'arrivalVoice',
  'isToweliVoice',
  'loaderIdentity',
];

/** Art readers whose first argument names a surface, and the surfaces no skin changes. */
const SURFACE_READERS = new Set(['pageArt', 'pageArtWith', 'bungalowArtContext', 'bungalowArtPool']);
const SHARED_SURFACES = ['loader', 'nav-logo'];

interface Source { rel: string; sf: ts.SourceFile }

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'test') continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/\.(test|spec|d)\.[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function parse(rel: string, text: string): Source {
  const kind = /x$/.test(rel) ? ts.ScriptKind.TSX : rel.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return { rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind) };
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);

function isIIFE(fn: ts.Node): boolean {
  let p = fn.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  if (!p || !ts.isCallExpression(p)) return false;
  let callee: ts.Node = p.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  return callee === fn;
}

function callName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Name of a module-top-level function (declaration or `const f = () => …`), else null. */
function topLevelName(stmt: ts.Statement): { name: string; body: ts.Node }[] {
  if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) return [{ name: stmt.name.text, body: stmt.body }];
  if (!ts.isVariableStatement(stmt)) return [];
  const out: { name: string; body: ts.Node }[] = [];
  for (const d of stmt.declarationList.declarations) {
    if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      out.push({ name: d.name.text, body: d.initializer.body });
    }
  }
  return out;
}

/** Seed readers plus every lower-case, non-hook top-level function that calls one. */
function readerNames(sources: Source[]): Set<string> {
  const readers = new Set(SEED_READERS);
  const fns = sources.flatMap((s) => s.sf.statements.flatMap(topLevelName));
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, body } of fns) {
      if (readers.has(name) || !/^[a-z]/.test(name) || /^use[A-Z]/.test(name)) continue;
      let calls = false;
      (function visit(n: ts.Node) {
        if (calls) return;
        if (ts.isCallExpression(n)) {
          const c = callName(n);
          if (c && readers.has(c)) { calls = true; return; }
        }
        ts.forEachChild(n, visit);
      })(body);
      if (calls) { readers.add(name); grew = true; }
    }
  }
  return readers;
}

function isSharedSurfaceRead(call: ts.CallExpression, name: string): boolean {
  if (!SURFACE_READERS.has(name)) return false;
  const first = call.arguments[0];
  return !!first && ts.isStringLiteralLike(first) && SHARED_SURFACES.includes(first.text);
}

/** Every skin read that runs when its module is evaluated, as `file:line  call`. */
function moduleScopeSkinReads(sources: Source[], readers: Set<string>): string[] {
  const found: string[] = [];
  for (const { rel, sf } of sources) {
    (function visit(n: ts.Node, inFunction: boolean) {
      const nowIn = inFunction || (isFn(n) && !isIIFE(n));
      if (!nowIn && ts.isCallExpression(n)) {
        const name = callName(n);
        if (name && readers.has(name) && !isSharedSurfaceRead(n, name)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          found.push(`${rel}:${line + 1}  ${n.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}`);
        }
      }
      ts.forEachChild(n, (c) => visit(c, nowIn));
    })(sf, false);
  }
  return found;
}

function scanTree(): { reads: string[]; readers: Set<string>; files: number } {
  const sources = sourceFiles(SRC).map((f) =>
    parse(relative(SRC, f).split(sep).join('/'), readFileSync(f, 'utf8')));
  const readers = readerNames(sources);
  return { reads: moduleScopeSkinReads(sources, readers), readers, files: sources.length };
}

function scanText(text: string): string[] {
  const sources = [parse('probe.ts', text)];
  return moduleScopeSkinReads(sources, readerNames(sources));
}

afterEach(() => {
  localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('the skin is state: nothing reads it at module scope', () => {
  it('no source file reads the skin when its module is evaluated', () => {
    const { reads, files } = scanTree();
    expect(files, 'sanity: the walk found the source tree').toBeGreaterThan(300);
    expect(
      reads,
      `skin reads at module scope are frozen at first import and paint the previous room after a door. ` +
        `Read the skin inside the component or function that uses it:\n  ${reads.join('\n  ')}`,
    ).toEqual([]);
  });

  it('follows readers through the helpers that call them', () => {
    const { readers } = scanTree();
    for (const helper of ['pageArtWith', 'onboardingSteps']) expect(readers.has(helper), helper).toBe(true);
  });
});

describe('the scanner can fail', () => {
  it('flags a direct read, an IIFE and a helper that calls a reader', () => {
    expect(scanText(`const A = pageArt('home', 0);`)).toHaveLength(1);
    expect(scanText(`const B = (() => getActiveBungalow())();`)).toHaveLength(1);
    expect(scanText(`function voice() { return isToweliVoice(); }\nconst C = voice();`)).toHaveLength(1);
    expect(scanText(`export const D = { e: loaderIdentity().main };`)).toHaveLength(1);
  });

  it('flags a read inside a callback the module itself runs', () => {
    expect(scanText(`const E = [0, 1, 2].map((i) => pageArt('transition', i));`)).toHaveLength(1);
    expect(scanText(`const F = Array.from({ length: 3 }, (_, i) => pageArt('home', i));`)).toHaveLength(1);
    expect(scanText(`const G = ['a', 'b'].filter(function () { return isToweliVoice(); });`)).toHaveLength(1);
    expect(scanText(`const H = [0].forEach((i) => { pageArt('home', i); });`)).toHaveLength(1);
  });

  it('passes reads inside functions, getters and hooks, and shared surfaces', () => {
    expect(scanText(`function f() { return pageArt('home', 0); }`)).toEqual([]);
    expect(scanText(`const g = () => getBungalowIdentity();`)).toEqual([]);
    expect(scanText(`export const L = { get t() { return pageArt('token-icon', 0).src; } };`)).toEqual([]);
    expect(scanText(`const M = pageArt('loader', 3);\nconst N = pageArt("nav-logo", 0);`)).toEqual([]);
  });

  it('exempts only surfaces that really ignore the skin', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    for (const surface of SHARED_SURFACES) expect(bungalowArtContext(surface), surface).toBeNull();
    expect(bungalowArtContext('home'), 'a skinned surface must resolve to the room').not.toBeNull();
  });
});
