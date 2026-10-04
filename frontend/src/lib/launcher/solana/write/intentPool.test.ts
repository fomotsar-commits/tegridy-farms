// @vitest-environment node
//
// Adding and removing liquidity, read back out of the bytes (spec 3.3). The pool
// instruction is judged against PoolPins, the pool as prepare read and checked it:
// every account that decides where value comes from or goes to must be the pin, the
// signer's own account under that mint's program, or a fixed program. Each case
// changes ONE thing, so deleting the check that guards it lets the transaction through.
//
// The launch-program kinds are pinned, unedited, in intent.test.ts.
import { describe, it, expect } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeMint2Instruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { deriveLpMint, deriveObservation, deriveVault, sortMints } from '../../../solana/cpswap/program';
import { depositIx, swapBaseInputIx, withdrawIx } from '../../../solana/cpswap/ix';
import { LIGHTHOUSE_PROGRAM_ID, PROGRAMS_BY_KIND, decodeIntent, isPoolIntent } from './intent';
import { AMM_CONFIG, CPSWAP, VAULT, cfgLocal } from './testkit.fixture';
import type { IntentContext, PoolIntent, PoolPins } from './types';
import { SOL_QUOTE } from '../../../solana/lp/quotes';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const fresh = () => Keypair.generate().publicKey;

/** A pool's pins, derived the way poolPins() derives them. */
function pinsFor(o: { tokenProgram?: PublicKey; lpAccount?: PublicKey } = {}): PoolPins {
  const address = fresh();
  const tokenMint = fresh();
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
  const quoteIsToken0 = token0.equals(WSOL_MINT);
  const lpMint = deriveLpMint(CPSWAP, address);
  return {
    address,
    ammConfig: AMM_CONFIG,
    origin: 'standard',
    token0Mint: token0,
    token1Mint: token1,
    token0Program: quoteIsToken0 ? TOKEN_PROGRAM_ID : tokenProgram,
    token1Program: quoteIsToken0 ? tokenProgram : TOKEN_PROGRAM_ID,
    vault0: deriveVault(CPSWAP, address, token0),
    vault1: deriveVault(CPSWAP, address, token1),
    lpMint,
    observation: deriveObservation(CPSWAP, address),
    tokenMint,
    tokenProgram,
    quote: SOL_QUOTE,
    quoteIsToken0,
    lpAccount: o.lpAccount ?? associatedTokenAddress(lpMint, ME, TOKEN_PROGRAM_ID),
  };
}

const ctxFor = (kind: PoolIntent['kind'], pins: PoolPins): PoolIntent => ({
  kind,
  signer: ME,
  cfg: cfgLocal,
  maxPriorityLamports: 1_000_000n,
  pins,
});

const mine = (mint: PublicKey, program: PublicKey) => associatedTokenAddress(mint, ME, program);

function common(p: PoolPins) {
  return {
    programId: CPSWAP,
    owner: ME,
    poolState: p.address,
    token0Account: mine(p.token0Mint, p.token0Program),
    token1Account: mine(p.token1Mint, p.token1Program),
    token0Vault: p.vault0,
    token1Vault: p.vault1,
    vault0Mint: p.token0Mint,
    vault1Mint: p.token1Mint,
    lpMint: p.lpMint,
  };
}

const deposit = (p: PoolPins, o: Partial<{ lp: bigint; max0: bigint; max1: bigint }> = {}) =>
  depositIx({
    ...common(p),
    ownerLpToken: mine(p.lpMint, TOKEN_PROGRAM_ID),
    lpTokenAmount: o.lp ?? 1_000n,
    maximumToken0Amount: o.max0 ?? 5_000n,
    maximumToken1Amount: o.max1 ?? 7_000n,
  });

const withdraw = (p: PoolPins, o: Partial<{ lp: bigint; min0: bigint; min1: bigint }> = {}) =>
  withdrawIx({
    ...common(p),
    ownerLpToken: p.lpAccount,
    lpTokenAmount: o.lp ?? 1_000n,
    minimumToken0Amount: o.min0 ?? 5n,
    minimumToken1Amount: o.min1 ?? 7n,
  });

