import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHook } from '@testing-library/react';
import { useTapeFollowerFills } from './useTapeFollowerFills';
import { poolKeyOf, type IslandPool, type IslandTape, type TapeFill } from '../lib/copytrade/tape';
import type { MirrorIntent } from '../lib/copytrade/follows';
import { WETH_ADDRESS } from '../lib/constants';
import { SOL_MINT } from '../lib/solana';

const NOW = 1_780_000_000;
const EVM_ME = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SOL_ME = '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k';
const LEADER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOL_LEADER = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';

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

const solPool: IslandPool = {
  bungalowId: 'bobo',
  symbol: 'BOBO',
  network: 'solana',
  family: 'solana',
  pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
  label: 'BOBO / SOL',
  baseToken: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump',
  quoteToken: SOL_MINT,
};

function fill(pool: IslandPool, wallet: string, at: number): TapeFill {
  return {
    pool,
    txHash: pool.family === 'solana' ? 'z'.repeat(87) : `0x${'cd'.repeat(32)}`,
    wallet,
    side: 'buy',
    at,
    usd: 10,
    quoteAmount: '0.05',
    blockNumber: null,
  };
}

const tape: IslandTape = {
  fetchedAt: NOW * 1000,
  stoppedEarly: false,
  reads: [
    {
      status: 'read',
      pool: ethPool,
      fills: [fill(ethPool, LEADER, NOW - 900), fill(ethPool, EVM_ME, NOW - 500), fill(ethPool, LEADER, NOW - 10)],
      fetchedAt: NOW * 1000,
      newestAt: NOW - 10,
      oldestAt: NOW - 900,
      capped: false,
      undated: 0,
    },
    {
      status: 'read',
      pool: solPool,
      fills: [fill(solPool, SOL_LEADER, NOW - 900), fill(solPool, SOL_ME, NOW - 500), fill(solPool, SOL_LEADER, NOW - 10)],
      fetchedAt: NOW * 1000,
      newestAt: NOW - 10,
      oldestAt: NOW - 900,
      capped: false,
      undated: 0,
    },
  ],
};

const evmIntent: MirrorIntent = {
  venue: 'evm',
  leader: LEADER,
  leaderTxHash: `0x${'ab'.repeat(32)}`,
  leaderTimestamp: NOW - 900,
  confirmedAt: NOW - 700,
  follower: EVM_ME,
  quoteToken: WETH_ADDRESS.toLowerCase(),
  tokenOut: ethPool.baseToken,
  notionalWei: 10n ** 16n,
  poolKey: poolKeyOf(ethPool),
};

const solIntent: MirrorIntent = {
  venue: 'solana',
  leader: SOL_LEADER,
  leaderTxHash: 'y'.repeat(87),
  leaderTimestamp: NOW - 900,
  confirmedAt: NOW - 700,
  follower: SOL_ME,
  quoteToken: SOL_MINT,
  tokenOut: solPool.baseToken,
  notionalWei: 500_000_000n,
  poolKey: poolKeyOf(solPool),
};

describe('useTapeFollowerFills', () => {
  it('says nothing at all with no identity', () => {
    const { result } = renderHook(() => useTapeFollowerFills({ tape, intents: [evmIntent, solIntent] }));
    expect(result.current.readable).toBe(false);
    expect(result.current.outcomes).toEqual([]);
    // Both intents are counted as unjudged rather than silently ignored.
    expect(result.current.unaddressed).toBe(2);
  });

  it('reconciles EVM intents against the connected wallet only', () => {
    const { result } = renderHook(() =>
      useTapeFollowerFills({ tape, intents: [evmIntent, solIntent], evmAddress: EVM_ME.toUpperCase() }),
    );
    expect(result.current.readable).toBe(true);
    expect(result.current.outcomes).toHaveLength(1);
    expect(result.current.outcomes[0]!.state).toBe('filled');
    expect(result.current.outcomes[0]!.entryLagSeconds).toBe(400);
    // The Solana intent is NOT judged: reconciling it against an EVM address
    // would report "not filled" for a mirror nobody looked for.
    expect(result.current.unaddressed).toBe(1);
  });

  it('reconciles Solana intents against the pasted pubkey only', () => {
    const { result } = renderHook(() =>
      useTapeFollowerFills({ tape, intents: [evmIntent, solIntent], solanaAddress: SOL_ME }),
    );
    expect(result.current.outcomes).toHaveLength(1);
    expect(result.current.outcomes[0]!.intent.venue).toBe('solana');
    expect(result.current.outcomes[0]!.state).toBe('filled');
  });

  it('is unreadable with no tape, and never reports a count from one', () => {
    const { result } = renderHook(() =>
      useTapeFollowerFills({ tape: null, intents: [evmIntent], evmAddress: EVM_ME }),
    );
    expect(result.current.readable).toBe(false);
    expect(result.current.byLeader).toEqual([]);
  });

  it('never imports a Solana wallet adapter', () => {
    // This route mounts no Solana WalletProvider, so useWallet() would throw —
    // and pulling the adapter in would drag its whole chunk onto a page that
    // signs nothing. Source-level pin, because a bundle regression is invisible
    // to a behavioural test.
    const src = readFileSync(join(process.cwd(), 'src', 'hooks', 'useTapeFollowerFills.ts'), 'utf8');
    // Comments are stripped: the header explains WHY useWallet() is absent, and
    // a guard that forbade the explanation would be a guard against documentation.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/@solana\/wallet-adapter/);
    expect(code).not.toMatch(/\buseWallet\b/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});
