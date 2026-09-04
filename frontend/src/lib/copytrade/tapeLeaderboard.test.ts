import { describe, it, expect } from 'vitest';
import { buildTapeLeaderboard, TAPE_RETURN_RANKING, TAPE_SENDER_NOTICE } from './tapeLeaderboard';
import type { IslandPool, IslandTape, PoolTapeRead, TapeFill } from './tape';
import { SOL_MINT } from '../solana';
import { WETH_ADDRESS } from '../constants';

const ethPool: IslandPool = {
  bungalowId: 'pepe',
  symbol: 'PEPE',
  network: 'eth',
  family: 'evm',
  pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  label: 'PEPE / WETH',
  baseToken: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
  quoteToken: WETH_ADDRESS.toLowerCase(),
};

const basePool: IslandPool = {
  bungalowId: 'qr',
  symbol: 'QR',
  network: 'base',
  family: 'evm',
  pool: '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0',
  label: 'QR / WETH',
  baseToken: '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf',
  quoteToken: '0x4200000000000000000000000000000000000006',
};

const solPool: IslandPool = {
  bungalowId: 'bobo',
  symbol: 'BOBO',
  network: 'solana',
  family: 'solana',
  pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
  label: 'BOBO / SOL',
  baseToken: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump',
  quoteToken: SOL_MINT,
};

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function fill(pool: IslandPool, over: Partial<TapeFill> = {}): TapeFill {
  return {
    pool,
    txHash: `0x${'cd'.repeat(32)}`,
    wallet: A,
    side: 'buy',
    at: 1_780_000_000,
    usd: 100,
    quoteAmount: '0.5',
    blockNumber: null,
    ...over,
  };
}

function readOf(pool: IslandPool, fills: TapeFill[], over: Partial<Extract<PoolTapeRead, { status: 'read' }>> = {}): PoolTapeRead {
  return {
    status: 'read',
    pool,
    fills,
    fetchedAt: 1_780_000_500_000,
    newestAt: fills.length ? Math.max(...fills.map((f) => f.at)) : null,
    oldestAt: fills.length ? Math.min(...fills.map((f) => f.at)) : null,
    capped: false,
    undated: 0,
    ...over,
  };
}

function tapeOf(reads: PoolTapeRead[], stoppedEarly = false): IslandTape {
  return { reads, fetchedAt: 1_780_000_500_000, stoppedEarly };
}

