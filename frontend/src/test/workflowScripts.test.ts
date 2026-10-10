// Two ways a workflow dies that a YAML parser never sees, pinned for every workflow file:
//   * a `run:` script that turns on nounset (`set -u`) and reads a name nothing binds
//     fails its step at that read;
//   * an empty expression in anything the runner evaluates, a shell comment inside a
//     `run:` block included, makes GitHub reject the whole file.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const workflows = (): { file: string; src: string }[] =>
  readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => ({ file, src: readFileSync(join(WORKFLOW_DIR, file), 'utf-8') }));

const indentOf = (line: string): number => line.length - line.trimStart().length;
const names = (code: string, re: RegExp): string[] => [...code.matchAll(re)].map((m) => m[1]);

interface Script { n: number; body: string; bound: string[] }

/** Keys of the `env:` mapping that opens on line `at`. */
function envKeys(lines: string[], at: number): string[] {
  const col = lines[at].indexOf('env:');
  const keys: string[] = [];
  for (let j = at + 1; j < lines.length; j++) {
    if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue;
    if (indentOf(lines[j]) <= col) break;
    const k = /^\s*([A-Za-z_]\w*):/.exec(lines[j]);
    if (k) keys.push(k[1]);
  }
  return keys;
}

/**
 * Every step's script, with the names its own, its job's and the workflow's `env:` bind.
 * Reads the layout these files use: a job's name at two spaces, its keys at four.
 */
