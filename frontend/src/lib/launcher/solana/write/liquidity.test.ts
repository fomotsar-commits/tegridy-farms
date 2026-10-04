// @vitest-environment node
//
// Adding and removing liquidity (spec 3.1-3.10), against a fake chain whose
// simulator runs the pool program's own maths on its accounts. The leave rule is the
// point of half of these: removing liquidity prepares while every fact that refuses
// a deposit holds.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  IX_DEPOSIT,
  IX_WITHDRAW,
  POOL_STATUS_DISABLE_DEPOSIT,
  POOL_STATUS_DISABLE_SWAP,
  POOL_STATUS_DISABLE_WITHDRAW,
  decodePoolState,
} from '../../../solana/cpswap/program';
import { lpTokensToTradingTokens } from '../../../solana/cpswap/math';
import { spendableSol } from '../../../solana/lp/liquidityMath';
import { estimatedLoss } from '../../../solana/lp/opening';
import { assessPool } from '../../../solana/lp/poolHealth';
import { BUILDABLE_EXTENSIONS, EXTENSION, classifyToken } from '../../../solana/lp/tokenSafety';
import { observationBytes } from '../../../solana/lp/testkit.fixture';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from './metaplex';
import {
  LP_COPY,
  LP_FEE_RESERVE,
  POOL_READ_FAILED,
  accountCheck,
  depositStepsProblem,
  poolPins,
  prepareLpDeposit,
  prepareLpWithdraw,
  readPoolForWrite,
  tokenAccountSize,
  withdrawStepsProblem,
  type LpPrepareReads,
  type WriteSnapshot,
} from './liquidity';
import { TX_SIZE_LIMIT } from './prepare';
import {
  CPSWAP,
  EXT,
  FakeChain,
  addPool,
  beforeBalanceRun,
  cfgLocal,
  openAccount,
  rent,
  setClock,
  skewTestRun,
  type PoolFixture,
  type SimHandler,
} from './testkit.fixture';
import type { LpOpenGate, PreparedTx, WriteRpc, LpDepositSummary, LpWithdrawSummary, IntentStep } from './types';
import { SOL_QUOTE } from '../../../solana/lp/quotes';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const WITHDRAW_ONLY: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'withdraw-only' };
const SOL_RESERVE = 10n * 10n ** 9n;
const TOKEN_RESERVE = 1_000n * 10n ** 6n; // 0.01 SOL per token at 6 decimals
const LP_SUPPLY = 1_000_000_000n;
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];

const priced = (solPerToken = 0.01): LpPrepareReads => ({ outsidePrice: async () => ({ kind: 'ok', solPerToken, source: 'Jupiter' }) });
const answering = (o: OutsidePrice): LpPrepareReads => ({ outsidePrice: async () => o });
const NO_ROUTE: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };

/** The body length each Token-2022 mint extension needs to decode (the two name ones); any other is opaque here. */
const extensionOf = (type: number): [number, number] => [type, type === EXTENSION.MetadataPointer ? 64 : type === EXTENSION.TokenMetadata ? 76 : 8];
/** A Token-2022 mint's extra beyond its name and picture. */
const withExtra = (type: number): Array<[number, number]> => [extensionOf(type), ...METADATA_ONLY];

function str(s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  return [b.length & 255, (b.length >> 8) & 255, 0, 0, ...b];
}
/** Gives the token a Metaplex name record (key 4), immutable. */
function nameToken(chain: FakeChain, mint: PublicKey, name: string, symbol: string): void {
  const data = Uint8Array.from([4, ...Keypair.generate().publicKey.toBytes(), ...mint.toBytes(), ...str(name), ...str(symbol), ...str('https://x.test/a.json'), 0, 0, 0, 0, 0]);
  chain.set(metadataPda(mint), { lamports: 1, owner: METAPLEX_TOKEN_METADATA_ID, data });
}

const NO_MARKET_DEPOSIT =
  'Jupiter has no market price for this token, so this pool’s price was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.';
const COPY_DEPOSIT =
  'It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of this pool.';
const FREEZE_DEPOSIT =
  'Its creator can freeze the vault of this pool, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.';
const AMOUNTS =
  'The amount a wallet displays for this token changes over time. This site shows and moves raw token units, so check the amounts against your wallet before you sign.';

// ── the simulator: the pool program's own maths on the fake chain ─────────────

