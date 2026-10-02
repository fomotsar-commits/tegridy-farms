// @vitest-environment node
//
// The instruction-level check: a program allowlist would pass a SOL transfer to a
// stranger (System is allowed) and a token approval (Token is allowed). Each case
// below is a transaction this site never builds, and each must be refused with a
// reason, while the transactions it does build decode into the steps the review shows.
import { describe, it, expect } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createApproveInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  AuthorityType,
  createInitializeMint2Instruction,
} from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, WSOL_MINT, poolStatePda } from '../curve/program';
import { associatedTokenAddress, buyIx, sellIx, updateGlobalIx } from '../curve/ix';
import { deriveObservation, deriveVault } from '../../../solana/cpswap/program';
import { swapBaseInputIx } from '../../../solana/cpswap/ix';
import { computeUnitLimit, decodeIntent, LIGHTHOUSE_PROGRAM_ID, priorityLamports } from './intent';
import { createLaunchInstructions } from './launch';
import { createMetadataV3Ix, metadataPda } from './metaplex';
import { BAYLA_MINT, WORKSHOP_BAYLA_ACCOUNT, WORKSHOP_WALLET, baylaAccountOf, plantInstructions } from './plant';
import { AMM_CONFIG, CPSWAP, LAUNCH, VAULT, cfgLocal, globalValue } from './testkit.fixture';
import type { IntentContext, OpenGate, TxKind } from './types';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const MINT_KP = Keypair.generate();
const MINT = MINT_KP.publicKey;
const CREATOR = Keypair.generate().publicKey;

// A create allows every program but the pool's, so most shape checks run under it;
// swaps run under a pool kind (PROGRAMS_BY_KIND).
const ctx: IntentContext = {
  kind: 'create',
  signer: ME,
  cfg: cfgLocal,
  feeRecipient: VAULT,
  ammConfig: AMM_CONFIG,
  creator: CREATOR,
  mint: MINT,
  maxPriorityLamports: 1_000_000n,
};

const gate = { kind: 'open', cfg: cfgLocal, global: globalValue(), ammConfigAddress: AMM_CONFIG, paused: false } as unknown as OpenGate;

const ids = { programId: LAUNCH, cpSwapProgram: CPSWAP };
const buy = (over: Partial<{ creator: PublicKey; feeRecipient: PublicKey; trader: PublicKey; min: bigint }> = {}) =>
  buyIx(
    { trader: over.trader ?? ME, mint: MINT, feeRecipient: over.feeRecipient ?? VAULT, creator: over.creator ?? CREATOR },
    1_000_000n,
    over.min ?? 10n,
    ids,
  );

const swap = (over: Partial<{ output: PublicKey; min: bigint; pool: PublicKey }> = {}) => {
  const pool = over.pool ?? poolStatePda(MINT, LAUNCH);
  return swapBaseInputIx({
    programId: CPSWAP, payer: ME, ammConfig: AMM_CONFIG, poolState: pool,
    inputTokenAccount: associatedTokenAddress(WSOL_MINT, ME),
    outputTokenAccount: over.output ?? associatedTokenAddress(MINT, ME),
    inputVault: deriveVault(CPSWAP, pool, WSOL_MINT), outputVault: deriveVault(CPSWAP, pool, MINT),
    inputTokenProgram: TOKEN_PROGRAM_ID, outputTokenProgram: TOKEN_PROGRAM_ID,
    inputTokenMint: WSOL_MINT, outputTokenMint: MINT, observationState: deriveObservation(CPSWAP, pool),
    amountIn: 5n, minimumAmountOut: over.min ?? 3n,
  });
};

const poolCtx: IntentContext = { ...ctx, kind: 'pool-buy' };

const refused = (ixs: TransactionInstruction[], why: RegExp, c: IntentContext = ctx) => {
  const r = decodeIntent(ixs, c);
  expect(r.ok, `expected a refusal matching ${why}`).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(why);
};

