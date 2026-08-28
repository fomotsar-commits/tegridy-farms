import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { solanaRpcEndpoint } from './solana';

/**
 * Bungalow staking adapter — the venue's thin seam over the Streamflow
 * staking SDK (@streamflow/staking 13.3.1, verified against its shipped
 * type definitions and README 2026-08-26).
 *
 * WHY THIS FILE EXISTS (and stays thin): the house rule is battle-tested
 * code only — the pool program, accounting and grouped flows are
 * Streamflow's, audited and SDK-shipped. Everything here is mapping,
 * defensive reads and honest error wrapping; there is deliberately NO math
 * of ours on the money path.
 *
 * The ONE apparent exception, and why it is not one: `stakeWeightScaled` and
 * `rewardRatePerPeriod` are DISPLAY math (what a lock is worth before the
 * user signs). They are exact transcriptions of the SDK's own
 * `calculateStakeWeight` / `calculateRewardRateFromAmount`, pinned against
 * the SDK's implementations by bungalowStakingRates.test.ts. They compute
 * nothing that rides a transaction — the amounts and durations the wallet
 * signs still come straight from the SDK's prepare paths below.
 *
 * FUNDING-LAST CONTRACT: the pool is expected to go live with an EMPTY
 * reward vault (the operator funds last). readPool() therefore reports the
 * vault balance as its own first-class fact — 0 renders as a real, labeled
 * zero, "could not read" stays an outage, and no rate shown anywhere is
 * presented as a yield the pool is actually paying while the vault is dry.
 *
 * Every @streamflow/* import is DYNAMIC: the SDK loads only after a pool
 * address is configured and the live section actually mounts — no bungalow
 * pool, no bytes.
 *
 * All calls resolve, never throw: `{ ok: false, reason }` is the only
 * failure shape, so render paths cannot crash on RPC weather.
 */

/** The program's fixed-point scale for weights (1e9 = a 1.00x multiplier). */
export const WEIGHT_SCALE = 1_000_000_000n;

/** `reward_amount` is quoted as a fraction of 1 / 10^9 (SDK REWARD_AMOUNT_DECIMALS). */
export const REWARD_AMOUNT_DECIMALS = 9;

export const SECONDS_PER_YEAR = 365 * 86_400;

export interface RewardPoolView {
  address: string;
  mint: string;
  nonce: number;
  /** Escrow token account the rewards are paid out of. */
  vault: string;
  /** Decimals of the reward mint, read on-chain (never assumed). */
  decimals: number;
  /** Raw reward-vault balance (base units of the reward mint); null = unreadable. */
  fundedRaw: bigint | null;
  /** Whether ANYONE may top this vault up, or only the pool authority. */
  permissionless: boolean;
  /** On-chain configured rate parts (raw, 1e9-scaled amount per effective token per period). */
  rewardAmountRaw: string;
  rewardPeriodSecs: number;
}

export interface PoolView {
  address: string;
  mint: string;
  /** Decimals of the stake mint, read on-chain (never assumed). */
  decimals: number;
  /**
   * The mint's OWNER program (legacy SPL or Token-2022), detected at read
   * time and threaded through every write — BAYLA is Token-2022, and the
   * first mainnet broadcast died with IncorrectProgramId for assuming
   * legacy (2026-08-26). Never assume; always detect.
   */
  tokenProgram: string;
  minDurationSecs: number;
  maxDurationSecs: number;
  /**
   * Lock-weight bounds, 1e9-scaled: `1e9` = a 1.00x multiplier. When the two
   * are equal the pool grants NO duration bonus — a longer lock earns exactly
   * the same rate as the shortest one, and the UI has to say so rather than
   * imply a boost curve that does not exist. (The live BAYLA lighthouse is
   * exactly this case: minWeight = maxWeight = 1e9, read on mainnet
   * 2026-08-28.)
   */
  minWeightScaled: bigint;
  maxWeightScaled: bigint;
  /** Cool-down between requesting an unstake and taking the tokens; 0 = none. */
  unstakePeriodSecs: number;
  /** Raw total staked (base units of the stake mint); null = unreadable. */
  totalStakeRaw: bigint | null;
  /**
   * Total staked NORMALISED back to raw stake units after each entry's weight
   * (the chain stores it as the sum of amount x weight, i.e. scaled by 1e9 —
   * see the program's own field docs). Null = unreadable.
   */
  totalEffectiveStakeRaw: bigint | null;
  rewardPools: RewardPoolView[];
}

