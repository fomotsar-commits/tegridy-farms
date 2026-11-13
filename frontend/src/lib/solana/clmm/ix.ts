import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { associatedTokenAddress } from '../../launcher/solana/curve/ix';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { getArrayStartIndex, isOverflowDefaultTickarrayBitmap } from './bitmap';
import { U128_MAX, U64_MAX } from './math';
import {
  IX_CLOSE_POSITION,
  IX_CREATE_POOL,
  IX_DECREASE_LIQUIDITY_V2,
  IX_INCREASE_LIQUIDITY_V2,
  IX_OPEN_POSITION_WITH_TOKEN22_NFT,
  IX_SWAP_V2,
  POOL_STATUS_BIT,
  deriveBitmapExtension,
  deriveObservation,
  derivePersonalPosition,
  derivePool,
  deriveProtocolPosition,
  deriveTickArray,
  deriveVault,
  poolAllows,
  sortMints,
  type PoolStateView,
} from './program';

/**
 * Hand-encoded instruction builders for the range-pool program.
 *
 * The account lists live here as DATA, in program order with their signer and writable
 * flags, and ix.test.ts parses each `#[derive(Accounts)]` struct out of the Rust and holds
 * them equal name for name, flag for flag. That is how this repo's pool clients stopped
 * shipping a builder one account short.
 *
 * A position opens ONLY through `open_position_with_token22_nft`: its NFT is a Token-2022
 * mint holding its own name and link, so no outside metadata program is ever paid. The
 * program's Metaplex paths (`open_position`, `open_position_v2`) have no builder here.
 *
 * Pure: no connection, no signing, no fetch.
 */

export interface AccountSpec {
  name: string;
  s: boolean;
  w: boolean;
}

const A = (name: string, s = false, w = false): AccountSpec => ({ name, s, w });

/** `CreatePool`: create_pool.rs. */
export const CREATE_POOL_ACCOUNTS: AccountSpec[] = [
  A('pool_creator', true, true), A('amm_config'), A('pool_state', false, true),
  A('token_mint_0'), A('token_mint_1'),
  A('token_vault_0', false, true), A('token_vault_1', false, true),
  A('observation_state', false, true), A('tick_array_bitmap', false, true),
  A('token_program_0'), A('token_program_1'), A('system_program'), A('rent'),
  A('create_pool_fee', false, true),
];

/** `OpenPositionWithToken22Nft`: open_position_with_token22_nft.rs. */
export const OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS: AccountSpec[] = [
  A('payer', true, true), A('position_nft_owner'), A('position_nft_mint', true, true),
  A('position_nft_account', false, true), A('pool_state', false, true), A('protocol_position'),
  A('tick_array_lower', false, true), A('tick_array_upper', false, true),
  A('personal_position', false, true),
  A('token_account_0', false, true), A('token_account_1', false, true),
  A('token_vault_0', false, true), A('token_vault_1', false, true),
  A('rent'), A('system_program'), A('token_program'), A('associated_token_program'),
  A('token_program_2022'), A('vault_0_mint'), A('vault_1_mint'),
];

/** `IncreaseLiquidityV2`: increase_liquidity_v2.rs. */
export const INCREASE_LIQUIDITY_V2_ACCOUNTS: AccountSpec[] = [
  A('nft_owner', true), A('nft_account'), A('pool_state', false, true), A('protocol_position'),
  A('personal_position', false, true),
  A('tick_array_lower', false, true), A('tick_array_upper', false, true),
  A('token_account_0', false, true), A('token_account_1', false, true),
  A('token_vault_0', false, true), A('token_vault_1', false, true),
  A('token_program'), A('token_program_2022'), A('vault_0_mint'), A('vault_1_mint'),
];

/** `DecreaseLiquidityV2`: decrease_liquidity_v2.rs. Also how fees are collected. */
export const DECREASE_LIQUIDITY_V2_ACCOUNTS: AccountSpec[] = [
  A('nft_owner', true), A('nft_account'), A('personal_position', false, true),
  A('pool_state', false, true), A('protocol_position'),
  A('token_vault_0', false, true), A('token_vault_1', false, true),
  A('tick_array_lower', false, true), A('tick_array_upper', false, true),
  A('recipient_token_account_0', false, true), A('recipient_token_account_1', false, true),
  A('token_program'), A('token_program_2022'), A('memo_program'),
  A('vault_0_mint'), A('vault_1_mint'),
];

