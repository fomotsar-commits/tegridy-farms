// @vitest-environment node
//
// Every Jupiter leg the keeper signs is held to the list of its own token accounts (KeeperIo.held):
// it may name none of them but the leg's own source and destination. One case for each place a leg
// is built, each beside the same leg naming no such account, which reaches the trip's build. The
// chain and Jupiter are made up here; the keeper's own steps run as they do live.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { PoolView } from '../lp/poolFinder';
import type { Arbitrage } from '../lp/poolList';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../lp/quotes';
import type { JupiterApi, JupiterQuote, SwapInstructions } from './jupiterApi';
import type { OutsideTake } from './takes';

const gaps = new Map<string, Arbitrage>();
let pools: PoolView[] = [];
vi.mock('../lp/poolList', async (orig) => ({
  ...(await orig<typeof import('../lp/poolList')>()),
  listPools: vi.fn(async () => ({ kind: 'ok', list: { pools, chainNow: 100n } })),
  readMarketPrices: vi.fn(async () => ({ kind: 'ok', usd: new Map([[SOL_QUOTE.mint, 100]]) })),
  arbitrage: vi.fn((view: PoolView) => gaps.get(view.address) ?? null),
  rowTokenFee: vi.fn(() => null),
}));
// Every mint reads as a plain token: the token gate's own test is rule.test.ts.
vi.mock('../lp/tokenSafety', async (orig) => ({
  ...(await orig<typeof import('../lp/tokenSafety')>()),
  readTokenSafety: vi.fn(async (_rpc: unknown, mints: string[]) => new Map(mints.map((m) => [m, { kind: 'read', mint: m, facts: { program: 'token', isInitialized: true, freezeAuthority: null, extensions: [] } }]))),
}));
vi.mock('./plan', async (orig) => ({ ...(await orig<typeof import('./plan')>()), poolProblem: vi.fn(() => null) }));
vi.mock('./rule', async (orig) => ({ ...(await orig<typeof import('./rule')>()), tokenGate: vi.fn(() => null) }));
// Our pool pays twice what goes in, either way: every trip here pays.
vi.mock('../cpswap/read', async (orig) => ({
  ...(await orig<typeof import('../cpswap/read')>()),
  quoteOwnPool: vi.fn((_snapshot: unknown, _config: unknown, _inputMint: string, amountIn: bigint) => ({ outAmount: amountIn * 2n })),
}));

const { runCycle, sellDust, sendChecked, DEFAULT_SETTINGS } = await import('./cycle');
const { DEFAULT_LIMITS, JUPITER_PROGRAM, NAMES_OTHER_ACCOUNT, ROUTE_V2, SHARED_ACCOUNTS_ROUTE_V2 } = await import('./plan');

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOL = new PublicKey(SOL_QUOTE.mint);
const key = () => Keypair.generate().publicKey;
const b58 = (k: PublicKey) => k.toBase58();
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN);
const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };
const REACHED = 'the trip reached its build';
// The venue's pool program, and its launch tier (0) and public tier (1), on mainnet.
const POOL_PROGRAM = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
const TIERS = [new PublicKey('BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW'), new PublicKey('CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy')] as const;

/** A token account of `owner` holding `amount` of `mint`, as the RPC answers it. */
function tokenAccount(amount: bigint, mint = key(), owner = key()) {
  const data = new Uint8Array(165);
  data.set(mint.toBytes(), 0);
  data.set(owner.toBytes(), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: b58(TOKEN), lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

/**
 * The chain: every account holds 5 coins' worth, a mint reads 6 decimals, and a trip stops at its
 * build, or, given `tested`, at its test run, which keeps the transaction there.
 */
function chain(owner: PublicKey, accounts: { mint: PublicKey; amount: bigint }[] = [], tested?: string[]) {
  const asked: string[] = [];
  const mints = new Set(accounts.map((a) => b58(a.mint)));
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    asked.push(method);
    if (method === 'getMultipleAccounts') {
      const decimals = new Uint8Array(82);
      decimals[44] = 6;
      return { value: (params[0] as string[]).map((a) => (mints.has(a) ? { ...tokenAccount(0n), data: [Buffer.from(decimals).toString('base64'), 'base64'] } : tokenAccount(5_000_000_000n))) };
    }
    if (method === 'getTokenAccountsByOwner') {
      if ((params[1] as { programId: string }).programId !== b58(TOKEN)) return { value: [] };
      return { value: accounts.map((a) => ({ pubkey: b58(ata(a.mint, owner)), account: tokenAccount(a.amount, a.mint, owner) })) };
    }
    if (method === 'getLatestBlockhash' && tested) return { value: { blockhash: b58(key()) } };
    if (method === 'simulateTransaction' && tested) tested.push(params[0] as string);
    if (method === 'getLatestBlockhash' || method === 'simulateTransaction') throw new Error(REACHED);
    throw new Error(`unexpected ${method}`);
  });
  return { rpc, asked };
}

