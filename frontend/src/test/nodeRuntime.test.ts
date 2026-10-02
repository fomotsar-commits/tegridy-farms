// One Node version, chosen in one place, and never one past its end of life.
//
// Node 20 reached end of life on 2026-04-30 and the repo kept running it for five months:
// .nvmrc, sixteen workflow steps and five package.json files all said 20 (or ">=20.0.0"),
// and nothing noticed. The open range also meant two different things to the two hosts
// that read it. Railway's builder took the bottom of the range and ran the indexer on
// 20.20.2. Vercel took the top, and its build log warned the range "will automatically
// upgrade when a new major Node.js Version is released", so production could change its
// runtime with no commit at all.
//
// Pinned here:
//   1. .nvmrc names one major, and that major is not past its end of life.
//   2. Every setup-node step in .github/workflows names a version, and it is that major.
//   3. Every package.json at the repo root or one folder down (the things that get
//      deployed) says engines.node "<major>.x": one major, bounded, read the same way
//      by Vercel, Railway and npm.
//   4. No @types/node is ahead of the runtime (types for an API the runtime lacks still
//      type-check, then throw in production), and Dependabot is told not to offer one.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf-8');

// The Node.js release schedule (nodejs.org/en/about/previous-releases). Only even majors
// become LTS. A major missing from this table fails on purpose: when you move to it, add
// its end-of-life date from that page.
const END_OF_LIFE: Record<number, string> = {
  20: '2026-04-30',
  22: '2027-04-30',
  24: '2028-04-30',
  26: '2029-04-30',
};

const runtimeMajor = (): number => {
  const text = read('.nvmrc').trim();
  expect(text, '.nvmrc must be a bare major, like 24').toMatch(/^\d+$/);
  return Number(text);
};

/** Tracked package.json files at the repo root or one folder down. */
const deployableManifests = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter((p) => /^([^/]+\/)?package\.json$/.test(p));

const manifest = (path: string) => JSON.parse(read(path)) as {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const workflowFiles = (): string[] =>
  readdirSync(join(REPO_ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));

/** The major a semver range starts at: "^24.12.0" -> 24, "~22" -> 22, "24.x" -> 24. */
const rangeMajor = (range: string): number => {
  const m = /(\d+)/.exec(range);
  if (!m) throw new Error(`cannot read a major out of "${range}"`);
  return Number(m[1]);
};

describe('the Node runtime', () => {
  it('.nvmrc names a major that is still supported', () => {
    const major = runtimeMajor();
    const eol = END_OF_LIFE[major];
    expect(eol, `Node ${major} has no end-of-life date in END_OF_LIFE; add it`).toBeDefined();
    expect(
      Date.now() <= Date.parse(`${eol}T23:59:59Z`),
      `Node ${major} reached end of life on ${eol}; move .nvmrc and everything this file pins to a supported LTS`,
    ).toBe(true);
  });

  it('every setup-node step in the workflows names that major', () => {
    const major = String(runtimeMajor());
    const wrong: string[] = [];
    let steps = 0;
    let versions = 0;
    for (const f of workflowFiles()) {
      const lines = read('.github', 'workflows', f).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (/uses:\s*actions\/setup-node@/.test(line)) steps++;
        const m = /^\s*node-version:\s*["']?([^"'\s#]+)["']?/.exec(line);
        if (m) {
          versions++;
          if (m[1] !== major) wrong.push(`${f}:${i + 1} node-version ${m[1]}`);
        }
        if (/^\s*node-version-file:/.test(line)) versions++;
      });
    }
    expect(steps, 'no setup-node step found; the scan is reading the wrong files').toBeGreaterThan(0);
    // A setup-node step with no version runs whatever Node the runner image ships.
    expect(versions, 'a setup-node step names no node-version').toBe(steps);
    expect(wrong).toEqual([]);
  });

  it('every deployable package.json pins engines.node to that one major', () => {
    const want = `${runtimeMajor()}.x`;
    const files = deployableManifests();
    // root, frontend, indexer, indexer-solana, bot at the time of writing
    expect(files.length).toBeGreaterThanOrEqual(5);
    const wrong = files
      .map((f) => ({ f, node: manifest(f).engines?.node }))
      .filter(({ node }) => node !== want)
      .map(({ f, node }) => `${f}: engines.node ${JSON.stringify(node)}, want "${want}"`);
    expect(wrong).toEqual([]);
  });

  it('no @types/node is ahead of the runtime, and Dependabot will not offer one', () => {
    const major = runtimeMajor();
    const dependabot = read('.github', 'dependabot.yml');
    // One block per `- package-ecosystem:` entry, keyed by its directory.
    const blocks = dependabot.split(/\n(?=\s*- package-ecosystem:)/);
    const blockFor = (dir: string) =>
      blocks.find((b) => new RegExp(`directory:\\s*["']?${dir.replace(/[/]/g, '\\/')}["']?\\s*\\n`).test(b));

    const problems: string[] = [];
    for (const f of deployableManifests()) {
      const m = manifest(f);
      const range = m.devDependencies?.['@types/node'] ?? m.dependencies?.['@types/node'];
      if (!range) continue;
      if (rangeMajor(range) > major) problems.push(`${f}: @types/node ${range} is ahead of Node ${major}`);
      const dir = f.includes('/') ? `/${f.split('/')[0]}` : '/';
      const block = blockFor(dir);
      if (!block) {
        problems.push(`${f}: no Dependabot npm entry for ${dir}`);
        continue;
      }
      const ignore = /- dependency-name:\s*["']@types\/node["']\s*\n\s*versions:\s*\[\s*["']>=\s*(\d+)["']\s*\]/.exec(block);
      if (!ignore) problems.push(`${dir}: Dependabot has no @types/node ignore for majors above ${major}`);
      else if (Number(ignore[1]) !== major + 1)
        problems.push(`${dir}: Dependabot ignores @types/node >=${ignore[1]}, want >=${major + 1}`);
    }
    expect(problems).toEqual([]);
  });
});