const createAta = (mint: PublicKey, program: PublicKey, o: Partial<{ address: PublicKey; owner: PublicKey }> = {}) =>
  createAssociatedTokenAccountIdempotentInstruction(
    ME,
    o.address ?? associatedTokenAddress(mint, o.owner ?? ME, program),
    o.owner ?? ME,
    mint,
    program,
  );

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
  expect(r.ok, `expected a refusal matching ${why}`).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(why);
};

const U64_MAX = 0xffff_ffff_ffff_ffffn;

describe('what this site builds for liquidity decodes into one readable step', () => {
  it('a deposit: wrap, open the pool-share account, deposit, close the wrapped SOL', () => {
    const p = pinsFor();
    const c = ctxFor('lp-deposit', p);
    const wsol = mine(WSOL_MINT, TOKEN_PROGRAM_ID);
    const steps = ok(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        createAta(WSOL_MINT, TOKEN_PROGRAM_ID),
        SystemProgram.transfer({ fromPubkey: ME, toPubkey: wsol, lamports: 9_000 }),
        createSyncNativeInstruction(wsol),
        createAta(p.lpMint, TOKEN_PROGRAM_ID),
        deposit(p),
        createCloseAccountInstruction(wsol, ME, ME),
      ],
      c,
    );
    expect(steps.map((s) => s.kind)).toEqual([
      'compute-limit', 'create-token-account', 'wrap-sol', 'sync-wsol', 'create-token-account', 'pool-deposit', 'close-wsol',
    ]);
    expect(steps[5]).toEqual({ kind: 'pool-deposit', pool: p.address, lpAmount: 1_000n, max0: 5_000n, max1: 7_000n });
  });

  it('a withdrawal: open both payout accounts, withdraw, close the wrapped SOL', () => {
    const p = pinsFor();
    const c = ctxFor('lp-withdraw', p);
    const steps = ok(
      [
        createAta(p.tokenMint, p.tokenProgram),
        createAta(WSOL_MINT, TOKEN_PROGRAM_ID),
        withdraw(p),
        createCloseAccountInstruction(mine(WSOL_MINT, TOKEN_PROGRAM_ID), ME, ME),
      ],
      c,
    );
    expect(steps.map((s) => s.kind)).toEqual(['create-token-account', 'create-token-account', 'pool-withdraw', 'close-wsol']);
    expect(steps[2]).toEqual({ kind: 'pool-withdraw', pool: p.address, lpAccount: p.lpAccount, lpAmount: 1_000n, min0: 5n, min1: 7n });
  });

  it('a withdrawal from a pool-share account that is not an associated account pins THAT account', () => {
    const own = fresh();
    const p = pinsFor({ lpAccount: own });
    const steps = ok([withdraw(p)], ctxFor('lp-withdraw', p));
    expect(steps[0]).toMatchObject({ kind: 'pool-withdraw', lpAccount: own });
    refused([withKey(withdraw(p), 3, mine(p.lpMint, TOKEN_PROGRAM_ID))], /not the one checked/, ctxFor('lp-withdraw', p));
  });

  it('a Token-2022 token: its accounts are the ones seeded under Token-2022', () => {
    const p = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    ok([createAta(p.tokenMint, TOKEN_2022_PROGRAM_ID), withdraw(p)], ctxFor('lp-withdraw', p));
    ok([deposit(p)], ctxFor('lp-deposit', p));
  });

  it('the two kinds are pool intents; the launch-program kinds are not', () => {
    const p = pinsFor();
    expect(isPoolIntent(ctxFor('lp-deposit', p))).toBe(true);
    expect(isPoolIntent(ctxFor('lp-withdraw', p))).toBe(true);
    expect(
      isPoolIntent({ kind: 'pool-buy', signer: ME, cfg: cfgLocal, feeRecipient: VAULT, ammConfig: AMM_CONFIG, mint: fresh(), maxPriorityLamports: 1n }),
    ).toBe(false);
  });
});

