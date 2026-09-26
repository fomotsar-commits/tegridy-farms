// The pool a graduated launch trades in, read from where the LAUNCH says it is.
//
// The pool program's standard address for a pair
// (`["pool", amm_config, mint0, mint1]`) is NOT used: pool creation there is
// permissionless, so anyone can open a pool at that address first, with their own
// price. The launch program instead creates its pool at an address only it can sign
// for (`["launchpool", mint]` under the launch program) and records it on the curve.
// So this reads `curve.pool`, requires it to be that derivation, and then checks
// every field of the pool against what graduation writes. Any difference is a
// `mismatch` and no swap is offered.
//
// The fee settings are the POOL'S OWN (`pool.amm_config`), not the launch program's
// current `global.amm_config`: the operator can change the global one for future
// graduations, and a pool keeps the one it was created with forever. cp-swap only
// accepts a swap that names the pool's own (`address = pool_state.amm_config`).

import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  poolStatePda,
  type BondingCurve,
  type GlobalConfig,
} from '../curve/program';
import { clipDetail, type CurveRpc, type Read } from '../curve/read';
import {
  decodeAmmConfig,
  decodePoolState,
  deriveLpMint,
  deriveObservation,
  deriveVault,
  sortMints,
  swapEnabled,
  type AmmConfigView,
} from '../../../solana/cpswap/program';
import { readPoolAt, type PoolSnapshot } from '../../../solana/cpswap/read';
import type { CurveWriteConfig } from '../write/types';

export interface LaunchPool {
  address: PublicKey;
  snapshot: PoolSnapshot;
  /** The pool's own fee settings account (`pool.amm_config`), owned by cp-swap. */
  ammConfigAddress: PublicKey;
  ammConfig: AmmConfigView;
  /**
   * The CLUSTER's clock (unix seconds) when this was read, or null if not read. The
   * pool opens by the chain's clock, not the viewer's: a validator can run a minute
   * ahead of a laptop, and a laptop's clock can be anything. Missing = not read.
   */
  chainTime?: bigint | null;
}

const CLOCK_SYSVAR = new PublicKey('SysvarC1ock11111111111111111111111111111111');

/** The cluster's `unix_timestamp` from the Clock sysvar, or null when it cannot be read. */
export async function readChainTime(rpc: CurveRpc): Promise<bigint | null> {
  try {
    const a = await rpc.getAccountInfo(CLOCK_SYSVAR);
    if (!a || a.data.length < 40) return null;
    return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigInt64(32, true);
  } catch {
    return null;
  }
}

export type LaunchPoolRead =
  | Read<LaunchPool>
  | { kind: 'not-a-pool'; address: string }
  /** The curve has not graduated, so there is no pool yet. */
  | { kind: 'not-graduated' }
  /** A pool is there but something about it is not what graduation writes. Offer nothing. */
  | { kind: 'mismatch'; detail: string }
  /** The pool is right but not taking swaps (switched off, or not open yet). */
  | { kind: 'closed-to-swaps'; detail: string; value: LaunchPool };

