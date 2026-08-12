// Post-graduation locker read — the fully-verifiable half of the fee disclosure.
//
// A Tegridy launch's fee split is a set of `streamableFees.beneficiaries` params at
// CREATE time (airlock.ts), but the Doppler StreamableFeesLocker position is only
// created AT GRADUATION. So the truthful, on-chain fee constitution can only be read
// once a token has migrated to its V4 pool. This module derives the migration PoolId
// and reads the locker; launchService.ts's beneficiariesToFeeConstitution turns the
// result back into labelled fee lines.
//
// 🔴 CORRECTED 2026-07-30 — this module previously read `streams(poolId)` and the
// header below asserted V1 "HAS the enumerable streams(bytes32) getter". That was
// BACKWARDS, and it made the whole module inert: the call always reverted, the catch
// reported "not graduated", and no token could ever be attested. Re-probed on mainnet:
//
//   V1 0xe24F…1eC6 (ours)  streams(bytes32) -> REVERT   positions(uint256) -> 128 bytes
//   V2 0xce32…3d47         streams(bytes32) -> data     positions(uint256) -> REVERT
//
// A revert PROVES ABSENCE here: an auto-generated public-mapping getter returns zeros
// for a missing key, it never reverts. Same probe also confirmed V1 has
// `beneficiariesClaims(address,address)`, and does NOT have `currencyBalances` or
// `airlock()`; `owner()`=0x21E2…7A66, `positionManager()`=0xbD21…ee9e.
//
// ⚠ The SDK's exported `streamableFeesLockerAbi` is the **V2** shape. Importing it and
// pointing it at V1 is exactly how the original bug happened — do not re-introduce it.
//
// ⚠ V1 is keyed by the UniV4 position **tokenId (uint256)**, NOT by a PoolId(bytes32).
// The PoolId helpers below are still correct UniV4 math and still worth having (the
// migration pool's id is a real, useful identifier), but they are NOT V1's lookup key.
// Resolving token -> tokenId needs the locker's own Lock event, whose shape is NOT
// derivable from the SDK (the SDK's `Lock` belongs to a different contract) and cannot
// be sampled on-chain today: the uniswapV4->V1 path is DORMANT, V1 holds zero positions
// from the canonical PositionManager. So `readLockPosition` takes the tokenId as an
// argument rather than guessing an event signature — guessing is what produced the bug
// this comment documents.
//
// GROUNDED IN ON-CHAIN READS (2026-07-26 / re-verified 2026-07-30, mainnet):
//   - Our launches use withMigration({type:'uniswapV4'}) -> the SDK's v4Migrator
//     0x0820…205f5, whose IMMUTABLE getters read: migratorHook()=0x4053…E500,
//     locker()=0xe24F…1eC6 (V1 StreamableFeesLocker).
//   - PoolId = keccak256(abi.encode(currency0,currency1,fee:uint24,tickSpacing:int24,
//     hooks)) — canonical UniV4 PoolId.toId; matches the SDK's computePoolId, PROVEN
//     against 3 real on-chain PoolManager Initialize events.
//   - For a native-ETH numeraire (our launches), currency0 is 0x0 and currency1 is the
//     token (isToken0Expected(0)===false; 0x0 is the minimum address).

import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { NATIVE_ETH, MIGRATION_POOL } from './airlock';
import { DOPPLER_MAINNET } from './doppler.constants';
import type { LockResolver } from './collector';

/** The UniV4 PoolKey ABI, in the exact field order PoolId.toId hashes. */
const V4_POOLKEY_ABI = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * Canonical Uniswap V4 PoolId: keccak256(abi.encode(poolKey)). Reimplemented with
 * viem (three lines of standard, non-proprietary hashing) rather than importing the
 * SDK's computePoolId, so it stays pure + synchronously unit-testable and adds no SDK
 * weight to callers. Pinned in lockerStream.test.ts against a REAL on-chain Initialize
 * id, which is a stronger guarantee than matching the SDK.
 */
