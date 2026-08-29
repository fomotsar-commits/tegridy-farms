import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RECOMMENDED_AMM_CONFIG,
  feeSplit,
  createAmmConfigArgs,
  solOf,
  LAMPORTS_PER_SOL,
} from './venue';

/**
 * The fee sheet is a PROPOSAL, and the thing that makes it credible is that it
 * is the same tier the repo's own migration rehearsal creates its config with.
 * This pins that agreement, so the proposal cannot drift away from the config
 * the only end-to-end test in the repo actually exercises.
 */

const REHEARSAL = resolve(
  __dirname, '../../../../..',
  'solana/tegridy-amm/tests/tegridy-launch-migration.test.ts',
);

describe('RECOMMENDED_AMM_CONFIG', () => {
  it('matches the rates the migration rehearsal creates its config with', () => {
    if (!existsSync(REHEARSAL)) throw new Error(`rehearsal test not found at ${REHEARSAL}`);
    const src = readFileSync(REHEARSAL, 'utf8');
    // .createAmmConfig(index, new BN(2500), new BN(120000), new BN(0), CREATE_POOL_FEE, new BN(0))
    // A naive `[^)]*` stops inside `new BN(2500)`, so take a window instead.
    const flat = src.replace(/\s+/g, ' ');
    const at = flat.indexOf('.createAmmConfig(');
    expect(at, 'createAmmConfig call not found in the rehearsal').toBeGreaterThan(-1);
    const args = flat.slice(at, at + 200);
    expect(args).toContain('new BN(2500)');
    expect(args).toContain('new BN(120000)');
    expect(RECOMMENDED_AMM_CONFIG.tradeFeeRate).toBe(2_500n);
    expect(RECOMMENDED_AMM_CONFIG.protocolFeeRate).toBe(120_000n);

    // CREATE_POOL_FEE = new BN(15).mul(LAMPORTS_PER_SOL).div(new BN(100)) = 0.15 SOL
    expect(src).toMatch(/CREATE_POOL_FEE\s*=\s*new BN\(15\)[\s\S]{0,80}div\(new BN\(100\)\)/);
    expect(RECOMMENDED_AMM_CONFIG.createPoolFee).toBe(150_000_000n);
    expect(solOf(RECOMMENDED_AMM_CONFIG.createPoolFee)).toBe(0.15);
  });

  it('ships the creator fee OFF — enabling it raises the cost of every trade', () => {
    expect(RECOMMENDED_AMM_CONFIG.creatorFeeRate).toBe(0n);
  });

  it('uses config index 0, the conventional standard tier', () => {
    expect(RECOMMENDED_AMM_CONFIG.index).toBe(0);
  });
});

describe('feeSplit', () => {
  it('reads the proposal as 0.25% paid, 0.21% to LPs, 0.04% to the venue', () => {
    const s = feeSplit(RECOMMENDED_AMM_CONFIG);
    expect(s.traderPaysPct).toBeCloseTo(0.25, 10);
    expect(s.venueShareOfFeePct).toBeCloseTo(16, 10);
    expect(s.venueTakesPct).toBeCloseTo(0.04, 10);
    expect(s.lpKeepsPct).toBeCloseTo(0.21, 10);
  });

  it('always accounts for every basis point — LP + venue == what the trader paid', () => {
    for (const c of [
      RECOMMENDED_AMM_CONFIG,
      { tradeFeeRate: 10_000n, protocolFeeRate: 500_000n, fundFeeRate: 0n },
      { tradeFeeRate: 100n, protocolFeeRate: 0n, fundFeeRate: 0n },
      { tradeFeeRate: 0n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n },
    ]) {
      const s = feeSplit(c);
      expect(s.lpKeepsPct + s.venueTakesPct).toBeCloseTo(s.traderPaysPct, 10);
    }
  });

  it('forms each part exactly, rather than by subtracting floats', () => {
    // 0.3 - 0.075 is 0.22499999999999998 in doubles, which a two-decimal display
    // renders as 0.22 — understating an LP's cut by half a basis point on the
    // one number this venue asks them to judge it by.
    const s = feeSplit({ tradeFeeRate: 3_000n, protocolFeeRate: 250_000n, fundFeeRate: 0n });
    expect(s.lpKeepsPct).toBe(0.225);
    expect(s.venueTakesPct).toBe(0.075);
    expect(s.lpKeepsPct.toFixed(2)).toBe('0.23');
  });

  it('reads a chain config the same way it reads the proposal', () => {
    // The page uses this over `readVenue()` output; if the two disagreed, the
    // disclosure and the proposal would drift the moment the operator retuned.
    const onChain = { tradeFeeRate: 3_000n, protocolFeeRate: 250_000n, fundFeeRate: 0n };
    const s = feeSplit(onChain);
    expect(s.traderPaysPct).toBeCloseTo(0.3, 10);
    expect(s.venueTakesPct).toBeCloseTo(0.075, 10);
    expect(s.lpKeepsPct).toBeCloseTo(0.225, 10);
  });
});

describe('createAmmConfigArgs', () => {
  it('is the operator instruction in program order', () => {
    // create_amm_config(index, trade_fee_rate, protocol_fee_rate,
    //                   fund_fee_rate, create_pool_fee, creator_fee_rate)
    expect(createAmmConfigArgs()).toEqual([
      '0', '2500', '120000', '40000', '150000000', '0',
    ]);
  });
});

describe('solOf', () => {
  it('converts without floating-point drift at sane magnitudes', () => {
    expect(solOf(LAMPORTS_PER_SOL)).toBe(1);
    expect(solOf(0n)).toBe(0);
    expect(solOf(150_000_000n)).toBe(0.15);
  });
});
