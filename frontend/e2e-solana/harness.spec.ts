// The harness checks itself before it is trusted to check the site.
//
// A guard that never refuses proves nothing, so each rule of the test wallet's guard
// is shown to REFUSE a transaction that breaks it, next to the same transaction built
// correctly, which it signs. The RPC guard is shown to stop methods production refuses.
import { test, expect } from '@playwright/test';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import {
  createApproveCheckedInstruction, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createInitializeMint2Instruction,
  createSyncNativeInstruction, createTransferCheckedInstruction, MINT_SIZE, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  CP_SWAP_PROGRAM, LAUNCH_PROGRAM, METAPLEX, WSOL, ata, chain, globalConfig, metadataAddress, expectedOpeningBuy, sol, fundedKeypair,
  poolFacts, tokenAmount, wrapSol, type PoolFacts, CREATE_POOL_FEE_RECEIVER, poolsFor,
} from './fixtures/chain';
import { BAYLA_MINT, PLANT_HALF, WORKSHOP_BAYLA_ACCOUNT, baylaAccount } from './fixtures/bayla';
import { checkTransaction, LAUNCH_INDEX } from './fixtures/walletGuard';
import { installTestWallet, TEST_WALLET_NAME } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { createClassicToken, createSolPool, createToken2022MetadataOnly, transferLp } from './fixtures/lp';
import { installHeatStub } from './fixtures/heatStub';
import { buyIx, createLaunchIx } from '../src/lib/launcher/solana/curve/ix';
import { poolStatePda, TOKEN_PROGRAM_ID, cpAmmAuthorityPda, cpAmmConfigPda, cpObservationPda, cpPoolVaultPda } from '../src/lib/launcher/solana/curve/program';
import { depositIx, initializeIx, withdrawIx, type DepositArgs, type WithdrawArgs } from '../src/lib/solana/cpswap/ix';
import { deriveAmmConfig, deriveLpMint, derivePool, deriveVault, sortMints } from '../src/lib/solana/cpswap/program';
import { USDC_MINT, giveUsdc, usdc, usdcAmount } from './fixtures/usdc';
import { closeWsolIxs, openWsolIx, wrapIxs } from '../src/lib/launcher/solana/write/wsol';
import { isPlanProblem, planDeposit, planWithdraw } from '../src/lib/solana/lp/liquidityMath';

const ids = { programId: LAUNCH_PROGRAM, cpSwapProgram: CP_SWAP_PROGRAM };
const stranger = Keypair.generate().publicKey;
const str = (s: string) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

function metadataIx(mint: PublicKey, wallet: PublicKey, isMutable: boolean, uri = 'https://ipfs.io/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return new TransactionInstruction({
    programId: METAPLEX,
    keys: [
      { pubkey: metadataAddress(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([33]), str('Harness'), str('HRNS'), str(uri), Buffer.from([0, 0, 0, 0, 0, isMutable ? 1 : 0, 0])]),
  });
}

/** The $BAYLA plant as the site appends it: burn 50,000 from your own $BAYLA account, then 50,000 to the Workshop. */
interface PlantOpts { burnFrom?: PublicKey; mint?: PublicKey; to?: PublicKey; authority?: PublicKey; burn?: bigint; give?: bigint; decimals?: number; coSigner?: PublicKey }
function plantIxs(wallet: PublicKey, o: PlantOpts = {}): TransactionInstruction[] {
  const from = o.burnFrom ?? baylaAccount(wallet);
  const mint = o.mint ?? BAYLA_MINT;
  const auth = o.authority ?? wallet;
  const dec = o.decimals ?? 6;
  return [
    createBurnCheckedInstruction(from, mint, auth, o.burn ?? PLANT_HALF, dec, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(from, mint, o.to ?? WORKSHOP_BAYLA_ACCOUNT, auth, o.give ?? PLANT_HALF, dec, o.coSigner ? [o.coSigner] : [], TOKEN_2022_PROGRAM_ID),
  ];
}

// A case that adds a signer (64 B) would not fit beside the 80-byte link and the plant.
const SHORT_URI = 'ipfs://bafkreiharness';
interface CreateOpts { minTokensOut?: bigint; feeRecipient?: PublicKey; reserveTo?: PublicKey; legacyCreate?: boolean; mutable?: boolean; trailingWritable?: boolean; extra?: TransactionInstruction[]; payer?: Keypair; cuPrice?: number; plant?: TransactionInstruction[]; shortUri?: boolean }
async function createTx(wallet: Keypair, mint: Keypair, o: CreateOpts = {}) {
  const g = await globalConfig();
  const q = expectedOpeningBuy(g, sol(0.05));
  // The reserve-at-create program: 11 accounts, the platform reserve paid to ATA(mint, fee_recipient).
  const create = createLaunchIx({ creator: wallet.publicKey, mint: mint.publicKey, feeRecipient: o.reserveTo ?? g.feeRecipient }, ids);
  // The superseded 8-account shape (reserve held until graduation).
  if (o.legacyCreate) create.keys.splice(8);
  create.keys.push({ pubkey: LAUNCH_INDEX, isSigner: false, isWritable: !!o.trailingWritable });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.cuPrice ?? 1_000 }),
    SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: 1_461_600, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, wallet.publicKey, null, TOKEN_PROGRAM_ID),
    metadataIx(mint.publicKey, wallet.publicKey, !!o.mutable, ...(o.shortUri ? [SHORT_URI] : [])),
    create,
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata(mint.publicKey, wallet.publicKey), wallet.publicKey, mint.publicKey),
    buyIx({ trader: wallet.publicKey, mint: mint.publicKey, feeRecipient: o.feeRecipient ?? g.feeRecipient, creator: wallet.publicKey }, sol(0.05), o.minTokensOut ?? q.tokensOut, ids),
    ...(o.plant ?? plantIxs(wallet.publicKey)),
    ...(o.extra ?? []),
  );
  tx.feePayer = (o.payer ?? wallet).publicKey;
  tx.recentBlockhash = PublicKey.default.toBase58();
  return Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function swapTx(wallet: PublicKey, mint: PublicKey, output: PublicKey, minOut: bigint, extra: TransactionInstruction[] = []) {
  const pool = poolStatePda(mint, LAUNCH_PROGRAM);
  const data = Buffer.alloc(24);
  Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]).copy(data, 0);
  data.writeBigUInt64LE(1_000_000n, 8);
  data.writeBigUInt64LE(minOut, 16);
  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const ix = new TransactionInstruction({
    programId: CP_SWAP_PROGRAM,
    keys: [
      k(wallet, false, true), k(cpAmmAuthorityPda(CP_SWAP_PROGRAM)), k(cpAmmConfigPda(0, CP_SWAP_PROGRAM)), k(pool, true),
      k(ata(WSOL, wallet), true), k(output, true), k(cpPoolVaultPda(pool, WSOL, CP_SWAP_PROGRAM), true), k(cpPoolVaultPda(pool, mint, CP_SWAP_PROGRAM), true),
      k(TOKEN_PROGRAM_ID), k(TOKEN_PROGRAM_ID), k(WSOL), k(mint), k(cpObservationPda(pool, CP_SWAP_PROGRAM), true),
    ],
    data,
  });
  const tx = new Transaction().add(ix, ...extra);
  tx.feePayer = wallet;
  tx.recentBlockhash = PublicKey.default.toBase58();
  return Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

