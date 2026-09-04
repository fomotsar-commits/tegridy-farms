import { describe, it, expect, vi } from 'vitest';
import {
  MIN_TAPE_REFRESH_SECONDS,
  TAPE_CAP,
  classifySide,
  hasCopyTapeSource,
  islandPools,
  marketTxUrl,
  readIslandTape,
  toTapeFills,
  type IslandPool,
} from './tape';
import type { PoolTrade } from '../geckoTerminal/poolTrades';
import { SOL_MINT } from '../solana';
import { TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';

const EVM_HASH = `0x${'ab'.repeat(32)}`;
const EVM_WALLET = '0x1111111111111111111111111111111111111111';

function trade(over: Partial<PoolTrade> = {}): PoolTrade {
  return {
    at: '2026-09-01T12:00:00Z',
    kind: 'buy',
    txHash: EVM_HASH,
    wallet: EVM_WALLET,
    tokenAmount: 100,
    usd: 25,
    fromTokenAddress: null,
    toTokenAddress: null,
    fromTokenAmount: '0.5',
    toTokenAmount: '100',
    blockNumber: 21_000_000,
    ...over,
  };
}

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

describe('islandPools', () => {
  it('is the registry, plus the venue s own pool last', () => {
    const pools = islandPools();
    // Every entry has to be readable: a pool address to ask for and a token to
    // call the base leg. A row missing either cannot classify a single fill.
    for (const p of pools) {
      expect(p.pool.length, p.bungalowId).toBeGreaterThan(20);
      expect(p.baseToken.length, p.bungalowId).toBeGreaterThan(20);
    }
    // TOWELI's market lives in lib/chart/market.ts, not on its registry row, so
    // a plain `BUNGALOWS.filter(b => b.market)` silently drops the venue's own
    // pool. This is the pin for that mutation.
    const last = pools[pools.length - 1]!;
    expect(last.bungalowId).toBe('toweli');
    expect(last.baseToken).toBe(TOWELI_ADDRESS.toLowerCase());
    expect(pools.filter((p) => p.bungalowId === 'toweli')).toHaveLength(1);
  });

  it('gives every pool the quote token of ITS OWN network', () => {
    const pools = islandPools();
    for (const p of pools) {
      if (p.network === 'eth') expect(p.quoteToken, p.bungalowId).toBe(WETH_ADDRESS.toLowerCase());
      if (p.network === 'solana') expect(p.quoteToken, p.bungalowId).toBe(SOL_MINT);
      // Base has its own WETH9. A mutation that reuses mainnet WETH for Base
      // would make every Base fill unclassified, so the assertion is that the
      // two are DIFFERENT, not merely that Base has one.
      if (p.network === 'base') {
        expect(p.quoteToken, p.bungalowId).not.toBe(WETH_ADDRESS.toLowerCase());
        expect(p.quoteToken, p.bungalowId).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
    expect(pools.some((p) => p.network === 'base')).toBe(true);
    expect(pools.some((p) => p.network === 'solana')).toBe(true);
  });

  it('keeps Solana pool and token addresses in their registry case', () => {
    // base58 is case-sensitive; a lowercased mint is a different, valid-looking,
    // wrong address.
    const solana = islandPools().filter((p) => p.family === 'solana');
    expect(solana.length).toBeGreaterThan(0);
    expect(solana.some((p) => p.baseToken !== p.baseToken.toLowerCase())).toBe(true);
  });

  it('hasCopyTapeSource is true while any island pool is registered', () => {
    expect(hasCopyTapeSource()).toBe(true);
    expect(hasCopyTapeSource()).toBe(islandPools().length > 0);
  });
});

describe('classifySide', () => {
  it('derives buy and sell from the token legs, not from kind', () => {
    expect(
      classifySide(
        trade({ fromTokenAddress: ethPool.quoteToken, toTokenAddress: ethPool.baseToken, kind: 'buy' }),
        ethPool,
      ),
    ).toBe('buy');
    expect(
      classifySide(
        trade({ fromTokenAddress: ethPool.baseToken, toTokenAddress: ethPool.quoteToken, kind: 'sell' }),
        ethPool,
      ),
    ).toBe('sell');
  });

  it('is unclassified when either token address is missing', () => {
    // The mutation this pins: falling back to `kind` when the addresses are
    // absent. `kind` is relative to GeckoTerminal's own idea of base.
    expect(classifySide(trade({ fromTokenAddress: null, toTokenAddress: ethPool.baseToken }), ethPool)).toBe(
      'unclassified',
    );
    expect(classifySide(trade({ fromTokenAddress: ethPool.quoteToken, toTokenAddress: null }), ethPool)).toBe(
      'unclassified',
    );
  });

  it('is unclassified when the derived side and kind disagree', () => {
    expect(
      classifySide(
        trade({ fromTokenAddress: ethPool.quoteToken, toTokenAddress: ethPool.baseToken, kind: 'sell' }),
        ethPool,
      ),
    ).toBe('unclassified');
  });

  it('is unclassified when the pair is not this pool s pair', () => {
    // A router hop through a third token, or a different pool's row.
    expect(
      classifySide(
        trade({
          fromTokenAddress: '0x2222222222222222222222222222222222222222',
          toTokenAddress: ethPool.baseToken,
        }),
        ethPool,
      ),
    ).toBe('unclassified');
  });

  it('refuses a Base fill quoted in MAINNET weth', () => {
    // The whole reason quoteToken is per-network. Mainnet WETH on a Base pool is
    // a different contract; treating them as one is how a cap denominated on one
    // chain sizes a trade on another.
    const basePool: IslandPool = {
      ...ethPool,
      network: 'base',
      quoteToken: '0x4200000000000000000000000000000000000006',
    };
    expect(
      classifySide(
        trade({ fromTokenAddress: WETH_ADDRESS.toLowerCase(), toTokenAddress: basePool.baseToken }),
        basePool,
      ),
    ).toBe('unclassified');
  });

  it('compares EVM addresses case-insensitively and Solana keys exactly', () => {
    expect(
      classifySide(
        trade({ fromTokenAddress: WETH_ADDRESS, toTokenAddress: ethPool.baseToken.toUpperCase().replace('0X', '0x') }),
        ethPool,
      ),
    ).toBe('buy');

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
    expect(
      classifySide(trade({ fromTokenAddress: SOL_MINT, toTokenAddress: solPool.baseToken }), solPool),
    ).toBe('buy');
    expect(
      classifySide(
        trade({ fromTokenAddress: SOL_MINT, toTokenAddress: solPool.baseToken.toLowerCase() }),
        solPool,
      ),
    ).toBe('unclassified');
  });

  it('is unclassified for a pool with no registered quote token', () => {
    expect(
      classifySide(trade({ fromTokenAddress: WETH_ADDRESS, toTokenAddress: ethPool.baseToken }), {
        ...ethPool,
        quoteToken: null,
      }),
    ).toBe('unclassified');
  });
});

describe('marketTxUrl', () => {
  it('links only a hash that passes its family s rule', () => {
    expect(marketTxUrl('eth', EVM_HASH)).toBe(`https://etherscan.io/tx/${EVM_HASH}`);
    expect(marketTxUrl('base', EVM_HASH)).toContain('basescan.org');
    expect(marketTxUrl('eth', '0xdeadbeef')).toBeNull();
    expect(marketTxUrl('eth', null)).toBeNull();
    // A 32-byte pubkey is not a 64-byte signature.
    expect(marketTxUrl('solana', SOL_MINT)).toBeNull();
    expect(marketTxUrl('solana', 'z'.repeat(87))).toContain('solscan.io/tx/');
  });
});

describe('toTapeFills', () => {
  it('carries an unread pool through with its own reason', () => {
    const read = toTapeFills(ethPool, { status: 'unread', reason: 'rate-limited', detail: 'throttled' });
    expect(read.status).toBe('unread');
    if (read.status === 'unread') expect(read.reason).toBe('rate-limited');
  });

  it('drops an undated row instead of dating it zero, and counts it', () => {
    const read = toTapeFills(ethPool, {
      status: 'read',
      fetchedAt: 1_000,
      trades: [trade(), trade({ at: 'not a date' })],
    });
    expect(read.status).toBe('read');
    if (read.status !== 'read') return;
    expect(read.fills).toHaveLength(1);
    expect(read.undated).toBe(1);
    // The pin against `Date.parse(...) || 0`: an epoch-zero fill would sit
    // outside every coverage bound while still counting as read.
    expect(read.fills.every((f) => f.at > 1_700_000_000)).toBe(true);
    expect(read.oldestAt).toBe(read.newestAt);
  });

  it('keeps a null USD null and never zero', () => {
    const read = toTapeFills(ethPool, { status: 'read', fetchedAt: 1, trades: [trade({ usd: null })] });
    if (read.status !== 'read') throw new Error('expected a read');
    expect(read.fills[0]!.usd).toBeNull();
  });

  it('nulls a wallet that is not an address on this family', () => {
    const bad = toTapeFills(ethPool, {
      status: 'read',
      fetchedAt: 1,
      trades: [
        trade({ wallet: 'not-an-address' }),
        trade({ wallet: null }),
        // A 33-byte base58 string: valid-looking, and not an address anywhere.
        trade({ wallet: 'z'.repeat(44) }),
        trade({ wallet: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' }),
      ],
    });
    if (bad.status !== 'read') throw new Error('expected a read');
    expect(bad.fills[0]!.wallet).toBeNull();
    expect(bad.fills[1]!.wallet).toBeNull();
    expect(bad.fills[2]!.wallet).toBeNull();
    // EVM senders are lowercased so one address is one row, however it is cased.
    expect(bad.fills[3]!.wallet).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('nulls a tx hash it would refuse to link', () => {
    const read = toTapeFills(ethPool, { status: 'read', fetchedAt: 1, trades: [trade({ txHash: 'garbage' })] });
    if (read.status !== 'read') throw new Error('expected a read');
    expect(read.fills[0]!.txHash).toBeNull();
  });

  it('takes the quote leg from the DERIVED side, and none at all when unclassified', () => {
    const buy = toTapeFills(ethPool, {
      status: 'read',
      fetchedAt: 1,
      trades: [
        trade({
          fromTokenAddress: ethPool.quoteToken,
          toTokenAddress: ethPool.baseToken,
          kind: 'buy',
          fromTokenAmount: '0.5',
          toTokenAmount: '100',
        }),
      ],
    });
    if (buy.status !== 'read') throw new Error('expected a read');
    expect(buy.fills[0]!.side).toBe('buy');
    expect(buy.fills[0]!.quoteAmount).toBe('0.5');

    const sell = toTapeFills(ethPool, {
      status: 'read',
      fetchedAt: 1,
      trades: [
        trade({
          fromTokenAddress: ethPool.baseToken,
          toTokenAddress: ethPool.quoteToken,
          kind: 'sell',
          fromTokenAmount: '100',
          toTokenAmount: '0.4',
        }),
      ],
    });
    if (sell.status !== 'read') throw new Error('expected a read');
    expect(sell.fills[0]!.quoteAmount).toBe('0.4');

    const unknown = toTapeFills(ethPool, { status: 'read', fetchedAt: 1, trades: [trade()] });
    if (unknown.status !== 'read') throw new Error('expected a read');
    expect(unknown.fills[0]!.side).toBe('unclassified');
    expect(unknown.fills[0]!.quoteAmount).toBeNull();
  });

  it('reports capped exactly when the response filled the cap', () => {
    const under = toTapeFills(ethPool, {
      status: 'read',
      fetchedAt: 1,
      trades: Array.from({ length: TAPE_CAP - 1 }, () => trade()),
    });
    const at = toTapeFills(ethPool, {
      status: 'read',
      fetchedAt: 1,
      trades: Array.from({ length: TAPE_CAP }, () => trade()),
    });
    expect(under.status === 'read' && under.capped).toBe(false);
    expect(at.status === 'read' && at.capped).toBe(true);
  });
});

describe('readIslandTape', () => {
  const pools: IslandPool[] = [
    { ...ethPool, bungalowId: 'a', pool: '0xaaa' },
    { ...ethPool, bungalowId: 'b', pool: '0xbbb' },
    { ...ethPool, bungalowId: 'c', pool: '0xccc' },
  ];

  function jsonFetch(bodyFor: (url: string) => { status: number; body: unknown }) {
    let inFlight = 0;
    let maxInFlight = 0;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      const { status, body } = bodyFor(String(input));
      inFlight -= 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { impl: impl as unknown as typeof fetch, peak: () => maxInFlight, calls: impl };
  }

  const okBody = { data: [{ attributes: { block_timestamp: '2026-09-01T12:00:00Z', kind: 'buy', tx_hash: EVM_HASH } }] };

  it('reads one pool at a time', async () => {
    const f = jsonFetch(() => ({ status: 200, body: okBody }));
    const tape = await readIslandTape(pools, { fetchImpl: f.impl, sleep: async () => {}, now: () => 1_000 });
    // The Promise.all mutation fails here: three concurrent requests to a
    // keyless, IP-throttled upstream is how a working feed becomes three 429s.
    expect(f.peak()).toBe(1);
    expect(tape.reads).toHaveLength(3);
    expect(tape.reads.every((r) => r.status === 'read')).toBe(true);
    expect(tape.stoppedEarly).toBe(false);
  });

  it('stops on a 429 and marks the rest not-attempted, never read-and-empty', async () => {
    const f = jsonFetch((url) =>
      url.includes('0xbbb')
        ? { status: 429, body: { status: { error_code: 429 } } }
        : { status: 200, body: okBody },
    );
    const tape = await readIslandTape(pools, { fetchImpl: f.impl, sleep: async () => {}, now: () => 1_000 });

    expect(tape.stoppedEarly).toBe(true);
    expect(tape.reads[0]!.status).toBe('read');
    const throttled = tape.reads[1]!;
    expect(throttled.status === 'unread' && throttled.reason).toBe('rate-limited');
    const skipped = tape.reads[2]!;
    // The two mutations this pins: continuing the walk after a 429 (which turns
    // one throttle into three), and emitting `{ status: 'read', fills: [] }` for
    // a pool nobody asked about — an unread pool rendered as a quiet one.
    expect(skipped.status === 'unread' && skipped.reason).toBe('not-attempted');
    expect(skipped.status === 'unread' && skipped.detail).toMatch(/never asked/);
    expect(f.calls).toHaveBeenCalledTimes(2);
  });

  it('does not stop the walk for a single failing pool', async () => {
    const f = jsonFetch((url) =>
      url.includes('0xaaa') ? { status: 500, body: {} } : { status: 200, body: okBody },
    );
    const tape = await readIslandTape(pools, { fetchImpl: f.impl, sleep: async () => {}, now: () => 1 });
    expect(tape.stoppedEarly).toBe(false);
    expect(tape.reads[0]!.status === 'unread' && tape.reads[0]!.reason).toBe('http');
    expect(tape.reads[1]!.status).toBe('read');
    expect(tape.reads[2]!.status).toBe('read');
  });

  it('never rejects, whatever the transport does', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const tape = await readIslandTape(pools, { fetchImpl: boom, sleep: async () => {}, now: () => 1 });
    expect(tape.reads.every((r) => r.status === 'unread')).toBe(true);
  });

  it('gates the manual refresh at a minute', () => {
    expect(MIN_TAPE_REFRESH_SECONDS).toBe(60);
  });
});
