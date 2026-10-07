// @vitest-environment node
//
// A swap the Solana swap page sends to one of our pools, against a fake chain whose
// simulator works the swap out with its OWN constant-product sum and the tier's own rate
// (never by calling the code under test). The venue's real pool is the model: BAYLA
// (Token-2022) priced in SOL, on the public fee tier (tier 1, 1% a trade).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { IX_SWAP_BASE_INPUT, POOL_STATUS_DISABLE_SWAP, decodeAmmConfig, publicTierConfig } from '../../../solana/cpswap/program';
import { BAYLA_QUOTE, USDC_QUOTE } from '../../../solana/lp/quotes';
import { EXTENSION } from '../../../solana/lp/tokenSafety';
import { SWAP_COPY, prepareVenueSwap, venueSwapStepsProblem } from './venueSwap';
import { CPSWAP, EXT, FakeChain, addPool, cfgLocal, openAccount, rent, setClock, type PoolFixture, type SimHandler } from './testkit.fixture';
import type { IntentStep, LpOpenGate, PreparedTx, VenueSwapSummary, WriteRpc } from './types';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const NOW = 2_000_000_000n;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const BAYLA = new PublicKey(BAYLA_QUOTE.mint);
const USDC = new PublicKey(USDC_QUOTE.mint);
const TIER1 = publicTierConfig(CPSWAP);
const SOL_RESERVE = 10n * 10n ** 9n;
const BAYLA_RESERVE = 1_000_000n * 10n ** 6n;
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];

const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
function amountAt(c: FakeChain, k: PublicKey): bigint | null {
  const a = c.accounts.get(k.toBase58());
  return a && a.data.length >= 72 ? u64At(a.data, 64) : null;
}

