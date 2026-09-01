// The lighthouse ceremony — create (and prove) the BAYLA Streamflow staking
// pool with one command.
//
//   REHEARSAL (devnet, fully automatic, throwaway funds):
//     node scripts/bayla-lighthouse-ceremony.mjs --rehearse
//   Proves the ENTIRE lifecycle with real transactions against Streamflow's
//   devnet deployment (same program ids as mainnet): create stake pool →
//   create reward pool → fund → stake → claim → unstake&claim. Prints every
//   signature. Uses 1-second lock/reward periods so the round trip finishes
//   in seconds.
//
//   MAINNET (operator):
//     node scripts/bayla-lighthouse-ceremony.mjs --rate 0.003            # dry run: prints the exact plan, signs nothing
//     node scripts/bayla-lighthouse-ceremony.mjs --rate 0.003 \
//          --keypair C:\path\to\creator.json --broadcast                 # executes createStakePool + createRewardPool
//   Then paste the printed stake-pool address into VITE_BAYLA_STAKE_POOL.
//   --rate is REQUIRED on mainnet: reward economics are an operator choice,
//   never a script default. (rate = whole reward tokens per staked whole
//   token per reward period; converted with the SDK's own
//   calculateRewardAmountFromRate.)
//
// Security posture: the script never prints secret keys; --keypair reads a
// standard solana id.json; rehearsal keypairs are throwaway and written to
// the OS temp dir, not the repo. Funding on mainnet stays a separate,
// deliberately-LAST operator act (the app renders an empty vault honestly).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getMint,
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  SolanaStakingClient, calculateRewardAmountFromRate, deriveStakeMintPDA,
  deriveRewardPoolPDA, deriveRewardVaultPDA, constants as sfConstants,
} from '@streamflow/staking';
import { PublicKey } from '@solana/web3.js';

// Streamflow's treasury — the .d.ts names it STREAMFLOW_TREASURY_PUBLIC_KEY
// but the runtime bundle doesn't export it; value read from the SDK bundle
// itself (dist/esm/index.js, TREASURY_PUBLIC_KEY).
const STREAMFLOW_TREASURY = new PublicKey('5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw');
import { ICluster } from '@streamflow/common';

//   REBALANCE (operator): hold DAILY EMISSIONS flat so runway is a straight
//   line you can plan a reload against.
//     node scripts/bayla-lighthouse-ceremony.mjs --rebalance --pool <stakePool> \
//          --target-daily 2739 [--keypair <authority.json> --broadcast]
//   Streamflow pays a RATE PER STAKED TOKEN, so total emissions scale with TVL
//   and the runway moves every time someone stakes. This recomputes the rate as
//   target ÷ current weighted stake and writes it with the program's own
//   updatePool instruction — no custom program, no custody, just the audited
//   rail re-pointed. Re-run whenever stake moves materially (or on a schedule);
//   between runs the emission drifts with TVL exactly as much as stake changed.
//   ⚠ THE SIGNER MUST BE THE POOL AUTHORITY (updatePool passes `authority:
//   invoker`) — the ceremony key, not the permissionless funding wallet.
//
//   FUNDING (operator, task #13 — deliberately its own mode, run LAST):
//     node scripts/bayla-lighthouse-ceremony.mjs --fund --pool <stakePool> \
//          --amount 50000 --keypair C:\path\to\creator.json [--broadcast]
//   Dry-run by default (prints the plan); --broadcast creates Streamflow's
//   treasury ATA if missing (devnet-proven prerequisite) and deposits
//   <amount> whole BAYLA into the reward pool. Rerunnable — every top-up is
//   its own public transaction and the app's vault number climbs with each.
//
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = undefined) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const REHEARSE = has('--rehearse');
const FUND = has('--fund');
const REBALANCE = has('--rebalance');
const BROADCAST = has('--broadcast');
const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const DAY = 86_400;

const log = (...a) => console.log('[lighthouse]', ...a);

async function confirm(connection, sig) {
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  return sig;
}

// BAYLA is a Token-2022 mint (owner TokenzQd… — verified on mainnet
// 2026-08-26 after the first broadcast died with IncorrectProgramId during
// vault init). The SDK threads tokenProgramId through every call; detect the
// mint's owner program instead of ever assuming legacy SPL.
async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`mint ${mint} not found on this cluster`);
  log(`token program for ${mint.slice(0, 6)}…: ${info.owner.toBase58()}`);
  return info.owner.toBase58();
}

