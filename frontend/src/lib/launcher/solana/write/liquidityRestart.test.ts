// @vitest-environment node
//
// Restarting an almost empty pool at the market price (restart.ts, `prepareLpRestart`),
// against a fake chain whose simulator runs every instruction of the transaction IN ORDER:
// the wrap, the top-ups into the pool's vaults, the pool program's own deposit and
// withdrawal maths (ceiling in, floor out, 6005 past a limit), and the close. Then the very
// transaction that was built is run again on a pool someone moved first, and must fail.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { IX_DEPOSIT, IX_WITHDRAW, POOL_STATE_OFFSETS, decodePoolState, deriveAuthority } from '../../../solana/cpswap/program';
import { lpTokensToTradingTokens } from '../../../solana/cpswap/math';
import { NEARLY_EMPTY } from '../../../solana/lp/poolHealth';
import { planRestart } from '../../../solana/lp/restart';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { decodeIntent } from './intent';
import { LP_COPY, prepareLpDeposit, prepareLpRestart, type LpPrepareReads } from './liquidity';
import { CPSWAP, EXT, FakeChain, addPool, cfgLocal, legacyTx, openAccount, rent, setClock, simInstructions, tokenFeeOnChain, tokenFeeTaken, u64le, type PoolFixture, type SimHandler } from './testkit.fixture';
import { poolInverseFee } from '../../../solana/lp/transferFee';
import type { IntentStep, LpDepositSummary, LpOpenGate, PoolIntent, PreparedTx, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
// The dead SOL / TBB pool on mainnet (6tNCdz…AA5AA, 2026-11-26): 18 lamports, 567 units, the locked 100 shares.
const DEAD = { sol: 18n, tokens: 567n, lpSupply: 100n };
const TBB_PER_LAMPORT = 39.83;
const SOL_PER_TOKEN = 1e6 / TBB_PER_LAMPORT / 1e9;
const priced = (solPerToken = SOL_PER_TOKEN): LpPrepareReads => ({ outsidePrice: async () => ({ kind: 'ok', solPerToken, source: 'Jupiter' }) });
const answering = (o: OutsidePrice): LpPrepareReads => ({ outsidePrice: async () => o });
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];

// ── the simulator: every instruction, in order ───────────────────────────────