export async function readLaunchPool(
  rpc: CurveRpc,
  cfg: CurveWriteConfig,
  mint: PublicKey,
  curve: BondingCurve,
  global: GlobalConfig,
  /** Override for tests. By default the cluster's own clock is read. */
  nowSecs?: number,
): Promise<LaunchPoolRead> {
  if (!curve.complete) return { kind: 'not-graduated' };
  if (!curve.mint.equals(mint)) return { kind: 'mismatch', detail: 'the curve read belongs to a different token' };

  const expected = poolStatePda(mint, cfg.programId);
  if (!curve.pool.equals(expected)) {
    return { kind: 'mismatch', detail: 'the curve records a pool at an address the launch program would not use' };
  }

  const cp = cfg.cpSwapProgram;
  // Check the pool's own fields BEFORE following any address it names: a pool whose
  // vault field points somewhere else must read as a mismatch, not as "no vault".
  let raw;
  try {
    raw = await rpc.getAccountInfo(expected);
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
  if (!raw) return { kind: 'absent' };
  if (!raw.owner.equals(cp)) return { kind: 'not-a-pool', address: expected.toBase58() };
  const p = decodePoolState(expected.toBase58(), raw.data);
  if (!p) return { kind: 'not-a-pool', address: expected.toBase58() };

  const { token0, token1 } = sortMints(WSOL_MINT, mint);
  const want: Array<[string, PublicKey, string]> = [
    [p.token0Mint, token0, 'the pool trades a different pair of tokens'],
    [p.token1Mint, token1, 'the pool trades a different pair of tokens'],
    [p.token0Vault, deriveVault(cp, expected, token0), 'a pool vault is at an unexpected address'],
    [p.token1Vault, deriveVault(cp, expected, token1), 'a pool vault is at an unexpected address'],
    [p.observationKey, deriveObservation(cp, expected), 'the pool price record is at an unexpected address'],
    [p.lpMint, deriveLpMint(cp, expected), 'the pool share token is at an unexpected address'],
    [p.token0Program, TOKEN_PROGRAM_ID, 'the pool uses an unexpected token program'],
    [p.token1Program, TOKEN_PROGRAM_ID, 'the pool uses an unexpected token program'],
  ];
  for (const [got, w, why] of want) if (got !== w.toBase58()) return { kind: 'mismatch', detail: why };

  // `global` is only needed for what graduation fixed at the time: the pair, the
  // addresses. The fee settings are read from the pool itself (see the header).
  void global;

  const r = await readPoolAt(rpc, cp, expected);
  if (r.kind !== 'ok') return r;

  const cfgRead = await readPoolAmmConfig(rpc, cp, r.value.pool.ammConfig);
  if (cfgRead.kind !== 'ok') return cfgRead;

  const chainTime = nowSecs !== undefined ? BigInt(nowSecs) : await readChainTime(rpc);
  const value: LaunchPool = { address: expected, snapshot: r.value, ammConfigAddress: cfgRead.address, ammConfig: cfgRead.value, chainTime };
  if (!swapEnabled(p)) return { kind: 'closed-to-swaps', detail: 'swaps are switched off on this pool', value };
  if (p.openTime > 0n) {
    // Graduation opens the pool one second after it is created, by the chain's clock.
    if (chainTime === null) return { kind: 'unreadable', detail: 'the network clock could not be read to check the pool is open' };
    if (chainTime < p.openTime) return { kind: 'closed-to-swaps', detail: 'this pool is not open for swaps yet', value };
  }
  return { kind: 'ok', value };
}

/** The pool's own fee settings: must exist, be owned by cp-swap, and decode. */
async function readPoolAmmConfig(
  rpc: CurveRpc,
  cp: PublicKey,
  address58: string,
): Promise<
  | { kind: 'ok'; address: PublicKey; value: AmmConfigView }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'unreadable'; detail: string }
> {
  let address: PublicKey;
  try {
    address = new PublicKey(address58);
  } catch {
    return { kind: 'mismatch', detail: 'the pool names fee settings at an address that is not valid' };
  }
  let ammConfig: AmmConfigView | null;
  try {
    const a = await rpc.getAccountInfo(address);
    if (!a) return { kind: 'mismatch', detail: 'the pool’s fee settings account does not exist' };
    if (!a.owner.equals(cp)) return { kind: 'mismatch', detail: 'the pool’s fee settings account is not owned by the pool program' };
    ammConfig = decodeAmmConfig(address.toBase58(), a.data);
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
  if (!ammConfig) return { kind: 'unreadable', detail: 'the pool’s fee settings could not be read' };
  return { kind: 'ok', address, value: ammConfig };
}

/**
 * The same pool, read again NOW: its state, both vault balances, its fee settings
 * and the chain clock. A swap is quoted from this, never from the copy the page
 * loaded, which may be minutes old (a stale quote either blocks every trade or sets
 * the minimum far below the fair output, which a sandwich takes).
 *
 * The fields graduation fixed (pair, vaults, fee settings account, price record)
 * cannot change on chain; if the fresh read disagrees with the verified copy, the
 * answer is a mismatch and nothing is offered.
 */
export async function refreshLaunchPool(
  rpc: CurveRpc,
  cpSwapProgram: PublicKey,
  verified: LaunchPool,
): Promise<{ kind: 'ok'; value: LaunchPool } | { kind: 'failed'; detail: string }> {
  let r;
  try {
    r = await readPoolAt(rpc, cpSwapProgram, verified.address);
  } catch (e) {
    return { kind: 'failed', detail: `the pool could not be read again (${clipDetail(e)})` };
  }
  if (r.kind !== 'ok') {
    return { kind: 'failed', detail: r.kind === 'unreadable' ? `the pool could not be read again (${r.detail})` : 'the pool could not be read again' };
  }
  const a = verified.snapshot.pool;
  const b = r.value.pool;
  const fixed: Array<keyof typeof a> = ['ammConfig', 'token0Mint', 'token1Mint', 'token0Vault', 'token1Vault', 'observationKey', 'lpMint', 'token0Program', 'token1Program'];
  if (b.ammConfig !== verified.ammConfigAddress.toBase58() || fixed.some((k) => a[k] !== b[k])) {
    return { kind: 'failed', detail: 'the pool no longer matches the one this page checked' };
  }
  const cfgRead = await readPoolAmmConfig(rpc, cpSwapProgram, b.ammConfig);
  if (cfgRead.kind !== 'ok') return { kind: 'failed', detail: cfgRead.detail };
  const chainTime = await readChainTime(rpc);
  return {
    kind: 'ok',
    value: { address: verified.address, snapshot: r.value, ammConfigAddress: cfgRead.address, ammConfig: cfgRead.value, chainTime },
  };
}
