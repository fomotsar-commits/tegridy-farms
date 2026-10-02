// Test-only helpers for the write layer: account encoders that follow the program
// layouts byte for byte, and a fake chain that answers the RPC calls the write path
// makes. Imported by *.test.ts only; nothing in the app imports it.

import { Buffer } from 'buffer';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATOR,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BONDING_CURVE_LAYOUT,
  GLOBAL_CONFIG_LAYOUT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  cpAmmConfigPda,
  curvePda,
  globalPda,
  poolStatePda,
  type BondingCurve,
  type GlobalConfig,
} from '../curve/program';
import { BPF_LOADER_UPGRADEABLE_ID } from '../curve/read';
import { curveSupply } from '../curve/math';
import {
  ACCOUNT_AMM_CONFIG,
  ACCOUNT_POOL_STATE,
  AMM_CONFIG_LEN,
  AMM_CONFIG_OFFSETS,
  IX_INITIALIZE,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  decodeAmmConfig,
  deriveAuthority,
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  publicTierConfig,
  sortMints,
} from '../../../solana/cpswap/program';
import { isqrt } from '../../../solana/lp/liquidityMath';
import { associatedTokenAddress } from '../curve/ix';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import {
  BAYLA_MINT,
  PLANT_BURN_RAW,
  PLANT_WORKSHOP_RAW,
  WORKSHOP_BAYLA_ACCOUNT,
  WORKSHOP_WALLET,
  baylaAccountOf,
} from './plant';

export const LAUNCH = new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2');
export const CPSWAP = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
export const VAULT = new PublicKey('GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd');
export const AMM_CONFIG = cpAmmConfigPda(0, CPSWAP);
/** A local-validator genesis: not a public cluster. */
export const LOCAL_GENESIS = 'LocaLGenesis1111111111111111111111111111111';
export const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

export const cfgLocal = { programId: LAUNCH, cpSwapProgram: CPSWAP, cluster: 'localnet' as const };

export const rent = (size: number): number => (128 + size) * 6_960;

export function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

/** The 1-SOL rehearsal global (run 3111), with the owner's fee settings. */
export function globalValue(over: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    authority: VAULT,
    feeRecipient: VAULT,
    tradeFeeBps: 100n,
    creatorFeeShareBps: 5_000n,
    initialVirtualSol: 2_603_952_621n,
    initialVirtualToken: 1_033_406_300_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 1_000_000_000n,
    migrationReserveLamports: 50_000_000n,
    cpSwapProgram: CPSWAP,
    ammConfig: AMM_CONFIG,
    paused: false,
    bump: 255,
    platformReserveBps: 369n,
    ...over,
  };
}

export function encodeGlobal(g: GlobalConfig): Uint8Array {
  const L = GLOBAL_CONFIG_LAYOUT;
  const d = new Uint8Array(L.size);
  d.set(ACCOUNT_DISCRIMINATOR.GlobalConfig, 0);
  d.set(g.authority.toBytes(), L.authority);
  d.set(g.feeRecipient.toBytes(), L.feeRecipient);
  d.set(u64le(g.tradeFeeBps), L.tradeFeeBps);
  d.set(u64le(g.creatorFeeShareBps), L.creatorFeeShareBps);
  d.set(u64le(g.initialVirtualSol), L.initialVirtualSol);
  d.set(u64le(g.initialVirtualToken), L.initialVirtualToken);
  d.set(u64le(g.tokenTotalSupply), L.tokenTotalSupply);
  d.set(u64le(g.graduationTargetLamports), L.graduationTargetLamports);
  d.set(u64le(g.migrationReserveLamports), L.migrationReserveLamports);
  d.set(g.cpSwapProgram.toBytes(), L.cpSwapProgram);
  d.set(g.ammConfig.toBytes(), L.ammConfig);
  d[L.paused] = g.paused ? 1 : 0;
  d[L.bump] = g.bump;
  d.set(u64le(g.platformReserveBps), L.platformReserveBps);
  return d;
}

/** A fresh curve as `create_launch` would write it from `g`. */
export function freshCurve(mint: PublicKey, creator: PublicKey, g: GlobalConfig = globalValue()): BondingCurve {
  const s = curveSupply(g.tokenTotalSupply, g.platformReserveBps);
  if (!s.ok) throw new Error('bad supply');
  return {
    mint,
    creator,
    virtualSolReserves: g.initialVirtualSol,
    virtualTokenReserves: g.initialVirtualToken,
    realSolReserves: 0n,
    realTokenReserves: s.value.curveTokens,
    tradeFeeBps: g.tradeFeeBps,
    creatorFeeShareBps: g.creatorFeeShareBps,
    graduationTargetLamports: g.graduationTargetLamports,
    migrationReserveLamports: g.migrationReserveLamports,
    complete: false,
    pool: new PublicKey(new Uint8Array(32)),
    bump: 254,
    platformReserveTokens: s.value.reserveTokens,
    // create_launch pays the reserve to the treasury and sets this in the same instruction.
    platformReserveReleased: true,
  };
}

