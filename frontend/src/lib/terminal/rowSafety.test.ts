// THE ONE THING THIS PAGE MUST NEVER DO, pinned.
//
// A terminal row has two ways to carry no red mark, and they are opposite facts:
// it was read and nothing was found, or it could not be read. On a page built
// for fast decisions the second one wearing the first one's colour is not a
// cosmetic bug — it is an outage promoted to a buy signal.
//
// Every test below is a variant of the same assertion, applied to each surface
// where the two could be confused: the badge's colour, the "safe" filter, and
// the sort order in both directions.

import { describe, it, expect } from 'vitest';
import {
  SAFETY_NOT_REQUESTED,
  assessRowSafety,
  compareBySafety,
  componentRead,
  componentUnread,
  deployerReadFrom,
  distributionReadFrom,
  isKnownSafe,
  passesSafetyFilter,
  safetyBadge,
  buyAcknowledgement,
  safetyRank,
  sortBySafety,
  type ComponentRead,
  type DeployerRead,
  type DistributionRead,
  type HeatRead,
  type RowSafety,
  type SafetyFilter,
} from './rowSafety';
import type { DeployerReputation } from '../detection/deployerReputation';
import type { DistributionAnalysis } from '../detection';

const HEAT_UNREAD: ComponentRead<HeatRead> = componentUnread('no heat');
const HEAT_READ: ComponentRead<HeatRead> = componentRead({ tier: 'Resident', degrees: 12, isCold: false });

function dist(over: Partial<DistributionRead> = {}): ComponentRead<DistributionRead> {
  return componentRead({
    band: 'well-distributed',
    confidence: 'high',
    firedGateIds: [],
    ...over,
  });
}

function dep(over: Partial<DeployerRead> = {}): ComponentRead<DeployerRead> {
  return componentRead({
    created: 4,
    noMarket: 0,
    unobserved: 0,
    confidence: 'medium',
    ...over,
  });
}

const CLEAN = assessRowSafety({ distribution: dist(), deployer: dep(), heat: HEAT_READ });

describe('a row that could not be read is not a clean row', () => {
  it('is unscored when the holder read did not come back, and says why', () => {
    const safety = assessRowSafety({
      distribution: componentUnread('The holder read did not complete.'),
      deployer: dep(),
      heat: HEAT_READ,
    });
    expect(safety.kind).toBe('unscored');
    expect(safety.kind === 'unscored' && safety.missing).toEqual(['distribution']);
    expect(safety.kind === 'unscored' && safety.reasons).toEqual(['The holder read did not complete.']);
    expect(isKnownSafe(safety)).toBe(false);
  });

  it('is unscored when the deployer read did not come back', () => {
    const safety = assessRowSafety({
      distribution: dist(),
      deployer: componentUnread('no creator lookup'),
      heat: HEAT_READ,
    });
    expect(safety.kind).toBe('unscored');
    expect(isKnownSafe(safety)).toBe(false);
  });

  it('names BOTH missing components rather than stopping at the first', () => {
    const safety = assessRowSafety({
      distribution: componentUnread('a'),
      deployer: componentUnread('b'),
      heat: HEAT_UNREAD,
    });
    expect(safety.kind === 'unscored' && safety.missing).toEqual(['distribution', 'deployer']);
    expect(safety.kind === 'unscored' && safety.reasons).toEqual(['a', 'b']);
  });

  it('starts every row unscored, never presumed fine', () => {
    expect(SAFETY_NOT_REQUESTED.kind).toBe('unscored');
    expect(isKnownSafe(SAFETY_NOT_REQUESTED)).toBe(false);
    expect(safetyRank(SAFETY_NOT_REQUESTED)).toBeNull();
    expect(safetyBadge(SAFETY_NOT_REQUESTED).tone).toBe('unknown');
  });
});