describe('refused: a deposit slot that is not the checked pool’s, or not yours', () => {
  const p = pinsFor();
  const c = ctxFor('lp-deposit', p);

  it.each([
    [0, fresh(), /deposit is paid by someone else/],
    [1, fresh(), /deposit names the wrong pool authority/],
    [2, fresh(), /deposit goes into a different pool than the one checked/],
    [3, associatedTokenAddress(p.lpMint, STRANGER), /pool shares go to an account that is not yours/],
    [4, associatedTokenAddress(p.token0Mint, STRANGER, p.token0Program), /deposit spends from an account that is not yours/],
    [5, associatedTokenAddress(p.token1Mint, STRANGER, p.token1Program), /deposit spends from an account that is not yours/],
    [6, fresh(), /deposit names the wrong pool vault/],
    [7, fresh(), /deposit names the wrong pool vault/],
    [8, TOKEN_2022_PROGRAM_ID, /deposit names the wrong token program/],
    [9, TOKEN_PROGRAM_ID, /deposit names the wrong token program/],
    [10, fresh(), /deposit names the wrong token\./],
    [11, fresh(), /deposit names the wrong token\./],
    [12, fresh(), /deposit names the wrong pool-share token/],
  ] as const)('slot %i replaced', (slot, pubkey, why) => {
    ok([deposit(p)], c);
    refused([withKey(deposit(p), slot, pubkey)], why, c);
  });

  it('the token side spending from a classic-seeded account of a Token-2022 token is refused', () => {
    const t = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const slot = t.quoteIsToken0 ? 5 : 4;
    refused([withKey(deposit(t), slot, associatedTokenAddress(t.tokenMint, ME))], /spends from an account that is not yours/, ctxFor('lp-deposit', t));
  });

  it('a deposit with an account missing or one too many', () => {
    const ix = deposit(p);
    refused([new TransactionInstruction({ programId: ix.programId, keys: ix.keys.slice(0, 12), data: ix.data })], /12 accounts, expected 13/, c);
    refused([new TransactionInstruction({ programId: ix.programId, keys: [...ix.keys, ix.keys[0]!], data: ix.data })], /14 accounts, expected 13/, c);
  });
});

describe('refused: a withdrawal slot that is not the checked pool’s, or pays out to anyone else', () => {
  const p = pinsFor();
  const c = ctxFor('lp-withdraw', p);

  it.each([
    [0, fresh(), /withdrawal is signed for by someone else/],
    [1, fresh(), /withdrawal names the wrong pool authority/],
    [2, fresh(), /withdrawal comes out of a different pool than the one checked/],
    [3, fresh(), /takes pool shares from an account that is not the one checked/],
    [4, fresh(), /withdrawal pays out to an account that is not yours/],
    [5, fresh(), /withdrawal pays out to an account that is not yours/],
    [6, fresh(), /withdrawal names the wrong pool vault/],
    [7, fresh(), /withdrawal names the wrong pool vault/],
    [8, TOKEN_2022_PROGRAM_ID, /withdrawal names the wrong token program/],
    [9, TOKEN_PROGRAM_ID, /withdrawal names the wrong token program/],
    [10, fresh(), /withdrawal names the wrong token\./],
    [11, fresh(), /withdrawal names the wrong token\./],
    [12, fresh(), /withdrawal names the wrong pool-share token/],
    [13, fresh(), /withdrawal names the wrong memo program/],
  ] as const)('slot %i replaced', (slot, pubkey, why) => {
    ok([withdraw(p)], c);
    refused([withKey(withdraw(p), slot, pubkey)], why, c);
  });

  // withdraw.rs checks only the MINT of slots 4 and 5, so a stranger's account for
  // the right mint would be paid. These two pins are all that stops it.
  it('slots 4 and 5 set to a stranger’s account for the right mint', () => {
    refused([withKey(withdraw(p), 4, associatedTokenAddress(p.token0Mint, STRANGER, p.token0Program))], /pays out to an account that is not yours/, c);
    refused([withKey(withdraw(p), 5, associatedTokenAddress(p.token1Mint, STRANGER, p.token1Program))], /pays out to an account that is not yours/, c);
  });

  it('a payout to the classic-seeded address of a Token-2022 token is refused; the Token-2022-seeded one is accepted', () => {
    const t = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const ct = ctxFor('lp-withdraw', t);
    const slot = t.quoteIsToken0 ? 5 : 4;
    refused([withKey(withdraw(t), slot, associatedTokenAddress(t.tokenMint, ME))], /pays out to an account that is not yours/, ct);
    ok([withKey(withdraw(t), slot, associatedTokenAddress(t.tokenMint, ME, TOKEN_2022_PROGRAM_ID))], ct);
  });

  it('a withdrawal without the memo program (13 accounts) is refused', () => {
    const ix = withdraw(p);
    refused([new TransactionInstruction({ programId: ix.programId, keys: ix.keys.slice(0, 13), data: ix.data })], /13 accounts, expected 14/, c);
  });
});

