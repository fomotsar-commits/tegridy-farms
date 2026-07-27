import { describe, it, expect } from 'vitest';
import { keccak256, concat, pad, numberToHex, type Address, type Hex } from 'viem';
import {
  computeV4PoolId,
  buildBoostedStakerDeployParams,
  afterlifeEligibility,
  defaultAfterlifeAddressBook,
  ZERO_ADDRESS,
  type V4PoolKey,
  type AfterlifeAddressBook,
  type AfterlifeLaunch,
} from './afterlife';
import { AFTERLIFE_GAUGE_CONTROLLER_ADDRESS, AFTERLIFE_V4_POSITION_MANAGER_ADDRESS } from './constants';

const TOKEN = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as Address;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const HOOK = '0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044' as Address;
const OWNER = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d' as Address;
const POSMGR = '0x1111111111111111111111111111111111111111' as Address;
const GAUGE = '0x2222222222222222222222222222222222222222' as Address;

// A native-ETH / token full-range pool key (currency0 = ETH = zero address).
const NATIVE_KEY: V4PoolKey = {
  currency0: ZERO_ADDRESS,
  currency1: TOKEN,
  fee: 3000,
  tickSpacing: 60,
  hooks: HOOK,
};

/**
 * Independent reference for `keccak256(abi.encode(poolKey))`: manually left-pad
 * each of the five fields to a 32-byte slot and hash the 160-byte concatenation.
 * This reproduces v4-core's `keccak256(poolKey, 0xa0)` memory layout without
 * reusing viem's `encodeAbiParameters`, so it independently pins the field order
 * and encoding. `int24` sign-extends across the full 256-bit slot.
 */
function referencePoolId(key: V4PoolKey): Hex {
  const slot = (hex: Hex) => pad(hex, { size: 32 });
  const c0 = slot(key.currency0);
  const c1 = slot(key.currency1);
  const fee = slot(numberToHex(BigInt.asUintN(256, BigInt(key.fee))));
  const spacing = slot(numberToHex(BigInt.asUintN(256, BigInt(key.tickSpacing))));
  const hooks = slot(key.hooks);
  return keccak256(concat([c0, c1, fee, spacing, hooks]));
}