export function encodeCurve(c: BondingCurve): Uint8Array {
  const L = BONDING_CURVE_LAYOUT;
  const d = new Uint8Array(L.size);
  d.set(ACCOUNT_DISCRIMINATOR.BondingCurve, 0);
  d.set(c.mint.toBytes(), L.mint);
  d.set(c.creator.toBytes(), L.creator);
  d.set(u64le(c.virtualSolReserves), L.virtualSolReserves);
  d.set(u64le(c.virtualTokenReserves), L.virtualTokenReserves);
  d.set(u64le(c.realSolReserves), L.realSolReserves);
  d.set(u64le(c.realTokenReserves), L.realTokenReserves);
  d.set(u64le(c.tradeFeeBps), L.tradeFeeBps);
  d.set(u64le(c.creatorFeeShareBps), L.creatorFeeShareBps);
  d.set(u64le(c.graduationTargetLamports), L.graduationTargetLamports);
  d.set(u64le(c.migrationReserveLamports), L.migrationReserveLamports);
  d[L.complete] = c.complete ? 1 : 0;
  d.set(c.pool.toBytes(), L.pool);
  d[L.bump] = c.bump;
  d.set(u64le(c.platformReserveTokens), L.platformReserveTokens);
  d[L.platformReserveReleased] = c.platformReserveReleased ? 1 : 0;
  return d;
}

export interface AmmConfigOverrides {
  index: number;
  disableCreatePool: boolean;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  createPoolFee: bigint;
  creatorFeeRate: bigint;
}

/** AmmConfig bytes. With no argument: the launch tier's (tier 0) rehearsal values, as always. */
export function encodeAmmConfig(over: Partial<AmmConfigOverrides> = {}): Uint8Array {
  const o = AMM_CONFIG_OFFSETS;
  const d = new Uint8Array(AMM_CONFIG_LEN);
  d.set(ACCOUNT_AMM_CONFIG, 0);
  d[o.bump] = 255;
  d[o.disableCreatePool] = over.disableCreatePool ? 1 : 0;
  new DataView(d.buffer).setUint16(o.index, over.index ?? 0, true);
  d.set(u64le(over.tradeFeeRate ?? 2_500n), o.tradeFeeRate);
  d.set(u64le(over.protocolFeeRate ?? 120_000n), o.protocolFeeRate);
  d.set(u64le(over.fundFeeRate ?? 0n), o.fundFeeRate);
  d.set(u64le(over.createPoolFee ?? 0n), o.createPoolFee);
  d.set(VAULT.toBytes(), o.protocolOwner);
  d.set(VAULT.toBytes(), o.fundOwner);
  d.set(u64le(over.creatorFeeRate ?? 0n), o.creatorFeeRate);
  return d;
}

/**
 * The public fee tier (tier 1) as the vault created it on mainnet (2026-10-01): index 1,
 * 1% a trade, 16% of that to the protocol, no fund or creator fee, 0.15 SOL to open,
 * creation on.
 */
export const TIER1_VALUES: AmmConfigOverrides = {
  index: 1,
  disableCreatePool: false,
  tradeFeeRate: 10_000n,
  protocolFeeRate: 160_000n,
  fundFeeRate: 0n,
  createPoolFee: 150_000_000n,
  creatorFeeRate: 0n,
};

export interface FeeReceiverOptions {
  /** The program that owns the account (default: the classic token program). */
  program: PublicKey;
  /** The mint it holds (default: wrapped SOL). */
  mint: PublicKey;
  /** 1 = set up (default), 0 = not set up, 2 = frozen. */
  state: 0 | 1 | 2;
  /** Whether it is a native wrapped-SOL account (default: yes). */
  native: boolean;
  /** Its token balance (default 0). */
  amount: bigint;
  /** Its byte length (default 165); longer is zero-padded. */
  length: number;
}

