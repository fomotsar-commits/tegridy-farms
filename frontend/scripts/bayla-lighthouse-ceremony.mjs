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
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
} from '@solana/spl-token';
import BN from 'bn.js';
import { SolanaStakingClient, calculateRewardAmountFromRate, deriveStakeMintPDA } from '@streamflow/staking';
import { PublicKey } from '@solana/web3.js';

// Streamflow's treasury — the .d.ts names it STREAMFLOW_TREASURY_PUBLIC_KEY
// but the runtime bundle doesn't export it; value read from the SDK bundle
// itself (dist/esm/index.js, TREASURY_PUBLIC_KEY).
const STREAMFLOW_TREASURY = new PublicKey('5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw');
import { ICluster } from '@streamflow/common';

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
  log('fundPool… 100,000 tokens into the reward vault');
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

  // Second ATA the program expects pre-created (devnet error 3012 on the
  // `to` account, tx 4B8hFc…KJRu): the STAKER's ATA for the stake-mint PDA —
  // the receipt token the pool mints on stake.
  const stakeMintPda = deriveStakeMintPDA(client.getCurrentProgramId('stakePoolProgram'), new PublicKey(stakePool));
  log(`creating staker ATA for the stake-mint PDA ${stakeMintPda.toBase58()}…`);
  await createAssociatedTokenAccountIdempotent(connection, payer, stakeMintPda, payer.publicKey);

  log('stakeAndCreateEntries… 1,000 tokens, 2s lock');
  const stakeRes = await client.stakeAndCreateEntries({
    stakePool,
    stakePoolMint: mint.toBase58(),
    amount: new BN('1000000000'),
    duration: new BN(2),
    nonce: 0,
    rewardPools: [{ nonce: 0, mint: mint.toBase58(), rewardPoolType: 'fixed' }],
  }, ext);
  log(`✓ staked (tx ${stakeRes.txId})`);

  log('waiting 5s for the lock + a few reward periods…');
  await new Promise((r) => setTimeout(r, 5000));

  log('claimRewards…');
  const claim = await client.claimRewards({
    stakePool,
    stakePoolMint: mint.toBase58(),
    rewardPoolNonce: 0,
    depositNonce: 0,
    rewardMint: mint.toBase58(),
    rewardPoolType: 'fixed',
  }, ext);
  log(`✓ claimed (tx ${claim.txId})`);

  log('unstakeAndClaim…');
  const unstake = await client.unstakeAndClaim({
    stakePool,
    stakePoolMint: mint.toBase58(),
    nonce: 0,
    rewardPools: [{ nonce: 0, mint: mint.toBase58(), rewardPoolType: 'fixed' }],
  }, ext);
  log(`✓ unstaked + claimed + closed (tx ${unstake.txId})`);

  const pool = await client.getStakePool(stakePool);
  log(`final pool state: totalStake=${pool.totalStake?.toString?.() ?? '?'}`);
  log('');
  log('REHEARSAL COMPLETE — every lifecycle call executed on devnet with the');
  log('exact SDK flows the app and the mainnet ceremony use.');
  log(`explorer: https://solscan.io/account/${stakePool}?cluster=devnet`);
}

async function mainnet() {
  const rateStr = val('--rate');
  if (!rateStr || !(Number(rateStr) > 0)) {
    throw new Error('--rate <rewardTokensPerStakedTokenPerPeriod> is required on mainnet (economics are an operator choice). Example: --rate 0.003');
  }
  const rate = Number(rateStr);
  const mint = val('--mint', BAYLA_MINT);
  const minDays = Number(val('--min-days', '1'));
  const maxDays = Number(val('--max-days', '365'));
  const periodDays = Number(val('--period-days', '1'));
  const nonce = Number(val('--nonce', '0'));
  const clusterUrl = val('--rpc', 'https://api.mainnet-beta.solana.com');
  const rewardAmount = calculateRewardAmountFromRate(rate, 6, 6);
  if (rewardAmount.isZero()) throw new Error('rate too small for 6/6 decimals — SDK computed rewardAmount 0');

  const plan = {
    cluster: 'mainnet',
    stakePool: {
      mint, nonce,
      minDuration: `${minDays}d`, maxDuration: `${maxDays}d`,
      maxWeight: '1x (flat — heat already rewards holding; weight curves are a later choice)',
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
  const connection = new Connection(clusterUrl, 'confirmed');
  const tokenProgramId = await detectTokenProgram(connection, mint);
  const ext = { invoker: payer, computePrice: 10_000, computeLimit: 'autoSimulate' };
  const created = await client.createStakePool({
    mint,
    nonce,
    minDuration: new BN(minDays * DAY),
    maxDuration: new BN(maxDays * DAY),
    maxWeight: new BN(1_000_000_000),
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
  const amountRaw = new BN(Math.round(amountWhole * 1e6).toString()); // BAYLA = 6 decimals

  log('FUNDING PLAN (task #13 — the deliberately-LAST step):');
  console.log(JSON.stringify({
    cluster: 'mainnet', stakePool: pool, rewardMint: mint,
    amount: `${amountWhole.toLocaleString()} BAYLA (${amountRaw.toString()} raw)`,
    rewardPoolNonce: Number(val('--nonce', '0')),
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
  const connection = new Connection(clusterUrl, 'confirmed');
  const client = new SolanaStakingClient({ clusterUrl, cluster: ICluster.Mainnet });
  const ext = { invoker: payer, computePrice: 10_000, computeLimit: 'autoSimulate' };

  const tokenProgramId = await detectTokenProgram(connection, mint);
  log('ensuring Streamflow treasury ATA for the reward mint…');
  await createAssociatedTokenAccountIdempotent(
    connection, payer, new PublicKey(mint), STREAMFLOW_TREASURY, undefined, new PublicKey(tokenProgramId),
  );
  log(`fundPool… ${amountWhole.toLocaleString()} BAYLA`);
  const res = await client.fundPool({
    stakePool: pool,
    stakePoolMint: mint,
    rewardMint: mint,
    nonce: Number(val('--nonce', '0')),
    amount: amountRaw,
    feeValue: null,
    tokenProgramId,
  }, ext);
  log(`✓ funded (tx ${res.txId})`);
  log(`solscan: https://solscan.io/tx/${res.txId}`);
  log('the vault balance on /farm (bayla mode) reflects this within one refresh.');
}

(REHEARSE ? rehearse() : FUND ? fund() : mainnet()).catch((e) => {
  console.error('[lighthouse] FAILED:', e?.message ?? e);
  // Anchor/web3 simulation errors carry program logs — surface them, they
  // are the only way to see WHY a simulation failed.
  const logs = e?.logs ?? e?.error?.logs ?? e?.transactionLogs;
  if (Array.isArray(logs)) for (const l of logs.slice(-12)) console.error('  log:', l);
  if (e?.signature) console.error('  sig:', e.signature);
  process.exit(1);
});
