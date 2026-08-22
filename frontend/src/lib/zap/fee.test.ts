import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zapFeeDisclosure } from './fee';

describe('what a zap charges', () => {
  it('adds nothing of its own, on every branch', () => {
    for (const input of [
      { executor: null, routerFeeBps: null },
      { executor: 'uniswap-v2' as const, routerFeeBps: null },
      { executor: 'swap-fee-router' as const, routerFeeBps: null },
      { executor: 'swap-fee-router' as const, routerFeeBps: 0 },
      { executor: 'swap-fee-router' as const, routerFeeBps: 25 },
    ]) {
      expect(zapFeeDisclosure(input).addedByZap).toBe(0);
    }
  });

  it('renders an unread router fee as unavailable, never as zero', () => {
    const d = zapFeeDisclosure({ executor: 'swap-fee-router', routerFeeBps: null });
    expect(d.value).toBe('Unavailable');
    expect(d.unavailable).toBe(true);
    expect(d.value).not.toMatch(/0/);
    expect(d.note).toMatch(/not a zero/i);
  });

  it('renders a genuine on-chain zero as none, and says which is which', () => {
    const zero = zapFeeDisclosure({ executor: 'swap-fee-router', routerFeeBps: 0 });
    expect(zero.value).toBe('None');
    expect(zero.unavailable).toBe(false);
    expect(zero.note).toMatch(/reads as zero/);
  });

  it('shows the router s own rate when it answers', () => {
    expect(zapFeeDisclosure({ executor: 'swap-fee-router', routerFeeBps: 25 }).value).toBe('0.25%');
    expect(zapFeeDisclosure({ executor: 'swap-fee-router', routerFeeBps: 30 }).value).toBe('0.3%');
  });

  it('takes nothing on a Uniswap fill — the venue does not host that trade', () => {
    const d = zapFeeDisclosure({ executor: 'uniswap-v2', routerFeeBps: 25 });
    expect(d.value).toBe('None');
    expect(d.unavailable).toBe(false);
  });

  it('never claims the figure covers pool, aggregator or gas costs', () => {
    for (const input of [
      { executor: null, routerFeeBps: null },
      { executor: 'uniswap-v2' as const, routerFeeBps: 25 },
      { executor: 'swap-fee-router' as const, routerFeeBps: 25 },
      { executor: 'swap-fee-router' as const, routerFeeBps: null },
    ]) {
      expect(zapFeeDisclosure(input).note).toMatch(/not part of this figure/);
    }
  });
});

describe('there is exactly one fee dial, and the zap is not it', () => {
  // The house rule is "do not add a second fee mechanism". A comment saying so decays;
  // a grep does not. The zap's own directories may not read any VITE_ env var at all —
  // the only venue fee dial is src/lib/fees/swapFee.ts, which fee.ts reads through.
  const src = join(process.cwd(), 'src');
  const OWNED = [join(src, 'lib', 'zap'), join(src, 'components', 'zap')];

  function walk(dir: string, acc: string[] = []): string[] {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir);
    } catch {
      return acc;
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.tsx?$/.test(name)) acc.push(p);
    }
    return acc;
  }

  const hookFiles = readdirSync(join(src, 'hooks'))
    .filter((f) => /^useZap.*\.tsx?$/.test(f))
    .map((f) => join(src, 'hooks', f));

  const files = [...OWNED.flatMap((d) => walk(d)), ...hookFiles];

  it('found the zap sources — an empty sweep would pass vacuously', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it('declares no environment dial of its own', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      // The guard's own test file names the pattern it forbids; skip it, not the rule.
      if (file.endsWith('fee.test.ts')) continue;
      const hits = source.match(/import\.meta\.env\.VITE_\w+/g) ?? [];
      expect(hits, `${file} reads an env dial. The venue fee has exactly one, in src/lib/fees/swapFee.ts.`).toEqual([]);
    }
  });

  it('reads the venue fee policy rather than restating a rate', () => {
    const source = readFileSync(join(src, 'lib', 'zap', 'fee.ts'), 'utf-8');
    expect(source).toMatch(/from '\.\.\/fees\/swapFee'/);
  });
});
