import { describe, it, expect, vi } from 'vitest';
import { toFunctionSelector, type Address } from 'viem';

// Keep the read hermetic: the concrete streamableFeesLockerAbi shape is irrelevant to
// the decode logic (the mock client returns canned data), and mocking avoids loading
// the heavy real SDK in the test env. The named export must exist for the dynamic import.
vi.mock('@whetstone-research/doppler-sdk/evm', () => ({ streamableFeesLockerAbi: [] }));

import {
  poolKeyToId,
  migrationPoolId,
  readMigrationStream,
  readLockPosition,
  readBeneficiaryClaim,
  lockResolverFor,
  LOCKER_V1_ABI,
  type MigrationStream,
} from './lockerStream';
import { DOPPLER_MAINNET } from './doppler.constants';
import { ETH_NUMERAIRE, TOWELI_NUMERAIRE } from './config';
import { DEPLOYED_LOCKER_V1, DEPLOYED_LOCKER_V2 } from './lockerSelectors.fixture';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const HOOK = DOPPLER_MAINNET.support.uniswapV4MigratorHook;
const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
// A token mined ABOVE TOWELI (0x42…), so a TOWELI pool sorts currency0=TOWELI, currency1=token.
const TOKEN_ABOVE_TOWELI = '0x9999999999999999999999999999999999999999' as Address;

describe('poolKeyToId — canonical UniV4 PoolId', () => {
  it('matches a REAL on-chain PoolManager Initialize id (encoding pinned to mainnet)', () => {
    // asset 0xa9EBf7…, WETH-paired dopplerHook migration pool, block 25096286:
    // Initialize emitted id 0x6ad0…e492 for this exact poolKey. If our abi.encode field
    // order/types ever drift, this fails — the strongest possible pin.
    const id = poolKeyToId({
      currency0: '0xa9EBf73DFD02BE43202cae2f65803001a772e1C8',
      currency1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      fee: 10000,
      tickSpacing: 200,
      hooks: '0x1E40b0875DDa35f41E15cFB475403859B8c860c4',
    });
    expect(id).toBe('0x6ad0e8f46ee424e4a7617f3700243d355efb2bd90c70c0cf3bb3361967f1e492');
  });
});

describe('migrationPoolId — the graduated pool key for a native-ETH launch', () => {
  it('composes poolKeyToId with {0x0, token, fee 3000, ts 60, migratorHook}', () => {
    expect(migrationPoolId(TOKEN)).toBe(
      poolKeyToId({ currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: HOOK }),
    );
  });

  it('regression pin — a change to fee/tickSpacing/hook would move the key off the real stream', () => {
    expect(migrationPoolId(TOKEN)).toBe('0x532936d8e9d38be3535f09a81f69ba659a54f3c1e47d76cec47e8b9023783a82');
  });

  it('is per-token (different token -> different key)', () => {
    const other = '0x00000000000000000000000000000000000000ab' as Address;
    expect(migrationPoolId(TOKEN)).not.toBe(migrationPoolId(other));
  });

  it('is case-insensitive on the token (checksummed vs lowercase -> same key)', () => {
    expect(migrationPoolId(TOKEN)).toBe(migrationPoolId(TOKEN.toLowerCase() as Address));
  });

  it('is numeraire-aware: token/TOWELI is a DIFFERENT pool than token/ETH', () => {
    expect(migrationPoolId(TOKEN_ABOVE_TOWELI, TOWELI_NUMERAIRE)).not.toBe(migrationPoolId(TOKEN_ABOVE_TOWELI));
    // sorts {TOWELI, token} -> currency0=TOWELI (lower), currency1=token
    expect(migrationPoolId(TOKEN_ABOVE_TOWELI, TOWELI_NUMERAIRE)).toBe(
      poolKeyToId({
        currency0: TOWELI_NUMERAIRE.toLowerCase() as Address,
        currency1: TOKEN_ABOVE_TOWELI.toLowerCase() as Address,
        fee: 3000,
        tickSpacing: 60,
        hooks: HOOK,
      }),
    );
  });
});