const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
function amountAt(c: FakeChain, k: PublicKey): bigint | null {
  const a = c.accounts.get(k.toBase58());
  return !a || a.data.length < 72 ? null : u64At(a.data, 64);
}
const fail = (ix: number, code: number) => ({ err: { InstructionError: [ix, { Custom: code }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 60_000 });
const startsWith = (d: Uint8Array, disc: Uint8Array) => disc.every((b, i) => d[i] === b);

const restartSim: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const ixs = simInstructions(vtx);
  const bal = new Map<string, bigint>();
  const get = (k: PublicKey) => bal.get(k.toBase58()) ?? amountAt(chain, k) ?? 0n;
  const put = (k: PublicKey, v: bigint) => bal.set(k.toBase58(), v);
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  let signer = 0;
  let closed = false;
  let supply: bigint | null = null;
  for (const [i, ix] of ixs.entries()) {
    if (ix.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const o = openAccount(chain, ix.accounts[1]!, ix.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165);
      signer -= o.paid;
      if (ix.accounts[1]!.equals(wsolAta) && amountAt(chain, wsolAta) === null) put(wsolAta, BigInt(o.lamports - rent(165)));
    } else if (ix.program.equals(SYSTEM_PROGRAM_ID)) {
      const v = u64At(ix.data, 4);
      signer -= Number(v);
      put(wsolAta, get(wsolAta) + v);
    } else if (ix.program.equals(TOKEN_PROGRAM_ID) || ix.program.equals(TOKEN_2022_PROGRAM_ID)) {
      if (ix.data[0] === 9) {
        signer += Number(get(wsolAta)) + rent(165);
        closed = true;
      } else if (ix.data[0] === 12) {
        const [from, mint, to] = [ix.accounts[0]!, ix.accounts[1]!, ix.accounts[2]!];
        const v = u64At(ix.data, 1);
        if (get(from) < v) return { err: { InstructionError: [i, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
        put(from, get(from) - v);
        put(to, get(to) + v - tokenFeeTaken(chain, mint, v));
      }
    } else if (ix.program.equals(CPSWAP)) {
      const poolKey = ix.accounts[2]!;
      const state = decodePoolState(poolKey.toBase58(), chain.accounts.get(poolKey.toBase58())!.data)!;
      const S: bigint = supply ?? state.lpSupply;
      const [v0, v1] = [new PublicKey(state.token0Vault), new PublicKey(state.token1Vault)];
      const [u0, u1, lpAcc] = [ix.accounts[4]!, ix.accounts[5]!, ix.accounts[3]!];
      const [m0, m1] = [new PublicKey(state.token0Mint), new PublicKey(state.token1Mint)];
      const [lp, b0, b1] = [u64At(ix.data, 8), u64At(ix.data, 16), u64At(ix.data, 24)];
      if (startsWith(ix.data, IX_DEPOSIT)) {
        const c = lpTokensToTradingTokens(lp, S, get(v0), get(v1), 'ceiling');
        if (!c || c.token0Amount === 0n || c.token1Amount === 0n) return fail(i, 6006);
        // A side's transfer fee goes on top of what the pool takes (deposit.rs).
        const fee0 = poolInverseFee(tokenFeeOnChain(chain, m0), c.token0Amount) ?? 0n;
        const fee1 = poolInverseFee(tokenFeeOnChain(chain, m1), c.token1Amount) ?? 0n;
        if (c.token0Amount + fee0 > b0 || c.token1Amount + fee1 > b1) return fail(i, 6005);
        if (get(u0) < c.token0Amount + fee0 || get(u1) < c.token1Amount + fee1) return { err: { InstructionError: [i, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
        put(u0, get(u0) - c.token0Amount - fee0);
        put(u1, get(u1) - c.token1Amount - fee1);
        put(v0, get(v0) + c.token0Amount);
        put(v1, get(v1) + c.token1Amount);
        put(lpAcc, get(lpAcc) + lp);
        supply = S + lp;
      } else if (startsWith(ix.data, IX_WITHDRAW)) {
        const o = lpTokensToTradingTokens(lp, S, get(v0), get(v1), 'floor');
        if (!o || o.token0Amount === 0n || o.token1Amount === 0n) return fail(i, 6006);
        const got0 = o.token0Amount - tokenFeeTaken(chain, m0, o.token0Amount);
        const got1 = o.token1Amount - tokenFeeTaken(chain, m1, o.token1Amount);
        if (got0 < b0 || got1 < b1) return fail(i, 6005);
        if (get(lpAcc) < lp) return { err: { InstructionError: [i, { Custom: 2506 }] }, logs: [], unitsConsumed: 1 };
        put(v0, get(v0) - o.token0Amount);
        put(v1, get(v1) - o.token1Amount);
        put(u0, get(u0) + got0);
        put(u1, get(u1) + got1);
        put(lpAcc, get(lpAcc) - lp);
        supply = S - lp;
      } else return { err: 'not a liquidity instruction', logs: [], unitsConsumed: 1 };
    }
  }
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 120_000 };
  const changes: Parameters<FakeChain['post']>[1] = { [ME.toBase58()]: { lamportsDelta: signer } };
  for (const [k, v] of bal) {
    const acc = chain.accounts.get(k);
    // An account opened by this transaction has no data yet: its mint is the world's.
    const mint = acc && acc.data.length >= 32 ? new PublicKey(acc.data.subarray(0, 32)) : newAccountMints.get(k);
    changes[k] = k === wsolAta.toBase58() && closed ? { closed: true } : { tokenAmount: v, mint, owner: ME };
  }
  return { err: null, logs: [], unitsConsumed: 120_000, accounts: chain.post(config.accounts.addresses, changes) };
};

/** The mints of the signer's accounts a transaction may open, by address (set by `world`). */
let newAccountMints = new Map<string, PublicKey>();

// ── the world ────────────────────────────────────────────────────────────────

interface World {
  chain: FakeChain;
  mint: PublicKey;
  pool: PoolFixture;
  tokenAta: PublicKey;
  lpAta: PublicKey;
  wsolAta: PublicKey;
}

function world(o: { lpSupply?: bigint; sol?: bigint; tokens?: bigint; tokenProgram?: PublicKey; heldTokens?: bigint; wallet?: bigint } = {}): World {
  const chain = FakeChain.healthy();
  chain.simulate = restartSim;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(mint, METADATA_ONLY, { decimals: 6 });
  else chain.mint(mint, { decimals: 6 });
  const pool = addPool(chain, mint, { sol: o.sol ?? DEAD.sol, tokens: o.tokens ?? DEAD.tokens, lpSupply: o.lpSupply ?? DEAD.lpSupply, tokenProgram });
  setClock(chain, NOW);
  chain.fund(ME, Number(o.wallet ?? 20n * 10n ** 9n));
  const tokenAta = associatedTokenAddress(mint, ME, tokenProgram);
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenAta, mint, ME, o.heldTokens ?? 10_000n * 10n ** 6n);
  else chain.tokenAccount(tokenAta, mint, ME, o.heldTokens ?? 10_000n * 10n ** 6n);
  const lpAta = associatedTokenAddress(pool.lpMint, ME);
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  newAccountMints = new Map([
    [tokenAta.toBase58(), mint],
    [lpAta.toBase58(), pool.lpMint],
    [wsolAta.toBase58(), WSOL_MINT],
  ]);
  return { chain, mint, pool, tokenAta, lpAta, wsolAta };
}

const args = (w: World, o: Partial<Parameters<typeof prepareLpRestart>[3]> = {}) => ({
  owner: ME,
  pool: w.pool.address,
  tokenMint: w.mint,
  quoteMint: WSOL_MINT,
  driving: 'quote' as const,
  maxIn: 100_000_000n,
  slippageBps: 100n,
  shownOtherMax: null,
  ...o,
});
const restart = (w: World, o: Partial<Parameters<typeof prepareLpRestart>[3]> = {}, reads: LpPrepareReads = priced()) => prepareLpRestart(W(w.chain), OPEN, reads, args(w, o));
function ok(r: Awaited<ReturnType<typeof restart>>): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}
function refused(r: Awaited<ReturnType<typeof restart>>): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  return r.outcome.message;
}
const body = (p: PreparedTx) => p.steps.filter((s) => s.kind !== 'compute-limit' && s.kind !== 'compute-price');
const kinds = (p: PreparedTx) => body(p).map((s) => s.kind);

/** The transaction that was test-run, run again on the chain as it is now. */
const rerun = (w: World) => restartSim(w.chain.simulateCalls.at(-1)!.vtx, undefined, w.chain);

/** Someone else's own deposit of `lp` shares at the pool's price as it stands. */
function dilute(w: World, lp: bigint) {
  const authority = deriveAuthority(CPSWAP);
  const key = w.pool.address.toBase58();
  const acc = w.chain.accounts.get(key)!;
  const S = u64At(acc.data, POOL_STATE_OFFSETS.lpSupply);
  const r0 = amountAt(w.chain, w.pool.vault0)!;
  const r1 = amountAt(w.chain, w.pool.vault1)!;
  const c = lpTokensToTradingTokens(lp, S, r0, r1, 'ceiling')!;
  const data = new Uint8Array(acc.data);
  data.set(u64le(S + lp), POOL_STATE_OFFSETS.lpSupply);
  w.chain.set(w.pool.address, { ...acc, data });
  w.chain.tokenAccount(w.pool.vault0, w.pool.token0, authority, r0 + c.token0Amount);
  w.chain.tokenAccount(w.pool.vault1, w.pool.token1, authority, r1 + c.token1Amount);
}

describe('prepareLpRestart: a dead pool, set to the market price', () => {
  it('tops up, adds and checks back, in that order, and says so on the review', async () => {
    const w = world();
    const p = ok(await restart(w));
    expect(p.kind).toBe('lp-restart');
    const order = kinds(p).filter((k) => k === 'pool-topup' || k === 'pool-deposit' || k === 'pool-withdraw');
    expect(order.at(-2)).toBe('pool-deposit');
    expect(order.at(-1)).toBe('pool-withdraw');
    expect(order.slice(0, -2).every((k) => k === 'pool-topup')).toBe(true);
    const s = p.summary as LpDepositSummary;
    expect(s.kind).toBe('lp-deposit');
    const want = planRestart(
      { pool: { lpSupply: 100n } as never, vault0Amount: 0n, vault1Amount: 0n, reserve0: w.pool.quoteIsToken0 ? DEAD.sol : DEAD.tokens, reserve1: w.pool.quoteIsToken0 ? DEAD.tokens : DEAD.sol },
      { quoteIsToken0: w.pool.quoteIsToken0, quoteDecimals: 9, tokenDecimals: 6, perToken: SOL_PER_TOKEN, driving: 'quote', maxIn: 100_000_000n, bps: 100n, availableQuote: null, availableToken: null },
    );
    if ('problem' in want) throw new Error('expected a plan');
    const [tq, tt] = w.pool.quoteIsToken0 ? [want.topUpSent0, want.topUpSent1] : [want.topUpSent1, want.topUpSent0];
    expect(s.restart).toMatchObject({ topUp: { quote: tq, token: tt }, keep: want.keep, checkLp: want.check.lp, perToken: SOL_PER_TOKEN });
    // Each top-up goes into its own coin's vault of this pool.
    const ups = body(p).filter((x): x is Extract<IntentStep, { kind: 'pool-topup' }> => x.kind === 'pool-topup');
    for (const u of ups) expect(u.vault.equals(u.mint.equals(w.pool.token0) ? w.pool.vault0 : w.pool.vault1)).toBe(true);
    // The pool's old price is not a warning: the restart sets it.
    expect(s.warnings).toEqual([]);
    expect(s.priceGap).toBeNull();
  });

  it('the transaction as built fails on a pool someone added to first, at the check-back', async () => {
    const w = world();
    ok(await restart(w));
    expect(rerun(w).err).toBeNull();
    dilute(w, 1_000n);
    const r = rerun(w);
    // The check-back is the last pool instruction: the deposit's maxima passed it.
    const ixs = simInstructions(w.chain.simulateCalls.at(-1)!.vtx);
    const checkAt = ixs.findIndex((ix) => ix.program.equals(CPSWAP) && startsWith(ix.data, IX_WITHDRAW));
    expect(r.err).toEqual({ InstructionError: [checkAt, { Custom: 6005 }] });
  });

  it('the transaction as built fails on a pool someone sent coins into first, at the deposit', async () => {
    const w = world();
    ok(await restart(w));
    w.chain.tokenAccount(w.pool.tokenVault, w.mint, deriveAuthority(CPSWAP), DEAD.tokens + 1_000n);
    const ixs = simInstructions(w.chain.simulateCalls.at(-1)!.vtx);
    const depositAt = ixs.findIndex((ix) => ix.program.equals(CPSWAP) && startsWith(ix.data, IX_DEPOSIT));
    expect(rerun(w).err).toEqual({ InstructionError: [depositAt, { Custom: 6005 }] });
  });

  it('an ordinary add still refuses the same pool, as almost empty', async () => {
    const w = world();
    const r = await prepareLpDeposit(W(w.chain), OPEN, priced(), args(w));
    expect(refused(r)).toContain(NEARLY_EMPTY);
  });

  it('is never built without a market price read: the pool stays refused, as almost empty', async () => {
    const w = world();
    expect(refused(await restart(w, {}, answering({ kind: 'unread', detail: 'Jupiter did not answer' })))).toContain(NEARLY_EMPTY);
    expect(refused(await restart(w, {}, answering({ kind: 'no-route', detail: 'no route' })))).toContain(NEARLY_EMPTY);
  });

  it('is not built while anyone holds a share of the pool: it stays refused, as almost empty', async () => {
    const w = world({ lpSupply: 1_100n });
    expect(refused(await restart(w))).toContain(NEARLY_EMPTY);
  });

  it('is not built for a pool that takes ordinary deposits again', async () => {
    const w = world({ lpSupply: 1_000_000_000n, sol: 10n ** 10n, tokens: 4n * 10n ** 11n });
    expect(refused(await restart(w))).toBe(LP_COPY.restartNotNeeded);
  });

  it('refuses an amount too small to restart, naming the least that is not', async () => {
    const w = world();
    expect(refused(await restart(w, { maxIn: 20_000n }))).toMatch(/^Too small to restart this pool\. Put in at least 0\.0000\d+ SOL\.$/);
  });

  it('tops up a Token-2022 token under its own program, and the checker takes it', async () => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const p = ok(await restart(w));
    const tx = legacyTx(p);
    const up = tx.instructions.find((ix) => ix.data[0] === 12 && ix.keys[1]!.pubkey.equals(w.mint));
    expect(up?.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});

// ── the checker holds a restart to its shape ─────────────────────────────────

describe('decodeIntent: a restart in any other shape is blocked', () => {
  async function built() {
    const w = world();
    const p = ok(await restart(w));
    const ixs = legacyTx(p).instructions;
    const ctx = p.check.intent as PoolIntent;
    return { w, ixs, ctx };
  }
  const isPool = (d: Uint8Array) => (ix: TransactionInstruction) => ix.programId.equals(CPSWAP) && startsWith(ix.data, d);
  const isTopUp = (ix: TransactionInstruction) => ix.data[0] === 12;

  it('passes as built', async () => {
    const { ixs, ctx } = await built();
    expect(decodeIntent(ixs, ctx).ok).toBe(true);
  });

  it('without its check-back', async () => {
    const { ixs, ctx } = await built();
    const r = decodeIntent(ixs.filter((ix) => !isPool(IX_WITHDRAW)(ix)), ctx);
    expect(!r.ok && r.reason).toMatch(/does not take exactly one check-back/);
  });

  it('with its check-back before the deposit', async () => {
    const { ixs, ctx } = await built();
    const dep = ixs.findIndex(isPool(IX_DEPOSIT));
    const chk = ixs.findIndex(isPool(IX_WITHDRAW));
    const swapped = [...ixs];
    [swapped[dep], swapped[chk]] = [swapped[chk]!, swapped[dep]!];
    const r = decodeIntent(swapped, ctx);
    expect(!r.ok && r.reason).toMatch(/check-back out before the deposit/);
  });

  it('with a top-up after the deposit', async () => {
    const { ixs, ctx } = await built();
    const up = ixs.findIndex(isTopUp);
    const moved = [...ixs.slice(0, up), ...ixs.slice(up + 1)];
    moved.splice(moved.findIndex(isPool(IX_DEPOSIT)) + 1, 0, ixs[up]!);
    const r = decodeIntent(moved, ctx);
    expect(!r.ok && r.reason).toMatch(/tops up the pool after the deposit/);
  });

  it('with a top-up sent anywhere but the pool’s own vault for that coin', async () => {
    const { w, ixs, ctx } = await built();
    const up = ixs.findIndex(isTopUp);
    const k = ixs[up]!.keys.map((x) => ({ ...x }));
    const otherVault = k[2]!.pubkey.equals(w.pool.vault0) ? w.pool.vault1 : w.pool.vault0;
    for (const to of [Keypair.generate().publicKey, otherVault]) {
      const bad = [...ixs];
      bad[up] = { ...ixs[up]!, keys: k.map((x, i) => (i === 2 ? { ...x, pubkey: to } : x)) } as TransactionInstruction;
      const r = decodeIntent(bad, ctx);
      expect(!r.ok && r.reason).toMatch(/the top-up goes somewhere other than this pool’s own vault/);
    }
  });

  it('a transfer in an ordinary add', async () => {
    const { ixs, ctx } = await built();
    const r = decodeIntent(ixs.filter((ix) => !isPool(IX_WITHDRAW)(ix)), { ...ctx, kind: 'lp-deposit' });
    expect(!r.ok && r.reason).toMatch(/a token instruction this page never builds/);
  });
});