function amountAt(c: FakeChain, k: PublicKey): bigint | null {
  const a = c.accounts.get(k.toBase58());
  if (!a || a.data.length < 72) return null;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

const fail = (code: number) => ({ err: { InstructionError: [3, { Custom: code }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 40_000 });

/** Runs cp-swap's deposit / withdraw maths on the chain's accounts and reports the watched post-state. */
const lpSimulator: SimHandler = (vtx: VersionedTransaction, config, chain) => {
  const keys = vtx.message.staticAccountKeys;
  const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  const pool = ixs.find((i) => i.program.equals(CPSWAP));
  if (!pool) return { err: 'no pool instruction', logs: [], unitsConsumed: 1 };
  const d = pool.data;
  const u64 = (o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
  const isDeposit = IX_DEPOSIT.every((b, i) => d[i] === b);
  const isWithdraw = IX_WITHDRAW.every((b, i) => d[i] === b);
  const [lp, b0, b1] = [u64(8), u64(16), u64(24)];
  const poolKey = pool.accounts[2]!;
  const state = decodePoolState(poolKey.toBase58(), chain.accounts.get(poolKey.toBase58())!.data)!;
  const R0 = amountAt(chain, new PublicKey(state.token0Vault))!;
  const R1 = amountAt(chain, new PublicKey(state.token1Vault))!;
  const solIs0 = state.token0Mint === WSOL_MINT.toBase58();
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  const userTok = pool.accounts[solIs0 ? 5 : 4]!;
  const userLp = pool.accounts[3]!;
  // What the signer pays to open accounts: a full deposit each, or only the top-up for an
  // address that already holds SOL someone sent it.
  const paidToOpen = ixs
    .filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    .reduce((n, i) => n + openAccount(chain, i.accounts[1]!, i.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165).paid, 0);
  const wrapped = ixs.filter((i) => i.program.equals(SYSTEM_PROGRAM_ID)).reduce((n, i) => n + new DataView(i.data.buffer, i.data.byteOffset, i.data.byteLength).getBigUint64(4, true), 0n);
  const closes = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
  // Both kinds open the wrapped-SOL account first. Opened over lamports already there, it
  // starts with those above its deposit as balance.
  const wsolLamports = openAccount(chain, wsolAta).lamports;
  const wsolBefore = amountAt(chain, wsolAta) ?? BigInt(wsolLamports - rent(165));
  const tokBefore = amountAt(chain, userTok) ?? 0n;
  const lpBefore = amountAt(chain, userLp) ?? 0n;

  let solMoved: bigint;
  let tokMoved: bigint;
  if (isDeposit) {
    const c = lpTokensToTradingTokens(lp, state.lpSupply, R0, R1, 'ceiling');
    if (!c || c.token0Amount === 0n || c.token1Amount === 0n) return fail(6006);
    if (c.token0Amount > b0 || c.token1Amount > b1) return fail(6005);
    if (tokBefore < (solIs0 ? c.token1Amount : c.token0Amount)) return { err: { InstructionError: [3, { Custom: 1 }] }, logs: [], unitsConsumed: 1 };
    solMoved = -(solIs0 ? c.token0Amount : c.token1Amount);
    tokMoved = -(solIs0 ? c.token1Amount : c.token0Amount);
  } else if (isWithdraw) {
    const o = lpTokensToTradingTokens(lp, state.lpSupply, R0, R1, 'floor');
    if (!o || o.token0Amount === 0n || o.token1Amount === 0n) return fail(6006);
    if (o.token0Amount < b0 || o.token1Amount < b1) return fail(6005);
    if (lpBefore < lp) return { err: { InstructionError: [3, { Custom: 2506 }] }, logs: [], unitsConsumed: 1 };
    solMoved = solIs0 ? o.token0Amount : o.token1Amount;
    tokMoved = solIs0 ? o.token1Amount : o.token0Amount;
  } else {
    return { err: 'not a liquidity instruction', logs: [], unitsConsumed: 1 };
  }
  if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 60_000 };

  const wsolAfter = wsolBefore + wrapped + solMoved;
  // The close hands back every lamport in the account.
  const signerDelta = -Number(wrapped) - paidToOpen + (closes ? wsolLamports + Number(wrapped + solMoved) : 0);
  const changes: Parameters<FakeChain['post']>[1] = {
    [ME.toBase58()]: { lamportsDelta: signerDelta },
    [userTok.toBase58()]: { tokenAmount: tokBefore + tokMoved, mint: new PublicKey(solIs0 ? state.token1Mint : state.token0Mint), owner: ME },
    [userLp.toBase58()]: { tokenAmount: lpBefore + (isDeposit ? lp : -lp), mint: new PublicKey(state.lpMint), owner: ME },
    [wsolAta.toBase58()]: closes ? { closed: true } : { tokenAmount: wsolAfter, mint: WSOL_MINT, owner: ME },
  };
  return { err: null, logs: [], unitsConsumed: 60_000, accounts: chain.post(config.accounts.addresses, changes) };
};

// ── the world ────────────────────────────────────────────────────────────────

interface World {
  chain: FakeChain;
  mint: PublicKey;
  pool: PoolFixture;
  tokenProgram: PublicKey;
  tokenAta: PublicKey;
  lpAta: PublicKey;
  wsolAta: PublicKey;
}

function world(o: {
  tokenProgram?: PublicKey;
  mintExtensions?: Array<[number, number]>;
  mintDecimals?: number;
  /** The decimals the POOL records for the token (default 6). */
  poolDecimals?: number;
  freezeAuthority?: PublicKey;
  sol?: bigint;
  tokens?: bigint;
  lpSupply?: bigint;
  status?: number;
  openTime?: bigint;
  launch?: boolean;
  enableCreatorFee?: boolean;
  frozenTokenVault?: boolean;
  wallet?: bigint;
  heldTokens?: bigint | null;
  heldLp?: bigint;
  heldWsol?: bigint;
  record?: Parameters<typeof addPool>[2]['record'];
} = {}): World {
  const chain = FakeChain.healthy();
  chain.simulate = lpSimulator;
  const mint = Keypair.generate().publicKey;
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const mintOpts = { decimals: o.mintDecimals ?? 6, freezeAuthority: o.freezeAuthority };
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(mint, o.mintExtensions ?? METADATA_ONLY, mintOpts);
  else chain.mint(mint, mintOpts);
  const pool = addPool(chain, mint, {
    sol: o.sol ?? SOL_RESERVE,
    tokens: o.tokens ?? TOKEN_RESERVE,
    lpSupply: o.lpSupply ?? LP_SUPPLY,
    status: o.status,
    openTime: o.openTime,
    launch: o.launch,
    enableCreatorFee: o.enableCreatorFee,
    tokenProgram,
    frozenTokenVault: o.frozenTokenVault,
    record: o.record,
    ...(o.poolDecimals === undefined ? {} : { tokenDecimals: o.poolDecimals }),
  });
  setClock(chain, NOW);
  chain.fund(ME, Number(o.wallet ?? 20n * 10n ** 9n));
  const tokenAta = associatedTokenAddress(mint, ME, tokenProgram);
  const held = o.heldTokens === undefined ? 10_000n * 10n ** 6n : o.heldTokens;
  if (held !== null) {
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenAta, mint, ME, held);
    else chain.tokenAccount(tokenAta, mint, ME, held);
  }
  const lpAta = associatedTokenAddress(pool.lpMint, ME);
  if (o.heldLp !== undefined) chain.tokenAccount(lpAta, pool.lpMint, ME, o.heldLp);
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  if (o.heldWsol !== undefined) chain.tokenAccount(wsolAta, WSOL_MINT, ME, o.heldWsol);
  return { chain, mint, pool, tokenProgram, tokenAta, lpAta, wsolAta };
}

const depositArgs = (w: World, o: Partial<Parameters<typeof prepareLpDeposit>[3]> = {}) => ({
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

const withdrawArgs = (w: World, o: Partial<Parameters<typeof prepareLpWithdraw>[2]> = {}) => ({
  owner: ME,
  pool: w.pool.address,
  tokenMint: w.mint,
  quoteMint: WSOL_MINT,
  lpAccount: w.lpAta,
  pctBps: 5_000n,
  slippageBps: 100n,
  ...o,
});

async function deposit(w: World, o: Partial<Parameters<typeof prepareLpDeposit>[3]> = {}, reads: LpPrepareReads = priced(), gate: LpOpenGate = OPEN) {
  return prepareLpDeposit(W(w.chain), gate, reads, depositArgs(w, o));
}

async function withdraw(w: World, o: Partial<Parameters<typeof prepareLpWithdraw>[2]> = {}, gate: LpOpenGate = OPEN) {
  return prepareLpWithdraw(W(w.chain), gate, withdrawArgs(w, o));
}

function ok(r: Awaited<ReturnType<typeof deposit>>): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}

function refused(r: Awaited<ReturnType<typeof deposit>>): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
  return r.outcome.message;
}

/** A position worth withdrawing: the wallet holds 10% of the pool's shares. */
const holding = (o: Parameters<typeof world>[0] = {}) => world({ heldLp: LP_SUPPLY / 10n, ...o });

// ── the single read ──────────────────────────────────────────────────────────

describe('readPoolForWrite: one read for the maths', () => {
  it('reads the 13 maths keys in ONE call, then only the config account and three rents', async () => {
    const w = world({ heldLp: 5n });
    const asked: string[][] = [];
    const orig = w.chain.getMultipleAccountsInfo;
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      asked.push(keys.map((k) => k.toBase58()));
      return orig(keys);
    };
    const snap = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote: SOL_QUOTE, owner: ME })) as WriteSnapshot;
    expect(typeof snap).toBe('object');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(13);
    expect(asked[0]).toEqual(expect.arrayContaining([w.pool.address, w.pool.vault0, w.pool.vault1, w.pool.lpMint, w.pool.observation, w.mint, ME, w.tokenAta, w.wsolAta, w.lpAta].map((k) => k.toBase58())));
    expect(w.chain.calls.filter((c) => c === 'getMultipleAccountsInfo')).toHaveLength(1);
    expect(w.chain.calls.filter((c) => c === 'getAccountInfo')).toHaveLength(1);
    expect(w.chain.calls.filter((c) => c === 'getMinimumBalanceForRentExemption')).toHaveLength(3);
    expect(snap.view.snapshot.reserve0 + snap.view.snapshot.reserve1).toBe(SOL_RESERVE + TOKEN_RESERVE);
    // A SOL pool: the wrapped-SOL account is a classic one, so its rent is the 165 read, with no fourth read.
    expect(snap.rents).toEqual({ walletFloor: BigInt(rent(0)), tokenAccount165: BigInt(rent(165)), tokenAccountForMint: BigInt(rent(165)), quoteAccount: BigInt(rent(165)) });
    expect(snap.quote).toBe(SOL_QUOTE);
    expect(snap.quoteMint).toBeNull();
    expect(snap.quoteAccount.address.equals(w.wsolAta)).toBe(true);
    expect(snap.chainNow).toBe(NOW);
  });

  it('a recorded vault, LP mint or price record that is not the one the address gives is refused (one per field)', async () => {
    for (const field of ['token0Vault', 'token1Vault', 'lpMint', 'observationKey'] as const) {
      const w = world({ record: { [field]: Keypair.generate().publicKey } });
      const r = await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote: SOL_QUOTE, owner: ME });
      expect(r, field).toMatch(/no longer matches what the page read/);
    }
  });

  it('a read that fails is said as such, never a pool', async () => {
    const w = world();
    w.chain.getMultipleAccountsInfo = async () => {
      throw new Error('HTTP 502');
    };
    expect(await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote: SOL_QUOTE, owner: ME })).toBe(POOL_READ_FAILED);
    expect(refused(await deposit(w))).toBe(LP_COPY.depositPoolUnread);
    expect(refused(await withdraw(w))).toBe(LP_COPY.withdrawPoolUnread);
  });

  it('a pool account owned by someone else, or a pool for another token, is refused', async () => {
    const w = world();
    const acc = w.chain.accounts.get(w.pool.address.toBase58())!;
    w.chain.set(w.pool.address, { ...acc, owner: STRANGER });
    expect(await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote: SOL_QUOTE, owner: ME })).toMatch(/not owned by the pool program/);
    const v = world();
    expect(await readPoolForWrite(W(v.chain), cfgLocal, { pool: v.pool.address, tokenMint: Keypair.generate().publicKey, quote: SOL_QUOTE, owner: ME })).toBe(LP_COPY.notThisPair('SOL'));
  });
});

describe('poolPins', () => {
  async function view() {
    const w = world();
    const snap = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote: SOL_QUOTE, owner: ME })) as WriteSnapshot;
    return { w, view: snap.view };
  }

  it('pins every account of the pool, from the read', async () => {
    const { w, view: v } = await view();
    const pins = poolPins(cfgLocal, v, { tokenMint: w.mint, lpAccount: w.lpAta });
    expect(typeof pins).toBe('object');
    if (typeof pins === 'string') return;
    expect([pins.vault0, pins.vault1, pins.lpMint, pins.observation, pins.tokenMint, pins.tokenProgram, pins.lpAccount].map((k) => k.toBase58())).toEqual(
      [w.pool.vault0, w.pool.vault1, w.pool.lpMint, w.pool.observation, w.mint, TOKEN_PROGRAM_ID, w.lpAta].map((k) => k.toBase58()),
    );
  });

  it('refuses SOL under the Token-2022 program, the wrong token, and a token under an unknown program', async () => {
    const { w, view: v } = await view();
    const solSide = v.quoteIsToken0 ? 'token0Program' : 'token1Program';
    const tokSide = v.quoteIsToken0 ? 'token1Program' : 'token0Program';
    const withPool = (over: Partial<typeof v.snapshot.pool>) => ({ ...v, snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, ...over } } });
    expect(poolPins(cfgLocal, withPool({ [solSide]: TOKEN_2022_PROGRAM_ID.toBase58() }), { tokenMint: w.mint, lpAccount: w.lpAta })).toMatch(/SOL side/);
    expect(poolPins(cfgLocal, v, { tokenMint: Keypair.generate().publicKey, lpAccount: w.lpAta })).toBe(LP_COPY.notThisPair('SOL'));
    expect(poolPins(cfgLocal, withPool({ [tokSide]: Keypair.generate().publicKey.toBase58() }), { tokenMint: w.mint, lpAccount: w.lpAta })).toMatch(/program this site does not know/);
  });
});