// A synthetic streams() return in viem's tuple form:
// [poolKey, recipient, startDate, lockDuration, isUnlocked, beneficiaries, positions]
function streamTuple(opts: { currency0?: Address; currency1?: Address; isUnlocked?: boolean; beneficiaries?: { beneficiary: Address; shares: bigint }[] } = {}) {
  return [
    { currency0: opts.currency0 ?? ZERO, currency1: opts.currency1 ?? TOKEN, fee: 3000, tickSpacing: 60, hooks: HOOK },
    '0x000000000000000000000000000000000000dEaD',
    1_700_000_000, // startDate
    31_536_000, // lockDuration = 365d
    opts.isUnlocked ?? false,
    opts.beneficiaries ?? [
      { beneficiary: '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address, shares: (8000n * 10n ** 18n) / 10_000n },
      { beneficiary: DOPPLER_MAINNET.airlockOwner, shares: (500n * 10n ** 18n) / 10_000n },
      { beneficiary: '0xF993316E2fC079de4358c489A935E01e03E23E17' as Address, shares: (1500n * 10n ** 18n) / 10_000n },
    ],
    [], // positions
  ];
}

function mockClient(result: unknown, opts: { throws?: boolean } = {}) {
  return {
    readContract: vi.fn(async () => {
      if (opts.throws) throw new Error('execution reverted');
      return result;
    }),
  };
}

// ── The regression these tests exist to prevent ─────────────────────────────────────
// The PREVIOUS version of this block mocked a `streams(poolId)` return and asserted
// `graduated: true`. Every one of those tests passed — while production was permanently
// broken, because V1 has no `streams` function at all and the mock was feeding V2-shaped
// data the real contract never returns. Green tests over a fiction.
// So: assert against the surface PROBED on mainnet, and assert the honest states.
describe('readMigrationStream — must not claim graduation it cannot read', () => {
  it('reports unsupported rather than a negative finding about the token', async () => {
    const s = await readMigrationStream(mockClient(null), TOKEN);
    expect(s.unsupported).toBe(true);
    expect(s.graduated).toBe(false);
    expect(s.beneficiaries).toEqual([]);
    expect(s.locker).toBeNull();
  });

  it('still returns the correct migration PoolId for diagnostics', async () => {
    const s = await readMigrationStream(mockClient(null), TOKEN);
    expect(s.poolId).toBe(migrationPoolId(TOKEN));
    const t = await readMigrationStream(mockClient(null), TOKEN_ABOVE_TOWELI, TOWELI_NUMERAIRE);
    expect(t.poolId).toBe(migrationPoolId(TOKEN_ABOVE_TOWELI, TOWELI_NUMERAIRE));
    expect(t.numeraire).toBe(TOWELI_NUMERAIRE);
  });

  it('NEVER reports graduated:true — a fabricated split is the failure to avoid', async () => {
    for (const canned of [streamTuple(), null, undefined, {}, []]) {
      const s = await readMigrationStream(mockClient(canned), TOKEN);
      expect(s.graduated).toBe(false);
    }
  });
});

describe('LOCKER_V1_ABI — pinned to the mainnet-probed surface', () => {
  it('declares positions(uint256) with the 4 outputs V1 actually returns', () => {
    const fn = LOCKER_V1_ABI.find((f) => f.name === 'positions');
    expect(fn?.inputs.map((i) => i.type)).toEqual(['uint256']);
    expect(fn?.outputs.map((o) => o.type)).toEqual(['address', 'uint32', 'uint32', 'bool']);
  });

  it('declares beneficiariesClaims(address,address) and NO streams()', () => {
    expect(LOCKER_V1_ABI.find((f) => f.name === 'beneficiariesClaims')?.inputs.map((i) => i.type))
      .toEqual(['address', 'address']);
    // V1 has no streams(); re-adding it is the original bug.
    //
    // Compared as `string`, not against the ABI's literal name union: today that
    // union is exactly `'positions' | 'beneficiariesClaims'`, so `=== 'streams'`
    // is a comparison the compiler settles statically (TS2367). The runtime check
    // is the point and is unchanged — it is what goes red the moment someone puts
    // `streams` back.
    expect(LOCKER_V1_ABI.map((f): string => f.name)).not.toContain('streams');
  });
});

// ── The ONLY assertions in this file that a mock cannot fake ─────────────────────────
// Everything above feeds the module canned data, so it can prove the decode logic
// self-consistent and nothing more — it cannot notice that the deployed contract has no
// such function. That blind spot IS the bug this module shipped: `readMigrationStream`
// called `streams(bytes32)` on a locker that never had one, every test passed, every
// call reverted, and the catch reported "not graduated" forever.
//
// These compare the hand-rolled ABI against the real mainnet runtime bytecode captured
// in lockerSelectors.fixture.ts, so re-declaring a function V1 does not have fails here
// even while every mocked test above stays green.
describe('LOCKER_V1_ABI — pinned to the DEPLOYED bytecode, not to a mock', () => {
  const v1 = new Set<string>(DEPLOYED_LOCKER_V1.selectors);
  const v2 = new Set<string>(DEPLOYED_LOCKER_V2.selectors);
  // Derived from the signature, never hardcoded: editing the ABI recomputes these, so
  // this pins the invariant ("what we call must exist") rather than a literal.
  const STREAMS = toFunctionSelector('streams(bytes32)');
  const POSITIONS = toFunctionSelector('positions(uint256)');

  it('captures the locker the module actually calls', () => {
    // A fixture for a different address would police nothing.
    expect(DEPLOYED_LOCKER_V1.address.toLowerCase())
      .toBe(DOPPLER_MAINNET.support.streamableFeesLocker.toLowerCase());
  });

  it('every function we declare exists on the deployed V1 locker', () => {
    const declared = LOCKER_V1_ABI.map((f) => ({ name: f.name, selector: toFunctionSelector(f) }));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((f) => !v1.has(f.selector))).toEqual([]);
  });

  it('V1 does NOT dispatch streams(bytes32) — the call that was silently reverting', () => {
    // Absence from the walk is strong evidence rather than a proof (a 0x00000000
    // selector is matched by a bare ISZERO with no PUSH4). For THIS selector it was
    // confirmed by a live eth_call, recorded in the fixture header.
    expect(v1.has(STREAMS)).toBe(false);
  });

  // NON-VACUITY. If the fixture were empty or captured from the wrong contract, the
  // assertion above would pass for the wrong reason. V1 and V2 are exactly
  // complementary, so proving the selector lives on the SIBLING proves the sets are real.
  it('streams(bytes32) IS on V2 — so its absence from V1 is a finding, not an empty set', () => {
    expect(v2.has(STREAMS)).toBe(true);
    expect(v2.has(POSITIONS)).toBe(false);
    expect(v1.has(POSITIONS)).toBe(true);
  });

  it('retargeting to V2 would be the WRONG fix — the migrator points at V1', () => {
    // Recorded here because "just use V2, it has streams()" is the tempting wrong turn:
    // v4Migrator.locker() returns V1, so a V2-shaped read would be reading a locker our
    // launches never touch.
    expect(DEPLOYED_LOCKER_V2.address.toLowerCase())
      .not.toBe(DOPPLER_MAINNET.support.streamableFeesLocker.toLowerCase());
  });
});