/** Jupiter's event account, one address as on mainnet. */
const EVENTS = key();

function routeData(shared: boolean, inAmount: bigint, quoted: bigint, slippageBps: number): Buffer {
  const at = shared ? 9 : 8;
  const data = Buffer.alloc(at + 22 + 4);
  Buffer.from(shared ? SHARED_ACCOUNTS_ROUTE_V2 : ROUTE_V2).copy(data, 0);
  data.writeBigUInt64LE(inAmount, at);
  data.writeBigUInt64LE(quoted, at + 8);
  data.writeUInt16LE(slippageBps, at + 16);
  return data;
}

/**
 * Jupiter's API, building an honest route for every quote: the user's two accounts, the two coins
 * and one pool. `names` adds accounts to every leg that sells `from`. Selling `dear` pays double.
 */
function jupiter(o: { names?: { from: PublicKey; keys: PublicKey[] }; dear?: PublicKey; dexes?: Record<string, { program: PublicKey; pool: PublicKey }>; prices?: Record<string, number> }) {
  const asked: boolean[] = [];
  const quote = async (p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; dexes?: readonly string[] }): Promise<JupiterQuote> => {
    const dex = p.dexes?.[0];
    return {
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      inAmount: String(p.amount),
      outAmount: String(o.dear && p.inputMint === b58(o.dear) ? p.amount * 2n : p.amount),
      otherAmountThreshold: '0',
      swapMode: 'ExactIn',
      slippageBps: p.slippageBps,
      routePlan: [{ swapInfo: { label: dex ?? 'Elsewhere', ammKey: b58(dex ? o.dexes![dex]!.pool : key()) } }],
    };
  };
  const swapInstructions = async (q: JupiterQuote, user: PublicKey, opts?: { shared?: boolean }): Promise<SwapInstructions> => {
    const shared = opts?.shared === true;
    asked.push(shared);
    const [inMint, outMint] = [new PublicKey(q.inputMint), new PublicKey(q.outputMint)];
    const step = q.routePlan[0]!.swapInfo!;
    const venue = [o.dexes?.[step.label!]?.program ?? key(), new PublicKey(step.ammKey!)];
    const named = o.names && b58(o.names.from) === q.inputMint ? o.names.keys : [];
    const keys = shared
      ? [key(), user, ata(inMint, user), key(), key(), ata(outMint, user), inMint, outMint, ...venue, ...named]
      : [user, ata(inMint, user), ata(outMint, user), inMint, outMint, TOKEN, TOKEN, JUPITER_PROGRAM, EVENTS, JUPITER_PROGRAM, ...venue, ...named];
    return {
      swap: new TransactionInstruction({ programId: JUPITER_PROGRAM, keys: keys.map((pubkey) => ({ pubkey, isSigner: pubkey.equals(user), isWritable: true })), data: routeData(shared, BigInt(q.inAmount), BigInt(q.outAmount), q.slippageBps) }),
      lookupTables: [],
      extra: 0,
    };
  };
  const labels = async () => Object.fromEntries(Object.entries(o.dexes ?? {}).map(([label, d]) => [b58(d.program), label]));
  const prices = async (ids: string[]) => Object.fromEntries(ids.map((m) => [m, o.prices?.[m] ?? 100]));
  return { api: { quote, swapInstructions, labels, prices } as unknown as JupiterApi, asked };
}

/** One of our pools on the public fee tier, `quote` against `token`, both sides plain tokens. */
function ourPool(quote: QuoteCoin, token: PublicKey): PoolView {
  return {
    address: b58(key()),
    tokenMint: b58(token),
    quote,
    quoteIsToken0: true,
    vaultsFrozen: false,
    quoteReserve: 1n,
    tokenReserve: 1n,
    config: {},
    snapshot: { pool: { token0Mint: quote.mint, token1Mint: b58(token), token0Program: b58(TOKEN), token1Program: b58(TOKEN), token0Vault: b58(key()), token1Vault: b58(key()), ammConfig: b58(TIERS[1]), observationKey: b58(key()) } },
  } as unknown as PoolView;
}