describe('refused: amounts with no limit, or nothing to do', () => {
  it('a deposit for zero pool shares', () => {
    const p = pinsFor();
    refused([deposit(p, { lp: 0n })], /asks for zero pool shares/, ctxFor('lp-deposit', p));
  });
  it('a deposit with a zero maximum on either side', () => {
    const p = pinsFor();
    refused([deposit(p, { max0: 0n })], /zero limit on one side/, ctxFor('lp-deposit', p));
    refused([deposit(p, { max1: 0n })], /zero limit on one side/, ctxFor('lp-deposit', p));
  });
  it('a deposit whose maximum is u64::MAX (no limit) on either side; one below it is accepted', () => {
    const p = pinsFor();
    const c = ctxFor('lp-deposit', p);
    refused([deposit(p, { max0: U64_MAX })], /accepts any price \(no limit\)/, c);
    refused([deposit(p, { max1: U64_MAX })], /accepts any price \(no limit\)/, c);
    ok([deposit(p, { max0: U64_MAX - 1n, max1: U64_MAX - 1n })], c);
  });
  it('a withdrawal for zero pool shares, or with a zero minimum on either side', () => {
    const p = pinsFor();
    const c = ctxFor('lp-withdraw', p);
    refused([withdraw(p, { lp: 0n })], /asks for zero pool shares/, c);
    refused([withdraw(p, { min0: 0n })], /accepts any payout \(no minimum\)/, c);
    refused([withdraw(p, { min1: 0n })], /accepts any payout \(no minimum\)/, c);
  });
  it('pool instruction data of the wrong size', () => {
    const p = pinsFor();
    const ix = deposit(p);
    const longer = new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.from([0])]) });
    refused([longer], /a pool instruction other than a deposit/, ctxFor('lp-deposit', p));
  });
});

describe('refused: anything but one pool instruction of the kind’s own type', () => {
  const p = pinsFor();
  const dep = ctxFor('lp-deposit', p);
  const wd = ctxFor('lp-withdraw', p);
  const swap = () =>
    swapBaseInputIx({
      programId: CPSWAP, payer: ME, ammConfig: AMM_CONFIG, poolState: p.address,
      inputTokenAccount: mine(WSOL_MINT, TOKEN_PROGRAM_ID), outputTokenAccount: mine(p.tokenMint, p.tokenProgram),
      inputVault: deriveVault(CPSWAP, p.address, WSOL_MINT), outputVault: deriveVault(CPSWAP, p.address, p.tokenMint),
      inputTokenProgram: TOKEN_PROGRAM_ID, outputTokenProgram: p.tokenProgram,
      inputTokenMint: WSOL_MINT, outputTokenMint: p.tokenMint, observationState: p.observation,
      amountIn: 5n, minimumAmountOut: 3n,
    });

  it('two deposits in one transaction', () => {
    refused([deposit(p), deposit(p)], /exactly one deposit/, dep);
  });
  it('no deposit at all', () => {
    refused([createAta(p.lpMint, TOKEN_PROGRAM_ID)], /exactly one deposit/, dep);
  });
  it('two withdrawals, or none', () => {
    refused([withdraw(p), withdraw(p)], /exactly one withdrawal/, wd);
    refused([createAta(p.tokenMint, p.tokenProgram)], /exactly one withdrawal/, wd);
  });
  it('a swap inside a deposit or a withdrawal', () => {
    refused([swap(), deposit(p)], /a pool instruction other than a deposit/, dep);
    refused([withdraw(p), swap()], /a pool instruction other than a withdrawal/, wd);
  });
  it('a deposit inside a withdrawal, and a withdrawal inside a deposit', () => {
    refused([deposit(p)], /a pool instruction other than a withdrawal/, wd);
    refused([withdraw(p)], /a pool instruction other than a deposit/, dep);
  });
});

