// @vitest-environment node
//
// jsdom breaks `PublicKey.findProgramAddressSync` in this repo ("Unable to find a
// viable program address nonce"), and every door below derives a PDA. Same header
// as program.test.ts / ix.test.ts, same reason.
//
// WHAT THIS FILE IS FOR, in one line: proving that the two ways this module can
// quietly hurt someone are both closed.
//
//   1. A MISLABELLED PROGRAM ERROR. The Anchor code table is positional — insert
//      one variant into errors.rs and every code below it shifts, so a hand-written
//      table silently starts telling people the wrong thing about their own money
//      ("still locked" for "pool degraded"). The first block re-derives the table
//      from the Rust source and fails on any drift.
//
//   2. "NOTHING MOVED" SAID ABOUT A TRANSACTION THAT MAY HAVE LANDED. That
//      sentence invites a retry, and a retried `stake` is a second lock of real
//      money for up to four years. The classifier may only say it where it can
//      prove the transaction never reached the network.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { poolPda, stakeVaultPda, rewardVaultPda, ASSOCIATED_TOKEN_PROGRAM_ID, MIN_LOCK_SECS } from './program';
import { createAtaIdempotentIx } from './ix';
import {
  LADDER_ERRORS, anchorCode, classifyWriteError, submitLadder,
  ladderStake, ladderClaim, ladderExit, ladderHatch, ladderClaimCarried,
  type LadderWriteCtx,
} from './write';

const HERE = dirname(fileURLToPath(import.meta.url));
const ERRORS_RS = resolve(HERE, '../../../../solana/tegridy-amm/programs/bayla-ladder/src/errors.rs');
const IDL_JSON = resolve(HERE, '../../../../solana/tegridy-amm/idl/bayla_ladder.json');

const PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const MINT = new PublicKey('8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL');
const OWNER = new PublicKey('Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj');
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const POOL = poolPda(PROGRAM, MINT, 0);
const SIG = '5xTr8Kq9WnQ2vB7hL3mNpYzD4fG6sJ1cA8eR0uX2iO9kP3wS7tV5bN1mZ4yH6gQ8dC2rF';

const poolAccounts = {
  mint: MINT.toBase58(),
  tokenProgram: TOKEN_2022,
  stakeVault: stakeVaultPda(PROGRAM, POOL).toBase58(),
  rewardVault: rewardVaultPda(PROGRAM, POOL).toBase58(),
};

/* ─────────────────────── 1. the table cannot drift ─────────────────────── */

