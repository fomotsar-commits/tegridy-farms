import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  WETH_MAINNET,
  feeConstitutionToBeneficiaries,
  buildTegridyLaunchParams,
  dopplerBeneficiaryLine,
  type DopplerAuctionBuilder,
  type DopplerEvmSdkLike,
  type TegridyLaunchConfig,
} from './airlock';
import type { FeeConstitutionLine } from './factSheet';

const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const ATTENTION = '0x2222222222222222222222222222222222222222' as Address;
const STAKERS = '0x3333333333333333333333333333333333333333' as Address;

function constitution(): (FeeConstitutionLine & { address: Address })[] {
  return [
    { recipient: 'creator', role: 'creator', shareBps: 6000, address: CREATOR },
    { recipient: 'attention', role: 'attention-beneficiary', shareBps: 1500, address: ATTENTION },
    { recipient: 'stakers/POL', role: 'protocol-stakers', shareBps: 2000, address: STAKERS },
    dopplerBeneficiaryLine(500),
  ];
}

describe('feeConstitutionToBeneficiaries', () => {
  it('converts bps to WAD shares summing to exactly 1e18', () => {
    const b = feeConstitutionToBeneficiaries(constitution());
    const sum = b.reduce((n, x) => n + x.shares, 0n);
    expect(sum).toBe(10n ** 18n);
  });

  it('maps each bps line to bps*1e14 WAD', () => {
    const b = feeConstitutionToBeneficiaries(constitution());
    const creator = b.find((x) => x.beneficiary === CREATOR)!;
    expect(creator.shares).toBe(6000n * 10n ** 14n); // 0.6e18
  });

  it('returns beneficiaries sorted ascending by address', () => {
    const b = feeConstitutionToBeneficiaries(constitution());
    const addrs = b.map((x) => x.beneficiary.toLowerCase());
    expect([...addrs].sort()).toEqual(addrs);
  });

  it('rejects a constitution that does not sum to 10000 bps', () => {
    const bad = constitution();
    bad[0].shareBps = 5000; // now sums to 9000
    expect(() => feeConstitutionToBeneficiaries(bad)).toThrow(/10000 bps/);
  });

  it('rejects a Doppler share below the 5% floor', () => {
    const bad: (FeeConstitutionLine & { address: Address })[] = [
      { recipient: 'creator', role: 'creator', shareBps: 6500, address: CREATOR },
      { recipient: 'attention', role: 'attention-beneficiary', shareBps: 1500, address: ATTENTION },
      { recipient: 'stakers', role: 'protocol-stakers', shareBps: 1900, address: STAKERS },
      dopplerBeneficiaryLine(100), // only 1% — below floor
    ];
    expect(() => feeConstitutionToBeneficiaries(bad)).toThrow(/>= 500 bps/);
  });
});

/** Recording mock of the SDK builder — captures every call for assertion. */
function recordingSdk(): { sdk: DopplerEvmSdkLike; calls: Record<string, unknown> } {
  const calls: Record<string, unknown> = {};
  const builder: DopplerAuctionBuilder = {
    tokenConfig(c) { calls.tokenConfig = c; return builder; },
    saleConfig(c) { calls.saleConfig = c; return builder; },
    withMarketCapRange(c) { calls.marketCap = c; return builder; },
    poolConfig(c) { calls.poolConfig = c; return builder; },
    withMigration(c) { calls.migration = c; return builder; },
    withGovernance(c) { calls.governance = c; return builder; },
    withIntegrator(a) { calls.integrator = a; return builder; },
    withUserAddress(a) { calls.userAddress = a; return builder; },
    build() { calls.built = true; return { ok: true }; },
  };
  const sdk: DopplerEvmSdkLike = {
    buildDynamicAuction: () => builder,
    factory: { createDynamicAuction: async () => ({ hookAddress: CREATOR, tokenAddress: CREATOR, poolId: '0x', transactionHash: CREATOR }) },
  };
  return { sdk, calls };
}

function config(tier: TegridyLaunchConfig['tier']): TegridyLaunchConfig {
  return {
    tier,
    token: { name: 'Tegridy Launch', symbol: 'TGL', tokenURI: 'ipfs://x' },
    initialSupply: 1_000_000_000n,
    numTokensToSell: 900_000_000n,
    marketCap: { start: 30_000, end: 300_000 },
    numerairePriceUsd: 1881,
    minProceeds: 5n * 10n ** 18n,
    maxProceeds: 100n * 10n ** 18n,
    feeConstitution: constitution(),
    integrator: STAKERS,
    lockDurationSeconds: 365 * 24 * 60 * 60,
    userAddress: CREATOR,
  };
}

describe('buildTegridyLaunchParams — policy encoding', () => {
  it('wires WETH numeraire, integrator, V4 migration, and beneficiaries', () => {
    const { sdk, calls } = recordingSdk();
    const params = buildTegridyLaunchParams(sdk, config('flagship'));
    expect(params).toEqual({ ok: true });
    expect((calls.saleConfig as { numeraire: Address }).numeraire).toBe(WETH_MAINNET);
    expect(calls.integrator).toBe(STAKERS);
    const mig = calls.migration as { type: string; streamableFees: { lockDuration: number; beneficiaries: unknown[] } };
    expect(mig.type).toBe('uniswapV4');
    expect(mig.streamableFees.lockDuration).toBe(365 * 24 * 60 * 60);
    expect(mig.streamableFees.beneficiaries).toHaveLength(4);
  });

  it('flagship uses default governance; listable uses noOp', () => {
    const flag = recordingSdk();
    buildTegridyLaunchParams(flag.sdk, config('flagship'));
    expect((flag.calls.governance as { type: string }).type).toBe('default');

    const list = recordingSdk();
    buildTegridyLaunchParams(list.sdk, config('listable'));
    expect((list.calls.governance as { type: string }).type).toBe('noOp');
  });

  it('propagates the market-cap band and proceeds bounds', () => {
    const { sdk, calls } = recordingSdk();
    buildTegridyLaunchParams(sdk, config('flagship'));
    const mc = calls.marketCap as { marketCap: { start: number; end: number }; minProceeds: bigint };
    expect(mc.marketCap).toEqual({ start: 30_000, end: 300_000 });
    expect(mc.minProceeds).toBe(5n * 10n ** 18n);
  });
});
