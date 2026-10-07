// @vitest-environment node
//
// Our pools for a swap pair: found wherever they sit, each quoted with its own fee tier on
// the chain's clock, and "no pool" said only after a search that read everything.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodePoolState } from '../cpswap/program';
import { findPools, readPools } from '../lp/poolFinder';
import { readTokenSafety, BAYLA_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from '../lp/tokenSafety';
import { USDC_QUOTE } from '../lp/quotes';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, configBytes, fakeIndex, fakeRpc, key, mintBytes, type BuiltPool, type FakeAccount } from '../lp/testkit.fixture';
import { OWN_EXCLUDED, OWN_GAPS, ownPair, pickOwnPool, quoteOwnPools, searchOwnPools, type OwnPoolReaders } from './ownPools';

const SOL = 1_000_000_000n;
const CHAIN_NOW = 1_000n;

function readers(accounts: Record<string, FakeAccount>, index: Record<string, string[]> = {}, o: { indexStatus?: number; truncated?: boolean; fail?: Set<string> } = {}): OwnPoolReaders {
  const rpc = fakeRpc(accounts, { fail: o.fail });
  const opts = { programId: PROGRAM, launchProgramId: LAUNCH, fetchImpl: fakeIndex(index, { status: o.indexStatus, truncated: o.truncated }) };
  return {
    findPools: (mint) => findPools(rpc, mint, opts),
    readPools: (addresses) => readPools(rpc, addresses, opts),
    safety: (mints) => readTokenSafety(rpc, mints),
  };
}

