// The failure-swallowers cannot come back.
//
// ci.yml carried `continue-on-error: true` on Unit Tests (added 2026-05-18 for
// 79 pre-existing vitest failures) and on E2E Tests (added the same day for six
// selector-drift failures nobody had triaged). Both premises expired; both
// flags were removed, on 2026-07-28 and 2026-07-30. In between, every
// regression in those suites — including 44 serverless-API security tests —
// would have merged green.
//
// Removing a flag is a fact about one commit. Nothing stopped the next red
// build from re-adding it "just to unblock", which is exactly how it got there
// the first time. This is the ratchet.
//
// WHAT IS PINNED — behaviour, never wording:
//   * no step in ci.yml swallows its own failure (`continue-on-error: true`)
//   * no step in ci.yml swallows a command's failure inside the script
//     (`|| true`, `|| exit 0`, `set +e`) — same effect, different spelling,
//     and the spelling CI review is least likely to notice
//   * the suites that were swallowed still RUN, and the money paths have a job
//   * no `run:` block interpolates `${{ }}` (command injection; one was found
//     and fixed here already)
//
// Job names, step names and ordering are deliberately NOT asserted. Rename
// freely.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const CI = join(WORKFLOW_DIR, 'ci.yml');

const source = (): string => readFileSync(CI, 'utf-8');

/** Lines with YAML comments stripped, so rationale prose is never mistaken for config. */
const configLines = (): { n: number; text: string }[] =>
  source()
    .split(/\r?\n/)
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => !/^\s*#/.test(text));

/** Every `run:` script body in the file, single-line and block form alike. */
const runScripts = (): { n: number; body: string }[] => {
  const lines = source().split(/\r?\n/);
  const out: { n: number; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, indent, rest] = m;
    if (rest.trim() !== '' && !/^[|>][-+]?\d*$/.test(rest.trim())) {
      out.push({ n: i + 1, body: rest });
      continue;
    }
    let block = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && !lines[j].startsWith(`${indent} `)) break;
      block += `${lines[j]}\n`;
    }
    out.push({ n: i + 1, body: block });
  }
  return out;
};

/** Script text with shell comments removed — `# … || true` is prose, not a swallow. */
const shellCode = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('ci.yml cannot swallow a failure', () => {
  it('parses something at all (guards the guard)', () => {
    expect(runScripts().length).toBeGreaterThan(5);
    expect(source()).toContain('jobs:');
  });

  it('has no continue-on-error anywhere', () => {
    const offenders = configLines()
      .filter(({ text }) => /continue-on-error:\s*true/i.test(text))
      .map(({ n, text }) => `ci.yml:${n}: ${text.trim()}`);
    expect(
      offenders,
      'a step is allowed to fail without failing the job. That is how the unit + e2e suites ' +
        'stopped being gates for two months. Fix the failure instead.',
    ).toEqual([]);
  });

  it('has no step whose script swallows a non-zero exit', () => {
    // `|| true` / `|| exit 0` / `set +e` are continue-on-error wearing shell
    // clothes: the step goes green while the command it exists to run failed.
    const offenders: string[] = [];
    for (const { n, body } of runScripts()) {
      const code = shellCode(body);
      if (/\|\|\s*true\b/.test(code)) offenders.push(`ci.yml:${n}: '|| true'`);
      if (/\|\|\s*exit\s+0\b/.test(code)) offenders.push(`ci.yml:${n}: '|| exit 0'`);
      if (/^\s*set\s+\+e\b/m.test(code)) offenders.push(`ci.yml:${n}: 'set +e'`);
    }
    expect(
      offenders,
      'these scripts discard a command failure. If a command is genuinely allowed to fail, ' +
        'branch on its status explicitly and say why — do not hide the exit code.',
    ).toEqual([]);
  });

  it('never interpolates ${{ }} inside a run: script', () => {
    // `${{ }}` is textual substitution performed BEFORE bash parses the script,
    // so the value is shell source rather than data. Comments are NOT stripped
    // here: an interpolated newline escapes a shell comment just as readily as
    // it escapes a quote.
    const offenders = runScripts()
      .filter(({ body }) => body.includes('${{'))
      .map(({ n }) => `ci.yml:${n}`);
    expect(
      offenders,
      'bind the value through env: instead — a command injection was already found and fixed this way here.',
    ).toEqual([]);
  });
});

describe('ci.yml still runs the suites the swallowers were hiding', () => {
  const text = () => source();

  it('runs the unit suite', () => {
    expect(text()).toMatch(/run:\s*npm test\b/);
  });

  it('runs the e2e suite', () => {
    expect(text()).toMatch(/playwright test/);
  });

  it('has a job that runs the money paths against a chain, and requires it to have run', () => {
    // The money-path specs skip themselves without ANVIL_RPC_URL, and
    // Playwright exits 0 on an all-skipped run — so "a job exists" is not
    // enough. Pin the harness invocation AND the skip assertion that stops it
    // reporting green over nothing.
    expect(text(), 'no job invokes the anvil e2e harness (npm run e2e)').toMatch(/npm run e2e\b/);
    expect(
      text(),
      'the anvil job does not refuse to fall back to mock-mode — without E2E_REQUIRE_ANVIL ' +
        'a runner missing Foundry silently reruns the all-skipped suite and passes',
    ).toContain('E2E_REQUIRE_ANVIL');
    expect(
      text(),
      'nothing asserts the money-path run had zero skips; an all-skipped Playwright run exits 0',
    ).toMatch(/stats\.skipped/);
  });
});

// AUDIT R056: every third-party action is pinned to a full commit SHA.
//
// A floating `@v4` is a promise from a tag owner that the tag will not move.
// Tags move — that is how a supply-chain compromise reaches a runner holding
// a service key. Most of this repo was pinned; solana-ci.yml,
// solana-deploy-artifact.yml and gitleaks.yml were not, so the hardening was
// true of the files someone remembered and silently false of the rest.
//
// Repo-wide and self-extending: a new workflow is covered the day it lands.
describe('every third-party action is pinned to a commit SHA', () => {
  const usesLines = (): { file: string; n: number; ref: string; line: string }[] => {
    const out: { file: string; n: number; ref: string; line: string }[] = [];
    for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      readFileSync(join(WORKFLOW_DIR, file), 'utf-8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
          if (!m) return;
          // `uses: ./path` and `uses: docker://…` are not tag-pinned refs.
          if (m[1].startsWith('.') || m[1].startsWith('docker://')) return;
          const at = m[1].lastIndexOf('@');
          if (at === -1) return;
          out.push({ file, n: i + 1, ref: m[1].slice(at + 1), line: line.trim() });
        });
    }
    return out;
  };

  it('finds action references at all (guards the guard)', () => {
    expect(usesLines().length).toBeGreaterThan(10);
  });

  it('pins every one to a 40-character SHA', () => {
    const floating = usesLines()
      .filter((u) => !/^[0-9a-f]{40}$/.test(u.ref))
      .map((u) => `${u.file}:${u.n}: ${u.line}`);
    expect(
      floating,
      'these actions float on a tag or branch. Resolve to a commit SHA and keep the version in a trailing comment. ' +
        'Method note: git/ref/tags/vX can return an ANNOTATED TAG object rather than the commit — dereference via ' +
        'git/tags/<sha> before trusting what you paste.',
    ).toEqual([]);
  });
});