const arb = (side: 'buy' | 'sell'): Arbitrage => ({ side, gap: 0.05, profitUsd: 0.4, tradeUsd: 20 }) as unknown as Arbitrage;
const BAYLA = new PublicKey(BAYLA_QUOTE.mint);
const USDC = new PublicKey(USDC_QUOTE.mint);
const PATHS = ['jupiter-sell', 'jupiter-buy', 'via-first', 'via-last', 'outside-first', 'outside-last'] as const;

/**
 * One pass with one trip on offer, the keeper holding `held`: what it logged and whether the trip
 * reached its build. The route of the leg the path names (a trip against Jupiter has one Jupiter
 * leg, the others two: first or last) also names `named`. Given `tested`, the trip goes on to its test run.
 */
async function trip(path: (typeof PATHS)[number], named: PublicKey[], held: (owner: PublicKey, token: PublicKey) => Set<string> | undefined, tested?: string[]) {
  const owner = key();
  const token = key();
  const { rpc, asked } = chain(owner, [], tested);
  const log = vi.fn();
  const dexes = { DexA: { program: key(), pool: key() }, DexB: { program: key(), pool: key() } };
  const sells = path === 'jupiter-buy' || path === 'via-last' || path === 'outside-last' ? token : SOL;
  const j = jupiter({ names: { from: sells, keys: named }, dear: token, dexes });
  let takes: (() => Promise<OutsideTake[]>) | undefined;
  gaps.clear();
  if (path === 'outside-first' || path === 'outside-last') {
    pools = [];
    const legs: OutsideTake['legs'] = [{ pool: b58(dexes.DexA.pool), program: b58(dexes.DexA.program) }, { pool: b58(dexes.DexB.pool), program: b58(dexes.DexB.program) }];
    takes = async () => [{ coinMint: SOL_QUOTE.mint, tokenMint: b58(token), legs, inRaw: 100_000_000n, netUsd: 1 }];
  } else {
    const pool = ourPool(path.startsWith('via') ? BAYLA_QUOTE : SOL_QUOTE, token);
    pools = [pool];
    gaps.set(pool.address, arb(path === 'jupiter-sell' ? 'sell' : 'buy'));
  }
  await runCycle({ rpc, jupiter: j.api, owner, indexFetch: fetch, log, held: held(owner, token), takes }, settings);
  const lines = log.mock.calls.map((c) => String(c[0]));
  return { lines, built: asked.includes('getLatestBlockhash'), asked: j.asked };
}

/** What the keeper holds: its accounts of both floats, of the trip's token and of BAYLA, and the account `leftover`. */
const holding = (leftover: PublicKey) => (owner: PublicKey, token: PublicKey) => new Set([...[SOL, USDC, token, BAYLA].map((m) => b58(ata(m, owner))), b58(leftover)]);

describe('a Jupiter leg that names a token account the keeper holds', () => {
  it.each(PATHS)('%s: refused, asked again through Jupiter’s shared accounts, and refused again', async (path) => {
    const leftover = key();
    const r = await trip(path, [leftover], holding(leftover));
    expect(r.lines.some((l) => l.includes(NAMES_OTHER_ACCOUNT))).toBe(true);
    expect(r.asked.slice(-2)).toEqual([false, true]);
    expect(r.built).toBe(false);
  });

  it.each(PATHS)('%s: the same leg naming none reaches the build, its own two accounts held', async (path) => {
    const r = await trip(path, [], holding(key()));
    expect(r.lines.some((l) => l.includes(REACHED))).toBe(true);
    expect(r.built).toBe(true);
  });

  it('refuses every leg while the keeper’s own token accounts are unread', async () => {
    const r = await trip('jupiter-sell', [], () => undefined);
    expect(r.lines.some((l) => /token accounts were not read/.test(l))).toBe(true);
    expect(r.built).toBe(false);
  });
});

describe('the leftover sale', () => {
  it('adds every account it reads to the list, and refuses a sale whose route names another leftover', async () => {
    const owner = key();
    const [a, b] = [key(), key()];
    const read = [SOL, USDC, a, b].map((mint) => ({ mint, amount: 5_000_000_000n }));
    const { rpc, asked } = chain(owner, read);
    // A leftover's 5,000 coins at $0.10 are worth 5 SOL at $100: Jupiter's one for one.
    const j = jupiter({ names: { from: a, keys: [ata(b, owner)] }, prices: { [b58(a)]: 0.1, [b58(b)]: 0.1 } });
    const log = vi.fn();
    const held = new Set<string>();
    await sellDust({ rpc, jupiter: j.api, owner, indexFetch: fetch, log, held }, settings);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect([...held].sort()).toEqual(read.map((t) => b58(ata(t.mint, owner))).sort());
    expect(lines.find((l) => l.includes(b58(a)))).toContain(NAMES_OTHER_ACCOUNT);
    expect(lines.find((l) => l.includes(b58(b)))).toContain(REACHED);
    expect(asked.filter((m) => m === 'getLatestBlockhash')).toHaveLength(1);
  });
});