describe('the Anchor error table is derived from the program, not remembered', () => {
  // NOT a conditional skip. A missing errors.rs means this guard is not running,
  // and a guard that is not running must fail loudly rather than pass quietly —
  // that is the whole "unreadable must not read as fine" rule, applied to a test.
  it('can see the program source it claims to check', () => {
    expect(existsSync(ERRORS_RS), `errors.rs not found at ${ERRORS_RS}`).toBe(true);
  });

  const variants = (() => {
    const src = readFileSync(ERRORS_RS, 'utf8');
    const body = /pub enum LadderError\s*\{([\s\S]*?)\n\}/.exec(src);
    if (!body) return [];
    // Every variant is the bare identifier on its own line after its #[msg(...)].
    return [...body[1]!.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm)].map((m) => m[1]!);
  })();

  it('found the enum and it is not empty', () => {
    expect(variants.length).toBeGreaterThan(20);
  });

  it('names every code exactly as the Rust enum orders it, starting at 6000', () => {
    // MUTATION-CHECKED: deleting `WrongTokenProgram` from the table, or inserting a
    // spare entry anywhere above it, fails here — which is precisely the shift a
    // hand-maintained table suffers when somebody adds a variant to errors.rs.
    const derived = Object.fromEntries(variants.map((name, i) => [6000 + i, name]));
    const actual = Object.fromEntries(
      Object.entries(LADDER_ERRORS).map(([code, e]) => [Number(code), e.name]),
    );
    expect(actual).toEqual(derived);
  });

  it('gives every error a staker can actually reach its own sentence', () => {
    // The operator-only variants are allowed to fall back to their name. These are
    // the ones a person pressing a button on the card can produce, and a bare
    // "WalletCapExceeded" in front of a staker is not an explanation.
    for (const code of [6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6020, 6026, 6027]) {
      expect(LADDER_ERRORS[code]?.human, `code ${code} has no human sentence`).toBeTruthy();
    }
  });

  it('agrees with the BUILT IDL too, which is the witness that actually shipped', () => {
    // A SECOND, INDEPENDENT WITNESS. errors.rs is the source; the IDL is what
    // `anchor build` produced from it and what the deployed program answers with. If
    // somebody edits the enum without rebuilding, or rebuilds without editing, the two
    // disagree and this fails — which no single-source check can see.
    expect(existsSync(IDL_JSON), `IDL not found at ${IDL_JSON}`).toBe(true);
    const idl = JSON.parse(readFileSync(IDL_JSON, 'utf8')) as { errors?: { code: number; name: string }[] };
    expect(idl.errors?.length, 'the committed IDL declares no errors').toBeGreaterThan(20);
    const fromIdl = Object.fromEntries((idl.errors ?? []).map((e) => [e.code, e.name]));
    const mine = Object.fromEntries(
      Object.entries(LADDER_ERRORS).map(([code, e]) => [Number(code), e.name]),
    );
    expect(mine).toEqual(fromIdl);
  });

  it('never tells a locked staker the hatch is free', () => {
    // The single most expensive mistake this repo has made about this program: the
    // CLI, the runbook, a memory and a sentence said directly to the owner all had
    // the hatch costing nothing while locked. It costs the same flat 25% as an
    // early exit (lib.rs:607-613), and a `Withdrawn` event on a real 500-token
    // locked position decoded to amount=375, penalty=125.
    const m = LADDER_ERRORS[6007]!.human!;
    expect(m).toMatch(/hatch/i);
    expect(m).toMatch(/25%/);
    expect(m).not.toMatch(/penalty-free|no penalty|free of charge|costs? nothing/i);
  });
});

/* ─────────────────────── 2. reading the code out ─────────────────────── */

describe('anchorCode reads both wire forms', () => {
  it('parses the Anchor-parsed form', () => {
    expect(anchorCode('AnchorError caused by account: position. Error Code: StillLocked. Error Number: 6007. Error Message: x')).toBe(6007);
  });

  it('parses the RAW form, in hex', () => {
    // MUTATION-CHECKED: parsing 0x1777 as decimal yields 1777 and every message
    // downstream becomes the generic fallback — a silent half-dead classifier that
    // still passes any test asserting only "it returns something".
    expect(anchorCode('failed: custom program error: 0x1777')).toBe(6007);
    expect(anchorCode('custom program error: 0x1770')).toBe(6000);
    expect(anchorCode('custom program error: 0x178b')).toBe(6027);
  });

  it('is null when there is no code, rather than 0', () => {
    expect(anchorCode('Network request failed')).toBeNull();
    expect(anchorCode('')).toBeNull();
  });
});

/* ────────── 3. "nothing moved" is a claim, and it needs proof ────────── */

