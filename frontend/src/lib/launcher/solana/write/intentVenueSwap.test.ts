// @vitest-environment node
//
// A swap the Solana swap page sends to one of our pools (`venue-swap`), read back out of
// its bytes and judged against PoolPins, the pool as prepare read it. Each refusal case
// changes ONE slot and names its own reason, so a dropped check cannot hide behind the
// catch-all "not a kind of transaction this page builds".
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { deriveAuthority, deriveLpMint, deriveObservation, deriveVault, sortMints } from '../../../solana/cpswap/program';
import { depositIx, swapBaseInputIx } from '../../../solana/cpswap/ix';
import { PROGRAMS_BY_KIND, decodeIntent, isPoolIntent } from './intent';
import { AMM_CONFIG, CPSWAP, cfgLocal } from './testkit.fixture';
import type { IntentContext, PoolIntent, PoolPins } from './types';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../solana/lp/quotes';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const fresh = () => Keypair.generate().publicKey;

/** A pool's pins as poolPins() derives them: `quote` against a token under `tokenProgram`. */
function pinsFor(o: { quote?: QuoteCoin; tokenProgram?: PublicKey; tokenMint?: PublicKey } = {}): PoolPins {
  const quote = o.quote ?? SOL_QUOTE;
  const quoteMint = new PublicKey(quote.mint);
  const quoteProgram = new PublicKey(quote.program);
  const address = fresh();
  const tokenMint = o.tokenMint ?? fresh();
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const { token0, token1 } = sortMints(quoteMint, tokenMint);
  const quoteIsToken0 = token0.equals(quoteMint);
  const lpMint = deriveLpMint(CPSWAP, address);
  return {
    address,
    ammConfig: AMM_CONFIG,
    origin: 'standard',
    token0Mint: token0,
    token1Mint: token1,
    token0Program: quoteIsToken0 ? quoteProgram : tokenProgram,
    token1Program: quoteIsToken0 ? tokenProgram : quoteProgram,
    vault0: deriveVault(CPSWAP, address, token0),
    vault1: deriveVault(CPSWAP, address, token1),
    lpMint,
    observation: deriveObservation(CPSWAP, address),
    tokenMint,
    tokenProgram,
    quote,
    quoteIsToken0,
    lpAccount: associatedTokenAddress(lpMint, ME, TOKEN_PROGRAM_ID),
  };
}

const ctxFor = (pins: PoolPins, kind: PoolIntent['kind'] = 'venue-swap'): PoolIntent => ({ kind, signer: ME, cfg: cfgLocal, maxPriorityLamports: 1_000_000n, pins });

const programOf = (p: PoolPins, m: PublicKey) => (m.equals(p.token0Mint) ? p.token0Program : p.token1Program);
const vaultOf = (p: PoolPins, m: PublicKey) => (m.equals(p.token0Mint) ? p.vault0 : p.vault1);
const mine = (p: PoolPins, m: PublicKey) => associatedTokenAddress(m, ME, programOf(p, m));

/** The swap this site builds: `input` in, the pool's other mint out, every account the pins'. */
function swap(p: PoolPins, input: PublicKey, o: Partial<{ amountIn: bigint; minOut: bigint }> = {}): TransactionInstruction {
  const output = input.equals(p.token0Mint) ? p.token1Mint : p.token0Mint;
  return swapBaseInputIx({
    programId: CPSWAP,
    payer: ME,
    ammConfig: p.ammConfig,
    poolState: p.address,
    inputTokenAccount: mine(p, input),
    outputTokenAccount: mine(p, output),
    inputVault: vaultOf(p, input),
    outputVault: vaultOf(p, output),
    inputTokenProgram: programOf(p, input),
    outputTokenProgram: programOf(p, output),
    inputTokenMint: input,
    outputTokenMint: output,
    observationState: p.observation,
    amountIn: o.amountIn ?? 1_000_000n,
    minimumAmountOut: o.minOut ?? 990n,
  });
}

const createAta = (mint: PublicKey, program: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(ME, associatedTokenAddress(mint, ME, program), ME, mint, program);
const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
const wrap = (lamports: bigint) => [SystemProgram.transfer({ fromPubkey: ME, toPubkey: wsolAta, lamports }), createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID)];
const closeWsol = () => createCloseAccountInstruction(wsolAta, ME, ME, [], TOKEN_PROGRAM_ID);

/** The same instruction with one account slot replaced. */
const withKey = (ix: TransactionInstruction, i: number, pubkey: PublicKey) =>
  new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k, n) => (n === i ? { ...k, pubkey } : k)), data: ix.data });

