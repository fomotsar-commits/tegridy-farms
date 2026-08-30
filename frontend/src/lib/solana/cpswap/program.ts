import { PublicKey } from '@solana/web3.js';

/**
 * cp-swap program identity, PDAs, account layouts and discriminators.
 *
 * ⛔ THERE IS NO PROGRAM AT `PROGRAM_ID` TODAY. The fork was deployed to
 * mainnet 2026-08-08 and CLOSED on 2026-08-13; its ProgramData account is
 * deleted, which makes the id permanently SPENT — Solana never lets a closed
 * upgradeable program id hold a program again. The constant below is a RECORD
 * of where the venue ran, never a deploy target. A restart declares a new id
 * under a fresh keypair, and `LIVE_PROGRAM_ID` picks it up from env with no
 * code change.
 *
 * The same trap the bonding-curve client documents applies here and is the
 * reason `probeDeployment` in read.ts reads ProgramData and not the program
 * account: **a closed program still reads as executable.** `solana program
 * close` deletes ProgramData and leaves the 36-byte stub with
 * `executable: true`, so a naive `getAccountInfo(PROGRAM_ID)` reports
 * "deployed" for a spent id.
 *
 * WHAT THIS PROGRAM IS: a VERBATIM fork of raydium-cp-swap @ 78f254e1023751e7…
 * CI's `diff-guard` clones upstream, refuses any differing file outside two,
 * and sha256-hashes the remaining delta against a pinned value — currently 86
 * lines across `lib.rs`, `create_support_mint_associated.rs` and `Cargo.toml`,
 * all of it authority constants and comments. So every layout, seed and
 * discriminator below is Raydium's, and a resync that changes any of them
 * fails `program.test.ts` before it can misdecode an account.
 *
 * There is NO committed IDL (`solana/tegridy-amm/.gitignore` ignores `target/`),
 * so the layouts here are encoded BY HAND from the program source and pinned by
 * test against the program's own `LEN` constants.
 *
 * There is no React here and there must not be.
 */

/* ─────────────────────────────── identity ───────────────────────────────── */

/**
 * ⛔ SPENT. Where the fork ran between 2026-08-08 and the close of its
 * ProgramData `6TnZb1GTHhPAYsrbtwfELkqQrXyqCfv7V6s27RJKXHAF` on 2026-08-13.
 * Registered in frontend/scripts/addresses.json with the closure evidence.
 */
export const SPENT_PROGRAM_ID = new PublicKey('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');

/**
 * The program id this client talks to. Empty until the operator redeploys under
 * a fresh keypair and publishes it as `VITE_SOLANA_CPSWAP_PROGRAM`.
 *
 * Deliberately NOT defaulted to `SPENT_PROGRAM_ID`: a default that points at a
 * spent id is how a surface ends up quoting against a program that cannot
 * execute. Absent means absent, and every read below refuses rather than
 * guessing.
 */
export const LIVE_PROGRAM_ID: PublicKey | null = (() => {
  const raw = (import.meta.env?.VITE_SOLANA_CPSWAP_PROGRAM as string | undefined)?.trim();
  if (!raw) return null;
  try {
    const pk = new PublicKey(raw);
    // Refuse the spent id even if someone pastes it back in.
    return pk.equals(SPENT_PROGRAM_ID) ? null : pk;
  } catch {
    return null;
  }
})();

/** True once the venue has an id to talk to at all. Not proof it is deployed. */
export function hasProgramId(): boolean {
  return LIVE_PROGRAM_ID !== null;
}

/**
 * The AmmConfig index this venue's pools use. Config 0 is the conventional
 * "standard" config on Raydium's own deployment and there is no reason to
 * differ; a second index is a deliberate act (a different fee tier).
 */
export const DEFAULT_AMM_CONFIG_INDEX = 0;

/* ──────────────────────────────── seeds ─────────────────────────────────── */

const enc = new TextEncoder();
export const AMM_CONFIG_SEED = enc.encode('amm_config');
export const AUTH_SEED = enc.encode('vault_and_lp_mint_auth_seed');
export const POOL_SEED = enc.encode('pool');
export const POOL_LP_MINT_SEED = enc.encode('pool_lp_mint');
export const POOL_VAULT_SEED = enc.encode('pool_vault');
export const OBSERVATION_SEED = enc.encode('observation');