function scripts(src: string): Script[] {
  const lines = src.split(/\r?\n/);
  const job = (k: number): number => {
    while (k > 0 && !/^ {2}[^\s#]/.test(lines[k])) k--;
    return k;
  };
  const out: Script[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(- )?run:\s*(.*)$/.exec(lines[i]);
    // `defaults: run:` opens a mapping, not a script.
    if (!m || m[3] === '') continue;
    const key = m[1].length + (m[2] ? 2 : 0);
    let body = m[3];
    let end = i + 1;
    if (/^[|>][-+]?\d*$/.test(m[3].trim())) {
      body = '';
      for (; end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > key); end++) {
        body += `${lines[end]}\n`;
      }
    }
    // The step is the list item this key sits in.
    let start = i;
    while (start > 0 && !lines[start].startsWith(`${' '.repeat(Math.max(key - 2, 0))}- `)) start--;
    let stop = end;
    while (stop < lines.length && (lines[stop].trim() === '' || /^\s*#/.test(lines[stop]) || indentOf(lines[stop]) >= key)) stop++;
    const bound: string[] = [];
    lines.forEach((line, j) => {
      const e = /^(\s*)(- )?env:\s*$/.exec(line);
      if (!e) return;
      const col = e[1].length + (e[2] ? 2 : 0);
      const ofStep = col === key && j >= start && j < stop;
      const ofJob = col === 4 && job(j) === job(i);
      if (ofStep || ofJob || col === 0) bound.push(...envKeys(lines, j));
    });
    out.push({ n: i + 1, body, bound });
  }
  return out;
}

/** The script with what bash never expands blanked: comments, single quotes, escapes, quoted heredocs. */
function expanding(body: string): string {
  const kept: string[] = [];
  let heredoc: { tag: string; quoted: boolean } | null = null;
  for (const line of body.split('\n')) {
    if (heredoc) {
      if (line.trim() === heredoc.tag) heredoc = null;
      else if (!heredoc.quoted) kept.push(line);
      continue;
    }
    const h = /(?<!<)<<-?(?!<)\s*(['"\\]?)([A-Za-z_]\w*)/.exec(line);
    if (h) heredoc = { tag: h[2], quoted: h[1] !== '' };
    kept.push(line);
  }
  const text = kept.join('\n');
  let out = '';
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (single) {
      if (c === "'") single = false;
      else if (c === '\n') out += c;
    } else if (c === '\\') {
      out += '  ';
      i++;
    } else if (c === "'" && !double) {
      single = true;
    } else if (c === '#' && !double && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else {
      if (c === '"') double = !double;
      out += c;
    }
  }
  return out;
}

/** The inside of every `$(( … ))` and `(( … ))`, with any command substitution taken out. */
function arithmetic(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:\$|(?<=^|[\s;]))\(\(/gm)) {
    const open = m.index + m[0].length - 2;
    let depth = 0;
    let close = open;
    for (; close < code.length; close++) {
      if (code[close] === '(') depth++;
      else if (code[close] === ')' && --depth === 0) break;
    }
    let inner = code.slice(open + 2, close - 1);
    for (let prev = ''; prev !== inner; ) {
      prev = inner;
      inner = inner.replace(/\$\([^()]*\)/g, ' ');
    }
    out.push(inner);
  }
  return out;
}

/** Names bash or the runner sets before any step runs. */
const AMBIENT = /^(GITHUB_\w+|RUNNER_\w+|BASH\w*|CI|HOME|PATH|PWD|IFS|RANDOM|SECONDS|LINENO|PIPESTATUS)$/;

/** Names a script gives a value: `X=`, `${X:=…}`, `for X`, `read X Y`. */
const assigned = (code: string): string[] => [
  ...names(code, /(?<![\w$-])([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/g),
  ...names(code, /\$\{([A-Za-z_]\w*):=/g),
  ...names(code, /\bfor\s+(?:\(\(\s*)?([A-Za-z_]\w*)/g),
  ...names(code, /\b(?:read|mapfile|readarray)\s+(?:-\w+\s+)*([A-Za-z_][\w \t]*)/g).flatMap((n) => n.trim().split(/\s+/)),
];

/** Names a nounset script reads that neither it nor `bound` gives a value. */
function unboundReads(body: string, bound: string[]): string[] {
  const code = expanding(body);
  if (!/^\s*set\s+(-[A-Za-z]*u|-o\s+nounset)/m.test(code)) return [];
  const known = new Set([...bound, ...assigned(code)]);
  const reads = [
    // `${X:-…}`, `${X-…}` and the `+`, `?` and `=` forms never trip nounset.
    ...[...code.matchAll(/\$\{[#!]?([A-Za-z_]\w*)(:?[-+?=])?/g)].filter((m) => !m[2]).map((m) => m[1]),
    ...names(code, /\$([A-Za-z_]\w*)/g),
    ...arithmetic(code).flatMap((a) => names(a, /(?<![\w$#.])([A-Za-z_]\w*)/g)),
  ];
  return [...new Set(reads)].filter((r) => !known.has(r) && !AMBIENT.test(r)).sort();
}

/** `file:line: NAME`, the line being the script's `run:` key. */
function unbound(file: string, src: string): string[] {
  const all = scripts(src);
  // A name a step writes to the runner's env file is bound for the steps after it.
  const exported = all.filter((s) => s.body.includes('GITHUB_ENV')).flatMap((s) => assigned(s.body));
  return all.flatMap((s) => unboundReads(s.body, [...s.bound, ...exported]).map((name) => `${file}:${s.n}: ${name}`));
}

/** Lines the runner evaluates: all but YAML comments. A `#` line inside a block scalar is text. */
function evaluated(src: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let block = -1;
  src.split(/\r?\n/).forEach((text, i) => {
    if (block >= 0 && (text.trim() === '' || indentOf(text) > block)) {
      out.push({ n: i + 1, text });
      return;
    }
    block = -1;
    if (/^\s*#/.test(text)) return;
    out.push({ n: i + 1, text });
    const m = /^(\s*)(- )?[^#]*:\s*[|>][-+]?\d*\s*$/.exec(text);
    if (m) block = m[1].length + (m[2] ? 2 : 0);
  });
  return out;
}

const emptyExpressions = (file: string, src: string): string[] =>
  evaluated(src)
    .filter(({ text }) => /\$\{\{\s*\}\}/.test(text))
    .map(({ n }) => `${file}:${n}`);

describe('no run: script under nounset reads a name nothing binds', () => {
  it('finds nounset scripts and their env: at all (guards the guard)', () => {
    const all = workflows().flatMap(({ src }) => scripts(src));
    expect(all.filter((s) => /^\s*set\s+-[A-Za-z]*u/m.test(s.body)).length).toBeGreaterThan(20);
    expect(all.filter((s) => s.bound.length > 0).length).toBeGreaterThan(20);
  });

  it('tells a bound name from an unbound one', () => {
    const yml = [
      'env:',
      '  FROM_WORKFLOW: 1',
      'jobs:',
      '  a:',
      '    env:',
      '      FROM_JOB: 1',
      '    steps:',
      '      - name: bound every way a name can be',
      '        env:',
      '          FROM_STEP: 1',
      '        run: |',
      '          set -euo pipefail',
      '          LOCAL=$(stat -c%s f)',
      '          for item in a b; do echo "$item"; done',
      '          echo "$FROM_WORKFLOW $FROM_JOB $FROM_STEP ${LOCAL} $(( (LOCAL + 1) * 2 )) $GITHUB_SHA"',
      '          echo "${MAYBE:-} ${MAYBE_TOO-x} \\$ESCAPED" \'$NOT_EXPANDED\'  # $IN_A_COMMENT',
      "          python3 - <<'PY'",
      '          print("$NOT_SHELL")',
      '          PY',
      '      - name: unbound three ways, and another step\'s env does not carry',
      '        run: |',
      '          set -eu',
      '          echo "$PLAIN ${BRACED} $((ARITH * 2)) $FROM_STEP"',
      '      - name: no nounset, so an unset name is only an empty string',
      '        run: |',
      '          echo "$ANYTHING"',
      '  b:',
      '    steps:',
      '      - run: |',
      '          set -u',
      '          echo "$FROM_WORKFLOW $FROM_JOB"',
    ].join('\n');
    expect(unbound('x.yml', yml)).toEqual([
      'x.yml:21: ARITH',
      'x.yml:21: BRACED',
      'x.yml:21: FROM_STEP',
      'x.yml:21: PLAIN',
      'x.yml:29: FROM_JOB',
    ]);
  });

  it('finds none in any workflow', () => {
    expect(
      workflows().flatMap(({ file, src }) => unbound(file, src)),
      'under `set -u` this read fails the step. Give the name a value in the script or in an ' +
        'env: block, or read it as ${NAME:-} if it may be unset.',
    ).toEqual([]);
  });
});

describe('no workflow carries an empty expression', () => {
  it('reads expressions at all (guards the guard)', () => {
    const lines = workflows().flatMap(({ src }) => evaluated(src));
    expect(lines.filter(({ text }) => text.includes('${{')).length).toBeGreaterThan(50);
  });

  it('tells a YAML comment from a comment the runner evaluates', () => {
    const yml = [
      '# prose about ${{ }} up here is a YAML comment',
      'jobs:',
      '  a:',
      '    steps:',
      '      - name: x',
      '        # so is this: ${{ }}',
      '        run: |',
      '          # this is script text: ${{ }}',
      '          echo ok',
      '        env:',
      '          # a YAML comment again: ${{ }}',
      '          A: ${{   }}',
    ].join('\n');
    expect(emptyExpressions('x.yml', yml)).toEqual(['x.yml:8', 'x.yml:12']);
  });

  it('finds none in any workflow', () => {
    expect(
      workflows().flatMap(({ file, src }) => emptyExpressions(file, src)),
      'GitHub evaluates this text, comment or not, and an empty expression makes it reject the ' +
        'whole workflow file. Say "expression" in words.',
    ).toEqual([]);
  });
});