/** The program's own maths, written out: the trade fee rounds up, the output down. */
function expectedOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: bigint): bigint {
  const fee = (amountIn * tradeFeeRate + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
}

/** A tier's own fee settings, put in the pool's config account. */
function withConfig(b: BuiltPool, index: number, tradeFeeRate: bigint): BuiltPool {
  b.accounts[b.config.toBase58()] = { owner: PROGRAM.toBase58(), data: configBytes(index, tradeFeeRate, 120_000n) };
  return b;
}

const classicMint = (decimals = 6): FakeAccount => ({ owner: TOKEN_PROGRAM, data: mintBytes(null, decimals) });

describe('ownPair', () => {
  it('reads a pair the way the pools do: the higher pairing coin is the quote', () => {
    const x = key().toBase58();
    expect(ownPair(WSOL_MINT, x)).toEqual({ quote: expect.objectContaining({ symbol: 'SOL' }), tokenMint: x });
    expect(ownPair(x, USDC_MINT)).toEqual({ quote: USDC_QUOTE, tokenMint: x });
    expect(ownPair(BAYLA_MINT, WSOL_MINT)?.tokenMint).toBe(BAYLA_MINT);
    expect(ownPair(BAYLA_MINT, USDC_MINT)).toEqual({ quote: USDC_QUOTE, tokenMint: BAYLA_MINT });
  });

  it('two tokens with no pairing coin, or one mint twice, are no pair of ours', () => {
    const x = key().toBase58();
    expect(ownPair(x, key().toBase58())).toBeNull();
    expect(ownPair(x, x)).toBeNull();
  });
});

describe('searchOwnPools and quoteOwnPools', () => {
  it('finds both of our pools for the pair and picks the one that pays more, though it is not the deepest', async () => {
    const mint = key();
    // Deepest, on the public tier at 1%.
    const deep = withConfig(buildPool({ mint, configIndex: 1, quoteReserve: 100n * SOL, tokenReserve: 10_000_000_000n }), 1, 10_000n);
    // Shallower, at its own address, on tier 0 at 0.25%: better for a small trade.
    const cheap = withConfig(buildPool({ mint, configIndex: 0, address: Keypair.generate().publicKey, quoteReserve: 50n * SOL, tokenReserve: 5_000_000_000n }), 0, 2_500n);
    const r = readers(
      { ...deep.accounts, ...cheap.accounts, [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) },
      { [`mint:${mint.toBase58()}`]: [cheap.address.toBase58()] },
    );
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    expect(s.kind).toBe('ok');
    if (s.kind !== 'ok') return;
    // The finder lists the deepest first: the pick must not lean on that order.
    expect(s.search.addresses).toEqual([deep.address.toBase58(), cheap.address.toBase58()]);
    expect(s.search.gaps).toEqual([]);
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL / 10n);
    expect(q.kind).toBe('ok');
    if (q.kind !== 'ok') return;
    expect(q.quotes.found).toBe(2);
    expect(q.quotes.best?.view.address).toBe(cheap.address.toBase58());
    expect(q.quotes.best?.quote.outAmount).toBe(expectedOut(SOL / 10n, 50n * SOL, 5_000_000_000n, 2_500n));
    expect(q.quotes.excluded).toEqual([]);
  });

  it('the BAYLA/SOL pool on the public tier is found and quoted with ITS tier, not tier 0', async () => {
    const bayla = new PublicKey(BAYLA_MINT);
    const pool = withConfig(buildPool({ mint: bayla, configIndex: 1, tokenProgram: TOKEN_2022_PROGRAM, quoteReserve: 20n * SOL, tokenReserve: 30_000_000_000_000n }), 1, 10_000n);
    const r = readers({ ...pool.accounts, [BAYLA_MINT]: { owner: TOKEN_2022_PROGRAM, data: mintBytes(null, 6) }, [CLOCK]: clockAccount(CHAIN_NOW) });
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, BAYLA_MINT)!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL);
    if (q.kind !== 'ok') throw new Error(q.detail);
    expect(q.quotes.best?.view.address).toBe(pool.address.toBase58());
    expect(q.quotes.best?.view.config?.index).toBe(1);
    expect(q.quotes.best?.quote.outAmount).toBe(expectedOut(SOL, 20n * SOL, 30_000_000_000_000n, 10_000n));
    // A sale the other way is quoted from the same pool.
    const sale = await quoteOwnPools(r, s.search, BAYLA_MINT, 1_000_000_000n);
    expect(sale.kind === 'ok' && sale.quotes.best?.quote.outAmount).toBe(expectedOut(1_000_000_000n, 30_000_000_000_000n, 20n * SOL, 10_000n));
  });

  it("a pool not open yet by the CHAIN's clock is not quoted, whatever the viewer's clock says", async () => {
    const mint = key();
    // Opens at 2,000: after the chain's 1,000, long before the viewer's clock.
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000_000n, openTime: 2_000n });
    const r = readers({ ...pool.accounts, [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) });
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL);
    expect(q.kind === 'ok' && q.quotes).toMatchObject({ found: 1, best: null, excluded: [{ address: pool.address.toBase58(), reason: OWN_EXCLUDED.cannotPrice }] });
  });

  it('a pool of the same token with another coin is not this pair', async () => {
    const mint = key();
    const solPool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000_000n });
    const usdcPool = buildPool({ mint, quote: USDC_QUOTE, quoteReserve: 1_000_000_000n, tokenReserve: 1_000_000_000n });
    const r = readers({ ...solPool.accounts, ...usdcPool.accounts, [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) });
    const s = await searchOwnPools(r, ownPair(mint.toBase58(), USDC_MINT)!);
    expect(s.kind === 'ok' && s.search.addresses).toEqual([usdcPool.address.toBase58()]);
  });

  it('a complete search that read every place and found nothing is a finding: no pools, no gaps', async () => {
    const mint = key();
    const r = readers({ [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) });
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    expect(s.search).toMatchObject({ addresses: [], gaps: [] });
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL);
    expect(q).toEqual({ kind: 'ok', quotes: { found: 0, gaps: [], best: null, excluded: [] } });
  });

  it('an index that could not be read, or that was cut short, leaves a gap: never a clean "no pool"', async () => {
    const mint = key();
    const accounts = { [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) };
    const down = await searchOwnPools(readers(accounts, {}, { indexStatus: 502 }), ownPair(WSOL_MINT, mint.toBase58())!);
    expect(down.kind === 'ok' && down.search.gaps).toEqual([OWN_GAPS.index('the pool index answered HTTP 502')]);
    const cut = await searchOwnPools(readers(accounts, {}, { truncated: true }), ownPair(WSOL_MINT, mint.toBase58())!);
    expect(cut.kind === 'ok' && cut.search.gaps).toEqual([OWN_GAPS.truncated]);
  });

  it('a pool that cannot be read when quoting leaves a gap, and the others are still quoted', async () => {
    const mint = key();
    const a = buildPool({ mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000_000_000n });
    const b = buildPool({ mint, configIndex: 0, quoteReserve: 5n * SOL, tokenReserve: 500_000_000n });
    const accounts = { ...a.accounts, ...b.accounts, [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) };
    const r = readers(accounts);
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    // b's token vault goes missing between the search and the quote.
    delete accounts[tokenVaultOf(b)];
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL / 10n);
    expect(q.kind === 'ok' && q.quotes).toMatchObject({ found: 1, gaps: [OWN_GAPS.unread(1)], best: { view: { address: a.address.toBase58() } } });
  });

  it('a pool that could not be read in the search is read again when quoting; still unread, it is a gap', async () => {
    const mint = key();
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000_000n });
    const accounts = { ...pool.accounts, [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) };
    const tokenVault = tokenVaultOf(pool);
    const kept = accounts[tokenVault]!;
    delete accounts[tokenVault];
    const r = readers(accounts);
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    expect(s.search.addresses).toEqual([pool.address.toBase58()]);
    expect(await quoteOwnPools(r, s.search, WSOL_MINT, SOL)).toEqual({ kind: 'ok', quotes: { found: 0, gaps: [OWN_GAPS.unread(1)], best: null, excluded: [] } });
    // Readable again: quoted.
    accounts[tokenVault] = kept;
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL);
    expect(q.kind === 'ok' && q.quotes).toMatchObject({ found: 1, gaps: [], best: { view: { address: pool.address.toBase58() } } });
  });

  it('a pool read again when quoting that turns out to pair another coin is not counted for this pair', async () => {
    const mint = key();
    const solPool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000_000n });
    const usdcPool = buildPool({ mint, quote: USDC_QUOTE, quoteReserve: 1_000_000_000n, tokenReserve: 1_000_000_000n });
    const accounts = { ...solPool.accounts, ...usdcPool.accounts, [mint.toBase58()]: classicMint(), [CLOCK]: clockAccount(CHAIN_NOW) };
    const tokenVault = tokenVaultOf(usdcPool);
    const kept = accounts[tokenVault]!;
    delete accounts[tokenVault];
    const r = readers(accounts);
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    // Unread, it might have been this pair's: it is kept to be read again.
    expect(s.search.addresses).toEqual([solPool.address.toBase58(), usdcPool.address.toBase58()]);
    accounts[tokenVault] = kept;
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL);
    expect(q.kind === 'ok' && q.quotes).toMatchObject({ found: 1, gaps: [], excluded: [], best: { view: { address: solPool.address.toBase58() } } });
  });

  it('a search whose chain read fails is unread, never an empty result', async () => {
    const mint = key();
    const r = readers({ [mint.toBase58()]: classicMint() }, {}, { fail: new Set(['getMultipleAccounts']) });
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    expect(s.kind).toBe('unread');
  });

  it('a token this site does not build for (a transfer fee) excludes every pool, with the reason', async () => {
    const mint = key();
    const pool = buildPool({ mint, tokenProgram: TOKEN_2022_PROGRAM, quoteReserve: 10n * SOL, tokenReserve: 1_000_000_000n });
    const r = readers({ ...pool.accounts, [mint.toBase58()]: { owner: TOKEN_2022_PROGRAM, data: transferFeeMint() }, [CLOCK]: clockAccount(CHAIN_NOW) });
    const s = await searchOwnPools(r, ownPair(WSOL_MINT, mint.toBase58())!);
    if (s.kind !== 'ok') throw new Error(s.detail);
    const q = await quoteOwnPools(r, s.search, WSOL_MINT, SOL);
    expect(q.kind === 'ok' && q.quotes).toMatchObject({ found: 1, best: null, excluded: [{ address: pool.address.toBase58(), reason: OWN_EXCLUDED.tokenBlocked }] });
  });
});