describe('what this site builds decodes into readable steps', () => {
  it('the create transaction', () => {
    const ixs = createLaunchInstructions(
      gate,
      { creator: ME, mint: MINT_KP, metadata: { name: 'Tegridy', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x' } },
      1_461_600,
      { maxLamportsIn: 7n, minTokensOut: 6n },
      VAULT,
    );
    const r = decodeIntent(ixs, { ...ctx, creator: ME });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => s.kind)).toEqual([
      'create-mint-account', 'init-mint', 'create-metadata', 'create-launch', 'create-token-account', 'curve-buy',
      'plant-burn', 'plant-transfer',
    ]);
    // The plant, read back out of the bytes: from your own $BAYLA account, exact amounts.
    expect(r.steps[6]).toEqual({ kind: 'plant-burn', account: baylaAccountOf(ME), mint: BAYLA_MINT, amount: 50_000_000_000n });
    expect(r.steps[7]).toEqual({
      kind: 'plant-transfer', from: baylaAccountOf(ME), to: WORKSHOP_BAYLA_ACCOUNT, mint: BAYLA_MINT, amount: 50_000_000_000n,
    });
    const meta = r.steps[2];
    expect(meta).toMatchObject({ kind: 'create-metadata', name: 'Tegridy', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x' });
    expect(r.steps[5]).toMatchObject({ kind: 'curve-buy', maxLamportsIn: 7n, minTokensOut: 6n });
    // The platform reserve's destination, derived from the chain-read fee recipient.
    expect(r.steps[3]).toEqual({
      kind: 'create-launch',
      mint: MINT,
      feeRecipient: VAULT,
      treasuryToken: associatedTokenAddress(MINT, VAULT),
    });
  });

  it('a buy, a sell and a pool swap', () => {
    expect(decodeIntent([buy()], { ...ctx, kind: 'buy' }).ok).toBe(true);
    expect(
      decodeIntent([sellIx({ trader: ME, mint: MINT, feeRecipient: VAULT, creator: CREATOR }, 3n, 2n, ids)], { ...ctx, kind: 'sell' }).ok,
    ).toBe(true);
    const r = decodeIntent([swap()], poolCtx);
    expect(r.ok && r.steps[0]).toMatchObject({ kind: 'pool-swap', amountIn: 5n, minimumAmountOut: 3n });
  });
});

describe('refused: moving value anywhere but the signer', () => {
  it('a SOL transfer to a stranger', () => {
    refused([SystemProgram.transfer({ fromPubkey: ME, toPubkey: STRANGER, lamports: 1 })], /not your own wrapped-SOL/);
  });
  it('a SOL transfer from someone else', () => {
    refused([SystemProgram.transfer({ fromPubkey: STRANGER, toPubkey: associatedTokenAddress(WSOL_MINT, ME), lamports: 1 })], /from someone other than you/);
  });
  it('a token transfer, an approval, an authority change', () => {
    const mine = associatedTokenAddress(MINT, ME);
    refused([createTransferInstruction(mine, STRANGER, ME, 1n)], /never builds/);
    refused([createApproveInstruction(mine, STRANGER, ME, 1n)], /never builds/);
    refused([createSetAuthorityInstruction(mine, ME, AuthorityType.AccountOwner, STRANGER)], /never builds/);
  });
  it('closing the WSOL account into a stranger’s wallet', () => {
    refused([createCloseAccountInstruction(associatedTokenAddress(WSOL_MINT, ME), STRANGER, ME)], /pays someone else/);
  });
  it('closing an account that is not the WSOL account', () => {
    refused([createCloseAccountInstruction(associatedTokenAddress(MINT, ME), ME, ME)], /not your wrapped-SOL/);
  });
  it('a pool swap paying out to someone else (cp-swap does not check the output owner)', () => {
    refused([swap({ output: associatedTokenAddress(MINT, STRANGER) })], /pays out to an account that is not yours/, poolCtx);
  });
  it('a pool swap against a squatted standard-address pool', () => {
    refused([swap({ pool: Keypair.generate().publicKey })], /different pool/, poolCtx);
  });
});

describe('refused: wrong parties or no price limit', () => {
  it('a buy paying the fee to someone other than global.fee_recipient', () => {
    refused([buy({ feeRecipient: STRANGER })], /wrong accounts/);
  });
  it('a buy naming a creator other than curve.creator', () => {
    refused([buy({ creator: STRANGER })], /wrong accounts/);
  });
  it('a buy for someone else', () => {
    refused([buy({ trader: STRANGER })], /wrong accounts/);
  });
  it('a buy or swap with a zero minimum', () => {
    refused([buy({ min: 0n })], /any price/);
    refused([swap({ min: 0n })], /any price/, poolCtx);
  });
  it('a trade with no creator read off the launch', () => {
    refused([buy()], /no creator/, { ...ctx, creator: undefined });
  });
});

// Reserve at create (2026-09-26): create_launch pays the platform reserve to
// ATA(mint, global.fee_recipient). The receiver is read from chain into the context;
// a transaction that names any other receiver, or the old 8-account shape, is refused.
describe('refused: a platform reserve paid anywhere but the treasury', () => {
  const launchIxOf = (feeRecipient: PublicKey) =>
    createLaunchInstructions(
      gate,
      { creator: ME, mint: MINT_KP, metadata: { name: 'Tegridy', symbol: 'TGD', uri: 'https://ipfs.io/ipfs/x' } },
      1_461_600,
      null,
      feeRecipient,
    )[3]!;

  it('a create_launch naming another fee recipient', () => {
    refused([launchIxOf(STRANGER)], /platform reserve receiver other than the treasury/);
  });
  it('a create_launch naming the treasury but another token account for the reserve', () => {
    const ix = launchIxOf(VAULT);
    const keys = ix.keys.map((k, i) => (i === 9 ? { ...k, pubkey: associatedTokenAddress(MINT, STRANGER) } : k));
    refused([new TransactionInstruction({ programId: ix.programId, keys, data: ix.data })], /wrong accounts/);
  });
  it('the old 8-account create_launch (reserve held until graduation)', () => {
    const ix = launchIxOf(VAULT);
    const keys = [...ix.keys.slice(0, 8), ix.keys[11]!];
    refused([new TransactionInstruction({ programId: ix.programId, keys, data: ix.data })], /wrong accounts/);
  });
});

describe('refused: a program this KIND of transaction never calls', () => {
  it('a create never reaches the pool program', () => {
    refused([swap()], /this kind of transaction never uses/);
  });
  it('a pool swap never reaches Token Metadata or the launch program', () => {
    const meta = createMetadataV3Ix({ metadata: metadataPda(MINT), mint: MINT, mintAuthority: ME, payer: ME, updateAuthority: ME, name: 'A', symbol: 'AB', uri: 'https://x' });
    refused([swap(), meta], /this kind of transaction never uses/, poolCtx);
    refused([swap(), buy()], /this kind of transaction never uses/, poolCtx);
  });
  it('a curve trade never reaches the System or Token program', () => {
    refused([buy(), SystemProgram.transfer({ fromPubkey: ME, toPubkey: associatedTokenAddress(WSOL_MINT, ME), lamports: 1 })], /this kind of transaction never uses/, { ...ctx, kind: 'buy' });
  });
  it('a graduation is the launch program alone', () => {
    refused([buy()], /no creator|this kind|wrong/, { ...ctx, kind: 'migrate', creator: undefined });
    refused([swap()], /this kind of transaction never uses/, { ...ctx, kind: 'migrate' });
  });
});

// The plant (island ruling 2): Token-2022 is allowed for a create ONLY, and only as
// these two shapes: burn 50,000 $BAYLA from your own $BAYLA account, and send 50,000
// to the island's Workshop. Every other Token-2022 instruction is refused.
describe('the plant: exactly two Token-2022 shapes, in a create only', () => {
  const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const MINE = baylaAccountOf(ME);
  const [burnIx, giveIx] = plantInstructions(ME);
  const burnOf = (o: Partial<{ from: PublicKey; mint: PublicKey; owner: PublicKey; amount: bigint; decimals: number; signers: PublicKey[]; program: PublicKey }> = {}) =>
    createBurnCheckedInstruction(o.from ?? MINE, o.mint ?? BAYLA_MINT, o.owner ?? ME, o.amount ?? 50_000_000_000n, o.decimals ?? 6, o.signers ?? [], o.program ?? T22);
  const giveOf = (o: Partial<{ from: PublicKey; mint: PublicKey; to: PublicKey; owner: PublicKey; amount: bigint; decimals: number; signers: PublicKey[]; program: PublicKey }> = {}) =>
    createTransferCheckedInstruction(o.from ?? MINE, o.mint ?? BAYLA_MINT, o.to ?? WORKSHOP_BAYLA_ACCOUNT, o.owner ?? ME, o.amount ?? 50_000_000_000n, o.decimals ?? 6, o.signers ?? [], o.program ?? T22);

  it('the builders here are the plant’s own bytes, and they decode', () => {
    expect(burnOf().data.equals(burnIx.data)).toBe(true);
    expect(giveOf().data.equals(giveIx.data)).toBe(true);
    const r = decodeIntent([burnOf(), giveOf()], ctx);
    expect(r.ok && r.steps.map((s) => s.kind)).toEqual(['plant-burn', 'plant-transfer']);
  });

  // This page builds a Token-2022 transfer itself (the Workshop's half), so the refusal
  // names what is refused, never "a transfer this page never builds".
  it('a third Token-2022 instruction', () => {
    const why = /a Token-2022 instruction other than the plant's own burn and transfer \(such as an approval or another transfer\)/;
    refused([burnIx, giveIx, createTransferInstruction(MINE, WORKSHOP_BAYLA_ACCOUNT, ME, 1n, [], T22)], why);
    refused([burnIx, giveIx, createApproveInstruction(MINE, STRANGER, ME, 1n, [], T22)], why);
  });

  it('a second burn, or a second transfer', () => {
    refused([burnIx, burnIx, giveIx], /plants more than once/);
    refused([burnIx, giveIx, giveIx], /plants more than once/);
  });

  it('the Workshop’s half sent to any other account', () => {
    for (const to of [
      associatedTokenAddress(BAYLA_MINT, WORKSHOP_WALLET), // the legacy-program derivation (G2JTfW…)
      WORKSHOP_WALLET,
      baylaAccountOf(STRANGER),
      MINE,
    ]) {
      refused([burnIx, giveOf({ to })], /somewhere other than the island's Workshop/);
    }
  });

  it('a different amount, either half', () => {
    for (const amount of [49_999_999_999n, 50_000_000_001n, 100_000_000_000n, 0n]) {
      refused([burnOf({ amount }), giveIx], /burns a different amount/);
      refused([burnIx, giveOf({ amount })], /sends a different amount/);
    }
  });

  it('wrong decimals', () => {
    refused([burnOf({ decimals: 9 }), giveIx], /decimals/);
    refused([burnIx, giveOf({ decimals: 0 })], /decimals/);
  });

  it('a mint other than $BAYLA', () => {
    const other = Keypair.generate().publicKey;
    refused([burnOf({ mint: other }), giveIx], /other than \$BAYLA/);
    refused([burnIx, giveOf({ mint: other })], /other than \$BAYLA/);
  });

  it('from an account that is not your own $BAYLA account', () => {
    refused([burnOf({ from: baylaAccountOf(STRANGER) }), giveIx], /not your \$BAYLA account/);
    refused([burnIx, giveOf({ from: baylaAccountOf(STRANGER) })], /not your \$BAYLA account/);
  });

  it('a different authority', () => {
    refused([burnOf({ owner: STRANGER }), giveIx], /someone other than you/);
    refused([burnIx, giveOf({ owner: STRANGER })], /someone other than you/);
  });

  it('a multisig signer tail', () => {
    const signer = Keypair.generate().publicKey;
    refused([burnOf({ signers: [signer] }), giveIx], /accounts, expected 3/);
    refused([burnIx, giveOf({ signers: [signer] })], /accounts, expected 4/);
  });

  it('a stray byte on either instruction', () => {
    const pad = (ix: TransactionInstruction) => new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.from([0])]) });
    refused([pad(burnIx), giveIx], /wrong size/);
    refused([burnIx, pad(giveIx)], /wrong size/);
  });

  it('the same shapes under the legacy token program are not the plant', () => {
    refused([burnOf({ program: TOKEN_PROGRAM_ID }), giveIx], /token instruction this page never builds/);
  });

  it('Token-2022 in any kind of transaction but a create', () => {
    for (const kind of ['buy', 'sell', 'migrate', 'pool-buy', 'pool-sell'] as TxKind[]) {
      refused([burnIx], /this kind of transaction never uses/, { ...ctx, kind });
      refused([giveIx], /this kind of transaction never uses/, { ...ctx, kind });
    }
  });
});

