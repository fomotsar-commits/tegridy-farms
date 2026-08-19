// WHERE the price is re-checked on the EVM rail.
//
// The wizard prices a launch when it reads the door. The locker makes that price permanent
// when the transaction mines. Between those two moments a browser tab can sit open for an
// hour, a wallet can cool, and the island's instrument can go dark — so the discount is
// re-checked against the reading that just came back, above the SDK import and above any
// signature request, exactly where the Heat denial itself sits.
//
// Separate file for the same reason launchService.gate.test.ts is separate: that file's
// module mock forces `isLauncherEnabled` false, so `launchToken` returns at its first line.
// Here the launcher is enabled and the DENIAL is dialled off, which isolates the pricing
// check as the only thing that can refuse.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Address } from 'viem';

const sdkCtor = vi.hoisted(() => vi.fn());
vi.mock('@whetstone-research/doppler-sdk/evm', () => ({
  DopplerSDK: class {
    constructor(...args: unknown[]) {
      sdkCtor(...args);
    }
    factory = {
      simulateCreateDynamicAuction: vi.fn(),
      createDynamicAuction: vi.fn(),
    };
  },
}));

vi.mock('./config', async (importActual) => {
  const actual = await importActual<typeof import('./config')>();
  return { ...actual, isLauncherEnabled: () => true };
});

import { wizardConfigToLaunchConfig, launchToken, LaunchError, type LaunchWizardInput } from './launchService';
import { clearGateAudit } from '../heat/gateAudit';
import { HEAT_TIER_VENUE_LINE_BPS, resolveLaunchPricing, standardLaunchPricing } from './launchPricing';

const CREATOR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a' as Address;

const wizard = (): LaunchWizardInput => ({
  tier: 'listable',
  name: 'Test Coin',
  symbol: 'TEST',
  tokenURI: 'ipfs://meta',
  totalSupply: '1000000',
  premineBps: 0,
  vestMonths: 0,
  lpLockMonths: 1,
  mcapStartK: 100,
  mcapFloorK: 10,
});

/** A launch config carrying whatever price we hand it. */
const cfg = (pricing = standardLaunchPricing()) =>
  wizardConfigToLaunchConfig(wizard(), {
    userAddress: CREATOR,
    attentionSplits: [],
    numerairePriceUsd: 3000,
    pricing,
  });

/** A price an Elder wallet would have been quoted while the dial was on. */
const elderDiscount = resolveLaunchPricing(
  { tier: 'Elder', state: 'WARM' },
  { tierPricingEnabled: true, table: { ...HEAT_TIER_VENUE_LINE_BPS, Elder: 600, Builder: 900 } },
);

beforeEach(() => {
  vi.clearAllMocks();
  clearGateAudit();
  // The denial is off, so the launch is not stopped by the gate — but the oracle is still
  // dark, which is precisely the state in which a discount must not be minted.
  vi.stubEnv('VITE_HEAT_GATE', 'off');
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe('a discount is re-earned at the moment it is minted', () => {
  it('refuses a config priced below what the live reading supports, before the SDK loads', async () => {
    expect(elderDiscount.venueBps).toBe(600);
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg(elderDiscount)).catch((e) => e)) as LaunchError;

    expect(err).toBeInstanceOf(LaunchError);
    expect(err.code).toBe('invalid-config');
    expect(err.message).toMatch(/Re-review/);
    // Pre-broadcast is a fact here, not a hope: nothing downstream ever ran.
    expect(err.broadcast).toBe(false);
    expect(sdkCtor).not.toHaveBeenCalled();
  });

  it('lets the standard-rate config through — today’s path is untouched by the check', async () => {
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg()).catch((e) => e)) as LaunchError;
    // It gets PAST the pricing check and dies later, inside the stub SDK's builder. The
    // SDK having been CONSTRUCTED is the proof of passage — the refusal is above that line,
    // and both failures land on the same `invalid-config` code so the message is what tells
    // them apart.
    expect(sdkCtor).toHaveBeenCalled();
    expect(err.message).not.toMatch(/Re-review/);
  });

  it('never refuses a config that keeps MORE for the venue than the live price', async () => {
    // Being shown a worse price than the live optimum is the creator's business; the
    // refusal exists for the other direction only.
    const generous = resolveLaunchPricing({ tier: 'Elder', state: 'WARM' }, { tierPricingEnabled: false });
    const dummy = {} as never;
    const err = (await launchToken(dummy, dummy, cfg(generous)).catch((e) => e)) as LaunchError;
    expect(sdkCtor).toHaveBeenCalled();
    expect(err.message).not.toMatch(/Re-review/);
  });
});

describe('the config carries the priced split, not a template', () => {
  it('the deployed constitution is the priced one and still sums to 10000', () => {
    const lines = cfg(elderDiscount).feeConstitution;
    expect(lines.reduce((n, l) => n + l.shareBps, 0)).toBe(10_000);
    expect(lines.filter((l) => l.role === 'protocol-stakers').reduce((n, l) => n + l.shareBps, 0)).toBe(600);
    expect(lines.filter((l) => l.role === 'creator').reduce((n, l) => n + l.shareBps, 0)).toBe(8900);
    expect(lines.filter((l) => l.role === 'doppler').reduce((n, l) => n + l.shareBps, 0)).toBe(500);
  });

  it('omitting the price yields exactly the split every launch ships with today', () => {
    expect(cfg().feeConstitution).toEqual(
      wizardConfigToLaunchConfig(wizard(), { userAddress: CREATOR, attentionSplits: [], numerairePriceUsd: 3000 })
        .feeConstitution,
    );
  });
});
