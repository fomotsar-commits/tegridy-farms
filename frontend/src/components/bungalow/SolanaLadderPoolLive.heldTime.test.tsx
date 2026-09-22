// The held-time line on the lock ladder card: under the headline figures, keyed by
// the pool registry from the card's own ladder pool, shown only with the figures.
// The fixture's pool address drives both states through the real registry.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const NOW = 1_800_000_000;
const READ_POOL = 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV';
const UNREAD_POOL = '2RJNUuj3y8CDibhCehvRoufAvkBG9idpKrryYosvZxi4';
const LIGHTHOUSE = 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';
const MINT = '8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL';
const OWNER = 'Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj';

const READ = 'Staking keeps your held time.';
const UNREAD =
  'Heat reads wallets today. A bag locked here is not counted until the island reads this pool. Your clock is not reset.';

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

vi.mock('../../lib/ladder/program', async (orig) => {
  const actual = await orig<typeof import('../../lib/ladder/program')>();
  const { PublicKey } = await import('@solana/web3.js');
  return {
    ...actual,
    isLadderConfigured: () => true,
    ladderProgramId: () => new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK'),
  };
});

const reads = vi.hoisted(() => ({
  pool: null as unknown,
  vaults: { stakeRaw: 0n, rewardRaw: 0n } as { stakeRaw: bigint | null; rewardRaw: bigint | null },
  wallet: null as unknown,
  balance: 0n as bigint | null,
}));
vi.mock('../../lib/ladder/read', () => ({
  readLadderPool: vi.fn(async () => reads.pool),
  readVaultBalances: vi.fn(async () => reads.vaults),
  readLadderWallet: vi.fn(async () => reads.wallet),
  readOwnerTokenBalance: vi.fn(async () => reads.balance),
  nextPositionNonce: (w: { stats: { nextNonce: number } | null }) => w.stats?.nextNonce ?? 0,
  walletPrincipalRaw: (w: { stats: { principalRaw: bigint } | null }) => w.stats?.principalRaw ?? 0n,
}));
vi.mock('../../lib/ladder/write', () => ({
  ladderStake: vi.fn(), ladderClaim: vi.fn(), ladderExit: vi.fn(), ladderHatch: vi.fn(), ladderClaimCarried: vi.fn(),
}));

const { SolanaLadderPoolLive } = await import('./SolanaLadderPoolLive');

const poolView = (address: string) => ({
  address, bump: 255, nonce: 0, mint: MINT,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  decimals: 6, authority: OWNER, pendingAuthority: OWNER,
  stakeVault: 'SV', rewardVault: 'RV',
  minStakeRaw: 100_000_000n,
  depositCapRaw: 10_000_000_000_000n,
  pendingCapRaw: 0n, pendingCapTs: 0n,
  maxWalletPrincipalRaw: 10_000_000_000_000n,
  totalPrincipalRaw: 1_000_000_000n,
  totalWeighted: 1_000_000_000n,
  rewardRate: 0n,
  periodFinish: BigInt(NOW + 30 * DAY),
  lastUpdateTime: BigInt(NOW - DAY),
  rewardPerWeightStored: 0n,
  rpwResidueRaw: 0n,
  rewardsEmitted: 0n, rewardsPaid: 0n,
  rewardFundedCumulative: 0n, penaltyCollectedCumulative: 0n,
  orphanedPenaltyRaw: 0n,
  degraded: false,
});

const position = (pool: string) => ({
  address: 'POS0', pool, owner: OWNER, nonce: 0,
  amountRaw: 500_000_000n,
  weight: 2_000_000_000n,
  lockEnd: BigInt(NOW + 4 * 365 * DAY),
  rewardPerWeightPaid: 0n,
  rewardsOwed: 0n,
});

const walletView = (pool: string) => ({
  stats: { address: 'US', nextNonce: 1, openPositions: 1, rewardsCarriedRaw: 0n, principalRaw: 500_000_000n },
  slots: [], open: [position(pool)], truncated: false,
  shareBasis: { mineWeight: 2_000_000_000n, totalWeighted: 2_000_000_000n },
});

// Read: the lock ladder pool. Unread: another ladder pool, on a row whose stakePool
// IS read, so a card that keyed the line on the wrong field would say "read".
const READ_ROOM = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  address: MINT, ladderPool: READ_POOL, decimals: 6,
} as unknown as Bungalow & { ladderPool: string };
const UNREAD_ROOM = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  address: MINT, ladderPool: UNREAD_POOL, stakePool: LIGHTHOUSE, decimals: 6,
} as unknown as Bungalow & { ladderPool: string };

function seed(pool: string) {
  reads.pool = { ok: true, value: poolView(pool) };
  reads.vaults = { stakeRaw: 1_000_000_000n, rewardRaw: 5_000_000_000n };
  reads.wallet = { ok: true, value: walletView(pool) };
  reads.balance = 2_000_000_000n;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW * 1000);
  walletState.publicKey = { toBase58: () => OWNER };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const earnings = () => document.querySelector('section[aria-label="Your earnings"]') as HTMLElement;
const staircase = () => document.querySelector('section[aria-label="Open a position"]') as HTMLElement;

describe('the held-time line on the lock ladder card', () => {
  it('says the read sentence under the headline figures when the registry reads this pool', async () => {
    seed(READ_POOL);
    render(<SolanaLadderPoolLive bungalow={READ_ROOM} />);
    const line = await screen.findByText(READ);
    expect(screen.queryByText(UNREAD)).toBeNull();
    expect(screen.getAllByText(READ)).toHaveLength(1);
    expect(earnings().lastElementChild).toBe(line);
    expect(line.compareDocumentPosition(staircase()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the unread sentence in the same place when the registry does not read this pool', async () => {
    seed(UNREAD_POOL);
    render(<SolanaLadderPoolLive bungalow={UNREAD_ROOM} />);
    const line = await screen.findByText(UNREAD);
    expect(screen.queryByText(READ)).toBeNull();
    expect(earnings().lastElementChild).toBe(line);
    expect(line.compareDocumentPosition(staircase()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the line with no wallet connected, under the meter prompt', async () => {
    walletState.publicKey = null;
    seed(READ_POOL);
    render(<SolanaLadderPoolLive bungalow={READ_ROOM} />);
    await screen.findByText('Your meter starts when you lock.');
    expect(earnings().lastElementChild?.textContent).toBe(READ);
  });

  it('shows no line when the pool read fails, because no figures show', async () => {
    seed(READ_POOL);
    reads.pool = { ok: false, unreadable: true, reason: 'the pool could not be read: 502 Bad Gateway' };
    render(<SolanaLadderPoolLive bungalow={READ_ROOM} />);
    await screen.findByText(/the pool could not be read/);
    expect(screen.queryByText(READ)).toBeNull();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  it('shows no line while the pool is still being read', async () => {
    seed(READ_POOL);
    reads.pool = new Promise(() => {});
    render(<SolanaLadderPoolLive bungalow={READ_ROOM} />);
    await screen.findByText('Reading the pool…');
    expect(screen.queryByText(READ)).toBeNull();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });
});
