// The word Cannot appears nowhere on the venue (island answer twenty-four, build 5; answer
// twenty-five, screen 2). e2e/cannot-zero.spec.ts walks the page text of every route, but only
// the branches a sealed walk renders; a toast, a refused button's label or a tooltip shows on
// a state no walk reaches. So every string the app source can show is read here too: string
// literals, template pieces and JSX text, never comments. A visitor is told what is true and
// the next move instead.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The capital word, as a label or a sentence opens with it. */
const WORD = /\bCannot\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    // Tests, fixtures and type declarations put nothing on a page: two plain checks, so no anchor reads as shared.
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|fixture)\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Every piece of text a source can put on a page, with its line. */
function shownTexts(name: string, source: string): { line: number; text: string }[] {
  const kind = /\.[jt]sx$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
  const out: { line: number; text: string }[] = [];
  const visit = (n: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) text = n.text;
    else if (ts.isJsxText(n)) text = n.getText(sf);
    if (text !== null) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('the word Cannot', () => {
  // Parses every source file with the TypeScript compiler, as pageTitlesNoEmDash.test.ts does:
  // its time is CPU, so the limit says "this is a long test" and loosens nothing asserted.
  it('is in no string the venue can show', { timeout: 30_000 }, () => {
    const files = sourceFiles(SRC);
    const offenders = files.flatMap((f) =>
      shownTexts(f, readFileSync(f, 'utf8'))
        .filter((t) => WORD.test(t.text))
        .map((t) => `${relative(SRC, f).replace(/\\/g, '/')}:${t.line}: ${JSON.stringify(t.text.trim().slice(0, 100))}`),
    );
    expect(files.length).toBeGreaterThan(100);
    expect(offenders, `say what is true and the next move instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reads strings, templates and JSX text, and never a comment, so it cannot pass by reading nothing', () => {
    const source = [
      "// Cannot, in a comment, is nobody's copy",
      "const a = 'Cannot share';",
      'const b = `Cannot ${a} here`;',
      'const c = <p title="Cannot verify">Cannot launch</p>;',
    ].join('\n');
    expect(shownTexts('probe.tsx', source).filter((t) => WORD.test(t.text)).map((t) => t.text.trim())).toEqual([
      'Cannot share',
      'Cannot',
      'Cannot verify',
      'Cannot launch',
    ]);
  });
});