/** `ClosePosition`: close_position.rs. */
export const CLOSE_POSITION_ACCOUNTS: AccountSpec[] = [
  A('nft_owner', true, true), A('position_nft_mint', false, true),
  A('position_nft_account', false, true), A('personal_position', false, true),
  A('system_program'), A('token_program'),
];

/** `SwapSingleV2`: swap_v2.rs. Bands follow as remaining accounts. */
export const SWAP_V2_ACCOUNTS: AccountSpec[] = [
  A('payer', true), A('amm_config'), A('pool_state', false, true),
  A('input_token_account', false, true), A('output_token_account', false, true),
  A('input_vault', false, true), A('output_vault', false, true),
  A('observation_state', false, true),
  A('token_program'), A('token_program_2022'), A('memo_program'),
  A('input_vault_mint'), A('output_vault_mint'),
];

/* ───────────────────────────── encoding (Borsh) ─────────────────────────── */

class Writer {
  private parts: Uint8Array[] = [];
  raw(b: Uint8Array) {
    this.parts.push(b);
    return this;
  }
  private int(v: bigint, bytes: number, min: bigint, max: bigint, what: string) {
    if (v < min || v > max) throw new RangeError(`${what} out of range`);
    const b = new Uint8Array(bytes);
    let x = BigInt.asUintN(bytes * 8, v);
    for (let i = 0; i < bytes; i++) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return this.raw(b);
  }
  i32(v: number) {
    if (!Number.isInteger(v)) throw new RangeError('i32 must be a whole number');
    return this.int(BigInt(v), 4, -(1n << 31n), (1n << 31n) - 1n, 'i32');
  }
  u64(v: bigint) {
    return this.int(v, 8, 0n, U64_MAX, 'u64');
  }
  u128(v: bigint) {
    return this.int(v, 16, 0n, U128_MAX, 'u128');
  }
  bool(v: boolean) {
    return this.raw(Uint8Array.of(v ? 1 : 0));
  }
  /** Borsh `Option<bool>`: 0 for None, 1 then the value for Some. */
  optionBool(v: boolean | null) {
    return v === null ? this.raw(Uint8Array.of(0)) : this.raw(Uint8Array.of(1, v ? 1 : 0));
  }
  done(): Buffer {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return Buffer.from(out);
  }
}

/** Zip a spec with its addresses; a short list throws at build time, never on chain. */
function keys(spec: AccountSpec[], addresses: PublicKey[]) {
  if (spec.length !== addresses.length) {
    throw new Error(`account count mismatch: program wants ${spec.length}, builder supplied ${addresses.length}`);
  }
  return spec.map((a, i) => ({ pubkey: addresses[i]!, isSigner: a.s, isWritable: a.w }));
}

const pk = (s: string) => new PublicKey(s);
const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

/** The pool fields a builder needs; a decoded `PoolStateView` has them all. */
export type PoolRef = Pick<PoolStateView, 'address' | 'tokenMint0' | 'tokenMint1' | 'tokenVault0' | 'tokenVault1' | 'tickSpacing'>;

/** The position fields a builder needs; a decoded `PersonalPositionView` has them all. */
export interface PositionRef {
  nftMint: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
}

/** The bitmap extension, as the first remaining account, when the program will read it. */
function extensionIfNeeded(programId: PublicKey, pool: PoolRef, ticks: number[]) {
  return isOverflowDefaultTickarrayBitmap(pool.tickSpacing, ticks) ? [writable(deriveBitmapExtension(programId, pk(pool.address)))] : [];
}

/** A position's NFT is a Token-2022 mint, so its holder's account is the Token-2022 ATA. */
export function positionNftAccount(owner: PublicKey, nftMint: PublicKey): PublicKey {
  return associatedTokenAddress(nftMint, owner, TOKEN_2022_PROGRAM_ID);
}

/* ──────────────────────────────── builders ──────────────────────────────── */