describe('the classifier only promises "nothing moved" when it can prove it', () => {
  it('a declined signature never reached the network', () => {
    const r = classifyWriteError(new Error('User rejected the request.'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/declined/i);
    expect(!r.ok && r.reason).toMatch(/nothing moved/i);
  });

  it('names a program error in the words of the person who pressed the button', () => {
    const r = classifyWriteError(new Error('Error Number: 6026. Error Message: degraded'));
    expect(!r.ok && r.reason).toMatch(/no new stakes/i);
    expect(!r.ok && r.reason).toMatch(/penalty-free/);
  });

  it('an UNKNOWN failure that carries a signature NEVER says nothing moved', () => {
    // ⚠️ THE LOAD-BEARING ASSERTION OF THIS FILE.
    // A signature means it was broadcast. Saying "nothing moved" here invites a
    // retry, and a retried stake is a second four-year lock of real funds.
    // MUTATION-CHECKED: rewriting that branch to the confident wording fails here
    // and nowhere else in the suite.
    const r = classifyWriteError(new Error('block height exceeded'), SIG);
    expect(!r.ok && r.reason).not.toMatch(/nothing moved/i);
    expect(!r.ok && r.reason).toMatch(/unknown/i);
    expect(!r.ok && r.signature).toBe(SIG);
  });

  it('carries the signature so the advice to go and look is actionable', () => {
    const r = classifyWriteError(new Error('timed out'), SIG);
    // MUTATION-CHECKED: dropping `signature` from that branch leaves the sentence
    // reading fine and the advice impossible to follow.
    expect(!r.ok && r.signature).toBe(SIG);
  });

  it('a preflight refusal with no signature MAY say nothing moved', () => {
    const r = classifyWriteError(new Error('Transaction simulation failed: Blockhash not found'));
    expect(!r.ok && r.reason).toMatch(/nothing moved/i);
    expect(!r.ok && r.signature).toBeUndefined();
  });

  it('an unknown failure with NO signature still stops short of promising a negative', () => {
    const r = classifyWriteError(new Error('Failed to fetch'));
    expect(!r.ok && r.reason).not.toMatch(/nothing moved/i);
    expect(!r.ok && r.reason).toMatch(/check it before retrying/i);
  });

  it('explains a SOL shortfall as a SOL shortfall', () => {
    const r = classifyWriteError(new Error('Attempt to debit an account but found no record of a prior credit.'));
    expect(!r.ok && r.reason).toMatch(/SOL/);
    expect(!r.ok && r.reason).toMatch(/rent/i);
  });
});

/* ─────────────────────── 4. submit, end to end ─────────────────────── */

type Status = { err: unknown; confirmationStatus?: string } | null;

function fakeConn(opts: {
  statuses: Status[];
  logs?: string[];
  onStatuses?: () => void;
  throwOnStatuses?: number;
}) {
  let call = 0;
  return {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 })),
    getSignatureStatuses: vi.fn(async () => {
      const i = call++;
      opts.onStatuses?.();
      if (opts.throwOnStatuses === i) throw new Error('RPC 503');
      return { value: [opts.statuses[Math.min(i, opts.statuses.length - 1)] ?? null] };
    }),
    getTransaction: vi.fn(async () => ({ meta: { logMessages: opts.logs ?? [] } })),
  } as unknown as Connection;
}

function fakeWallet(send: (tx: unknown) => Promise<string>, publicKey: PublicKey | null = OWNER) {
  return { publicKey, sendTransaction: vi.fn(send) } as unknown as SignerWalletAdapter;
}

const noSleep = { sleep: async () => {}, now: () => 0, timeoutMs: 60_000 };

// `Transaction.add()` throws "No instructions" on an empty list, so the submit
// cases carry a real one. Any instruction does; this one needs no extra fixtures.
const SOME_IX = [createAtaIdempotentIx({
  payer: OWNER, owner: OWNER, mint: MINT, tokenProgram: new PublicKey(TOKEN_2022),
})];

