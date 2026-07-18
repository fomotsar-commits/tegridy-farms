import { describe, it, expect } from 'vitest';
import { parseEther, type Address } from 'viem';
import {
  wizardConfigToLaunchConfig,
  launchToken,
  LaunchError,
  type LaunchWizardInput,
  type LaunchMapOptions,
} from './launchService';
import { feeConstitutionToBeneficiaries } from './airlock';
import { DOPPLER_MAINNET } from './doppler.constants';
import { REVENUE_DISTRIBUTOR_ADDRESS } from '../constants';
import { LAUNCHER_INTEGRATOR_ADDRESS, LAUNCH_FEE_TIER } from './config';

const USER = '0x1111111111111111111111111111111111111111' as Address;
const KOL = '0x2222222222222222222222222222222222222222' as Address;

function wizard(overrides: Partial<LaunchWizardInput> = {}): LaunchWizardInput {
  return {
    name: 'Tegridy Launch',
    symbol: 'TGL',
    tokenURI: 'ipfs://meta',
    tier: 'flagship',
    totalSupply: '1000000000', // 1B whole tokens
    premineBps: 0,
    mcapStartK: 300, // $300k
    mcapFloorK: 30, // $30k
    lpLockMonths: 12,
    ...overrides,
  };
}

function opts(overrides: Partial<LaunchMapOptions> = {}): LaunchMapOptions {
  return { userAddress: USER, numerairePriceUsd: 1881, ...overrides };
}

