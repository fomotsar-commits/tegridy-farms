// Post-graduation locker read — the fully-verifiable half of the fee disclosure.
//
// A Tegridy launch's fee split is a set of `streamableFees.beneficiaries` params at
// CREATE time (airlock.ts), but the Doppler StreamableFeesLocker stream is only
// created AT GRADUATION, keyed by the MIGRATION pool's PoolId. So the truthful,
// on-chain fee constitution can only be read once a token has migrated to its V4 pool.
// This module derives that PoolId and reads the locker; launchService.ts's
// beneficiariesToFeeConstitution turns the result back into labelled fee lines.
//
// GROUNDED IN ON-CHAIN READS (2026-07-26, mainnet):
//   - Our launches use withMigration({type:'uniswapV4'}) -> the SDK's v4Migrator
//     0x0820…205f5, whose IMMUTABLE getters read: migratorHook()=0x4053…E500,
//     locker()=0xe24F…1eC6 (the V1 StreamableFeesLocker, which HAS the enumerable
//     streams(bytes32) getter — the V2 locker 0xcE32… does NOT).
//   - PoolId = keccak256(abi.encode(currency0,currency1,fee:uint24,tickSpacing:int24,
//     hooks)) — canonical UniV4 PoolId.toId; matches the SDK's computePoolId, PROVEN
//     against 3 real on-chain PoolManager Initialize events.
//   - For a native-ETH numeraire (our launches), currency0 is 0x0 and currency1 is the
//     token (isToken0Expected(0)===false; 0x0 is the minimum address).
//   - streams(poolId) REVERTS for any key without a stream (pre-graduation, or a
//     mis-derived key). We catch it and report "not graduated". Because keccak256 makes
//     a wrong PoolId revert (never collide with another token's stream), a mis-derivation
//     can only fail SAFE — it can never surface a plausible-but-wrong split.

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

/**
 * Read the StreamableFeesLocker stream for `token`'s migration pool. Never throws:
 * a revert (no stream / pre-graduation) resolves to `{ graduated: false, … }`.
 * The locker ABI comes from the SDK (`streamableFeesLockerAbi`) via a dynamic import
 * so the ~heavy SDK stays a lazy chunk — this is a deliberate, user-triggered read.
 */
export async function readMigrationStream(
  client: LockerReadClient,
  token: Address,
  numeraire: Address = NATIVE_ETH,
): Promise<MigrationStream> {
  const expectedKey = migrationPoolKey(token, numeraire);
  const poolId = poolKeyToId(expectedKey);
  const locker = DOPPLER_MAINNET.support.streamableFeesLocker;
  const notGraduated: MigrationStream = {
    graduated: false,
    numeraire,
    poolId,
    locker: null,
    locked: false,
    unlockAt: null,
    beneficiaries: [],
  };

  let raw: unknown;
  try {
    const { streamableFeesLockerAbi } = await import('@whetstone-research/doppler-sdk/evm');
    raw = await client.readContract({ address: locker, abi: streamableFeesLockerAbi, functionName: 'streams', args: [poolId] });
  } catch {
    // streams(poolId) reverts when no stream exists — the honest "not graduated" signal.
    return notGraduated;
  }

  const decoded = decodeStream(raw);
  if (!decoded) return notGraduated;
  // Defense in depth: the only stream at this exact PoolId is this pool's (keccak256 —
  // a mis-derived key reverts, never collides). Refuse a read whose poolKey does not
  // match BOTH derived currencies (token AND the numeraire we asked for), so a false
  // disclosure is structurally impossible even if the SDK ABI shape or the derivation
  // ever changed underneath us — and so an ETH-pool read can never be mistaken for a
  // TOWELI-pool read (or vice-versa).
  if (
    decoded.currency0.toLowerCase() !== expectedKey.currency0.toLowerCase() ||
    decoded.currency1.toLowerCase() !== expectedKey.currency1.toLowerCase()
  ) {
    return notGraduated;
  }

  return {
    graduated: true,
    numeraire,
    poolId,
    locker,
    locked: !decoded.isUnlocked,
    unlockAt: decoded.startDate + decoded.lockDuration,
    beneficiaries: decoded.beneficiaries,
  };
}

/**
 * Build a collector {@link LockResolver} from an already-read stream — so
 * collectTokenFacts reads the locker ONCE (here) and the same lock state feeds the
 * Fact Sheet, instead of the hardcoded default the pre-graduation attest path uses.
 */
export function lockResolverFor(stream: MigrationStream): LockResolver {
  return async () => ({ locked: stream.locked, locker: stream.locker, unlockAt: stream.unlockAt });
}

/**
 * Normalise viem's `streams` return into just the fields we use. viem returns the 7
 * named outputs as a tuple array [poolKey, recipient, startDate, lockDuration,
 * isUnlocked, beneficiaries, positions]; we also tolerate an object form defensively.
 */
function decodeStream(
  raw: unknown,
): { currency0: Address; currency1: Address; isUnlocked: boolean; startDate: number; lockDuration: number; beneficiaries: StreamBeneficiaryRaw[] } | null {
  if (raw == null || typeof raw !== 'object') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;
  const arr = Array.isArray(r);
  const poolKey = arr ? r[0] : r.poolKey;
  const startDate = arr ? r[2] : r.startDate;
  const lockDuration = arr ? r[3] : r.lockDuration;
  const isUnlocked = arr ? r[4] : r.isUnlocked;
  const beneficiaries = arr ? r[5] : r.beneficiaries;
  if (poolKey == null || !Array.isArray(beneficiaries)) return null;
  const pkArr = Array.isArray(poolKey);
  const currency0 = (pkArr ? poolKey[0] : poolKey.currency0) as Address | undefined;
  const currency1 = (pkArr ? poolKey[1] : poolKey.currency1) as Address | undefined;
  if (!currency0 || !currency1) return null;
  return {
    currency0,
    currency1,
    isUnlocked: Boolean(isUnlocked),
    startDate: Number(startDate),
    lockDuration: Number(lockDuration),
    beneficiaries: beneficiaries.map((b: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const x = b as any;
      return {
        beneficiary: (Array.isArray(x) ? x[0] : x.beneficiary) as Address,
        shares: BigInt(Array.isArray(x) ? x[1] : x.shares),
      };
    }),
  };
}