describe('computeV4PoolId', () => {
  it('is deterministic (same key -> same id)', () => {
    expect(computeV4PoolId(NATIVE_KEY)).toBe(computeV4PoolId(NATIVE_KEY));
  });

  it('returns a 32-byte hex', () => {
    const id = computeV4PoolId(NATIVE_KEY);
    expect(id).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('matches an independent abi.encode-layout reference (known-vector cross-check)', () => {
    expect(computeV4PoolId(NATIVE_KEY)).toBe(referencePoolId(NATIVE_KEY));
  });

  it('matches the reference for a negative tickSpacing (int24 sign-extension)', () => {
    const key: V4PoolKey = { ...NATIVE_KEY, tickSpacing: -60 };
    expect(computeV4PoolId(key)).toBe(referencePoolId(key));
  });

  it('is sensitive to field ORDER — swapping fee and tickSpacing changes the id', () => {
    const a = computeV4PoolId({ ...NATIVE_KEY, fee: 3000, tickSpacing: 60 });
    const b = computeV4PoolId({ ...NATIVE_KEY, fee: 60, tickSpacing: 3000 });
    expect(a).not.toBe(b);
  });

  it('changes when any single field changes', () => {
    const base = computeV4PoolId(NATIVE_KEY);
    expect(computeV4PoolId({ ...NATIVE_KEY, currency1: WETH })).not.toBe(base);
    expect(computeV4PoolId({ ...NATIVE_KEY, fee: 500 })).not.toBe(base);
    expect(computeV4PoolId({ ...NATIVE_KEY, tickSpacing: 10 })).not.toBe(base);
    expect(computeV4PoolId({ ...NATIVE_KEY, hooks: ZERO_ADDRESS })).not.toBe(base);
  });
});

describe('buildBoostedStakerDeployParams', () => {
  const book: AfterlifeAddressBook = {
    rewardToken: TOKEN,
    staking: '0xcaDc93E96De58EA554c71ca609974625615E046D' as Address,
    positionManager: POSMGR,
    gaugeController: GAUGE,
  };

  it('assembles the 5 constructor args in order, allowedPoolId = computed PoolId', () => {
    const p = buildBoostedStakerDeployParams(NATIVE_KEY, {
      positionManager: POSMGR,
      owner: OWNER,
      addresses: book,
    });
    expect(p.rewardToken).toBe(TOKEN);
    expect(p.staking).toBe(book.staking);
    expect(p.positionManager).toBe(POSMGR);
    expect(p.allowedPoolId).toBe(computeV4PoolId(NATIVE_KEY));
    expect(p.owner).toBe(OWNER);
    expect(p.args).toEqual([TOKEN, book.staking, POSMGR, computeV4PoolId(NATIVE_KEY), OWNER]);
  });

  it('lets rewardToken and staking be overridden explicitly', () => {
    const p = buildBoostedStakerDeployParams(NATIVE_KEY, {
      positionManager: POSMGR,
      owner: OWNER,
      rewardToken: WETH,
      staking: HOOK,
    });
    expect(p.rewardToken).toBe(WETH);
    expect(p.staking).toBe(HOOK);
  });

  it('rejects a zero positionManager (constructor ZeroAddress mirror)', () => {
    expect(() =>
      buildBoostedStakerDeployParams(NATIVE_KEY, { positionManager: ZERO_ADDRESS, owner: OWNER, addresses: book }),
    ).toThrow(/positionManager/);
  });

  it('rejects a zero owner (added guard — would strand admin)', () => {
    expect(() =>
      buildBoostedStakerDeployParams(NATIVE_KEY, { positionManager: POSMGR, owner: ZERO_ADDRESS, addresses: book }),
    ).toThrow(/owner/);
  });

  it('rejects a zero rewardToken / staking', () => {
    expect(() =>
      buildBoostedStakerDeployParams(NATIVE_KEY, {
        positionManager: POSMGR,
        owner: OWNER,
        rewardToken: ZERO_ADDRESS,
      }),
    ).toThrow(/rewardToken/);
    expect(() =>
      buildBoostedStakerDeployParams(NATIVE_KEY, {
        positionManager: POSMGR,
        owner: OWNER,
        staking: ZERO_ADDRESS,
      }),
    ).toThrow(/staking/);
  });

  it('rejects an unsorted pool key (currency0 >= currency1) that would brick the staker', () => {
    const unsorted: V4PoolKey = { ...NATIVE_KEY, currency0: TOKEN, currency1: ZERO_ADDRESS };
    expect(() =>
      buildBoostedStakerDeployParams(unsorted, { positionManager: POSMGR, owner: OWNER, addresses: book }),
    ).toThrow(/sorted currency0 < currency1/);
  });
});

describe('afterlifeEligibility', () => {
  const graduated: AfterlifeLaunch = {
    token: TOKEN,
    tier: 'flagship',
    graduated: true,
    poolKey: NATIVE_KEY,
  };
  const allDeployed: AfterlifeAddressBook = {
    rewardToken: TOKEN,
    staking: '0xcaDc93E96De58EA554c71ca609974625615E046D' as Address,
    positionManager: POSMGR,
    gaugeController: GAUGE,
  };

  const feat = (r: ReturnType<typeof afterlifeEligibility>, f: string) =>
    r.features.find((x) => x.feature === f)!;

  it('not-applicable for a launch that has not graduated', () => {
    const r = afterlifeEligibility({ token: TOKEN, tier: 'flagship', graduated: false }, allDeployed);
    expect(r.graduated).toBe(false);
    expect(feat(r, 'boosted-lp-farming').status).toBe('not-applicable');
    expect(feat(r, 'gauge-application').status).toBe('not-applicable');
    expect(r.anyAvailable).toBe(false);
  });

  it('treats graduated:true with a null poolKey as not graduated', () => {
    const r = afterlifeEligibility({ token: TOKEN, tier: 'flagship', graduated: true, poolKey: null }, allDeployed);
    expect(r.graduated).toBe(false);
    expect(feat(r, 'boosted-lp-farming').status).toBe('not-applicable');
  });

  it('eligible for both features when graduated and all contracts are deployed', () => {
    const r = afterlifeEligibility(graduated, allDeployed);
    expect(feat(r, 'boosted-lp-farming').status).toBe('eligible');
    expect(feat(r, 'gauge-application').status).toBe('eligible');
    expect(r.anyAvailable).toBe(true);
  });

  it('default state: BOTH eligible — PositionManager + GaugeController wired', () => {
    const r = afterlifeEligibility(graduated); // default book: real V4 PositionManager + real GaugeController
    // The V4 PositionManager is now wired -> boosted-LP farming is eligible (infra in place).
    expect(feat(r, 'boosted-lp-farming').status).toBe('eligible');
    expect(feat(r, 'gauge-application').status).toBe('eligible');
    expect(r.anyAvailable).toBe(true);
    // dependency deployed-flags are reported honestly: both true now.
    const pm = feat(r, 'boosted-lp-farming').requires.find((d) => /PositionManager/.test(d.label))!;
    expect(pm.deployed).toBe(true);
    const gc = feat(r, 'gauge-application').requires.find((d) => /GaugeController/.test(d.label))!;
    expect(gc.deployed).toBe(true);
  });

  it('boosted-LP falls back to pending-deployment when the PositionManager is unset', () => {
    // Keeps the honest-gating code path covered even though the default is now wired.
    const book: AfterlifeAddressBook = { ...allDeployed, positionManager: ZERO_ADDRESS };
    const r = afterlifeEligibility(graduated, book);
    expect(feat(r, 'boosted-lp-farming').status).toBe('pending-deployment');
    const pm = feat(r, 'boosted-lp-farming').requires.find((d) => /PositionManager/.test(d.label))!;
    expect(pm.deployed).toBe(false);
  });

  it('gauge pending-deployment while boosted-LP eligible (independent gating)', () => {
    const book: AfterlifeAddressBook = { ...allDeployed, gaugeController: ZERO_ADDRESS };
    const r = afterlifeEligibility(graduated, book);
    expect(feat(r, 'boosted-lp-farming').status).toBe('eligible');
    expect(feat(r, 'gauge-application').status).toBe('pending-deployment');
    expect(r.anyAvailable).toBe(true);
  });

  it('fastTrack reflects flagship tier only', () => {
    expect(afterlifeEligibility(graduated, allDeployed).fastTrack).toBe(true);
    expect(afterlifeEligibility({ ...graduated, tier: 'listable' }, allDeployed).fastTrack).toBe(false);
    expect(afterlifeEligibility({ ...graduated, tier: 'none' }, allDeployed).fastTrack).toBe(false);
  });

  it('default address book: canonical V4 PositionManager + real deployed GaugeController, all non-zero', () => {
    const book = defaultAfterlifeAddressBook();
    // PositionManager = the canonical Uniswap V4 posm (verified on-chain 0xbD21…ee9e).
    expect(book.positionManager).toBe(AFTERLIFE_V4_POSITION_MANAGER_ADDRESS);
    expect(book.positionManager).not.toBe(ZERO_ADDRESS);
    // GaugeController is the real deployed mainnet address (launcher-local, not the
    // app-global gauge gate) — verified from the DeployGaugeController broadcast.
    expect(book.gaugeController).toBe(AFTERLIFE_GAUGE_CONTROLLER_ADDRESS);
    expect(book.gaugeController).not.toBe(ZERO_ADDRESS);
    expect(book.rewardToken).not.toBe(ZERO_ADDRESS);
    expect(book.staking).not.toBe(ZERO_ADDRESS);
  });
});
