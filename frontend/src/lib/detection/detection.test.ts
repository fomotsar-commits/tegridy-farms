import { describe, it, expect } from 'vitest';
import {
  ratio,
  computeHHI,
  effectiveHolders,
  topNShare,
  nakamotoCoefficient,
  giniCoefficient,
  normalizeHolders,
  classifyAddress,
  classifyHolders,
  worseBand,
  analyzeDistribution,
  type RawHolder,
  type LabelSource,
} from './index';

// ── helpers ──────────────────────────────────────────────────────────────────
function eqHolders(n: number, each: bigint = 1n): RawHolder[] {
  return Array.from({ length: n }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}`, balance: each }));
}

// ── pure math: HHI / N_eff (LEAD METRIC) ──────────────────────────────────────
describe('HHI / effectiveHolders (inverse-Simpson)', () => {
  it('HHI of 4 equal shares is 0.25 and N_eff is 4', () => {
    const hhi = computeHHI([0.25, 0.25, 0.25, 0.25]);
    expect(hhi).toBeCloseTo(0.25, 10);
    expect(effectiveHolders(hhi)).toBeCloseTo(4, 10);
  });
  it('single holder ⇒ HHI 1, N_eff 1', () => {
    expect(computeHHI([1])).toBe(1);
    expect(effectiveHolders(1)).toBe(1);
  });
  it('empty ⇒ HHI 0, N_eff 0 (no divide-by-zero)', () => {
    expect(computeHHI([])).toBe(0);
    expect(effectiveHolders(0)).toBe(0);
  });
});

// ── ratio: bigint fixed-point, no precision loss above 2^53 ────────────────────
describe('ratio', () => {
  it('computes simple fractions', () => {
    expect(ratio(1n, 4n)).toBeCloseTo(0.25, 12);
    expect(ratio(3n, 4n)).toBeCloseTo(0.75, 12);
  });
  it('clamps and guards', () => {
    expect(ratio(0n, 10n)).toBe(0);
    expect(ratio(10n, 0n)).toBe(0);
    expect(ratio(5n, 5n)).toBe(1);
  });
  it('keeps precision with 18-decimal balances beyond Number.MAX_SAFE_INTEGER', () => {
    const whole = 1_000_000n * 10n ** 18n;
    const part = whole / 4n;
    expect(ratio(part, whole)).toBeCloseTo(0.25, 10);
  });
});

// ── top-N ─────────────────────────────────────────────────────────────────────
describe('topNShare', () => {
  const desc = [0.5, 0.3, 0.15, 0.05];
  it('top1 / top2 / beyond-length', () => {
    expect(topNShare(desc, 1)).toBeCloseTo(0.5, 12);
    expect(topNShare(desc, 2)).toBeCloseTo(0.8, 12);
    expect(topNShare(desc, 10)).toBeCloseTo(1.0, 12);
  });
});

// ── Nakamoto coefficient ──────────────────────────────────────────────────────
describe('nakamotoCoefficient', () => {
  it('fewest holders to exceed 50%', () => {
    expect(nakamotoCoefficient([0.5, 0.3, 0.15, 0.05])).toBe(2); // 0.5 not >0.5, +0.3 ⇒ 2
    expect(nakamotoCoefficient([0.6, 0.4])).toBe(1);
    expect(nakamotoCoefficient([0.25, 0.25, 0.25, 0.25])).toBe(3); // 0.75 > 0.5
  });
  it('empty ⇒ 0', () => expect(nakamotoCoefficient([])).toBe(0));
});

// ── Gini (SECONDARY, address≠person caveat) ───────────────────────────────────
describe('giniCoefficient', () => {
  it('perfect equality ⇒ 0', () => expect(giniCoefficient([1, 1, 1, 1])).toBeCloseTo(0, 12));
  it('[1,2,3,4] ⇒ 0.25 (known value)', () => expect(giniCoefficient([1, 2, 3, 4])).toBeCloseTo(0.25, 12));
  it('n ≤ 1 ⇒ 0 (Gini undefined for a single address)', () => {
    expect(giniCoefficient([5])).toBe(0);
    expect(giniCoefficient([])).toBe(0);
  });
});

// ── normalization: Solana ATA → owner grouping ────────────────────────────────
describe('normalizeHolders', () => {
  it('groups multiple ATAs of one owner and drops zero balances', () => {
    const out = normalizeHolders([
      { address: 'ata1', ownerAddress: 'ownerA', balance: 100n },
      { address: 'ata2', ownerAddress: 'ownerA', balance: 50n },
      { address: 'ownerB', balance: 30n },
      { address: 'zeroAta', ownerAddress: 'ownerC', balance: 0n },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((h) => h.address === 'ownerA');
    expect(a?.balance).toBe(150n);
  });
  it('merges behavioral flags across an owner’s accounts', () => {
    const out = normalizeHolders([
      { address: 'ata1', ownerAddress: 'ownerA', balance: 100n, sniper: false },
      { address: 'ata2', ownerAddress: 'ownerA', balance: 50n, sniper: true },
    ]);
    expect(out[0]?.sniper).toBe(true);
  });
});

// ── classification / exclusion registry ───────────────────────────────────────
describe('classifyAddress', () => {
  const base = { chain: 'ethereum' as const, sources: [] as LabelSource[], thr: 0.01 };
  it('explicit label wins and drives exclusion', () => {
    const c = classifyAddress({ address: '0xpool', balance: 1n, label: 'lp' }, 0.3, base.chain, base.sources, base.thr);
    expect(c.category).toBe('lp');
    expect(c.excluded).toBe(true);
  });
  it('off-curve ⇒ PDA excluded (Solana)', () => {
    const c = classifyAddress({ address: 'pdaAddr', balance: 1n, offCurve: true }, 0.3, 'solana', base.sources, base.thr);
    expect(c.category).toBe('pda');
    expect(c.excluded).toBe(true);
  });
  it('burn address ⇒ excluded', () => {
    const c = classifyAddress(
      { address: '0x000000000000000000000000000000000000dEaD', balance: 1n },
      0.3,
      base.chain,
      base.sources,
      base.thr,
    );
    expect(c.category).toBe('burn');
    expect(c.excluded).toBe(true);
  });
  it('contract code with no label ⇒ contract excluded (low confidence)', () => {
    const c = classifyAddress({ address: '0xC0DE', balance: 1n, isContract: true }, 0.3, base.chain, base.sources, base.thr);
    expect(c.category).toBe('contract');
    expect(c.excluded).toBe(true);
    expect(c.confidence).toBe('low');
  });
  it('large UNLABELED wallet ⇒ unclassified, KEPT (not assumed hostile)', () => {
    const c = classifyAddress({ address: '0xWhale', balance: 1n }, 0.3, base.chain, base.sources, base.thr);
    expect(c.category).toBe('unclassified');
    expect(c.excluded).toBe(false);
  });
  it('small unlabeled wallet ⇒ plain eoa', () => {
    const c = classifyAddress({ address: '0xSmall', balance: 1n }, 0.0001, base.chain, base.sources, base.thr);
    expect(c.category).toBe('eoa');
    expect(c.excluded).toBe(false);
  });
  it('pluggable label source can classify (CEX ⇒ excluded)', () => {
    const src: LabelSource = { name: 'test', classify: (a) => (a === '0xCEX' ? 'cex' : null) };
    const c = classifyAddress({ address: '0xCEX', balance: 1n }, 0.3, base.chain, [src], base.thr);
    expect(c.category).toBe('cex');
    expect(c.excluded).toBe(true);
  });
});

// ── EXCLUSION HAPPENS BEFORE THE MATH (mutation-sensitive) ─────────────────────
describe('exclusion precedes concentration math', () => {
  it('an LP holding 90% of supply does not collapse the effective-holder count', () => {
    const holders: RawHolder[] = [
      { address: '0xLP', balance: 9000n, label: 'lp' },
      { address: '0xa', balance: 100n },
      { address: '0xb', balance: 100n },
      { address: '0xc', balance: 100n },
    ];
    const r = analyzeDistribution({ holders, observedAt: 1_700_000_000 });
    // Only the 3 EOAs are measured ⇒ ~3 effective holders, NOT ~1.
    expect(r.metrics.includedHolders).toBe(3);
    expect(r.metrics.effectiveHolders).toBeCloseTo(3, 2);
    expect(r.includedSupply).toBe('300');
    // The LP is disclosed in the exclusions, not silently dropped.
    const lp = r.exclusions.buckets.find((b) => b.category === 'lp');
    expect(lp?.excluded).toBe(true);
    expect(lp?.count).toBe(1);
    // top1 of TOTAL reflects the largest real holder (100/9300), not the pool.
    expect(r.metrics.top1ShareOfTotal).toBeCloseTo(100 / 9300, 4);
  });
});

// ── 3-band verdict ────────────────────────────────────────────────────────────
describe('banding', () => {
  it('many equal holders ⇒ well-distributed', () => {
    const r = analyzeDistribution({ holders: eqHolders(100), observedAt: 1_700_000_000 });
    expect(r.band).toBe('well-distributed');
  });
  it('one holder with 90% ⇒ concentrated', () => {
    const holders: RawHolder[] = [{ address: '0xbig', balance: 900n }, ...eqHolders(9, 11n)];
    const r = analyzeDistribution({ holders, observedAt: 1_700_000_000 });
    expect(r.band).toBe('concentrated');
  });
});

// ── WEAKEST-LINK GATE over hard facts ─────────────────────────────────────────
describe('weakest-link hard-fact gate', () => {
  it('live mint authority floors an otherwise well-distributed token at concentrated', () => {
    const r = analyzeDistribution({
      holders: eqHolders(100),
      hardFacts: { mintAuthorityLive: true },
      observedAt: 1_700_000_000,
    });
    expect(r.soft.band).toBe('well-distributed'); // soft evidence still looks fine
    expect(r.band).toBe('concentrated'); // …but the gate wins
    expect(r.gate.findings.find((f) => f.id === 'mint-authority-live')?.fired).toBe(true);
  });
  it('live freeze authority floors at mixed (softer than mint)', () => {
    const r = analyzeDistribution({
      holders: eqHolders(100),
      hardFacts: { mintAuthorityLive: false, freezeAuthorityLive: true, lpUnlocked: false },
      observedAt: 1_700_000_000,
    });
    expect(r.band).toBe('mixed');
  });
  it('a single holder above the majority threshold fires the gate', () => {
    const holders: RawHolder[] = [{ address: '0xbig', balance: 600n }, ...eqHolders(4, 100n)];
    const r = analyzeDistribution({ holders, observedAt: 1_700_000_000 });
    expect(r.gate.findings.find((f) => f.id === 'single-holder-majority')?.fired).toBe(true);
    expect(r.band).toBe('concentrated');
  });
  it('unknown facts never fire the gate', () => {
    const r = analyzeDistribution({ holders: eqHolders(100), hardFacts: {}, observedAt: 1_700_000_000 });
    expect(r.gate.floor).toBe('well-distributed');
  });
});

// ── DATA-CONFIDENCE flag (separate from band) ─────────────────────────────────
describe('data-confidence flag', () => {
  it('too few holders ⇒ low confidence (band unaffected)', () => {
    const r = analyzeDistribution({ holders: eqHolders(3), observedAt: 1_700_000_000 });
    expect(r.confidence.level).toBe('low');
    expect(r.confidence.reasons.join(' ')).toMatch(/holders/i);
  });
  it('very fresh token ⇒ low confidence', () => {
    const r = analyzeDistribution({
      holders: eqHolders(100),
      launch: { tokenAgeSeconds: 3600, bundlesResolved: true, snipersResolved: true },
      observedAt: 1_700_000_000,
    });
    expect(r.confidence.level).toBe('low');
  });
  it('high unlabeled supply ⇒ low confidence but NOT auto-hostile', () => {
    const holders: RawHolder[] = [{ address: '0xWhale', balance: 300n }, ...eqHolders(70, 10n)];
    const r = analyzeDistribution({
      holders,
      launch: { bundlesResolved: true, snipersResolved: true },
      observedAt: 1_700_000_000,
    });
    expect(r.confidence.level).toBe('low');
    // The whale is kept and measured, classified unclassified — never excluded as hostile.
    expect(r.holderCounts.unclassified).toBeGreaterThanOrEqual(1);
  });
  it('healthy inputs with detections run ⇒ high confidence', () => {
    // A realistic well-distributed base: 200 holders each ~0.5% (below the 1%
    // "large unlabeled" bar) ⇒ all plain EOAs, nothing unresolved.
    const r = analyzeDistribution({
      holders: eqHolders(200),
      launch: { tokenAgeSeconds: 60 * 60 * 24 * 30, bundlesResolved: true, snipersResolved: true },
      observedAt: 1_700_000_000,
    });
    expect(r.confidence.level).toBe('high');
  });
  it('a diffuse unlabeled base (no dominant wallet) is medium, not low', () => {
    // 100 holders each ~1% unlabeled: none has leverage to flip the read.
    const r = analyzeDistribution({
      holders: eqHolders(100),
      launch: { tokenAgeSeconds: 60 * 60 * 24 * 30, bundlesResolved: true, snipersResolved: true },
      observedAt: 1_700_000_000,
    });
    expect(r.confidence.level).toBe('medium');
  });
});

// ── missing signals are DROPPED, never defaulted to 0 risk ────────────────────
describe('missing-signal handling', () => {
  it('absent bundle/sniper/cluster signals are null and renormalized out of the blend', () => {
    const r = analyzeDistribution({ holders: eqHolders(100), observedAt: 1_700_000_000 });
    const bundled = r.soft.signals.find((s) => s.id === 'bundledHeld');
    const sniper = r.soft.signals.find((s) => s.id === 'sniper');
    const clustered = r.soft.signals.find((s) => s.id === 'clustered');
    expect(bundled?.risk).toBeNull();
    expect(sniper?.risk).toBeNull();
    expect(clustered?.risk).toBeNull();
    expect(r.metrics.bundledCurrentHeldShareOfTotal).toBeNull();
    // Not penalized for the gaps:
    expect(r.band).toBe('well-distributed');
  });
});

// ── bundled supply reported as TWO numbers ────────────────────────────────────
describe('bundled supply = total-at-launch AND currently-held', () => {
  it('reports both figures distinctly', () => {
    const holders: RawHolder[] = [
      { address: '0xb1', balance: 50n, bundled: true, bundledBalance: 50n },
      { address: '0xb2', balance: 50n, bundled: true, bundledBalance: 50n },
      ...eqHolders(9, 100n),
    ];
    const r = analyzeDistribution({
      holders,
      totalSupply: 1000n,
      launch: { bundledTotalSupplyShare: 0.4, bundlesResolved: true },
      observedAt: 1_700_000_000,
    });
    expect(r.metrics.bundledTotalShareOfTotal).toBeCloseTo(0.4, 6); // launch-time
    expect(r.metrics.bundledCurrentHeldShareOfTotal).toBeCloseTo(0.1, 6); // still held now
  });
});

// ── worseBand helper ──────────────────────────────────────────────────────────
describe('worseBand', () => {
  it('returns the more severe band', () => {
    expect(worseBand('well-distributed', 'mixed')).toBe('mixed');
    expect(worseBand('concentrated', 'mixed')).toBe('concentrated');
    expect(worseBand('well-distributed', 'well-distributed')).toBe('well-distributed');
  });
});

// ── output is descriptive + JSON-safe (honest-framing surface contract) ───────
describe('result envelope', () => {
  it('carries method, timestamp, caveats, correction path and is JSON-serializable', () => {
    const r = analyzeDistribution({ holders: eqHolders(100), observedAt: 1_700_000_000 });
    expect(r.method.version).toMatch(/detection-core/);
    expect(r.observedAt).toBe(1_700_000_000);
    expect(r.caveats.length).toBeGreaterThan(0);
    expect(r.correctionPath).toMatch(/correction/i);
    expect(typeof r.totalSupply).toBe('string'); // bigints stringified
    expect(() => JSON.parse(JSON.stringify(r))).not.toThrow();
    expect(r.headline).toMatch(/effective|equally-sized/i);
  });
});