const ok = (ixs: TransactionInstruction[], c: IntentContext) => {
  const r = decodeIntent(ixs, c);
  expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  return r.ok ? r.steps : [];
};
const refused = (ixs: TransactionInstruction[], why: RegExp, c: IntentContext) => {
  const r = decodeIntent(ixs, c);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(why);
};

describe('a swap in one of our pools decodes into one readable step', () => {
  it('SOL in: wrap, open the token account, swap, close the wrapped SOL', () => {
    const p = pinsFor();
    const steps = ok([createAta(WSOL_MINT, TOKEN_PROGRAM_ID), ...wrap(1_000_000n), createAta(p.tokenMint, p.tokenProgram), swap(p, WSOL_MINT), closeWsol()], ctxFor(p));
    expect(steps.map((s) => s.kind)).toEqual(['create-token-account', 'wrap-sol', 'sync-wsol', 'create-token-account', 'pool-swap', 'close-wsol']);
    expect(steps[4]).toEqual({ kind: 'pool-swap', pool: p.address, inputMint: WSOL_MINT, outputMint: p.tokenMint, amountIn: 1_000_000n, minimumAmountOut: 990n });
  });

  it('SOL out: open the wrapped-SOL account, swap, close it', () => {
    const p = pinsFor();
    const steps = ok([createAta(WSOL_MINT, TOKEN_PROGRAM_ID), swap(p, p.tokenMint), closeWsol()], ctxFor(p));
    expect(steps.find((s) => s.kind === 'pool-swap')).toMatchObject({ inputMint: p.tokenMint, outputMint: WSOL_MINT });
  });

  it('a pool paired with USDC: open the output account, swap, and nothing is wrapped', () => {
    const p = pinsFor({ quote: USDC_QUOTE });
    ok([createAta(p.tokenMint, p.tokenProgram), swap(p, new PublicKey(USDC_QUOTE.mint))], ctxFor(p));
  });

  it('BAYLA (Token-2022) on one side: its accounts are the ones seeded under Token-2022', () => {
    // BAYLA/SOL, BAYLA priced in SOL: the venue's own pool.
    const p = pinsFor({ tokenMint: new PublicKey(BAYLA_QUOTE.mint), tokenProgram: TOKEN_2022_PROGRAM_ID });
    const ixs = [createAta(WSOL_MINT, TOKEN_PROGRAM_ID), ...wrap(1_000_000n), createAta(p.tokenMint, TOKEN_2022_PROGRAM_ID), swap(p, WSOL_MINT), closeWsol()];
    ok(ixs, ctxFor(p));
    const s = swap(p, WSOL_MINT);
    expect(s.keys[5]!.pubkey.equals(associatedTokenAddress(p.tokenMint, ME, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(s.keys[9]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it('is a pool intent, with its own programs', () => {
    expect(isPoolIntent(ctxFor(pinsFor()))).toBe(true);
    expect([...PROGRAMS_BY_KIND['venue-swap']].sort()).toEqual(['ata', 'compute', 'pool', 'system', 'token']);
  });
});

describe('refused: a swap slot that is not the checked pool’s, or not yours', () => {
  const p = pinsFor({ tokenMint: new PublicKey(BAYLA_QUOTE.mint), tokenProgram: TOKEN_2022_PROGRAM_ID });
  const c = ctxFor(p);
  it.each([
    [0, STRANGER, /paid by someone else/],
    [1, fresh(), /wrong pool authority/],
    [2, fresh(), /wrong fee settings/],
    [3, fresh(), /different pool than the one checked/],
    [4, associatedTokenAddress(WSOL_MINT, STRANGER), /spends from an account that is not yours/],
    [5, associatedTokenAddress(new PublicKey(BAYLA_QUOTE.mint), STRANGER, TOKEN_2022_PROGRAM_ID), /pays out to an account that is not yours/],
    // The payout account seeded under the classic program is a different address for a Token-2022 mint.
    [5, associatedTokenAddress(new PublicKey(BAYLA_QUOTE.mint), ME, TOKEN_PROGRAM_ID), /pays out to an account that is not yours/],
    [6, fresh(), /wrong pool vault/],
    [7, fresh(), /wrong pool vault/],
    [8, TOKEN_2022_PROGRAM_ID, /wrong token program/],
    [9, TOKEN_PROGRAM_ID, /wrong token program/],
    [12, fresh(), /wrong price record/],
  ] as const)('slot %i changed', (slot, pubkey, why) => {
    ok([swap(p, WSOL_MINT)], c);
    refused([withKey(swap(p, WSOL_MINT), slot, pubkey)], why, c);
  });

  it('a mint that is not one of the pool’s two, or the same mint on both sides', () => {
    refused([withKey(swap(p, WSOL_MINT), 11, fresh())], /not between this pool’s two tokens/, c);
    refused([withKey(swap(p, WSOL_MINT), 11, WSOL_MINT)], /not between this pool’s two tokens/, c);
  });

  it('the vault the pins give for the OTHER side', () => {
    refused([withKey(swap(p, WSOL_MINT), 6, vaultOf(p, p.tokenMint))], /wrong pool vault/, c);
  });

  it('an account missing, or one too many', () => {
    const ix = swap(p, WSOL_MINT);
    refused([new TransactionInstruction({ programId: CPSWAP, keys: ix.keys.slice(0, 12), data: ix.data })], /has 12 accounts, expected 13/, c);
    refused([new TransactionInstruction({ programId: CPSWAP, keys: [...ix.keys, ix.keys[0]!], data: ix.data })], /has 14 accounts, expected 13/, c);
  });

  it('a zero amount, or no minimum', () => {
    refused([swap(p, WSOL_MINT, { amountIn: 0n })], /swap amount is zero/, c);
    refused([swap(p, WSOL_MINT, { minOut: 0n })], /accepts any price \(no minimum\)/, c);
  });

  it('swap data of the wrong size', () => {
    const ix = swap(p, WSOL_MINT);
    refused([new TransactionInstruction({ programId: CPSWAP, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.from([0])]) })], /a pool instruction other than a swap/, c);
  });
});

describe('refused: anything but one swap, and anything a swap never does', () => {
  const p = pinsFor();
  const c = ctxFor(p);
  it('two swaps, or none', () => {
    refused([swap(p, WSOL_MINT), swap(p, WSOL_MINT)], /exactly one swap in the pool/, c);
    refused([createAta(p.tokenMint, p.tokenProgram)], /exactly one swap in the pool/, c);
  });

  it('a deposit inside a swap', () => {
    const d = depositIx({
      programId: CPSWAP, owner: ME, poolState: p.address, ownerLpToken: p.lpAccount,
      token0Account: mine(p, p.token0Mint), token1Account: mine(p, p.token1Mint), token0Vault: p.vault0, token1Vault: p.vault1,
      vault0Mint: p.token0Mint, vault1Mint: p.token1Mint, lpMint: p.lpMint, lpTokenAmount: 1n, maximumToken0Amount: 1n, maximumToken1Amount: 1n,
    });
    refused([d], /a pool instruction other than a swap/, c);
  });

  it('opening a pool-share account', () => {
    refused([createAta(p.lpMint, TOKEN_PROGRAM_ID), swap(p, WSOL_MINT)], /never opens a pool-share account/, c);
  });

  it('wrapping SOL into a pool that is not paired with SOL', () => {
    const u = pinsFor({ quote: USDC_QUOTE });
    refused([...wrap(1n), swap(u, new PublicKey(USDC_QUOTE.mint))], /this pool is not paired with SOL/, ctxFor(u));
    refused([closeWsol(), swap(u, new PublicKey(USDC_QUOTE.mint))], /this pool is not paired with SOL/, ctxFor(u));
  });

  it('a SOL transfer to anyone but your own wrapped-SOL account', () => {
    refused([SystemProgram.transfer({ fromPubkey: ME, toPubkey: STRANGER, lamports: 1n }), swap(p, WSOL_MINT)], /not your own wrapped-SOL account/, c);
  });

  it('a token transfer, even of your own tokens', () => {
    const move = createTransferCheckedInstruction(mine(p, p.tokenMint), p.tokenMint, associatedTokenAddress(p.tokenMint, STRANGER), ME, 1n, 6);
    refused([move, swap(p, WSOL_MINT)], /a token instruction this page never builds/, c);
  });

  it('a top-level Token-2022 instruction', () => {
    const b = pinsFor({ tokenMint: new PublicKey(BAYLA_QUOTE.mint), tokenProgram: TOKEN_2022_PROGRAM_ID });
    const move = createTransferCheckedInstruction(mine(b, b.tokenMint), b.tokenMint, associatedTokenAddress(b.tokenMint, STRANGER, TOKEN_2022_PROGRAM_ID), ME, 1n, 6, [], TOKEN_2022_PROGRAM_ID);
    refused([move, swap(b, WSOL_MINT)], /a program this page never uses/, ctxFor(b));
  });

  it('the pool authority is the program’s own', () => {
    expect(swap(p, WSOL_MINT).keys[1]!.pubkey.equals(deriveAuthority(CPSWAP))).toBe(true);
  });
});
