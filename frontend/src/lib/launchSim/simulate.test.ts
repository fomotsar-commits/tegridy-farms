import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, BAND_RANK } from '../detection';
import {
  simulate,
  buildHolders,
  toHardFacts,
  toRawTokenFacts,
  effectivePowers,
  parseAmount,
  DEFAULT_STRUCTURAL,
  type AllocRow,
  type SimInput,
  type StructuralInput,
} from './simulate';

const NOW = 1_800_000_000;

function rows(specs: Array<Partial<AllocRow> & { amount: string }>): AllocRow[] {
  return specs.map((s, i) => ({
    id: String(i),
    label: s.label ?? `row-${i}`,
    amount: s.amount,
    category: s.category ?? 'auto',
    clusterId: s.clusterId,
    bundled: s.bundled,
    sniper: s.sniper,
  }));
}

function baseInput(over: Partial<SimInput> = {}): SimInput {
  return {
    rows: [],
    structural: { ...DEFAULT_STRUCTURAL },
    bundlesModeled: false,
    snipersModeled: false,
    now: NOW,
    ...over,
  };
}

/** n equal holders of `each` whole tokens. */
function equalRows(n: number, each = '1000'): AllocRow[] {
  return rows(Array.from({ length: n }, () => ({ amount: each })));
}

describe('parseAmount', () => {
  it('parses digits, strips separators, and floors garbage to 0', () => {
    expect(parseAmount('1,000,000')).toBe(1_000_000n);
    expect(parseAmount('  42 ')).toBe(42n);
    expect(parseAmount('')).toBe(0n);
    expect(parseAmount('abc')).toBe(0n);
  });
});

describe('buildHolders', () => {
  it('drops zero/blank rows and assigns distinct addresses so rows never merge', () => {
    const holders = buildHolders(baseInput({ rows: rows([{ amount: '100' }, { amount: '0' }, { amount: '' }, { amount: '50' }]) }));
    expect(holders).toHaveLength(2);
    expect(new Set(holders.map((h) => h.address)).size).toBe(2);
  });

  it('passes an explicit category through as a core label (so LP is excluded)', () => {
    const holders = buildHolders(baseInput({ rows: rows([{ amount: '100', category: 'lp' }]) }));
    expect(holders[0].label).toBe('lp');
  });

  it('only honours bundled/sniper flags once the dev opts into modelling them', () => {
    const spec = rows([{ amount: '100', bundled: true, sniper: true }]);
    expect(buildHolders(baseInput({ rows: spec, bundlesModeled: false, snipersModeled: false }))[0].bundled).toBe(false);
    const modeled = buildHolders(baseInput({ rows: spec, bundlesModeled: true, snipersModeled: true }))[0];
    expect(modeled.bundled).toBe(true);
    expect(modeled.sniper).toBe(true);
  });
});

describe('effectivePowers / toHardFacts', () => {
  it('an audited template forces the dangerous powers false regardless of toggles', () => {
    const s: StructuralInput = { ...DEFAULT_STRUCTURAL, knownSafeTemplate: true, canMint: true, canPause: true, upgradeable: true };
    expect(effectivePowers(s).mint).toBe(false);
    expect(effectivePowers(s).upgrade).toBe(false);
    expect(toHardFacts(s).mintAuthorityLive).toBe(false);
  });

  it('without an audited template the dev toggles stand and map into hard facts', () => {
    const s: StructuralInput = { ...DEFAULT_STRUCTURAL, knownSafeTemplate: false, canMint: true, canPause: true, lpLocked: false };
    expect(effectivePowers(s).mint).toBe(true);
    const hf = toHardFacts(s);
    expect(hf.mintAuthorityLive).toBe(true);
    expect(hf.freezeAuthorityLive).toBe(true);
    expect(hf.lpUnlocked).toBe(true);
  });
});

describe('simulate — self-gating', () => {
  it('reports hasData=false and measures nothing when there are no non-zero rows', () => {
    const r = simulate(baseInput({ rows: rows([{ amount: '0' }]) }));
    expect(r.hasData).toBe(false);
    expect(r.analysis.metrics.includedHolders).toBe(0);
  });
});

describe('simulate — distribution band', () => {
  it('a broad fair launch reads well-distributed with no gate fires', () => {
    const r = simulate(baseInput({ rows: equalRows(80) }));
    expect(r.hasData).toBe(true);
    expect(r.analysis.band).toBe('well-distributed');
    expect(r.analysis.gate.findings.some((f) => f.fired)).toBe(false);
  });

  it('a single majority wallet fires the single-holder gate and floors the band at concentrated', () => {
    // one wallet 900, nine wallets 10 each → top1 = 900/990 ≈ 0.909 ≥ 0.5 gate.
    const r = simulate(
      baseInput({ rows: rows([{ amount: '900' }, ...Array.from({ length: 9 }, () => ({ amount: '10' }))]) }),
    );
    expect(r.analysis.band).toBe('concentrated');
    const fired = r.analysis.gate.findings.find((f) => f.id === 'single-holder-majority');
    expect(fired?.fired).toBe(true);
  });

  it('LP / locker rows are excluded before concentration math, not counted as holders', () => {
    const r = simulate(
      baseInput({
        rows: rows([
          { amount: '5000', category: 'lp', label: 'LP' },
          ...Array.from({ length: 50 }, () => ({ amount: '100' })),
        ]),
      }),
    );
    // 50 real holders after excluding the pool.
    expect(r.analysis.metrics.includedHolders).toBe(50);
    expect(r.analysis.exclusions.buckets.some((b) => b.category === 'lp' && b.excluded)).toBe(true);
  });
});