describe('a heat outage never unrates a row, and heat never rates one', () => {
  // The two halves of HEAT_IS_NOT_A_RISK_SIGNAL. If either broke, the honest
  // failure would be invisible: rows would quietly stop being ratable, or a
  // tenured wallet would start earning green for its deployments.
  it('scores identically whether heat was read or not', () => {
    const withHeat = assessRowSafety({ distribution: dist(), deployer: dep(), heat: HEAT_READ });
    const without = assessRowSafety({ distribution: dist(), deployer: dep(), heat: HEAT_UNREAD });
    expect(safetyRank(withHeat)).toBe(safetyRank(without));
    expect(isKnownSafe(withHeat)).toBe(isKnownSafe(without));
    expect(safetyBadge(withHeat).tone).toBe(safetyBadge(without).tone);
  });

  it('carries the heat read through for display without folding it in', () => {
    const safety = assessRowSafety({ distribution: dist(), deployer: dep(), heat: HEAT_READ });
    expect(safety.heat).toEqual(HEAT_READ);
  });

  it('a cold wallet does not make a fully-read row anything but clean', () => {
    const cold = componentRead<HeatRead>({ tier: 'Drifter', degrees: 0, isCold: true });
    const safety = assessRowSafety({ distribution: dist(), deployer: dep(), heat: cold });
    expect(isKnownSafe(safety)).toBe(true);
  });
});

describe('low confidence removes a row from the axis rather than colouring it', () => {
  it('a low-confidence holder read cannot be known-safe', () => {
    const safety = assessRowSafety({
      distribution: dist({ confidence: 'low' }),
      deployer: dep(),
      heat: HEAT_READ,
    });
    expect(safety.kind).toBe('scored');
    expect(safety.kind === 'scored' && safety.coverage).toBe('partial');
    expect(isKnownSafe(safety)).toBe(false);
    expect(safetyRank(safety)).toBeNull();
    expect(safetyBadge(safety).tone).toBe('unknown');
  });

  it('a low-confidence deployer read does the same', () => {
    const safety = assessRowSafety({
      distribution: dist(),
      deployer: dep({ confidence: 'low' }),
      heat: HEAT_READ,
    });
    expect(isKnownSafe(safety)).toBe(false);
    expect(safetyRank(safety)).toBeNull();
  });

  it('an unreadable slice of the deployer history is a gap, not a clean result', () => {
    const safety = assessRowSafety({
      distribution: dist(),
      deployer: dep({ created: 4, unobserved: 2 }),
      heat: HEAT_READ,
    });
    expect(safety.kind === 'scored' && safety.coverage).toBe('partial');
    expect(safety.kind === 'scored' && safety.gaps.join(' ')).toMatch(/gaps, not clean results/);
    expect(isKnownSafe(safety)).toBe(false);
  });

  it('the partly-unread badge says nothing about the token', () => {
    const badge = safetyBadge(
      assessRowSafety({ distribution: dist({ confidence: 'low' }), deployer: dep(), heat: HEAT_READ }),
    );
    expect(badge.label).toBe('Partly unread');
    expect(badge.detail).not.toMatch(/nothing (was )?found/i);
    expect(badge.detail).not.toMatch(/clean/i);
  });
});

describe('a gap can add risk but never subtract it', () => {
  it('keeps an observed high risk at high risk when the read was incomplete', () => {
    const safety = assessRowSafety({
      distribution: dist({ band: 'concentrated', confidence: 'low' }),
      deployer: dep(),
      heat: HEAT_READ,
    });
    const badge = safetyBadge(safety);
    expect(badge.tone).toBe('bad');
    expect(badge.label).toBe('High risk (partly unread)');
    // Still off the axis: the finding is real, but the row's POSITION is not known.
    expect(safetyRank(safety)).toBeNull();
  });

  it('escalates a fired hard-fact gate to at least caution', () => {
    const safety = assessRowSafety({
      distribution: dist({ band: 'well-distributed', firedGateIds: ['mint-authority-live'] }),
      deployer: dep(),
      heat: HEAT_READ,
    });
    expect(safety.kind === 'scored' && safety.observed).toBe('caution');
    expect(isKnownSafe(safety)).toBe(false);
    expect(safety.kind === 'scored' && safety.flags[0].note).toMatch(/mint authority is still live/i);
  });

  it('caps deployer history at caution — it never becomes a rug verdict', () => {
    const safety = assessRowSafety({
      distribution: dist(),
      deployer: dep({ created: 5, noMarket: 5 }),
      heat: HEAT_READ,
    });
    expect(safety.kind === 'scored' && safety.observed).toBe('caution');
    const note = safety.kind === 'scored' ? safety.flags.map((f) => f.note).join(' ') : '';
    expect(note).toMatch(/not evidence of a rug/i);
  });
});