describe('refused: token shapes this site never makes', () => {
  it('token details that stay editable', () => {
    const ix = createMetadataV3Ix({ metadata: metadataPda(MINT), mint: MINT, mintAuthority: ME, payer: ME, updateAuthority: ME, name: 'A', symbol: 'AB', uri: 'https://x' });
    const d = Uint8Array.from(ix.data);
    d[d.length - 2] = 1;
    refused([new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.from(d) })], /could be changed/);
  });
  it('token details controlled by someone else', () => {
    refused(
      [createMetadataV3Ix({ metadata: metadataPda(MINT), mint: MINT, mintAuthority: ME, payer: ME, updateAuthority: STRANGER, name: 'A', symbol: 'AB', uri: 'https://x' })],
      /controlled by someone else/,
    );
  });
  it('token details whose optional seventh account is not the rent sysvar', () => {
    const ix = createMetadataV3Ix({ metadata: metadataPda(MINT), mint: MINT, mintAuthority: ME, payer: ME, updateAuthority: ME, name: 'A', symbol: 'AB', uri: 'https://x' });
    expect(ix.keys).toHaveLength(7);
    expect(decodeIntent([ix], ctx).ok).toBe(true);
    const keys = ix.keys.map((k, i) => (i === 6 ? { ...k, pubkey: STRANGER } : k));
    refused([new TransactionInstruction({ programId: ix.programId, keys, data: ix.data })], /unexpected extra account/);
  });
  it('a mint that keeps a freeze authority, or a different decimals', () => {
    refused([createInitializeMint2Instruction(MINT, 6, ME, ME)], /freeze authority/);
    refused([createInitializeMint2Instruction(MINT, 9, ME, null)], /6 decimals/);
  });
  it('an admin instruction to the launch program', () => {
    refused([updateGlobalIx({ authority: ME }, { paused: true }, ids)], /never builds/);
  });
  it('an unknown program', () => {
    refused([new TransactionInstruction({ programId: STRANGER, keys: [], data: Buffer.alloc(0) })], /never uses/);
  });
});