describe('computeBandTargets — the "delta to pass each band" solver', () => {
  it('a fair launch meets both bands with zero blockers', () => {
    const r = simulate(baseInput({ rows: equalRows(80) }));
    for (const t of r.bandTargets) {
      expect(t.met).toBe(true);
      expect(t.gateBlockers).toHaveLength(0);
    }
  });

  it('a live mint authority becomes a hard blocker for every better band, with a fix', () => {
    const structural: StructuralInput = { ...DEFAULT_STRUCTURAL, knownSafeTemplate: false, canMint: true };
    const r = simulate(baseInput({ rows: equalRows(80), structural }));
    const well = r.bandTargets.find((t) => t.band === 'well-distributed')!;
    const blocker = well.gateBlockers.find((b) => b.id === 'mint-authority-live');
    expect(blocker).toBeTruthy();
    expect(blocker!.fix.length).toBeGreaterThan(0);
    // A forced-concentrated floor cannot be met by any better band.
    expect(well.met).toBe(false);
  });

  it('ranks the concentration levers by contribution (descending) when the soft blend blocks a band', () => {
    // Skewed but sub-majority: no gate fires, so the soft blend is what blocks.
    const r = simulate(baseInput({ rows: rows([{ amount: '40' }, { amount: '30' }, { amount: '20' }, { amount: '10' }]) }));
    expect(r.analysis.gate.findings.some((f) => f.fired)).toBe(false);
    const well = r.bandTargets.find((t) => t.band === 'well-distributed')!;
    expect(well.softMet).toBe(false);
    expect(well.levers.length).toBeGreaterThan(0);
    // sorted by contribution, descending
    for (let i = 1; i < well.levers.length; i++) {
      expect(well.levers[i - 1].contribution).toBeGreaterThanOrEqual(well.levers[i].contribution);
    }
    // a concentration signal must be present as a lever
    expect(well.levers.some((l) => ['top1', 'top10', 'effectiveHolders', 'nakamoto'].includes(l.id))).toBe(true);
    // guideline endpoints come straight from the resolved ramps (not fabricated)
    const top1 = well.levers.find((l) => l.id === 'top1');
    if (top1) expect(top1.guidelineGood).toBe(DEFAULT_CONFIG.ramps.top1[0]);
  });

  it('a single-lever target, when sufficient alone, points in the improving direction', () => {
    const r = simulate(baseInput({ rows: rows([{ amount: '40' }, { amount: '30' }, { amount: '20' }, { amount: '10' }]) }));
    const mixed = r.bandTargets.find((t) => t.band === 'mixed')!;
    for (const lever of mixed.levers) {
      if (!lever.sufficientAlone) continue;
      expect(lever.singleLeverTarget).not.toBeNull();
      if (lever.direction === 'lower') expect(lever.singleLeverTarget!).toBeLessThanOrEqual(lever.value + 1e-9);
      else expect(lever.singleLeverTarget!).toBeGreaterThanOrEqual(lever.value - 1e-9);
    }
  });

  it('met flags agree with the analysis band ordering', () => {
    const r = simulate(baseInput({ rows: equalRows(6, '1000') }));
    for (const t of r.bandTargets) {
      expect(t.met).toBe(BAND_RANK[r.analysis.band] <= BAND_RANK[t.band]);
    }
  });
});

describe('simulate — reused Fact-Sheet gate', () => {
  it('a clean audited-template, LP-locked, fair launch projects a flagship Fact Sheet', () => {
    const r = simulate(baseInput({ rows: equalRows(50), structural: { ...DEFAULT_STRUCTURAL } }));
    expect(r.factSheet.tier).toBe('flagship');
    expect(r.factSheet.knownSafeTemplate).toBe(true);
  });

  it('an unlocked-LP, non-template config cannot reach listable', () => {
    const structural: StructuralInput = { ...DEFAULT_STRUCTURAL, knownSafeTemplate: false, lpLocked: false, canMint: true };
    const r = simulate(baseInput({ rows: equalRows(50), structural }));
    expect(r.factSheet.tier).toBe('none');
  });

  it('team allocation above the flagship insider cap downgrades the tier but stays disclosed', () => {
    const structural: StructuralInput = { ...DEFAULT_STRUCTURAL, teamAllocationBps: 3000, teamAllocationVestedBps: 3000 };
    const r = simulate(baseInput({ rows: equalRows(50), structural }));
    // Listable (fully vested) but not flagship (insider float over 20%).
    expect(r.factSheet.tier).toBe('listable');
    expect(r.factSheet.teamAllocationBps).toBe(3000);
  });

  it('the projected total supply is the sum of the proposed row balances', () => {
    const r = simulate(baseInput({ rows: rows([{ amount: '100' }, { amount: '250' }]) }));
    expect(r.totalSupply).toBe('350');
    const facts = toRawTokenFacts(baseInput({ rows: rows([{ amount: '100' }, { amount: '250' }]) }), 350n, NOW);
    expect(facts.totalSupply).toBe(350n);
  });
});