/** The pool program's fee account for openings, as on mainnet: a native wrapped-SOL token account owned by the vault. */
export function encodeFeeReceiver(over: Partial<FeeReceiverOptions> = {}): Uint8Array {
  const base = encodeTokenAccountWith(over.mint ?? WSOL_MINT, VAULT, over.amount ?? 0n);
  const d = new Uint8Array(over.length ?? 165);
  d.set(base.subarray(0, Math.min(165, d.length)), 0);
  if (d.length >= 165) {
    d[108] = over.state ?? 1;
    const v = new DataView(d.buffer);
    if (over.native ?? true) {
      v.setUint32(109, 1, true);
      v.setBigUint64(113, BigInt(rent(165)), true);
    }
  }
  return d;
}

/** A 165-byte SPL token account holding `amount` of `mint` for `owner`. */
export function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  return encodeTokenAccountWith(mint, owner, amount);
}

export interface TokenAccountOptions {
  /** 1 = initialized (the default), 2 = frozen. */
  state?: 1 | 2;
  delegate?: PublicKey;
  delegatedAmount?: bigint;
  closeAuthority?: PublicKey;
}

/** The base 165-byte token account layout, shared by both token programs. */
export function encodeTokenAccountWith(mint: PublicKey, owner: PublicKey, amount: bigint, o: TokenAccountOptions = {}): Uint8Array {
  const d = new Uint8Array(165);
  const v = new DataView(d.buffer);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  d.set(u64le(amount), 64);
  if (o.delegate) {
    v.setUint32(72, 1, true);
    d.set(o.delegate.toBytes(), 76);
    d.set(u64le(o.delegatedAmount ?? 0n), 121);
  }
  d[108] = o.state ?? 1;
  if (o.closeAuthority) {
    v.setUint32(129, 1, true);
    d.set(o.closeAuthority.toBytes(), 133);
  }
  return d;
}

/** spl-token-2022 extension numbers used by these fixtures. */
export const EXT = { ImmutableOwner: 7, MemoTransfer: 8, CpiGuard: 11, TransferFeeConfig: 1, MetadataPointer: 18, TokenMetadata: 19 } as const;

/**
 * A Token-2022 token account as the associated-token program creates it: the base
 * layout, the account-type byte (2), then ImmutableOwner, so 170 bytes (the size of the
 * Workshop's $BAYLA account on mainnet; the plant's fixtures use it with no options).
 * CPI Guard and required memos add their own one-byte extensions after it.
 */
export function encodeToken2022Account(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  o: TokenAccountOptions & { cpiGuard?: boolean; memoRequired?: boolean } = {},
): Uint8Array {
  const tlv: Array<[number, Uint8Array]> = [[EXT.ImmutableOwner, new Uint8Array(0)]];
  if (o.memoRequired !== undefined) tlv.push([EXT.MemoTransfer, Uint8Array.of(o.memoRequired ? 1 : 0)]);
  if (o.cpiGuard !== undefined) tlv.push([EXT.CpiGuard, Uint8Array.of(o.cpiGuard ? 1 : 0)]);
  const len = 166 + tlv.reduce((n, [, b]) => n + 4 + b.length, 0);
  const d = new Uint8Array(len);
  d.set(encodeTokenAccountWith(mint, owner, amount, o), 0);
  d[165] = 2; // AccountType::Account
  const v = new DataView(d.buffer);
  let at = 166;
  for (const [type, body] of tlv) {
    v.setUint16(at, type, true);
    v.setUint16(at + 2, body.length, true);
    d.set(body, at + 4);
    at += 4 + body.length;
  }
  return d;
}

export interface MintOptions {
  decimals?: number;
  mintAuthority?: PublicKey;
  freezeAuthority?: PublicKey;
  supply?: bigint;
}

/** A classic 82-byte mint. */
export function encodeMint(o: MintOptions = {}): Uint8Array {
  const d = new Uint8Array(82);
  const v = new DataView(d.buffer);
  if (o.mintAuthority) {
    v.setUint32(0, 1, true);
    d.set(o.mintAuthority.toBytes(), 4);
  }
  d.set(u64le(o.supply ?? 1_000_000_000_000n), 36);
  d[44] = o.decimals ?? 6;
  d[45] = 1;
  if (o.freezeAuthority) {
    v.setUint32(46, 1, true);
    d.set(o.freezeAuthority.toBytes(), 50);
  }
  return d;
}

/**
 * A Token-2022 mint carrying `extensions` ([type, length], zero-filled bodies): the
 * base mint, padding to 165, the account-type byte (1), then each extension. A zeroed
 * metadata pointer or token-metadata body decodes as "no name".
 */
