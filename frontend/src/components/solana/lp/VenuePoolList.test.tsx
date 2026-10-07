// The venue's pool list, the component half (DESIGN 2.C3). What a visitor sees before any
// token is typed: one row per pool, grouped SOL then USDC then BAYLA and deepest first
// within a coin (the reader's order, never re-ranked here), each headed by its pair and
// tier from the site's registry, never from the token's own words. A blocked token is
// listed last under its short mint. An index that did not answer is "could not be
// listed", never "no pools". No outside price is ever read for the list; with USD_LINES
// off no "about $" line and no price call; a price of 0 is no line, never "$0".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PublicKey } from '@solana/web3.js';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import { BUNGALOWS } from '../../../lib/bungalows';
import { FORECAST_WORDS, formatSolPrice, quoteText, shortAddress } from '../../../lib/solana/lp/format';
import type { PoolOrigin, PoolView } from '../../../lib/solana/lp/poolFinder';
import type { PoolList, PoolListRead } from '../../../lib/solana/lp/poolList';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { UsdPerCoin } from '../../../lib/solana/lp/usd';
import type { LpReaders } from './readers';
import type { UsdPricesRead } from './useUsdPrices';
import { VenuePoolList } from './VenuePoolList';

// The dollar prices behind the "about $" lines: the real hook (USD_LINES off, no fetch)
// unless a test hands in prices, which stands for the switch being on with a read landed.
const usd = vi.hoisted(() => ({ read: null as UsdPricesRead | null }));
vi.mock('./useUsdPrices', async (orig) => {
  const mod = await orig<typeof import('./useUsdPrices')>();
  return {
    ...mod,
    useUsdPrices: (k: number) => {
      const real = mod.useUsdPrices(k);
      return usd.read ?? real;
    },
  };
});

const bayla = BUNGALOWS.find((b) => b.id === 'bayla' && b.chain === 'solana' && b.address);
if (!bayla?.address) throw new Error('the BAYLA room has no Solana mint');
const BAYLA = bayla.address;
const UNIT = 10n ** 6n;
const SOL = 10n ** 9n;