describe('pickOwnPool: what may fill, and which wins', () => {
  const mint = key();
  const views = async (...pools: BuiltPool[]) => {
    const accounts = Object.assign({ [CLOCK]: clockAccount(CHAIN_NOW) }, ...pools.map((p) => p.accounts));
    const read = await readPools(fakeRpc(accounts), pools.map((p) => p.address.toBase58()), { programId: PROGRAM, launchProgramId: LAUNCH });
    if (read.kind !== 'ok') throw new Error(read.detail);
    return read.entries.map((e) => (e.kind === 'pool' ? e.view : (() => { throw new Error(e.kind); })()));
  };
  const okToken = { kind: 'read', verdict: 'ok' } as Parameters<typeof pickOwnPool>[2];

  it('each pool that cannot fill says why', async () => {
    const frozen = buildPool({ mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1n * SOL, frozenVault: true });
    const off = buildPool({ mint, configIndex: 0, address: key(), quoteReserve: 10n * SOL, tokenReserve: 1n * SOL, status: 4 });
    // On a tier of its own, so the config account that goes missing is only its own.
    const noFees = buildPool({ mint, configIndex: 2, address: key(), quoteReserve: 10n * SOL, tokenReserve: 1n * SOL });
    delete noFees.accounts[noFees.config.toBase58()];
    const [f, o, n] = await views(frozen, off, noFees);
    const pick = pickOwnPool([f!, o!, n!], CHAIN_NOW, okToken, WSOL_MINT, SOL);
    expect(pick).toEqual({
      best: null,
      excluded: [
        { address: frozen.address.toBase58(), reason: OWN_EXCLUDED.frozen },
        { address: off.address.toBase58(), reason: OWN_EXCLUDED.cannotPrice },
        { address: noFees.address.toBase58(), reason: OWN_EXCLUDED.feesUnread },
      ],
    });
  });

  it('without the chain clock nothing is quoted, and an unread token excludes every pool', async () => {
    const [v] = await views(buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1n * SOL }));
    expect(pickOwnPool([v!], null, okToken, WSOL_MINT, SOL).excluded).toEqual([{ address: v!.address, reason: OWN_EXCLUDED.clockUnread }]);
    expect(pickOwnPool([v!], CHAIN_NOW, { kind: 'unread', mint: mint.toBase58(), detail: 'x' }, WSOL_MINT, SOL).excluded).toEqual([{ address: v!.address, reason: OWN_EXCLUDED.tokenUnread }]);
  });

  it('an amount too small to pay anything is excluded, not quoted at zero', async () => {
    const [v] = await views(buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000n }));
    expect(pickOwnPool([v!], CHAIN_NOW, okToken, WSOL_MINT, 1_000n).excluded).toEqual([{ address: v!.address, reason: OWN_EXCLUDED.paysNothing }]);
  });

  it('equal output: the deeper pairing-coin side wins, then the lower address', async () => {
    // Same price, same tier: a small trade pays the same in both after rounding.
    const shallow = buildPool({ mint, configIndex: 1, quoteReserve: 1_000n * SOL, tokenReserve: 1_000n * SOL });
    const deep = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 1_001n * SOL, tokenReserve: 1_001n * SOL });
    const [s, d] = await views(shallow, deep);
    const amount = 1_000n;
    expect(pickOwnPool([s!, d!], CHAIN_NOW, okToken, WSOL_MINT, amount).best?.quote.outAmount).toBe(pickOwnPool([s!], CHAIN_NOW, okToken, WSOL_MINT, amount).best?.quote.outAmount);
    // The deeper one wins even with the higher address.
    const [low, high] = [{ ...s!, address: '1'.repeat(32) }, { ...d!, address: 'z'.repeat(32) }];
    expect(pickOwnPool([low, high], CHAIN_NOW, okToken, WSOL_MINT, amount).best?.view.address).toBe('z'.repeat(32));
    const twin = { ...s!, address: '1'.repeat(32) };
    expect(pickOwnPool([s!, twin], CHAIN_NOW, okToken, WSOL_MINT, amount).best?.view.address).toBe('1'.repeat(32));
  });
});

/** The address of a built pool's token-side vault, read from the pool's own bytes. */
function tokenVaultOf(b: BuiltPool): string {
  const pool = Object.entries(b.accounts).find(([a]) => a === b.address.toBase58())![1];
  const read = decodePoolState(b.address.toBase58(), pool.data)!;
  return readPairOf(read.token0Mint, read.token1Mint) ? read.token1Vault : read.token0Vault;
}

/** True when token0 is the pairing coin, so the token sits on side 1. */
function readPairOf(token0Mint: string, token1Mint: string): boolean {
  return ownPair(token0Mint, token1Mint)!.tokenMint === token1Mint;
}

/** A Token-2022 mint carrying a transfer-fee setting (extension type 1). */
function transferFeeMint(): Uint8Array {
  const out = new Uint8Array(166 + 4 + 108);
  out.set(mintBytes(null, 6), 0);
  out[165] = 1;
  const v = new DataView(out.buffer);
  v.setUint16(166, 1, true);
  v.setUint16(168, 108, true);
  return out;
}