test.describe('the test wallet guard', () => {
  const wallet = Keypair.generate();

  test('signs the launch transaction the site should build', async () => {
    const ixs = await checkTransaction(await createTx(wallet, Keypair.generate()), wallet.publicKey);
    expect(ixs.map((i) => i.name)).toEqual([
      'set-compute-unit-limit', 'set-compute-unit-price', 'create-mint-account', 'initialize-mint', 'create-metadata-v3', 'create_launch', 'create-idempotent', 'buy',
      'plant-burn', 'plant-transfer',
    ]);
    expect(ixs.at(-1)?.accounts.to).toBe(WORKSHOP_BAYLA_ACCOUNT.toBase58());
  });

  // Token-2022 is accepted ONLY as the exact plant of a launch; each rule refuses its breach.
  const me = wallet.publicKey;
  const plantCases: [string, () => Promise<Uint8Array>, RegExp][] = [
    ['a $BAYLA transfer to a stranger instead of the Workshop', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { to: baylaAccount(stranger) }) }), /somewhere other than the island's Workshop/],
    ['a Token-2022 approval riding with the plant', () => createTx(wallet, Keypair.generate(), { extra: [createApproveInstruction(baylaAccount(me), stranger, me, 1n, [], TOKEN_2022_PROGRAM_ID)] }), /Token-2022 instruction 4 is not the plant/],
    ['a plant that burns more than 50,000', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { burn: PLANT_HALF + 1n }) }), /not 50,000 \$BAYLA/],
    ['a plant that sends the Workshop less than 50,000', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { give: PLANT_HALF - 1n }) }), /not 50,000 \$BAYLA/],
    ["a plant spent from someone else's $BAYLA account", () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { burnFrom: baylaAccount(stranger) }) }), /not your own \$BAYLA account/],
    ['a plant of another token', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { mint: stranger }) }), /token other than \$BAYLA/],
    ['a plant authorised by someone else', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { authority: stranger }), shortUri: true }), /authorised by someone other than you/],
    ['a plant naming the wrong decimals', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { decimals: 9 }) }), /9 decimals/],
    ['a plant transfer with an extra co-signer', () => createTx(wallet, Keypair.generate(), { plant: plantIxs(me, { coSigner: stranger }), shortUri: true }), /names 5 accounts/],
    ['the plant twice', () => createTx(wallet, Keypair.generate(), { plant: [...plantIxs(me), plantIxs(me)[0]] }), /plants more than once/],
    ['half a plant (the burn alone)', () => createTx(wallet, Keypair.generate(), { plant: [plantIxs(me)[0]] }), /half a plant/],
    ['a plant in a transaction that launches nothing', async () => { const m = Keypair.generate().publicKey; return swapTx(me, m, ata(m, me), 1n, plantIxs(me)); }, /launches nothing/],
    // Shaped like the plant's transfer to the letter (accounts, 50,000, 6 decimals), but a delegation.
    ['an approveChecked to the Workshop in place of the transfer', () => createTx(wallet, Keypair.generate(), {
      plant: [plantIxs(me)[0], createApproveCheckedInstruction(baylaAccount(me), BAYLA_MINT, WORKSHOP_BAYLA_ACCOUNT, me, PLANT_HALF, 6, [], TOKEN_2022_PROGRAM_ID)],
    }), /Token-2022 instruction 13 is not the plant/],
    ['a plant burn carrying a trailing byte', () => {
      const [burn, give] = plantIxs(me);
      burn.data = Buffer.concat([burn.data, Buffer.from([0])]);
      return createTx(wallet, Keypair.generate(), { plant: [burn, give] });
    }, /of 11 bytes is not the plant/],
  ];
  for (const [what, build, why] of plantCases) {
    test(`refuses ${what}`, async () => {
      await expect(checkTransaction(await build(), wallet.publicKey)).rejects.toThrow(why);
    });
  }

  const cases: [string, () => Promise<Uint8Array>, RegExp][] = [
    ['a SOL transfer to a stranger', async () => createTx(wallet, Keypair.generate(), { extra: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger, lamports: 1 })] }), /not this wallet's own WSOL/],
    ['a token approval', async () => { const m = Keypair.generate(); return createTx(wallet, m, { extra: [createApproveInstruction(ata(m.publicKey, wallet.publicKey), stranger, wallet.publicKey, 1n)] }); }, /never sent by this site/],
    ['a buy with no slippage floor', async () => createTx(wallet, Keypair.generate(), { minTokensOut: 0n }), /slippage floor is 0/],
    ['a buy paying another fee recipient', async () => createTx(wallet, Keypair.generate(), { feeRecipient: stranger }), /not global.fee_recipient/],
    ['a create paying the platform reserve to a stranger', async () => createTx(wallet, Keypair.generate(), { reserveTo: stranger }), /platform reserve goes to someone other than global.fee_recipient/],
    ['the superseded 8-account create_launch', async () => createTx(wallet, Keypair.generate(), { legacyCreate: true }), /platform reserve goes to someone other than global.fee_recipient/],
    ['metadata left mutable', async () => createTx(wallet, Keypair.generate(), { mutable: true }), /MUTABLE/],
    ['a writable extra account on create_launch', async () => createTx(wallet, Keypair.generate(), { trailingWritable: true }), /not the read-only launch index/],
    ['another fee payer', async () => createTx(wallet, Keypair.generate(), { payer: Keypair.generate(), shortUri: true }), /fee payer/],
    ['a priority fee above 0.001 SOL', async () => createTx(wallet, Keypair.generate(), { cuPrice: 10_000_000 }), /above the 1000000 cap/],
    ['an unknown program', async () => createTx(wallet, Keypair.generate(), { extra: [new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.alloc(0) })] }), /is not one this site calls/],
    ['a swap whose output goes to a stranger', async () => swapTx(wallet.publicKey, Keypair.generate().publicKey, ata(WSOL, stranger), 1n), /OUTPUT account is not your own/],
    ['a swap with no minimum out', async () => { const m = Keypair.generate().publicKey; return swapTx(wallet.publicKey, m, ata(m, wallet.publicKey), 0n); }, /minimum_amount_out is 0/],
  ];
  for (const [what, build, why] of cases) {
    test(`refuses ${what}`, async () => {
      await expect(checkTransaction(await build(), wallet.publicKey)).rejects.toThrow(why);
    });
  }

  test('signs the swap the site should build', async () => {
    const m = Keypair.generate().publicKey;
    const ixs = await checkTransaction(swapTx(wallet.publicKey, m, ata(m, wallet.publicKey), 1n), wallet.publicKey);
    expect(ixs.map((i) => i.name)).toEqual(['swap_base_input']);
  });
});

