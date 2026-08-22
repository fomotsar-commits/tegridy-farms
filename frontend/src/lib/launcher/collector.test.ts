import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  collectTokenFacts,
  cloneImplTarget,
  eip1167Target,
  viemChainReader,
  TOKEN_READER_ABI,
  type ChainReader,
  type ReadOnlyPublicClient,
} from './collector';
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

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0xabc0000000000000000000000000000000000abc' as Address;

/**
 * Mock viem PublicClient (ReadOnlyPublicClient subset). `getCode` returns the
 * configured bytecode; `readContract` returns a value per functionName or REVERTS
 * for any name not in `reads` (mirroring a token that doesn't implement it).
 * Every call is captured so tests can assert the adapter's read-only wiring.
 */
function mockPublicClient(cfg: {
  code: Hex | undefined;
  reads?: Record<string, unknown>;
  calls?: { fn: string; address: Address; abiRef: unknown }[];
}): ReadOnlyPublicClient {
  const reads = cfg.reads ?? {};
  return {
    async getCode({ address: _address }) {
      return cfg.code;
    },
    async readContract({ address, abi, functionName }) {
      cfg.calls?.push({ fn: functionName, address, abiRef: abi });
      if (!(functionName in reads)) throw new Error(`execution reverted: no ${functionName}()`);
      return reads[functionName];
    },
  };
}

/** The full DopplerERC20V1 read surface for a clean, renounced, no-float clone. */
const CLEAN_DOPPLER_READS = {
  name: 'Randy',
  symbol: 'RANDY',
  totalSupply: 1_000_000_000n,
  owner: ZERO,
  isBalanceLimitActive: false,
  vestedTotalAmount: 0n,
} as const;

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

describe('viemChainReader — read-only PublicClient adapter', () => {
  it('drives a known-safe DopplerERC20V1 clone end-to-end => flagship', async () => {
    const client = mockPublicClient({ code: soladyCloneCode(IMPL), reads: { ...CLEAN_DOPPLER_READS } });
    const facts = await collectTokenFacts(viemChainReader(client), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.tokenFactory).toBe(DOPPLER_MAINNET.modules.dopplerErc20V1Factory.address);
    expect(facts.powers.mint).toBe(false); // proven-false by construction
    expect(facts.powers.upgrade).toBe(false);
    expect(facts.ownerRenounced).toBe(true); // zero-address owner
    expect(buildFactSheet(facts, defaultGateConfig(NOW)).tier).toBe('flagship');
  });

  it('routes every view read through the shared ABI at the token address (read-only wiring)', async () => {
    const calls: { fn: string; address: Address; abiRef: unknown }[] = [];
    const client = mockPublicClient({ code: soladyCloneCode(IMPL), reads: { ...CLEAN_DOPPLER_READS }, calls });
    await collectTokenFacts(viemChainReader(client), TOKEN, { now: NOW, lockResolver: lockedTwoYears });
    // The Doppler-template path reads the ERC-20 basics plus the two DopplerERC20V1 getters.
    expect(calls.map((c) => c.fn).sort()).toEqual(
      ['isBalanceLimitActive', 'name', 'owner', 'symbol', 'totalSupply', 'vestedTotalAmount'].sort(),
    );
    expect(calls.every((c) => c.address === TOKEN)).toBe(true);
    expect(calls.every((c) => c.abiRef === TOKEN_READER_ABI)).toBe(true);
  });

  it('defaults CLOSED for an unverified/opaque token (non-clone bytecode, reverting reads)', async () => {
    // Opaque runtime that is NOT a recognised minimal-proxy, and every view reverts
    // (the collector's safeRead degrades each to its conservative fallback).
    const client = mockPublicClient({ code: '0x60806040523480156100' as Hex, reads: {} });
    const facts = await collectTokenFacts(viemChainReader(client), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.tokenFactory).toBeNull();
    expect(facts.name).toBe(''); // reverted read => conservative fallback, no fabricated value
    expect(facts.powers.mint).toBe(true); // unverified => dangerous powers reported present
    expect(facts.powers.upgrade).toBe(true);
    expect(buildFactSheet(facts, defaultGateConfig(NOW)).tier).toBe('none');
  });

  it('a Solady clone of a NON-Doppler impl is not vouched for => none', async () => {
    const client = mockPublicClient({
      code: soladyCloneCode('0xdead00000000000000000000000000000000dead'),
      reads: { ...CLEAN_DOPPLER_READS },
    });
    const facts = await collectTokenFacts(viemChainReader(client), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.tokenFactory).toBeNull();
    expect(facts.powers.mint).toBe(true);
    expect(buildFactSheet(facts, defaultGateConfig(NOW)).tier).toBe('none');
  });

  it('a non-contract address (undefined code) collapses to unverified => none', async () => {
    const client = mockPublicClient({ code: undefined, reads: {} });
    const facts = await collectTokenFacts(viemChainReader(client), TOKEN, { now: NOW });
    expect(facts.tokenFactory).toBeNull();
    expect(facts.powers.upgrade).toBe(true);
    expect(buildFactSheet(facts, defaultGateConfig(NOW)).tier).toBe('none');
  });
});

// `safeRead` degrades a failed view call to a conservative fallback. That is right for the
// GATE (a fallback fails the gate, the safe direction) but it erases the difference between
// "read said X" and "read never landed" — and surfaces that publish PROSE invert on that:
// an unread owner becomes null becomes "Ownership renounced."
//
// `unreadFields` is what lets those surfaces tell the two apart, so it has to be recorded.
// A mutation that stopped recording it originally broke NO test — this closes that gap.
describe('collectTokenFacts — unreadFields records which reads did not land', () => {
  const TOKEN = '0xabc0000000000000000000000000000000000abc' as Address;

  /** A reader whose named methods throw, mimicking one 429 inside the Promise.all. */
  // `code` is `Hex`, not `string`: `ChainReader.getCode` returns `Hex | undefined`,
  // so a plain `string` here made the stub something the interface never accepts.
  function flakyReader(failing: string[], code: Hex): ChainReader {
    return {
      async getCode() {
        return code;
      },
      async readToken<T>(_addr: Address, fn: string): Promise<T> {
        if (failing.includes(fn)) throw new Error('HTTP 429');
        const map: Record<string, unknown> = {
          name: 'Mock',
          symbol: 'MOCK',
          totalSupply: 1_000_000_000n,
          owner: '0x00000000000000000000000000000000000000ff',
          isBalanceLimitActive: false,
          vestedTotalAmount: 0n,
        };
        if (!(fn in map)) throw new Error(`unexpected read: ${fn}`);
        return map[fn] as T;
      },
    };
  }

  it('is empty when every read lands', async () => {
    const facts = await collectTokenFacts(mockReader({ code: cloneCode(IMPL) }), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.unreadFields ?? []).not.toContain('owner');
    expect(facts.unreadFields ?? []).not.toContain('totalSupply');
  });

  it('records a throwing owner() — and the fallback would otherwise read as renounced', async () => {
    const facts = await collectTokenFacts(flakyReader(['owner'], cloneCode(IMPL)), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.unreadFields).toContain('owner');
    // The inversion this exists to prevent: a token WITH a live owner reports renounced.
    expect(facts.ownerRenounced).toBe(true);
  });

  it('records a throwing totalSupply() — the fallback would otherwise read as zero float', async () => {
    const facts = await collectTokenFacts(flakyReader(['totalSupply'], cloneCode(IMPL)), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.unreadFields).toContain('totalSupply');
    expect(facts.totalSupply).toBe(0n);
  });

  it('records several failures at once', async () => {
    const facts = await collectTokenFacts(flakyReader(['owner', 'totalSupply'], cloneCode(IMPL)), TOKEN, {
      now: NOW,
      lockResolver: lockedTwoYears,
    });
    expect(facts.unreadFields).toEqual(expect.arrayContaining(['owner', 'totalSupply']));
  });
});
