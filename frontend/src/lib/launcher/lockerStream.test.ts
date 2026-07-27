import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';

// Keep the read hermetic: the concrete streamableFeesLockerAbi shape is irrelevant to
// the decode logic (the mock client returns canned data), and mocking avoids loading
// the heavy real SDK in the test env. The named export must exist for the dynamic import.
vi.mock('@whetstone-research/doppler-sdk/evm', () => ({ streamableFeesLockerAbi: [] }));

import { poolKeyToId, migrationPoolId, readMigrationStream, lockResolverFor, type MigrationStream } from './lockerStream';
import { DOPPLER_MAINNET } from './doppler.constants';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const HOOK = DOPPLER_MAINNET.support.uniswapV4MigratorHook;
const TOKEN = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as Address;

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
    expect(migrationPoolId(TOKEN)).toBe('0x87063522a2526720953810050237c1b7e117c49939ae6a69ab67e4209f376bf0');
  });

  it('is per-token (different token -> different key)', () => {
    const other = '0x00000000000000000000000000000000000000ab' as Address;
    expect(migrationPoolId(TOKEN)).not.toBe(migrationPoolId(other));
  });

  it('is case-insensitive on the token (checksummed vs lowercase -> same key)', () => {
    expect(migrationPoolId(TOKEN)).toBe(migrationPoolId(TOKEN.toLowerCase() as Address));
  });
});

// A synthetic streams() return in viem's tuple form:
// [poolKey, recipient, startDate, lockDuration, isUnlocked, beneficiaries, positions]
function streamTuple(opts: { currency1?: Address; isUnlocked?: boolean; beneficiaries?: { beneficiary: Address; shares: bigint }[] } = {}) {
  return [
    { currency0: ZERO, currency1: opts.currency1 ?? TOKEN, fee: 3000, tickSpacing: 60, hooks: HOOK },
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

describe('readMigrationStream — the on-chain graduation + fee read', () => {
  it('graduated: decodes beneficiaries, lock state, and unlock time', async () => {
    const s = await readMigrationStream(mockClient(streamTuple()), TOKEN);
    expect(s.graduated).toBe(true);
    expect(s.locker).toBe(DOPPLER_MAINNET.support.streamableFeesLocker);
    expect(s.locked).toBe(true); // isUnlocked === false
    expect(s.unlockAt).toBe(1_700_000_000 + 31_536_000);
    expect(s.beneficiaries.map((b) => b.shares)).toEqual([
      (8000n * 10n ** 18n) / 10_000n,
      (500n * 10n ** 18n) / 10_000n,
      (1500n * 10n ** 18n) / 10_000n,
    ]);
    expect(s.poolId).toBe(migrationPoolId(TOKEN));
  });

  it('isUnlocked === true -> locked false (honest lock state, not hardcoded)', async () => {
    const s = await readMigrationStream(mockClient(streamTuple({ isUnlocked: true })), TOKEN);
    expect(s.graduated).toBe(true);
    expect(s.locked).toBe(false);
  });

  it('REVERTS (no stream / pre-graduation) -> not graduated, empty, never throws', async () => {
    const s = await readMigrationStream(mockClient(null, { throws: true }), TOKEN);
    expect(s.graduated).toBe(false);
    expect(s.beneficiaries).toEqual([]);
    expect(s.locker).toBeNull();
    expect(s.locked).toBe(false);
    expect(s.unlockAt).toBeNull();
  });

  it('DEFENSE: a stream whose poolKey names a DIFFERENT token is rejected (not graduated)', async () => {
    const wrong = '0x00000000000000000000000000000000DeaDBeef' as Address;
    const s = await readMigrationStream(mockClient(streamTuple({ currency1: wrong })), TOKEN);
    expect(s.graduated).toBe(false);
    expect(s.beneficiaries).toEqual([]);
  });
});

describe('lockResolverFor — real LockResolver from an already-read stream', () => {
  it('maps a graduated stream to {locked, locker, unlockAt}', async () => {
    const stream: MigrationStream = {
      graduated: true,
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
    });
  });

  it('maps a not-graduated stream to an unlocked/null lock', async () => {
    const stream: MigrationStream = { graduated: false, poolId: migrationPoolId(TOKEN), locker: null, locked: false, unlockAt: null, beneficiaries: [] };
    await expect(lockResolverFor(stream)(TOKEN)).resolves.toEqual({ locked: false, locker: null, unlockAt: null });
  });
});