describe('submitLadder', () => {
  it('returns the signature once the status says confirmed', async () => {
    const conn = fakeConn({ statuses: [{ err: null, confirmationStatus: 'confirmed' }] });
    const r = await submitLadder(conn, fakeWallet(async () => SIG), SOME_IX, noSleep);
    expect(r).toEqual({ ok: true, signature: SIG });
  });

  it('accepts `finalized` as confirmed too', async () => {
    const conn = fakeConn({ statuses: [{ err: null, confirmationStatus: 'finalized' }] });
    const r = await submitLadder(conn, fakeWallet(async () => SIG), SOME_IX, noSleep);
    expect(r.ok).toBe(true);
  });

  it('does NOT treat a failed poll as a failed transaction', async () => {
    // MUTATION-CHECKED: letting the getSignatureStatuses exception escape (or
    // mapping it to 'reverted') turns one RPC hiccup into "your transaction
    // reverted" for a transaction that is landing normally.
    const conn = fakeConn({
      statuses: [null, { err: null, confirmationStatus: 'confirmed' }],
      throwOnStatuses: 0,
    });
    const r = await submitLadder(conn, fakeWallet(async () => SIG), SOME_IX, noSleep);
    expect(r).toEqual({ ok: true, signature: SIG });
  });

  it('asks the chain WHY when it lands and reverts, and names the error', async () => {
    const conn = fakeConn({
      statuses: [{ err: { InstructionError: [1, { Custom: 7 }] }, confirmationStatus: 'confirmed' }],
      logs: ['Program log: AnchorError. Error Number: 6027. Error Message: cap'],
    });
    const r = await submitLadder(conn, fakeWallet(async () => SIG), SOME_IX, noSleep);
    expect(!r.ok && r.reason).toMatch(/per-wallet limit/i);
    expect(!r.ok && r.signature).toBe(SIG);
  });

  it('stays generic rather than wrong when the logs name no code', async () => {
    const conn = fakeConn({
      statuses: [{ err: { InstructionError: [0, 'ProgramFailedToComplete'] }, confirmationStatus: 'confirmed' }],
      logs: ['Program log: something else entirely'],
    });
    const r = await submitLadder(conn, fakeWallet(async () => SIG), SOME_IX, noSleep);
    expect(!r.ok && r.reason).toMatch(/landed on chain and reverted/i);
  });

  it('reports an unconfirmed transaction as unknown, WITH its signature', async () => {
    let t = 0;
    const conn = fakeConn({ statuses: [null] });
    const r = await submitLadder(conn, fakeWallet(async () => SIG), SOME_IX, {
      sleep: async () => { t += 2_000; },
      now: () => t,
      timeoutMs: 6_000,
    });
    expect(!r.ok && r.reason).toMatch(/may still land/i);
    expect(!r.ok && r.reason).not.toMatch(/nothing moved/i);
    expect(!r.ok && r.signature).toBe(SIG);
  });

  it('refuses to build anything without a connected wallet', async () => {
    const conn = fakeConn({ statuses: [] });
    const wallet = fakeWallet(async () => SIG, null);
    const r = await submitLadder(conn, wallet, [], noSleep);
    expect(!r.ok && r.reason).toMatch(/connect a wallet/i);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('sets the fee payer and a fresh blockhash on the transaction it signs', async () => {
    const conn = fakeConn({ statuses: [{ err: null, confirmationStatus: 'confirmed' }] });
    let seen: { feePayer?: PublicKey; recentBlockhash?: string } | null = null;
    await submitLadder(conn, fakeWallet(async (tx) => { seen = tx as never; return SIG; }), SOME_IX, noSleep);
    expect(seen!.feePayer!.toBase58()).toBe(OWNER.toBase58());
    expect(seen!.recentBlockhash).toBe('11111111111111111111111111111111');
  });
});

/* ────────── 5. the account the program will not create for you ────────── */

describe('every door prepends an idempotent ATA create', () => {
  const capture = async (fn: (ctx: LadderWriteCtx) => Promise<unknown>, tokenProgram = TOKEN_2022) => {
    const sent: { keys: { pubkey: PublicKey }[]; programId: PublicKey; data: Buffer }[] = [];
    const conn = fakeConn({ statuses: [{ err: null, confirmationStatus: 'confirmed' }] });
    const wallet = fakeWallet(async (tx) => {
      sent.push(...(tx as { instructions: typeof sent }).instructions);
      return SIG;
    });
    await fn({
      connection: conn, invoker: wallet, programId: PROGRAM, pool: POOL,
      poolAccounts: { ...poolAccounts, tokenProgram }, deps: noSleep,
    });
    return sent;
  };

  // ⚠️ THE PROGRAM WILL NOT CREATE THIS ACCOUNT. `owner_ata` is a plain
  // InterfaceAccount with `mut` on Stake/Claim/WithdrawMatured/EarlyExit/
  // EmergencyWithdraw/ClaimCarried — never `init_if_needed`. A staker who closed
  // their token account while locked cannot claim or exit at all without this.
  // MUTATION-CHECKED: dropping the prepend from any single door fails exactly one
  // of these five, which is why they are five cases and not one loop over a list.
  it('stake', async () => {
    const ix = await capture((c) => ladderStake(c, { positionNonce: 0, amountRaw: 1n, lockSecs: MIN_LOCK_SECS }));
    expect(ix).toHaveLength(2);
    expect(ix[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(Array.from(ix[0]!.data)).toEqual([1]); // CreateIdempotent, not Create
  });

  it('claim', async () => {
    const ix = await capture((c) => ladderClaim(c, { positionNonce: 0 }));
    expect(ix[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  });

  it('exit (both doors)', async () => {
    for (const early of [true, false]) {
      const ix = await capture((c) => ladderExit(c, { positionNonce: 0, early }));
      expect(ix[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    }
  });

  it('hatch', async () => {
    const ix = await capture((c) => ladderHatch(c, { positionNonce: 0 }));
    expect(ix[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  });

  it('claim-carried', async () => {
    const ix = await capture((c) => ladderClaimCarried(c));
    expect(ix[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  });

  it('names the POOL token program in the create, never a hardcoded one', async () => {
    // The ATA address itself is derived from the token program, so assuming legacy
    // SPL on a Token-2022 pool creates the WRONG account and the ladder instruction
    // beside it then fails its owner constraint. BAYLA is Token-2022; the first
    // Streamflow broadcast in this repo died of exactly this assumption.
    const t22 = await capture((c) => ladderClaim(c, { positionNonce: 0 }), TOKEN_2022);
    const legacy = await capture((c) => ladderClaim(c, { positionNonce: 0 }), LEGACY);
    expect(t22[0]!.keys[5]!.pubkey.toBase58()).toBe(TOKEN_2022);
    expect(legacy[0]!.keys[5]!.pubkey.toBase58()).toBe(LEGACY);
    // ...and the account being created differs too, which is the part that bites.
    expect(t22[0]!.keys[1]!.pubkey.toBase58()).not.toBe(legacy[0]!.keys[1]!.pubkey.toBase58());
  });

  it('pays for the account from the staker, and creates it FOR the staker', async () => {
    const ix = await capture((c) => ladderClaim(c, { positionNonce: 0 }));
    expect(ix[0]!.keys[0]!.pubkey.toBase58()).toBe(OWNER.toBase58()); // payer
    expect(ix[0]!.keys[2]!.pubkey.toBase58()).toBe(OWNER.toBase58()); // owner
    expect(ix[0]!.keys[3]!.pubkey.toBase58()).toBe(MINT.toBase58());  // mint
  });

  it('refuses every door without a connected wallet, and signs nothing', async () => {
    const conn = fakeConn({ statuses: [] });
    const wallet = fakeWallet(async () => SIG, null);
    const ctx: LadderWriteCtx = {
      connection: conn, invoker: wallet, programId: PROGRAM, pool: POOL, poolAccounts, deps: noSleep,
    };
    const results = await Promise.all([
      ladderStake(ctx, { positionNonce: 0, amountRaw: 1n, lockSecs: MIN_LOCK_SECS }),
      ladderClaim(ctx, { positionNonce: 0 }),
      ladderExit(ctx, { positionNonce: 0, early: true }),
      ladderHatch(ctx, { positionNonce: 0 }),
      ladderClaimCarried(ctx),
    ]);
    for (const r of results) expect(!r.ok && r.reason).toMatch(/connect a wallet/i);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('addresses the ladder instruction at the ladder program, not the ATA program', async () => {
    // Guards against a copy-paste that puts both instructions on the same program.
    const ix = await capture((c) => ladderStake(c, { positionNonce: 4, amountRaw: 1n, lockSecs: MIN_LOCK_SECS }));
    expect(ix[1]!.programId.toBase58()).toBe(PROGRAM.toBase58());
  });

  it('the ATA create is for THIS wallet, not a remembered one', async () => {
    const other = Keypair.generate().publicKey;
    const sent: { keys: { pubkey: PublicKey }[] }[] = [];
    const conn = fakeConn({ statuses: [{ err: null, confirmationStatus: 'confirmed' }] });
    const wallet = fakeWallet(async (tx) => {
      sent.push(...(tx as { instructions: typeof sent }).instructions);
      return SIG;
    }, other);
    await ladderClaim(
      { connection: conn, invoker: wallet, programId: PROGRAM, pool: POOL, poolAccounts, deps: noSleep },
      { positionNonce: 0 },
    );
    expect(sent[0]!.keys[2]!.pubkey.toBase58()).toBe(other.toBase58());
  });
});