// ── deposit ──────────────────────────────────────────────────────────────────

describe('prepareLpDeposit', () => {
  it('a clean pool: one deposit, bounded on both sides, every number from the transaction', async () => {
    const w = world();
    const p = ok(await deposit(w));
    expect(p.kind).toBe('lp-deposit');
    const s = p.summary as LpDepositSummary;
    expect(s.max.quote).toBe(100_000_000n);
    expect(s.quoted.quote <= s.max.quote && s.quoted.token <= s.max.token).toBe(true);
    expect(s.max.token).toBeLessThan(2n ** 64n - 1n);
    expect(s.lpAmount).toBeGreaterThan(0n);
    expect(s.unwrapsWsol).toBe(true);
    expect(s.sharePct.before).toBe(0);
    expect(s.sharePct.after).toBeCloseTo((Number(s.lpAmount) / Number(LP_SUPPLY + s.lpAmount)) * 100, 9);
    expect(p.steps.filter((x) => x.kind === 'pool-deposit')).toHaveLength(1);
    expect(p.check.intent).toMatchObject({ kind: 'lp-deposit' });
    // The pool shares and the wrapped SOL are watched, each in its own decimals.
    expect(p.check.watch.tokenAccounts.map((t) => [t.role, t.decimals])).toEqual([['token', 6], ['lp', 9], ['wsol', 9]]);
    // A clean token at the market price: nothing to warn of, and no price gap.
    expect(s.price).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(s.warnings).toEqual([]);
    expect(s.priceGap).toBeNull();
    expect(s.tokenWarnings.map((x) => x.code)).toEqual(['no-metadata']);
  });

  it('refused while adding is paused (withdraw-only); a withdrawal from the same pool still prepares', async () => {
    const w = holding();
    expect(refused(await deposit(w, {}, priced(), WITHDRAW_ONLY))).toBe(LP_COPY.depositPaused);
    ok(await withdraw(w, {}, WITHDRAW_ONLY));
  });

  // The loss is worked out with the TOKEN's own decimals. Every other loss test here uses
  // a 6-decimal token, so a builder that assumed 6 passed them all (review, 2026-10-04).
  it('a 9-decimal token: the estimated loss uses the token’s own decimals', async () => {
    // 10 SOL against 1,000 whole tokens of 9 decimals: 0.01 SOL a token. The market says 0.0096.
    const w = world({ mintDecimals: 9, poolDecimals: 9, tokens: 1_000n * 10n ** 9n, heldTokens: 10_000n * 10n ** 9n });
    const s = ok(await deposit(w, {}, priced(0.0096))).summary as LpDepositSummary;
    expect(s.tokenDecimals).toBe(9);
    expect(s.price).toMatchObject({ state: 'disagrees', against: 'outside' });
    const loss = estimatedLoss({ quoteAmount: s.quoted.quote, token: s.quoted.token, tokenDecimals: 9, marketPricePerToken: 0.0096, quote: SOL_QUOTE })!;
    expect(s.priceGap!.lossQuote).toBe(loss);
    // Read as 6 decimals the tokens would count a thousand times over, and so would the loss.
    expect(loss).not.toBe(estimatedLoss({ quoteAmount: s.quoted.quote, token: s.quoted.token, tokenDecimals: 6, marketPricePerToken: 0.0096, quote: SOL_QUOTE }));
    expect(loss).toBeGreaterThan(0n);
    expect(loss).toBeLessThan(s.quoted.quote / 1_000n);
  });

  // Owner ruling 2026-10-04: a price that is off is a warning. The gap and the estimated
  // loss come from the builder's own fresh reads, not from what the card showed.
  it('a price pushed after the card read it (the card saw it agree; the fresh read is 4% off) builds, with the gap and the estimated loss from the fresh read', async () => {
    const w = world();
    const first = (await readPoolForWrite(W(w.chain), cfgLocal, { pool: w.pool.address, tokenMint: w.mint, quote: SOL_QUOTE, owner: ME })) as WriteSnapshot;
    const safety = classifyToken(w.mint.toBase58(), first.mint, first.metaplex);
    const card = assessPool({ view: first.view, tokenDecimals: 6, chainNow: NOW, outside: { kind: 'ok', solPerToken: 0.01, source: 'Jupiter' }, safety });
    expect(card.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
    // Someone pushes the pool's SOL side up 4% before Review.
    w.chain.tokenAccount(w.pool.solVault, WSOL_MINT, new PublicKey(w.chain.accounts.get(w.pool.solVault.toBase58())!.data.subarray(32, 64)), (SOL_RESERVE * 104n) / 100n);
    const s = ok(await deposit(w)).summary as LpDepositSummary;
    expect(s.price).toMatchObject({ state: 'disagrees', against: 'outside' });
    expect(s.priceGap!.diff).toBeCloseTo(0.04, 9);
    // The loss is worked out from the amounts that go in, against the price just read, rounded up.
    const loss = estimatedLoss({ quoteAmount: s.quoted.quote, token: s.quoted.token, tokenDecimals: 6, marketPricePerToken: 0.01, quote: SOL_QUOTE })!;
    expect(s.priceGap!.lossQuote).toBe(loss);
    expect(loss).toBeGreaterThan(0n);
    // About 0.1 SOL at 4% off costs about 0.00002 SOL, never more than what goes in.
    expect(loss).toBeLessThan(s.quoted.quote / 1_000n);
    expect(s.warnings).toEqual([
      'Its price is 4.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.',
      `At these amounts, a move back to the outside price would take up to about ${(Number(loss) / 1e9).toFixed(9).replace(/0+$/, '')} SOL of what you put in. That is an estimate.`,
    ]);
  });

  it('the estimated loss never decides anything: a pool 50% off still builds, and the transaction is the one a pool at the market gets', async () => {
    const at = async (reads: LpPrepareReads) => ok(await deposit(world(), {}, reads));
    const fair = await at(priced(0.01));
    const off = await at(priced(0.02));
    const [f, o] = [fair.summary as LpDepositSummary, off.summary as LpDepositSummary];
    expect(o.priceGap!.diff).toBeCloseTo(-0.5, 9);
    expect(o.priceGap!.lossQuote).toBeGreaterThan(0n);
    expect(f.priceGap).toBeNull();
    // The same shares, the same limits, the same bounds on what may leave.
    expect([o.lpAmount, o.max, o.quoted]).toEqual([f.lpAmount, f.max, f.quoted]);
    expect(off.check.expect.maxSolOut).toBe(fair.check.expect.maxSolOut);
  });

  it('a loss that cannot be worked out is said as such, never as 0', async () => {
    // A market price no number can be multiplied by: the gap is real, its cost is not known.
    const s = ok(await deposit(world(), {}, priced(1e300))).summary as LpDepositSummary;
    expect(s.price.state).toBe('disagrees');
    expect(s.priceGap).toMatchObject({ lossQuote: null });
    expect(s.warnings[s.warnings.length - 1]).toBe('What a move back to the outside price would cost you at these amounts could not be worked out.');
    expect(s.warnings.join(' ')).not.toMatch(/about 0 SOL/);
  });

  it('refused when the outside price cannot be read at prepare, or the read throws: unread is never a warning', async () => {
    const w = world();
    expect(refused(await deposit(w, {}, answering({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' })))).toMatch(/could not check its price.*HTTP 502/);
    const throwing: LpPrepareReads = { outsidePrice: async () => { throw new Error('offline'); } };
    expect(refused(await deposit(w, {}, throwing))).toMatch(/could not check its price.*offline/);
  });

  // Owner ruling 2026-10-04. Jupiter ANSWERING "no route" for a pool anyone could open is
  // "no market": it builds, and says the price was checked against nothing.
  it('Jupiter answers "no route" for a pool anyone could open: it builds as "no market", with the warning and no price gap', async () => {
    const s = ok(await deposit(world(), {}, answering(NO_ROUTE))).summary as LpDepositSummary;
    expect(s.origin).toBe('standard');
    expect(s.price).toMatchObject({ state: 'no-market', detail: 'Jupiter has no route for this token' });
    expect(s.warnings).toEqual([NO_MARKET_DEPOSIT]);
    expect(s.priceGap).toBeNull();
  });

  it('what still refuses a deposit, each in its own words: a mint under another program than the pool’s, other decimals, a 0-bps transfer fee, an extension the pool program rejects', async () => {
    // The pool says classic; the mint is Token-2022.
    const w = world();
    w.chain.mint2022(w.mint, METADATA_ONLY, { decimals: 6 });
    expect(refused(await deposit(w))).toBe(LP_COPY.poolChanged("the token's program"));
    expect(refused(await deposit(world({ mintDecimals: 9 })))).toBe(LP_COPY.poolChanged("the token's decimals"));
    // A transfer fee: the leave rule. The words say it is this site's limit.
    const fee = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [[EXT.TransferFeeConfig, 108], ...METADATA_ONLY] });
    expect(refused(await deposit(fee))).toBe(
      LP_COPY.tokenBlocked(
        'It uses a transfer-fee setting, which lets the token take a fee out of every transfer. This site cannot build exact deposits and withdrawals for a token with one, so it does not open or add to pools for it.',
      ),
    );
    const hook = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: withExtra(EXTENSION.TransferHook) });
    expect(refused(await deposit(hook))).toBe(
      LP_COPY.tokenBlocked('It uses a transfer hook, a program that runs on every transfer and can refuse or redirect it. The pool program does not accept tokens with it.'),
    );
    // The token gone, or no longer a mint.
    const gone = world();
    gone.chain.accounts.delete(gone.mint.toBase58());
    expect(refused(await deposit(gone))).toBe(LP_COPY.poolChanged('its token mint is missing'));
    const broken = world();
    const m = broken.chain.accounts.get(broken.mint.toBase58())!;
    broken.chain.set(broken.mint, { ...m, data: m.data.subarray(0, 81) });
    expect(refused(await deposit(broken))).toMatch(/^This token is now blocked on this site: This address is not a token this site can use/);
  });

  // Owner ruling 2026-10-04: a token its creator can freeze takes deposits, with the warning.
  it('a token whose creator can freeze accounts builds, and the summary says what a freeze means for this pool and for the holder', async () => {
    const s = ok(await deposit(world({ freezeAuthority: STRANGER }))).summary as LpDepositSummary;
    expect(s.warnings).toEqual([FREEZE_DEPOSIT]);
    expect(s.priceGap).toBeNull();
    const own = s.tokenWarnings.find((x) => x.code === 'freeze-authority')!;
    expect(own.text).toContain(STRANGER.toBase58());
    expect(own.text).toMatch(/While a pool’s vault is frozen, nobody can take liquidity out of that pool\./);
  });

  it('a freezable token whose pool vault IS frozen right now is still refused: the warning lifts nothing about the pool', async () => {
    const msg = refused(await deposit(world({ freezeAuthority: STRANGER, frozenTokenVault: true })));
    expect(msg).toMatch(/^We did not build this deposit: One of this pool’s vaults is frozen by the token’s issuer/);
  });

  it('a copy of a well-known name builds, and the copy warning is on the summary', async () => {
    const w = world();
    nameToken(w.chain, w.mint, 'USD Coin', 'USDC');
    const s = ok(await deposit(w)).summary as LpDepositSummary;
    expect(s.warnings).toEqual([COPY_DEPOSIT]);
    expect(s.tokenWarnings.map((x) => x.code)).toEqual(['copies-known-name']);
  });

  it('every warning that applies is carried together: a freezable copy in a pool with no market price', async () => {
    const w = world({ freezeAuthority: STRANGER });
    nameToken(w.chain, w.mint, 'BAYLA', 'BAYLA');
    const s = ok(await deposit(w, {}, answering(NO_ROUTE))).summary as LpDepositSummary;
    expect(s.warnings).toEqual([COPY_DEPOSIT, FREEZE_DEPOSIT, NO_MARKET_DEPOSIT]);
  });

  it.each([
    ['interest-bearing', EXTENSION.InterestBearingConfig],
    ['scaled-amount', EXTENSION.ScaledUiAmountConfig],
  ] as const)('a Token-2022 token with %s amounts builds, with the line about what a wallet displays, and its withdrawal builds too', async (code, type) => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: withExtra(type), heldLp: LP_SUPPLY / 10n });
    const s = ok(await deposit(w)).summary as LpDepositSummary;
    expect(s.warnings).toEqual([AMOUNTS]);
    expect(s.tokenWarnings.map((x) => x.code)).toContain(code);
    // The leave rule: what went in can come out.
    expect((ok(await withdraw(w)).summary as LpWithdrawSummary).lpAmount).toBe(LP_SUPPLY / 20n);
  });

  // The leave rule as code, with the real verdict: this site adds to a pool for exactly
  // the extensions it can also build a withdrawal for, and for no other.
  it('for each Token-2022 extension: a deposit builds only if a withdrawal builds, and only for the one set this site builds for', async () => {
    const letIn: number[] = [];
    const letOut: number[] = [];
    for (const type of [...Object.values(EXTENSION), 99]) {
      const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [extensionOf(type)], heldLp: LP_SUPPLY / 10n });
      if ((await deposit(w)).ok) letIn.push(type);
      if ((await withdraw(w)).ok) letOut.push(type);
    }
    const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);
    expect(sorted(letIn)).toEqual(sorted(BUILDABLE_EXTENSIONS));
    expect(sorted(letOut)).toEqual(sorted(BUILDABLE_EXTENSIONS));
    for (const type of letIn) expect(letOut, String(type)).toContain(type);
  });

  it('refused for a token account a stranger owns (naming the owner), a frozen source, and CPI Guard', async () => {
    const w = world();
    w.chain.tokenAccount(w.tokenAta, w.mint, STRANGER, 10n ** 12n);
    expect(refused(await deposit(w))).toBe(LP_COPY.foreignOwner(w.tokenAta.toBase58(), STRANGER.toBase58()));
    const f = world();
    f.chain.tokenAccount(f.tokenAta, f.mint, ME, 10n ** 12n, { state: 2 });
    expect(refused(await deposit(f))).toBe(LP_COPY.frozenSource('token'));
    const g = world({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    g.chain.token2022Account(g.tokenAta, g.mint, ME, 10n ** 12n, { cpiGuard: true });
    expect(refused(await deposit(g))).toBe(LP_COPY.cpiGuard);
    // CPI Guard present but off is fine.
    g.chain.token2022Account(g.tokenAta, g.mint, ME, 10n ** 12n, { cpiGuard: false });
    ok(await deposit(g));
  });

  it('refused when the pool-share or wrapped-SOL account it would use belongs to a stranger, or is frozen', async () => {
    const w = world();
    w.chain.tokenAccount(w.lpAta, w.pool.lpMint, STRANGER, 0n);
    expect(refused(await deposit(w))).toBe(LP_COPY.foreignOwner(w.lpAta.toBase58(), STRANGER.toBase58()));
    const f = world();
    f.chain.tokenAccount(f.lpAta, f.pool.lpMint, ME, 0n, { state: 2 });
    expect(refused(await deposit(f))).toBe(LP_COPY.frozenDestination('pool-share'));
    const s = world();
    s.chain.tokenAccount(s.wsolAta, WSOL_MINT, STRANGER, 0n);
    expect(refused(await deposit(s))).toBe(LP_COPY.foreignOwner(s.wsolAta.toBase58(), STRANGER.toBase58()));
  });

  it('refused with no token account at all, naming where it looked', async () => {
    const w = world({ heldTokens: null });
    expect(refused(await deposit(w))).toBe(LP_COPY.noTokenAccount(w.tokenAta.toBase58()));
  });

  it('refused above the most this wallet can put in, saying that number (the rent band)', async () => {
    const wallet = 1_000_000_000n;
    const w = world({ wallet });
    const most = spendableSol({ lamports: wallet, walletFloor: BigInt(rent(0)), feeReserve: LP_FEE_RESERVE, lpAccountRent: BigInt(rent(165)), wsolCreateRent: BigInt(rent(165)) });
    expect(refused(await deposit(w, { maxIn: most + 1n }))).toBe(LP_COPY.rentBand(`${(Number(most) / 1e9).toFixed(9).replace(/0+$/, '')} SOL`));
    ok(await deposit(w, { maxIn: most }));
  });

  // The SOL limit is spendableSol, never the wallet's balance. Typing tokens whose SOL
  // cost is over it must not say "your wallet has {spendable}": the wallet app shows more.
  it('typing tokens that cost more SOL than this wallet can put in names the most it can add, not a false balance', async () => {
    const wallet = 1_000_000_000n;
    const w = world({ wallet });
    const most = spendableSol({ lamports: wallet, walletFloor: BigInt(rent(0)), feeReserve: LP_FEE_RESERVE, lpAccountRent: BigInt(rent(165)), wsolCreateRent: BigInt(rent(165)) });
    // 200 tokens cost about 2 SOL at this pool's price.
    const msg = refused(await deposit(w, { driving: 'token', maxIn: 200n * 10n ** 6n }));
    expect(msg).toBe(LP_COPY.rentBand(`${(Number(most) / 1e9).toFixed(9).replace(/0+$/, '')} SOL`));
    expect(msg).not.toMatch(/your wallet has/);
  });

  it('refused when the other side moved beyond the maximum shown; within the tolerance it prepares', async () => {
    const w = world();
    const shown = (ok(await deposit(w)).summary as LpDepositSummary).max.token;
    // The token halved in price since the preview: the same SOL now needs twice the tokens.
    const w2 = world({ tokens: TOKEN_RESERVE * 2n });
    const fresh = (ok(await deposit(w2, {}, priced(0.005))).summary as LpDepositSummary).max.token;
    expect(refused(await deposit(w2, { shownOtherMax: shown }, priced(0.005)))).toBe(
      LP_COPY.moved(`${(Number(fresh) / 1e6).toString()} tokens`, `${(Number(shown) / 1e6).toString()} tokens`),
    );
    // Moved, but within the tolerance of what was shown: it prepares.
    ok(await deposit(w, { shownOtherMax: shown }));
    ok(await deposit(w, { shownOtherMax: shown - shown / 200n }));
  });

  // The review's "traders pay" is the pool's own cost: the trade fee, plus the tier's
  // creator fee when the POOL's switch is on. The switch comes from the same fresh read.
  it("carries the pool's own creator-fee switch into the summary, read fresh", async () => {
    const launch = ok(await deposit(world({ launch: true, enableCreatorFee: true }), {}, answering({ kind: 'no-route', detail: 'Jupiter has no route for this token' })));
    expect((launch.summary as LpDepositSummary).enableCreatorFee).toBe(true);
    const plain = ok(await deposit(world()));
    expect((plain.summary as LpDepositSummary).enableCreatorFee).toBe(false);
  });

  it('a never-traded launch pool prepares when Jupiter answers no route, and is refused when Jupiter is down', async () => {
    const w = world({ launch: true });
    const p = ok(await deposit(w, {}, answering({ kind: 'no-route', detail: 'Jupiter has no route for this token' })));
    expect((p.summary as LpDepositSummary).origin).toBe('launch-pool');
    expect((p.summary as LpDepositSummary).price.state).toBe('no-trades-yet');
    // The card had said allowed; at prepare Jupiter is down: unchecked, so no deposit.
    expect(refused(await deposit(w, {}, answering({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' })))).toMatch(/^We did not build this deposit: .*HTTP 502/);
  });

  // A launch pool with no route keeps its own-average check. Off that average it builds
  // too, and the review is told which price it is off: its own, not the market's.
  it('a launch pool pushed to double its own half-hour average builds, and the gap and the loss are said against its own average', async () => {
    const w = world({ launch: true });
    // One hour of trading at half today's price, last written ten seconds ago.
    const Q32 = 1n << 32n;
    const [first, last] = [NOW - 3_610n, NOW - 10n];
    const own = 5n * Q32 * (last - first);
    const other = ((Q32 * Q32) / (5n * Q32)) * (last - first);
    const [c0, c1] = w.pool.quoteIsToken0 ? [other, own] : [own, other];
    w.chain.set(w.pool.observation, {
      lamports: rent(4075),
      owner: CPSWAP,
      data: observationBytes({ pool: w.pool.address, index: 1, lastUpdate: last, obs: [[0, first, 0n, 0n], [1, last, c0, c1]] }),
    });
    const s = ok(await deposit(w, {}, answering(NO_ROUTE))).summary as LpDepositSummary;
    expect(s.price).toMatchObject({ state: 'disagrees', against: 'own-average' });
    expect(s.priceGap!.diff).toBeCloseTo(0.994, 2);
    const reference = s.price.state === 'disagrees' ? s.price.reference : 0;
    const loss = estimatedLoss({ quoteAmount: s.quoted.quote, token: s.quoted.token, tokenDecimals: 6, marketPricePerToken: reference, quote: SOL_QUOTE })!;
    expect(s.priceGap!.lossQuote).toBe(loss);
    expect(loss).toBeGreaterThan(0n);
    expect(s.warnings).toEqual([
      'Its price is 99.4% above its own average over the last half hour. Someone may have just pushed it; a deposit now would pay for that.',
      `At these amounts, a move back to its own average would take up to about ${(Number(loss) / 1e9).toFixed(9).replace(/0+$/, '')} SOL of what you put in. That is an estimate.`,
    ]);
    // Nothing here names a market this token does not have.
    expect(s.warnings.join(' ')).not.toMatch(/outside price|market price/);
  });

  it('existing wrapped SOL is never closed, and only what the pool did not use may stay in it', async () => {
    const w = world({ heldWsol: 500_000_000n });
    const p = ok(await deposit(w));
    expect(p.steps.some((s) => s.kind === 'close-wsol')).toBe(false);
    expect((p.summary as LpDepositSummary).unwrapsWsol).toBe(false);
    expect((p.summary as LpDepositSummary).wsolHeldBefore).toBe(500_000_000n);
    const row = p.check.expect.tokens.find((t) => t.account.equals(w.wsolAta))!;
    expect([row.minDelta, row.maxDelta]).toEqual([0n, 100_000_000n - 1n]);
  });

  // Mainnet, 2026-10-02: the wrap's sync also credits a kept account set up under the old
  // rent with its old reserve's surplus (550,840), so the upper bound carries it too.
  it('kept wrapped SOL in an account set up under the old rent: both bounds move up by exactly that surplus', async () => {
    const SURPLUS = 550_840n;
    const w = world({ heldWsol: 500_000_000n });
    w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 500_000_000n, { native: { reserve: BigInt(rent(165)) + SURPLUS } });
    const p = ok(await deposit(w));
    const row = p.check.expect.tokens.find((t) => t.account.equals(w.wsolAta))!;
    expect([row.minDelta, row.maxDelta]).toEqual([SURPLUS, 100_000_000n - 1n + SURPLUS]);
  });

  it('wrapped SOL that reaches an empty account between the builder’s read and the balance read is BLOCKED, not unwrapped', async () => {
    const w = world();
    const orig = w.chain.getMultipleAccountsInfo;
    let n = 0;
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      // The pipeline's balance read is the second account read.
      if (++n === 2) w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 250_000_000n);
      return orig(keys);
    };
    const r = await deposit(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/^Blocked: the simulation shows a different token amount/) });
  });

  // A spender approved on the account the new shares land in can move them out: the
  // shares would not be only yours. A drainer's usual approval is exactly this.
  it('a pool-share account an approved spender can still draw from is refused, naming the spender; one with nothing left to spend is not', async () => {
    const w = world();
    w.chain.tokenAccount(w.lpAta, w.pool.lpMint, ME, 0n, { delegate: STRANGER, delegatedAmount: 5n });
    expect(refused(await deposit(w))).toBe(LP_COPY.delegatedDestination(STRANGER.toBase58(), '0.000000005', 'pool-share', w.lpAta.toBase58()));
    const spent = world();
    spent.chain.tokenAccount(spent.lpAta, spent.pool.lpMint, ME, 0n, { delegate: STRANGER, delegatedAmount: 0n });
    expect((ok(await deposit(spent)).summary as LpDepositSummary).notices).toEqual([]);
  });

  it('a pool-share account a stranger can close once it is empty is a notice, not a refusal', async () => {
    const w = world();
    w.chain.tokenAccount(w.lpAta, w.pool.lpMint, ME, 0n, { closeAuthority: STRANGER });
    expect((ok(await deposit(w)).summary as LpDepositSummary).notices).toEqual([LP_COPY.closeAuthorityNotice(STRANGER.toBase58(), 'pool-share')]);
  });

  // Wrapped SOL is native: its close authority can close it with SOL inside and keep
  // every lamport. Kept, the unused SOL would sit there; empty, our close would fail.
  it('a wrapped-SOL account a stranger can close is refused, kept or empty, and so is a kept one a spender can draw from', async () => {
    const kept = world({ heldWsol: 10_000_000n });
    kept.chain.tokenAccount(kept.wsolAta, WSOL_MINT, ME, 10_000_000n, { closeAuthority: STRANGER });
    expect(refused(await deposit(kept))).toMatch(new RegExp(`^${STRANGER.toBase58()} can close your wrapped-SOL account .* and take what is in it`));
    const empty = world({ heldWsol: 0n });
    empty.chain.tokenAccount(empty.wsolAta, WSOL_MINT, ME, 0n, { closeAuthority: STRANGER });
    expect(refused(await deposit(empty))).toMatch(new RegExp(`^${STRANGER.toBase58()} can close your wrapped-SOL account`));
    const spender = world({ heldWsol: 10_000_000n });
    spender.chain.tokenAccount(spender.wsolAta, WSOL_MINT, ME, 10_000_000n, { delegate: STRANGER, delegatedAmount: 10_000_000n });
    expect(refused(await deposit(spender))).toBe(
      `An approved spender (${STRANGER.toBase58()}) can move up to 0.01 wrapped SOL out of your wrapped-SOL account, and this would leave SOL in it. Revoke that approval in your wallet, then try again.`,
    );
    // Empty: it is filled, used and closed in this one transaction, so a spender can take nothing.
    const closed = world({ heldWsol: 0n });
    closed.chain.tokenAccount(closed.wsolAta, WSOL_MINT, ME, 0n, { delegate: STRANGER, delegatedAmount: 10_000_000n });
    expect(ok(await deposit(closed)).steps.some((s) => s.kind === 'close-wsol')).toBe(true);
  });
});

