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
    if (!pool) return { ok: false, reason: READ_FAIL };
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
