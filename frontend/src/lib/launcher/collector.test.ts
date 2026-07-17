import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import { collectTokenFacts, cloneImplTarget, eip1167Target, type ChainReader } from './collector';
import { buildFactSheet, defaultGateConfig } from './gate';
import { DOPPLER_MAINNET } from './doppler.constants';

const NOW = 1_800_000_000;
const DAY = 86_400;
const IMPL = DOPPLER_MAINNET.support.dopplerErc20V1Impl;

/** EIP-1167 minimal-proxy runtime pointing at `impl`. */
function eip1167Code(impl: Address): Hex {
  const body = impl.slice(2).toLowerCase();
  return `0x363d3d373d3d3d363d73${body}5af43d82803e903d91602b57fd5bf3` as Hex;
}

/** Solady LibClone runtime pointing at `impl` — the layout Doppler ACTUALLY deploys. */
function soladyCloneCode(impl: Address): Hex {
  const body = impl.slice(2).toLowerCase();
  return `0x3d3d3d3d363d3d37363d73${body}5af43d3d93803e602a57fd5bf3` as Hex;
}

/** Default clone helper uses the real Doppler (Solady) layout. */
const cloneCode = soladyCloneCode;

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

describe('cloneImplTarget — recognises both proxy layouts', () => {
  it('parses a canonical EIP-1167 proxy', () => {
    expect(cloneImplTarget(eip1167Code(IMPL))?.toLowerCase()).toBe(IMPL.toLowerCase());
  });
  it('parses a Solady LibClone proxy (the real Doppler layout)', () => {
    expect(cloneImplTarget(soladyCloneCode(IMPL))?.toLowerCase()).toBe(IMPL.toLowerCase());
  });
  it('parses the exact RANDY bytecode observed on the mainnet fork', () => {
    // 0x3d3d3d3d363d3d37363d73 <CloneERC20 impl> 5af43d3d93803e602a57fd5bf3
    const real = '0x3d3d3d3d363d3d37363d73215b2ce3dd8d110394e94a868580d61a77adec4a5af43d3d93803e602a57fd5bf3' as Hex;
    expect(cloneImplTarget(real)?.toLowerCase()).toBe('0x215b2ce3dd8d110394e94a868580d61a77adec4a');
  });
  it('returns null for non-proxy bytecode', () => {
    expect(cloneImplTarget('0x6080604052' as Hex)).toBeNull();
  });
  it('returns null for empty / undefined code (EOA or non-contract)', () => {
    expect(cloneImplTarget('0x' as Hex)).toBeNull();
    expect(cloneImplTarget(undefined)).toBeNull();
  });
  it('legacy eip1167Target still rejects the Solady layout (EIP-1167 only)', () => {
    expect(eip1167Target(soladyCloneCode(IMPL))).toBeNull();
    expect(eip1167Target(eip1167Code(IMPL))?.toLowerCase()).toBe(IMPL.toLowerCase());
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
