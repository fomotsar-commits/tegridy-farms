// A page title is venue voice: AppLayout's live region reads document.title aloud on every
// route, so the em-dash walk sees it whenever the announcement lands first. Every literal a
// usePageTitle call can put in the title (its first argument) carries no U+2014.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function titleTexts(file: string, source: string): { calls: number; texts: string[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const texts: string[] = [];
  let calls = 0;
  const collect = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts.push(n.text);
    else if (ts.isTemplateExpression(n)) texts.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, collect);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'usePageTitle' && n.arguments[0]) {
      calls += 1;
      collect(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, texts };
}

// The call is the identifier usePageTitle, and a file can spell that only with the name or
// a \u escape. Only those files are parsed; every other file is read and skipped.
const CAN_CALL = /usePageTitle|\\u/;

// Scanned once while the file is collected, where no timeout runs. The scan is synchronous,
// so a test timeout cannot stop it: it only fails a slow pass after the work is done.
const scan = (() => {
  const files = sourceFiles(SRC);
  const offenders: string[] = [];
  let calls = 0;
  for (const f of files) {
    const source = readFileSync(f, 'utf8');
    if (!CAN_CALL.test(source)) continue;
    const found = titleTexts(f, source);
    calls += found.calls;
    offenders.push(...found.texts.filter((t) => t.includes('—')).map((t) => `${relative(SRC, f)}: ${JSON.stringify(t)}`));
  }
  return { walked: files.length, calls, offenders };
})();

describe('page titles', () => {
  it('no usePageTitle call puts an em dash in the title the live region reads aloud', () => {
    expect(scan.walked, 'source files walked').toBeGreaterThan(100);
    expect(scan.calls, 'usePageTitle calls read').toBeGreaterThan(20);
    expect(scan.offenders).toEqual([]);
  });
});