/* ───────────────────────────────── PDAs ─────────────────────────────────── */

function derive(programId: PublicKey, seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** `[AMM_CONFIG_SEED, index.to_be_bytes()]` — note BIG-endian u16. */
export function deriveAmmConfig(programId: PublicKey, index: number): PublicKey {
  const be = new Uint8Array(2);
  new DataView(be.buffer).setUint16(0, index, false);
  return derive(programId, [AMM_CONFIG_SEED, be]);
}

/** `[AUTH_SEED]` — the vault + LP-mint authority, one per program. */
export function deriveAuthority(programId: PublicKey): PublicKey {
  return derive(programId, [AUTH_SEED]);
}

/**
 * `[POOL_SEED, amm_config, token_0_mint, token_1_mint]`.
 *
 * ORDER IS NOT YOURS TO CHOOSE: `initialize` carries
 * `constraint = token_0_mint.key() < token_1_mint.key()`, so the mints must be
 * sorted by their raw bytes. `sortMints` below is the only correct way to
 * produce them, and every caller must use it — a pool derived from unsorted
 * mints is simply a different, non-existent address.
 */
export function derivePool(
  programId: PublicKey,
  ammConfig: PublicKey,
  token0Mint: PublicKey,
  token1Mint: PublicKey,
): PublicKey {
  return derive(programId, [POOL_SEED, ammConfig.toBytes(), token0Mint.toBytes(), token1Mint.toBytes()]);
}

export function deriveLpMint(programId: PublicKey, pool: PublicKey): PublicKey {
  return derive(programId, [POOL_LP_MINT_SEED, pool.toBytes()]);
}

export function deriveVault(programId: PublicKey, pool: PublicKey, mint: PublicKey): PublicKey {
  return derive(programId, [POOL_VAULT_SEED, pool.toBytes(), mint.toBytes()]);
}

export function deriveObservation(programId: PublicKey, pool: PublicKey): PublicKey {
  return derive(programId, [OBSERVATION_SEED, pool.toBytes()]);
}

/**
 * The program's mint ordering — a raw byte comparison, matching Rust's
 * `Pubkey` `Ord`. Returns which side the caller's mint landed on so a quote
 * can pick the right vault without re-deriving.
 */
export function sortMints(a: PublicKey, b: PublicKey): { token0: PublicKey; token1: PublicKey; flipped: boolean } {
  const ab = a.toBytes();
  const bb = b.toBytes();
  for (let i = 0; i < 32; i++) {
    const x = ab[i]!;
    const y = bb[i]!;
    if (x !== y) {
      return x < y
        ? { token0: a, token1: b, flipped: false }
        : { token0: b, token1: a, flipped: true };
    }
  }
  return { token0: a, token1: b, flipped: false };
}

/* ─────────────────────────── discriminators ─────────────────────────────── */

// Anchor: first 8 bytes of sha256("global:<snake_case_name>") for instructions
// and sha256("account:<StructName>") for accounts. Computed once and pinned by
// program.test.ts, which recomputes them — so a rename upstream fails here.
export const IX_INITIALIZE = Uint8Array.from([175, 175, 109, 31, 13, 152, 155, 237]);
export const IX_DEPOSIT = Uint8Array.from([242, 35, 198, 137, 82, 225, 242, 182]);
export const IX_WITHDRAW = Uint8Array.from([183, 18, 70, 156, 148, 109, 161, 34]);
export const IX_SWAP_BASE_INPUT = Uint8Array.from([143, 190, 90, 218, 196, 30, 51, 222]);
export const IX_SWAP_BASE_OUTPUT = Uint8Array.from([55, 217, 98, 86, 163, 74, 180, 173]);

export const ACCOUNT_POOL_STATE = Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]);
export const ACCOUNT_AMM_CONFIG = Uint8Array.from([218, 244, 33, 104, 203, 203, 43, 111]);

/* ──────────────────────────────── layouts ───────────────────────────────── */

