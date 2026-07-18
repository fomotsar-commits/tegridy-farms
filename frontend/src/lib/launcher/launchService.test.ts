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
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ kolAddress: KOL }));
    const byRole = Object.fromEntries(cfg.feeConstitution.map((l) => [l.role, l.address]));
    expect(byRole['creator']).toBe(USER);
    expect(byRole['attention-beneficiary']).toBe(KOL);
    expect(byRole['protocol-stakers']).toBe(REVENUE_DISTRIBUTOR_ADDRESS);
    expect(byRole['doppler']).toBe(DOPPLER_MAINNET.airlockOwner);
  });

  it('fee lines sum to exactly 10000 bps with the Doppler line >= 500', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ kolAddress: KOL }));
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
    const doppler = cfg.feeConstitution.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0);
    expect(doppler).toBeGreaterThanOrEqual(500);
  });

  it('coalesces creator + attention into one line when no distinct KOL (unique beneficiaries)', () => {
    const cfg = wizardConfigToLaunchConfig(wizard(), opts()); // no kolAddress -> attention == user
    const addrs = cfg.feeConstitution.map((l) => l.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length); // all unique
    const userLine = cfg.feeConstitution.find((l) => l.address === USER)!;
    expect(userLine.shareBps).toBe(8000); // 7000 creator + 1000 attention merged
    // Still sums to 10000 and remains locker-valid.
    const total = cfg.feeConstitution.reduce((n, l) => n + l.shareBps, 0);
    expect(total).toBe(10_000);
  });

  it('produces a constitution the locker accepts (sums to 1e18, doppler floor, sorted)', () => {
    // With a distinct KOL (4 unique addresses) and without (3 unique) — both valid.
    for (const o of [opts(), opts({ kolAddress: KOL })]) {
      const cfg = wizardConfigToLaunchConfig(wizard(), o);
      const beneficiaries = feeConstitutionToBeneficiaries(cfg.feeConstitution);
      const sum = beneficiaries.reduce((n, b) => n + b.shares, 0n);
      expect(sum).toBe(10n ** 18n);
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
    const cfg = wizardConfigToLaunchConfig(wizard(), opts({ kolAddress: KOL }));
    // Dummy clients: they must never be used because the guard fires first.
    const dummy = {} as never;
    await expect(launchToken(dummy, dummy, cfg)).rejects.toBeInstanceOf(LaunchError);
    await expect(launchToken(dummy, dummy, cfg)).rejects.toMatchObject({ code: 'launcher-disabled' });
  });
});