export function encodeMint2022(extensions: Array<[number, number]>, o: MintOptions = {}): Uint8Array {
  const len = (extensions.length ? 166 : 82) + extensions.reduce((n, [, l]) => n + 4 + l, 0);
  const d = new Uint8Array(len);
  d.set(encodeMint(o), 0);
  if (!extensions.length) return d;
  d[165] = 1; // AccountType::Mint
  const v = new DataView(d.buffer);
  let at = 166;
  for (const [type, l] of extensions) {
    v.setUint16(at, type, true);
    v.setUint16(at + 2, l, true);
    at += 4 + l;
  }
  return d;
}

/** 250,000 $BAYLA: what the test maker holds unless a test says otherwise. */
export const MAKER_BAYLA = 250_000_000_000n;
/** The Workshop's $BAYLA balance as read on mainnet, 2026-10-01. */
export const WORKSHOP_BAYLA = 135_491_275_155_257n;

/** The plant's two accounts: `maker`'s own $BAYLA account holding `makerAmount`, and the Workshop's. */
export function addPlantAccounts(chain: FakeChain, maker: PublicKey, makerAmount: bigint = MAKER_BAYLA): FakeChain {
  chain.token2022Account(baylaAccountOf(maker), BAYLA_MINT, maker, makerAmount);
  return chain.token2022Account(WORKSHOP_BAYLA_ACCOUNT, BAYLA_MINT, WORKSHOP_WALLET, WORKSHOP_BAYLA);
}

/** Simulated post-state for the plant: `burned + toWorkshop` leaves the maker, `toWorkshop` reaches the Workshop. */
export function plantMoved(
  maker: PublicKey,
  o: { burned?: bigint; toWorkshop?: bigint; makerAmount?: bigint } = {},
): Record<string, { tokenAmount: bigint; mint: PublicKey; owner: PublicKey }> {
  const burned = o.burned ?? PLANT_BURN_RAW;
  const toWorkshop = o.toWorkshop ?? PLANT_WORKSHOP_RAW;
  return {
    [baylaAccountOf(maker).toBase58()]: { tokenAmount: (o.makerAmount ?? MAKER_BAYLA) - burned - toWorkshop, mint: BAYLA_MINT, owner: maker },
    [WORKSHOP_BAYLA_ACCOUNT.toBase58()]: { tokenAmount: WORKSHOP_BAYLA + toWorkshop, mint: BAYLA_MINT, owner: WORKSHOP_WALLET },
  };
}

/**
 * A graduated launch's pool, as `migrate_to_amm` leaves it: at the launch program's
 * own address, every field derived, both vaults holding `sol` and `tokens`.
 */
export function addLaunchPool(
  chain: FakeChain,
  mint: PublicKey,
  o: { sol: bigint; tokens: bigint; status?: number; openTime?: bigint; ammConfig?: PublicKey },
): PublicKey {
  const pool = poolStatePda(mint, LAUNCH);
  const { token0, token1 } = sortMints(WSOL_MINT, mint);
  const off = POOL_STATE_OFFSETS;
  const d = new Uint8Array(POOL_STATE_LEN);
  d.set(ACCOUNT_POOL_STATE, 0);
  const keys: Array<[number, PublicKey]> = [
    [off.ammConfig, o.ammConfig ?? AMM_CONFIG],
    [off.poolCreator, mint],
    [off.token0Vault, deriveVault(CPSWAP, pool, token0)],
    [off.token1Vault, deriveVault(CPSWAP, pool, token1)],
    [off.lpMint, deriveLpMint(CPSWAP, pool)],
    [off.token0Mint, token0],
    [off.token1Mint, token1],
    [off.token0Program, TOKEN_PROGRAM_ID],
    [off.token1Program, TOKEN_PROGRAM_ID],
    [off.observationKey, deriveObservation(CPSWAP, pool)],
  ];
  for (const [at, k] of keys) d.set(k.toBytes(), at);
  d[off.status] = o.status ?? 0;
  d[off.lpMintDecimals] = 9;
  d[off.mint0Decimals] = token0.equals(WSOL_MINT) ? 9 : 6;
  d[off.mint1Decimals] = token1.equals(WSOL_MINT) ? 9 : 6;
  d.set(u64le(1n), off.lpSupply);
  d.set(u64le(o.openTime ?? 0n), off.openTime);
  chain.set(pool, { lamports: rent(POOL_STATE_LEN), owner: CPSWAP, data: d });
  const amount = (m: PublicKey) => (m.equals(WSOL_MINT) ? o.sol : o.tokens);
  chain.tokenAccount(deriveVault(CPSWAP, pool, token0), token0, pool, amount(token0));
  chain.tokenAccount(deriveVault(CPSWAP, pool, token1), token1, pool, amount(token1));
  return pool;
}