// ── withdraw ─────────────────────────────────────────────────────────────────

describe('prepareLpWithdraw: the leave rule', () => {
  it('a clean withdrawal: one withdrawal, a minimum of at least 1 on each side, and it all comes to you', async () => {
    const w = holding();
    const p = ok(await withdraw(w));
    const s = p.summary as LpWithdrawSummary;
    expect(s.lpAmount).toBe(LP_SUPPLY / 20n);
    expect(s.min.quote >= 1n && s.min.token >= 1n).toBe(true);
    expect(s.min.quote <= s.quoted.quote && s.min.token <= s.quoted.token).toBe(true);
    expect(s.keep).toBe(LP_SUPPLY / 20n);
    expect(s.tokenAccountRent).toBe(0n);
    expect(p.steps.filter((x) => x.kind === 'pool-withdraw')).toHaveLength(1);
    // Everything arriving has no upper bound: a donation to the pool never blocks leaving.
    expect(p.check.expect.tokens.find((t) => t.account.equals(w.tokenAta))!.maxDelta).toBe(2n ** 64n);
    const all = ok(await withdraw(w, { pctBps: 10_000n })).summary as LpWithdrawSummary;
    expect([all.all, all.lpAmount, all.keep]).toEqual([true, LP_SUPPLY / 10n, 0n]);
  });

  it('prepares while every fact that refuses a deposit holds', async () => {
    const cases: Array<[string, Parameters<typeof world>[0], ((w: World) => void)?]> = [
      ['the deposit switch is off', { status: POOL_STATUS_DISABLE_DEPOSIT }],
      ['swaps are switched off', { status: POOL_STATUS_DISABLE_SWAP }],
      ['the pool opens in 10 years', { openTime: NOW + 10n * 365n * 24n * 3600n }],
      // A token blocked for new deposits: its mint reads as never set up.
      ['the token is blocked (a mint that was never set up)', {}, (w) => { w.chain.accounts.get(w.mint.toBase58())!.data[45] = 0; }],
    ];
    for (const [why, o, change] of cases) {
      const w = holding(o);
      change?.(w);
      // Each of these does refuse a deposit ...
      expect((await deposit(w)).ok, why).toBe(false);
      // ... and none of them stops the way out.
      expect((await withdraw(w)).ok, why).toBe(true);
    }
  });

  it('prepares while every fact that only WARNS a deposit holds, and says nothing about them: leaving never depends on a warning', async () => {
    const freezable = holding({ freezeAuthority: STRANGER });
    const copy = holding();
    nameToken(copy.chain, copy.mint, 'USD Coin', 'USDC');
    for (const w of [freezable, copy]) {
      const s = ok(await withdraw(w)).summary as LpWithdrawSummary;
      expect(s.notices).toEqual([]);
    }
  });

  it('prepares while the price disagrees by 50%: no outside price is read at all', async () => {
    // A 2x push on the SOL side. prepareLpWithdraw takes no price reader.
    const r = await withdraw(holding({ sol: SOL_RESERVE * 2n }));
    expect(r.ok).toBe(true);
    expect(prepareLpWithdraw.length).toBe(3);
  });

  it('prepares while the token cannot be classified and the fee settings cannot be read', async () => {
    const w = holding();
    // A mint that no longer decodes as one (blocked as "not a token") ...
    const m = w.chain.accounts.get(w.mint.toBase58())!;
    w.chain.set(w.mint, { ...m, data: m.data.subarray(0, 81) });
    // ... and the pool's config account gone.
    w.chain.accounts.delete(decodePoolState(w.pool.address.toBase58(), w.chain.accounts.get(w.pool.address.toBase58())!.data)!.ammConfig);
    const p = ok(await withdraw(w));
    expect((p.summary as LpWithdrawSummary).config).toBeNull();
    expect((p.summary as LpWithdrawSummary).notices.join(' ')).toMatch(/blocked on this site for new deposits/);
  });

  it('says what would stop a deposit, without refusing: swaps off, a far open time, a blocked token', async () => {
    const off = ok(await withdraw(holding({ status: POOL_STATUS_DISABLE_SWAP }))).summary as LpWithdrawSummary;
    expect(off.notices).toContain(LP_COPY.swapsOff);
    const later = ok(await withdraw(holding({ openTime: NOW + 3600n }))).summary as LpWithdrawSummary;
    expect(later.notices.join(' ')).toMatch(/^Swaps on this pool are blocked until .*That does not stop you taking your liquidity out\.$/);
    const never = holding();
    never.chain.accounts.get(never.mint.toBase58())!.data[45] = 0;
    const blocked = ok(await withdraw(never)).summary as LpWithdrawSummary;
    expect(blocked.notices).toEqual([LP_COPY.tokenBlockedInform('This token mint was never set up.')]);
  });
});

