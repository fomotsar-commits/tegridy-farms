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

function titleTexts(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const texts: string[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts.push(n.text);
    else if (ts.isTemplateExpression(n)) texts.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, collect);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'usePageTitle' && n.arguments[0]) {
      collect(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return texts;
}

describe('page titles', () => {
  it('no usePageTitle call puts an em dash in the title the live region reads aloud', () => {
    const files = sourceFiles(SRC);
    const offenders = files.flatMap((f) =>
      titleTexts(f).filter((t) => t.includes('—')).map((t) => `${relative(SRC, f)}: ${JSON.stringify(t)}`));
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
