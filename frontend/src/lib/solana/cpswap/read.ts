import { PublicKey } from '@solana/web3.js';
import {
  readDeployment,
  clipDetail,
  type CurveRpc,
  type Deployment,
  type Read,
} from '../../launcher/solana/curve/read';
import {
  LIVE_PROGRAM_ID,
  DEFAULT_AMM_CONFIG_INDEX,
  deriveAmmConfig,
  derivePool,
  deriveVault,
  decodeAmmConfig,
  decodePoolState,
  sortMints,
  swapEnabled,
  isCreatorFeeOnInput,
  type AmmConfigView,
  type PoolStateView,
} from './program';
import {
  swapBaseInput,
  vaultAmountWithoutFee,
  lpTokensToTradingTokens,
  type SwapResult,
} from './math';

/**
 * Reads for the venue's own AMM, and the quote built on top of them.
 *
 * REUSED, NOT REBUILT: the account-fetch seam, the `Read` result shape and
 * `readDeployment` all come from the bonding-curve client
 * (`lib/launcher/solana/curve/read.ts`). `readDeployment` is already generic
 * over a program id, and it is the only function in the repo that gets the
 * closed-program case right — a closed upgradeable program's stub stays
 * executable-flagged, so `getAccountInfo` alone reports a SPENT id as deployed.
 * A second implementation of that check would be a second chance to get it
 * wrong.
 *
 * ⚠️ POOLS CANNOT BE ENUMERATED FROM THE BROWSER. `getProgramAccounts` is
 * deliberately absent from the `/api/solrpc` allowlist as an unbounded scan, so
 * there is no "list every pool" call available here. Every pool this client
 * knows about is one whose PAIR a caller named — the address is derived, then
 * read. Any list built on this is a CURATED list and the surface has to say so.
 */

export type { Deployment, Read };

/**
 * A pool read has one outcome the generic `Read` cannot express: an account
 * EXISTS at the derived address and is not a pool. That is neither an outage
 * nor an absence, and folding it into either would either invent a connection
 * problem or claim the pair has no pool when something is sitting on its
 * address.
 */
export type PoolRead<T> = Read<T> | { kind: 'not-a-pool'; address: string };

/** The account-reader shape. Named for its role rather than its origin. */
export type AccountRpc = CurveRpc;

/** SPL token account: mint(32) owner(32) amount(u64 LE @64). Same for Token-2022. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_MIN_LEN = 72;

function decodeTokenAccountAmount(data: Uint8Array): bigint | null {
  if (data.length < TOKEN_ACCOUNT_MIN_LEN) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
    .getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true);
}

async function fetchAccount(rpc: AccountRpc, address: PublicKey): Promise<Read<Uint8Array>> {
  try {
    const acc = await rpc.getAccountInfo(address);
    if (!acc) return { kind: 'absent' };
    return { kind: 'ok', value: acc.data };
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
}

/**
 * Is the venue standing at all?
 *
 * Three separable answers, and a surface must not collapse them: no program id
 * configured (nothing has been deployed since the 2026-08-13 close), an id that
 * is configured but whose program is absent/closed, and a live program whose
 * AmmConfig has never been created — the state that made `migrate_to_amm` fail
 * `AmmNotConfigured` for the entire life of the previous deployment.
 */
export type VenueStatus =
  | { kind: 'no-program-id' }
  | { kind: 'program'; deployment: Exclude<Deployment, { kind: 'deployed' }> }
  | { kind: 'no-config'; programId: string }
  | { kind: 'live'; programId: string; config: AmmConfigView }
  | { kind: 'unreadable'; detail: string };