export interface CreatePoolArgs {
  programId: PublicKey;
  poolCreator: PublicKey;
  ammConfig: PublicKey;
  /** MUST be byte-sorted: use `sortMints`. */
  mint0: PublicKey;
  mint1: PublicKey;
  tokenProgram0: PublicKey;
  tokenProgram1: PublicKey;
  /** The opening price, sqrt(token_1 / token_0) in raw units, Q64.64. */
  sqrtPriceX64: bigint;
}

/** What the program charges to open a pool, in lamports (lib.rs CREATE_POOL_FEE): 0.5 SOL. */
export const CREATE_POOL_FEE_LAMPORTS = 500_000_000n;
/** Who that fee pays: the team's vault (lib.rs create_pool_fee_reveiver). */
export const CREATE_POOL_FEE_RECEIVER = PLATFORM_TREASURY_VAULT;

/** `create_pool`. Open time is 0: the program requires it to be in the past. */
export function createPoolIx(a: CreatePoolArgs): TransactionInstruction {
  const { token0 } = sortMints(a.mint0, a.mint1);
  if (!token0.equals(a.mint0) || a.mint0.equals(a.mint1)) {
    throw new Error('mint0/mint1 are not byte-sorted: pass them through sortMints first');
  }
  const pool = derivePool(a.programId, a.ammConfig, a.mint0, a.mint1);
  return new TransactionInstruction({
    programId: a.programId,
    keys: keys(CREATE_POOL_ACCOUNTS, [
      a.poolCreator, a.ammConfig, pool, a.mint0, a.mint1,
      deriveVault(a.programId, pool, a.mint0), deriveVault(a.programId, pool, a.mint1),
      deriveObservation(a.programId, pool), deriveBitmapExtension(a.programId, pool),
      a.tokenProgram0, a.tokenProgram1, SystemProgram.programId, SYSVAR_RENT_PUBKEY,
      CREATE_POOL_FEE_RECEIVER,
    ]),
    data: new Writer().raw(IX_CREATE_POOL).u128(a.sqrtPriceX64).u64(0n).done(),
  });
}

export interface OpenPositionArgs {
  programId: PublicKey;
  payer: PublicKey;
  /** Who receives the position NFT; usually the payer. */
  owner: PublicKey;
  /** A fresh keypair's public key. It signs the transaction and becomes the NFT. */
  positionNftMint: PublicKey;
  pool: PoolRef;
  tokenAccount0: PublicKey;
  tokenAccount1: PublicKey;
  tickLower: number;
  tickUpper: number;
  /**
   * The liquidity to add. With 0 and a `baseFlag`, the program works it out from
   * amount0Max (true) or amount1Max (false), which is how a one-coin position opens.
   */
  liquidity: bigint;
  /** Ceilings the program refuses above (`PriceSlippageCheck`). */
  amount0Max: bigint;
  amount1Max: bigint;
  baseFlag: boolean | null;
}

/** `open_position_with_token22_nft`, with the NFT's own name and link always written. */
export function openPositionWithToken22NftIx(a: OpenPositionArgs): TransactionInstruction {
  const poolKey = pk(a.pool.address);
  const lowerStart = getArrayStartIndex(a.tickLower, a.pool.tickSpacing);
  const upperStart = getArrayStartIndex(a.tickUpper, a.pool.tickSpacing);
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      ...keys(OPEN_POSITION_WITH_TOKEN22_NFT_ACCOUNTS, [
        a.payer, a.owner, a.positionNftMint, positionNftAccount(a.owner, a.positionNftMint), poolKey,
        deriveProtocolPosition(a.programId, poolKey, a.tickLower, a.tickUpper),
        deriveTickArray(a.programId, poolKey, lowerStart), deriveTickArray(a.programId, poolKey, upperStart),
        derivePersonalPosition(a.programId, a.positionNftMint),
        a.tokenAccount0, a.tokenAccount1, pk(a.pool.tokenVault0), pk(a.pool.tokenVault1),
        SYSVAR_RENT_PUBKEY, SystemProgram.programId, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID, pk(a.pool.tokenMint0), pk(a.pool.tokenMint1),
      ]),
      ...extensionIfNeeded(a.programId, a.pool, [lowerStart, upperStart]),
    ],
    data: new Writer()
      .raw(IX_OPEN_POSITION_WITH_TOKEN22_NFT)
      .i32(a.tickLower).i32(a.tickUpper).i32(lowerStart).i32(upperStart)
      .u128(a.liquidity).u64(a.amount0Max).u64(a.amount1Max)
      .bool(true)
      .optionBool(a.baseFlag)
      .done(),
  });
}

