// The LIVE METER, pinned at the render.
//
// `lib/ladder/meter.test.ts` proves the arithmetic. What only a render can catch is
// the card failing to DRIVE it: a clock that still ticks once a minute, a figure
// printed at two decimals where the movement lives in the sixth, a meter that keeps
// climbing after the reward window shut, or one that comes back from a hidden tab and
// creeps up to the truth instead of landing on it.
//
// Every one of those renders as a plausible-looking number. That is what makes them
// worth a test rather than an eyeball.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const NOW = 1_800_000_000;
const POOL_ADDR = '2RJNUuj3y8CDibhCehvRoufAvkBG9idpKrryYosvZxi4';
const MINT = '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL';
const OWNER = 'Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj';

/* ─────────────────────────── the rig ─────────────────────────── */

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));

const walletState = vi.hoisted(() => ({ publicKey: null as { toBase58: () => string } | null }));
const conn = vi.hoisted(() => ({ connection: {} }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: walletState.publicKey,
    wallet: walletState.publicKey ? { adapter: { publicKey: walletState.publicKey } } : null,
    connected: !!walletState.publicKey,
  }),
  useConnection: () => conn,
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

// The reduced-motion switch is the one piece of the shared motion system this feature
// consumes, so it is the one piece worth being able to flip.
const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock('framer-motion', async (orig) => {
  const actual = await orig<typeof import('framer-motion')>();
  return { ...actual, useReducedMotion: () => motion.reduce };
});

const cfg = vi.hoisted(() => ({ configured: true, program: 'HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK' }));
vi.mock('../../lib/ladder/program', async (orig) => {
  const actual = await orig<typeof import('../../lib/ladder/program')>();
  const { PublicKey } = await import('@solana/web3.js');
  return { ...actual, isLadderConfigured: () => cfg.configured, ladderProgramId: () => new PublicKey(cfg.program) };
});

const reads = vi.hoisted(() => ({
  pool: null as unknown,
  vaults: { stakeRaw: 0n, rewardRaw: 0n } as { stakeRaw: bigint | null; rewardRaw: bigint | null },
  wallet: null as unknown,
  balance: 0n as bigint | null,
  poolCalls: 0,
}));
vi.mock('../../lib/ladder/read', () => ({
  readLadderPool: vi.fn(async () => { reads.poolCalls += 1; return reads.pool; }),
  readVaultBalances: vi.fn(async () => reads.vaults),
  readLadderWallet: vi.fn(async () => reads.wallet),
  readOwnerTokenBalance: vi.fn(async () => reads.balance),
  nextPositionNonce: (w: { stats: { nextNonce: number } | null }) => w.stats?.nextNonce ?? 0,
  walletPrincipalRaw: (w: { stats: { principalRaw: bigint } | null }) => w.stats?.principalRaw ?? 0n,
}));
vi.mock('../../lib/ladder/write', () => ({
  ladderStake: vi.fn(), ladderClaim: vi.fn(), ladderExit: vi.fn(),
  ladderHatch: vi.fn(), ladderClaimCarried: vi.fn(),
}));

const { SolanaLadderPoolLive } = await import('./SolanaLadderPoolLive');
const { earnedNow } = await import('../../lib/ladder/program');

/* ── fixtures: the LIVE pool's shape, so the movement is the real movement ── */

const poolView = (o: Record<string, unknown> = {}) => ({
  address: POOL_ADDR, bump: 255, nonce: 0, mint: MINT,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  decimals: 6, authority: OWNER, pendingAuthority: OWNER,
  stakeVault: 'SV', rewardVault: 'RV',
  minStakeRaw: 100_000_000n,
  depositCapRaw: 10_000_000_000_000_000n,
  pendingCapRaw: 0n, pendingCapTs: 0n,
  maxWalletPrincipalRaw: 10_000_000_000_000_000n,
  totalPrincipalRaw: 82_654_490_000n,
  totalWeighted: 82_654_490_000n,     // the live pool's total weight
  rewardRate: 5_506n,                 // 0.005506 BAYLA/sec, the live schedule
  periodFinish: BigInt(NOW + 90 * DAY),
  lastUpdateTime: BigInt(NOW - DAY),
  rewardPerWeightStored: 0n, rpwResidueRaw: 0n,
  rewardsEmitted: 0n, rewardsPaid: 0n,
  rewardFundedCumulative: 0n, penaltyCollectedCumulative: 0n,
  orphanedPenaltyRaw: 0n, degraded: false,
  ...o,
});