describe('prepareLpWithdraw: what may refuse it', () => {
  it('the pool program’s withdraw switch, and a frozen vault, each with its own words', async () => {
    expect(refused(await withdraw(holding({ status: POOL_STATUS_DISABLE_WITHDRAW })))).toBe(LP_COPY.withdrawBit);
    expect(refused(await withdraw(holding({ frozenTokenVault: true })))).toBe(LP_COPY.vaultFrozen);
  });

  // The row still offers Remove in this state, so the "Leaving without this site" block
  // is not on screen: the refusal must stand on its own and point at nothing.
  it('a transfer-fee token: this site cannot build it yet, says the program still allows it, and points at no section that is not shown', async () => {
    const w = holding({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [[EXT.TransferFeeConfig, 108], ...METADATA_ONLY] });
    const msg = refused(await withdraw(w));
    expect(msg).toMatch(/^This site cannot build a withdrawal for this token yet \(it uses a transfer-fee setting[^)]*\)\. The pool program still lets you withdraw/);
    expect(msg).not.toMatch(/Leaving without this site|\bsee\b/i);
  });

  it('a payout account a stranger owns is refused, naming the owner; required memos are refused; so is a spender who could take the payout', async () => {
    const w = holding();
    w.chain.tokenAccount(w.tokenAta, w.mint, STRANGER, 0n);
    expect(refused(await withdraw(w))).toBe(LP_COPY.foreignOwner(w.tokenAta.toBase58(), STRANGER.toBase58()));
    const x = holding();
    x.chain.tokenAccount(x.wsolAta, WSOL_MINT, STRANGER, 0n);
    expect(refused(await withdraw(x))).toBe(LP_COPY.foreignOwner(x.wsolAta.toBase58(), STRANGER.toBase58()));
    const m = holding({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    m.chain.token2022Account(m.tokenAta, m.mint, ME, 0n, { memoRequired: true });
    expect(refused(await withdraw(m))).toBe(LP_COPY.memosRequired);
    const d = holding();
    d.chain.tokenAccount(d.tokenAta, d.mint, ME, 0n, { delegate: STRANGER, delegatedAmount: 1_000_000n });
    expect(refused(await withdraw(d))).toBe(LP_COPY.delegatedDestination(STRANGER.toBase58(), '1', 'token', d.tokenAta.toBase58()));
  });

  // The withdrawal's SOL lands in the signer's wrapped-SOL account. Kept, a stranger
  // who can close it takes the payout in the next slot; empty, the close we plan is
  // refused on chain (only that authority may sign it), so it is said here instead.
  it('a wrapped-SOL account a stranger can close is refused, kept or empty; a kept one a spender can draw from too', async () => {
    const kept = holding({ heldWsol: 10_000_000n });
    kept.chain.tokenAccount(kept.wsolAta, WSOL_MINT, ME, 10_000_000n, { closeAuthority: STRANGER });
    expect(refused(await withdraw(kept))).toMatch(new RegExp(`^${STRANGER.toBase58()} can close your wrapped-SOL account \\(${kept.wsolAta.toBase58()}\\) and take what is in it`));
    const empty = holding({ heldWsol: 0n });
    empty.chain.tokenAccount(empty.wsolAta, WSOL_MINT, ME, 0n, { closeAuthority: STRANGER });
    expect(refused(await withdraw(empty))).toMatch(new RegExp(`^${STRANGER.toBase58()} can close your wrapped-SOL account`));
    const spender = holding({ heldWsol: 10_000_000n });
    spender.chain.tokenAccount(spender.wsolAta, WSOL_MINT, ME, 10_000_000n, { delegate: STRANGER, delegatedAmount: 1n });
    expect(refused(await withdraw(spender))).toMatch(/^An approved spender .* wrapped-SOL account, and this would leave SOL in it\./);
    // The signer as its own close authority is fine.
    const own = holding({ heldWsol: 10_000_000n });
    own.chain.tokenAccount(own.wsolAta, WSOL_MINT, ME, 10_000_000n, { closeAuthority: ME });
    ok(await withdraw(own));
  });

  it('a payout token account a stranger can close once it is empty is a notice, not a refusal', async () => {
    const w = holding();
    w.chain.tokenAccount(w.tokenAta, w.mint, ME, 0n, { closeAuthority: STRANGER });
    expect((ok(await withdraw(w)).summary as LpWithdrawSummary).notices).toContain(LP_COPY.closeAuthorityNotice(STRANGER.toBase58(), 'token'));
  });

  it('a pool-share account that is not the signer’s, not this pool’s share, or holds none is refused', async () => {
    const w = holding();
    w.chain.tokenAccount(w.lpAta, w.pool.lpMint, STRANGER, 5n);
    expect(refused(await withdraw(w))).toBe(LP_COPY.shareChanged);
    const x = holding();
    x.chain.tokenAccount(x.lpAta, Keypair.generate().publicKey, ME, 5n);
    expect(refused(await withdraw(x))).toBe(LP_COPY.shareChanged);
    const z = holding({ heldLp: 0n });
    expect(refused(await withdraw(z))).toBe(LP_COPY.shareChanged);
  });

  it('too small, a dust remainder, and a bad percent each say so', async () => {
    // 1,000 lamports over 10^9 shares: one side needs 10^6 shares.
    const thin = world({ sol: 1_000n, tokens: 10n ** 12n, heldLp: 1_500_000n });
    expect(refused(await withdraw(thin, { pctBps: 5_000n }))).toBe(LP_COPY.tooSmallWithdraw);
    expect(refused(await withdraw(thin, { pctBps: 7_000n }))).toBe(LP_COPY.dustRemainder('0.00045'));
    expect(refused(await withdraw(thin, { pctBps: 0n }))).toBe(LP_COPY.badPercent);
    ok(await withdraw(thin, { pctBps: 10_000n }));
  });
});

describe('prepareLpWithdraw: from the exact account found', () => {
  it('a pool-share account that is not the associated one: it prepares, and the transaction pins THAT account', async () => {
    const w = world();
    const other = Keypair.generate().publicKey;
    w.chain.tokenAccount(other, w.pool.lpMint, ME, LP_SUPPLY / 10n);
    const p = ok(await withdraw(w, { lpAccount: other }));
    const step = p.steps.find((s) => s.kind === 'pool-withdraw');
    expect(step?.kind === 'pool-withdraw' && step.lpAccount.equals(other)).toBe(true);
    expect(p.check.intent.kind === 'lp-withdraw' && 'pins' in p.check.intent && p.check.intent.pins.lpAccount.equals(other)).toBe(true);
  });
});

describe('Token-2022 account size (D20)', () => {
  it('a token account is 170 bytes for a metadata-only mint AND for a Token-2022 mint with no extensions (getAccountLenForMint says 165)', () => {
    const acc = (data: Uint8Array, owner: PublicKey) => ({ address: 'x', data, owner: owner.toBase58(), lamports: 1 });
    const c = new FakeChain();
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const k = Keypair.generate().publicKey;
    c.mint2022(a, METADATA_ONLY).mint2022(b, []).mint(k);
    expect(tokenAccountSize(acc(c.accounts.get(a.toBase58())!.data, TOKEN_2022_PROGRAM_ID))).toBe(170);
    expect(tokenAccountSize(acc(c.accounts.get(b.toBase58())!.data, TOKEN_2022_PROGRAM_ID))).toBe(170);
    expect(tokenAccountSize(acc(c.accounts.get(k.toBase58())!.data, TOKEN_PROGRAM_ID))).toBe(165);
    // A transfer-fee mint's accounts carry the fee amount too.
    c.mint2022(a, [[EXT.TransferFeeConfig, 108]]);
    expect(tokenAccountSize(acc(c.accounts.get(a.toBase58())!.data, TOKEN_2022_PROGRAM_ID))).toBe(182);
    expect(tokenAccountSize(acc(new Uint8Array(82), STRANGER))).toMatch(/not owned by a token program/);
  });

  it('a withdrawal into a missing Token-2022 account opens it at the Token-2022 address, and its rent is rent(170)', async () => {
    const w = holding({ tokenProgram: TOKEN_2022_PROGRAM_ID, heldTokens: null });
    const p = ok(await withdraw(w));
    const s = p.summary as LpWithdrawSummary;
    expect(s.tokenAccount.equals(associatedTokenAddress(w.mint, ME, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(s.tokenAccountRent).toBe(BigInt(rent(170)));
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(170)));
  });
});

describe('the balance check is sized to the plan (spec 3.4)', () => {
  const row = (p: PreparedTx, k: PublicKey) => {
    const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
    return [r.minDelta, r.maxDelta];
  };

  it('deposit: at least the shares, at most the token maximum and at least 1, the wrapped SOL back where it was, and SOL out = the maximum plus the new account', async () => {
    const w = world();
    const p = ok(await deposit(w));
    const s = p.summary as LpDepositSummary;
    expect(row(p, w.lpAta)).toEqual([s.lpAmount, 2n ** 64n]);
    expect(row(p, w.tokenAta)).toEqual([-s.max.token, -1n]);
    expect(row(p, w.wsolAta)).toEqual([0n, 0n]);
    expect(p.check.expect.maxSolOut).toBe(s.max.quote + BigInt(rent(165)));
    expect(p.check.expect.minSolIn).toBeUndefined();
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(165)));
    // With the pool-share account already there, no new account is paid for.
    const v = world({ heldLp: 1n });
    const q = ok(await deposit(v));
    expect(q.check.expect.maxSolOut).toBe((q.summary as LpDepositSummary).max.quote);
    expect(q.fees.newAccountRentLamports).toBe(0n);
  });

  it('withdraw: at most the shares out, at least the minimum in with no upper bound, and SOL at least the minimum less a new account', async () => {
    const w = holding({ heldTokens: null });
    const p = ok(await withdraw(w));
    const s = p.summary as LpWithdrawSummary;
    expect(row(p, w.lpAta)).toEqual([-s.lpAmount, 2n ** 64n]);
    expect(row(p, w.tokenAta)).toEqual([s.min.token, 2n ** 64n]);
    expect(row(p, w.wsolAta)).toEqual([0n, 0n]);
    expect(p.check.expect.maxSolOut).toBe(BigInt(rent(165)));
    expect(p.check.expect.minSolIn).toBe(s.min.quote - BigInt(rent(165)));
    expect(s.tokenAccountRent).toBe(BigInt(rent(165)));
  });

  it('withdraw into wrapped SOL the wallet already holds: kept, never closed, and at least the minimum arrives in it', async () => {
    const w = holding({ heldWsol: 7n });
    const p = ok(await withdraw(w));
    const s = p.summary as LpWithdrawSummary;
    expect(p.steps.some((x) => x.kind === 'close-wsol')).toBe(false);
    expect(s.unwrapsWsol).toBe(false);
    expect(row(p, w.wsolAta)).toEqual([s.min.quote, 2n ** 64n]);
    expect(p.check.expect.minSolIn).toBeUndefined();
  });
});