// ── stage 2: adding and removing liquidity ────────────────────────────────────
//
// The deposit and withdrawal below are built the way the site builds them
// (W/liquidity.ts: the same cpswap/ix.ts builders, W/wsol.ts's wrapped-SOL steps and
// liquidityMath's plans), against REAL pools on the validator, because the guard reads
// each pool from the chain. H1 and H2 then LAND what the guard signed, so the "good"
// half of every pair is a transaction the mainnet binary accepts, not only one the
// guard likes.

const U64_MAX = (1n << 64n) - 1n;
const UNIT = 10n ** 6n;
const sides = (f: PoolFacts) => {
  const p = f.pool;
  return {
    m0: new PublicKey(p.token0Mint), m1: new PublicKey(p.token1Mint),
    prog0: new PublicKey(p.token0Program), prog1: new PublicKey(p.token1Program),
    solIs0: new PublicKey(p.token0Mint).equals(WSOL),
    lpMint: new PublicKey(p.lpMint),
  };
};

async function finish(ixs: TransactionInstruction[], payer: PublicKey): Promise<Uint8Array> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ...ixs,
  );
  tx.feePayer = payer;
  tx.recentBlockhash = (await chain().getLatestBlockhash('confirmed')).blockhash;
  return Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

interface LpTxOpts {
  /** Replace instruction arguments or accounts AFTER the site's plan (the "bad" half of a pair). */
  over?: Partial<DepositArgs & WithdrawArgs>;
  /** Close the wallet's WSOL account at the end (the site does when it was absent or empty). */
  close?: boolean;
  /** Extra instructions appended (a stray instruction the site never sends). */
  extra?: TransactionInstruction[];
  /** Change the pool instruction itself after it is built (an account the builder derives). */
  mutate?: (ix: TransactionInstruction) => void;
}
const withMutation = (ix: TransactionInstruction, o: LpTxOpts) => { o.mutate?.(ix); return ix; };

/** A deposit of about 0.01 SOL's worth, as W/liquidity.ts builds it (1% slippage, SOL typed). */
async function depositTx(owner: PublicKey, f: PoolFacts, o: LpTxOpts = {}): Promise<{ bytes: Uint8Array; lp: bigint }> {
  const s = sides(f);
  const plan = planDeposit(f.snapshot, { quoteIsToken0: s.solIs0, driving: 'quote', maxIn: sol(0.01), bps: 100n, availableQuote: null, availableToken: null });
  if (isPlanProblem(plan)) throw new Error(`deposit plan: ${plan.problem}`);
  const lpAta = ata(s.lpMint, owner);
  const args: DepositArgs = {
    programId: CP_SWAP_PROGRAM, owner, poolState: f.address, ownerLpToken: lpAta,
    token0Account: ata(s.m0, owner, s.prog0), token1Account: ata(s.m1, owner, s.prog1),
    token0Vault: new PublicKey(f.pool.token0Vault), token1Vault: new PublicKey(f.pool.token1Vault),
    vault0Mint: s.m0, vault1Mint: s.m1, lpMint: s.lpMint,
    lpTokenAmount: plan.lp, maximumToken0Amount: plan.max0, maximumToken1Amount: plan.max1,
    ...o.over,
  };
  const maxSol = s.solIs0 ? plan.max0 : plan.max1;
  const ixs = [
    openWsolIx(owner),
    ...wrapIxs(owner, maxSol),
    createAssociatedTokenAccountIdempotentInstruction(owner, lpAta, owner, s.lpMint, TOKEN_PROGRAM_ID),
    withMutation(depositIx(args), o),
    ...closeWsolIxs({ ata: ata(WSOL, owner), closeAfter: o.close ?? true, heldBefore: 0n }, owner),
    ...(o.extra ?? []),
  ];
  return { bytes: await finish(ixs, owner), lp: args.lpTokenAmount };
}

/** A withdrawal of 10% of the wallet's pool-share ATA, as W/liquidity.ts builds it. */
async function withdrawTx(owner: PublicKey, f: PoolFacts, o: LpTxOpts = {}): Promise<{ bytes: Uint8Array; lp: bigint }> {
  const s = sides(f);
  const lpAta = ata(s.lpMint, owner);
  const held = (await tokenAmount(lpAta)) ?? 0n;
  const plan = planWithdraw(f.snapshot, { held, pctBps: 1_000n, bps: 100n });
  if (isPlanProblem(plan)) throw new Error(`withdraw plan: ${plan.problem}`);
  const tokenMint = s.solIs0 ? s.m1 : s.m0;
  const tokenProg = s.solIs0 ? s.prog1 : s.prog0;
  const args: WithdrawArgs = {
    programId: CP_SWAP_PROGRAM, owner, poolState: f.address, ownerLpToken: lpAta,
    token0Account: ata(s.m0, owner, s.prog0), token1Account: ata(s.m1, owner, s.prog1),
    token0Vault: new PublicKey(f.pool.token0Vault), token1Vault: new PublicKey(f.pool.token1Vault),
    vault0Mint: s.m0, vault1Mint: s.m1, lpMint: s.lpMint,
    lpTokenAmount: plan.lp, minimumToken0Amount: plan.min0, minimumToken1Amount: plan.min1,
    ...o.over,
  };
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata(tokenMint, owner, tokenProg), owner, tokenMint, tokenProg),
    openWsolIx(owner),
    withMutation(withdrawIx(args), o),
    ...closeWsolIxs({ ata: ata(WSOL, owner), closeAfter: o.close ?? true, heldBefore: 0n }, owner),
    ...(o.extra ?? []),
  ];
  return { bytes: await finish(ixs, owner), lp: args.lpTokenAmount };
}