/** cp-swap's swap_base_input, worked out here in words: a ceiling trade fee, then a floored constant product. */
export function expectedOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: bigint): bigint {
  const fee = (amountIn * tradeFeeRate + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (reserveOut * net) / (reserveIn + net);
}

const fail = (code: number) => ({ err: { InstructionError: [4, { Custom: code }] }, logs: [`Program ${CPSWAP.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 40_000 });

/**
 * Runs the swap on the chain's own accounts: the tier's rate read from the config the
 * swap names, the reserves from the vaults it names. `pay` changes what the pool pays
 * out (a test of the balance check); the program's own floor still applies.
 */
function swapSimulator(o: { pay?: (out: bigint) => bigint; ignoreFloor?: boolean; skimWsol?: bigint } = {}): SimHandler {
  return (vtx: VersionedTransaction, config, chain) => {
    const keys = vtx.message.staticAccountKeys;
    const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
    const sw = ixs.find((i) => i.program.equals(CPSWAP));
    if (!sw || !IX_SWAP_BASE_INPUT.every((b, i) => sw.data[i] === b)) return { err: 'no swap', logs: [], unitsConsumed: 1 };
    const amountIn = u64At(sw.data, 8);
    const minOut = u64At(sw.data, 16);
    const [, , cfgKey, , inAcc, outAcc, inVault, outVault, , outProg, inMint, outMint] = sw.accounts;
    const cfg = decodeAmmConfig(cfgKey!.toBase58(), chain.accounts.get(cfgKey!.toBase58())!.data)!;
    const out = (o.pay ?? ((x) => x))(expectedOut(amountIn, amountAt(chain, inVault!)!, amountAt(chain, outVault!)!, cfg.tradeFeeRate));
    if (out < minOut && !o.ignoreFloor) return fail(6005);
    const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
    const paidToOpen = ixs
      .filter((i) => i.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
      .reduce((n, i) => n + openAccount(chain, i.accounts[1]!, i.accounts[5]!.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165).paid, 0);
    const wrapped = ixs.filter((i) => i.program.equals(SYSTEM_PROGRAM_ID)).reduce((n, i) => n + u64At(i.data, 4), 0n);
    const closes = ixs.some((i) => i.program.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9);
    const solIn = inMint!.equals(WSOL_MINT);
    const solOut = outMint!.equals(WSOL_MINT);
    const wsolLamportsBefore = BigInt(openAccount(chain, wsolAta).lamports);
    const wsolLamportsAfter = wsolLamportsBefore + wrapped - (solIn ? amountIn : 0n) + (solOut ? out : 0n);
    const signerDelta = -wrapped - BigInt(paidToOpen) + (closes ? wsolLamportsAfter : 0n);
    if (!config?.accounts) return { err: null, logs: [], unitsConsumed: 60_000 };
    const changes: Parameters<FakeChain['post']>[1] = { [ME.toBase58()]: { lamportsDelta: Number(signerDelta) } };
    const wsolBalance = (amountAt(chain, wsolAta) ?? 0n) + wrapped - (solIn ? amountIn : 0n) + (solOut ? out : 0n) - (o.skimWsol ?? 0n);
    if (solIn || solOut) changes[wsolAta.toBase58()] = closes ? { closed: true } : { tokenAmount: wsolBalance, mint: WSOL_MINT, owner: ME };
    if (!solIn) changes[inAcc!.toBase58()] = { tokenAmount: (amountAt(chain, inAcc!) ?? 0n) - amountIn, mint: inMint!, owner: ME };
    if (!solOut) changes[outAcc!.toBase58()] = { tokenAmount: (amountAt(chain, outAcc!) ?? 0n) + out, mint: outMint!, owner: ME };
    void outProg;
    return { err: null, logs: [], unitsConsumed: 60_000, accounts: chain.post(config.accounts.addresses, changes) };
  };
}

interface World {
  chain: FakeChain;
  pool: PoolFixture;
  tokenAta: PublicKey;
  wsolAta: PublicKey;
}

/** The venue's BAYLA/SOL pool on tier 1 (the chain also holds tier 0, at a different rate), and a funded wallet. */
function world(o: {
  heldBayla?: bigint | null;
  heldWsol?: bigint;
  wallet?: bigint;
  status?: number;
  openTime?: bigint;
  clock?: bigint | null;
  frozenTokenVault?: boolean;
  extensions?: Array<[number, number]>;
  delegatedBayla?: boolean;
  pay?: (out: bigint) => bigint;
  /** A test run that breaks the program's rules: pays below the floor, or takes the wallet's own wrapped SOL. */
  rogue?: { ignoreFloor?: boolean; skimWsol?: bigint };
} = {}): World {
  const chain = FakeChain.healthy();
  chain.addTier1();
  chain.simulate = swapSimulator({ pay: o.pay, ...o.rogue });
  chain.mint2022(BAYLA, o.extensions ?? METADATA_ONLY, { decimals: 6 });
  const pool = addPool(chain, BAYLA, {
    sol: SOL_RESERVE,
    tokens: BAYLA_RESERVE,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    ammConfig: TIER1,
    status: o.status,
    openTime: o.openTime,
    frozenTokenVault: o.frozenTokenVault,
  });
  setClock(chain, o.clock === undefined ? NOW : o.clock);
  chain.fund(ME, Number(o.wallet ?? 20n * 10n ** 9n));
  const tokenAta = associatedTokenAddress(BAYLA, ME, TOKEN_2022_PROGRAM_ID);
  if (o.heldBayla !== null && o.heldBayla !== undefined) {
    chain.token2022Account(tokenAta, BAYLA, ME, o.heldBayla, o.delegatedBayla ? { delegate: STRANGER, delegatedAmount: 5n } : {});
  }
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  if (o.heldWsol !== undefined) chain.tokenAccount(wsolAta, WSOL_MINT, ME, o.heldWsol, { native: { reserve: BigInt(rent(165)) } });
  return { chain, pool, tokenAta, wsolAta };
}

const buy = (w: World, amountIn: bigint, slippageBps = 100n) =>
  prepareVenueSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, inputMint: WSOL_MINT, outputMint: BAYLA, amountIn, slippageBps });
const sell = (w: World, amountIn: bigint, slippageBps = 100n) =>
  prepareVenueSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, inputMint: BAYLA, outputMint: WSOL_MINT, amountIn, slippageBps });

function ok(r: Awaited<ReturnType<typeof prepareVenueSwap>>): PreparedTx {
  if (!r.ok) throw new Error(`not prepared: ${r.outcome.message}`);
  return r.prepared;
}
const refused = (r: Awaited<ReturnType<typeof prepareVenueSwap>>): string => {
  if (r.ok) throw new Error('prepared, expected a refusal');
  return r.outcome.message;
};
const swapStep = (p: PreparedTx) => p.steps.find((s) => s.kind === 'pool-swap') as Extract<IntentStep, { kind: 'pool-swap' }>;
const sum = (p: PreparedTx) => p.summary as VenueSwapSummary;
const minOf = (out: bigint, bps: bigint) => (out * (10_000n - bps)) / 10_000n;

describe('a buy of BAYLA with SOL in its tier-1 pool', () => {
  it('prices with the pool’s own tier (1%) and pins every number of the swap to it', async () => {
    const w = world();
    const p = ok(await buy(w, 1_000_000_000n));
    // Worked out by hand at 1%, not 0.25%: the chain's tier 0 must not be the one used.
    const out = expectedOut(1_000_000_000n, SOL_RESERVE, BAYLA_RESERVE, 10_000n);
    expect(out).not.toBe(expectedOut(1_000_000_000n, SOL_RESERVE, BAYLA_RESERVE, 2_500n));
    expect(swapStep(p)).toEqual({ kind: 'pool-swap', pool: w.pool.address, inputMint: WSOL_MINT, outputMint: BAYLA, amountIn: 1_000_000_000n, minimumAmountOut: minOf(out, 100n) });
    const swapIx = p.tx.instructions.find((ix) => ix.programId.equals(CPSWAP))!;
    expect(swapIx.keys[2]!.pubkey.equals(TIER1)).toBe(true);
    // BAYLA's side is Token-2022: its program and its account seeded under it.
    expect(swapIx.keys[5]!.pubkey.equals(w.tokenAta)).toBe(true);
    expect(swapIx.keys[9]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    const s = sum(p);
    expect(s.quote.outAmount).toBe(out);
    expect([s.input.symbol, s.output.symbol, s.output.decimals, s.wrapsSol, s.unwrapsWsol]).toEqual(['SOL', 'BAYLA', 6, true, true]);
    expect(s.config.tradeFeeRate).toBe(10_000n);
  });

  it('opens the BAYLA account at Token-2022’s size and says what it costs', async () => {
    const p = ok(await buy(world(), 1_000_000_000n));
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(170)));
    expect(sum(p).outputAccountRent).toBe(BigInt(rent(170)));
    expect(p.steps.map((s) => s.kind).filter((k) => k !== 'compute-limit' && k !== 'compute-price')).toEqual([
      'create-token-account', 'wrap-sol', 'sync-wsol', 'create-token-account', 'pool-swap', 'close-wsol',
    ]);
  });

  it('a wallet that already holds wrapped SOL keeps it: nothing of it is spent, and the account stays open', async () => {
    const w = world({ heldWsol: 2_000_000_000n, heldBayla: 0n });
    const p = ok(await buy(w, 1_000_000_000n));
    expect(sum(p).unwrapsWsol).toBe(false);
    expect(p.steps.some((s) => s.kind === 'close-wsol')).toBe(false);
  });

  it('the pool’s own floor is the bound: a pool that pays less than the floor is refused by the program', async () => {
    const r = await buy(world({ pay: (out) => minOf(out, 100n) - 1n }), 1_000_000_000n);
    expect(refused(r)).toMatch(/./);
  });
});

describe('a sale of BAYLA for SOL', () => {
  it('opens and closes the wrapped-SOL account, so the SOL comes back plain', async () => {
    const w = world({ heldBayla: 50_000n * 10n ** 6n });
    const p = ok(await sell(w, 10_000n * 10n ** 6n));
    const out = expectedOut(10_000n * 10n ** 6n, BAYLA_RESERVE, SOL_RESERVE, 10_000n);
    expect(swapStep(p)).toMatchObject({ inputMint: BAYLA, outputMint: WSOL_MINT, minimumAmountOut: minOf(out, 100n) });
    expect(sum(p)).toMatchObject({ unwrapsWsol: true, outputAccountRent: 0n });
    expect(p.fees.newAccountRentLamports).toBe(0n);
  });

  it('with wrapped SOL already held, the SOL stays wrapped in that account', async () => {
    const p = ok(await sell(world({ heldBayla: 50_000n * 10n ** 6n, heldWsol: 5n }), 10_000n * 10n ** 6n));
    expect(sum(p).unwrapsWsol).toBe(false);
  });

  it('refuses a sale of more than the account holds, and an account that is not open', async () => {
    expect(refused(await sell(world({ heldBayla: 1_000n * 10n ** 6n }), 2_000n * 10n ** 6n))).toMatch(/^This swap spends 2,?000 BAYLA and your account for it holds 1,?000 BAYLA\.$/);
    expect(refused(await sell(world({ heldBayla: null }), 2_000n * 10n ** 6n))).toMatch(/^You hold no BAYLA in your main account for it/);
  });
});

describe('a pool paired with USDC: nothing is wrapped', () => {
  it('a token sold for USDC opens the USDC account and swaps, and moves no SOL', async () => {
    const chain = FakeChain.healthy();
    chain.addTier1();
    chain.simulate = swapSimulator();
    const mint = Keypair.generate().publicKey;
    chain.mint(mint, { decimals: 6 });
    chain.mint(USDC, { decimals: 6 });
    const pool = addPool(chain, mint, { sol: 50_000n * 10n ** 6n, tokens: 1_000_000n * 10n ** 6n, quote: USDC_QUOTE, ammConfig: TIER1 });
    setClock(chain, NOW);
    chain.fund(ME, 1_000_000_000);
    chain.tokenAccount(associatedTokenAddress(mint, ME), mint, ME, 10_000n * 10n ** 6n);
    const p = ok(await prepareVenueSwap(W(chain), OPEN, { owner: ME, pool: pool.address, inputMint: mint, outputMint: USDC, amountIn: 1_000n * 10n ** 6n, slippageBps: 50n }));
    expect(p.steps.some((s) => s.kind === 'wrap-sol' || s.kind === 'close-wsol' || s.kind === 'sync-wsol')).toBe(false);
    expect(sum(p)).toMatchObject({ wrapsSol: false, outputAccountRent: BigInt(rent(165)) });
    expect(sum(p).output.symbol).toBe('USDC');
    expect(sum(p).input.symbol).toBeNull();
  });
});

describe('refused, each for its own reason', () => {
  it('a pool that does not trade exactly these two tokens', async () => {
    const w = world();
    const r = await prepareVenueSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, inputMint: USDC, outputMint: BAYLA, amountIn: 1n, slippageBps: 100n });
    expect(refused(r)).toBe('This pool does not pair this token with USDC.');
  });

  it('two tokens neither of which is a pairing coin', async () => {
    const w = world();
    const r = await prepareVenueSwap(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, inputMint: Keypair.generate().publicKey, outputMint: Keypair.generate().publicKey, amountIn: 1n, slippageBps: 100n });
    expect(refused(r)).toBe(SWAP_COPY.notAPair);
  });

  it('paused: the pools page in its emergency state', async () => {
    const w = world();
    const r = await prepareVenueSwap(W(w.chain), { kind: 'open', cfg: cfgLocal, mode: 'withdraw-only' }, { owner: ME, pool: w.pool.address, inputMint: WSOL_MINT, outputMint: BAYLA, amountIn: 1n, slippageBps: 100n });
    expect(refused(r)).toBe(SWAP_COPY.paused);
  });

  it('no slippage, or more than this site allows', async () => {
    expect(refused(await buy(world(), 1_000n, 0n))).toMatch(/slippage|price limit/i);
    expect(refused(await buy(world(), 1_000n, 501n))).toMatch(/slippage|5%/i);
  });

  it('swaps switched off, or a pool not open yet BY THE CHAIN’S CLOCK', async () => {
    expect(refused(await buy(world({ status: POOL_STATUS_DISABLE_SWAP }), 1_000_000n))).toBe(SWAP_COPY.cannotPrice);
    expect(refused(await buy(world({ openTime: NOW + 60n }), 1_000_000n))).toBe(SWAP_COPY.cannotPrice);
    // The viewer's clock (2026) is long past 1,001; the chain's (1,000) is not.
    expect(refused(await buy(world({ clock: 1_000n, openTime: 1_001n }), 1_000_000n))).toBe(SWAP_COPY.cannotPrice);
    expect(refused(await buy(world({ clock: null }), 1_000_000n))).toBe(SWAP_COPY.clockUnread);
  });

  // A read that could not run is no verdict: the outcome says asking again may work, so the
  // swap page does not take it as our pool refusing this wallet (SolanaSwapPage onOwnSettled).
  it('a read that could not run says so; a refusal does not', async () => {
    const noClock = await buy(world({ clock: null }), 1_000_000n);
    expect(!noClock.ok && noClock.outcome).toMatchObject({ stage: 'build', message: SWAP_COPY.clockUnread, retry: true });
    const down = world();
    down.chain.getMultipleAccountsInfo = async () => {
      throw new Error('HTTP 502');
    };
    const unread = await buy(down, 1_000_000n);
    expect(!unread.ok && unread.outcome).toMatchObject({ stage: 'build', message: SWAP_COPY.poolUnread, retry: true });
    const noHash = world();
    noHash.chain.getLatestBlockhash = async () => {
      throw new Error('HTTP 429');
    };
    const hashless = await buy(noHash, 1_000_000n);
    expect(!hashless.ok && hashless.outcome).toMatchObject({ stage: 'build', message: expect.stringMatching(/^Could not read the network to prepare this/), retry: true });
    const noSim = world();
    noSim.chain.simulateTransaction = async () => {
      throw new Error('HTTP 503');
    };
    const simless = await buy(noSim, 1_000_000n);
    expect(!simless.ok && simless.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/^Could not run the safety check/), retry: true });
    // A node behind on the blockhash, or one that left out the balances it was asked for, is no verdict either.
    const behind = world();
    behind.chain.simulate = () => ({ err: 'BlockhashNotFound', logs: [], unitsConsumed: 0 });
    const lagged = await buy(behind, 1_000_000n);
    expect(!lagged.ok && lagged.outcome).toMatchObject({ stage: 'simulate', retry: true });
    const blind = world();
    blind.chain.simulate = () => ({ err: null, logs: [], unitsConsumed: 50_000 });
    const unconfirmed = await buy(blind, 1_000_000n);
    expect(!unconfirmed.ok && unconfirmed.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/^The safety check could not confirm this/), retry: true });
    for (const r of [await buy(world({ status: POOL_STATUS_DISABLE_SWAP }), 1_000_000n), await buy(world({ frozenTokenVault: true }), 1_000_000n)]) {
      expect(!r.ok && 'retry' in r.outcome).toBe(false);
    }
  });

  it('a frozen vault', async () => {
    expect(refused(await buy(world({ frozenTokenVault: true }), 1_000_000n))).toBe(SWAP_COPY.vaultFrozen);
  });

  it('a token with a transfer fee: a cut outside the quote', async () => {
    const r = await buy(world({ extensions: [[EXTENSION.TransferFeeConfig, 108], ...METADATA_ONLY] }), 1_000_000n);
    expect(refused(r)).toMatch(/^This token is now blocked on this site:/);
  });

  it('a BAYLA account with an approved spender, which the swap would pay into', async () => {
    const r = await buy(world({ heldBayla: 1n, delegatedBayla: true }), 1_000_000n);
    expect(refused(r)).toMatch(/approved spender .* this would pay into it/);
  });

  it('more SOL than the wallet can spend and still pay its fees and deposits', async () => {
    expect(refused(await buy(world({ wallet: 1_000_000_000n }), 1_000_000_000n))).toMatch(/^That would leave your wallet with too little SOL/);
  });
});

// A test run that breaks the program's own rules: only the balance check stands between it
// and the wallet. Each direction has its own bounds, and each is pinned here.
describe('the balance check, per direction, against a test run that does not keep the rules', () => {
  const short = (out: bigint) => minOf(out, 100n) - 1n;
  it('SOL in: tokens below the floor arriving are blocked', async () => {
    expect(refused(await buy(world({ pay: short, rogue: { ignoreFloor: true } }), 1_000_000_000n))).toMatch(/^Blocked:/);
  });
  it('SOL in, wrapped SOL kept: the wallet’s own wrapped SOL taken is blocked', async () => {
    expect(refused(await buy(world({ heldWsol: 2_000_000_000n, rogue: { skimWsol: 1n } }), 1_000_000_000n))).toMatch(/^Blocked:/);
  });
  // The SOL check allows the network fees as slack (a simulation may or may not debit them),
  // so the shortfall here is well past any fee; the program's own floor guards the exact amount.
  it('SOL out, closed: less SOL than the floor coming back is blocked', async () => {
    const wayShort = (out: bigint) => minOf(out, 100n) - 10_000_000n;
    expect(refused(await sell(world({ heldBayla: 50_000n * 10n ** 6n, pay: wayShort, rogue: { ignoreFloor: true } }), 10_000n * 10n ** 6n))).toMatch(/^Blocked:/);
  });
  it('SOL out, kept: less wrapped SOL than the floor arriving is blocked', async () => {
    expect(refused(await sell(world({ heldBayla: 50_000n * 10n ** 6n, heldWsol: 5n, pay: short, rogue: { ignoreFloor: true } }), 10_000n * 10n ** 6n))).toMatch(/^Blocked:/);
  });
});

describe('the decoded body must be exactly the plan', () => {
  const pool = Keypair.generate().publicKey;
  const swap = (o: Partial<Extract<IntentStep, { kind: 'pool-swap' }>> = {}): IntentStep => ({ kind: 'pool-swap', pool, inputMint: WSOL_MINT, outputMint: BAYLA, amountIn: 10n, minimumAmountOut: 9n, ...o });
  const wsol = associatedTokenAddress(WSOL_MINT, ME);
  const out = associatedTokenAddress(BAYLA, ME, TOKEN_2022_PROGRAM_ID);
  const open = (address: PublicKey): IntentStep => ({ kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address });
  const want = { pool, inputMint: WSOL_MINT, outputMint: BAYLA, amountIn: 10n, minimumAmountOut: 9n, wrap: 10n as bigint | null, opens: [wsol, out], closeAfter: true as boolean | null };
  const planned = (): IntentStep[] => [open(wsol), { kind: 'wrap-sol', lamports: 10n }, { kind: 'sync-wsol' }, open(out), swap(), { kind: 'close-wsol' }];

  it('the plan itself passes', () => {
    expect(venueSwapStepsProblem(planned(), want)).toBeNull();
  });
  it.each<[string, () => IntentStep[], RegExp]>([
    ['the swap reversed', () => planned().map((s) => (s.kind === 'pool-swap' ? swap({ inputMint: BAYLA, outputMint: WSOL_MINT }) : s)), /goes the other way/],
    ['another amount', () => planned().map((s) => (s.kind === 'pool-swap' ? swap({ amountIn: 11n }) : s)), /does not match the quote/],
    ['another pool', () => planned().map((s) => (s.kind === 'pool-swap' ? swap({ pool: STRANGER }) : s)), /different pool/],
    ['two swaps', () => [...planned(), swap()], /missing from the transaction/],
    ['more SOL wrapped than spent', () => planned().map((s) => (s.kind === 'wrap-sol' ? { kind: 'wrap-sol', lamports: 11n } : s)), /SOL wrapped/],
    ['an extra account opened', () => [open(Keypair.generate().publicKey), ...planned()], /exactly the accounts/],
    ['the wrapped SOL kept when it should close', () => planned().filter((s) => s.kind !== 'close-wsol'), /closes your wrapped-SOL account/],
  ])('%s', (_what, steps, why) => {
    expect(venueSwapStepsProblem(steps(), want)).toMatch(why);
  });
  it('a swap that spends no SOL wraps none and never closes the wrapped-SOL account', () => {
    const noSol = { ...want, wrap: null, opens: [out], closeAfter: null };
    expect(venueSwapStepsProblem([open(out), swap()], noSol)).toBeNull();
    expect(venueSwapStepsProblem([{ kind: 'wrap-sol', lamports: 1n }, { kind: 'sync-wsol' }, open(out), swap()], noSol)).toMatch(/wraps SOL/);
    expect(venueSwapStepsProblem([open(out), swap(), { kind: 'close-wsol' }], noSol)).toMatch(/closes your wrapped-SOL account/);
  });
});

// The builder only ever decodes its own body, so no case above can tell its summarize
// apart from one that skips the plan check. Pin the call site in the source itself.
describe('the plan check is where the review is built', () => {
  it('summarize returns the steps problem before it builds the summary', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'venueSwap.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    const summarize = src.slice(src.indexOf('summarize: (steps)'));
    expect(summarize.indexOf('venueSwapStepsProblem(steps')).toBeGreaterThan(-1);
    expect(summarize.indexOf('if (problem) return problem;')).toBeGreaterThan(summarize.indexOf('venueSwapStepsProblem(steps'));
    expect(summarize.indexOf("kind: 'venue-swap'")).toBeGreaterThan(summarize.indexOf('if (problem) return problem;'));
  });
});