describe('fees and wallet guards', () => {
  it('a priority fee above the cap is refused; at the cap it passes', () => {
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const atCap = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000n }); // 5e6 * 2e5 / 1e6 = 1e6
    expect(priorityLamports(5_000_000n, 200_000)).toBe(1_000_000n);
    expect(decodeIntent([limit, atCap, buy()], ctx).ok).toBe(true);
    refused([limit, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_001n }), buy()], /priority fee/);
  });
  it('with NO unit limit, the fee is judged at the runtime default: 200,000 per instruction up to 1,400,000', () => {
    // A price that is exactly at the cap for 200,000 units...
    const atCapFor200k = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000n });
    // ...on a transaction with two instructions and no limit is charged on 400,000
    // units: 2,000,000 lamports, twice the cap. A wallet that strips our limit
    // instruction must not get that past the check.
    refused([atCapFor200k, buy(), buy()], /priority fee/);
    const many = Array.from({ length: 9 }, () => buy());
    expect(computeUnitLimit([atCapFor200k, ...many], [])).toBe(1_400_000);
    expect(computeUnitLimit([atCapFor200k, buy()], [])).toBe(200_000);
    expect(computeUnitLimit([buy()], [{ kind: 'compute-limit', units: 70_000 }])).toBe(70_000);
  });
  it('setting the fee twice is refused', () => {
    const p = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n });
    refused([p, p, buy()], /more than once/);
  });
  it('a Lighthouse guard instruction passes ONLY for a wallet-returned transaction', () => {
    const guard = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
    refused([buy(), guard], /never uses/);
    expect(decodeIntent([buy(), guard], ctx, { allowWalletGuards: true }).ok).toBe(true);
  });
});