export function poolKeyToId(k: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters(V4_POOLKEY_ABI, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

/**
 * The migration (graduated) pool's PoolKey for a Tegridy launch of `token` paired
 * against `numeraire` (default native ETH; TOWELI for an exotic launch). V4 sorts the
 * pair numerically, so currency0 = min(numeraire, token) and currency1 = max. For both
 * supported numeraires the numeraire sorts BELOW the token — ETH is 0x0, and the SDK
 * mines the token ABOVE a low-address numeraire like TOWELI (isToken0Expected=false) —
 * so in practice currency0 = numeraire, currency1 = token; the explicit sort keeps it
 * correct regardless. Uses the SAME fee/tickSpacing the launcher commits at create time
 * (MIGRATION_POOL) and the migrator's own hook.
 */
export function migrationPoolKey(token: Address, numeraire: Address = NATIVE_ETH): V4PoolKey {
  // Lowercase so any-case input encodes cleanly (viem rejects a mixed-case non-EIP-55
  // address); the bytes — and thus the PoolId — are identical either way.
  const t = token.toLowerCase() as Address;
  const n = numeraire.toLowerCase() as Address;
  const [currency0, currency1] = BigInt(n) < BigInt(t) ? [n, t] : [t, n];
  return {
    currency0,
    currency1,
    fee: MIGRATION_POOL.fee, // 3000
    tickSpacing: MIGRATION_POOL.tickSpacing, // 60
    hooks: DOPPLER_MAINNET.support.uniswapV4MigratorHook, // v4Migrator.migratorHook() (on-chain verified)
  };
}

/**
 * The migration PoolId for `token` paired against `numeraire` (default native ETH).
 * NOT the auction poolId createDynamicAuction returns.
 */
export function migrationPoolId(token: Address, numeraire: Address = NATIVE_ETH): Hex {
  return poolKeyToId(migrationPoolKey(token, numeraire));
}

/** One on-chain locker beneficiary — address + WAD share (uint96). */
export interface StreamBeneficiaryRaw {
  beneficiary: Address;
  shares: bigint;
}

/** The result of reading the migration stream for a token. */
export interface MigrationStream {
  /** true iff the locker holds a stream for this token's migration pool (i.e. it graduated). */
  graduated: boolean;
  /**
   * true when we could not READ the locker at all, as opposed to having read it and
   * found no stream. Keeping these apart is the whole lesson of this module: for weeks
   * an unreadable surface rendered identically to "has not graduated yet", so a
   * permanently broken call looked like a normal empty state. A caller showing
   * provenance MUST NOT present `unsupported` as a negative finding about the token.
   */
  unsupported?: boolean;
  /** The base pair the read was performed against (native ETH or TOWELI). */
  numeraire: Address;
  /** The derived migration PoolId (returned even when not graduated, for diagnostics). */
  poolId: Hex;
  /** The StreamableFeesLocker holding the stream (null when not graduated). */
  locker: Address | null;
  /** LP-lock state (shape matches collector's LockResolver). locked === !isUnlocked. */
  locked: boolean;
  /** Unix seconds the lock expires (startDate + lockDuration); null when not graduated. */
  unlockAt: number | null;
  /** The REAL on-chain fee beneficiaries, in the locker's stored (address-sorted) order. Empty when not graduated. */
  beneficiaries: StreamBeneficiaryRaw[];
}

/** Minimal read surface — a real viem PublicClient satisfies it; tests supply a mock. */
export interface LockerReadClient {
  // `any` mirrors collector.ts's ReadOnlyPublicClient: a real client's readContract
  // overload infers a literal functionName from the abi and is not assignable to a
  // plain signature, so `any` lets both the real client and a test mock satisfy this.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: any): Promise<unknown>;
}

/** V1 StreamableFeesLocker read surface — PROBED on mainnet, not taken from the SDK. */
export const LOCKER_V1_ABI = [
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'recipient', type: 'address' },
      { name: 'startDate', type: 'uint32' },
      { name: 'lockDuration', type: 'uint32' },
      { name: 'isUnlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'beneficiariesClaims',
    stateMutability: 'view',
    inputs: [
      { name: 'beneficiary', type: 'address' },
      { name: 'currency', type: 'address' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const;

/**
 * Read one locked LP position from the V1 locker by its UniV4 position tokenId.
 *
 * Never throws — a revert (unknown tokenId) resolves to `{ found: false }`. Because
 * `positions` is an auto-generated getter, an unknown key returns ZEROS rather than
 * reverting, so a zero `recipient` is the real "no such position" signal; the try/catch
 * only covers transport failure and a wrong-contract call.
 */
export async function readLockPosition(
  client: LockerReadClient,
  tokenId: bigint,
  locker: Address = DOPPLER_MAINNET.support.streamableFeesLocker,
): Promise<{ found: boolean; recipient: Address | null; locked: boolean; unlockAt: number | null }> {
  const none = { found: false, recipient: null, locked: false, unlockAt: null };
  let raw: unknown;
  try {
    raw = await client.readContract({ address: locker, abi: LOCKER_V1_ABI, functionName: 'positions', args: [tokenId] });
  } catch {
    return none;
  }
  const r = raw as readonly unknown[] | Record<string, unknown> | null;
  if (r == null || typeof r !== 'object') return none;
  const arr = Array.isArray(r);
  const recipient = (arr ? r[0] : (r as Record<string, unknown>).recipient) as Address | undefined;
  const startDate = Number(arr ? r[1] : (r as Record<string, unknown>).startDate);
  const lockDuration = Number(arr ? r[2] : (r as Record<string, unknown>).lockDuration);
  const isUnlocked = Boolean(arr ? r[3] : (r as Record<string, unknown>).isUnlocked);
  // Zero recipient = empty mapping slot = no such position.
  if (!recipient || /^0x0{40}$/i.test(recipient)) return none;
  return {
    found: true,
    recipient,
    locked: !isUnlocked,
    unlockAt: Number.isFinite(startDate + lockDuration) ? startDate + lockDuration : null,
  };
}

/**
 * Read what a published beneficiary has actually accrued in `currency` on the locker.
 *
 * This is the part of post-graduation re-attestation that works TODAY against V1's real
 * surface: we already know the beneficiary addresses (we set them at create time), so
 * reading each one's claim proves the published split is wired to real, funded accounts
 * rather than being a claim on a page. Returns null on any read failure — a missing
 * number must never be rendered as a zero balance.
 */
export async function readBeneficiaryClaim(
  client: LockerReadClient,
  beneficiary: Address,
  currency: Address,
  locker: Address = DOPPLER_MAINNET.support.streamableFeesLocker,
): Promise<bigint | null> {
  try {
    const raw = await client.readContract({
      address: locker,
      abi: LOCKER_V1_ABI,
      functionName: 'beneficiariesClaims',
      args: [beneficiary, currency],
    });
    return typeof raw === 'bigint' ? raw : BigInt(raw as string | number);
  } catch {
    return null;
  }
}

/**
 * Post-graduation stream read.
 *
 * ⛔ NOT IMPLEMENTED against V1, deliberately — see the file header. It requires a
 * token -> position-tokenId mapping that is only recoverable from the locker's own Lock
 * event, whose signature cannot be verified today (the SDK ships V2's ABI, and the V1
 * path is dormant on mainnet so there is no live event to sample).
 *
 * It returns `graduated: false` with `unsupported: true` so callers can tell
 * "we cannot read this yet" apart from "this token has not graduated" — the conflation
 * of those two is precisely what hid the original bug for weeks. It must never return
 * `graduated: true` without a real read.
 */
export async function readMigrationStream(
  _client: LockerReadClient,
  token: Address,
  numeraire: Address = NATIVE_ETH,
): Promise<MigrationStream> {
  return {
    graduated: false,
    unsupported: true,
    numeraire,
    poolId: migrationPoolId(token, numeraire),
    locker: null,
    locked: false,
    unlockAt: null,
    beneficiaries: [],
  };
}

/**
 * Build a collector {@link LockResolver} from an already-read stream — so
 * collectTokenFacts reads the locker ONCE (here) and the same lock state feeds the
 * Fact Sheet, instead of the hardcoded default the pre-graduation attest path uses.
 */
export function lockResolverFor(stream: MigrationStream): LockResolver {
  return async () => ({
    locked: stream.locked,
    locker: stream.locker,
    unlockAt: stream.unlockAt,
    // `unsupported` means readMigrationStream returned its hardcoded shape WITHOUT
    // touching the chain. Passing that through as a plain `locked: false` is what let
    // "Liquidity is not locked" be published — and attested — about a locker nobody
    // queried. Carry the distinction instead of flattening it.
    readable: !stream.unsupported,
  });
}

// `decodeStream` lived here: it normalised the V2 `streams` tuple. Deleted with the
// V2-shaped read it served — keeping a decoder for a function this locker does not have
// is what made the dead call look maintained.