describe('buildTapeLeaderboard', () => {
  it('returns NULL when every pool is unread', () => {
    // The mutation this pins: returning `{ rows: [], ... }`. An empty board on a
    // page headed "wallets trading the island" is a claim about every wallet at
    // once, produced by an outage.
    const board = buildTapeLeaderboard(
      tapeOf([
        { status: 'unread', pool: ethPool, reason: 'rate-limited', detail: 'throttled' },
        { status: 'unread', pool: solPool, reason: 'not-attempted', detail: 'never asked' },
      ]),
    );
    expect(board).toBeNull();
  });

  it('keeps a read-but-empty pool as a board with no rows', () => {
    // The opposite case, and it must NOT be null: this one really is a
    // measurement, and the surface has different words for it.
    const board = buildTapeLeaderboard(tapeOf([readOf(ethPool, [])]));
    expect(board).not.toBeNull();
    expect(board!.rows).toEqual([]);
    expect(board!.poolsRead).toHaveLength(1);
    expect(board!.window).toBeNull();
  });

  it('leaves a row with no priced fill at null volume, never zero', () => {
    const board = buildTapeLeaderboard(
      tapeOf([readOf(ethPool, [fill(ethPool, { usd: null }), fill(ethPool, { usd: null })])]),
    )!;
    const row = board.rows[0]!;
    // `usdVolume ?? 0` would put this row at "$0 of island volume", which is a
    // claim upstream never made.
    expect(row.usdVolume).toBeNull();
    expect(row.unpricedFills).toBe(2);
    expect(row.largestFillUsd).toBeNull();
    expect(row.fills).toBe(2);
  });

  it('sorts priced rows above unpriced ones however many fills the unpriced row has', () => {
    const board = buildTapeLeaderboard(
      tapeOf([
        readOf(ethPool, [
          fill(ethPool, { wallet: A, usd: 5 }),
          fill(ethPool, { wallet: B, usd: null }),
          fill(ethPool, { wallet: B, usd: null }),
          fill(ethPool, { wallet: B, usd: null }),
        ]),
      ]),
    )!;
    expect(board.rows.map((r) => r.wallet)).toEqual([A, B]);
    expect(board.rows[0]!.usdVolume).toBe(5);
    expect(board.rows[1]!.usdVolume).toBeNull();
  });

  it('makes the same 0x address on two chains TWO rows', () => {
    const board = buildTapeLeaderboard(
      tapeOf([readOf(ethPool, [fill(ethPool, { wallet: A })]), readOf(basePool, [fill(basePool, { wallet: A })])]),
    )!;
    // A merged row would be an identity claim nothing in this data supports.
    expect(board.rows).toHaveLength(2);
    expect(board.rows.map((r) => r.key).sort()).toEqual([`base:${A}`, `eth:${A}`]);
  });

  it('counts a fill with no sender rather than inventing a row for it', () => {
    const board = buildTapeLeaderboard(
      tapeOf([readOf(ethPool, [fill(ethPool, { wallet: null }), fill(ethPool, { wallet: A })])]),
    )!;
    expect(board.unattributedFills).toBe(1);
    expect(board.fillsRead).toBe(2);
    expect(board.rows).toHaveLength(1);
  });

  it('splits buys, sells and unclassified and never sizes the unclassified', () => {
    const board = buildTapeLeaderboard(
      tapeOf([
        readOf(ethPool, [
          fill(ethPool, { side: 'buy' }),
          fill(ethPool, { side: 'sell' }),
          fill(ethPool, { side: 'unclassified', quoteAmount: null }),
        ]),
      ]),
    )!;
    const row = board.rows[0]!;
    expect([row.buys, row.sells, row.unclassified]).toEqual([1, 1, 1]);
    expect(row.fills).toBe(3);
  });

  it('excludes the viewer, per family', () => {
    const solWallet = '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k';
    const board = buildTapeLeaderboard(
      tapeOf([
        readOf(ethPool, [fill(ethPool, { wallet: A }), fill(ethPool, { wallet: B })]),
        readOf(solPool, [fill(solPool, { wallet: solWallet })]),
      ]),
      // Cased differently on purpose: an EVM address is the same address either
      // way, and the exclusion has to hold.
      { exclude: [A.toUpperCase(), solWallet] },
    )!;
    expect(board.rows.map((r) => r.wallet)).toEqual([B]);
  });

  it('carries the read ledger, the cap flag and the early stop up to the surface', () => {
    const board = buildTapeLeaderboard(
      tapeOf(
        [
          readOf(ethPool, [fill(ethPool)], { capped: true, undated: 2 }),
          { status: 'unread', pool: basePool, reason: 'http', detail: 'HTTP 500' },
          { status: 'unread', pool: solPool, reason: 'not-attempted', detail: 'never asked' },
        ],
        true,
      ),
    )!;
    expect(board.poolsRead).toHaveLength(1);
    expect(board.poolsUnread).toHaveLength(2);
    expect(board.anyCapped).toBe(true);
    expect(board.stoppedEarly).toBe(true);
    expect(board.undatedFills).toBe(2);
  });

  it('tracks the newest fill for the row s last link, and the window over all pools', () => {
    const older = `0x${'11'.repeat(32)}`;
    const newer = `0x${'22'.repeat(32)}`;
    const board = buildTapeLeaderboard(
      tapeOf([
        readOf(ethPool, [
          fill(ethPool, { at: 1_780_000_000, txHash: older }),
          fill(ethPool, { at: 1_780_000_900, txHash: newer }),
        ]),
      ]),
    )!;
    expect(board.rows[0]!.lastTxHash).toBe(newer);
    expect(board.rows[0]!.firstSeen).toBe(1_780_000_000);
    expect(board.window).toEqual({ from: 1_780_000_000, to: 1_780_000_900 });
  });

  it('states the refusal and the sender caveat in the words the surface prints', () => {
    expect(TAPE_RETURN_RANKING.ranked).toBe(false);
    expect(TAPE_RETURN_RANKING.reason).toMatch(/No wallet on this board is ranked by profit/);
    expect(TAPE_RETURN_RANKING.rankedInstead).toMatch(/activity, not skill and not outcome/);
    expect(TAPE_SENDER_NOTICE).toMatch(/SENT the transaction/);
  });
});