describe('wizardConfigToLaunchConfig — mapping', () => {
  it('scales supply to 18 decimals; 0% premine sells the whole supply', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ premineBps: 0 }), opts());
    expect(cfg.initialSupply).toBe(parseEther('1000000000'));
    expect(cfg.numTokensToSell).toBe(parseEther('1000000000')); // fair launch -> sell all
  });

  it('REFUSES a premine until on-chain vesting is wired (no false "vested" disclosure)', () => {
    expect(() => wizardConfigToLaunchConfig(wizard({ premineBps: 1000 }), opts())).toThrow(/not supported yet/);
  });

  it('rejects invalid wizard state (zero supply, non-descending mcap, bad ETH price)', () => {
    expect(() => wizardConfigToLaunchConfig(wizard({ totalSupply: '0' }), opts())).toThrow(/positive/);
    expect(() => wizardConfigToLaunchConfig(wizard({ mcapStartK: 30, mcapFloorK: 300 }), opts())).toThrow(/descend/);
    expect(() => wizardConfigToLaunchConfig(wizard(), { ...opts(), numerairePriceUsd: 0 })).toThrow(/ETH price/);
  });

  it('builds a descending market-cap band (start > min) in USD', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts());
    expect(cfg.marketCap).toEqual({ start: 300_000, min: 30_000 });
    expect(cfg.marketCap.start).toBeGreaterThan(cfg.marketCap.min);
  });

  it('computes lockDuration from months at 365/12 days/month (12mo === 365 days)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ lpLockMonths: 12 }), opts());
    expect(cfg.lockDurationSeconds).toBe(365 * 86_400); // exactly one year
    const six = wizardConfigToLaunchConfig(wizard({ lpLockMonths: 6 }), opts());
    expect(six.lockDurationSeconds).toBe(Math.round(6 * (365 / 12) * 86_400));
  });

  it('resolves fee-constitution roles to concrete addresses', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }));
    const byAddress = Object.fromEntries(cfg.feeConstitution.map((l) => [l.address, l]));
    expect(byAddress[USER].role).toBe('creator');
    expect(byAddress[KOL].role).toBe('attention-beneficiary');
    expect(byAddress[REVENUE_DISTRIBUTOR_ADDRESS].role).toBe('protocol-stakers');
    expect(byAddress[DOPPLER_MAINNET.airlockOwner].role).toBe('doppler');
  });

  it('fee lines sum to exactly 10000 bps with the Doppler line >= 500', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }));
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
    const doppler = cfg.feeConstitution.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0);
    expect(doppler).toBeGreaterThanOrEqual(500);
  });

  it('attention splits carve from the creator pool; protocol + doppler are untouched', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 2000 }] }));
    const byAddress = Object.fromEntries(cfg.feeConstitution.map((l) => [l.address, l.shareBps]));
    // Creator keeps the 8000 pool minus the 2000 carve; KOL gets the 2000.
    expect(byAddress[USER]).toBe(6000);
    expect(byAddress[KOL]).toBe(2000);
    // Fixed lines never move.
    expect(byAddress[REVENUE_DISTRIBUTOR_ADDRESS]).toBe(1500);
    expect(byAddress[DOPPLER_MAINNET.airlockOwner]).toBe(500);
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('supports multiple KOL splits, each to its own address', () => {
    const KOL2 = '0x3333333333333333333333333333333333333333' as Address;
    const cfg = wizardConfigToLaunchConfig(
      wizard(),
      opts({
        attentionSplits: [
          { address: KOL, shareBps: 1500 },
          { address: KOL2, shareBps: 500 },
        ],
      }),
    );
    const byAddress = Object.fromEntries(cfg.feeConstitution.map((l) => [l.address, l.shareBps]));
    expect(byAddress[USER]).toBe(6000); // 8000 - 1500 - 500
    expect(byAddress[KOL]).toBe(1500);
    expect(byAddress[KOL2]).toBe(500);
    expect(byAddress[REVENUE_DISTRIBUTOR_ADDRESS]).toBe(1500);
    expect(byAddress[DOPPLER_MAINNET.airlockOwner]).toBe(500);
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('throws a clear error when a creator over-allocates the pool (> 8000 bps)', () => {
    expect(() =>
      wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 8001 }] })),
    ).toThrow(/over-allocate/);
    // Multiple splits that sum past the pool also throw.
    const KOL2 = '0x3333333333333333333333333333333333333333' as Address;
    expect(() =>
      wizardConfigToLaunchConfig(
        wizard(),
        opts({
          attentionSplits: [
            { address: KOL, shareBps: 5000 },
            { address: KOL2, shareBps: 4000 },
          ],
        }),
      ),
    ).toThrow(/over-allocate/);
  });

  it('coalesces a KOL split pointed at the creator back into the creator line', () => {
    // A "split" to the creator's own address is a no-op: creator keeps the full 8000.
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: USER, shareBps: 2000 }] }));
    const addrs = cfg.feeConstitution.map((l) => l.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length); // all unique
    const userLine = cfg.feeConstitution.find((l) => l.address === USER)!;
    expect(userLine.shareBps).toBe(8000); // 6000 remainder + 2000 split merged
    expect(userLine.role).toBe('creator'); // creator line wins the merge
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('coalesces creator + attention into one line when there are no splits (unique beneficiaries)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts()); // no splits -> creator keeps 8000
    const addrs = cfg.feeConstitution.map((l) => l.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length); // all unique
    const userLine = cfg.feeConstitution.find((l) => l.address === USER)!;
    expect(userLine.shareBps).toBe(8000); // whole creator+attention pool
    // Only three lines: creator, protocol, doppler.
    expect(cfg.feeConstitution).toHaveLength(3);
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('produces a constitution the locker accepts (sums to 1e18, doppler floor, sorted)', () => {
    // No splits (3 unique), one KOL (4 unique), two KOLs (5 unique) — all valid.
    const KOL2 = '0x3333333333333333333333333333333333333333' as Address;
    const cases: LaunchMapOptions[] = [
      opts(),
      opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }),
      opts({
        attentionSplits: [
          { address: KOL, shareBps: 1500 },
          { address: KOL2, shareBps: 500 },
        ],
      }),
    ];
    for (const o of cases) {
      const cfg = wizardConfigToLaunchConfig(wizard(), o);
      const beneficiaries = feeConstitutionToBeneficiaries(cfg.feeConstitution);
      const sum = beneficiaries.reduce((n, b) => n + b.shares, 0n);
      expect(sum).toBe(10n ** 18n);
      const doppler = cfg.feeConstitution.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0);
      expect(doppler).toBeGreaterThanOrEqual(500);
    }
  });

  it('pins integrator, fee tier, start-time buffer, and passes the tier through', () => {
    const cfg = wizardConfigToLaunchConfig(wizard({ tier: 'listable' }), opts());
    expect(cfg.integrator).toBe(LAUNCHER_INTEGRATOR_ADDRESS);
    expect(cfg.feeTier).toBe(LAUNCH_FEE_TIER);
    expect(cfg.startTimeOffsetSeconds).toBe(600);
    expect(cfg.tier).toBe('listable');
    expect(cfg.numerairePriceUsd).toBe(1881);
  });

  it('supplies sane default proceeds bounds, overridable via opts', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts());
    expect(cfg.minProceeds).toBe(parseEther('1'));
    expect(cfg.maxProceeds).toBe(parseEther('1000'));
    const custom = wizardConfigToLaunchConfig(wizard(), opts({ minProceeds: parseEther('5'), maxProceeds: parseEther('50') }));
    expect(custom.minProceeds).toBe(parseEther('5'));
    expect(custom.maxProceeds).toBe(parseEther('50'));
  });
});

describe('launchToken — gate guard (no chain access)', () => {
  it('refuses to launch while the launcher is gated (LAUNCHER_ENABLED=false)', async () => {
    // isLauncherEnabled() is false by default -> throws before ever touching the clients.
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ attentionSplits: [{ address: KOL, shareBps: 1000 }] }));
    // Dummy clients: they must never be used because the guard fires first.
    const dummy = {} as never;
    await expect(launchToken(dummy, dummy, cfg)).rejects.toBeInstanceOf(LaunchError);
    await expect(launchToken(dummy, dummy, cfg)).rejects.toMatchObject({ code: 'launcher-disabled' });
  });
});
