// The held-time line on the lighthouse pool card: the last line of the pool figures,
// keyed by the pool registry from the card's own stake pool, shown only with the
// figures. The fixture's pool address drives both states through the real registry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const READ_POOL = 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';
const UNREAD_POOL = 'PkwDYVNxyesAukE9STqRQL9H1pBpXbt1tVbiYVMX96w';
const LADDER = 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV';

const READ = 'Staking keeps your held time.';
const UNREAD =
  'Heat reads wallets today. A bag locked here is not counted until the island reads this pool. Your clock is not reset.';

const pool = (address: string) => ({
  address,
  mint: 'MintAddr',
  decimals: 6,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  minDurationSecs: DAY,
  maxDurationSecs: 365 * DAY,
  minWeightScaled: WEIGHT_SCALE,
  maxWeightScaled: 5n * WEIGHT_SCALE,
  unstakePeriodSecs: 0,
  totalStakeRaw: 1_000_000_000n,
  totalEffectiveStakeRaw: 1_000_000_000n,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'fixed' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: 1_000_000_000n, permissionless: true,
    rewardAmountRaw: '1000', rewardPeriodSecs: 86_400,
    fundedAmountRaw: null, claimedAmountRaw: null, claimPeriodSecs: 0,
    rateChangedAtTs: 1_788_241_201,
  }],
});

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
const walletState = vi.hoisted(() => ({ publicKey: null as { toBase58: () => string } | null }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: walletState.publicKey,
    wallet: walletState.publicKey ? { adapter: { publicKey: walletState.publicKey } } : null,
    connected: !!walletState.publicKey,
  }),
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

const poolRead = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => poolRead.next),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: [] })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => null),
  readConfirmedSlot: vi.fn(async () => 500),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

// Read: the BAYLA lighthouse pool. Unread: another Streamflow pool, on a row whose
// ladderPool IS read, so a card that keyed the line on the wrong field would say "read".
const room = (stakePool: string, extra: Record<string, unknown> = {}) => ({
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool, address: 'MintAddr', ...extra,
}) as unknown as Bungalow & { stakePool: string };

const figures = () => document.querySelector('section[aria-label="The lighthouse pool figures"]') as HTMLElement;

beforeEach(() => {
  walletState.publicKey = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
});

describe('the held-time line on the lighthouse pool card', () => {
  it('says the read sentence as the last line of the pool figures when the registry reads this pool', async () => {
    poolRead.next = { ok: true, pool: pool(READ_POOL) };
    render(<LighthousePoolLive bungalow={room(READ_POOL)} />);
    const line = await screen.findByText(READ);
    expect(screen.queryByText(UNREAD)).toBeNull();
    expect(screen.getAllByText(READ)).toHaveLength(1);
    expect(figures().lastElementChild).toBe(line);
  });

  it('says the unread sentence in the same place when the registry does not read this pool', async () => {
    poolRead.next = { ok: true, pool: pool(UNREAD_POOL) };
    render(<LighthousePoolLive bungalow={room(UNREAD_POOL, { ladderPool: LADDER })} />);
    const line = await screen.findByText(UNREAD);
    expect(screen.queryByText(READ)).toBeNull();
    expect(figures().lastElementChild).toBe(line);
  });

  it('sits above the closed-deposits notice, never inside it', async () => {
    poolRead.next = { ok: true, pool: pool(READ_POOL) };
    render(<LighthousePoolLive bungalow={room(READ_POOL, { depositsClosed: true })} />);
    const line = await screen.findByText(READ);
    const notice = screen.getByText(/closed to new deposits/i).parentElement!;
    expect(notice.contains(line)).toBe(false);
    expect(line.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the line with no wallet connected', async () => {
    walletState.publicKey = null;
    poolRead.next = { ok: true, pool: pool(READ_POOL) };
    render(<LighthousePoolLive bungalow={room(READ_POOL)} />);
    expect(await screen.findByText(READ)).toBeTruthy();
  });

  it('shows no line when the pool read fails, because no figures show', async () => {
    poolRead.next = { ok: false, reason: 'The pool could not be read right now.' };
    render(<LighthousePoolLive bungalow={room(READ_POOL)} />);
    await screen.findByText('The pool could not be read right now.');
    expect(screen.queryByText(READ)).toBeNull();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  it('shows no line while the pool is still being read', async () => {
    poolRead.next = new Promise(() => {});
    render(<LighthousePoolLive bungalow={room(READ_POOL)} />);
    await screen.findByText('Reading the pool…');
    expect(screen.queryByText(READ)).toBeNull();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });
});
