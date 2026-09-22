// The root is a front door: what a session opens first is short, current and small.
//
// CLAUDE.md is one screen: it names the build recipe, the one to-do file and the laws.
// The root holds the community files, the notes, the changelog and config; everything
// else lives under docs/. Every other plan in docs/ and docs/archive/ opens with a pointer
// to the one to-do list, and the changelog is one line per change.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf-8');
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const EM_DASH = '—';

describe('CLAUDE.md', () => {
  it('exists, fits one screen (under 4 KB), and is plain ASCII with no em dash', () => {
    const text = read('CLAUDE.md');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(4096);
    expect(text).not.toContain(EM_DASH);
    expect([...text].filter((c) => c.charCodeAt(0) > 0x7e || (c.charCodeAt(0) < 0x20 && c !== '\n'))).toEqual([]);
  });

  it('names the one to-do file, and that file exists', () => {
    expect(read('CLAUDE.md')).toContain('docs/TODO_OPERATOR.md');
    expect(existsSync(join(REPO_ROOT, 'docs', 'TODO_OPERATOR.md'))).toBe(true);
  });

  it('gives a build recipe whose every command a workflow actually runs', () => {
    const text = read('CLAUDE.md');
    const fence = /```\n([\s\S]*?)```/.exec(text);
    expect(fence, 'CLAUDE.md has no fenced build recipe').not.toBeNull();
    const commands = fence![1]
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trim())
      .filter((l) => l && !l.startsWith('cd '));
    expect(commands.length).toBeGreaterThanOrEqual(6);
    const workflows = readdirSync(join(REPO_ROOT, '.github', 'workflows'))
      .map((f) => read('.github', 'workflows', f))
      .join('\n');
    for (const c of commands) expect(workflows, `no workflow runs \`${c}\``).toContain(c);
  });

  it('says how to read NOTES.md: headings first', () => {
    expect(read('CLAUDE.md')).toContain("grep -n '^## ' NOTES.md");
  });
});

describe('the root is a front door', () => {
  // Community files stay at the root because GitHub reads them there; NOTICE.md because
  // LICENSE and the contract sources cite it; slither.config.json is config.
  const ROOT_ALLOWLIST = [
    '.claude',
    '.gitattributes',
    '.github',
    '.gitignore',
    '.gitleaks.toml',
    '.gitmodules',
    '.nvmrc',
    '.vercelignore',
    '.vscode',
    'CHANGELOG.md',
    'CLAUDE.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'NOTES.md',
    'NOTICE.md',
    'README.md',
    'SECURITY.md',
    'bot',
    'contracts',
    'docs',
    'frontend',
    'indexer',
    'indexer-solana',
    'package-lock.json',
    'package.json',
    'scripts',
    'slither.config.json',
    'solana',
  ];

  it('tracks nothing at the root outside the allowlist', () => {
    const roots = [...new Set(tracked().map((f) => f.split('/')[0]))].sort();
    expect(roots).toEqual([...ROOT_ALLOWLIST].sort());
  });

  it('tracks no runtime lock under .claude', () => {
    expect(tracked().filter((f) => f.startsWith('.claude/') && f.endsWith('.lock'))).toEqual([]);
  });
});

describe('one to-do list', () => {
  const PLAN = /(PLAN|TODO|NEXT|ROADMAP|LEFT|UNFINISHED|WHAT_I_NEED)/;
  const plans = (): string[] =>
    ['docs', 'docs/archive']
      .filter((d) => existsSync(join(REPO_ROOT, d)))
      .flatMap((d) =>
        readdirSync(join(REPO_ROOT, d))
          .filter((f) => f.endsWith('.md') && PLAN.test(f))
          .map((f) => `${d}/${f}`),
      )
      .filter((f) => f !== 'docs/TODO_OPERATOR.md');

  it('finds the plan documents (guards the guard)', () => {
    expect(plans().length).toBeGreaterThanOrEqual(13);
  });

  it('opens every other plan document with a link to docs/TODO_OPERATOR.md', () => {
    const missing: string[] = [];
    for (const f of plans()) {
      const head = read(...f.split('/')).split('\n').slice(0, 3).join('\n');
      const link = /\]\(([^)\s]*TODO_OPERATOR\.md)\)/.exec(head);
      const target = link && posix.normalize(posix.join(posix.dirname(f), link[1]));
      if (target !== 'docs/TODO_OPERATOR.md') missing.push(f);
    }
    expect(missing, 'these plans do not open with a working pointer to the one to-do list').toEqual([]);
  });

  it('lets no plan document claim to outrank it', () => {
    const claims = plans().filter((f) => /this file is now newer/i.test(read(...f.split('/'))));
    expect(claims).toEqual([]);
  });

  it('lets no plan document call another file the to-do list', () => {
    // Naming some other plan "the operational to-do list" competes with the one list the
    // way a precedence claim does. A paragraph that points at TODO_OPERATOR.md is fine.
    const CLAIM = /\b(?:operational|canonical|single|master|main)\s+to-?do\s+list\b/i;
    const claims = plans().flatMap((f) =>
      read(...f.split('/'))
        .split('\n')
        .slice(3)
        .join('\n')
        .split(/\n\s*\n/)
        .filter((para) => CLAIM.test(para) && !para.includes('TODO_OPERATOR.md'))
        .map((para) => `${f}: ${CLAIM.exec(para)![0]}`),
    );
    expect(claims, 'only docs/TODO_OPERATOR.md is the to-do list').toEqual([]);
  });
});

describe('the changelog is one line per change', () => {
  it('stays short and points at the long form in git', () => {
    const text = read('CHANGELOG.md');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(64 * 1024);
    expect(text).toContain('git show 531813e6:CHANGELOG.md');
  });

  it('holds only date headings and one-line entries under Unreleased, with no em dash', () => {
    const text = read('CHANGELOG.md');
    expect(text.indexOf('## [Unreleased]')).toBeGreaterThan(-1);
    const rest = text.slice(text.indexOf('## [Unreleased]') + '## [Unreleased]'.length);
    const next = rest.search(/^## /m);
    const body = next === -1 ? rest : rest.slice(0, next);
    const odd = body
      .split('\n')
      .filter((l) => l.trim() !== '')
      .filter((l) => !/^### \d{4}-\d{2}-\d{2}$/.test(l) && !/^- \S/.test(l) && !/^<!--.*-->$/.test(l));
    expect(odd, 'every line under Unreleased is a date heading, one entry, or the slot marker').toEqual([]);
    expect(body.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThan(10);
    expect(text).not.toContain(EM_DASH);
  });
});
