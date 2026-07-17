import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import { collectTokenFacts, eip1167Target, type ChainReader } from './collector';
import { buildFactSheet, defaultGateConfig } from './gate';
import { DOPPLER_MAINNET } from './doppler.constants';

const NOW = 1_800_000_000;
const DAY = 86_400;
const IMPL = DOPPLER_MAINNET.support.dopplerErc20V1Impl;

/** Build the runtime bytecode of an EIP-1167 minimal proxy pointing at `impl`. */
function cloneCode(impl: Address): Hex {
  const body = impl.slice(2).toLowerCase();
  return `0x363d3d373d3d3d363d73${body}5af43d82803e903d91602b57fd5bf3` as Hex;
}

/** Mock reader: a Doppler clone with configurable balance-limit / vesting / owner. */
function mockReader(cfg: {
  code: Hex | undefined;
  owner?: Address;
  totalSupply?: bigint;
  vestedTotal?: bigint;
  balanceLimitActive?: boolean;
}): ChainReader {
  return {
    async getCode() {
      return cfg.code;
    },
    async readToken<T>(_addr: Address, fn: string): Promise<T> {
      const map: Record<string, unknown> = {
        name: 'Mock',
        symbol: 'MOCK',
        totalSupply: cfg.totalSupply ?? 1_000_000_000n,
        owner: cfg.owner ?? '0x0000000000000000000000000000000000000000',
        isBalanceLimitActive: cfg.balanceLimitActive ?? false,
        vestedTotalAmount: cfg.vestedTotal ?? 0n,
      };
      if (!(fn in map)) throw new Error(`unexpected read: ${fn}`);
      return map[fn] as T;
    },
  };
}

const lockedTwoYears = async () => ({
  locked: true,
  locker: DOPPLER_MAINNET.support.streamableFeesLocker,
  unlockAt: NOW + 730 * DAY,
});

describe('eip1167Target', () => {
  it('extracts the implementation address from a minimal proxy', () => {
    expect(eip1167Target(cloneCode(IMPL))?.toLowerCase()).toBe(IMPL.toLowerCase());
  });
  it('returns null for non-proxy bytecode', () => {
    expect(eip1167Target('0x6080604052' as Hex)).toBeNull();
  });
  it('returns null for empty / undefined code (EOA or non-contract)', () => {
    expect(eip1167Target('0x' as Hex)).toBeNull();
    expect(eip1167Target(undefined)).toBeNull();
  });
});

describe('collectTokenFacts — Doppler template provenance', () => {
  it('recognises a DopplerERC20V1 clone and marks dangerous powers false', async () => {
    const reader = mockReader({ code: cloneCode(IMPL) });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.tokenFactory).toBe(DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address);
    expect(facts.powers.mint).toBe(false);
    expect(facts.powers.upgrade).toBe(false);
    expect(facts.ownerRenounced).toBe(true); // zero-address owner
  });

  it('end-to-end: a clean Doppler clone with locked LP and no team float => flagship', async () => {
    const reader = mockReader({ code: cloneCode(IMPL) });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tier).toBe('flagship');
  });

  it('computes team allocation bps from on-chain vested total (and marks it fully vested)', async () => {
    const reader = mockReader({ code: cloneCode(IMPL), totalSupply: 1_000_000_000n, vestedTotal: 150_000_000n });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', { now: NOW, lockResolver: lockedTwoYears });
    expect(facts.teamAllocationBps).toBe(1500); // 15%
    expect(facts.teamAllocationVestedBps).toBe(1500); // vestedTotalAmount is by-definition on-chain vested
    // 15% insider float is over the 20%? no — under. still flagship.
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tier).toBe('flagship');
  });

  it('a 30% vested float trips only the flagship insider cap => listable', async () => {
    const reader = mockReader({ code: cloneCode(IMPL), totalSupply: 1_000_000_000n, vestedTotal: 300_000_000n });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', { now: NOW, lockResolver: lockedTwoYears });
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tier).toBe('listable');
  });
});

describe('collectTokenFacts — unverified template defaults closed', () => {
  it('a non-Doppler contract reports dangerous powers present => gate none', async () => {
    const reader = mockReader({ code: cloneCode('0xdead00000000000000000000000000000000dead') });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.tokenFactory).toBeNull();
    expect(facts.powers.mint).toBe(true); // conservative
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tier).toBe('none');
  });

  it('a non-contract address (no code) is treated as unverified', async () => {
    const reader = mockReader({ code: '0x' });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', { now: NOW });
    expect(facts.tokenFactory).toBeNull();
    expect(facts.powers.upgrade).toBe(true);
  });

  it('an unresolved LP lock leaves liquidity unlocked (fails the gate)', async () => {
    const reader = mockReader({ code: cloneCode(IMPL) });
    const facts = await collectTokenFacts(reader, '0xabc0000000000000000000000000000000000abc', { now: NOW });
    // default lock resolver => not locked
    expect(facts.liquidity.locked).toBe(false);
    const sheet = buildFactSheet(facts, defaultGateConfig(NOW));
    expect(sheet.tier).toBe('none');
  });
});
