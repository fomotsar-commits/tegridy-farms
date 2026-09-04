// HONESTY GUARD for the island-tape half of /copy-trading.
//
// pages/copyCompetitionHonesty.test.ts is shared with the competitions surface
// and pins the indexer half. This file pins the half that reads a live,
// third-party, rate-limited feed — where the failure modes are different and
// where the flattering mistake is not an empty table but a SHORT one:
//
//   an unread pool rendered as a quiet pool
//   a fill with no USD valuation summed as $0
//   a sender address described as a trader
//   a mirror the tape cannot see reported as one that did not happen
//
// The libraries refuse all four and their own tests pin that. What THIS file
// pins is the render layer and the module boundary, where a refusal is easiest
// to undo by accident.
//
// Prose may be rewritten freely. Add a second fetch site, coerce an unknown to
// zero, print a return, or draw the board outside its read state, and this goes
// red.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasCopyTapeSource, islandPools } from '../lib/copytrade/tape';

const SRC = join(process.cwd(), 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

/** Every file this lane added or rewrote for the tape. */
const SURFACES: Record<string, string> = {
  'pages/CopyTradingPage.tsx': read('pages', 'CopyTradingPage.tsx'),
  'components/copytrade/TapeLeaderBoard.tsx': read('components', 'copytrade', 'TapeLeaderBoard.tsx'),
  'components/copytrade/TapeReadLedger.tsx': read('components', 'copytrade', 'TapeReadLedger.tsx'),
  'components/copytrade/MirrorQueue.tsx': read('components', 'copytrade', 'MirrorQueue.tsx'),
  'components/copytrade/FollowForm.tsx': read('components', 'copytrade', 'FollowForm.tsx'),
  'components/copytrade/FollowerRecord.tsx': read('components', 'copytrade', 'FollowerRecord.tsx'),
  'lib/copytrade/tape.ts': read('lib', 'copytrade', 'tape.ts'),
  'lib/copytrade/tapeLeaderboard.ts': read('lib', 'copytrade', 'tapeLeaderboard.ts'),
  'lib/copytrade/tapeMirror.ts': read('lib', 'copytrade', 'tapeMirror.ts'),
  'lib/copytrade/tapeReconcile.ts': read('lib', 'copytrade', 'tapeReconcile.ts'),
  'lib/copytrade/quoteTokens.ts': read('lib', 'copytrade', 'quoteTokens.ts'),
  'lib/copytrade/follows.ts': read('lib', 'copytrade', 'follows.ts'),
  'lib/copytrade/base58.ts': read('lib', 'copytrade', 'base58.ts'),
  'hooks/useIslandTape.ts': read('hooks', 'useIslandTape.ts'),
  'hooks/useTapeSignals.ts': read('hooks', 'useTapeSignals.ts'),
  'hooks/useTapeFollowerFills.ts': read('hooks', 'useTapeFollowerFills.ts'),
  'hooks/useCopyFollows.ts': read('hooks', 'useCopyFollows.ts'),
};

/** Strip comments — the notes discuss `?? 0`, `fetch(` and "profit" on purpose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('an unread figure never becomes a number', () => {
  const NUMERIC_FALLBACK = /(\?\?|\|\|)\s*0n?\b/;

  it.each(Object.keys(SURFACES))('%s has no numeric fallback for a read', (name) => {
    const offenders = code(SURFACES[name]!)
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => NUMERIC_FALLBACK.test(l.line));
    expect(
      offenders,
      `${name} coerces something to zero:\n${offenders.map((o) => `  line ${o.n}: ${o.line}`).join('\n')}`,
    ).toEqual([]);
  });
});

describe('there is exactly one place this app asks GeckoTerminal for a tape', () => {
  it('the fetch lives in the shared reader and nowhere in this slice', () => {
    // A second fetch site is not a style problem: it is a second place for the
    // CSP entry, the abort handling, the 429 wording and the null-vs-zero rule
    // to drift — and, on a rate-limited upstream, a second consumer of one
    // budget.
    // The reader reaches the global through an injectable seam
    // (`opts.fetchImpl ?? fetch`), so the pin is that IT names the global and
    // nothing in this slice does.
    const reader = code(readFileSync(join(SRC, 'lib', 'geckoTerminal', 'poolTrades.ts'), 'utf8'));
    expect(reader, 'the shared reader no longer performs the request').toMatch(
      /(\?\?\s*fetch\b|\bfetch\s*\()/,
    );

    for (const [name, src] of Object.entries(SURFACES)) {
      const body = code(src);
      expect(body, `${name} calls fetch directly`).not.toMatch(/\bfetch\s*\(/);
      expect(body, `${name} reaches for the global fetch`).not.toMatch(/(\?\?|=)\s*fetch\b/);
      expect(body, `${name} names key material`).not.toMatch(
        /privateKey|mnemonic|seedPhrase|\bsignMessage\b/i,
      );
    }
  });
});

describe('no table is drawn in a state that could not read one', () => {
  const page = code(SURFACES['pages/CopyTradingPage.tsx']!);

  it('mounts the tape board only from a non-null board in a read state', () => {
    expect(page).toMatch(/tape\.status === 'ready' \|\| tape\.status === 'partial'/);
    expect(page).toMatch(/tapeReadable && tape\.board \? \(/);
  });

  it('keeps the router panels behind their own read states', () => {
    expect(page).toMatch(/signals\.status === 'ready' \|\| signals\.status === 'backfilling'/);
    expect(page).toMatch(/board\.board \? \(/);
    expect(page.match(/<CopyDataNotice/g) ?? []).toHaveLength(3);
  });

  it('leads with the read ledger, so a short read is described before it is drawn', () => {
    expect(page).toContain('<TapeReadLedger');
    expect(page.indexOf('<TapeReadLedger')).toBeLessThan(page.indexOf('<TapeLeaderBoard'));
  });

  it('the follower record separates "not logged" from "could not be read"', () => {
    // Same digits, different facts. Showing an outage to somebody who simply has
    // not started reports a failure that is not happening.
    const record = code(SURFACES['components/copytrade/FollowerRecord.tsx']!);
    expect(record).toMatch(/loggedCount === 0/);
    expect(record).toMatch(/!readable/);
    // And 'unverifiable' has to reach the render, or it collapses into a failure.
    expect(record).toMatch(/'unverifiable'/);
  });
});

describe('the three refusals stay refused', () => {
  it('the board prints the return refusal rather than a profit column', () => {
    const board = code(SURFACES['components/copytrade/TapeLeaderBoard.tsx']!);
    expect(board).toContain('TAPE_RETURN_RANKING.reason');
    expect(board).toContain('TAPE_RETURN_RANKING.rankedInstead');
    expect(board).toContain('TAPE_SENDER_NOTICE');
    // No column header a reader would take for a return.
    expect(board).not.toMatch(/>\s*(PnL|P&L|Profit|ROI|Return|Gain)\s*</i);
  });

  it('nothing in the slice calls the sender a trader', () => {
    // GeckoTerminal returns the address that SENT the transaction. Calling it
    // the trader is a claim about a party this feed cannot identify.
    for (const [name, src] of Object.entries(SURFACES)) {
      expect(code(src), `${name} calls a sender "the trader"`).not.toMatch(/\bthe trader\b/i);
    }
  });

  it('every surface that offers a mirror states that nothing executes', () => {
    expect(SURFACES['pages/CopyTradingPage.tsx']).toContain('MIRROR_EXECUTION');
    expect(SURFACES['components/copytrade/FollowForm.tsx']).toContain('MIRROR_EXECUTION');
    expect(SURFACES['components/copytrade/MirrorQueue.tsx']).toContain('MIRROR_EXECUTION');
    // And no surface claims a keeper by another name.
    for (const [name, src] of Object.entries(SURFACES)) {
      expect(code(src), `${name} implies automatic execution`).not.toMatch(
        /\bauto[- ]?(trade|execute|mirror|copy)\b/i,
      );
    }
  });

  it('the queue renders refusals rather than filtering them out', () => {
    const queue = code(SURFACES['components/copytrade/MirrorQueue.tsx']!);
    expect(queue).toContain('MIRROR_REFUSAL_TEXT');
    expect(queue).toContain('TAPE_MIRROR_REFUSAL_TEXT');
    expect(queue).toMatch(/candidates\.map\(/);
  });

  it('the only follower-relative number comes from the reader s own fills', () => {
    const record = code(SURFACES['components/copytrade/FollowerRecord.tsx']!);
    expect(record).toContain('FOLLOWER_RETURN_UNMEASURABLE');
    expect(record).toContain('MATCH_BASIS');
    expect(record).toContain('TAPE_MATCH_LIMIT');
  });
});

describe('the pill input', () => {
  it('is true exactly while an island pool is registered to read', () => {
    // The pill itself lives in the shared navConfig; this pins the predicate the
    // shared edit will call, so a future registry with no markets fails loudly
    // here rather than shipping a live pill over a page with nothing to read.
    expect(islandPools().length).toBeGreaterThan(0);
    expect(hasCopyTapeSource()).toBe(true);
  });

  it('reads pools on all three island chains, so the label is not Ethereum-only', () => {
    const networks = new Set(islandPools().map((p) => p.network));
    expect([...networks].sort()).toEqual(['base', 'eth', 'solana']);
  });
});

describe('touch targets', () => {
  it.each([
    'components/copytrade/TapeLeaderBoard.tsx',
    'components/copytrade/TapeReadLedger.tsx',
    'components/copytrade/MirrorQueue.tsx',
    'components/copytrade/FollowForm.tsx',
    'components/copytrade/FollowerRecord.tsx',
  ])('%s gives every button a 44px target', (name) => {
    const src = SURFACES[name]!;
    const starts = [...src.matchAll(/<button\b/g)].map((m) => m.index!);
    expect(starts.length).toBeGreaterThan(0);
    for (const i of starts) {
      expect(src.slice(i, src.indexOf('</button', i)), `${name} button at ${i}`).toContain('min-h-11');
    }
  });
});
