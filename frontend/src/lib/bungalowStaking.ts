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
 * FUNDING-LAST CONTRACT: the pool is expected to go live with an EMPTY
 * reward vault (the operator funds last). readPool() therefore reports the
 * vault balance as its own first-class fact — 0 renders as a real, labeled
 * zero, "could not read" stays an outage, and nothing here synthesizes an
 * APR from a rate that isn't backed by deposits.
 *
 * Every @streamflow/* import is DYNAMIC: the SDK loads only after a pool
 * address is configured and the live section actually mounts — no bungalow
 * pool, no bytes.
 *
 * All calls resolve, never throw: `{ ok: false, reason }` is the only
 * failure shape, so render paths cannot crash on RPC weather.
 */

export interface RewardPoolView {
  address: string;
  mint: string;
  nonce: number;
  /** Raw reward-vault balance (base units of the reward mint); null = unreadable. */
  fundedRaw: bigint | null;
  /** On-chain configured rate parts (raw, 1e9-scaled amount per effective token per period). */
  rewardAmountRaw: string;
  rewardPeriodSecs: number;
}

export interface PoolView {
  address: string;
  mint: string;
  /**
   * The mint's OWNER program (legacy SPL or Token-2022), detected at read
   * time and threaded through every write — BAYLA is Token-2022, and the
   * first mainnet broadcast died with IncorrectProgramId for assuming
   * legacy (2026-08-26). Never assume; always detect.
   */
  tokenProgram: string;
  minDurationSecs: number;
  maxDurationSecs: number;
  /** Raw total staked (base units of the stake mint); null = unreadable. */
  totalStakeRaw: bigint | null;
  /** On-chain weight ceiling, 1e9-scaled ('1000000000' = flat 1x: lock length adds no boost). */
  maxWeightRaw: string;
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

/** Read the configured stake pool + its reward pools + each reward vault's balance. */
export async function readPool(stakePool: string): Promise<Result<{ pool: PoolView }> | Failure> {
  try {
    const client = await makeClient();
    const pool: any = await client.getStakePool(stakePool);
    // Account-not-found is NOT RPC weather: the address is wrong or the pool
    // is gone. Saying "could not be read right now" there disguises a
    // permanent misconfig as a transient outage.
    if (!pool) return { ok: false, reason: 'No stake pool exists at this address. If this persists, the configured pool address is wrong.' };
    const rewardAccounts: any[] = await client.searchRewardPools({ stakePool: stakePool as any });

    const rewardPools: RewardPoolView[] = [];
    for (const acc of rewardAccounts) {
      const rp = acc?.account ?? acc;
      const address = String(acc?.publicKey ?? '');
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
        mint: String(rp?.mint ?? ''),
        nonce: bnToNumber(rp?.nonce),
        fundedRaw,
        rewardAmountRaw: String(bnToBigint(rp?.rewardAmount) ?? '0'),
        rewardPeriodSecs: bnToNumber(rp?.rewardPeriod),
      });
    }

    // Detect the mint's owner program (Token-2022 vs legacy) for the writes.
    let tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const mintInfo = await client.connection.getAccountInfo(new PublicKey(String(pool?.mint ?? '')));
      if (mintInfo?.owner) tokenProgram = mintInfo.owner.toBase58();
    } catch { /* keep legacy default; writes against the wrong program fail loudly, never silently */ }

    return {
      ok: true,
      pool: {
        address: stakePool,
        mint: String(pool?.mint ?? ''),
        tokenProgram,
        minDurationSecs: bnToNumber(pool?.minDuration),
        maxDurationSecs: bnToNumber(pool?.maxDuration),
        totalStakeRaw: bnToBigint(pool?.totalStake),
        maxWeightRaw: String(bnToBigint(pool?.maxWeight) ?? ''),
        rewardPools,
      },
    };
  } catch {
    return { ok: false, reason: READ_FAIL };
  }
}

