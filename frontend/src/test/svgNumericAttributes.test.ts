// Hand-inlined SVG icons must carry NUMBERS where SVG expects numbers.
//
// WHY THIS EXISTS. SecurityPage.tsx shipped a Feather `zap-off` whose third
// polyline read `points="8 8 3 14h6l-1 8 5-6"` — PATH syntax (`h` horizontal-to,
// `l` line-to) in an attribute that accepts only coordinate pairs. The browser
// rejects the whole attribute, so the icon silently lost a stroke and every
// render logged `<polyline> attribute points: Expected number`.
//
// It reached production, and was found by reading the console on the live site,
// because nothing in CI fails on it: it is valid TSX, it type-checks, it lints,
// and the component mounts without throwing. A broken icon that still renders is
// the "unreadable must not read as fine" shape — the page looks finished.
//
// The repo inlines its icons by hand rather than depending on an icon package,
// so these numbers are copied by hand and a copy can land mid-token. This is the
// cheap check for that whole class, and it is a lint the type system cannot do.
//
// SCOPE: attributes whose grammar is unambiguous. `path` d= is deliberately NOT
// checked — it is a real mini-language, and a wrong-but-well-formed path is a
// visual bug no parser here could catch anyway.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const SRC = join(dirname(SELF), '..');
const EXT = ['.tsx', '.ts', '.jsx', '.js', '.svg', '.html'];
// `join`/`dirname` give platform separators; normalise paths for readable output.
const sep = process.platform === 'win32' ? '\\' : '/';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, out);
    } else if (EXT.some((x) => entry.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  what: string;
  value: string;
}

function scan() {
  const findings: Finding[] = [];
  let points = 0;
  let viewBoxes = 0;
  const files = walk(SRC);

  for (const file of files) {
    // This file quotes `points="…"` and `viewBox="…"` inside its own patterns and
    // its own failure messages, so scanning it reports the scanner.
    if (file === SELF) continue;
    const source = readFileSync(file, 'utf-8');
    const rel = file.slice(SRC.length + 1).split(sep).join('/');
    const lineOf = (index: number) => source.slice(0, index).split('\n').length;

    for (const m of source.matchAll(/<(polyline|polygon)\b[^>]*?points="([^"]*)"/gs)) {
      const value = m[2];
      // A JSX expression defers the value to runtime; not this lint's business.
      if (value.includes('{')) continue;
      points++;
      if (/[^\s,\-0-9.eE]/.test(value)) {
        findings.push({ file: rel, line: lineOf(m.index!), what: `<${m[1]} points> is not numeric`, value });
        continue;
      }
      const coords = value.trim().split(/[\s,]+/).filter(Boolean);
      if (coords.length === 0 || coords.length % 2 !== 0) {
        findings.push({
          file: rel,
          line: lineOf(m.index!),
          what: `<${m[1]} points> has ${coords.length} coordinates — must be a non-zero even number`,
          value,
        });
      }
    }

    for (const m of source.matchAll(/viewBox="([^"]*)"/g)) {
      const value = m[1];
      if (value.includes('{')) continue;
      viewBoxes++;
      const nums = value.trim().split(/[\s,]+/).filter(Boolean);
      if (nums.length !== 4 || !nums.every((n) => /^-?\d*\.?\d+$/.test(n))) {
        findings.push({ file: rel, line: lineOf(m.index!), what: 'viewBox must be exactly 4 numbers', value });
      }
    }
  }

  return { findings, files: files.length, points, viewBoxes };
}

const result = scan();

describe('inlined SVG numeric attributes', () => {
  it('guards the guard — it actually read the tree', () => {
    // If a refactor moves the icons or breaks the walk, these floors fail LOUDLY
    // instead of letting an empty scan report a clean tree.
    expect(result.files, 'the walker found almost no source files').toBeGreaterThan(300);
    expect(result.points, 'no <polyline>/<polygon> points= found at all — the pattern drifted').toBeGreaterThan(10);
    expect(result.viewBoxes, 'no viewBox= found at all — the pattern drifted').toBeGreaterThan(50);
  });

  it('accepts only numbers where SVG accepts only numbers', () => {
    const report = result.findings
      .map((f) => `  ${f.file}:${f.line}  ${f.what}\n    value = "${f.value}"`)
      .join('\n');
    expect(
      result.findings,
      result.findings.length
        ? `SVG attributes the browser will reject outright:\n${report}\n` +
            'The element still mounts, so nothing else in CI notices — the icon just loses a stroke.'
        : '',
    ).toEqual([]);
  });
});