describe('the summary must be the plan', () => {
  const pool = Keypair.generate().publicKey;
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  const lpAta = Keypair.generate().publicKey;
  const tokenAta = Keypair.generate().publicKey;
  const lpAccount = Keypair.generate().publicKey;
  const depositSteps = (over: Partial<Extract<IntentStep, { kind: 'pool-deposit' }>> = {}, close = true): IntentStep[] => [
    { kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address: wsolAta },
    { kind: 'wrap-sol', lamports: 100n },
    { kind: 'sync-wsol' },
    { kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address: lpAta },
    { kind: 'pool-deposit', pool, lpAmount: 5n, max0: 100n, max1: 7n, ...over },
    ...(close ? [{ kind: 'close-wsol' } as IntentStep] : []),
  ];
  const want = { pool, lp: 5n, max0: 100n, max1: 7n, maxSol: 100n, closeAfter: true, wsolAta, lpAta };

  it('a deposit step that differs from the plan is refused', () => {
    expect(depositStepsProblem(depositSteps(), want)).toBeNull();
    expect(depositStepsProblem(depositSteps({ lpAmount: 6n }), want)).toMatch(/does not match/);
    expect(depositStepsProblem(depositSteps({ max1: 8n }), want)).toMatch(/does not match/);
    expect(depositStepsProblem(depositSteps({ pool: Keypair.generate().publicKey }), want)).toMatch(/does not match/);
    expect(depositStepsProblem(depositSteps({}, false), want)).toMatch(/closes your wrapped-SOL/);
    expect(depositStepsProblem(depositSteps(), { ...want, maxSol: 99n })).toMatch(/wrapped/);
  });

  it('a withdrawal step that differs from the plan is refused', () => {
    const steps = (over: Partial<Extract<IntentStep, { kind: 'pool-withdraw' }>> = {}): IntentStep[] => [
      { kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address: tokenAta },
      { kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address: wsolAta },
      { kind: 'pool-withdraw', pool, lpAccount, lpAmount: 5n, min0: 1n, min1: 2n, ...over },
      { kind: 'close-wsol' },
    ];
    const wantW = { pool, lpAccount, lp: 5n, min0: 1n, min1: 2n, closeAfter: true, wsolAta, tokenAta };
    expect(withdrawStepsProblem(steps(), wantW)).toBeNull();
    expect(withdrawStepsProblem(steps({ min0: 0n }), wantW)).toMatch(/does not match/);
    expect(withdrawStepsProblem(steps({ lpAccount: Keypair.generate().publicKey }), wantW)).toMatch(/does not match/);
    expect(withdrawStepsProblem(steps().slice(1), wantW)).toMatch(/does not open exactly/);
  });
});