export interface StakeEntryView {
  address: string;
  nonce: number;
  amountRaw: bigint;
  durationSecs: number;
  createdTs: number;
  /** 0 = still open. */
  closedTs: number;
  /** Weight-adjusted stake in raw stake units (what rewards are paid on). */
  effectiveAmountRaw: bigint;
  /**
   * Rewards accrued and not yet claimed, keyed by reward-pool nonce, in raw
   * units of that reward mint. `null` = the reward entry could not be read —
   * an outage, never a zero. Computed by the SDK's own `calcRewards`.
   */
  pendingRaw: Record<number, bigint | null>;
}

export type Result<T> = { ok: true } & T;
export type Failure = { ok: false; reason: string };

const READ_FAIL = 'The pool could not be read right now — that is an outage, not a zero.';

/* eslint-disable @typescript-eslint/no-explicit-any -- SDK account structs are
   IDL-derived; every access below is defensive against field drift. */

// ONE dynamic-import site for the SDK, shared by every call below — both so
// the chunk graph stays predictable and so tests mock a single seam.
async function loadSdk() {
  const [staking, { ICluster }] = await Promise.all([
    import('@streamflow/staking'),
    import('@streamflow/common'),
  ]);
  const client = new staking.SolanaStakingClient({
    clusterUrl: solanaRpcEndpoint(),
    cluster: ICluster.Mainnet,
  });
  return { client, staking };
}

async function makeClient() {
  return (await loadSdk()).client;
}

function bnToBigint(v: unknown): bigint | null {
  try {
    if (v === null || v === undefined) return null;
    return BigInt((v as { toString(): string }).toString());
  } catch {
    return null;
  }
}