export async function readVenue(
  rpc: AccountRpc,
  programId: PublicKey | null = LIVE_PROGRAM_ID,
  configIndex: number = DEFAULT_AMM_CONFIG_INDEX,
): Promise<VenueStatus> {
  if (!programId) return { kind: 'no-program-id' };

  const deployment = await readDeployment(rpc, programId);
  if (deployment.kind === 'unreadable') return { kind: 'unreadable', detail: deployment.detail };
  if (deployment.kind !== 'deployed') return { kind: 'program', deployment };

  const configAddress = deriveAmmConfig(programId, configIndex);
  const raw = await fetchAccount(rpc, configAddress);
  if (raw.kind === 'unreadable') return { kind: 'unreadable', detail: raw.detail };
  // An absent AmmConfig is NOT an outage — it is the operator's `create_amm_config`
  // step not having run. Naming it precisely is the difference between "come back
  // later" and "one instruction is missing".
  if (raw.kind === 'absent') return { kind: 'no-config', programId: programId.toBase58() };
  if (raw.kind !== 'ok') {
    return { kind: 'unreadable', detail: 'the AmmConfig account could not be decoded' };
  }

  const config = decodeAmmConfig(configAddress.toBase58(), raw.value);
  if (!config) {
    return { kind: 'unreadable', detail: 'an account exists at the AmmConfig address but does not decode as one' };
  }
  return { kind: 'live', programId: programId.toBase58(), config };
}