describe('green is exactly the predicate the filter uses', () => {
  const MATRIX: RowSafety[] = [
    CLEAN,
    assessRowSafety({ distribution: dist({ band: 'mixed' }), deployer: dep(), heat: HEAT_READ }),
    assessRowSafety({ distribution: dist({ band: 'concentrated' }), deployer: dep(), heat: HEAT_READ }),
    assessRowSafety({ distribution: dist({ confidence: 'low' }), deployer: dep(), heat: HEAT_READ }),
    assessRowSafety({ distribution: dist({ band: 'mixed', confidence: 'low' }), deployer: dep(), heat: HEAT_READ }),
    assessRowSafety({ distribution: dist(), deployer: dep({ noMarket: 1 }), heat: HEAT_READ }),
    assessRowSafety({ distribution: dist(), deployer: dep({ unobserved: 1 }), heat: HEAT_READ }),
    assessRowSafety({ distribution: componentUnread('x'), deployer: dep(), heat: HEAT_READ }),
    assessRowSafety({ distribution: dist(), deployer: componentUnread('y'), heat: HEAT_UNREAD }),
    SAFETY_NOT_REQUESTED,
  ];

  it('tone "good" if and only if isKnownSafe', () => {
    for (const safety of MATRIX) {
      expect(
        safetyBadge(safety).tone === 'good',
        `badge tone and isKnownSafe disagree for ${JSON.stringify(safety)}`,
      ).toBe(isKnownSafe(safety));
    }
    // Guard the guard: the matrix must contain at least one of each.
    expect(MATRIX.some(isKnownSafe)).toBe(true);
    expect(MATRIX.some((s) => !isKnownSafe(s))).toBe(true);
  });

  it('the "fully read" filter admits only known-safe rows', () => {
    for (const safety of MATRIX) {
      expect(passesSafetyFilter(safety, 'known-safe')).toBe(isKnownSafe(safety));
    }
  });

  it('every row survives the "all" filter, and unrated rows are their own bucket', () => {
    for (const safety of MATRIX) {
      expect(passesSafetyFilter(safety, 'all')).toBe(true);
      expect(passesSafetyFilter(safety, 'unrated')).toBe(safetyRank(safety) === null);
    }
  });

  it('no filter silently drops every row it does not understand', () => {
    const filters: SafetyFilter[] = ['all', 'known-safe', 'unrated'];
    for (const f of filters) {
      expect(MATRIX.some((s) => passesSafetyFilter(s, f)), `filter ${f} matched nothing`).toBe(true);
    }
  });
});