export interface IncreaseLiquidityArgs {
  programId: PublicKey;
  nftOwner: PublicKey;
  position: PositionRef;
  pool: PoolRef;
  tokenAccount0: PublicKey;
  tokenAccount1: PublicKey;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  /** Required by the program when liquidity is 0. */
  baseFlag: boolean | null;
}

/** `increase_liquidity_v2`. */
export function increaseLiquidityV2Ix(a: IncreaseLiquidityArgs): TransactionInstruction {
  if (a.liquidity === 0n && a.baseFlag === null) throw new Error('liquidity 0 needs a baseFlag (the program refuses: MissingBaseFlag)');
  const poolKey = pk(a.pool.address);
  const nftMint = pk(a.position.nftMint);
  const { tickLowerIndex: lower, tickUpperIndex: upper } = a.position;
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      ...keys(INCREASE_LIQUIDITY_V2_ACCOUNTS, [
        a.nftOwner, positionNftAccount(a.nftOwner, nftMint), poolKey,
        deriveProtocolPosition(a.programId, poolKey, lower, upper), derivePersonalPosition(a.programId, nftMint),
        deriveTickArray(a.programId, poolKey, getArrayStartIndex(lower, a.pool.tickSpacing)),
        deriveTickArray(a.programId, poolKey, getArrayStartIndex(upper, a.pool.tickSpacing)),
        a.tokenAccount0, a.tokenAccount1, pk(a.pool.tokenVault0), pk(a.pool.tokenVault1),
        TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, pk(a.pool.tokenMint0), pk(a.pool.tokenMint1),
      ]),
      ...extensionIfNeeded(a.programId, a.pool, [lower, upper]),
    ],
    data: new Writer().raw(IX_INCREASE_LIQUIDITY_V2).u128(a.liquidity).u64(a.amount0Max).u64(a.amount1Max).optionBool(a.baseFlag).done(),
  });
}

/** A reward the pool pays, and where the holder receives it. */
export interface RewardCollect {
  vault: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
}

export interface DecreaseLiquidityArgs {
  programId: PublicKey;
  nftOwner: PublicKey;
  position: PositionRef;
  pool: PoolRef & Pick<PoolStateView, 'status' | 'rewardInfos'>;
  recipientTokenAccount0: PublicKey;
  recipientTokenAccount1: PublicKey;
  /** 0 collects the fees owed and moves no liquidity. */
  liquidity: bigint;
  /** Floors the program refuses below, checked only when liquidity > 0. */
  amount0Min: bigint;
  amount1Min: bigint;
  /**
   * One per reward the pool has set up, in its order. The program refuses a different
   * count while rewards can be collected (`InvalidRewardInputAccountNumber`).
   */
  rewards: RewardCollect[];
}

/** `decrease_liquidity_v2`: takes liquidity out, and always pays the fees owed with it. */
export function decreaseLiquidityV2Ix(a: DecreaseLiquidityArgs): TransactionInstruction {
  const poolKey = pk(a.pool.address);
  const nftMint = pk(a.position.nftMint);
  const { tickLowerIndex: lower, tickUpperIndex: upper } = a.position;
  const want = poolAllows(a.pool, POOL_STATUS_BIT.collectReward) ? a.pool.rewardInfos.filter((r) => r.initialized).length : 0;
  if (a.rewards.length !== want) throw new Error(`reward accounts: the program wants ${want} groups, builder supplied ${a.rewards.length}`);
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      ...keys(DECREASE_LIQUIDITY_V2_ACCOUNTS, [
        a.nftOwner, positionNftAccount(a.nftOwner, nftMint), derivePersonalPosition(a.programId, nftMint),
        poolKey, deriveProtocolPosition(a.programId, poolKey, lower, upper),
        pk(a.pool.tokenVault0), pk(a.pool.tokenVault1),
        deriveTickArray(a.programId, poolKey, getArrayStartIndex(lower, a.pool.tickSpacing)),
        deriveTickArray(a.programId, poolKey, getArrayStartIndex(upper, a.pool.tickSpacing)),
        a.recipientTokenAccount0, a.recipientTokenAccount1,
        TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM_ID,
        pk(a.pool.tokenMint0), pk(a.pool.tokenMint1),
      ]),
      ...extensionIfNeeded(a.programId, a.pool, [lower, upper]),
      ...a.rewards.flatMap((r) => [writable(r.vault), writable(r.recipient), readonly(r.mint)]),
    ],
    data: new Writer().raw(IX_DECREASE_LIQUIDITY_V2).u128(a.liquidity).u64(a.amount0Min).u64(a.amount1Min).done(),
  });
}