function bnToNumber(v: unknown, fallback = 0): number {
  const b = bnToBigint(v);
  if (b === null) return fallback;
  const n = Number(b);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Mint decimals, read on-chain. Falls back to `fallback` when unreadable. */
async function readMintDecimals(client: any, mint: string, fallback: number): Promise<number> {
  try {
    if (!mint) return fallback;
    const { PublicKey } = await import('@solana/web3.js');
    const info: any = await client.connection.getParsedAccountInfo(new PublicKey(mint));
    const d = info?.value?.data?.parsed?.info?.decimals;
    return typeof d === 'number' && d >= 0 && d <= 18 ? d : fallback;
  } catch {
    return fallback;
  }
}

/* ───────────────────────── display math (SDK-pinned) ─────────────────────── */

/**
 * The lock weight for `durationSecs`, 1e9-scaled — an exact transcription of
 * the SDK's `calculateStakeWeight(minDuration, maxDuration, maxWeight,
 * duration)`, pinned against it by test. Clamps to >= 1.00x exactly as the
 * program does, so a flat-weight pool always reports 1e9.
 */
export function stakeWeightScaled(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs' | 'maxWeightScaled'>,
  durationSecs: number,
): bigint {
  const span = BigInt(pool.maxDurationSecs) - BigInt(pool.minDurationSecs);
  if (span <= 0n) return WEIGHT_SCALE;
  const over = BigInt(Math.trunc(durationSecs)) - BigInt(pool.minDurationSecs);
  if (over <= 0n) return WEIGHT_SCALE;
  const normalized = (over * WEIGHT_SCALE) / span;
  const weightDiff = pool.maxWeightScaled - WEIGHT_SCALE;
  const w = WEIGHT_SCALE + (normalized * weightDiff) / WEIGHT_SCALE;
  return w > WEIGHT_SCALE ? w : WEIGHT_SCALE;
}

/** The same weight as a human multiplier (1.00 = no bonus). */
export function stakeWeight(
  pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs' | 'maxWeightScaled'>,
  durationSecs: number,
): number {
  return Number(stakeWeightScaled(pool, durationSecs)) / Number(WEIGHT_SCALE);
}

/** True when the pool grants no duration bonus at all (min weight == max weight). */
export function isFlatWeight(pool: Pick<PoolView, 'minWeightScaled' | 'maxWeightScaled'>): boolean {
  return pool.minWeightScaled === pool.maxWeightScaled;
}

/**
 * Reward tokens paid per ONE stake token per reward period, at 1.00x weight —
 * a transcription of the SDK's `calculateRewardRateFromAmount(rewardAmount,
 * stakeDecimals, rewardDecimals)`.
 */
export function rewardRatePerPeriod(
  pool: Pick<PoolView, 'decimals'>,
  rp: Pick<RewardPoolView, 'decimals' | 'rewardAmountRaw'>,
): number {
  const scale = rp.decimals + REWARD_AMOUNT_DECIMALS - pool.decimals;
  const raw = Number(rp.rewardAmountRaw || '0');
  if (!Number.isFinite(raw)) return 0;
  return raw / 10 ** scale;
}

/**
 * The pool's CONFIGURED annual rate for a lock of `durationSecs`: reward
 * tokens per one staked token per year, weight applied. This is the rate the
 * program is set to pay — it is NOT a claim that the vault can pay it, which
 * is why every caller renders it beside the vault balance.
 */
export function configuredAnnualRate(pool: PoolView, rp: RewardPoolView, durationSecs: number): number {
  if (rp.rewardPeriodSecs <= 0) return 0;
  const periodsPerYear = SECONDS_PER_YEAR / rp.rewardPeriodSecs;
  return rewardRatePerPeriod(pool, rp) * periodsPerYear * stakeWeight(pool, durationSecs);
}

/**
 * True when the reward mint IS the stake mint — the only case where the rate
 * above is a percentage of the deposit and may be printed as an APR. Any other
 * pair needs two prices to become a percentage, and this venue does not invent
 * prices, so those render as "x REWARD per BAYLA per year" instead.
 */
export function rateIsPercent(pool: Pick<PoolView, 'mint'>, rp: Pick<RewardPoolView, 'mint'>): boolean {
  return rp.mint !== '' && rp.mint === pool.mint;
}

/**
 * How long the vault can pay at the CURRENT effective stake, in seconds, or
 * null when that cannot be stated honestly (nothing staked, vault unreadable
 * or empty, zero rate). Nothing here extrapolates: it answers "at today's
 * stake and today's rate", which is the only runway a pool can be held to.
 */
export function vaultRunwaySecs(pool: PoolView, rp: RewardPoolView): number | null {
  if (rp.fundedRaw === null || rp.fundedRaw === 0n) return null;
  const effective = pool.totalEffectiveStakeRaw;
  if (effective === null || effective === 0n) return null;
  const stakedTokens = Number(effective) / 10 ** pool.decimals;
  const perPeriodRaw = stakedTokens * rewardRatePerPeriod(pool, rp) * 10 ** rp.decimals;
  if (!(perPeriodRaw > 0)) return null;
  const periods = Number(rp.fundedRaw) / perPeriodRaw;
  if (!Number.isFinite(periods)) return null;
  return Math.floor(periods * rp.rewardPeriodSecs);
}

/**
 * Unix seconds at which an entry's lock expires. The program refuses an
 * unstake before this ("Stake is locked, unstake is not possible"), so the UI
 * has to disable the button rather than let the wallet eat the refusal.
 */
export function unlockTs(entry: Pick<StakeEntryView, 'createdTs' | 'durationSecs'>): number {
  return entry.createdTs + entry.durationSecs;
}

export interface LockPreset {
  label: string;
  days: number;
  seconds: number;
}

const DAY = 86_400;

/**
 * The lock-duration buttons, in the venue's own LOCK_OPTIONS idiom (7 Days /
 * 30 Days / 90 Days / 6 Months / 1 Year …) but CLAMPED to what this pool will
 * actually accept: the program rejects anything under `minDuration`, and the
 * weight stops growing at `maxDuration`.
 *
 * The pool's own bounds always appear as the first and last button even when
 * they are not round numbers, so "the shortest lock this pool allows" and "the
 * longest lock that still counts" are always one click away.
 */
export function lockPresets(pool: Pick<PoolView, 'minDurationSecs' | 'maxDurationSecs'>): LockPreset[] {
  const minDays = Math.max(1, Math.ceil(pool.minDurationSecs / DAY));
  const maxDays = Math.max(minDays, Math.floor(pool.maxDurationSecs / DAY));
  const candidates = [
    { label: '1 Day', days: 1 },
    { label: '7 Days', days: 7 },
    { label: '30 Days', days: 30 },
    { label: '90 Days', days: 90 },
    { label: '6 Months', days: 180 },
    { label: '1 Year', days: 365 },
    { label: '2 Years', days: 730 },
    { label: '4 Years', days: 1460 },
  ].filter((c) => c.days >= minDays && c.days <= maxDays);

  const byDays = new Map<number, LockPreset>();
  const put = (label: string, days: number) => {
    if (!byDays.has(days)) byDays.set(days, { label, days, seconds: days * DAY });
  };
  put(labelForDays(minDays), minDays);
  for (const c of candidates) put(c.label, c.days);
  put(labelForDays(maxDays), maxDays);
  return [...byDays.values()].sort((a, b) => a.days - b.days);
}

/** "30 Days" / "6 Months" / "1 Year" for an arbitrary day count. */
export function labelForDays(days: number): string {
  if (days >= 365 && days % 365 === 0) {
    const y = days / 365;
    return y === 1 ? '1 Year' : `${y} Years`;
  }
  if (days >= 30 && days % 30 === 0) {
    const m = days / 30;
    return m === 1 ? '1 Month' : `${m} Months`;
  }
  return days === 1 ? '1 Day' : `${days} Days`;
}

/* ──────────────────────────────── reads ─────────────────────────────────── */

/** Read the configured stake pool + its reward pools + each reward vault's balance. */
export async function readPool(stakePool: string): Promise<Result<{ pool: PoolView }> | Failure> {
  try {
    const client = await makeClient();
    const pool: any = await client.getStakePool(stakePool);
    if (!pool) return { ok: false, reason: READ_FAIL };
    const rewardAccounts: any[] = await client.searchRewardPools({ stakePool: stakePool as any });

    const stakeMint = String(pool?.mint ?? '');
    // Decimals decide every human number on this surface (and the reward RATE,
    // which is quoted per raw unit) — read them, never assume 6.
    const stakeDecimals = await readMintDecimals(client, stakeMint, 6);

    const rewardPools: RewardPoolView[] = [];
    for (const acc of rewardAccounts) {
      const rp = acc?.account ?? acc;
      const address = String(acc?.publicKey ?? '');
      const rewardMint = String(rp?.mint ?? '');
      let fundedRaw: bigint | null = null;
      try {
        const vault = rp?.vault;
        if (vault) {
          const bal = await client.connection.getTokenAccountBalance(vault);
          fundedRaw = BigInt(bal.value.amount);
        }
      } catch { /* vault unreadable → stays null (outage, not zero) */ }
      rewardPools.push({
        address,
        mint: rewardMint,
        nonce: bnToNumber(rp?.nonce),
        vault: String(rp?.vault ?? ''),
        decimals: rewardMint === stakeMint
          ? stakeDecimals
          : await readMintDecimals(client, rewardMint, stakeDecimals),
        fundedRaw,
        permissionless: Boolean(rp?.permissionless),
        rewardAmountRaw: String(bnToBigint(rp?.rewardAmount) ?? '0'),
        rewardPeriodSecs: bnToNumber(rp?.rewardPeriod),
      });
    }

    // Detect the mint's owner program (Token-2022 vs legacy) for the writes.
    let tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const mintInfo = await client.connection.getAccountInfo(new PublicKey(stakeMint));
      if (mintInfo?.owner) tokenProgram = mintInfo.owner.toBase58();
    } catch { /* keep legacy default; writes against the wrong program fail loudly, never silently */ }

    const totalEffectiveScaled = bnToBigint(pool?.totalEffectiveStake);

    return {
      ok: true,
      pool: {
        address: stakePool,
        mint: stakeMint,
        decimals: stakeDecimals,
        tokenProgram,
        minDurationSecs: bnToNumber(pool?.minDuration),
        maxDurationSecs: bnToNumber(pool?.maxDuration),
        minWeightScaled: bnToBigint(pool?.minWeight) ?? WEIGHT_SCALE,
        maxWeightScaled: bnToBigint(pool?.maxWeight) ?? WEIGHT_SCALE,
        unstakePeriodSecs: bnToNumber(pool?.unstakePeriod),
        totalStakeRaw: bnToBigint(pool?.totalStake),
        totalEffectiveStakeRaw:
          totalEffectiveScaled === null ? null : totalEffectiveScaled / WEIGHT_SCALE,
        rewardPools,
      },
    };
  } catch (err) {
    // The UI copy stays honest and generic, but a bare catch left NOBODY able to
    // say why the lighthouse read failed — the cause never reached a console.
    // Warn with the real error (same-origin proxy URL, no secret to leak).
    console.warn('[bungalowStaking] readPool failed', err);
    return { ok: false, reason: READ_FAIL };
  }
}

