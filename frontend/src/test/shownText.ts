// What the app source can put on a page, for the tests that hold a word out of the venue's copy
// (cannotZero.test.ts, vaultOneName.test.ts): string literals, template pieces and JSX text,
// never comments.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every app source under `dir`. */
export function sourceFiles(dir: string): string[] {
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
export function shownTexts(name: string, source: string): { line: number; text: string }[] {
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

/** A source's path from src/, with forward slashes. */
export const fromSrc = (file: string): string => relative(SRC, file).replace(/\\/g, '/');

/** Each shown text in the sources under src/ whose path matches `where` and whose text matches `word`, as "path:line: text". */
export function shownWith(word: RegExp, where: RegExp = /./): string[] {
  return sourceFiles(SRC)
    .filter((f) => where.test(fromSrc(f)))
    .flatMap((f) =>
      shownTexts(f, readFileSync(f, 'utf8'))
        .filter((t) => word.test(t.text))
        .map((t) => `${fromSrc(f)}:${t.line}: ${JSON.stringify(t.text.trim().slice(0, 100))}`),
    );
}