export interface PoolFixture {
  address: PublicKey;
  token0: PublicKey;
  token1: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  lpMint: PublicKey;
  observation: PublicKey;
  solIsToken0: boolean;
  /** The token side's vault. */
  tokenVault: PublicKey;
  solVault: PublicKey;
}

/**
 * Any TOKEN/SOL pool of the pool program, every field derived from its address, its
 * two vaults, its LP mint, and (for a launch pool) its price record. The token side
 * may be Token-2022. Defaults: the standard address on fee tier 0 (AMM_CONFIG).
 */
export function addPool(
  chain: FakeChain,
  mint: PublicKey,
  o: {
    sol: bigint;
    tokens: bigint;
    lpSupply?: bigint;
    status?: number;
    openTime?: bigint;
    address?: PublicKey;
    /** At the launch program's address for this mint, with a never-traded price record. */
    launch?: boolean;
    tokenProgram?: PublicKey;
    tokenDecimals?: number;
    frozenTokenVault?: boolean;
    /** Override recorded fields (to test a pool whose record and derivation disagree). */
    record?: Partial<Record<'token0Vault' | 'token1Vault' | 'lpMint' | 'observationKey' | 'token0Program' | 'token1Program', PublicKey>>;
  },
): PoolFixture {
  const { token0, token1 } = sortMints(WSOL_MINT, mint);
  const address = o.address ?? (o.launch ? poolStatePda(mint, LAUNCH) : derivePool(CPSWAP, AMM_CONFIG, token0, token1));
  const solIsToken0 = token0.equals(WSOL_MINT);
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const vault0 = deriveVault(CPSWAP, address, token0);
  const vault1 = deriveVault(CPSWAP, address, token1);
  const lpMint = deriveLpMint(CPSWAP, address);
  const observation = deriveObservation(CPSWAP, address);
  const off = POOL_STATE_OFFSETS;
  const d = new Uint8Array(POOL_STATE_LEN);
  d.set(ACCOUNT_POOL_STATE, 0);
  const r = o.record ?? {};
  const keys: Array<[number, PublicKey]> = [
    [off.ammConfig, AMM_CONFIG],
    [off.poolCreator, mint],
    [off.token0Vault, r.token0Vault ?? vault0],
    [off.token1Vault, r.token1Vault ?? vault1],
    [off.lpMint, r.lpMint ?? lpMint],
    [off.token0Mint, token0],
    [off.token1Mint, token1],
    [off.token0Program, r.token0Program ?? (solIsToken0 ? TOKEN_PROGRAM_ID : tokenProgram)],
    [off.token1Program, r.token1Program ?? (solIsToken0 ? tokenProgram : TOKEN_PROGRAM_ID)],
    [off.observationKey, r.observationKey ?? observation],
  ];
  for (const [at, k] of keys) d.set(k.toBytes(), at);
  d[off.status] = o.status ?? 0;
  d[off.lpMintDecimals] = 9;
  const dec = o.tokenDecimals ?? 6;
  d[off.mint0Decimals] = solIsToken0 ? 9 : dec;
  d[off.mint1Decimals] = solIsToken0 ? dec : 9;
  d.set(u64le(o.lpSupply ?? 1_000_000_000n), off.lpSupply);
  d.set(u64le(o.openTime ?? 0n), off.openTime);
  chain.set(address, { lamports: rent(POOL_STATE_LEN), owner: CPSWAP, data: d });
  const authority = deriveAuthority(CPSWAP);
  const solVault = solIsToken0 ? vault0 : vault1;
  const tokenVault = solIsToken0 ? vault1 : vault0;
  chain.tokenAccount(solVault, WSOL_MINT, authority, o.sol);
  const vaultOpts = { state: o.frozenTokenVault ? (2 as const) : (1 as const) };
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenVault, mint, authority, o.tokens, vaultOpts);
  else chain.tokenAccount(tokenVault, mint, authority, o.tokens, vaultOpts);
  chain.mint(lpMint, { decimals: 9, mintAuthority: authority, supply: o.lpSupply ?? 1_000_000_000n });
  if (o.launch) {
    // A never-traded price record: initialized 0, naming this pool.
    const obs = new Uint8Array(4075);
    obs.set([122, 174, 197, 53, 129, 9, 165, 132], 0);
    obs.set(address.toBytes(), 11);
    chain.set(observation, { lamports: rent(4075), owner: CPSWAP, data: obs });
  }
  return { address, token0, token1, vault0, vault1, lpMint, observation, solIsToken0, tokenVault, solVault };
}

