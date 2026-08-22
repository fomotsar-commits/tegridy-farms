// HONESTY GUARD — the copy-trading and competition surfaces cannot quietly grow
// the two claims they exist to refuse.
//
// Both features are read-only views over an indexer that is hosted nowhere, and
// both are the kind of surface whose failure mode is flattering rather than
// broken:
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

  it('the competition page renders the table only from a non-null standings object', () => {
    const page = code(SURFACES['pages/CompetitionsPage.tsx']!);
    expect(page).toMatch(/standings\.standings \? \(/);
    expect(page).toContain('<CompetitionDataNotice');
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

describe('nothing in the slice reaches a server or holds a key', () => {
  it('no surface here fetches, and none names a credential', () => {
    // NON-CUSTODIAL. The follow list and the mirror log live in this browser; a
    // fetch appearing in this slice is either a second data path around the
    // honesty-gated indexer client or an exfiltration of the user's follow list.
    for (const [name, src] of Object.entries(SURFACES)) {
      const body = code(src);
      expect(body, `${name} calls fetch directly`).not.toMatch(/\bfetch\s*\(/);
      expect(body, `${name} names key material`).not.toMatch(
        /privateKey|mnemonic|seedPhrase|\bsignMessage\b/i,
      );
    }
  });
});

describe('the nav entries describe what the pages can actually do', () => {
  it('pills both while there is no indexer to read', () => {
    // Asserted as a concrete value with its precondition pinned first, so a
    // configured indexer in some future environment fails the precondition
    // loudly instead of silently inverting the expectation.
    expect(isIndexerConfigured(), 'no indexer should be configured in tests').toBe(false);
    for (const path of ['/copy-trading', '/competitions']) {
      const entry = ALL_NAV.find((n) => n.to === path);
      expect(entry, `${path} missing from nav`).toBeTruthy();
      expect(entry?.soon, `${path} cannot do what it names without an indexer`).toBe(true);
    }
  });
});
