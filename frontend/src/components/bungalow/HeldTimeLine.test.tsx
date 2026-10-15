// The held-time line: one sentence per staking card, chosen by the pool registry.
// The card passes its chain and pool; the registry decides which sentence shows.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HeldTimeLine } from './HeldTimeLine';

const READ = 'Staking keeps your held time.';
const UNREAD_SHORT = 'Not counted as held time yet. Your clock is not reset.';
const UNREAD =
  'Heat reads wallets today. A bag locked here is not counted until the island reads this pool. Your clock is not reset.';

const LADDER = 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV';
const LIGHTHOUSE = 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';
const PEPE_LADDER = '0xBE1905de5FCDe60E13a9F1AfA44BEfdE1C5aaA1D';
const BOBO_LIGHTHOUSE = 'PkwDYVNxyesAukE9STqRQL9H1pBpXbt1tVbiYVMX96w';

const lineOf = (c: HTMLElement) => c.querySelector('[data-held-time]') as HTMLElement;

describe('the held-time line', () => {
  it('says the read sentence, exactly, on a pool the island reads', () => {
    for (const pool of [LADDER, LIGHTHOUSE]) {
      const { container, unmount } = render(<HeldTimeLine chain="solana" pool={pool} />);
      const line = lineOf(container);
      expect(line.textContent).toBe(READ);
      expect(line.getAttribute('data-held-time')).toBe('read');
      unmount();
    }
  });

  it('says the short unread line, with the full sentence exactly, one press away, on a pool the island does not read', () => {
    const cases: [ 'ethereum' | 'solana', string ][] = [['ethereum', PEPE_LADDER], ['solana', BOBO_LIGHTHOUSE]];
    for (const [chain, pool] of cases) {
      const { container, unmount } = render(<HeldTimeLine chain={chain} pool={pool} />);
      const line = lineOf(container);
      expect(line.getAttribute('data-held-time')).toBe('unread');
      expect(line.querySelector('p')!.textContent).toBe(UNREAD_SHORT);
      const fold = line.querySelector('details')!;
      expect(fold.open).toBe(false);
      expect(fold.querySelector('p')!.textContent).toBe(UNREAD);
      expect(screen.queryByText(READ)).toBeNull();
      unmount();
    }
  });

  it('is a plain paragraph: no role, no dialog, no alarm colour, no em dash', () => {
    for (const pool of [LADDER, PEPE_LADDER]) {
      const { container, unmount } = render(<HeldTimeLine chain={pool.startsWith('0x') ? 'ethereum' : 'solana'} pool={pool} />);
      const line = lineOf(container);
      // The visible line is a paragraph; the unread case wraps it with its fold.
      const visible = line.tagName === 'P' ? line : line.querySelector('p')!;
      expect(visible.tagName).toBe('P');
      for (const el of [line, visible]) {
        expect(el.getAttribute('role')).toBeNull();
        expect(el.getAttribute('aria-live')).toBeNull();
        expect(el.getAttribute('style') ?? '').not.toMatch(/f0b26b|fca5a5|239,\s*68,\s*68|240,\s*178,\s*107/i);
      }
      expect(line.closest('[role="dialog"],dialog')).toBeNull();
      expect(line.textContent).not.toMatch(/\u2014/);
      unmount();
    }
  });

  it('types each sentence in one source file only', () => {
    const SRC = join(process.cwd(), 'src');
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
      }
      return acc;
    };
    const holders = walk(SRC)
      .filter((f) => {
        const s = readFileSync(f, 'utf8');
        return s.includes(READ) || s.includes('A bag locked here is not counted');
      })
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(holders).toEqual(['components/bungalow/HeldTimeLine.tsx']);
  });
});