/** Read the connected wallet's stake entries for this pool (open ones first). */
export async function readEntries(
  stakePool: string,
  owner: string,
): Promise<Result<{ entries: StakeEntryView[] }> | Failure> {
  try {
    const client = await makeClient();
    const accounts: any[] = await client.searchStakeEntries({
      stakePool: stakePool as any,
      payer: owner as any,
    });
    const entries = accounts
      .map((acc) => {
        const e = acc?.account ?? acc;
        return {
          address: String(acc?.publicKey ?? ''),
          nonce: bnToNumber(e?.nonce),
          amountRaw: bnToBigint(e?.amount) ?? 0n,
          durationSecs: bnToNumber(e?.duration),
          createdTs: bnToNumber(e?.createdTs),
          closedTs: bnToNumber(e?.closedTs),
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

function writeFailure(err: unknown, fallback: string): Failure {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/reject|declin|denied/i.test(msg)) return { ok: false, reason: 'You declined the signature — nothing moved.' };
  // Streamflow custom error 6012 = the reward vault cannot cover the rewards
  // this action must pay out. PROVEN ON DEVNET (2026-08-28, same program ids
  // as mainnet): while accrued > vault, claim AND unstake&claim both revert —
  // principal stays locked until the vault is topped up, and the backlog is
  // NOT forfeited (a post-funding claim paid the full dry-window accrual).
  if (/\b6012\b/.test(msg)) {
    return {
      ok: false,
      reason:
        'The reward vault cannot cover the accrued rewards this action pays out, so it reverted — nothing moved, nothing is lost. ' +
        'Claims and exits work again once the vault is topped up; rewards keep accruing meanwhile.',
    };
  }
  // A confirmation timeout is NOT "nothing moved": web3's TransactionExpired*
  // errors fire AFTER the transaction was broadcast, and it may still land.
  // Asserting "nothing moved" there invites a duplicate stake (a second
  // 1–365-day lock of real funds). Say the outcome is unknown and carry the
  // signature when the error object has one, so the user can check first.
  const sig = (err as { signature?: unknown } | null)?.signature;
  if (typeof sig === 'string' && sig !== '' || /not confirmed|expired|block ?height exceeded|timed? ?out/i.test(msg)) {
    const sigNote = typeof sig === 'string' && sig ? ` Signature: ${sig}` : '';
    return {
      ok: false,
      reason: `Outcome unknown — the transaction was sent and may still land. Check your wallet or Solscan before retrying.${sigNote}`,
    };
  }
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

/* ——— Display helpers ———
 * NOT money math: every transfer stays the SDK's. These only turn the pool's
 * on-chain rate constants into honest labels, because hiding them proved
 * worse: the rate lived in announcement channels while the page showed
 * nothing, and the vault's runway is an EXIT-SAFETY number here — proven on
 * devnet 2026-08-28 (Streamflow error 6012, same program ids as mainnet):
 * while accrued rewards exceed the vault, claim AND unstake&claim revert, so
 * principal is locked until the vault is topped up past accrual (the backlog
 * itself survives — a post-funding claim paid the full dry window).
 */

/** Whole reward tokens per staked whole token per DAY (e.g. 0.003) from the pool's raw rate parts; null when unconfigured. */
export function rewardRatePerTokenPerDay(rp: RewardPoolView): number | null {
  const amount = Number(rp.rewardAmountRaw); // 1e9-scaled, per effective staked token per period
  if (!Number.isFinite(amount) || amount <= 0 || rp.rewardPeriodSecs <= 0) return null;
  return (amount / 1e9) * (86_400 / rp.rewardPeriodSecs);
}

/**
 * Days the funded vault covers at the current total stake.
 * null = an input is unreadable; Infinity = zero burn (no stake / no rate).
 * Float precision is fine here — this labels a card, it moves no funds.
 */
export function runwayDays(
  fundedRaw: bigint | null,
  totalStakeRaw: bigint | null,
  rp: RewardPoolView,
): number | null {
  if (fundedRaw === null || totalStakeRaw === null) return null;
  const rate = rewardRatePerTokenPerDay(rp);
  if (rate === null) return null;
  if (totalStakeRaw === 0n) return Infinity;
  const burnPerDayRaw = Number(totalStakeRaw) * rate;
  if (!(burnPerDayRaw > 0)) return Infinity;
  return Number(fundedRaw) / burnPerDayRaw;
}

/**
 * True while the vault is too thin to make staking exit-safe: empty, or
 * below one day of burn at the current stake, or below one whole token when
 * nothing is staked yet (a first staker's day-one accrual would exceed dust
 * immediately — the 1-raw-unit "dust defeats the empty banner" grief).
 */
export function vaultIsMateriallyEmpty(
  fundedRaw: bigint | null,
  totalStakeRaw: bigint | null,
  rp: RewardPoolView,
  decimals: number,
): boolean {
  if (fundedRaw === null) return false; // unreadable = outage, not a verdict
  if (fundedRaw === 0n) return true;
  const oneToken = 10n ** BigInt(decimals);
  if (fundedRaw < oneToken) return true;
  const runway = runwayDays(fundedRaw, totalStakeRaw, rp);
  return runway !== null && runway < 1;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