describe('refused: every other program and shape in a liquidity transaction', () => {
  const p = pinsFor();
  const dep = ctxFor('lp-deposit', p);
  const wd = ctxFor('lp-withdraw', p);

  it('each kind may call only its own programs', () => {
    expect([...PROGRAMS_BY_KIND['lp-deposit']].sort()).toEqual(['ata', 'compute', 'pool', 'system', 'token']);
    expect([...PROGRAMS_BY_KIND['lp-withdraw']].sort()).toEqual(['ata', 'compute', 'pool', 'token']);
  });

  it('the System program inside a withdrawal, even wrapping your own SOL', () => {
    const wrap = SystemProgram.transfer({ fromPubkey: ME, toPubkey: mine(WSOL_MINT, TOKEN_PROGRAM_ID), lamports: 1 });
    refused([wrap, withdraw(p)], /this kind of transaction never uses/, wd);
    ok([wrap, deposit(p)], dep);
  });

  it('a top-level Token-2022 instruction inside a deposit', () => {
    const t = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const move = createTransferCheckedInstruction(
      mine(t.tokenMint, TOKEN_2022_PROGRAM_ID), t.tokenMint, STRANGER, ME, 1n, 6, [], TOKEN_2022_PROGRAM_ID,
    );
    refused([move, deposit(t)], /a program this page never uses/, ctxFor('lp-deposit', t));
  });

  it('creating an account, or a new token, inside a liquidity transaction', () => {
    const create = SystemProgram.createAccount({ fromPubkey: ME, newAccountPubkey: fresh(), lamports: 1, space: 82, programId: TOKEN_PROGRAM_ID });
    refused([create, deposit(p)], /never creates an account/, dep);
    refused([createInitializeMint2Instruction(fresh(), 6, ME, null), deposit(p)], /never creates a token/, dep);
    refused([createInitializeMint2Instruction(fresh(), 6, ME, null), withdraw(p)], /never creates a token/, wd);
  });

  it('a Lighthouse guard passes only on the transaction a wallet hands back', () => {
    const guard = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
    refused([deposit(p), guard], /never uses/, dep);
    expect(decodeIntent([deposit(p), guard], dep, { allowWalletGuards: true }).ok).toBe(true);
  });
});

describe('the token accounts a liquidity transaction may open', () => {
  const p = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
  const dep = ctxFor('lp-deposit', p);
  const wd = ctxFor('lp-withdraw', p);

  it('accepted: wrapped SOL and the pool shares under the classic program, the token under its own', () => {
    ok([createAta(WSOL_MINT, TOKEN_PROGRAM_ID), createAta(p.lpMint, TOKEN_PROGRAM_ID), deposit(p)], dep);
    ok([createAta(p.tokenMint, TOKEN_2022_PROGRAM_ID), withdraw(p)], wd);
  });

  it('refused: the token under the other program, at either program’s address', () => {
    refused([createAta(p.tokenMint, TOKEN_PROGRAM_ID), withdraw(p)], /under the wrong programs/, wd);
    const atOther = createAta(p.tokenMint, TOKEN_2022_PROGRAM_ID, { address: associatedTokenAddress(p.tokenMint, ME, TOKEN_PROGRAM_ID) });
    refused([atOther, withdraw(p)], /at the wrong address/, wd);
  });

  it('refused: the pool shares or wrapped SOL under Token-2022', () => {
    refused([createAta(p.lpMint, TOKEN_2022_PROGRAM_ID), deposit(p)], /under the wrong programs/, dep);
    refused([createAta(WSOL_MINT, TOKEN_2022_PROGRAM_ID), deposit(p)], /under the wrong programs/, dep);
  });

  it('refused: a mint outside the three', () => {
    refused([createAta(fresh(), TOKEN_PROGRAM_ID), deposit(p)], /unrelated token/, dep);
  });

  it('refused: for someone else, under the wrong system program, or at another address', () => {
    refused([createAta(p.lpMint, TOKEN_PROGRAM_ID, { owner: STRANGER }), deposit(p)], /for someone else/, dep);
    refused([withKey(createAta(p.lpMint, TOKEN_PROGRAM_ID), 4, fresh()), deposit(p)], /under the wrong programs/, dep);
    refused([createAta(p.lpMint, TOKEN_PROGRAM_ID, { address: fresh() }), deposit(p)], /at the wrong address/, dep);
    expect(SYSTEM_PROGRAM_ID.equals(createAta(p.lpMint, TOKEN_PROGRAM_ID).keys[4]!.pubkey)).toBe(true);
  });
});