describe('size', () => {
  it('the worst case (both opens, a wrap, a close, a Token-2022 side) leaves 150 bytes for wallet guards', async () => {
    const limit = TX_SIZE_LIMIT - 150;
    const dep = ok(await deposit(world({ tokenProgram: TOKEN_2022_PROGRAM_ID })));
    const out = ok(await withdraw(holding({ tokenProgram: TOKEN_2022_PROGRAM_ID, heldTokens: null })));
    process.stdout.write(`[size] worst-case liquidity: deposit ${dep.sizeBytes}, withdrawal ${out.sizeBytes} of ${TX_SIZE_LIMIT} bytes\n`);
    expect(dep.steps.filter((s) => s.kind === 'create-token-account')).toHaveLength(2);
    expect(dep.steps.some((s) => s.kind === 'close-wsol')).toBe(true);
    expect(dep.sizeBytes).toBeLessThanOrEqual(limit);
    expect(out.sizeBytes).toBeLessThanOrEqual(limit);
  });
});

// ── SOL sent to an address before its account exists ─────────────────────────
//
// Anyone can send SOL to a wallet's associated address before an account is opened
// there. The address then reads as owned by the System program, with no data. That is
// no account yet: create-if-missing adopts it, and the signer pays only what is missing
// from its deposit. It must never refuse a withdrawal or a deposit, or a stranger could
// close the way out of a pool with dust.

