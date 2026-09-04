import { describe, it, expect } from 'vitest';
import { planTapeMirror, planTapeMirrors, TAPE_MIRROR_REFUSAL_TEXT } from './tapeMirror';
import { MAX_SIGNAL_AGE_SECONDS } from './mirror';
import type { FollowConfig } from './follows';
import type { IslandPool, IslandTape, TapeFill } from './tape';
import { WETH_ADDRESS } from '../constants';
import { SOL_MINT } from '../solana';

const NOW = 1_780_000_000;
const LEADER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX = `0x${'ab'.repeat(32)}`;
const BASE_WETH = '0x4200000000000000000000000000000000000006';

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

const basePool: IslandPool = { ...ethPool, bungalowId: 'qr', network: 'base', quoteToken: BASE_WETH };

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

const follow: FollowConfig = {
  venue: 'evm',
  leader: LEADER,
  quoteToken: WETH_ADDRESS.toLowerCase(),
  maxNotionalWei: 10n ** 17n, // 0.1 WETH
  slippageBps: 100,
  createdAt: NOW - 10_000,
};

function fill(over: Partial<TapeFill> = {}): TapeFill {
  return {
    pool: ethPool,
    txHash: TX,
    wallet: LEADER,
    side: 'buy',
    at: NOW - 60,
    usd: 100,
    quoteAmount: '0.05',
    blockNumber: null,
    ...over,
  };
}

function refusal(out: ReturnType<typeof planTapeMirror>): string {
  if (out.ok) throw new Error('expected a refusal, got a plan');
  return out.reason;
}