async function rehearse() {
  // --dry-vault: the FUNDING-LAST rehearsal. The mainnet pool goes live with
  // an EMPTY reward vault by design, so the state "accrued entitlement > 0,
  // vault = 0" is the expected launch state — and the normal rehearsal never
  // exercised it (it funds before staking). This mode proves what the
  // program actually does there: claim against a dry vault (revert? zero-pay?),
  // unstake&claim against a dry vault (principal hostage?), and whether a
  // dry-window claim FORFEITS the backlog once funding arrives (claim again
  // after funding and compare against a post-funding rate control).
  const DRY_VAULT = has('--dry-vault');
  const clusterUrl = val('--rpc', 'https://api.devnet.solana.com');
  const connection = new Connection(clusterUrl, 'confirmed');
  const payer = Keypair.generate();
  const keyDir = mkdtempSync(join(tmpdir(), 'lighthouse-rehearsal-'));
  const keyPath = join(keyDir, 'throwaway.json');
  writeFileSync(keyPath, JSON.stringify([...payer.secretKey]));
  log(`devnet rehearsal · throwaway signer ${payer.publicKey.toBase58()}`);
  log(`(throwaway key saved OUTSIDE the repo: ${keyPath})`);

  // Fund the throwaway: prefer a local --funder keypair (the public devnet
  // faucet rate-limits hard); its secret never leaves this machine and never
  // prints. Falls back to the faucet when no funder is given.
  const funderPath = val('--funder');
  if (funderPath) {
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(funderPath, 'utf8'))));
    const amount = Math.floor(Number(val('--funder-sol', '0.8')) * LAMPORTS_PER_SOL);
    log(`funding throwaway from local funder ${funder.publicKey.toBase58()} (${amount / LAMPORTS_PER_SOL} SOL)…`);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: payer.publicKey, lamports: amount }),
    ), [funder], { commitment: 'confirmed' });
  } else {
    log('requesting devnet airdrop (2 SOL)…');
    let funded = false;
    for (let i = 0; i < 4 && !funded; i++) {
      try {
        await confirm(connection, await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL));
        funded = true;
      } catch (e) {
        log(`airdrop attempt ${i + 1} failed (${String(e).slice(0, 90)}) — retrying…`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (!funded) throw new Error('devnet faucet refused 4 times — rerun, pass --rpc <another devnet rpc>, or pass --funder <keypair.json>');
  }
  log(`balance: ${(await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  log('creating 6-decimal rehearsal mint (stand-in for BAYLA)…');
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  const ata = await createAssociatedTokenAccountIdempotent(connection, payer, mint, payer.publicKey);
  await mintTo(connection, payer, mint, ata, payer, 1_000_000_000_000n); // 1M tokens
  log(`mint ${mint.toBase58()} · minted 1,000,000.000000 to ${ata.toBase58()}`);

  const client = new SolanaStakingClient({ clusterUrl, cluster: ICluster.Devnet });
  const ext = { invoker: payer, computePrice: 10_000, computeLimit: 'autoSimulate' };

  // 1-second windows so the full round trip runs in seconds.
  const poolParams = {
    mint: mint.toBase58(),
    minDuration: new BN(1),
    maxDuration: new BN(3600),
    maxWeight: new BN(1_000_000_000), // 1x flat
    permissionless: false,
    nonce: 0,
  };
  log('createStakePool…', JSON.stringify({ ...poolParams, minDuration: '1s', maxDuration: '3600s', maxWeight: '1x' }));
  const created = await client.createStakePool(poolParams, ext);
  const stakePool = String(created.metadataId);
  log(`✓ stake pool ${stakePool} (tx ${created.txId})`);

  const rewardAmount = calculateRewardAmountFromRate(0.003, 6, 6);
  log(`createRewardPool… rate 0.003/period → rewardAmount ${rewardAmount.toString()}`);
  const rp = await client.createRewardPool({
    nonce: 0,
    rewardAmount,
    rewardPeriod: new BN(1),
    rewardMint: mint.toBase58(),
    permissionless: true,
    stakePool,
    stakePoolMint: mint.toBase58(),
    // Required by the REAL CreateRewardPoolArgs (the README example omits
    // both — .d.ts is the source of truth): the stake pool's own nonce, and
    // the optional last-claim cutoff (null = none).
    stakePoolNonce: 0,
    lastClaimPeriodOpt: null,
  }, ext);
  log(`✓ reward pool ${String(rp.metadataId)} (tx ${rp.txId})`);

  // README warning made real (devnet error 3012 AccountNotInitialized):
  // funding expects Streamflow's treasury ATA for the reward mint to exist
  // — the funder creates it. Idempotent, harmless if it already exists.
  log('creating Streamflow treasury ATA for the reward mint (fund prerequisite)…');
  await createAssociatedTokenAccountIdempotent(connection, payer, mint, STREAMFLOW_TREASURY);
  const doFund = async (label) => {
    log(`fundPool… 100,000 tokens into the reward vault${label ? ` (${label})` : ''}`);
    const fund = await client.fundPool({
      stakePool,
      stakePoolMint: mint.toBase58(),
      rewardMint: mint.toBase58(),
      nonce: 0,
      amount: new BN('100000000000'),
      // Explicit null routes the fee check to the fee-manager's DEFAULT config
      // (which exists, fee 0) instead of a per-funder feeValue PDA that was
      // never initialized — omitting the field derives the latter and dies
      // with AccountNotInitialized (proven on devnet, tx 675Dnx…4nvR).
      feeValue: null,
    }, ext);
    log(`✓ funded (tx ${fund.txId})`);
  };
  if (!DRY_VAULT) {
    await doFund('');
  } else {
    log('DRY-VAULT MODE: skipping fundPool — the vault stays at 0, like mainnet launch day.');
  }

  // Second ATA the program expects pre-created (devnet error 3012 on the
  // `to` account, tx 4B8hFc…KJRu): the STAKER's ATA for the stake-mint PDA —
  // the receipt token the pool mints on stake.
  const stakeMintPda = deriveStakeMintPDA(client.getCurrentProgramId('stakePoolProgram'), new PublicKey(stakePool));
  log(`creating staker ATA for the stake-mint PDA ${stakeMintPda.toBase58()}…`);
  await createAssociatedTokenAccountIdempotent(connection, payer, stakeMintPda, payer.publicKey);

  const stakeEntry = async (nonce, amountRaw, label) => {
    log(`stakeAndCreateEntries… ${label}, 2s lock (entry nonce ${nonce})`);
    const res = await client.stakeAndCreateEntries({
      stakePool,
      stakePoolMint: mint.toBase58(),
      amount: new BN(amountRaw),
      duration: new BN(2),
      nonce,
      rewardPools: [{ nonce: 0, mint: mint.toBase58(), rewardPoolType: 'fixed' }],
    }, ext);
    log(`✓ staked (tx ${res.txId})`);
  };
  const claimEntry = (depositNonce) => client.claimRewards({
    stakePool,
    stakePoolMint: mint.toBase58(),
    rewardPoolNonce: 0,
    depositNonce,
    rewardMint: mint.toBase58(),
    rewardPoolType: 'fixed',
  }, ext);
  const unstakeEntry = (nonce) => client.unstakeAndClaim({
    stakePool,
    stakePoolMint: mint.toBase58(),
    nonce,
    rewardPools: [{ nonce: 0, mint: mint.toBase58(), rewardPoolType: 'fixed' }],
  }, ext);
  const walletRaw = async () => BigInt((await connection.getTokenAccountBalance(ata)).value.amount);
  // Outcome recorder: the experiment cares about revert-vs-success AND the
  // exact token delta each success moved — log both, never throw.
  const attempt = async (label, fn) => {
    const before = await walletRaw();
    try {
      const res = await fn();
      const delta = (await walletRaw()) - before;
      log(`▶ ${label}: SUCCEEDED (tx ${res.txId}) · wallet delta +${delta} raw`);
      return { ok: true, delta };
    } catch (e) {
      log(`▶ ${label}: FAILED · ${String(e?.message ?? e).slice(0, 220)}`);
      return { ok: false };
    }
  };

  if (!DRY_VAULT) {
    await stakeEntry(0, '1000000000', '1,000 tokens');

    log('waiting 5s for the lock + a few reward periods…');
    await new Promise((r) => setTimeout(r, 5000));

    log('claimRewards…');
    const claim = await claimEntry(0);
    log(`✓ claimed (tx ${claim.txId})`);

    log('unstakeAndClaim…');
    const unstake = await unstakeEntry(0);
    log(`✓ unstaked + claimed + closed (tx ${unstake.txId})`);
  } else {
    // ENTRY 0 answers the claim questions; ENTRY 1 answers "is principal
    // hostage to the vault" via a dry unstake&claim.
    await stakeEntry(0, '1000000000', '1,000 tokens');
    await stakeEntry(1, '500000000', '500 tokens');

    log('waiting 6s for the locks + several reward periods to accrue against the EMPTY vault…');
    await new Promise((r) => setTimeout(r, 6000));

    const dryClaim = await attempt('DRY claim (entry 0, vault=0)', () => claimEntry(0));
    const dryExit = await attempt('DRY unstake&claim (entry 1, vault=0)', () => unstakeEntry(1));

    await doFund('after the dry window');
    log('waiting 3s so post-funding periods accrue…');
    await new Promise((r) => setTimeout(r, 3000));

    const backlogClaim = await attempt('POST-FUND claim (entry 0) — pays the dry-window backlog, or only post-dry-claim periods?', () => claimEntry(0));
    log('waiting 3s for a rate control…');
    await new Promise((r) => setTimeout(r, 3000));
    const controlClaim = await attempt('CONTROL claim (entry 0) — the observed per-3s funded rate', () => claimEntry(0));

    const finalExit = await attempt('POST-FUND unstake&claim (entry 0)', () => unstakeEntry(0));

    log('');
    log('DRY-VAULT VERDICT (raw deltas above are ground truth):');
    log(`  dry claim:            ${dryClaim.ok ? `paid ${dryClaim.delta} raw` : 'REVERTED'}`);
    log(`  dry unstake&claim:    ${dryExit.ok ? `returned ${dryExit.delta} raw (500000000 = principal only)` : 'REVERTED — principal is HOSTAGE to vault funding'}`);
    log(`  post-fund claim:      ${backlogClaim.ok ? `paid ${backlogClaim.delta} raw` : 'REVERTED'}`);
    log(`  rate control (3s):    ${controlClaim.ok ? `paid ${controlClaim.delta} raw` : 'REVERTED'}`);
    log('  If post-fund ≈ control, the dry claim FORFEITED the backlog; if post-fund >> control, backlog survives a dry claim.');
    if (!finalExit.ok) log('  NOTE: final exit also failed — investigate before mainnet messaging.');
  }

  const pool = await client.getStakePool(stakePool);
  log(`final pool state: totalStake=${pool.totalStake?.toString?.() ?? '?'}`);
  log('');
  log('REHEARSAL COMPLETE — every lifecycle call executed on devnet with the');
  log('exact SDK flows the app and the mainnet ceremony use.');
  log(`explorer: https://solscan.io/account/${stakePool}?cluster=devnet`);
}


/**
 * Read the mint's decimals from the CHAIN, not from a flag. Every raw-amount
 * and rate computation in a ceremony derives from this number; a wrong value
 * builds a pool whose economics are off by powers of ten with no error
 * anywhere. --decimals (optional) is only a cross-check: if the operator
 * declares one and the chain disagrees, the ceremony refuses to proceed.
 * (BOBO/SOY/BRAINLET all read 6, classic Tokenkeg, verified 2026-08-30 —
 * but the read costs one RPC call and never goes stale.)
 */
async function readVerifiedDecimals(connection, mint, tokenProgramId) {
  const info = await getMint(connection, new PublicKey(mint), 'confirmed', new PublicKey(tokenProgramId));
  const declared = val('--decimals');
  if (declared !== undefined && Number(declared) !== info.decimals) {
    throw new Error(
      `--decimals ${declared} contradicts the chain: mint ${mint} has ${info.decimals} decimals. ` +
      'The chain wins — re-run without --decimals or with the correct value.',
    );
  }
  return info.decimals;
}

async function mainnet() {
  const rateStr = val('--rate');
  if (!rateStr || !(Number(rateStr) > 0)) {
    throw new Error('--rate <rewardTokensPerStakedTokenPerPeriod> is required on mainnet (economics are an operator choice). Example: --rate 0.003');
  }
  const rate = Number(rateStr);
  const mint = val('--mint', BAYLA_MINT);
  const minDays = Number(val('--min-days', '1'));
  // Default 7, NOT 365. Streamflow has no early exit at any price (see the
  // warning printed below), so --max-days is the longest a staker can be
  // stuck with no recourse. The safe value is the default; a long lock has
  // to be asked for explicitly, and above 30d has to be acknowledged.
  const maxDays = Number(val('--max-days', '7'));
  const periodDays = Number(val('--period-days', '1'));
  const nonce = Number(val('--nonce', '0'));
  // Lock-duration bonus. 1 = flat (every lock earns the same). Anything above
  // 1 makes the weight ramp LINEARLY from 1.00x at --min-days to this at
  // --max-days, and weight multiplies rewards, so the max-lock tier costs
  // --max-weight times the base rate. IMMUTABLE once created: the stake-pool
  // program exposes no update instruction for it (only reward pools can be
  // re-rated), so changing it later means a NEW pool at a new --nonce.
  const maxWeightX = Number(val('--max-weight', '1'));
  if (!(maxWeightX >= 1)) throw new Error('--max-weight must be >= 1 (1 = flat, no duration bonus)');
  // A lock this long is a promise you cannot un-make for someone else: there
  // is no early unstake, no penalty exit, no admin release, and the position
  // cannot be sold (owner-derived PDA + frozen stake mint). Make the operator
  // say it out loud rather than discover it from a stuck holder.
  if (maxDays > 30 && !has('--accept-long-lock')) {
    throw new Error(
      `--max-days ${maxDays} locks stakers for up to ${maxDays} days with NO early exit of any kind ` +
      '(Streamflow supports none — not for a fee, not by the pool authority). ' +
      'Re-run with --accept-long-lock if that is genuinely intended.',
    );
  }
  const clusterUrl = val('--rpc', 'https://api.mainnet-beta.solana.com');
  // Mint facts come off the chain BEFORE anything is planned or signed — the
  // dry run needs RPC reachability now, which is the point: a plan printed
  // against assumed decimals is a plan for a different token.
  const connection = new Connection(clusterUrl, 'confirmed');
  const tokenProgramId = await detectTokenProgram(connection, mint);
  const decimals = await readVerifiedDecimals(connection, mint, tokenProgramId);
  const rewardAmount = calculateRewardAmountFromRate(rate, decimals, decimals);
  if (rewardAmount.isZero()) throw new Error(`rate too small for ${decimals}/${decimals} decimals — SDK computed rewardAmount 0`);

  // The SDK's calculateStakeWeight, in the small: linear from 1.00x at
  // minDuration to maxWeight at maxDuration, clamped to >= 1.00x.
  const weightAt = (days) => {
    if (maxDays <= minDays) return 1;
    const over = Math.max(0, Math.min(days, maxDays) - minDays);
    return 1 + (over / (maxDays - minDays)) * (maxWeightX - 1);
  };
  const ladderDays = [...new Set([minDays, 7, 14, 30, 90, 180, maxDays]
    .filter((d) => d >= minDays && d <= maxDays))].sort((a, b) => a - b);

  const plan = {
    cluster: 'mainnet',
    mintFacts: {
      mint,
      decimals,
      tokenProgram: String(tokenProgramId),
      source: 'read on-chain by this run (getMint) — not assumed',
    },
    stakePool: {
      mint, nonce,
      minDuration: `${minDays}d`, maxDuration: `${maxDays}d`,
      maxWeight: maxWeightX === 1
        ? '1x (FLAT — every lock earns the same; the duration picker buys nothing)'
        : `${maxWeightX}x at ${maxDays}d, ramping linearly from 1.00x at ${minDays}d`,
      permissionless: false,
    },
    rewardPool: {
      rewardMint: mint, nonce: 0,
      rate: `${rate} per staked token per period`, rewardAmountRaw: rewardAmount.toString(),
      rewardPeriod: `${periodDays}d`,
      permissionless: true, // public top-ups — funding stays visible and open
    },
    funding: 'DELIBERATELY NOT PART OF THIS SCRIPT — fund last, in public (task #13).',
  };
  log('MAINNET PLAN:');
  console.log(JSON.stringify(plan, null, 2));

  // What each lock ACTUALLY earns, and what it costs the vault. Printed so the
  // economics are read before they are signed, not discovered afterwards.
  log('');
  log('LOCK LADDER (weight → effective daily rate → simple APR):');
  for (const d of ladderDays) {
    const w = weightAt(d);
    const daily = rate * w;
    log(
      `  ${String(d).padStart(4)}d  ${w.toFixed(3)}x  ${daily.toFixed(6)}/staked/day  ${(daily * 365 * 100).toFixed(1)}% APR`,
    );
  }
  log('');
  log('⚠ NO EARLY EXIT. The stake program refuses an unstake until a lock');
  log('  elapses ("Stake is locked, unstake is not possible") and exposes NO');
  log('  admin release, pause, or forfeit-and-exit — not even to the pool');
  log(`  authority. --max-days ${maxDays} is therefore the LONGEST a staker can`);
  log('  be locked in with no recourse. Choose it as an exit policy, not just');
  log('  as a yield tier.');

  if (!BROADCAST) {
    log('dry run (no --broadcast): nothing signed, nothing sent.');
    log('to execute: add --keypair <path-to-id.json> --broadcast');
    return;
  }
  const keyPath = val('--keypair');
  if (!keyPath) throw new Error('--broadcast requires --keypair <path-to-id.json>');
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf8'))));
  log(`signer ${payer.publicKey.toBase58()}`);

  const client = new SolanaStakingClient({ clusterUrl, cluster: ICluster.Mainnet });
  const ext = { invoker: payer, computePrice: 10_000, computeLimit: 'autoSimulate' };
  const created = await client.createStakePool({
    mint,
    nonce,
    minDuration: new BN(minDays * DAY),
    maxDuration: new BN(maxDays * DAY),
    maxWeight: new BN(Math.round(maxWeightX * 1_000_000_000)),
    permissionless: false,
    tokenProgramId,
  }, ext);
  const stakePool = String(created.metadataId);
  log(`✓ stake pool ${stakePool} (tx ${created.txId})`);
  const rp = await client.createRewardPool({
    nonce: 0,
    rewardAmount,
    rewardPeriod: new BN(periodDays * DAY),
    rewardMint: mint,
    permissionless: true,
    stakePool,
    stakePoolMint: mint,
    stakePoolNonce: nonce,
    lastClaimPeriodOpt: null,
    tokenProgramId,
  }, ext);
  log(`✓ reward pool ${String(rp.metadataId)} (tx ${rp.txId})`);
  log('');
  log('NEXT: set this in Vercel env and redeploy —');
  log(`  VITE_BAYLA_STAKE_POOL=${stakePool}`);
  log('then the dust-wallet live-fire (runbook §6d), announce, and FUND LAST.');
}

async function fund() {
  const pool = val('--pool');
  const amountWhole = Number(val('--amount', '0'));
  const mint = val('--mint', BAYLA_MINT);
  const clusterUrl = val('--rpc', 'https://api.mainnet-beta.solana.com');
  if (!pool) throw new Error('--fund requires --pool <stake pool address> (from the ceremony output / VITE_BAYLA_STAKE_POOL)');
  if (!(amountWhole > 0)) throw new Error('--fund requires --amount <whole tokens>, e.g. --amount 50000');
  // Decimals come off the chain (see readVerifiedDecimals) — funding 50,000
  // "whole" tokens of a 9-decimal mint with a hardcoded 1e6 would deliver
  // 50 tokens and no error. The dry run performs the same read on purpose.
  const connection = new Connection(clusterUrl, 'confirmed');
  const tokenProgramId = await detectTokenProgram(connection, mint);
  const decimals = await readVerifiedDecimals(connection, mint, tokenProgramId);
  const amountRaw = new BN(Math.round(amountWhole * 10 ** decimals).toString());
  const tokenLabel = mint === BAYLA_MINT ? 'BAYLA' : `tokens (mint ${mint})`;

  // SHOW THE DESTINATION BEFORE SIGNING (2026-08-31). The plan used to print
  // the STAKE pool and a bare nonce, so an operator could not check where the
  // tokens would actually land without trusting the flag. Reward pools live
  // under their OWN program (RWRDdfRb…, not STAKEvGqQ…), and the nonce here is
  // the REWARD pool's index inside the stake pool — NOT the stake pool's own
  // nonce, which the runbook also calls "nonce" (the live pool is stake-pool
  // nonce 1 carrying reward pool nonce 0). Deriving both addresses and reading
  // the live vault turns "trust the default" into something eyeballable
  // against the runbook before --broadcast.
  const nonce = Number(val('--nonce', '0'));
  const rewardProgram = new PublicKey(sfConstants.REWARD_POOL_PROGRAM_ID.mainnet);
  const rewardPool = deriveRewardPoolPDA(rewardProgram, new PublicKey(pool), new PublicKey(mint), nonce);
  const rewardVault = deriveRewardVaultPDA(rewardProgram, rewardPool);
  let vaultNow = 'unreadable';
  try {
    const bal = await connection.getTokenAccountBalance(rewardVault);
    vaultNow = `${bal.value.uiAmountString} ${tokenLabel}`;
  } catch { vaultNow = 'does not exist yet'; }

  log('FUNDING PLAN (task #13 — the deliberately-LAST step):');
  console.log(JSON.stringify({
    cluster: 'mainnet', stakePool: pool, rewardMint: mint,
    amount: `${amountWhole.toLocaleString()} ${tokenLabel} (${amountRaw.toString()} raw, ${decimals} decimals — read on-chain)`,
    rewardPoolNonce: nonce,
    rewardPool: rewardPool.toBase58(),
    rewardVault: rewardVault.toBase58(),
    vaultBalanceNow: vaultNow,
    verify: 'rewardPool + rewardVault MUST match docs/BAYLA_BUNGALOW.md §6g before --broadcast',
    prerequisite: "Streamflow treasury ATA for the reward mint (created idempotently if missing — devnet-proven)",
    note: 'feeValue: null routes the fee check to the fee-manager default config (devnet-proven).',
  }, null, 2));
  if (!BROADCAST) {
    log('dry run (no --broadcast): nothing signed, nothing sent.');
    log('to execute: add --keypair <path-to-id.json> --broadcast');
    return;
  }
  const keyPath = val('--keypair');
  if (!keyPath) throw new Error('--broadcast requires --keypair <path-to-id.json>');
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf8'))));
  log(`signer ${payer.publicKey.toBase58()}`);
  const client = new SolanaStakingClient({ clusterUrl, cluster: ICluster.Mainnet });
  const ext = { invoker: payer, computePrice: 10_000, computeLimit: 'autoSimulate' };

  log('ensuring Streamflow treasury ATA for the reward mint…');
  await createAssociatedTokenAccountIdempotent(
    connection, payer, new PublicKey(mint), STREAMFLOW_TREASURY, undefined, new PublicKey(tokenProgramId),
  );
  log(`fundPool… ${amountWhole.toLocaleString()} ${tokenLabel}`);
  const res = await client.fundPool({
    stakePool: pool,
    stakePoolMint: mint,
    rewardMint: mint,
    nonce,
    amount: amountRaw,
    feeValue: null,
    tokenProgramId,
  }, ext);
  log(`✓ funded (tx ${res.txId})`);
  log(`solscan: https://solscan.io/tx/${res.txId}`);
  log('the vault balance on /farm (bayla mode) reflects this within one refresh.');
}

async function rebalance() {
  const pool = val('--pool');
  const targetDaily = Number(val('--target-daily', '0'));
  const mint = val('--mint', BAYLA_MINT);
  const clusterUrl = val('--rpc', 'https://api.mainnet-beta.solana.com');
  const nonce = Number(val('--nonce', '0'));
  if (!pool) throw new Error('--rebalance requires --pool <stake pool address>');
  if (!(targetDaily > 0)) throw new Error('--rebalance requires --target-daily <whole tokens/day>, e.g. --target-daily 2739');

  const connection = new Connection(clusterUrl, 'confirmed');
  const tokenProgramId = await detectTokenProgram(connection, mint);
  const decimals = await readVerifiedDecimals(connection, mint, tokenProgramId);
  const client = new SolanaStakingClient({ clusterUrl, cluster: ICluster.Mainnet });

  const sp = await client.getStakePool(pool);
  // Same normalisation the app uses (bungalowStaking.ts): the program stores
  // effective stake scaled by WEIGHT_SCALE (1e9).
  const WEIGHT_SCALE = 1_000_000_000n;
  const effRaw = sp?.totalEffectiveStake ? BigInt(sp.totalEffectiveStake.toString()) / WEIGHT_SCALE : 0n;
  const stakedTokens = Number(effRaw) / 10 ** decimals;

  const rewardProgram = new PublicKey(sfConstants.REWARD_POOL_PROGRAM_ID.mainnet);
  const rewardPool = deriveRewardPoolPDA(rewardProgram, new PublicKey(pool), new PublicKey(mint), nonce);
  const rewardVault = deriveRewardVaultPDA(rewardProgram, rewardPool);
  let vaultTokens = null;
  try {
    const bal = await connection.getTokenAccountBalance(rewardVault);
    vaultTokens = Number(bal.value.uiAmountString);
  } catch { /* vault not created yet */ }

  const rps = await client.searchRewardPools({ stakePool: pool });
  const rp = (rps ?? []).find((r) => String(r?.publicKey ?? r?.address ?? '') === rewardPool.toBase58()) ?? rps?.[0];
  const periodSecs = rp?.account?.rewardPeriod ? Number(rp.account.rewardPeriod.toString()) : 86400;
  const perDayFactor = 86400 / periodSecs;

  if (stakedTokens <= 0) {
    log('NOTHING IS STAKED YET — a per-token rate cannot be solved against zero stake.');
    log('Fund first, let real stake arrive, then rebalance against it.');
    return;
  }

  // rate = tokens paid per staked token per PERIOD, so that
  // stakedTokens * rate * periodsPerDay === targetDaily
  const newRatePerPeriod = targetDaily / stakedTokens / perDayFactor;
  const newRewardAmount = calculateRewardAmountFromRate(newRatePerPeriod, decimals, decimals);
  const runwayDays = vaultTokens === null ? null : vaultTokens / targetDaily;

  log('REBALANCE PLAN — hold daily emissions flat:');
  console.log(JSON.stringify({
    cluster: 'mainnet', stakePool: pool, rewardPool: rewardPool.toBase58(), rewardVault: rewardVault.toBase58(),
    weightedStake: `${stakedTokens.toLocaleString()} (weight-adjusted)`,
    vaultBalanceNow: vaultTokens === null ? 'unreadable' : `${vaultTokens.toLocaleString()} tokens`,
    targetDailyEmission: `${targetDaily.toLocaleString()} tokens/day`,
    newRatePerStakedTokenPerPeriod: newRatePerPeriod,
    rewardPeriodSecs: periodSecs,
    runwayAtTarget: runwayDays === null ? 'unknown' : `${runwayDays.toFixed(1)} days`,
    caveat: 'Emissions stay flat only until stake moves. Re-run then, or on a schedule.',
    authority: 'updatePool signs as the POOL AUTHORITY — the ceremony key, not the funding wallet',
  }, null, 2));

  if (!BROADCAST) {
    log('dry run (no --broadcast): nothing signed, nothing sent.');
    log('to execute: add --keypair <pool-authority.json> --broadcast');
    return;
  }
  const keyPath = val('--keypair');
  if (!keyPath) throw new Error('--broadcast requires --keypair <path-to-authority.json>');
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf8'))));
  log(`signer ${payer.publicKey.toBase58()} (must be the pool authority)`);
  const res = await client.updateRewardPool({
    stakePool: pool,
    rewardPool: rewardPool.toBase58(),
    rewardAmount: newRewardAmount,
    rewardPeriod: null,
  }, { invoker: payer, computePrice: 10_000, computeLimit: 'autoSimulate' });
  log(`\u2713 rate updated (tx ${res.txId})`);
  log(`solscan: https://solscan.io/tx/${res.txId}`);
}

(REHEARSE ? rehearse() : REBALANCE ? rebalance() : FUND ? fund() : mainnet()).catch((e) => {
  console.error('[lighthouse] FAILED:', e?.message ?? e);
  // Anchor/web3 simulation errors carry program logs — surface them, they
  // are the only way to see WHY a simulation failed.
  const logs = e?.logs ?? e?.error?.logs ?? e?.transactionLogs;
  if (Array.isArray(logs)) for (const l of logs.slice(-12)) console.error('  log:', l);
  if (e?.signature) console.error('  sig:', e.signature);
  process.exit(1);
});