/** Free-balance read for the stake mint — what the amount field's MAX fills in. */
export async function readWalletBalance(
  mint: string,
  owner: string,
): Promise<Result<{ raw: bigint }> | Failure> {
  try {
    const client = await makeClient();
    const { PublicKey } = await import('@solana/web3.js');
    const resp: any = await client.connection.getParsedTokenAccountsByOwner(
      new PublicKey(owner),
      { mint: new PublicKey(mint) },
    );
    const raw = (resp?.value ?? []).reduce((sum: bigint, a: any) => {
      const v = a?.account?.data?.parsed?.info?.tokenAmount?.amount;
      return sum + (v ? BigInt(v) : 0n);
    }, 0n);
    return { ok: true, raw };
  } catch {
    return { ok: false, reason: 'Your balance could not be read right now.' };
  }
}

/**
 * The connected wallet's stake entries for this pool (open ones first), each
 * with the rewards it has accrued per reward pool.
 *
 * Pending rewards come from the SDK's own `calcRewards` over the real
 * on-chain reward entry — no accrual math of ours. A reward entry that cannot
 * be read leaves that pool's number `null` (unknown), never 0.
 */
export async function readEntries(
  stakePool: string,
  owner: string,
): Promise<Result<{ entries: StakeEntryView[] }> | Failure> {
  try {
    const { client, staking } = await loadSdk();
    const accounts: any[] = await client.searchStakeEntries({
      stakePool: stakePool as any,
      payer: owner as any,
    });

    // Reward pools are needed to price the accrual; a failed read just leaves
    // every pending number unknown.
    let rewardAccounts: any[] = [];
    try {
      rewardAccounts = await client.searchRewardPools({ stakePool: stakePool as any });
    } catch { /* pending stays null below */ }

    const raw = accounts.map((acc) => ({ acc, e: acc?.account ?? acc }));
    // Only OPEN entries accrue, and only a handful ever exist per wallet; the
    // cap keeps a pathological wallet from firing 256 x N account scans.
    const accruing = raw.filter(({ e }) => bnToNumber(e?.closedTs) === 0).slice(0, 8);
    const pendingByEntry = new Map<string, Record<number, bigint | null>>();
    for (const { acc } of accruing) {
      const perPool: Record<number, bigint | null> = {};
      for (const rpAcc of rewardAccounts) {
        const nonce = bnToNumber((rpAcc?.account ?? rpAcc)?.nonce);
        try {
          const found: any[] = await client.searchRewardEntries({
            stakeEntry: String(acc?.publicKey ?? '') as any,
            rewardPool: String(rpAcc?.publicKey ?? '') as any,
          });
          perPool[nonce] = bnToBigint(staking.calcRewards(found[0], acc, rpAcc));
        } catch {
          perPool[nonce] = null;
        }
      }
      pendingByEntry.set(String(acc?.publicKey ?? ''), perPool);
    }

    const entries = raw
      .map(({ acc, e }) => {
        const address = String(acc?.publicKey ?? '');
        const amountRaw = bnToBigint(e?.amount) ?? 0n;
        return {
          address,
          nonce: bnToNumber(e?.nonce),
          amountRaw,
          durationSecs: bnToNumber(e?.duration),
          createdTs: bnToNumber(e?.createdTs),
          closedTs: bnToNumber(e?.closedTs),
          effectiveAmountRaw: bnToBigint(e?.effectiveAmount) ?? amountRaw,
          pendingRaw: pendingByEntry.get(address) ?? {},
        };
      })
      .sort((a, b) => (a.closedTs === 0 ? -1 : 1) - (b.closedTs === 0 ? -1 : 1) || b.createdTs - a.createdTs);
    return { ok: true, entries };
  } catch {
    return { ok: false, reason: 'Your stakes could not be read right now.' };
  }
}