const position = (o: Record<string, unknown> = {}) => ({
  address: 'POS0', pool: POOL_ADDR, owner: OWNER, nonce: 0,
  amountRaw: 20_000_000_000n,         // the owner's 20,000 BAYLA
  weight: 80_000_000_000n,            // at the four-year rung
  lockEnd: BigInt(NOW + 4 * 365 * DAY),
  rewardPerWeightPaid: 0n, rewardsOwed: 0n,
  ...o,
});

const walletView = (o: Record<string, unknown> = {}) => ({
  stats: { address: 'US', nextNonce: 1, openPositions: 1, rewardsCarriedRaw: 0n, principalRaw: 20_000_000_000n },
  slots: [], open: [position()], truncated: false,
  ...o,
});

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  address: MINT, ladderPool: POOL_ADDR, decimals: 6,
} as unknown as Bungalow & { ladderPool: string };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW * 1000);
  cfg.configured = true;
  motion.reduce = false;
  walletState.publicKey = { toBase58: () => OWNER };
  reads.pool = { ok: true, value: poolView() };
  reads.vaults = { stakeRaw: 82_654_490_000n, rewardRaw: 50_000_000_000n };
  reads.wallet = { ok: true, value: walletView() };
  reads.balance = 2_000_000_000n;
  reads.poolCalls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The figure under "Earned, unclaimed", as raw base units.
 *
 * Reads the VALUE paragraph, never the whole stat block: the label "Earned, unclaimed"
 * carries a comma, and a `[\d,]+` pattern over the block happily matches that comma
 * alone and parses every assertion in this file as a confident 0.
 */
const shownRaw = (): bigint => {
  const el = screen.getByText('Earned, unclaimed').nextElementSibling;
  const text = el?.textContent ?? '';
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)/);
  if (!m) throw new Error(`no number in "${text}"`);
  const [whole, frac = ''] = m[1]!.replace(/,/g, '').split('.');
  return BigInt(whole + (frac + '000000').slice(0, 6));
};

/** What the program would actually pay at the current fake instant. */
const claimableNow = (pool = poolView()) =>
  earnedNow(position() as never, pool as never, Date.now() / 1000);

const draw = async () => {
  render(<SolanaLadderPoolLive bungalow={BUNGALOW} />);
  await act(async () => { await Promise.resolve(); });
  await screen.findByText('Earned, unclaimed');
};

/** Let the meter run for `ms` of wall clock, frames and all. */
const runFor = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

/* ─────────────────────────── the pins ─────────────────────────── */

describe('the figure climbs without a reload', () => {
  it('⚠️ increases between two ticks a second apart, with no re-read and no remount', async () => {
    await draw();
    const before = shownRaw();
    await runFor(1_000);
    const after = shownRaw();
    // PRE-FIX this is the same number: the card ticked once every 60_000ms and printed
    // at two decimals, so a second of the owner's accrual (5,329 raw units, the sixth
    // decimal) was invisible twice over.
    expect(after).toBeGreaterThan(before);
  });

  it('moves SUB-SECOND — four samples inside one second are four different figures', async () => {
    await draw();
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      seen.add(shownRaw().toString());
      await runFor(200);
    }
    // A once-a-second clock would give at most two distinct values across 600ms.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('climbs at the program\'s rate — 5,329 raw units a second, to within the sub-second lag', async () => {
    await draw();
    const before = shownRaw();
    await runFor(4_000);
    const gained = shownRaw() - before;
    // NOT `gained / 4`. Both samples carry their own sub-second lag, and the two do
    // not cancel: sampling at fraction ~0 and again at fraction ~1 spans just under
    // FIVE seconds of accrual across four seconds of wall clock. The invariant that
    // actually holds is that the gain over an N-second window is strictly inside
    // ((N-1) x rate, (N+1) x rate).
    expect(gained).toBeGreaterThan(3n * 5_329n);
    expect(gained).toBeLessThan(5n * 5_329n);
  });
});

describe('⚠️ the figure never reads higher than what is claimable', () => {
  it('stays at or below earnedNow() at the same instant, sampled across two seconds', async () => {
    await draw();
    for (let i = 0; i < 12; i++) {
      expect(shownRaw()).toBeLessThanOrEqual(claimableNow());
      await runFor(170);
    }
  });

  it('is still under the true figure after a long unattended run', async () => {
    await draw();
    await runFor(120_000);
    expect(shownRaw()).toBeLessThanOrEqual(claimableNow());
  });
});