/** A pool of `mint` paired with `coin`, `quoteReserve` of the coin against `tokenReserve` tokens (6 decimals). */
function view(coin: QuoteCoin, mint: PublicKey | string, quoteReserve: bigint, tokenReserve: bigint, origin: PoolOrigin = 'standard'): PoolView {
  const mintKey = typeof mint === 'string' ? key() : mint;
  const b = buildPool({ plain: true, mint: mintKey, quote: coin, configIndex: 1, quoteReserve, tokenReserve, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint === coin.mint;
  const tokenMint = typeof mint === 'string' ? mint : mint.toBase58();
  return {
    address: b.address.toBase58(),
    origin,
    snapshot: {
      // A registry mint cannot be put into the fixture's bytes (its key is given, not derived), so the mints are set here.
      pool: { ...pool, token0Mint: quoteIsToken0 ? coin.mint : tokenMint, token1Mint: quoteIsToken0 ? tokenMint : coin.mint },
      vault0Amount: quoteIsToken0 ? quoteReserve : tokenReserve,
      vault1Amount: quoteIsToken0 ? tokenReserve : quoteReserve,
      reserve0: quoteIsToken0 ? quoteReserve : tokenReserve,
      reserve1: quoteIsToken0 ? tokenReserve : quoteReserve,
    },
    config,
    tokenMint,
    quote: coin,
    quoteIsToken0,
    quoteReserve,
    tokenReserve,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}

const read = (mint: string, o: { verdict?: 'ok' | 'warn' | 'blocked'; name?: string; symbol?: string; decimals?: number | null } = {}): TokenSafety => ({
  kind: 'read',
  mint,
  verdict: o.verdict ?? 'ok',
  blocks: [],
  warnings: [],
  name: o.name ?? 'Corn',
  symbol: o.symbol ?? 'CORN',
  metadataSource: 'metaplex',
  facts:
    o.decimals === null
      ? null
      : { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: o.decimals ?? 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

const ok = (pools: PoolView[], o: Partial<Omit<PoolList, 'pools'>> = {}): PoolListRead => ({
  kind: 'ok',
  list: { pools, unread: 0, otherPairs: 0, truncated: false, chainNow: 1_000n, ...o },
});

function readers(o: { list?: () => Promise<PoolListRead>; safety?: (mints: string[]) => Promise<Map<string, TokenSafety>> } = {}): LpReaders {
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(o.safety ?? (async (mints: string[]) => new Map(mints.map((m) => [m, read(m)])))),
    findPools: vi.fn(async () => { throw new Error('the list never looks a token up'); }),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 1, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not read in these tests' })),
    wallet: vi.fn(async () => { throw new Error('not read in these tests'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not read in these tests'); }),
    listPools: vi.fn(o.list ?? (async () => ok([]))),
  };
}

const card = () => screen.getByTestId('lp-venue-pools');
const rows = () => within(card()).queryAllByTestId('lp-venue-pool');
const again = () => within(card()).getByRole('button', { name: /^Read again/ });
/** Render and let the reads land (promises only, no timers). */
async function mount(r: LpReaders, onPick = vi.fn(), reloadKey = 0) {
  const view = render(<VenuePoolList readers={r} reloadKey={reloadKey} onPick={onPick} />);
  await act(async () => {});
  await act(async () => {});
  return view;
}

const PRICES_ON = (prices: Partial<UsdPerCoin>): UsdPricesRead => ({ prices: { SOL: null, USDC: null, BAYLA: null, ...prices }, readAt: Date.now() });

beforeEach(() => {
  usd.read = null;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the four states, in the design’s words', () => {
  it('reading: the sentence, no rows, no "no pools"', async () => {
    const r = readers({ list: () => new Promise(() => {}) });
    await mount(r);
    expect(within(card()).getByRole('status')).toHaveTextContent('Reading the venue’s pools from the chain…');
    expect(rows()).toHaveLength(0);
    expect(card()).not.toHaveTextContent(/No pool/i);
    expect(within(card()).getByRole('heading', { level: 2 })).toHaveTextContent('Pools on the venue');
  });

  it('unread: "could not be listed" with the detail, never "no pools", and a Read again', async () => {
    const r = readers({ list: async () => ({ kind: 'unread', detail: 'the pool index did not answer in 20 seconds' }) });
    await mount(r);
    expect(within(card()).getByTestId('lp-venue-unread')).toHaveTextContent(
      'The venue’s pools could not be listed (the pool index did not answer in 20 seconds). That says nothing about how many there are.',
    );
    expect(card()).not.toHaveTextContent(/No pool/i);
    expect(rows()).toHaveLength(0);
    expect(again()).toBeInTheDocument();
  });

  it('a reader that throws is unread with the error’s words, never an empty list', async () => {
    const r = readers({ list: async () => { throw new Error('the pool index answered HTTP 502'); } });
    await mount(r);
    expect(within(card()).getByTestId('lp-venue-unread')).toHaveTextContent('could not be listed (the pool index answered HTTP 502)');
    expect(card()).not.toHaveTextContent(/No pool/i);
  });

  it('truncated: the index’s maximum is said, with the per-coin rule', async () => {
    const r = readers({ list: async () => ok([view(SOL_QUOTE, key(), 2n * SOL, 1_000n * UNIT)], { truncated: true }) });
    await mount(r);
    expect(within(card()).getByTestId('lp-venue-notes')).toHaveTextContent(
      'Our pool index returned its maximum, so there are more pools on the venue than this list. For each coin, the pools holding the most of it are here.',
    );
    expect(rows()).toHaveLength(1);
  });

  it('empty: no pool is open, and Create a pool opens the first', async () => {
    await mount(readers());
    expect(within(card()).getByTestId('lp-venue-empty')).toHaveTextContent('No pool is open on the venue yet. Create a pool, above, opens the first one.');
    expect(within(card()).queryByTestId('lp-venue-notes')).toBeNull();
  });

  it('every named pool unread is NOT "no pool is open": the unread count is said instead', async () => {
    const r = readers({ list: async () => ok([], { unread: 2 }) });
    await mount(r);
    expect(within(card()).queryByTestId('lp-venue-empty')).toBeNull();
    expect(card()).not.toHaveTextContent(/No pool/i);
    expect(within(card()).getByTestId('lp-venue-notes')).toHaveTextContent('2 pool(s) the index named could not be read this time and are not listed.');
  });

  it('other pairs and unread pools are counted under the rows', async () => {
    const r = readers({ list: async () => ok([view(SOL_QUOTE, key(), SOL, UNIT)], { unread: 1, otherPairs: 3 }) });
    await mount(r);
    const notes = within(card()).getByTestId('lp-venue-notes');
    expect(notes).toHaveTextContent('1 pool(s) the index named could not be read this time and are not listed.');
    expect(notes).toHaveTextContent('3 pool(s) on the venue pair two tokens with none of SOL, USDC or BAYLA. This site does not read those pools.');
  });

  it('the footnote says how the list is made, under every answered list', async () => {
    await mount(readers({ list: async () => ok([view(SOL_QUOTE, key(), SOL, UNIT)]) }));
    expect(card()).toHaveTextContent(
      'Listed from our pool index, then each pool read and checked on the chain. The index can leave a pool out; it cannot add one that is not on the chain.',
    );
  });

  it('no venue list at all without a listPools reader', async () => {
    const r = readers();
    delete r.listPools;
    render(<VenuePoolList readers={r} reloadKey={0} onPick={vi.fn()} />);
    expect(screen.queryByTestId('lp-venue-pools')).toBeNull();
  });
});

describe('the rows', () => {
  it('two pools of one coin come deepest first, and a USDC pool with more units than any SOL pool still comes after every SOL pool', async () => {
    const deep = view(SOL_QUOTE, key(), 2n * SOL, 1_000n * UNIT);
    const shallow = view(SOL_QUOTE, key(), SOL, 1_000n * UNIT);
    // 5,000 USDC: more base units and more whole coins than 2 SOL. Still after every SOL pool.
    const usdc = view(USDC_QUOTE, key(), 5_000n * UNIT, 1_000n * UNIT);
    const r = readers({ list: async () => ok([deep, shallow, usdc]) });
    await mount(r);
    expect(rows().map((el) => el.getAttribute('data-pool'))).toEqual([deep.address, shallow.address, usdc.address]);
    expect(rows().map((el) => el.getAttribute('data-quote'))).toEqual(['SOL', 'SOL', 'USDC']);
    expect(rows()[0]).toHaveTextContent('2 SOL');
    expect(rows()[1]).toHaveTextContent('1 SOL');
    expect(rows()[2]).toHaveTextContent('5,000 USDC');
  });

  it('a row: the pair and tier by registry, the depth, the pool’s own price in its coin, the origin word, and its accessible name', async () => {
    // 2 SOL against 435,000 BAYLA: 1 BAYLA = 0.000004598 SOL.
    const v = view(SOL_QUOTE, BAYLA, 2n * SOL, 435_000n * UNIT);
    const r = readers({ list: async () => ok([v]), safety: async () => new Map([[BAYLA, read(BAYLA, { name: 'Bayla Coin', symbol: 'BAYLA' })]]) });
    await mount(r);
    const row = rows()[0]!;
    expect(row).toHaveTextContent('BAYLA / SOL · 1% tier');
    expect(row).toHaveTextContent('2 SOL');
    expect(row).toHaveTextContent(`1 BAYLA = ${formatSolPrice(2 / 435_000)} SOL`);
    expect(row).toHaveTextContent('standard address');
    const button = within(row).getByRole('button');
    expect(button).toHaveAccessibleName(`Open the BAYLA / SOL pool, 1% tier, 2 SOL deep, at ${shortAddress(v.address)}`);
    // Not in the row: the full mint, the pool address, the verdict words, the fee split.
    expect(row).not.toHaveTextContent(BAYLA);
    expect(row).not.toHaveTextContent(v.address);
    expect(row).not.toHaveTextContent(/no problems found|warnings|LPs keep/i);
  });

  it('a BAYLA pool is priced in BAYLA, with its depth in BAYLA', async () => {
    const mint = key();
    const v = view(BAYLA_QUOTE, mint, 1_500n * UNIT, 3_000n * UNIT);
    await mount(readers({ list: async () => ok([v]) }));
    const row = rows()[0]!;
    expect(row).toHaveTextContent(`${shortAddress(mint.toBase58())} / BAYLA · 1% tier`);
    expect(row).toHaveTextContent('1,500 BAYLA');
    expect(row).toHaveTextContent(`1 ${shortAddress(mint.toBase58())} = 0.5 BAYLA`);
  });

  it('the origin words: launch pool, own address', async () => {
    const launch = view(SOL_QUOTE, key(), 3n * SOL, UNIT, 'launch-pool');
    const own = view(SOL_QUOTE, key(), SOL, UNIT, 'other');
    await mount(readers({ list: async () => ok([launch, own]) }));
    expect(rows()[0]).toHaveTextContent('launch pool');
    expect(rows()[1]).toHaveTextContent('own address');
  });

  it('a token whose decimals were not read: "Price not worked out", and the row stays', async () => {
    const mint = key();
    const v = view(SOL_QUOTE, mint, SOL, UNIT);
    const r = readers({ list: async () => ok([v]), safety: async () => new Map([[mint.toBase58(), { kind: 'unread', mint: mint.toBase58(), detail: 'no answer' }]]) });
    await mount(r);
    expect(rows()[0]).toHaveTextContent('Price not worked out');
    expect(rows()[0]).not.toHaveTextContent(' = ');
  });

  it('a token calling itself BAYLA at another mint is headed by its short mint, never by its claim', async () => {
    const mint = key();
    const v = view(SOL_QUOTE, mint, SOL, 1_000n * UNIT);
    const r = readers({ list: async () => ok([v]), safety: async () => new Map([[mint.toBase58(), read(mint.toBase58(), { name: 'BAYLA', symbol: 'BAYLA' })]]) });
    await mount(r);
    const row = rows()[0]!;
    expect(row).toHaveTextContent(`${shortAddress(mint.toBase58())} / SOL · 1% tier`);
    expect(row).not.toHaveTextContent('BAYLA');
  });

  it('a blocked token is listed last, headed by its short mint only, with the blocked line', async () => {
    const bad = key();
    const good = key();
    // The blocked pool is deeper and would otherwise come first.
    const blockedPool = view(SOL_QUOTE, bad, 30n * SOL, 1_000n * UNIT);
    const cleanPool = view(SOL_QUOTE, good, SOL, 1_000n * UNIT);
    const usdc = view(USDC_QUOTE, key(), 10n * UNIT, UNIT);
    const r = readers({
      list: async () => ok([blockedPool, cleanPool, usdc]),
      safety: async (mints) => new Map(mints.map((m) => [m, read(m, m === bad.toBase58() ? { verdict: 'blocked', name: 'BAYLA', symbol: 'BAYLA' } : {})])),
    });
    await mount(r);
    expect(rows().map((el) => el.getAttribute('data-pool'))).toEqual([cleanPool.address, usdc.address, blockedPool.address]);
    const last = rows()[2]!;
    expect(last).toHaveAttribute('data-blocked', 'true');
    expect(last).toHaveTextContent('Token blocked on this site');
    expect(within(last).getByTestId('lp-venue-pool-head')).toHaveTextContent(shortAddress(bad.toBase58()));
    expect(last).not.toHaveTextContent('/ SOL');
    expect(last).not.toHaveTextContent('BAYLA');
    expect(last).toHaveTextContent('30 SOL');
    expect(rows()[0]).toHaveAttribute('data-blocked', 'false');
  });

  it('a press on a row hands the finder the token and the pool', async () => {
    const mint = key();
    const v = view(SOL_QUOTE, mint, SOL, UNIT);
    const onPick = vi.fn();
    await mount(readers({ list: async () => ok([v]) }), onPick);
    fireEvent.click(within(rows()[0]!).getByRole('button'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(mint.toBase58(), v.address);
  });

  it('every row is one 56px press', async () => {
    const v = view(SOL_QUOTE, key(), SOL, UNIT);
    await mount(readers({ list: async () => ok([v]) }));
    const button = within(rows()[0]!).getByRole('button');
    expect(button.className).toContain('min-h-[56px]');
  });
});

describe('what the list reads, and does not', () => {
  it('one safety read for the unique mints; no outside price for any row', async () => {
    const shared = key();
    const pools = [view(SOL_QUOTE, shared, 2n * SOL, UNIT), view(USDC_QUOTE, shared, 10n * UNIT, UNIT), view(SOL_QUOTE, key(), SOL, UNIT)];
    const r = readers({ list: async () => ok(pools) });
    await mount(r);
    expect(rows()).toHaveLength(3);
    expect(r.safety).toHaveBeenCalledTimes(1);
    expect(vi.mocked(r.safety).mock.calls[0]![0]).toEqual([shared.toBase58(), pools[2]!.tokenMint]);
    expect(r.outsidePrice).not.toHaveBeenCalled();
    expect(r.findPools).not.toHaveBeenCalled();
  });

  it('a safety read that throws leaves the rows listed, unpriced, none of them blocked', async () => {
    const v = view(SOL_QUOTE, key(), SOL, UNIT);
    const r = readers({ list: async () => ok([v]), safety: async () => { throw new Error('getMultipleAccounts: HTTP 502'); } });
    await mount(r);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Price not worked out');
    expect(rows()[0]).toHaveAttribute('data-blocked', 'false');
  });

  it('with USD_LINES off: no "about $" anywhere and no price fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const v = view(SOL_QUOTE, key(), 2n * SOL, UNIT);
    await mount(readers({ list: async () => ok([v]) }));
    expect(rows()).toHaveLength(1);
    expect(card()).not.toHaveTextContent(/about \$|under \$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with prices read: "about $" appended to line 2, twice the coin side at that coin’s own price; a coin with no price has no line', async () => {
    usd.read = PRICES_ON({ SOL: 150 });
    const solPool = view(SOL_QUOTE, key(), 2n * SOL, UNIT);
    const usdcPool = view(USDC_QUOTE, key(), 10n * UNIT, UNIT);
    await mount(readers({ list: async () => ok([solPool, usdcPool]) }));
    expect(rows()[0]).toHaveTextContent('about $600.00');
    expect(rows()[1]).not.toHaveTextContent(/about \$|under \$/);
  });

  it('a price of 0 is no line, never "$0"', async () => {
    usd.read = PRICES_ON({ SOL: 0, USDC: 0, BAYLA: 0 });
    const v = view(SOL_QUOTE, key(), 2n * SOL, UNIT);
    await mount(readers({ list: async () => ok([v]) }));
    expect(card()).not.toHaveTextContent(/\$/);
  });

  it('no forecast word and no em dash in the card', async () => {
    usd.read = PRICES_ON({ SOL: 150 });
    const pools = [view(SOL_QUOTE, BAYLA, 2n * SOL, UNIT, 'launch-pool'), view(USDC_QUOTE, key(), 10n * UNIT, UNIT, 'other')];
    await mount(readers({ list: async () => ok(pools, { truncated: true, unread: 1, otherPairs: 1 }) }));
    const text = card().textContent ?? '';
    expect(text).not.toMatch(FORECAST_WORDS);
    expect(text).not.toContain('—');
    expect(text).toContain(quoteText(2n * SOL, SOL_QUOTE));
  });
});

describe('Read again', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads again once, keeps the last rows while the new read is in flight, then pauses ten seconds and says so', async () => {
    const v = view(SOL_QUOTE, key(), SOL, UNIT);
    let settle: (r: PoolListRead) => void = () => {};
    const answers = [Promise.resolve(ok([v])), new Promise<PoolListRead>((res) => { settle = res; }), Promise.resolve(ok([v]))];
    let n = 0;
    const r = readers({ list: () => answers[Math.min(n++, answers.length - 1)]! });
    await mount(r);
    expect(rows()).toHaveLength(1);
    expect(r.listPools).toHaveBeenCalledTimes(1);
    expect(again()).toHaveTextContent('Read again');
    expect(again()).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(again());
    await act(async () => {});
    expect(r.listPools).toHaveBeenCalledTimes(2);
    // The last answer stays on the screen; the stamp row says a read is running.
    expect(rows()).toHaveLength(1);
    expect(within(card()).getByRole('status')).toHaveTextContent('Reading the venue’s pools from the chain…');
    // Single flight, and the pause: a second press does nothing.
    expect(again()).toHaveTextContent('Read again in 10 s');
    expect(again()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(again());
    expect(r.listPools).toHaveBeenCalledTimes(2);

    await act(async () => settle(ok([v, view(USDC_QUOTE, key(), UNIT, UNIT)])));
    expect(rows()).toHaveLength(2);
    expect(within(card()).queryByRole('status')).toBeNull();
    // Still paused after the read landed: the ten seconds are between presses.
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(again()).toHaveTextContent('Read again in 6 s');
    fireEvent.click(again());
    expect(r.listPools).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(6_000); });
    expect(again()).toHaveTextContent('Read again');
    expect(again()).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(again());
    await act(async () => {});
    expect(r.listPools).toHaveBeenCalledTimes(3);
    expect(again()).toHaveTextContent('Read again in 10 s');
  });

  it('the section’s reload key reads the list again without a press and starts no pause; while that read runs a press is still one flight', async () => {
    const v = view(SOL_QUOTE, key(), SOL, UNIT);
    let settle: (r: PoolListRead) => void = () => {};
    let n = 0;
    const r = readers({ list: () => (n++ === 0 ? Promise.resolve(ok([v])) : new Promise<PoolListRead>((res) => { settle = res; })) });
    const m = await mount(r);
    expect(r.listPools).toHaveBeenCalledTimes(1);
    m.rerender(<VenuePoolList readers={r} reloadKey={1} onPick={vi.fn()} />);
    await act(async () => {});
    expect(r.listPools).toHaveBeenCalledTimes(2);
    // No press, so no countdown: the button says Read again, and only the read in flight holds it.
    expect(again()).toHaveTextContent('Read again');
    expect(again()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(again());
    await act(async () => {});
    expect(r.listPools, 'a press during a read in flight starts no second read').toHaveBeenCalledTimes(2);
    await act(async () => settle(ok([v])));
    expect(again()).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(again());
    await act(async () => {});
    expect(r.listPools).toHaveBeenCalledTimes(3);
  });
});