export interface PoolSnapshot {
  pool: PoolStateView;
  /** Raw vault balances, straight off the token accounts. */
  vault0Amount: bigint;
  vault1Amount: bigint;
  /**
   * Vault balances MINUS accrued protocol/fund/creator fees — the reserves the
   * curve actually trades against. Quoting off the raw balance overstates
   * liquidity and returns a price the program will not honour.
   */
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * Read the pool for a pair, if one exists.
 *
 * The caller may name the mints in either order; the program requires
 * `token_0 < token_1` by raw bytes, so they are sorted before derivation.
 */
export async function readPoolForPair(
  rpc: AccountRpc,
  programId: PublicKey,
  configAddress: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
): Promise<PoolRead<PoolSnapshot>> {
  const { token0, token1 } = sortMints(mintA, mintB);
  const poolAddress = derivePool(programId, configAddress, token0, token1);

  const raw = await fetchAccount(rpc, poolAddress);
  if (raw.kind !== 'ok') return raw;
  const pool = decodePoolState(poolAddress.toBase58(), raw.value);
  if (!pool) return { kind: 'not-a-pool', address: poolAddress.toBase58() };

  // Vault balances come from the pool's own recorded vault addresses, not from
  // a re-derivation — if the two ever disagree, the account is what pays out.
  const [v0, v1] = await Promise.all([
    fetchAccount(rpc, new PublicKey(pool.token0Vault)),
    fetchAccount(rpc, new PublicKey(pool.token1Vault)),
  ]);
  if (v0.kind !== 'ok') return v0;
  if (v1.kind !== 'ok') return v1;

  const vault0Amount = decodeTokenAccountAmount(v0.value);
  const vault1Amount = decodeTokenAccountAmount(v1.value);
  if (vault0Amount === null || vault1Amount === null) {
    return { kind: 'unreadable', detail: 'a pool vault did not decode as a token account' };
  }

  const reserve0 = vaultAmountWithoutFee(
    vault0Amount, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0,
  );
  const reserve1 = vaultAmountWithoutFee(
    vault1Amount, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1,
  );
  if (reserve0 === null || reserve1 === null) {
    // The program's own `InsufficientVault`. Refuse rather than quote a pool
    // whose books do not balance.
    return { kind: 'unreadable', detail: 'accrued fees exceed a pool vault balance' };
  }

  return { kind: 'ok', value: { pool, vault0Amount, vault1Amount, reserve0, reserve1 } };
}

/** Derive the vault addresses for a pool without reading it (create-pool preflight). */
export function poolVaultAddresses(programId: PublicKey, pool: PublicKey, token0: PublicKey, token1: PublicKey) {
  return {
    vault0: deriveVault(programId, pool, token0),
    vault1: deriveVault(programId, pool, token1),
  };
}

export interface OwnPoolQuote {
  /** The pool this quote is against. */
  poolAddress: string;
  /** Raw output the trader receives, before any Token-2022 output transfer fee. */
  outAmount: bigint;
  /** The full fee breakdown, so the surface can show where each part went. */
  result: SwapResult;
  /** Reserves used, for a price-impact read the caller can compute honestly. */
  reserveIn: bigint;
  reserveOut: bigint;
  /** Price impact as a fraction (0.01 = 1%), derived from the reserves. */
  priceImpact: number;
}

/**
 * Quote a swap against one of our pools, using the program's own maths.
 *
 * Returns null — never a fabricated number — when the program would refuse:
 * a swap-disabled pool, a pool not yet open, an unpriceable creator-fee mode,
 * or arithmetic the program aborts on.
 */
export function quoteOwnPool(
  snapshot: PoolSnapshot,
  config: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate' | 'creatorFeeRate'>,
  inputMint: string,
  amountIn: bigint,
  nowSecs: number = Math.floor(Date.now() / 1000),
): OwnPoolQuote | null {
  const { pool } = snapshot;
  if (!swapEnabled(pool)) return null;
  if (BigInt(nowSecs) < pool.openTime) return null;

  const inputIsToken0 = inputMint === pool.token0Mint;
  if (!inputIsToken0 && inputMint !== pool.token1Mint) return null;

  const feeOnInput = isCreatorFeeOnInput(pool.creatorFeeOn, inputIsToken0);
  if (feeOnInput === null) return null;

  const reserveIn = inputIsToken0 ? snapshot.reserve0 : snapshot.reserve1;
  const reserveOut = inputIsToken0 ? snapshot.reserve1 : snapshot.reserve0;

  const result = swapBaseInput({
    inputAmount: amountIn,
    inputVaultAmount: reserveIn,
    outputVaultAmount: reserveOut,
    tradeFeeRate: config.tradeFeeRate,
    // `adjust_creator_fee_rate`: the pool can switch the creator fee off
    // regardless of what the config says.
    creatorFeeRate: pool.enableCreatorFee ? config.creatorFeeRate : 0n,
    protocolFeeRate: config.protocolFeeRate,
    fundFeeRate: config.fundFeeRate,
    isCreatorFeeOnInput: feeOnInput,
  });
  if (!result) return null;

  // Impact against the mid price the pool was at BEFORE the trade. Computed in
  // floating point deliberately — it is a display number, and every number that
  // rides the transaction stayed BigInt above.
  const spotOut = Number(reserveOut) / Number(reserveIn) * Number(amountIn);
  const priceImpact = spotOut > 0 ? Math.max(0, (spotOut - Number(result.outputAmount)) / spotOut) : 0;

  return {
    poolAddress: pool.address,
    outAmount: result.outputAmount,
    result,
    reserveIn,
    reserveOut,
    priceImpact,
  };
}

/**
 * What burning `lpAmount` pays out — `withdraw.rs`, which values the position
 * against `vault_amount_without_fee` (NOT the raw vault balance) and rounds
 * DOWN. Using the raw balance here would quote an LP the accrued protocol and
 * creator fees as if they were theirs to withdraw.
 */
export function lpWithdrawValue(
  snapshot: PoolSnapshot,
  lpAmount: bigint,
): { token0Amount: bigint; token1Amount: bigint; sharePct: number } | null {
  if (snapshot.pool.lpSupply === 0n || lpAmount <= 0n) return null;
  const r = lpTokensToTradingTokens(
    lpAmount, snapshot.pool.lpSupply, snapshot.reserve0, snapshot.reserve1, 'floor',
  );
  if (!r) return null;
  return {
    token0Amount: r.token0Amount,
    token1Amount: r.token1Amount,
    sharePct: Number(lpAmount) / Number(snapshot.pool.lpSupply) * 100,
  };
}

/**
 * What minting `lpAmount` COSTS — `deposit.rs`, same reserves but rounding UP,
 * so the pool is never short-changed. The asymmetry with the withdraw path is
 * the program's, and quoting a deposit with the withdraw rounding would
 * under-quote every deposit by up to one unit a side.
 */
export function lpDepositCost(
  snapshot: PoolSnapshot,
  lpAmount: bigint,
): { token0Amount: bigint; token1Amount: bigint } | null {
  if (snapshot.pool.lpSupply === 0n || lpAmount <= 0n) return null;
  const r = lpTokensToTradingTokens(
    lpAmount, snapshot.pool.lpSupply, snapshot.reserve0, snapshot.reserve1, 'ceiling',
  );
  return r ? { token0Amount: r.token0Amount, token1Amount: r.token1Amount } : null;
}