const CLOCK_SYSVAR = new PublicKey('SysvarC1ock11111111111111111111111111111111');

/** The cluster clock (unix seconds), or no clock at all with `null`. */
export function setClock(chain: FakeChain, unix: bigint | null): void {
  if (unix === null) {
    chain.accounts.delete(CLOCK_SYSVAR.toBase58());
    return;
  }
  const b = new Uint8Array(40);
  new DataView(b.buffer).setBigInt64(32, unix, true);
  chain.set(CLOCK_SYSVAR, { lamports: 1, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), data: b });
}

export interface FakeAccount {
  lamports: number;
  owner: PublicKey;
  data: Uint8Array;
  executable?: boolean;
}

export type SimHandler = (
  vtx: VersionedTransaction,
  config: { accounts?: { addresses: string[] } } | undefined,
  chain: FakeChain,
) => { err: unknown; logs?: string[]; unitsConsumed?: number; accounts?: Array<{ lamports: number; data: string[] } | null> };

/** A fake chain answering the RPC calls the write layer makes. Every call is logged. */
export class FakeChain {
  accounts = new Map<string, FakeAccount>();
  calls: string[] = [];
  genesis = LOCAL_GENESIS;
  fees: number[] | Error = [0, 0, 10_000, 20_000];
  simulate: SimHandler = () => ({ err: null, logs: [], unitsConsumed: 50_000 });
  simulateCalls: Array<{ vtx: VersionedTransaction; config: unknown }> = [];

  set(address: PublicKey, a: FakeAccount): this {
    this.accounts.set(address.toBase58(), a);
    return this;
  }

  /** Both programs deployed (stub + ProgramData), and `global` + AmmConfig + permission + fee receiver. */
  static healthy(g: GlobalConfig = globalValue()): FakeChain {
    const c = new FakeChain();
    for (const id of [LAUNCH, CPSWAP]) {
      const pd = Keypair.generate().publicKey;
      const stub = new Uint8Array(36);
      new DataView(stub.buffer).setUint32(0, 2, true);
      stub.set(pd.toBytes(), 4);
      c.set(id, { lamports: 1, owner: BPF_LOADER_UPGRADEABLE_ID, data: stub, executable: true });
      c.set(pd, { lamports: 10_000_000, owner: BPF_LOADER_UPGRADEABLE_ID, data: new Uint8Array(64) });
    }
    c.set(globalPda(LAUNCH), { lamports: rent(202), owner: LAUNCH, data: encodeGlobal(g) });
    c.set(AMM_CONFIG, { lamports: rent(236), owner: CPSWAP, data: encodeAmmConfig() });
    return c;
  }

  /** The public fee tier (tier 1) at its derived address, with the owner's values unless `over` says otherwise. */
  addTier1(over: Partial<AmmConfigOverrides> = {}): this {
    return this.set(publicTierConfig(CPSWAP), { lamports: rent(AMM_CONFIG_LEN), owner: CPSWAP, data: encodeAmmConfig({ ...TIER1_VALUES, ...over }) });
  }

  /** The pool program's fee account for openings (`CP_CREATE_POOL_FEE_RECEIVER`), ready unless `over` says otherwise. */
  addFeeReceiver(over: Partial<FeeReceiverOptions> = {}): this {
    const data = encodeFeeReceiver(over);
    return this.set(CP_CREATE_POOL_FEE_RECEIVER, { lamports: rent(data.length), owner: over.program ?? TOKEN_PROGRAM_ID, data });
  }

  addCurve(curve: BondingCurve, lamports?: bigint): this {
    const floor = BigInt(rent(179));
    return this.set(curvePda(curve.mint, LAUNCH), {
      lamports: Number(lamports ?? floor + curve.realSolReserves),
      owner: LAUNCH,
      data: encodeCurve(curve),
    });
  }

  fund(who: PublicKey, lamports: number): this {
    return this.set(who, { lamports, owner: new PublicKey('11111111111111111111111111111111'), data: new Uint8Array(0) });
  }

  tokenAccount(address: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, o: TokenAccountOptions = {}): this {
    return this.set(address, { lamports: rent(165), owner: TOKEN_PROGRAM_ID, data: encodeTokenAccountWith(mint, owner, amount, o) });
  }

