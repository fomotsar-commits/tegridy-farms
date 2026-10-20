// @vitest-environment node
//
// Range pools pay Raydium nothing, ever (owner ruling 2026-10-13). key-guard.mjs keeps the
// programs clean; this keeps the SITE clean: no key Raydium's repositories hard-code may
// appear in code the site ships, so no page can build a transaction to Raydium or route
// money to an account it holds. Test files and recorded fixtures may name them (the range
// client is proven against Raydium's live accounts); nothing shipped may import those.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
import { findKeys, readDeny } from '../../../solana/guards/key-guard.mjs';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(FRONTEND, '..');
const DENY: string[] = readDeny(readFileSync(join(REPO_ROOT, 'solana', 'guards', 'upstream', 'deny-keys.txt'), 'utf-8'));
const ALLOW = JSON.parse(readFileSync(join(REPO_ROOT, 'solana', 'guards', 'allowed-keys.json'), 'utf-8')) as { keptUpstream: Record<string, unknown> };

/**
 * On the deny list but not Raydium's: the Memo program (a Solana program anyone uses), and
 * the four stablecoin mints the pool program takes by name, which the site names to explain
 * a block (lp/tokenSafety.ts). Every other entry is a Raydium program, owner or fee account.
 */
const NOT_RAYDIUMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', ...Object.keys(ALLOW.keptUpstream)]);
const RAYDIUM = DENY.filter((k) => !NOT_RAYDIUMS.has(k));

const SHIPPED_ROOTS = ['src', 'api', 'public', 'index.html', 'vercel.json'];
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|txt|webmanifest)$/;
const testOnly = (rel: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /\.fixture\.[jt]sx?$/.test(rel) || rel.split(sep).includes('__fixtures__') || rel.split(sep).includes('__tests__') || rel.startsWith(`src${sep}test${sep}`);

function walk(abs: string, out: string[]) {
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) if (name !== 'node_modules') walk(join(abs, name), out);
  } else if (TEXT.test(abs)) {
    out.push(abs);
  }
}

const files: string[] = [];
for (const r of SHIPPED_ROOTS) walk(join(FRONTEND, r), files);
const shipped = files.map((f) => relative(FRONTEND, f)).filter((rel) => !testOnly(rel));

describe('no Raydium key in what the site ships', () => {
  it('knows what it is looking for', () => {
    expect(RAYDIUM).toContain('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    expect(RAYDIUM).toContain('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    expect(RAYDIUM).toContain('GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ');
    expect(RAYDIUM.length).toBe(DENY.length - NOT_RAYDIUMS.size);
    expect(shipped.length).toBeGreaterThan(500);
    expect(shipped).toContain(join('src', 'lib', 'solana', 'clmm', 'program.ts'));
  });

  it('no shipped file names one, plain or glued to other letters', () => {
    const hits: string[] = [];
    for (const rel of shipped) {
      const text = readFileSync(join(FRONTEND, rel), 'utf8');
      for (const k of RAYDIUM) if (text.includes(k)) hits.push(`${rel}: ${k}`);
      for (const k of (findKeys(text).keys as string[])) if (RAYDIUM.includes(k)) hits.push(`${rel}: ${k}`);
    }
    expect(hits).toEqual([]);
  });

  it('no shipped file imports a test file or a recorded fixture', () => {
    const hits = shipped.filter((rel) => /\.[cm]?[jt]sx?$/.test(rel)).filter((rel) => {
      const text = readFileSync(join(FRONTEND, rel), 'utf8');
      return /from\s+['"][^'"]*(\.fixture|__fixtures__|\.test)['"/]/.test(text) || /import\(\s*['"][^'"]*(\.fixture|__fixtures__)/.test(text);
    });
    expect(hits).toEqual([]);
  });
});