describe('an unread row never takes a position on the axis', () => {
  const caution = assessRowSafety({ distribution: dist({ band: 'mixed' }), deployer: dep(), heat: HEAT_READ });
  const risky = assessRowSafety({ distribution: dist({ band: 'concentrated' }), deployer: dep(), heat: HEAT_READ });
  const unscored = assessRowSafety({ distribution: componentUnread('x'), deployer: dep(), heat: HEAT_UNREAD });
  const partial = assessRowSafety({ distribution: dist({ confidence: 'low' }), deployer: dep(), heat: HEAT_READ });

  it('ranks only fully-read rows', () => {
    expect(safetyRank(CLEAN)).toBe(0);
    expect(safetyRank(caution)).toBe(1);
    expect(safetyRank(risky)).toBe(2);
    expect(safetyRank(unscored)).toBeNull();
    expect(safetyRank(partial)).toBeNull();
  });

  it('sorts unread rows LAST under safest-first — never above a measured clean row', () => {
    const rows = [unscored, risky, partial, CLEAN, caution];
    const sorted = sortBySafety(rows, (r) => r, 'safest-first');
    expect(sorted.slice(0, 3)).toEqual([CLEAN, caution, risky]);
    expect(sorted.slice(3)).toEqual([partial, unscored]);
  });

  it('sorts unread rows LAST under riskiest-first too — they are not measured risk either', () => {
    const rows = [unscored, CLEAN, partial, risky, caution];
    const sorted = sortBySafety(rows, (r) => r, 'riskiest-first');
    expect(sorted.slice(0, 3)).toEqual([risky, caution, CLEAN]);
    expect(sorted.slice(3)).toEqual([partial, unscored]);
  });

  it('never places an unrated row before a rated one, in either direction', () => {
    for (const direction of ['safest-first', 'riskiest-first'] as const) {
      for (const rated of [CLEAN, caution, risky]) {
        for (const unrated of [unscored, partial, SAFETY_NOT_REQUESTED]) {
          expect(compareBySafety(unrated, rated, direction)).toBeGreaterThan(0);
          expect(compareBySafety(rated, unrated, direction)).toBeLessThan(0);
        }
      }
    }
  });

  it('orders the unrated block worst-observed first, so a real finding is not buried', () => {
    // A partly-read row that showed HIGH RISK is unrated — its position on the
    // axis is unknown — but the finding is real, and it must not end up below
    // rows that were merely never looked at.
    const partialRisky = assessRowSafety({
      distribution: dist({ band: 'concentrated', confidence: 'low' }),
      deployer: dep(),
      heat: HEAT_READ,
    });
    const partialCaution = assessRowSafety({
      distribution: dist({ band: 'mixed', confidence: 'low' }),
      deployer: dep(),
      heat: HEAT_READ,
    });
    for (const direction of ['safest-first', 'riskiest-first'] as const) {
      const sorted = sortBySafety(
        [unscored, partial, partialCaution, partialRisky],
        (r) => r,
        direction,
      );
      expect(sorted).toEqual([partialRisky, partialCaution, partial, unscored]);
    }
  });

  it('the unrated ordering still cannot promote an unrated row past a rated one', () => {
    const partialRisky = assessRowSafety({
      distribution: dist({ band: 'concentrated', confidence: 'low' }),
      deployer: dep(),
      heat: HEAT_READ,
    });
    for (const direction of ['safest-first', 'riskiest-first'] as const) {
      const sorted = sortBySafety([partialRisky, CLEAN], (r) => r, direction);
      expect(sorted[0]).toBe(CLEAN);
    }
  });

  it('is stable, so equal rows keep feed order', () => {
    const a = { id: 'a', s: CLEAN };
    const b = { id: 'b', s: CLEAN };
    expect(sortBySafety([a, b], (r) => r.s, 'safest-first').map((r) => r.id)).toEqual(['a', 'b']);
    expect(sortBySafety([b, a], (r) => r.s, 'safest-first').map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input list', () => {
    const rows = [risky, CLEAN];
    sortBySafety(rows, (r) => r, 'safest-first');
    expect(rows).toEqual([risky, CLEAN]);
  });
});

describe('adapters from the upstream cores', () => {
  function analysis(over: Partial<DistributionAnalysis> = {}): DistributionAnalysis {
    return {
      band: 'well-distributed',
      confidence: { level: 'high', reasons: [] },
      gate: {
        floor: 'well-distributed',
        findings: [
          { id: 'mint-authority-live', fired: true, forcedBand: 'concentrated', detail: 'd' },
          { id: 'lp-unlocked', fired: false, forcedBand: 'mixed', detail: 'd' },
        ],
      },
      ...over,
    } as DistributionAnalysis;
  }

  it('takes only the FIRED gates, so an evaluated-and-clear check never reads as a flag', () => {
    const read = distributionReadFrom(analysis());
    expect(read.state).toBe('read');
    expect(read.state === 'read' && read.value.firedGateIds).toEqual(['mint-authority-live']);
  });

  /**
   * A COMPLETE `DeployerReputation`. This used to be a two-field object with
   * `as DeployerReputation` welded on: nine required fields were missing, so the
   * fixture claimed a shape the production type never produces. It happened to
   * work only because `deployerReadFrom` reads `counts` and `confidence` and
   * nothing else today — the first time it reads `observedAt` or `trajectories`
   * the fixture hands it `undefined` and the test still goes green.
   */
  function reputation(counts: Partial<DeployerReputation['counts']>): DeployerReputation {
    return {
      method: { version: 'test', description: 'fixture' },
      deployer: '0x00000000000000000000000000000000000000de',
      observedAt: 1_800_000_000,
      counts: { created: 0, activeMarket: 0, thinMarket: 0, noMarket: 0, unobserved: 0, ...counts },
      latestCreationAt: null,
      lastActivityAt: null,
      trajectories: [],
      confidence: { level: 'medium', reasons: [] },
      headline: '',
      disclosures: [],
      correctionPath: '',
    };
  }

  it('maps "no direct creations found" to UNREAD, never to a spotless record', () => {
    const read = deployerReadFrom(reputation({ created: 0 }));
    expect(read.state).toBe('unread');
    expect(read.state === 'unread' && read.reason).toMatch(/factory/i);
    // And therefore a token from a factory launcher can never be green by default.
    const safety = assessRowSafety({ distribution: dist(), deployer: read, heat: HEAT_READ });
    expect(isKnownSafe(safety)).toBe(false);
  });

  it('maps an all-unobserved history to UNREAD', () => {
    const read = deployerReadFrom(reputation({ created: 3, unobserved: 3 }));
    expect(read.state).toBe('unread');
  });

  it('maps a partially-observed history to READ, carrying the gap forward', () => {
    const read = deployerReadFrom(reputation({ created: 3, unobserved: 1, noMarket: 1 }));
    expect(read.state).toBe('read');
    expect(read.state === 'read' && read.value.unobserved).toBe(1);
  });
});

// ─── The asymmetry: a gap may raise observed risk, never erase a finding ─────
//
// ADDED 2026-09-02, and it is not a refinement — it closes a hole that was
// swallowing real findings on every row of the live feed.
//
// Before this, ANY unread scoring component returned `unscored`, which threw
// away a concentrated holder band or a live mint authority that the holder read
// HAD produced. On this build the deployer component is unread for every token
// on every chain (there is no contract-creator lookup), so "Not scored" was
// being printed over tokens whose entire supply sits in one wallet.
//
// The direction matters and is pinned both ways below: a FINDING survives a gap,
// a CLEAN read does not.

describe('a holder finding survives an unread deployer', () => {
  const DEPLOYER_GAP = 'no creator lookup on this build';

  function partly(over: Partial<DistributionRead> = {}) {
    return assessRowSafety({
      distribution: dist(over),
      deployer: componentUnread(DEPLOYER_GAP),
      heat: HEAT_UNREAD,
    });
  }

  it('a concentrated band with an unread deployer is stated, at partial coverage', () => {
    // FAILS on the pre-change module, which returned kind 'unscored' here.
    const safety = partly({ band: 'concentrated' });
    expect(safety.kind).toBe('scored');
    expect(safety.kind === 'scored' && safety.coverage).toBe('partial');
    expect(safety.kind === 'scored' && safety.observed).toBe('high-risk');
  });

  it('a fired hard-fact gate with an unread deployer is stated too', () => {
    const safety = partly({ band: 'well-distributed', firedGateIds: ['mint-authority-live'] });
    expect(safety.kind).toBe('scored');
    expect(safety.kind === 'scored' && safety.observed).toBe('caution');
    // The gate's own words travel with it, or the badge says "caution" about
    // nothing a reader can act on.
    expect(safety.kind === 'scored' && safety.flags.map((f) => f.note).join(' ')).toMatch(
      /mint authority is still live/i,
    );
  });

  it('carries the deployer gap forward as a GAP, so the badge says "(partly unread)"', () => {
    const safety = partly({ band: 'concentrated' });
    expect(safety.kind === 'scored' && safety.gaps).toContain(DEPLOYER_GAP);
    const badge = safetyBadge(safety);
    expect(badge.label).toBe('High risk (partly unread)');
    expect(badge.tone).toBe('bad');
    expect(badge.detail).toContain(DEPLOYER_GAP);
  });

  it('carries BOTH the deployer gap and the low-confidence holder gap', () => {
    // The mutation this catches: a branch that pushes only `deployer.reason` and
    // forgets that the holder read it is quoting was itself weak.
    const safety = partly({ band: 'concentrated', confidence: 'low' });
    expect(safety.kind === 'scored' && safety.gaps).toHaveLength(2);
    expect(safety.kind === 'scored' && safety.gaps.join(' ')).toContain(DEPLOYER_GAP);
    expect(safety.kind === 'scored' && safety.gaps.join(' ')).toMatch(/low data confidence/i);
  });

  it('is STILL off the safety axis — it may warn, it may never reassure', () => {
    const safety = partly({ band: 'concentrated' });
    expect(isKnownSafe(safety)).toBe(false);
    expect(safetyRank(safety)).toBeNull();
    expect(passesSafetyFilter(safety, 'known-safe')).toBe(false);
    expect(passesSafetyFilter(safety, 'unrated')).toBe(true);
    // Unranked under BOTH directions, which is the rule the whole page rests on.
    for (const direction of ['safest-first', 'riskiest-first'] as const) {
      expect(compareBySafety(safety, CLEAN, direction)).toBe(1);
      expect(compareBySafety(CLEAN, safety, direction)).toBe(-1);
    }
  });

  it('a CLEAN holder read with an unread deployer stays unscored — nothing positive from half a read', () => {
    const safety = partly({ band: 'well-distributed' });
    expect(safety.kind).toBe('unscored');
    expect(safety.kind === 'unscored' && safety.missing).toEqual(['deployer']);
  });

  it('an unread HOLDER read is unscored regardless, because there is no finding to state', () => {
    const safety = assessRowSafety({
      distribution: componentUnread('holder source unavailable'),
      deployer: dep({ noMarket: 2 }),
      heat: HEAT_UNREAD,
    });
    expect(safety.kind).toBe('unscored');
  });

  it('EXHAUSTIVE: no band x gate x deployer-unread combination yields scored+partial+clean', () => {
    // The leak the new branch could have introduced: a row that says "clean" out
    // loud while admitting it is partly unread. A caller reading `observed`
    // directly would see 'clean' on a row nobody finished reading. It must
    // simply not exist.
    const bands = ['well-distributed', 'mixed', 'concentrated'] as const;
    const gateSets = [[], ['mint-authority-live'], ['lp-unlocked', 'top1-share']];
    const confidences = ['high', 'medium', 'low'] as const;

    let sawScored = false;
    for (const band of bands) {
      for (const firedGateIds of gateSets) {
        for (const confidence of confidences) {
          const safety = assessRowSafety({
            distribution: dist({ band, firedGateIds, confidence }),
            deployer: componentUnread(DEPLOYER_GAP),
            heat: HEAT_UNREAD,
          });
          if (safety.kind === 'scored') {
            sawScored = true;
            expect(safety.observed).not.toBe('clean');
            expect(safety.coverage).toBe('partial');
            expect(isKnownSafe(safety)).toBe(false);
          }
        }
      }
    }
    // Guards the guard: a loop that never enters the branch proves nothing.
    expect(sawScored).toBe(true);
  });
});

describe('the buy acknowledgement cannot contradict the badge beside it', () => {
  it('a high-risk partly-read row is asked about its FINDINGS, not about having none', () => {
    // FAILS on the pre-change component, whose branch order tested
    // `coverage === 'partial'` first and so asked a trader to affirm that a row
    // wearing a red badge "carries no safety result".
    const safety = assessRowSafety({
      distribution: dist({ band: 'concentrated' }),
      deployer: componentUnread('no creator lookup'),
      heat: HEAT_UNREAD,
    });
    const text = buyAcknowledgement(safety);
    expect(text).toMatch(/showed findings/i);
    expect(text).not.toMatch(/carries no safety result/i);
    // And it agrees with the badge the trader is looking at.
    expect(safetyBadge(safety).tone).toBe('bad');
  });

  it('an unscored row is asked about the absence of any measurement', () => {
    expect(buyAcknowledgement(SAFETY_NOT_REQUESTED)).toMatch(
      /nothing about this token has been measured/i,
    );
  });

  it('a complete read with findings uses the same findings sentence', () => {
    const safety = assessRowSafety({
      distribution: dist({ band: 'concentrated' }),
      deployer: dep(),
      heat: HEAT_UNREAD,
    });
    expect(safety.kind === 'scored' && safety.coverage).toBe('complete');
    expect(buyAcknowledgement(safety)).toMatch(/showed findings/i);
  });

  it('the one genuinely wordless state — clean but too weak to stand behind — keeps its own sentence', () => {
    // This state IS reachable: both components read, holder confidence low. The
    // branch is not dead code, so it is pinned rather than deleted.
    const safety = assessRowSafety({
      distribution: dist({ band: 'well-distributed', confidence: 'low' }),
      deployer: dep(),
      heat: HEAT_UNREAD,
    });
    expect(safety.kind === 'scored' && safety.coverage).toBe('partial');
    expect(safety.kind === 'scored' && safety.observed).toBe('clean');
    expect(buyAcknowledgement(safety)).toMatch(/carries no safety result/i);
    expect(safetyBadge(safety).tone).toBe('unknown');
  });
});