describe('planTapeMirror', () => {
  it('sizes a fresh buy from the quote leg', () => {
    const out = planTapeMirror(fill(), follow, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.leaderAmountIn).toBe(50_000_000_000_000_000n);
    expect(out.plan.notionalWei).toBe(50_000_000_000_000_000n);
    expect(out.plan.capped).toBe(false);
    expect(out.plan.tokenOut).toBe(ethPool.baseToken);
    expect(out.plan.minOut).toBeNull();
    expect(out.plan.signalAgeSeconds).toBe(60);
  });

  it('floors the size at the cap and says the cap decided it', () => {
    const out = planTapeMirror(fill({ quoteAmount: '5' }), follow, NOW);
    if (!out.ok) throw new Error('expected a plan');
    expect(out.plan.notionalWei).toBe(follow.maxNotionalWei);
    expect(out.plan.leaderAmountIn).toBe(5n * 10n ** 18n);
    expect(out.plan.capped).toBe(true);
    // It never scales UP to match a leader who spent less than the cap.
    const small = planTapeMirror(fill({ quoteAmount: '0.001' }), follow, NOW);
    if (!small.ok) throw new Error('expected a plan');
    expect(small.plan.notionalWei).toBe(10n ** 15n);
  });

  it('refuses a SELL as an exit signal rather than sizing it or hiding it', () => {
    expect(refusal(planTapeMirror(fill({ side: 'sell' }), follow, NOW))).toBe('exit-signal');
    expect(TAPE_MIRROR_REFUSAL_TEXT['exit-signal']).toMatch(/SOLD here/);
  });

  it('refuses an unclassified fill instead of guessing its direction', () => {
    expect(refusal(planTapeMirror(fill({ side: 'unclassified', quoteAmount: null }), follow, NOW))).toBe(
      'unclassified-fill',
    );
  });

  it('refuses a fill with no quote-side amount', () => {
    expect(refusal(planTapeMirror(fill({ quoteAmount: null }), follow, NOW))).toBe('unpriced-leg');
    // A non-numeric leg is the same outcome: refused, never coerced.
    expect(refusal(planTapeMirror(fill({ quoteAmount: 'lots' }), follow, NOW))).toBe('unpriced-leg');
  });

  it('refuses a fill with no usable sender, and one that is not this leader', () => {
    expect(refusal(planTapeMirror(fill({ wallet: null }), follow, NOW))).toBe('unknown-sender');
    expect(
      refusal(planTapeMirror(fill({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), follow, NOW)),
    ).toBe('not-this-leader');
  });

  it('refuses a fill whose transaction reference it would not link', () => {
    expect(refusal(planTapeMirror(fill({ txHash: null }), follow, NOW))).toBe('unlinkable-fill');
  });

  it('refuses a Base fill against a mainnet-WETH follow', () => {
    // Same symbol, different contract. This is the pin against a table keyed on
    // symbols instead of on (network, address).
    expect(refusal(planTapeMirror(fill({ pool: basePool }), follow, NOW))).toBe('quote-token-mismatch');
  });

  it('refuses a Solana fill against an EVM follow, and the reverse', () => {
    expect(
      refusal(planTapeMirror(fill({ pool: solPool, wallet: LEADER }), follow, NOW)),
    ).toBe('quote-token-mismatch');

    const solLeader = '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k';
    const solFollow: FollowConfig = {
      venue: 'solana',
      leader: solLeader,
      quoteToken: SOL_MINT,
      maxNotionalWei: 10n ** 9n,
      slippageBps: 100,
      createdAt: NOW,
    };
    expect(refusal(planTapeMirror(fill({ wallet: solLeader }), solFollow, NOW))).toBe('quote-token-mismatch');

    const ok = planTapeMirror(
      fill({ pool: solPool, wallet: solLeader, quoteAmount: '0.5', txHash: 'z'.repeat(87) }),
      solFollow,
      NOW,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.leaderAmountIn).toBe(500_000_000n);
  });

  it('refuses a pool with no registered quote token at all', () => {
    expect(refusal(planTapeMirror(fill({ pool: { ...ethPool, quoteToken: null } }), follow, NOW))).toBe(
      'quote-token-mismatch',
    );
  });

  it('ages a fill out of the signal window at the boundary, not after it', () => {
    const atLimit = planTapeMirror(fill({ at: NOW - MAX_SIGNAL_AGE_SECONDS }), follow, NOW);
    expect(atLimit.ok).toBe(true);
    expect(refusal(planTapeMirror(fill({ at: NOW - MAX_SIGNAL_AGE_SECONDS - 1 }), follow, NOW))).toBe(
      'stale-signal',
    );
  });

  it('refuses a fill timestamped ahead of the clock it was handed', () => {
    expect(refusal(planTapeMirror(fill({ at: NOW + 5 }), follow, NOW))).toBe('unusable-timestamp');
  });

  it('refuses a zero quote leg rather than planning a mirror of nothing', () => {
    expect(refusal(planTapeMirror(fill({ quoteAmount: '0' }), follow, NOW))).toBe('zero-input');
    expect(refusal(planTapeMirror(fill({ quoteAmount: '0.0000000000000000001' }), follow, NOW))).toBe(
      'zero-input',
    );
  });

  it('truncates an over-precise upstream leg instead of dropping the fill', () => {
    const out = planTapeMirror(fill({ quoteAmount: '0.050000000000000000987' }), follow, NOW);
    if (!out.ok) throw new Error('expected a plan');
    // Truncation, not rounding: the sized mirror is never larger than the leg.
    expect(out.plan.leaderAmountIn).toBe(50_000_000_000_000_000n);
  });
});

describe('planTapeMirrors', () => {
  const tape: IslandTape = {
    fetchedAt: NOW * 1000,
    stoppedEarly: false,
    reads: [
      {
        status: 'read',
        pool: ethPool,
        fetchedAt: NOW * 1000,
        newestAt: NOW - 30,
        oldestAt: NOW - 600,
        capped: false,
        undated: 0,
        fills: [
          fill({ at: NOW - 600, side: 'sell' }),
          fill({ at: NOW - 30 }),
          fill({ at: NOW - 90, wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
          fill({ at: NOW - 45, wallet: null }),
        ],
      },
      { status: 'unread', pool: solPool, reason: 'rate-limited', detail: 'throttled' },
    ],
  };

  it('keeps refusals as rows and orders newest first', () => {
    const candidates = planTapeMirrors(tape, [follow], NOW);
    // Two fills belong to the followed address: one buy and one sell. The sell is
    // a ROW, not an omission — dropping it would show the leader as buy-only.
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.fill.at).toBe(NOW - 30);
    expect(candidates[0]!.outcome.ok).toBe(true);
    expect(candidates[1]!.outcome.ok).toBe(false);
    expect(new Set(candidates.map((c) => c.key)).size).toBe(2);
  });

  it('plans nothing from a pool that could not be read', () => {
    // The pin against treating an unread pool as an empty one: a leader who
    // trades only on Solana must not read as a leader who stopped trading.
    const onlyUnread: IslandTape = { ...tape, reads: [tape.reads[1]!] };
    expect(planTapeMirrors(onlyUnread, [follow], NOW)).toEqual([]);
  });

  it('produces one candidate per follow when two follows name the same address', () => {
    const second: FollowConfig = { ...follow, quoteToken: follow.quoteToken, maxNotionalWei: 1n };
    const candidates = planTapeMirrors(tape, [follow, second], NOW);
    expect(candidates).toHaveLength(4);
  });
});