/** Collect a position's fees: `decrease_liquidity_v2` with no liquidity moved. */
export function collectFeesIx(a: Omit<DecreaseLiquidityArgs, 'liquidity' | 'amount0Min' | 'amount1Min'>): TransactionInstruction {
  return decreaseLiquidityV2Ix({ ...a, liquidity: 0n, amount0Min: 0n, amount1Min: 0n });
}

export interface ClosePositionArgs {
  programId: PublicKey;
  nftOwner: PublicKey;
  nftMint: PublicKey;
}

/**
 * `close_position`: burns the NFT and returns its rent. The program refuses while the
 * position holds liquidity, fees or rewards owed, so take them out first.
 */
export function closePositionIx(a: ClosePositionArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId,
    keys: keys(CLOSE_POSITION_ACCOUNTS, [
      a.nftOwner, a.nftMint, positionNftAccount(a.nftOwner, a.nftMint),
      derivePersonalPosition(a.programId, a.nftMint), SystemProgram.programId, TOKEN_2022_PROGRAM_ID,
    ]),
    data: new Writer().raw(IX_CLOSE_POSITION).done(),
  });
}

export interface SwapV2Args {
  programId: PublicKey;
  payer: PublicKey;
  pool: PoolRef & Pick<PoolStateView, 'ammConfig' | 'observationKey'>;
  /** True when the payer pays token 0 and receives token 1. */
  zeroForOne: boolean;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  /** The bands the swap may walk, in walking order: from the quote. */
  tickArrays: PublicKey[];
  /** Needed only when the walk reaches past the pool's own map. */
  bitmapExtension: PublicKey | null;
  amount: bigint;
  /**
   * The floor on what comes out (exact in) or the ceiling on what goes in (exact out).
   * Derive it from a quote and a tolerance; never 0, which accepts any price.
   */
  otherAmountThreshold: bigint;
  /** 0 = no price limit; the program then refuses a partial fill. */
  sqrtPriceLimitX64: bigint;
  isBaseInput: boolean;
}

/** `swap_v2`. */
export function swapV2Ix(a: SwapV2Args): TransactionInstruction {
  if (a.tickArrays.length === 0) throw new Error('a swap needs at least one band (NotEnoughTickArrayAccount)');
  const [inVault, outVault] = a.zeroForOne ? [a.pool.tokenVault0, a.pool.tokenVault1] : [a.pool.tokenVault1, a.pool.tokenVault0];
  const [inMint, outMint] = a.zeroForOne ? [a.pool.tokenMint0, a.pool.tokenMint1] : [a.pool.tokenMint1, a.pool.tokenMint0];
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      ...keys(SWAP_V2_ACCOUNTS, [
        a.payer, pk(a.pool.ammConfig), pk(a.pool.address), a.inputTokenAccount, a.outputTokenAccount,
        pk(inVault), pk(outVault), pk(a.pool.observationKey),
        TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM_ID, pk(inMint), pk(outMint),
      ]),
      ...(a.bitmapExtension ? [writable(a.bitmapExtension)] : []),
      ...a.tickArrays.map(writable),
    ],
    data: new Writer().raw(IX_SWAP_V2).u64(a.amount).u64(a.otherAmountThreshold).u128(a.sqrtPriceLimitX64).bool(a.isBaseInput).done(),
  });
}