describe('SOL sent to an address before its account exists is no account', () => {
  /** The least a bare address can hold, and more than a token account's deposit. */
  const SENT = [rent(0), rent(165) + 12_345];
  const row = (p: PreparedTx, k: PublicKey) => {
    const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
    return [r.minDelta, r.maxDelta];
  };
  const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;

  it('withdraw, at the wrapped-SOL address: it prepares, and those lamports come back with the payout', async () => {
    for (const sent of SENT) {
      const w = holding();
      w.chain.fund(w.wsolAta, sent);
      const p = ok(await withdraw(w));
      const s = p.summary as LpWithdrawSummary;
      expect(s.unwrapsWsol, String(sent)).toBe(true);
      expect(row(p, w.wsolAta), String(sent)).toEqual([0n, 0n]);
      expect(moved(p, w.wsolAta), String(sent)).toBe(0n);
      expect(p.simulated.signerLamportsDelta, String(sent)).toBe(s.quoted.quote + BigInt(sent));
    }
  });

  it('withdraw, at the token address (classic and Token-2022): it prepares, and the wallet pays only what is missing from the deposit', async () => {
    for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const deposit = rent(tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165);
      for (const sent of SENT) {
        const label = `${tokenProgram.toBase58()} ${sent}`;
        const w = holding({ tokenProgram, heldTokens: null });
        w.chain.fund(w.tokenAta, sent);
        const p = ok(await withdraw(w));
        const s = p.summary as LpWithdrawSummary;
        // The review states the whole deposit, and the check allows at most that.
        expect(s.tokenAccountRent, label).toBe(BigInt(deposit));
        expect(p.check.expect.maxSolOut, label).toBe(BigInt(deposit));
        expect(moved(p, w.tokenAta), label).toBe(s.quoted.token);
        expect(p.simulated.signerLamportsDelta, label).toBe(s.quoted.quote - BigInt(Math.max(0, deposit - sent)));
      }
    }
  });

  it('deposit, at the wrapped-SOL address: it prepares, and those lamports come back at the close', async () => {
    for (const sent of SENT) {
      const w = world();
      w.chain.fund(w.wsolAta, sent);
      const p = ok(await deposit(w));
      const s = p.summary as LpDepositSummary;
      expect(s.unwrapsWsol, String(sent)).toBe(true);
      expect(s.wsolHeldBefore, String(sent)).toBe(0n);
      expect(row(p, w.wsolAta), String(sent)).toEqual([0n, 0n]);
      // Out: the cost and the new pool-share account. Back: what was sent to the address.
      expect(p.simulated.signerLamportsDelta, String(sent)).toBe(-s.quoted.quote - BigInt(rent(165)) + BigInt(sent));
    }
  });

  it('deposit, at the pool-share address: it prepares, exactly the shares arrive, and the wallet pays only what is missing from the deposit', async () => {
    for (const sent of SENT) {
      const w = world();
      w.chain.fund(w.lpAta, sent);
      const p = ok(await deposit(w));
      const s = p.summary as LpDepositSummary;
      expect(moved(p, w.lpAta), String(sent)).toBe(s.lpAmount);
      expect(s.sharePct.before, String(sent)).toBe(0);
      expect(p.check.expect.maxSolOut, String(sent)).toBe(s.max.quote + BigInt(rent(165)));
      expect(p.fees.newAccountRentLamports, String(sent)).toBe(BigInt(rent(165)));
      expect(p.simulated.signerLamportsDelta, String(sent)).toBe(-s.quoted.quote - BigInt(Math.max(0, rent(165) - sent)));
    }
  });

  it('deposit: the most this wallet can put in still sets aside a full deposit for each such address', async () => {
    const wallet = 1_000_000_000n;
    const w = world({ wallet });
    w.chain.fund(w.wsolAta, rent(0));
    w.chain.fund(w.lpAta, rent(0));
    const most = spendableSol({ lamports: wallet, walletFloor: BigInt(rent(0)), feeReserve: LP_FEE_RESERVE, lpAccountRent: BigInt(rent(165)), wsolCreateRent: BigInt(rent(165)) });
    expect(refused(await deposit(w, { maxIn: most + 1n }))).toBe(LP_COPY.rentBand(`${(Number(most) / 1e9).toFixed(9).replace(/0+$/, '')} SOL`));
    ok(await deposit(w, { maxIn: most }));
  });

  it('deposit: a token address that only holds SOL is said as holding none of the token', async () => {
    const w = world({ heldTokens: null });
    w.chain.fund(w.tokenAta, rent(0));
    expect(refused(await deposit(w))).toBe(LP_COPY.noTokenAccount(w.tokenAta.toBase58()));
  });

  it('accountCheck itself reads it as absent, whoever calls it', () => {
    const bare = { address: STRANGER.toBase58(), owner: SYSTEM_PROGRAM_ID.toBase58(), data: new Uint8Array(0), lamports: rent(0) };
    for (const use of ['source', 'destination'] as const) {
      expect(accountCheck(bare, { owner: ME, mint: WSOL_MINT, program: TOKEN_PROGRAM_ID, use, what: 'wrapped SOL' })).toEqual({ notices: [] });
    }
  });

  it('anything else at the address is still refused: another owner, or data that is not a token account', async () => {
    const cases: Array<[string, { owner: PublicKey; data: Uint8Array }]> = [
      ['owned by the System program, with data', { owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(80) }],
      ['no data, owned by another program', { owner: STRANGER, data: new Uint8Array(0) }],
      ['owned by the token program, too short to be a token account', { owner: TOKEN_PROGRAM_ID, data: new Uint8Array(0) }],
    ];
    for (const [label, a] of cases) {
      const out = holding();
      out.chain.set(out.wsolAta, { lamports: rent(0), ...a });
      expect(refused(await withdraw(out)), label).toBe(LP_COPY.notUsable('wrapped SOL', out.wsolAta.toBase58()));
      const tok = holding({ heldTokens: null });
      tok.chain.set(tok.tokenAta, { lamports: rent(0), ...a });
      expect(refused(await withdraw(tok)), label).toBe(LP_COPY.notUsable('token', tok.tokenAta.toBase58()));
      const into = world();
      into.chain.set(into.lpAta, { lamports: rent(0), ...a });
      expect(refused(await deposit(into)), label).toBe(LP_COPY.notUsable('pool-share', into.lpAta.toBase58()));
    }
    // A pool-share address that only holds SOL has no shares to take out.
    const none = world();
    none.chain.fund(none.lpAta, rent(0));
    expect(refused(await withdraw(none))).toBe(LP_COPY.shareChanged);
  });
});

// ── a credit between the balance read and the test run ───────────────────────
//
// The balances are read a slot or more before the test run, so whatever a stranger sends
// in between shows up as a larger change. A row that allowed only the exact change let
// one unit of dust a slot block every Review. What protects the signer stays: no more
// may leave than the review says, and no less may arrive.

describe('a credit between the balance read and the test run does not block; a shortfall still does', () => {
  const BLOCKED = { status: 'not-sent', stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' };
  const outcome = (r: Awaited<ReturnType<typeof withdraw>>) => (r.ok ? 'prepared' : r.outcome);
  const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;

  it('withdraw: a pool share a stranger sends to your account in between does not block it', async () => {
    const w = holding();
    beforeBalanceRun(w.chain, () => w.chain.tokenAccount(w.lpAta, w.pool.lpMint, ME, LP_SUPPLY / 10n + 1n));
    const p = ok(await withdraw(w));
    expect(moved(p, w.lpAta)).toBe(1n - (p.summary as LpWithdrawSummary).lpAmount);
  });

  it('withdraw: one share more than the review says leaving your account is still blocked', async () => {
    const w = holding();
    skewTestRun(w.chain, w.lpAta, -1n);
    expect(outcome(await withdraw(w))).toMatchObject(BLOCKED);
  });

  it('withdraw: exactly the minimum arriving passes; one token, or one lamport, less is still blocked', async () => {
    const clean = ok(await withdraw(holding()));
    const s = clean.summary as LpWithdrawSummary;
    const fees = clean.fees.baseLamports + clean.fees.priorityLamports;
    const tokenShort = s.quoted.token - s.min.token;
    const solShort = s.quoted.quote - s.min.quote + fees;

    const atMin = holding();
    skewTestRun(atMin.chain, atMin.tokenAta, -tokenShort);
    skewTestRun(atMin.chain, ME, -solShort);
    ok(await withdraw(atMin));

    const fewerTokens = holding();
    skewTestRun(fewerTokens.chain, fewerTokens.tokenAta, -tokenShort - 1n);
    expect(outcome(await withdraw(fewerTokens))).toMatchObject(BLOCKED);

    const lessSol = holding();
    skewTestRun(lessSol.chain, ME, -solShort - 1n);
    expect(outcome(await withdraw(lessSol))).toMatchObject({ stage: 'simulate', message: 'Blocked: the simulation shows less SOL arriving than this screen says.' });
  });

  it('deposit: a pool share a stranger sends in between does not block it; one share fewer than the review says still does', async () => {
    const w = world({ heldLp: 5n });
    beforeBalanceRun(w.chain, () => w.chain.tokenAccount(w.lpAta, w.pool.lpMint, ME, 6n));
    const p = ok(await deposit(w));
    expect(moved(p, w.lpAta)).toBe((p.summary as LpDepositSummary).lpAmount + 1n);

    const short = world();
    skewTestRun(short.chain, short.lpAta, -1n);
    expect(outcome(await deposit(short))).toMatchObject(BLOCKED);
  });
});