/** Sign what the guard passed, exactly as handed over (the wallet first, then any co-signer), and land it. */
async function land(bytes: Uint8Array, kp: Keypair, coSigners: Keypair[] = []): Promise<string> {
  const vt = VersionedTransaction.deserialize(bytes);
  vt.sign([kp, ...coSigners]);
  const conn = chain();
  const sig = await conn.sendRawTransaction(vt.serialize(), { preflightCommitment: 'confirmed' });
  const bh = await conn.getLatestBlockhash('confirmed');
  const r = await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (r.value.err) throw new Error(`landed with an error: ${JSON.stringify(r.value.err)}`);
  return sig;
}

test.describe('the test wallet guard: adding and removing liquidity', () => {
  let w: Keypair;
  let holder: Keypair;
  let classic: PoolFacts;
  let t22: PublicKey;
  let t22Pool: PoolFacts;

  test.beforeAll(async () => {
    test.setTimeout(6 * 60_000);
    w = await fundedKeypair(5);
    holder = await fundedKeypair(1);
    const tok = await createClassicToken(w, { supply: 10_000_000n * UNIT, name: { name: 'E2E Harness LP', symbol: 'EHLP' } });
    classic = await poolFacts((await createSolPool(w, tok, { configIndex: 0, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' })).address);
    t22 = await createToken2022MetadataOnly(w, { name: 'E2E Harness 2022', symbol: 'EH22', supply: 10_000_000n * UNIT });
    t22Pool = await poolFacts((await createSolPool(w, t22, { configIndex: 0, sol: sol(0.5), tokens: 500_000n * UNIT, at: 'standard', tokenProgram: TOKEN_2022_PROGRAM_ID })).address);
    // Wrapped SOL the holder had BEFORE any transaction below (the kept case).
    await wrapSol(holder, sol(0.05));
    // A share of the classic pool of its own, so it can be held to ITS account.
    await transferLp(w, holder.publicKey, sides(classic).lpMint, 1_000_000n);
  });

  test('H1: signs the deposit the site builds, classic and Token-2022, and the chain takes it', async () => {
    for (const f of [classic, t22Pool]) {
      const lpAta = ata(sides(f).lpMint, w.publicKey);
      const before = (await tokenAmount(lpAta)) ?? 0n;
      const { bytes, lp } = await depositTx(w.publicKey, f);
      const ixs = await checkTransaction(bytes, w.publicKey);
      expect(ixs.map((i) => i.name)).toEqual(['set-compute-unit-limit', 'set-compute-unit-price', 'create-idempotent', 'wrap-sol', 'sync-native', 'create-idempotent', 'deposit', 'close-wsol']);
      expect(ixs.find((i) => i.name === 'deposit')?.accounts.pool_state).toBe(f.address.toBase58());
      await land(bytes, w);
      expect((await tokenAmount(lpAta)) ?? 0n).toBe(before + lp);
    }
  });

  test('H2: signs the withdrawal the site builds, classic and Token-2022 (its payout account under Token-2022), and the chain takes it', async () => {
    for (const f of [classic, t22Pool]) {
      const lpAta = ata(sides(f).lpMint, w.publicKey);
      const before = (await tokenAmount(lpAta)) ?? 0n;
      const { bytes, lp } = await withdrawTx(w.publicKey, f);
      const ixs = await checkTransaction(bytes, w.publicKey);
      expect(ixs.map((i) => i.name)).toEqual(['set-compute-unit-limit', 'set-compute-unit-price', 'create-idempotent', 'create-idempotent', 'withdraw', 'close-wsol']);
      const tokenProg = f === t22Pool ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      expect(ixs[2].args.tokenProgram).toBe(tokenProg.toBase58());
      await land(bytes, w);
      expect((await tokenAmount(lpAta)) ?? 0n).toBe(before - lp);
    }
  });

  test('H3: refuses a withdrawal paying a stranger\'s account on token_0_account (slot 4)', async () => {
    const s = sides(classic);
    const { bytes } = await withdrawTx(w.publicKey, classic, { over: { token0Account: ata(s.m0, Keypair.generate().publicKey, s.prog0) } });
    await expect(checkTransaction(bytes, w.publicKey)).rejects.toThrow(/token_0_account is not your own/);
  });

  test('H4: refuses a withdrawal paying a stranger\'s account on token_1_account (slot 5)', async () => {
    const s = sides(classic);
    const { bytes } = await withdrawTx(w.publicKey, classic, { over: { token1Account: ata(s.m1, Keypair.generate().publicKey, s.prog1) } });
    await expect(checkTransaction(bytes, w.publicKey)).rejects.toThrow(/token_1_account is not your own/);
  });

  test('H5: refuses a deposit whose vault is not the pool\'s own (another pool\'s, or no pool\'s)', async () => {
    const other = await depositTx(w.publicKey, classic, { over: { token0Vault: new PublicKey(t22Pool.pool.token0Vault) } });
    await expect(checkTransaction(other.bytes, w.publicKey)).rejects.toThrow(/token_0_vault is not the pool's own/);
    const none = await depositTx(w.publicKey, classic, { over: { token1Vault: Keypair.generate().publicKey } });
    await expect(checkTransaction(none.bytes, w.publicKey)).rejects.toThrow(/token_1_vault is not the pool's own/);
  });

  test('H6: refuses a deposit whose maximum is u64::MAX (or 0)', async () => {
    const max = await depositTx(w.publicKey, classic, { over: { maximumToken1Amount: U64_MAX } });
    await expect(checkTransaction(max.bytes, w.publicKey)).rejects.toThrow(/maximum_token_1_amount is u64::MAX/);
    const zero = await depositTx(w.publicKey, classic, { over: { maximumToken0Amount: 0n } });
    await expect(checkTransaction(zero.bytes, w.publicKey)).rejects.toThrow(/maximum_token_0_amount is 0/);
  });

  test('H7: refuses a withdrawal whose minimum is 0', async () => {
    for (const side of ['0', '1'] as const) {
      const over = side === '0' ? { minimumToken0Amount: 0n } : { minimumToken1Amount: 0n };
      const { bytes } = await withdrawTx(w.publicKey, classic, { over });
      await expect(checkTransaction(bytes, w.publicKey)).rejects.toThrow(new RegExp(`minimum_token_${side}_amount is 0`));
    }
  });

  test('H8: refuses to close a WSOL account that already held wrapped SOL; signs the same deposit that keeps it', async () => {
    expect(await tokenAmount(ata(WSOL, holder.publicKey))).toBe(sol(0.05));
    const closes = await depositTx(holder.publicKey, classic, { close: true });
    await expect(checkTransaction(closes.bytes, holder.publicKey)).rejects.toThrow(/already held 50000000 wrapped lamports/);
    const keeps = await depositTx(holder.publicKey, classic, { close: false });
    const ixs = await checkTransaction(keeps.bytes, holder.publicKey);
    expect(ixs.some((i) => i.name === 'close-wsol')).toBe(false);
  });

  test('H9: refuses a classic-seeded token account for a Token-2022 mint, whichever program it names', async () => {
    const classicSeeded = ata(t22, w.publicKey, TOKEN_PROGRAM_ID);
    const under = (program: PublicKey) => depositTx(w.publicKey, t22Pool, { extra: [createAssociatedTokenAccountIdempotentInstruction(w.publicKey, classicSeeded, w.publicKey, t22, program)] });
    await expect(checkTransaction((await under(TOKEN_PROGRAM_ID)).bytes, w.publicKey)).rejects.toThrow(/for a mint owned by TokenzQd/);
    await expect(checkTransaction((await under(TOKEN_2022_PROGRAM_ID)).bytes, w.publicKey)).rejects.toThrow(/not your own/);
    // The Token-2022-seeded one is accepted (H2 also lands it).
    const good = await depositTx(w.publicKey, t22Pool, { extra: [createAssociatedTokenAccountIdempotentInstruction(w.publicKey, ata(t22, w.publicKey, TOKEN_2022_PROGRAM_ID), w.publicKey, t22, TOKEN_2022_PROGRAM_ID)] });
    expect((await checkTransaction(good.bytes, w.publicKey)).at(-1)?.args.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  test('H10: refuses a top-level Token-2022 instruction', async () => {
    const { bytes } = await depositTx(w.publicKey, t22Pool, { extra: [createSyncNativeInstruction(ata(t22, w.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID)] });
    await expect(checkTransaction(bytes, w.publicKey)).rejects.toThrow(/top-level Token-2022 instruction/);
  });

  test('also refuses: shares paid to a stranger, a share account not yours or not this pool\'s, another owner, zero shares, a wrong authority or program slot, an extra account', async () => {
    const s = sides(classic);
    const cases: [string, Promise<{ bytes: Uint8Array }>, PublicKey, RegExp][] = [
      ['a deposit paying its shares to a stranger', depositTx(w.publicKey, classic, { over: { ownerLpToken: ata(s.lpMint, Keypair.generate().publicKey) } }), w.publicKey, /deposit: the pool shares go to an account that is not your own/],
      ['a withdrawal from someone else\'s share account', withdrawTx(holder.publicKey, classic, { over: { ownerLpToken: ata(s.lpMint, w.publicKey) } }), holder.publicKey, /withdraw: the pool-share account is not your own/],
      ['a withdrawal from a share account of another pool', withdrawTx(w.publicKey, classic, { over: { ownerLpToken: ata(sides(t22Pool).lpMint, w.publicKey) } }), w.publicKey, /withdraw: the pool-share account holds a different token/],
      ['a deposit made in someone else\'s name', depositTx(w.publicKey, classic, { over: { owner: Keypair.generate().publicKey } }), w.publicKey, /deposit: the owner is not you/],
      ['zero shares', depositTx(w.publicKey, classic, { over: { lpTokenAmount: 0n } }), w.publicKey, /deposit: lp_token_amount is 0/],
      ['a wrong authority', depositTx(w.publicKey, classic, { mutate: (ix) => { ix.keys[1] = { ...ix.keys[1], pubkey: Keypair.generate().publicKey }; } }), w.publicKey, /authority is not the pool program's own/],
      ['the Token-2022 program slot holding the classic program', withdrawTx(w.publicKey, classic, { mutate: (ix) => { ix.keys[9] = { ...ix.keys[9], pubkey: TOKEN_PROGRAM_ID }; } }), w.publicKey, /token_program_2022 is TokenkegQ/],
      ['an extra account on the withdrawal', withdrawTx(w.publicKey, classic, { mutate: (ix) => { ix.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }); } }), w.publicKey, /withdraw: 15 accounts, the pinned IDL has 14/],
    ];
    for (const [what, build, signer, why] of cases) {
      await expect(checkTransaction((await build).bytes, signer), what).rejects.toThrow(why);
    }
    // The holder's own share account passes (the good half of the second case).
    const own = await withdrawTx(holder.publicKey, classic, { close: false });
    expect((await checkTransaction(own.bytes, holder.publicKey)).some((i) => i.name === 'withdraw')).toBe(true);
  });
});

// ── opening a pool (create) ───────────────────────────────────────────────────
//
// Built the way W/createPool.ts builds an opening (prepareLpCreate step 14): the wallet's
// wrapped-SOL account opened and filled with exactly the SOL going in, cp-swap's
// initialize on fee tier 1 with open_time 0, and the wrapped-SOL account closed. H11 and
// H12 land on the validator, so the "good" half is an opening the binary accepts.

interface OpenOpts {
  /** A fresh key for the pool (the one-off path); the standard address otherwise. */
  fresh?: Keypair;
  tier?: 0 | 1 | 2;
  openTime?: bigint;
  over?: Partial<Parameters<typeof initializeIx>[0]>;
  /** Change the instruction after it is built (accounts the builder derives). */
  mutate?: (ix: TransactionInstruction) => void;
  extra?: TransactionInstruction[];
}

async function openingTx(owner: PublicKey, mint: PublicKey, o: OpenOpts = {}): Promise<{ bytes: Uint8Array; pool: PublicKey; lpMint: PublicKey }> {
  const config = deriveAmmConfig(CP_SWAP_PROGRAM, o.tier ?? 1);
  const { token0, token1 } = sortMints(WSOL, mint);
  const solIs0 = token0.equals(WSOL);
  const amountSol = sol(0.1);
  const amountTok = 100_000n * UNIT;
  const pool = o.fresh?.publicKey ?? derivePool(CP_SWAP_PROGRAM, config, token0, token1);
  const lpMint = deriveLpMint(CP_SWAP_PROGRAM, pool);
  const wsolAcc = ata(WSOL, owner);
  const tokAcc = ata(mint, owner);
  const init = initializeIx({
    programId: CP_SWAP_PROGRAM, creator: owner, ammConfig: config, token0Mint: token0, token1Mint: token1,
    creatorToken0: solIs0 ? wsolAcc : tokAcc, creatorToken1: solIs0 ? tokAcc : wsolAcc, creatorLpToken: ata(lpMint, owner),
    token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID, createPoolFee: CREATE_POOL_FEE_RECEIVER,
    initAmount0: solIs0 ? amountSol : amountTok, initAmount1: solIs0 ? amountTok : amountSol, openTime: o.openTime ?? 0n,
    poolState: o.fresh?.publicKey,
    ...o.over,
  });
  o.mutate?.(init);
  const ixs = [openWsolIx(owner), ...wrapIxs(owner, amountSol), init, ...closeWsolIxs({ ata: wsolAcc, closeAfter: true, heldBefore: 0n }, owner), ...(o.extra ?? [])];
  return { bytes: await finish(ixs, owner), pool, lpMint };
}

test.describe('the test wallet guard: opening a pool', () => {
  let opener: Keypair;
  let mint: PublicKey;
  const OPENING = ['set-compute-unit-limit', 'set-compute-unit-price', 'create-idempotent', 'wrap-sol', 'sync-native', 'initialize', 'close-wsol'];

  test.beforeAll(async () => {
    test.setTimeout(4 * 60_000);
    opener = await fundedKeypair(3);
    mint = await createClassicToken(opener, { supply: 10_000_000n * UNIT, name: { name: 'E2E Harness Open', symbol: 'EHOPEN' } });
  });

  test('H11: signs the site\'s standard opening on fee tier 1, and the chain opens it there', async () => {
    const { bytes, pool, lpMint } = await openingTx(opener.publicKey, mint);
    const ixs = await checkTransaction(bytes, opener.publicKey);
    expect(ixs.map((i) => i.name)).toEqual(OPENING);
    const init = ixs.find((i) => i.name === 'initialize')!;
    expect(init.args).toMatchObject({ openTime: '0', origin: 'standard' });
    expect(init.accounts.amm_config).toBe(deriveAmmConfig(CP_SWAP_PROGRAM, 1).toBase58());
    expect(init.accounts.create_pool_fee).toBe(CREATE_POOL_FEE_RECEIVER.toBase58());
    await land(bytes, opener);
    expect((await poolsFor(mint, opener.publicKey)).map((k) => k.toBase58())).toEqual([pool.toBase58()]);
    expect((await tokenAmount(ata(lpMint, opener.publicKey)) ?? 0n) > 0n).toBe(true);
  });

  test('H12: signs the site\'s one-off opening (a fresh key that co-signs), and the chain opens it at that key', async () => {
    const fresh = Keypair.generate();
    const { bytes, pool } = await openingTx(opener.publicKey, mint, { fresh });
    expect(VersionedTransaction.deserialize(bytes).message.header.numRequiredSignatures).toBe(2);
    const ixs = await checkTransaction(bytes, opener.publicKey);
    expect(ixs.map((i) => i.name)).toEqual(OPENING);
    expect(ixs.find((i) => i.name === 'initialize')!.args.origin).toBe('co-signer');
    await land(bytes, opener, [fresh]);
    expect((await poolsFor(mint, opener.publicKey)).map((k) => k.toBase58())).toContain(pool.toBase58());
  });

  test('H13: refuses an opening on fee tier 0 (the launch tier), by name', async () => {
    const { bytes } = await openingTx(opener.publicKey, mint, { tier: 0 });
    await expect(checkTransaction(bytes, opener.publicKey)).rejects.toThrow(/launch tier \(fee tier 0\)/);
  });

  test('H14: refuses an opening whose open_time is not 0', async () => {
    const { bytes } = await openingTx(opener.publicKey, mint, { fresh: Keypair.generate(), openTime: 1n });
    await expect(checkTransaction(bytes, opener.publicKey)).rejects.toThrow(/open_time is 1, so the pool would open for trading later/);
  });

  test('H15: refuses an opening whose creator_token_1 is a stranger\'s account', async () => {
    const { token1 } = sortMints(WSOL, mint);
    const { bytes } = await openingTx(opener.publicKey, mint, { fresh: Keypair.generate(), over: { creatorToken1: ata(token1, Keypair.generate().publicKey) } });
    await expect(checkTransaction(bytes, opener.publicKey)).rejects.toThrow(/creator_token_1 is not your own/);
  });

  test('H16: refuses an opening with a 21st account (it would be read as a support-mint record)', async () => {
    const { bytes } = await openingTx(opener.publicKey, mint, { fresh: Keypair.generate(), mutate: (ix) => { ix.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }); } });
    await expect(checkTransaction(bytes, opener.publicKey)).rejects.toThrow(/initialize: 21 accounts, the pinned IDL has 20/);
  });

  test('H17: refuses a top-level account-create of the new pool-share mint inside an opening', async () => {
    const fresh = Keypair.generate();
    const lpMint = deriveLpMint(CP_SWAP_PROGRAM, fresh.publicKey);
    const { bytes } = await openingTx(opener.publicKey, mint, { fresh, extra: [createAssociatedTokenAccountIdempotentInstruction(opener.publicKey, ata(lpMint, opener.publicKey), opener.publicKey, lpMint)] });
    await expect(checkTransaction(bytes, opener.publicKey)).rejects.toThrow(/an opening creates only your wrapped-SOL account/);
  });

  test('also refuses an opening: another creator, tier, authority or fee account, a pool that neither is standard nor signs, mints out of order or without SOL, an account not derived, the wrong token program, an empty side', async () => {
    const stranger = Keypair.generate().publicKey;
    const fresh = Keypair.generate();
    const cases: [string, Promise<{ bytes: Uint8Array }>, RegExp][] = [
      ['another creator', openingTx(opener.publicKey, mint, { fresh, over: { creator: stranger } }), /opened and paid for by someone else/],
      ['fee tier 2', openingTx(opener.publicKey, mint, { tier: 2 }), /a fee tier this site does not use/],
      ['a pool key that does not sign', openingTx(opener.publicKey, mint, { fresh, mutate: (ix) => { ix.keys[3] = { ...ix.keys[3], isSigner: false }; } }), /neither the standard address nor a fresh key that signs/],
      ['a vault not derived from the pool', openingTx(opener.publicKey, mint, { fresh, mutate: (ix) => { ix.keys[10] = { ...ix.keys[10], pubkey: Keypair.generate().publicKey }; } }), /token_0_vault is not the one the pool's address gives/],
      ['the token side under Token-2022', openingTx(opener.publicKey, mint, { fresh, over: { token0Program: TOKEN_2022_PROGRAM_ID, token1Program: TOKEN_2022_PROGRAM_ID } }), /token_\d_program is not the program that owns that mint/],
      ['shares to a stranger', openingTx(opener.publicKey, mint, { fresh, over: { creatorLpToken: ata(deriveLpMint(CP_SWAP_PROGRAM, fresh.publicKey), stranger) } }), /the pool shares go to an account that is not your own/],
      ['an empty side', openingTx(opener.publicKey, mint, { fresh, over: { initAmount0: 0n } }), /would open with an empty side/],
      ['the fee to open paid elsewhere', openingTx(opener.publicKey, mint, { fresh, over: { createPoolFee: stranger } }), /create_pool_fee is .*, not 2sa31zce/],
      ['a wrong authority', openingTx(opener.publicKey, mint, { fresh, mutate: (ix) => { ix.keys[2] = { ...ix.keys[2], pubkey: stranger }; } }), /the authority is not the pool program's own/],
      ['the mints out of order', openingTx(opener.publicKey, mint, { fresh, mutate: (ix) => { const k4 = ix.keys[4]; ix.keys[4] = ix.keys[5]; ix.keys[5] = k4; } }), /the two mints are not in the program's order/],
      ['two tokens and no SOL', openingTx(opener.publicKey, mint, {
        fresh,
        mutate: (ix) => {
          const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey].sort((x, y) => Buffer.compare(x.toBuffer(), y.toBuffer()));
          ix.keys[4] = { ...ix.keys[4], pubkey: a };
          ix.keys[5] = { ...ix.keys[5], pubkey: b };
        },
      }), /does not pair a token with SOL/],
    ];
    for (const [what, build, why] of cases) {
      await expect(checkTransaction((await build).bytes, opener.publicKey), what).rejects.toThrow(why);
    }
  });

  // ── pools paired with USDC or BAYLA (owner ruling 2026-10-03) ──
  // Only SOL is wrapped. A pool paired with USDC takes the USDC from the wallet's own
  // account, so its opening is the pool instruction alone, and nothing in an opening or a
  // deposit may touch wrapped SOL.

  /** The site's opening of a pool paired with USDC (W/createPool.ts): 10 USDC against 100,000 tokens, the pool instruction alone. */
  async function usdcOpeningTx(owner: PublicKey, o: { pre?: TransactionInstruction[]; post?: TransactionInstruction[] } = {}): Promise<{ bytes: Uint8Array; pool: PublicKey }> {
    const config = deriveAmmConfig(CP_SWAP_PROGRAM, 1);
    const { token0, token1 } = sortMints(USDC_MINT, mint);
    const usdcIs0 = token0.equals(USDC_MINT);
    const pool = derivePool(CP_SWAP_PROGRAM, config, token0, token1);
    const init = initializeIx({
      programId: CP_SWAP_PROGRAM, creator: owner, ammConfig: config, token0Mint: token0, token1Mint: token1,
      creatorToken0: ata(token0, owner), creatorToken1: ata(token1, owner), creatorLpToken: ata(deriveLpMint(CP_SWAP_PROGRAM, pool), owner),
      token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID, createPoolFee: CREATE_POOL_FEE_RECEIVER,
      initAmount0: usdcIs0 ? usdc(10) : 100_000n * UNIT, initAmount1: usdcIs0 ? 100_000n * UNIT : usdc(10), openTime: 0n,
    });
    return { bytes: await finish([...(o.pre ?? []), init, ...(o.post ?? [])], owner), pool };
  }

  test('H18: signs an opening paired with USDC and a deposit into it, neither wrapping anything, and the chain takes both; the same deposit with SOL wrapped beside it is refused', async () => {
    test.setTimeout(4 * 60_000);
    const owner = opener.publicKey;
    await giveUsdc(opener, usdc(100));
    const { bytes, pool } = await usdcOpeningTx(owner);
    const ixs = await checkTransaction(bytes, owner);
    expect(ixs.map((i) => i.name)).toEqual(['set-compute-unit-limit', 'set-compute-unit-price', 'initialize']);
    expect(ixs[2].args).toMatchObject({ pairedWith: 'USDC', origin: 'standard', openTime: '0' });
    await land(bytes, opener);
    expect(await usdcAmount(deriveVault(CP_SWAP_PROGRAM, pool, USDC_MINT)), 'the pool holds the 10 USDC').toBe(usdc(10));
    expect(await tokenAmount(ata(WSOL, owner)), 'no wrapped-SOL account was opened').toBeNull();

    // A deposit of up to 1 USDC, as W/liquidity.ts builds it for a pool that is not paired with SOL.
    const f = await poolFacts(pool);
    const s = sides(f);
    const plan = planDeposit(f.snapshot, { quoteIsToken0: s.m0.equals(USDC_MINT), driving: 'quote', maxIn: usdc(1), bps: 100n, availableQuote: null, availableToken: null });
    if (isPlanProblem(plan)) throw new Error(`deposit plan: ${plan.problem}`);
    const lpAta = ata(s.lpMint, owner);
    const body = [
      createAssociatedTokenAccountIdempotentInstruction(owner, lpAta, owner, s.lpMint, TOKEN_PROGRAM_ID),
      depositIx({
        programId: CP_SWAP_PROGRAM, owner, poolState: pool, ownerLpToken: lpAta,
        token0Account: ata(s.m0, owner, s.prog0), token1Account: ata(s.m1, owner, s.prog1),
        token0Vault: new PublicKey(f.pool.token0Vault), token1Vault: new PublicKey(f.pool.token1Vault),
        vault0Mint: s.m0, vault1Mint: s.m1, lpMint: s.lpMint,
        lpTokenAmount: plan.lp, maximumToken0Amount: plan.max0, maximumToken1Amount: plan.max1,
      }),
    ];
    const good = await finish(body, owner);
    const signed = await checkTransaction(good, owner);
    expect(signed.map((i) => i.name)).toEqual(['set-compute-unit-limit', 'set-compute-unit-price', 'create-idempotent', 'deposit']);
    expect(signed[3].args.pairedWith).toBe('USDC');
    const heldBefore = (await tokenAmount(lpAta))!;
    await land(good, opener);
    expect((await tokenAmount(lpAta))! - heldBefore).toBe(plan.lp);
    // The same deposit, with SOL wrapped and unwrapped around it as a SOL pool's is.
    const wrapped = await finish([openWsolIx(owner), ...wrapIxs(owner, sol(0.01)), ...body, ...closeWsolIxs({ ata: ata(WSOL, owner), closeAfter: true, heldBefore: 0n }, owner)], owner);
    await expect(checkTransaction(wrapped, owner)).rejects.toThrow(/deposit: the pool is paired with USDC, not SOL, and the transaction still carries create-idempotent on wrapped SOL/);
  });

  test('H19: refuses an opening paired with USDC that wraps SOL, opens or closes a wrapped-SOL account, or opens any other account', async () => {
    const owner = opener.publicKey;
    const notSol = /initialize: the pool is paired with USDC, not SOL, and the transaction still carries/;
    const cases: [string, Promise<{ bytes: Uint8Array }>, RegExp][] = [
      ['SOL wrapped beside it', usdcOpeningTx(owner, { pre: [openWsolIx(owner), ...wrapIxs(owner, sol(0.1))] }), notSol],
      ['a wrapped-SOL account opened', usdcOpeningTx(owner, { pre: [openWsolIx(owner)] }), notSol],
      ['a wrapped-SOL account closed', usdcOpeningTx(owner, { post: closeWsolIxs({ ata: ata(WSOL, owner), closeAfter: true, heldBefore: 0n }, owner) }), notSol],
      ['the token account opened', usdcOpeningTx(owner, { pre: [createAssociatedTokenAccountIdempotentInstruction(owner, ata(mint, owner), owner, mint)] }), /an opening creates only your wrapped-SOL account/],
    ];
    for (const [what, build, why] of cases) {
      await expect(checkTransaction((await build).bytes, owner), what).rejects.toThrow(why);
    }
  });
});

test('the injected wallet appears in the site\'s wallet list and connects; the RPC check stops what production stops', async ({ browser }) => {
  const kp = await fundedKeypair(0.1);
  const ctx = await browser.newContext();
  await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
  // Warm, so the create form (which shows the connected address) opens below the door.
  await installHeatStub(ctx);
  const page = await ctx.newPage();
  await page.goto('/curve-launch');
  const connect = page.getByRole('button', { name: 'Connect Solana Wallet' }).first();
  await connect.click();
  const row = page.getByRole('dialog').getByRole('button', { name: new RegExp(TEST_WALLET_NAME) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText(kp.publicKey.toBase58()).first()).toBeVisible({ timeout: 15_000 });

  rpc.view('probe');
  const statuses = await page.evaluate(async () => {
    const post = (body: unknown) => fetch('/api/solrpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
    return {
      scan: await post({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: ['11111111111111111111111111111111'] }),
      airdrop: await post({ jsonrpc: '2.0', id: 2, method: 'requestAirdrop', params: ['11111111111111111111111111111111', 1] }),
      ok: await post({ jsonrpc: '2.0', id: 3, method: 'getHealth' }),
    };
  });
  expect(statuses).toEqual({ scan: 403, airdrop: 403, ok: 200 });
  expect(rpc.violations.filter((v) => v.startsWith('[probe]'))).toHaveLength(2);
  await ctx.close();
});

test('the RPC rewrite changes what the PAGE reads of one account, single or batched, and nothing else; clearing it restores the chain', async ({ browser }) => {
  const ctx = await browser.newContext();
  const rpc = await installRpcGuard(ctx);
  const page = await ctx.newPage();
  await page.goto('/pools');
  const tier1 = deriveAmmConfig(CP_SWAP_PROGRAM, 1).toBase58();
  const tier0 = deriveAmmConfig(CP_SWAP_PROGRAM, 0).toBase58();
  const real = Buffer.from((await chain().getAccountInfo(new PublicKey(tier1), 'confirmed'))!.data);
  const read = () => page.evaluate(async ([a, b]) => {
    const post = (body: unknown) => fetch('/api/solrpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const one = await post({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [a, { encoding: 'base64', commitment: 'confirmed' }] });
    const many = await post([{ jsonrpc: '2.0', id: 7, method: 'getMultipleAccounts', params: [[b, a], { encoding: 'base64', commitment: 'confirmed' }] }]);
    const d = (v: { data: [string, string] } | null) => (v ? v.data[0] : null);
    return { one: d(one.result.value), many: (many[0].result.value as ({ data: [string, string] } | null)[]).map(d) };
  }, [tier1, tier0] as const);

  const before = await read();
  expect(before.one).toBe(real.toString('base64'));

  // The switch byte (offset 9, disable_create_pool) set, in the page's reads only.
  rpc.rewriteAccount(tier1, (data) => { const b = Buffer.from(data!); b[9] = 1; return b; });
  const flipped = Buffer.from(real); flipped[9] = 1;
  const during = await read();
  expect(during.one).toBe(flipped.toString('base64'));
  expect(during.many).toEqual([before.many[0], flipped.toString('base64')]);
  expect(rpc.rewrittenCount(tier1)).toBe(2);
  expect(Buffer.from((await chain().getAccountInfo(new PublicKey(tier1), 'confirmed'))!.data).equals(real), 'the chain itself is untouched').toBe(true);

  rpc.rewriteAccount(tier1, () => null);
  const gone = await read();
  expect(gone.one).toBeNull();
  expect(gone.many).toEqual([before.many[0], null]);

  rpc.clearRewrites();
  expect(await read()).toEqual(before);
  expect(rpc.violations).toEqual([]);
  await ctx.close();
});