describe('a Jupiter leg that names the venue’s pool program or a fee tier', () => {
  const SAID = 'venue’s pool program or one of its fee tiers';

  it.each(PATHS)('%s: refused at once, with no venue refused', async (path) => {
    const r = await trip(path, [POOL_PROGRAM, ...TIERS], holding(key()));
    expect(r.lines.some((l) => l.includes(SAID))).toBe(true);
    expect(r.asked.at(-1)).toBe(false);
    expect(r.built).toBe(false);
  });

  it('the leftover sale: refused', async () => {
    const owner = key();
    const [a, b] = [key(), key()];
    const { rpc } = chain(owner, [a, b].map((mint) => ({ mint, amount: 5_000_000_000n })));
    const j = jupiter({ names: { from: a, keys: [POOL_PROGRAM] }, prices: { [b58(a)]: 0.1, [b58(b)]: 0.1 } });
    const log = vi.fn();
    await sellDust({ rpc, jupiter: j.api, owner, indexFetch: fetch, log, held: new Set() }, settings);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.find((l) => l.includes(b58(a)))).toContain(SAID);
    expect(lines.find((l) => l.includes(b58(b)))).toContain(REACHED);
  });

  // The keeper's own pool legs are its own (cycle.ts ownSwap), never Jupiter's, so they are not held to this.
  it.each(['jupiter-sell', 'jupiter-buy', 'via-first'] as const)('%s: the keeper’s own leg names both, and the trip goes on to its test run', async (path) => {
    const tested: string[] = [];
    const r = await trip(path, [], holding(key()), tested);
    expect(r.lines.some((l) => l.includes(REACHED))).toBe(true);
    const tx = VersionedTransaction.deserialize(Buffer.from(tested[0]!, 'base64'));
    const keys = tx.message.staticAccountKeys.map(b58);
    const calls = (program: PublicKey) => tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === b58(program));
    expect(calls(POOL_PROGRAM)).toHaveLength(1);
    expect(calls(POOL_PROGRAM)[0]!.accountKeyIndexes.map((i) => keys[i])).toContain(b58(TIERS[1]));
    expect(calls(JUPITER_PROGRAM).length).toBeGreaterThan(0);
  });
});

describe('sendChecked', () => {
  it('adds a sent trip’s accounts to the list', async () => {
    const owner = key();
    const accounts = { coinAta: key(), tokenAta: key(), otherAta: key(), tokenMint: key(), tokenProgram: TOKEN, coinMint: SOL };
    const rpc = vi.fn(async (method: string) => {
      if (method === 'getLatestBlockhash') return { value: { blockhash: b58(key()) } };
      if (method === 'simulateTransaction') return { value: { err: null, unitsConsumed: 200_000, accounts: [tokenAccount(1_100_000n), tokenAccount(0n), tokenAccount(0n), tokenAccount(0n)] } };
      if (method === 'getMultipleAccounts') return { value: [tokenAccount(1_000_000n), null, tokenAccount(0n), tokenAccount(0n)] };
      throw new Error(`unexpected ${method}`);
    });
    const held = new Set<string>();
    const send = vi.fn(async () => ({ signature: 'sig', outcome: 'confirmed' as const }));
    const r = await sendChecked({ rpc, owner, log: vi.fn(), send, held } as never, settings, {
      name: 'T',
      kind: 'jupiter',
      pool: 'POOL',
      coin: SOL_QUOTE,
      coinIn: 10_000n,
      accounts,
      before: { coin: 1_000_000n, token: 0n, tokenExists: false, other: 0n, otherExists: true, lamports: 50_000_000n },
      legs: [new TransactionInstruction({ programId: key(), keys: [], data: Buffer.from([1]) })],
      lookupTables: [],
      floor: 50_000n,
      verdict: () => null,
      says: () => 'sent',
    });
    expect(r).toBe('sent');
    expect([...held].sort()).toEqual([accounts.coinAta, accounts.tokenAta, accounts.otherAta].map(b58).sort());
  });
});