/** Lowest nonce in [0,255] not used by an OPEN entry (closed entries free theirs). */
export function nextVacantNonce(entries: StakeEntryView[]): number | null {
  const used = new Set(entries.filter((e) => e.closedTs === 0).map((e) => e.nonce));
  for (let n = 0; n < 256; n++) {
    if (!used.has(n)) return n;
  }
  return null;
}

/* ──────────────────────────────── writes ────────────────────────────────── */

function writeFailure(err: unknown, fallback: string): Failure {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/reject|declin|denied/i.test(msg)) return { ok: false, reason: 'You declined the signature — nothing moved.' };
  return { ok: false, reason: `${fallback}${msg ? ` (${msg.slice(0, 140)})` : ''}` };
}

/**
 * Stake — the SDK's prepare-path with one extra instruction in FRONT: an
 * idempotent create of the staker's ATA for the stake-mint PDA (the receipt
 * token the pool mints). PROVEN NECESSARY on devnet: without it, Stake dies
 * with AccountNotInitialized on the `to` account for every first-time
 * staker (rehearsal tx 4B8hFc…KJRu). Everything rides ONE transaction via
 * the SDK's own execute() (bundling + compute budget are theirs).
 */
export async function stake(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  amountRaw: bigint;
  durationSecs: number;
  entries: StakeEntryView[];
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const nonce = nextVacantNonce(args.entries);
    if (nonce === null) return { ok: false, reason: 'All 256 stake slots are in use for this wallet.' };
    const staker = args.invoker.publicKey;
    if (!staker) return { ok: false, reason: 'Connect a wallet first.' };
    const [{ client, staking }, { default: BN }, web3, splToken] = await Promise.all([
      loadSdk(),
      import('bn.js'),
      import('@solana/web3.js'),
      import('@solana/spl-token'),
    ]);
    const ext = { invoker: args.invoker };
    const stakeMintPda = staking.deriveStakeMintPDA(
      client.getCurrentProgramId('stakePoolProgram' as any),
      new web3.PublicKey(args.pool.address),
    );
    // The receipt mint is created BY the pool program — read its owner
    // program from the chain rather than assuming it matches the stake
    // token's (Token-2022 pools may differ; detection is always right).
    let receiptProgram = new web3.PublicKey(args.pool.tokenProgram);
    try {
      const info = await client.connection.getAccountInfo(stakeMintPda);
      if (info?.owner) receiptProgram = info.owner as any;
    } catch { /* fall back to the pool's token program */ }
    const receiptAta = splToken.getAssociatedTokenAddressSync(stakeMintPda, staker, false, receiptProgram);
    const ataIx = splToken.createAssociatedTokenAccountIdempotentInstruction(staker, receiptAta, staker, stakeMintPda, receiptProgram);
    const stakePrep: any = await client.prepareStakeInstructions(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        amount: new BN(args.amountRaw.toString()),
        duration: new BN(String(args.durationSecs)),
        nonce,
        tokenProgramId: args.pool.tokenProgram as any,
      },
      ext,
    );
    const rewardIxs: any[] = [];
    for (const rp of args.pool.rewardPools) {
      const prep: any = await client.prepareCreateRewardEntryInstructions(
        {
          stakePool: args.pool.address as any,
          stakePoolMint: args.pool.mint as any,
          rewardPoolNonce: rp.nonce,
          depositNonce: nonce,
          rewardMint: rp.mint as any,
          rewardPoolType: 'fixed' as const,
          tokenProgramId: args.pool.tokenProgram as any,
        } as any,
        ext,
      );
      rewardIxs.push(...(prep?.ixs ?? []));
    }
    const res: any = await client.execute([ataIx, ...(stakePrep?.ixs ?? []), ...rewardIxs], ext);
    return { ok: true, txId: String(res?.txId ?? res?.signature ?? '') };
  } catch (err) {
    return writeFailure(err, 'The stake did not go through — nothing moved.');
  }
}