describe('readLockPosition — V1 positions(tokenId)', () => {
  it('decodes a live position into lock state and unlock time', async () => {
    const client = mockClient(['0x000000000000000000000000000000000000BEEF', 1_700_000_000, 31_536_000, false]);
    const p = await readLockPosition(client, 42n);
    expect(p.found).toBe(true);
    expect(p.locked).toBe(true);
    expect(p.unlockAt).toBe(1_700_000_000 + 31_536_000);
  });

  it('isUnlocked true -> locked false', async () => {
    const client = mockClient(['0x000000000000000000000000000000000000BEEF', 1n, 2n, true]);
    expect((await readLockPosition(client, 42n)).locked).toBe(false);
  });

  // The getter returns ZEROS for an unknown key rather than reverting, so a zero
  // recipient — not an exception — is the real "no such position" signal.
  it('treats a zero recipient as absent, not as a real position', async () => {
    const client = mockClient([ZERO, 0, 0, false]);
    expect((await readLockPosition(client, 999n)).found).toBe(false);
  });

  it('never throws on revert or junk', async () => {
    expect((await readLockPosition(mockClient(null, { throws: true }), 1n)).found).toBe(false);
    for (const junk of [null, undefined, 'nope', 5]) {
      await expect(readLockPosition(mockClient(junk), 1n)).resolves.toMatchObject({ found: false });
    }
  });
});

describe('readBeneficiaryClaim — what a published beneficiary actually accrued', () => {
  it('returns the claim amount', async () => {
    await expect(readBeneficiaryClaim(mockClient(1234n), TOKEN, ZERO)).resolves.toBe(1234n);
  });

  // null, not 0 — rendering an unread balance as zero would understate what a
  // beneficiary is owed on a page whose whole purpose is disclosure.
  it('returns null (not 0) when the read fails', async () => {
    await expect(readBeneficiaryClaim(mockClient(null, { throws: true }), TOKEN, ZERO)).resolves.toBeNull();
  });
});

describe('lockResolverFor — real LockResolver from an already-read stream', () => {
  it('maps a graduated stream to {locked, locker, unlockAt}', async () => {
    const stream: MigrationStream = {
      graduated: true,
      numeraire: ETH_NUMERAIRE,
      poolId: migrationPoolId(TOKEN),
      locker: DOPPLER_MAINNET.support.streamableFeesLocker,
      locked: true,
      unlockAt: 1_800_000_000,
      beneficiaries: [],
    };
    await expect(lockResolverFor(stream)(TOKEN)).resolves.toEqual({
      locked: true,
      locker: DOPPLER_MAINNET.support.streamableFeesLocker,
      unlockAt: 1_800_000_000,
      // A real read happened, so the sheet may state what it found.
      readable: true,
    });
  });

  it('maps a not-graduated stream to an unlocked/null lock', async () => {
    const stream: MigrationStream = { graduated: false, numeraire: ETH_NUMERAIRE, poolId: migrationPoolId(TOKEN), locker: null, locked: false, unlockAt: null, beneficiaries: [] };
    await expect(lockResolverFor(stream)(TOKEN)).resolves.toEqual({ locked: false, locker: null, unlockAt: null, readable: true });
  });

  it('marks an UNSUPPORTED stream unreadable — "we did not ask" is not "not locked"', async () => {
    // This is the live EVM state: readMigrationStream returns `unsupported: true` with a
    // hardcoded locked:false, having touched no chain. Flattening that into a plain
    // `locked: false` is what let the fact sheet publish — and ATTEST, via
    // canonicalDisclosuresJson -> disclosuresDigest — "Liquidity is not locked; it may be
    // withdrawable by the liquidity owner." about a locker nobody queried.
    const stream: MigrationStream = {
      graduated: false,
      unsupported: true,
      numeraire: ETH_NUMERAIRE,
      poolId: migrationPoolId(TOKEN),
      locker: null,
      locked: false,
      unlockAt: null,
      beneficiaries: [],
    };
    await expect(lockResolverFor(stream)(TOKEN)).resolves.toMatchObject({ readable: false });
  });
});