/**
 * `AmmConfig` — `#[account]`, i.e. Borsh, 8-byte discriminator then fields in
 * declaration order with no padding. Offsets pinned against the program's own
 * `AmmConfig::LEN`.
 */
export const AMM_CONFIG_OFFSETS = {
  bump: 8,
  disableCreatePool: 9,
  index: 10,
  tradeFeeRate: 12,
  protocolFeeRate: 20,
  fundFeeRate: 28,
  createPoolFee: 36,
  protocolOwner: 44,
  fundOwner: 76,
  creatorFeeRate: 108,
} as const;
export const AMM_CONFIG_LEN = 236;

/**
 * `PoolState` — `#[account(zero_copy(unsafe))] #[repr(C, packed)]`, so fields
 * are sequential with NO alignment padding. That `packed` is load-bearing: with
 * plain `repr(C)` every u64 after the five u8s would be padded to an 8-byte
 * boundary and half these offsets would be wrong.
 */
export const POOL_STATE_OFFSETS = {
  ammConfig: 8,
  poolCreator: 40,
  token0Vault: 72,
  token1Vault: 104,
  lpMint: 136,
  token0Mint: 168,
  token1Mint: 200,
  token0Program: 232,
  token1Program: 264,
  observationKey: 296,
  authBump: 328,
  status: 329,
  lpMintDecimals: 330,
  mint0Decimals: 331,
  mint1Decimals: 332,
  lpSupply: 333,
  protocolFeesToken0: 341,
  protocolFeesToken1: 349,
  fundFeesToken0: 357,
  fundFeesToken1: 365,
  openTime: 373,
  recentEpoch: 381,
  creatorFeeOn: 389,
  enableCreatorFee: 390,
  creatorFeesToken0: 397,
  creatorFeesToken1: 405,
} as const;
export const POOL_STATE_LEN = 637;

/**
 * Pool status bits — `PoolStatusBitIndex`. A set bit DISABLES the action, and
 * `swap_base_input` refuses outright when bit 2 is set, so a quote against a
 * swap-disabled pool is a quote the program will reject.
 */
export const POOL_STATUS_DISABLE_DEPOSIT = 1;
export const POOL_STATUS_DISABLE_WITHDRAW = 2;
export const POOL_STATUS_DISABLE_SWAP = 4;

/** Creator-fee collect mode — `creator_fee_on`. */
export const CREATOR_FEE_ON_BOTH = 0;
export const CREATOR_FEE_ON_TOKEN_0 = 1;
export const CREATOR_FEE_ON_TOKEN_1 = 2;

/* ──────────────────────────────── decoders ──────────────────────────────── */

function u8At(d: Uint8Array, o: number): number {
  return d[o]!;
}
function u16At(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
}
function u64At(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}
function pkAt(d: Uint8Array, o: number): string {
  return new PublicKey(d.subarray(o, o + 32)).toBase58();
}

function discriminatorMatches(d: Uint8Array, want: Uint8Array): boolean {
  if (d.length < 8) return false;
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) return false;
  return true;
}

export interface AmmConfigView {
  address: string;
  index: number;
  disableCreatePool: boolean;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  createPoolFee: bigint;
  creatorFeeRate: bigint;
  protocolOwner: string;
  fundOwner: string;
}

/** Decode an AmmConfig, or null if the bytes are not one. Never throws. */
export function decodeAmmConfig(address: string, data: Uint8Array): AmmConfigView | null {
  try {
    if (data.length < AMM_CONFIG_LEN) return null;
    if (!discriminatorMatches(data, ACCOUNT_AMM_CONFIG)) return null;
    const o = AMM_CONFIG_OFFSETS;
    return {
      address,
      index: u16At(data, o.index),
      disableCreatePool: u8At(data, o.disableCreatePool) !== 0,
      tradeFeeRate: u64At(data, o.tradeFeeRate),
      protocolFeeRate: u64At(data, o.protocolFeeRate),
      fundFeeRate: u64At(data, o.fundFeeRate),
      createPoolFee: u64At(data, o.createPoolFee),
      creatorFeeRate: u64At(data, o.creatorFeeRate),
      protocolOwner: pkAt(data, o.protocolOwner),
      fundOwner: pkAt(data, o.fundOwner),
    };
  } catch {
    return null;
  }
}

