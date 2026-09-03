// HONESTY GUARD — the copy-trading and competition surfaces cannot quietly grow
// the two claims they exist to refuse.
//
// Both features are read-only views over a third-party trade feed — the island
// tape, plus the venue's own indexer where one is configured — and both are the
// kind of surface whose failure mode is flattering rather than broken:
//
//   an unread board       → "nobody is trading", about every wallet at once
//   an unread season      → "nobody entered", about every competitor at once
//   an unread fill history → "none of your mirrors worked"
//   a leader's own return  → a promise made to someone who will not receive it
//
// The libraries refuse all four and their own tests pin that. What THIS file
// pins is the render layer, where a refusal is easiest to undo by accident: a
// table drawn outside its status branch, a `?? 0` where an unknown belongs, or a
// profit column reintroduced because it is what a leaderboard "should" have.
//
// Prose may be rewritten freely. Draw a table in a dark state, coerce a read to
// zero, or print a return, and this goes red.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAV } from '../lib/navConfig';
import { isIndexerConfigured } from '../lib/indexer/client';
import { islandPools } from '../lib/copytrade/tape';
import { cupPools } from '../lib/competitions/islandCup';

const SRC = join(process.cwd(), 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const SURFACES: Record<string, string> = {
  'pages/CopyTradingPage.tsx': read('pages', 'CopyTradingPage.tsx'),
  'pages/CompetitionsPage.tsx': read('pages', 'CompetitionsPage.tsx'),
  'components/copytrade/LeaderBoard.tsx': read('components', 'copytrade', 'LeaderBoard.tsx'),
  'components/copytrade/MirrorQueue.tsx': read('components', 'copytrade', 'MirrorQueue.tsx'),
  'components/copytrade/FollowerRecord.tsx': read('components', 'copytrade', 'FollowerRecord.tsx'),
  'components/copytrade/FollowForm.tsx': read('components', 'copytrade', 'FollowForm.tsx'),
  'components/competitions/StandingsTable.tsx': read('components', 'competitions', 'StandingsTable.tsx'),
  'components/competitions/ScoringRules.tsx': read('components', 'competitions', 'ScoringRules.tsx'),
  // The two notices and the amount formatter are the slice's remaining render
  // path. They carry no table, which is exactly why they are easy to leave
  // unpinned — and the formatter is where a mis-stated quantity would appear
  // wearing a correct-looking unit.
  'components/copytrade/CopyDataNotice.tsx': read('components', 'copytrade', 'CopyDataNotice.tsx'),
  'components/competitions/CompetitionDataNotice.tsx': read('components', 'competitions', 'CompetitionDataNotice.tsx'),
  'lib/copytrade/quoteTokens.ts': read('lib', 'copytrade', 'quoteTokens.ts'),
  'hooks/useCopyLeaderboard.ts': read('hooks', 'useCopyLeaderboard.ts'),
  'hooks/useCopySignals.ts': read('hooks', 'useCopySignals.ts'),
  'hooks/useCopyFollowerFills.ts': read('hooks', 'useCopyFollowerFills.ts'),
  'hooks/useCompetitionStandings.ts': read('hooks', 'useCompetitionStandings.ts'),
  // The Island Cup's render layer. lib/competitions/islandCupSource.ts and
  // lib/geckoTerminal/poolTrades.ts are deliberately NOT here: they are the I/O, and
  // `fetch(` is exactly what the second one is for. The describe below pins that
  // arrangement rather than leaving it to this list's silence.
  'hooks/useIslandCup.ts': read('hooks', 'useIslandCup.ts'),
  'components/competitions/CupBoard.tsx': read('components', 'competitions', 'CupBoard.tsx'),
  'components/competitions/CupCoverageNotice.tsx': read('components', 'competitions', 'CupCoverageNotice.tsx'),
  'components/competitions/SeasonCard.tsx': read('components', 'competitions', 'SeasonCard.tsx'),
  'components/competitions/YourRank.tsx': read('components', 'competitions', 'YourRank.tsx'),
  'components/competitions/ShareCard.tsx': read('components', 'competitions', 'ShareCard.tsx'),
  // The copy page's tape render layer is guarded in full by CopyTradingPage.tape.test.ts,
  // which applies these same rules plus a stricter fetch pin, so it is not duplicated
  // here. queueRows.ts is the one exception: the copy page imports it and that file lists
  // it nowhere, so a numeric fallback in the row builder would have had no guard at all.
  'components/copytrade/queueRows.ts': read('components', 'copytrade', 'queueRows.ts'),
};

/** Strip comments — the notes discuss `?? 0` and the word "profit" on purpose. */
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

describe('no table is drawn in a state that could not read one', () => {
  it('the copy page mounts each panel behind its own read state', () => {
    const page = code(SURFACES['pages/CopyTradingPage.tsx']!);
    // The mirror queue is gated on the signal read specifically — a queue drawn
    // from an unavailable feed is an empty list of opportunities that reads as a
    // quiet leader.
    expect(page).toMatch(/signals\.status === 'ready' \|\| signals\.status === 'backfilling'/);
    // The board renders only from a non-null board object, which the hook leaves
    // null in every state but ready/backfilling.
    expect(page).toMatch(/board\.board \? \(/);
    // Every panel is preceded by a notice that names what could not be read.
    expect(page.match(/<CopyDataNotice/g) ?? []).toHaveLength(3);
  });

  it('the competition page renders each table only from a non-null board', () => {
    const page = code(SURFACES['pages/CompetitionsPage.tsx']!);
    expect(page).toMatch(/standings\.standings \? \(/);
    expect(page).toContain('<CompetitionDataNotice');
    // The cup's own table, behind the same kind of gate. `board` is null in every
    // hook state but complete/partial, so an outage cannot draw a leaderboard.
    expect(page).toMatch(/cup\.board \? \(/);
    expect(page).toContain('<CupCoverageNotice');
    // No clock is read on this page any more. The old status line derived
    // "Counting now. Every figure moves as new swaps are indexed." from Date.now()
    // alone — a confident sentence about a process that was not running.
    expect(page).not.toContain('Date.now');
    expect(page).not.toContain('as new swaps are indexed');
    // The page composes; it does not read. A `Source` module or the shared trades
    // fetcher imported here would be a second data path around the hook's gates.
    expect(page).not.toMatch(/from '[^']*Source'/);
    expect(page).not.toMatch(/geckoTerminal\/poolTrades/);
  });

  it('the follower record separates "not logged" from "could not be read"', () => {
    // Same digits, different facts. Showing an outage to somebody who simply has
    // not started reports a failure that is not happening.
    const record = code(SURFACES['components/copytrade/FollowerRecord.tsx']!);
    expect(record).toMatch(/loggedCount === 0/);
    expect(record).toMatch(/!readable/);
  });
});

describe('the two refused claims stay refused', () => {
  it('the board prints the return refusal rather than a profit column', () => {
    const board = code(SURFACES['components/copytrade/LeaderBoard.tsx']!);
    expect(board).toContain('RETURN_RANKING.reason');
    expect(board).toContain('RETURN_RANKING.rankedInstead');
    // No column header a reader would take for a return.
    expect(board).not.toMatch(/>\s*(PnL|P&L|Profit|ROI|Return|Gain)\s*</i);
  });

  it('the cup board prints no profit column and no ticking timestamp', () => {
    // A trade feed gives ONE leg of a trade, so a return exists for nobody here —
    // the same refusal as PNL_SCORING, for a different reason. And "Last fill" is
    // the fill's own UTC time: a relative phrase would keep ageing after the data
    // stopped, on a page whose whole claim is the window the feed served.
    const board = code(SURFACES['components/competitions/CupBoard.tsx']!);
    expect(board).not.toMatch(/>\s*(PnL|P&L|Profit|ROI|Return|Gain)\s*</i);
    expect(board).not.toContain('formatTimeAgo');
    expect(board).not.toContain('Date.now');
  });

  it('the standings table prints no profit column either', () => {
    const table = code(SURFACES['components/competitions/StandingsTable.tsx']!);
    expect(table).not.toMatch(/>\s*(PnL|P&L|Profit|ROI|Return|Gain)\s*</i);
    expect(table).toContain('TRUNCATED_NOTICE');
  });

  it('the copy page and the follow form both state that nothing executes', () => {
    // The venue runs no keeper. "Follow" is a word that implies an automaton and
    // the correction has to arrive before the click, not in a footnote.
    expect(SURFACES['pages/CopyTradingPage.tsx']).toContain('MIRROR_EXECUTION');
    expect(SURFACES['components/copytrade/FollowForm.tsx']).toContain('MIRROR_EXECUTION');
    expect(SURFACES['components/copytrade/MirrorQueue.tsx']).toContain('MIRROR_EXECUTION');
  });

  it('the scoring panel states the resistance, its limits, and the absence of a prize', () => {
    const rules = SURFACES['components/competitions/ScoringRules.tsx']!;
    expect(rules).toContain('RESISTANCE_RULE');
    expect(rules).toContain('RESISTANCE_LIMITS');
    expect(rules).toContain('PNL_SCORING');
    expect(rules).toContain('SETTLEMENT');
  });

  it('the queue renders refusals rather than filtering them out', () => {
    const queue = code(SURFACES['components/copytrade/MirrorQueue.tsx']!);
    expect(queue).toContain('MIRROR_REFUSAL_TEXT');
    // The list is mapped over every candidate, not over a filtered subset.
    expect(queue).toMatch(/candidates\.map\(/);
  });
});

describe('the render layer holds no key and opens no second data path', () => {
  it('no surface here fetches, and none names a credential', () => {
    // NON-CUSTODIAL. The follow list and the mirror log live in this browser; a
    // fetch appearing in this slice is either a second data path around the gates
    // these hooks apply, or an exfiltration of the user's follow list.
    //
    // This slice DOES reach a server now — both pages read GeckoTerminal's pool-trade
    // feed — but never from a file in this list. The reads happen in the I/O modules
    // below, which is why they are excluded from SURFACES rather than exempted here.
    for (const [name, src] of Object.entries(SURFACES)) {
      const body = code(src);
      expect(body, `${name} calls fetch directly`).not.toMatch(/\bfetch\s*\(/);
      expect(body, `${name} reaches for the global fetch`).not.toMatch(/(\?\?|=)\s*fetch\b/);
      expect(body, `${name} names key material`).not.toMatch(
        /privateKey|mnemonic|seedPhrase|\bsignMessage\b/i,
      );
    }
  });

  it('the cup reaches the network only through the one shared reader', () => {
    // A second fetch site is not a style problem: it is a second place for the CSP
    // to be wrong, a second cache, a second set of error branches, and a second
    // chance to turn an unread window into a confident empty board. The reader takes
    // an injected `fetchImpl` for tests (`opts.fetchImpl ?? fetch`), so what is
    // pinned is that IT names the global and that the cup's own source does not.
    const reader = code(readFileSync(join(SRC, 'lib', 'geckoTerminal', 'poolTrades.ts'), 'utf8'));
    expect(reader, 'the shared trade reader stopped fetching').toMatch(
      /(\?\?\s*fetch\b|\bfetch\s*\()/,
    );

    const cupSource = code(readFileSync(join(SRC, 'lib', 'competitions', 'islandCupSource.ts'), 'utf8'));
    expect(cupSource, 'the cup source opened its own fetch site').not.toMatch(/\bfetch\s*\(/);
    expect(cupSource, 'the cup source reaches for the global fetch').not.toMatch(/(\?\?|=)\s*fetch\b/);
  });
});

describe('the nav entries describe what the pages can actually do', () => {
  // REWRITTEN 2026-09-02. This used to assert that BOTH entries were pilled because
  // neither could read anything without VITE_INDEXER_URL. That stopped being true when
  // both pages moved onto the island tape — GeckoTerminal's trade feed for the resident
  // pools the registry already names, which needs no env var, no key and no proxy.
  //
  // The precondition is asserted FIRST and is the registry, not the indexer: if the
  // registry is ever emptied, THAT fails here by name instead of silently inverting the
  // pill expectations two lines down.
  it('does not pill either page: both read the island tape, which the registry supplies', () => {
    expect(
      islandPools().length,
      'no island pool is registered, so the tape has nothing to read and the pills are right to be on',
    ).toBeGreaterThan(0);
    expect(
      cupPools().length,
      'no cup pool is registered, so no board can be scored',
    ).toBeGreaterThan(0);

    for (const path of ['/copy-trading', '/competitions']) {
      const entry = ALL_NAV.find((n) => n.to === path);
      expect(entry, `${path} missing from nav`).toBeTruthy();
      expect(
        entry?.soon,
        `${path} reads the island tape, which needs no operator step — it must not read as SOON`,
      ).toBeFalsy();
    }
  });

  // The independence claim, which is the half that would rot silently. Neither pill may
  // track the unhosted indexer any more; /competitions may still USE one when present
  // (its predicate is an OR), but its absence must not pill the entry.
  it('neither pill tracks the indexer', () => {
    expect(isIndexerConfigured(), 'no indexer should be configured in tests').toBe(false);
    for (const path of ['/copy-trading', '/competitions']) {
      expect(ALL_NAV.find((n) => n.to === path)?.soon).toBeFalsy();
    }
  });
});
