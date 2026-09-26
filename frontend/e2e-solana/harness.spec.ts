// The harness checks itself before it is trusted to check the site.
//
// A guard that never refuses proves nothing, so each rule of the test wallet's guard
// is shown to REFUSE a transaction that breaks it, next to the same transaction built
// correctly, which it signs. The RPC guard is shown to stop methods production refuses.
import { test, expect } from '@playwright/test';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, MINT_SIZE } from '@solana/spl-token';
import { CP_SWAP_PROGRAM, LAUNCH_PROGRAM, METAPLEX, WSOL, ata, globalConfig, metadataAddress, expectedOpeningBuy, sol, fundedKeypair } from './fixtures/chain';
import { checkTransaction, LAUNCH_INDEX } from './fixtures/walletGuard';
import { installTestWallet, TEST_WALLET_NAME } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { buyIx, createLaunchIx } from '../src/lib/launcher/solana/curve/ix';
import { poolStatePda, TOKEN_PROGRAM_ID, cpAmmAuthorityPda, cpAmmConfigPda, cpObservationPda, cpPoolVaultPda } from '../src/lib/launcher/solana/curve/program';

const ids = { programId: LAUNCH_PROGRAM, cpSwapProgram: CP_SWAP_PROGRAM };
const stranger = Keypair.generate().publicKey;
const str = (s: string) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

function metadataIx(mint: PublicKey, wallet: PublicKey, isMutable: boolean) {
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
    data: Buffer.concat([Buffer.from([33]), str('Harness'), str('HRNS'), str('https://ipfs.io/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), Buffer.from([0, 0, 0, 0, 0, isMutable ? 1 : 0, 0])]),
  });
}

interface CreateOpts { minTokensOut?: bigint; feeRecipient?: PublicKey; mutable?: boolean; trailingWritable?: boolean; extra?: TransactionInstruction[]; payer?: Keypair; cuPrice?: number }
async function createTx(wallet: Keypair, mint: Keypair, o: CreateOpts = {}) {
  const g = await globalConfig();
  const q = expectedOpeningBuy(g, sol(0.05));
  const create = createLaunchIx({ creator: wallet.publicKey, mint: mint.publicKey }, ids);
  create.keys.push({ pubkey: LAUNCH_INDEX, isSigner: false, isWritable: !!o.trailingWritable });
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.cuPrice ?? 1_000 }),
    SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: 1_461_600, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, wallet.publicKey, null, TOKEN_PROGRAM_ID),
    metadataIx(mint.publicKey, wallet.publicKey, !!o.mutable),
    create,
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata(mint.publicKey, wallet.publicKey), wallet.publicKey, mint.publicKey),
    buyIx({ trader: wallet.publicKey, mint: mint.publicKey, feeRecipient: o.feeRecipient ?? g.feeRecipient, creator: wallet.publicKey }, sol(0.05), o.minTokensOut ?? q.tokensOut, ids),
    ...(o.extra ?? []),
  );
  tx.feePayer = (o.payer ?? wallet).publicKey;
  tx.recentBlockhash = PublicKey.default.toBase58();
  return Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function swapTx(wallet: PublicKey, mint: PublicKey, output: PublicKey, minOut: bigint) {
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
  const tx = new Transaction().add(ix);
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
    ]);
  });

  const cases: [string, () => Promise<Uint8Array>, RegExp][] = [
    ['a SOL transfer to a stranger', async () => createTx(wallet, Keypair.generate(), { extra: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger, lamports: 1 })] }), /not this wallet's own WSOL/],
    ['a token approval', async () => { const m = Keypair.generate(); return createTx(wallet, m, { extra: [createApproveInstruction(ata(m.publicKey, wallet.publicKey), stranger, wallet.publicKey, 1n)] }); }, /never sent by this site/],
    ['a buy with no slippage floor', async () => createTx(wallet, Keypair.generate(), { minTokensOut: 0n }), /slippage floor is 0/],
    ['a buy paying another fee recipient', async () => createTx(wallet, Keypair.generate(), { feeRecipient: stranger }), /not global.fee_recipient/],
    ['metadata left mutable', async () => createTx(wallet, Keypair.generate(), { mutable: true }), /MUTABLE/],
    ['a writable extra account on create_launch', async () => createTx(wallet, Keypair.generate(), { trailingWritable: true }), /not the read-only launch index/],
    ['another fee payer', async () => createTx(wallet, Keypair.generate(), { payer: Keypair.generate() }), /fee payer/],
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

test('the injected wallet appears in the site\'s wallet list and connects; the RPC check stops what production stops', async ({ browser }) => {
  const kp = await fundedKeypair(0.1);
  const ctx = await browser.newContext();
  await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
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