export interface PoolStateView {
  address: string;
  ammConfig: string;
  poolCreator: string;
  token0Vault: string;
  token1Vault: string;
  lpMint: string;
  token0Mint: string;
  token1Mint: string;
  token0Program: string;
  token1Program: string;
  observationKey: string;
  status: number;
  lpMintDecimals: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  creatorFeesToken0: bigint;
  creatorFeesToken1: bigint;
  openTime: bigint;
  creatorFeeOn: number;
  enableCreatorFee: boolean;
}

/** Decode a PoolState, or null if the bytes are not one. Never throws. */
export function decodePoolState(address: string, data: Uint8Array): PoolStateView | null {
  try {
    if (data.length < POOL_STATE_LEN) return null;
    if (!discriminatorMatches(data, ACCOUNT_POOL_STATE)) return null;
    const o = POOL_STATE_OFFSETS;
    return {
      address,
      ammConfig: pkAt(data, o.ammConfig),
      poolCreator: pkAt(data, o.poolCreator),
      token0Vault: pkAt(data, o.token0Vault),
      token1Vault: pkAt(data, o.token1Vault),
      lpMint: pkAt(data, o.lpMint),
      token0Mint: pkAt(data, o.token0Mint),
      token1Mint: pkAt(data, o.token1Mint),
      token0Program: pkAt(data, o.token0Program),
      token1Program: pkAt(data, o.token1Program),
      observationKey: pkAt(data, o.observationKey),
      status: u8At(data, o.status),
      lpMintDecimals: u8At(data, o.lpMintDecimals),
      mint0Decimals: u8At(data, o.mint0Decimals),
      mint1Decimals: u8At(data, o.mint1Decimals),
      lpSupply: u64At(data, o.lpSupply),
      protocolFeesToken0: u64At(data, o.protocolFeesToken0),
      protocolFeesToken1: u64At(data, o.protocolFeesToken1),
      fundFeesToken0: u64At(data, o.fundFeesToken0),
      fundFeesToken1: u64At(data, o.fundFeesToken1),
      creatorFeesToken0: u64At(data, o.creatorFeesToken0),
      creatorFeesToken1: u64At(data, o.creatorFeesToken1),
      openTime: u64At(data, o.openTime),
      creatorFeeOn: u8At(data, o.creatorFeeOn),
      enableCreatorFee: u8At(data, o.enableCreatorFee) !== 0,
    };
  } catch {
    return null;
  }
}

/** Whether the program would accept a swap against this pool right now. */
export function swapEnabled(pool: Pick<PoolStateView, 'status'>): boolean {
  return (pool.status & POOL_STATUS_DISABLE_SWAP) === 0;
}
export function depositEnabled(pool: Pick<PoolStateView, 'status'>): boolean {
  return (pool.status & POOL_STATUS_DISABLE_DEPOSIT) === 0;
}
export function withdrawEnabled(pool: Pick<PoolStateView, 'status'>): boolean {
  return (pool.status & POOL_STATUS_DISABLE_WITHDRAW) === 0;
}

/**
 * `pool_state.is_creator_fee_on_input(trade_direction)` — which side of the
 * trade the creator's cut is taken from. The two modes are NOT symmetric in
 * the fee maths (see math.ts `swapBaseInput`), so getting this backwards
 * misquotes every trade on a pool that charges a creator fee.
 *
 * mode 0 (both):        whatever the input token is → always true.
 * mode 1 (token_0 only): true when the trader is PAYING token_0.
 * mode 2 (token_1 only): true when the trader is PAYING token_1.
 *
 * Anything else is `InvalidFeeModel` in the program, so it is `null` here —
 * a pool this client cannot price is one it must refuse to price, not one it
 * guesses a default for.
 */
export function isCreatorFeeOnInput(creatorFeeOn: number, inputIsToken0: boolean): boolean | null {
  if (creatorFeeOn === CREATOR_FEE_ON_BOTH) return true;
  if (creatorFeeOn === CREATOR_FEE_ON_TOKEN_0) return inputIsToken0;
  if (creatorFeeOn === CREATOR_FEE_ON_TOKEN_1) return !inputIsToken0;
  return null;
}