  token2022Account(address: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, o: TokenAccountOptions & { cpiGuard?: boolean; memoRequired?: boolean } = {}): this {
    const data = encodeToken2022Account(mint, owner, amount, o);
    return this.set(address, { lamports: rent(data.length), owner: TOKEN_2022_PROGRAM_ID, data });
  }

  mint(address: PublicKey, o: MintOptions = {}): this {
    return this.set(address, { lamports: rent(82), owner: TOKEN_PROGRAM_ID, data: encodeMint(o) });
  }

  mint2022(address: PublicKey, extensions: Array<[number, number]>, o: MintOptions = {}): this {
    const data = encodeMint2022(extensions, o);
    return this.set(address, { lamports: rent(data.length), owner: TOKEN_2022_PROGRAM_ID, data });
  }

  info(address: PublicKey) {
    const a = this.accounts.get(address.toBase58());
    if (!a) return null;
    return { lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data), executable: a.executable ?? false, rentEpoch: 0 };
  }

  /** Post-state for a simulation: this chain's accounts, with the given changes applied. */
  post(
    addresses: string[],
    changes: Record<string, { lamportsDelta?: number; tokenAmount?: bigint; mint?: PublicKey; owner?: PublicKey; closed?: boolean }>,
  ) {
    return addresses.map((addr) => {
      const cur = this.accounts.get(addr);
      const ch = changes[addr];
      if (ch?.closed) return null;
      if (!cur && !ch) return null;
      const lamports = (cur?.lamports ?? 0) + (ch?.lamportsDelta ?? 0);
      let data = cur?.data ?? new Uint8Array(0);
      if (ch?.tokenAmount !== undefined) {
        data = encodeTokenAccount(ch.mint ?? PublicKey.default, ch.owner ?? PublicKey.default, ch.tokenAmount);
      }
      return { lamports: lamports || (ch?.tokenAmount !== undefined ? rent(165) : 0), data: [Buffer.from(data).toString('base64'), 'base64'] };
    });
  }

  // ── the RPC surface ──
  getGenesisHash = async () => {
    this.calls.push('getGenesisHash');
    return this.genesis;
  };
  getAccountInfo = async (address: PublicKey) => {
    this.calls.push('getAccountInfo');
    return this.info(address);
  };
  getMultipleAccountsInfo = async (keys: PublicKey[]) => {
    this.calls.push('getMultipleAccountsInfo');
    return keys.map((k) => this.info(k));
  };
  getMinimumBalanceForRentExemption = async (n: number) => {
    this.calls.push('getMinimumBalanceForRentExemption');
    return rent(n);
  };
  getLatestBlockhash = async () => {
    this.calls.push('getLatestBlockhash');
    return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 };
  };
  getRecentPrioritizationFees = async () => {
    this.calls.push('getRecentPrioritizationFees');
    if (this.fees instanceof Error) throw this.fees;
    return this.fees.map((f, i) => ({ slot: i, prioritizationFee: f }));
  };
  simulateTransaction = async (vtx: VersionedTransaction, config?: { accounts?: { addresses: string[] } }) => {
    this.calls.push('simulateTransaction');
    this.simulateCalls.push({ vtx, config });
    return { context: { slot: 1 }, value: this.simulate(vtx, config, this) };
  };
  // Submit-side calls are replaced per test.
  sendRawTransaction = async (_raw: Uint8Array, _opts?: unknown): Promise<string> => {
    this.calls.push('sendRawTransaction');
    return 'sent';
  };
  getSignatureStatuses = async (_s: string[], _o?: unknown): Promise<{ context?: { slot: number }; value: unknown[] }> => {
    this.calls.push('getSignatureStatuses');
    return { value: [{ err: null, confirmationStatus: 'confirmed', slot: 7 }] };
  };
  getBlockHeight = async (_c?: unknown): Promise<number> => {
    this.calls.push('getBlockHeight');
    return 10;
  };
  /** The finalized slot. A status answer counts as "no record" only from a server at or past it. */
  getSlot = async (_c?: unknown): Promise<number> => {
    this.calls.push('getSlot');
    return FakeChain.FINALIZED_SLOT;
  };
  static readonly FINALIZED_SLOT = 500;
  getTransaction = async (_s: string, _o?: unknown): Promise<unknown> => {
    this.calls.push('getTransaction');
    return null;
  };
}

/** The amount of a token account on the fake chain, or null when there is none. */
function amountOnChain(c: FakeChain, k: PublicKey): bigint | null {
  const a = c.accounts.get(k.toBase58());
  if (!a || a.data.length < 72) return null;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

export interface CreateSimOptions {
  /** What reaches the fee account, given the fee the tier on this chain charges (default: exactly that). */
  feeArrives?: (fee: bigint) => bigint;
}

/**
 * Runs cp-swap's `initialize` on the fake chain's accounts and reports the watched
 * post-state: the wrapped-SOL account opened (rent) and funded, the tier's fee paid into
 * the fee account, every pool account paid for (pool 637, price record 4075, share token
 * 82, two 165-byte vaults, the opener's pool-share account 165), isqrt(a·b) − 100 shares
 * to the opener, the tokens out of the opener's account, and the wrapped-SOL account
 * closed back to the wallet when the transaction closes it. The program's own refusals:
 * the tier switched off (6000), below 100 shares (6009), and an LP mint already there
 * (the System program's "already in use", custom 0).
 */
export function createSimulator(o: CreateSimOptions = {}): SimHandler {
  return (vtx, config, chain) => {
    const keys = vtx.message.staticAccountKeys;
    const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
    const open = ixs.find((i) => i.program.equals(CPSWAP) && IX_INITIALIZE.every((b, j) => i.data[j] === b));
    if (!open) return { err: 'no initialize', logs: [], unitsConsumed: 1 };
    const d = open.data;
    const u64 = (at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
    const [init0, init1] = [u64(8), u64(16)];
    const at = (i: number) => open.accounts[i]!;
    const cpFail = (code: number) => ({ err: { InstructionError: [3, { Custom: code }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 30_000 });
    const tierAcc = chain.accounts.get(at(1).toBase58());
    const tier = tierAcc ? decodeAmmConfig(at(1).toBase58(), tierAcc.data) : null;
    if (!tier) return cpFail(3012);
    if (tier.disableCreatePool) return cpFail(6000);
    if (chain.accounts.has(at(6).toBase58())) {
      return {
        err: { InstructionError: [3, { Custom: 0 }] },
        logs: [`Allocate: account Address { address: ${at(6).toBase58()}, base: None } already in use`, 'Program 11111111111111111111111111111111 failed: custom program error: 0x0'],
        unitsConsumed: 20_000,
      };
    }
    const supply = isqrt(init0 * init1);
    if (supply < 100n) return cpFail(6009);
    const signer = at(0);
    const wsolAta = associatedTokenAddress(WSOL_MINT, signer);
    const solIs0 = at(4).equals(WSOL_MINT);
    const userTok = at(solIs0 ? 8 : 7);
    const tokenMint = at(solIs0 ? 5 : 4);
    const [sol, tokens] = solIs0 ? [init0, init1] : [init1, init0];
    const wrapped = ixs.filter((i) => i.program.equals(SYSTEM_PROGRAM)).reduce((n, i) => n + new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(4, true), 0n);
    const wsolCreated = ixs.some((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && i.accounts[1]!.equals(wsolAta)) && !chain.accounts.has(wsolAta.toBase58());
    const closes = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
    const wsolBefore = amountOnChain(chain, wsolAta) ?? 0n;
    const tokBefore = amountOnChain(chain, userTok) ?? 0n;
    if (tokBefore < tokens) return { err: { InstructionError: [3, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
    if (wsolBefore + wrapped < sol) return { err: { InstructionError: [3, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
    if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 120_000 };

    const fee = tier.createPoolFee;
    const arrives = o.feeArrives ? o.feeArrives(fee) : fee;
    const wsolAfter = wsolBefore + wrapped - sol;
    const poolRents = rent(POOL_STATE_LEN) + rent(4075) + rent(82) + rent(165) + rent(165) + rent(165);
    const signerDelta = -Number(wrapped) - (wsolCreated ? rent(165) : 0) - Number(fee) - poolRents + (closes ? Number(wsolAfter) + rent(165) : 0);
    const feeBefore = amountOnChain(chain, at(12)) ?? 0n;
    const changes: Parameters<FakeChain['post']>[1] = {
      [signer.toBase58()]: { lamportsDelta: signerDelta },
      [userTok.toBase58()]: { tokenAmount: tokBefore - tokens, mint: tokenMint, owner: signer },
      [wsolAta.toBase58()]: closes ? { closed: true } : { tokenAmount: wsolAfter, mint: WSOL_MINT, owner: signer },
      [at(9).toBase58()]: { tokenAmount: supply - 100n, mint: at(6), owner: signer },
      [at(12).toBase58()]: { tokenAmount: feeBefore + arrives, mint: WSOL_MINT, owner: VAULT },
    };
    return { err: null, logs: [], unitsConsumed: 120_000, accounts: chain.post(config.accounts.addresses, changes) };
  };
}

const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