/** Unstake + claim + close entries via the SDK's grouped flow. */
export async function unstakeAndClaim(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  entryNonce: number;
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const client = await makeClient();
    const res: any = await client.unstakeAndClaim(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        nonce: args.entryNonce,
        tokenProgramId: args.pool.tokenProgram as any,
        rewardPools: args.pool.rewardPools.map((rp) => ({
          nonce: rp.nonce,
          mint: rp.mint as any,
          rewardPoolType: 'fixed' as const,
          tokenProgramId: args.pool.tokenProgram as any,
        })),
      },
      { invoker: args.invoker },
    );
    return { ok: true, txId: String(res?.txId ?? '') };
  } catch (err) {
    return writeFailure(err, 'The unstake did not go through — your stake is untouched.');
  }
}

/** Claim rewards from one reward pool for one stake entry. */
export async function claimRewards(args: {
  invoker: SignerWalletAdapter;
  pool: PoolView;
  rewardPool: RewardPoolView;
  entryNonce: number;
}): Promise<Result<{ txId: string }> | Failure> {
  try {
    const client = await makeClient();
    const res: any = await client.claimRewards(
      {
        stakePool: args.pool.address as any,
        stakePoolMint: args.pool.mint as any,
        rewardPoolNonce: args.rewardPool.nonce,
        depositNonce: args.entryNonce,
        rewardMint: args.rewardPool.mint as any,
        rewardPoolType: 'fixed' as const,
        tokenProgramId: args.pool.tokenProgram as any,
      },
      { invoker: args.invoker },
    );
    return { ok: true, txId: String(res?.txId ?? '') };
  } catch (err) {
    return writeFailure(err, 'The claim did not go through — your rewards are untouched.');
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */
