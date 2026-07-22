import { describe, it, expect } from 'vitest';
import {
  classifyLaunch,
  summarizeDeployer,
  DEFAULT_DEPLOYER_CONFIG,
  type LaunchInput,
  type LaunchTrajectory,
} from './deployerReputation';

const NOW = 1_800_000_000;
const A = '0x000000000000000000000000000000000000000a';
const B = '0x000000000000000000000000000000000000000b';
const DEPLOYER = '0xDEAD00000000000000000000000000000000BEEF';

function input(over: Partial<LaunchInput>): LaunchInput {
  return { token: A, createdAt: 100, txHash: '0xt', market: null, ...over };
}

describe('classifyLaunch', () => {
  it('maps a null market (enrichment returned nothing) to unobserved — never a fabricated pool', () => {
    const t = classifyLaunch(input({ market: null }), NOW);
    expect(t.status).toBe('unobserved');
    expect(t.liquidityEth).toBeNull();
    expect(t.priceEth).toBeNull();
  });

  it('maps observed:false (a record that found no pool) to no-market, not a rug verdict', () => {
    const t = classifyLaunch(input({ market: { observed: false, liquidityEth: 0, priceEth: 0 } }), NOW);
    expect(t.status).toBe('no-market');
    expect(t.liquidityEth).toBeNull();
    // Honest-framing: the note must NOT accuse.
    expect(t.note.toLowerCase()).toContain('not evidence of a rug');
  });

  it('classifies a deep live pool as active-market', () => {
    const t = classifyLaunch(input({ market: { observed: true, liquidityEth: 5, priceEth: 0.001 } }), NOW);
    expect(t.status).toBe('active-market');
    expect(t.liquidityEth).toBe(5);
    expect(t.priceEth).toBe(0.001);
  });

  it('classifies a live pool below the liquidity floor as thin-market', () => {
    const below = DEFAULT_DEPLOYER_CONFIG.activeLiquidityFloorEth - 0.01;
    const t = classifyLaunch(input({ market: { observed: true, liquidityEth: below, priceEth: 0.001 } }), NOW);
    expect(t.status).toBe('thin-market');
  });

  it('treats exactly the floor as active (>= floor)', () => {
    const at = DEFAULT_DEPLOYER_CONFIG.activeLiquidityFloorEth;
    const t = classifyLaunch(input({ market: { observed: true, liquidityEth: at, priceEth: 0.001 } }), NOW);
    expect(t.status).toBe('active-market');
  });

  it('respects a custom liquidity floor', () => {
    const t = classifyLaunch(input({ market: { observed: true, liquidityEth: 2, priceEth: 1 } }), NOW, {
      activeLiquidityFloorEth: 10,
    });
    expect(t.status).toBe('thin-market');
  });

  it('coerces NaN/negative liquidity to 0 (→ thin) and lowercases the token', () => {
    const t = classifyLaunch(
      input({ token: '0xABCDEF0000000000000000000000000000000abc', market: { observed: true, liquidityEth: NaN, priceEth: -1 } }),
      NOW,
    );
    expect(t.token).toBe('0xabcdef0000000000000000000000000000000abc');
    expect(t.status).toBe('thin-market');
    expect(t.liquidityEth).toBe(0);
  });
});

function traj(status: LaunchTrajectory['status'], createdAt: number, token = A): LaunchTrajectory {
  return {
    token,
    createdAt,
    txHash: null,
    status,
    liquidityEth: status === 'active-market' ? 5 : status === 'thin-market' ? 0.1 : null,
    priceEth: null,
    note: 'x',
  };
}

describe('summarizeDeployer', () => {
  it('counts each status and sorts trajectories newest-first', () => {
    const rep = summarizeDeployer(
      [traj('active-market', 100, A), traj('no-market', 300, B), traj('thin-market', 200, '0x000000000000000000000000000000000000000c')],
      { deployer: DEPLOYER, observedAt: NOW },
    );
    expect(rep.counts).toMatchObject({ created: 3, activeMarket: 1, thinMarket: 1, noMarket: 1, unobserved: 0 });
    expect(rep.trajectories.map((t) => t.createdAt)).toEqual([300, 200, 100]);
    expect(rep.latestCreationAt).toBe(300);
    expect(rep.deployer).toBe(DEPLOYER.toLowerCase());
  });

  it('gives an honest empty headline + low confidence when nothing was created', () => {
    const rep = summarizeDeployer([], { deployer: DEPLOYER, observedAt: NOW });
    expect(rep.counts.created).toBe(0);
    expect(rep.confidence.level).toBe('low');
    expect(rep.headline.toLowerCase()).toContain('no contracts were created directly');
    // Must NOT read as a clean/safe track record.
    expect(rep.headline.toLowerCase()).not.toContain('clean');
  });

  it('is low-confidence when every token is unobserved', () => {
    const rep = summarizeDeployer([traj('unobserved', 1), traj('unobserved', 2, B)], { deployer: DEPLOYER, observedAt: NOW });
    expect(rep.confidence.level).toBe('low');
  });

  it('is low-confidence when the history was truncated', () => {
    const rep = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW, truncated: true });
    expect(rep.confidence.level).toBe('low');
  });

  it('caps at medium confidence for a clean read (never high — factory launches are invisible)', () => {
    const rep = summarizeDeployer([traj('active-market', 1), traj('no-market', 2, B)], {
      deployer: DEPLOYER,
      observedAt: NOW,
    });
    expect(rep.confidence.level).toBe('medium');
  });

  it('always discloses the factory-invisibility, no-baseline, and non-accusation gaps', () => {
    const rep = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW });
    const joined = rep.disclosures.join(' ').toLowerCase();
    expect(joined).toContain('factory');
    expect(joined).toContain('launch-time');
    expect(joined).toContain('never as a rug');
  });

  it('discloses holder counts are unavailable when no Pro source is wired', () => {
    const rep = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW, holderCountsAvailable: false });
    expect(rep.disclosures.join(' ').toLowerCase()).toContain('holder counts');
    expect(rep.confidence.reasons.join(' ').toLowerCase()).toContain('pro-gated');
  });

  it('adds a truncation disclosure only when truncated', () => {
    const untrunc = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW });
    const trunc = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW, truncated: true });
    expect(trunc.disclosures.length).toBeGreaterThan(untrunc.disclosures.length);
  });

  it('surfaces lastActivityAt when provided and null otherwise', () => {
    const withAct = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW, lastActivityAt: 1234 });
    expect(withAct.lastActivityAt).toBe(1234);
    const without = summarizeDeployer([traj('active-market', 1)], { deployer: DEPLOYER, observedAt: NOW });
    expect(without.lastActivityAt).toBeNull();
  });
});