describe('⚠️ the figure stops when accrual stops', () => {
  it('does NOT increase after periodFinish', async () => {
    reads.pool = { ok: true, value: poolView({ periodFinish: BigInt(NOW - 1) }) };
    await draw();
    const before = shownRaw();
    await runFor(10_000);
    expect(shownRaw()).toBe(before);
  });

  it('freezes AS the window closes mid-watch, without a re-read telling it to', async () => {
    // The window shuts two seconds into the session. Nothing re-reads; the meter has
    // to stop because `lastTimeApplicable` pins dt, not because it was informed.
    reads.pool = { ok: true, value: poolView({ periodFinish: BigInt(NOW + 2) }) };
    await draw();
    await runFor(2_000);              // the window shuts
    // One more second for the meter to finish interpolating INTO the closing second.
    // Sampling at the instant of close catches it mid-stride, one second's accrual
    // short of the final figure — that lag is the honesty guarantee doing its job,
    // not a freeze that failed.
    await runFor(2_000);
    const settled = shownRaw();
    expect(settled).toBe(claimableNow(poolView({ periodFinish: BigInt(NOW + 2) })));
    await runFor(8_000);
    expect(shownRaw()).toBe(settled);
  });

  it('does not move when nothing is staked (totalWeighted 0)', async () => {
    reads.pool = { ok: true, value: poolView({ totalWeighted: 0n }) };
    await draw();
    const before = shownRaw();
    await runFor(5_000);
    expect(shownRaw()).toBe(before);
  });

  it('does not move on a window that was never funded', async () => {
    reads.pool = { ok: true, value: poolView({ rewardRate: 0n, periodFinish: 0n, lastUpdateTime: 0n }) };
    await draw();
    expect(shownRaw()).toBe(0n);
    await runFor(5_000);
    expect(shownRaw()).toBe(0n);
  });
});

describe('⚠️ the hidden-tab trap', () => {
  it('JUMPS to the true figure on tab restore, never resumes a stale count and creeps', async () => {
    await draw();
    const beforeHide = shownRaw();

    // Hide the tab, and freeze the loop the way a real browser does: the clock moves
    // an hour, no animation frame and no throttled timeout gets to run.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    vi.setSystemTime((NOW + 3_600) * 1000);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    const onRestore = shownRaw();
    const truth = claimableNow();

    // An hour of the owner's accrual is ~19.18 BAYLA. A meter resuming from its stale
    // value would be sitting on `beforeHide` and would need an hour of frames to
    // catch up — this asserts it is already there, to within the sub-second lag.
    expect(onRestore).toBeGreaterThan(beforeHide + 19_000_000n);
    // At most ONE second of accrual behind: the restore landed on a whole second, so
    // the fraction is 0 and the lag is exactly one step. That is the bound, not a
    // strict inequality.
    expect(truth - onRestore).toBeLessThanOrEqual(5_329n);
    expect(onRestore).toBeLessThanOrEqual(truth);
  });

  it('keeps running after the restore rather than stalling on the jumped-to value', async () => {
    await draw();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    vi.setSystemTime((NOW + 600) * 1000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    const onRestore = shownRaw();
    await runFor(1_000);
    expect(shownRaw()).toBeGreaterThan(onRestore);
  });
});

describe('prefers-reduced-motion', () => {
  it('still climbs, once a second, and still never overstates', async () => {
    motion.reduce = true;
    await draw();
    const before = shownRaw();
    await runFor(3_000);
    const after = shownRaw();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(claimableNow());
  });

  it('shows the EXACT figure rather than a smoothed one — reduced motion is more accurate, not less', async () => {
    motion.reduce = true;
    await draw();
    await runFor(2_000);
    expect(shownRaw()).toBe(claimableNow());
  });
});

describe('the meter costs no extra RPC', () => {
  it('runs for a minute of frames on ONE pool read', async () => {
    await draw();
    const afterMount = reads.poolCalls;
    await runFor(40_000);
    expect(shownRaw()).toBeGreaterThan(0n);
    expect(reads.poolCalls).toBe(afterMount);
  });

  it('re-syncs on its own slow schedule — once, not once a frame', async () => {
    await draw();
    const afterMount = reads.poolCalls;
    await runFor(100_000);
    // 45s cadence over 100s of frames: a couple of reads, nowhere near the ~6,000
    // animation frames that elapsed.
    expect(reads.poolCalls).toBeGreaterThan(afterMount);
    expect(reads.poolCalls - afterMount).toBeLessThan(5);
  });
});
