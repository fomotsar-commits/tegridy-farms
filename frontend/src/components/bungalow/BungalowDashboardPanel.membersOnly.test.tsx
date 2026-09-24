// THE DASHBOARD FOLLOWS THE FARM PAGE'S RULE: a members-only Streamflow pool (closed,
// a ladder beside it) is shown only to wallets with an open position in it. Everyone
// else is pointed at the lock ladder. A failed read is never "not a member", and every
// other pool keeps its full card. Failed reads on ANY pool are outage lines.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

const fixtures = vi.hoisted(() => ({
  pool: {
    address: 'PooLAddr1111111111111111111111111111111111',
    mint: 'MintAddr',
    decimals: 6,
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    minDurationSecs: 86_400,
    maxDurationSecs: 365 * 86_400,
    minWeightScaled: 1_000_000_000n,
    maxWeightScaled: 5_000_000_000n,
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
  },
  entriesByWallet: {} as Record<string, unknown>,
  walletKey: null as string | null,
}));

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));
// STABLE objects, as the real adapter hands out. The balance effect depends on
// `publicKey` and `connection` by identity, so a fresh object per render re-runs it
// every render, and its setState renders again: a loop that never settles.
const adapter = vi.hoisted(() => {
  const keys = new Map<string, { toBase58: () => string }>();
  return {
    keyFor: (k: string) => {
      if (!keys.has(k)) keys.set(k, { toBase58: () => k });
      return keys.get(k)!;
    },
    connection: { getParsedTokenAccountsByOwner: async () => ({ value: [] }) },
    disconnect: async () => {},
  };
});
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => {
    const key = fixtures.walletKey;
    return { publicKey: key ? adapter.keyFor(key) : null, wallet: null, disconnect: adapter.disconnect };
  },
  useConnection: () => ({ connection: adapter.connection }),
}));
vi.mock('../../lib/jupiter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/jupiter')>()),
  getUsdPrices: async () => null,
}));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));
vi.mock('./BungalowMarket', () => ({ BungalowMarket: () => null }));
vi.mock('./BungalowHolders', () => ({ BungalowHolders: () => null }));
vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: fixtures.pool })),
  readEntries: vi.fn(async (_pool: string, owner: string) => {
    const reply = fixtures.entriesByWallet[owner] ?? [];
    if (reply === 'pending') return new Promise(() => {});
    if (reply === 'fail') return { ok: false as const, reason: 'Your stakes could not be read right now.' };
    return { ok: true as const, entries: reply };
  }),
}));

const staking = await import('../../lib/bungalowStaking');
const { BungalowDashboardPanel } = await import('./BungalowDashboardPanel');

type Dashboarded = Bungalow & { identity: BungalowIdentity };
const BASE = {
  id: 'bayla', name: 'Bayla', symbol: 'BAYLA', chain: 'solana', status: 'LIVE', tagline: 'Test.',
  address: 'MintAddr', decimals: 6, identity: {}, stakePool: fixtures.pool.address,
};
const MEMBERS_ONLY = { ...BASE, ladderPool: 'LadderPool1111111111111111111111111111111111', depositsClosed: true } as unknown as Dashboarded;
const OPEN = { ...BASE, id: 'bobo', symbol: 'BOBO' } as unknown as Dashboarded;
const CLOSED_NO_LADDER = { ...MEMBERS_ONLY, ladderPool: undefined } as unknown as Dashboarded;
const BOTH_OPEN = { ...MEMBERS_ONLY, depositsClosed: undefined } as unknown as Dashboarded;

const WALLET_A = 'WalletA111111111111111111111111111111111111';
const WALLET_B = 'WalletB111111111111111111111111111111111111';
// Lock still closed, opened after the rate change: the everyday member.
const POSITION = {
  address: 'Entry0', nonce: 0, amountRaw: 50_000_000_000n, durationSecs: 365 * DAY,
  createdTs: NOW - 10 * DAY, closedTs: 0, effectiveAmountRaw: 50_000_000_000n,
  pendingRaw: { 0: 19_524_569n }, accountedRaw: { 0: 0n },
};

const reply = (wallet: string, r: unknown) => { fixtures.entriesByWallet[wallet] = r; };
const ui = (b: Dashboarded) => <MemoryRouter><BungalowDashboardPanel bungalow={b} /></MemoryRouter>;
const mount = (b: Dashboarded) => render(ui(b));
/** Let the mocked reads resolve and their setState land. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const pageText = () => document.body.textContent ?? '';
const ladderCard = () => screen.queryByRole('heading', { name: 'The lock ladder' });
const MEMBER_KICKER = /The lighthouse pool · retired/;

beforeEach(() => {
  vi.mocked(staking.readEntries).mockClear();
  vi.mocked(staking.readPool).mockClear();
  fixtures.entriesByWallet = {};
  fixtures.walletKey = WALLET_A;
});

describe('a members-only pool on the dashboard', () => {
  it('a disconnected visitor is pointed at the ladder, never shown the old pool, and costs it no reads', async () => {
    fixtures.walletKey = null;
    mount(MEMBERS_ONLY);
    await settle();
    expect(ladderCard()).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Stake BAYLA' }).getAttribute('href')).toBe('/farm');
    // Not the card, not its rate and vault, not the connect copy's "lighthouse
    // position", not the surfaces link: the word does not appear on the page.
    expect(pageText()).not.toMatch(/lighthouse|Streamflow|Configured rate|Reward vault|See the pool/i);
    expect(screen.getByRole('link', { name: 'The lock ladder' }).getAttribute('href')).toBe('/farm');
    expect(staking.readEntries).not.toHaveBeenCalled();
    expect(staking.readPool).not.toHaveBeenCalled();
  });

  it('a connected wallet with no position sees the ladder, and nothing of the old pool', async () => {
    reply(WALLET_A, []);
    mount(MEMBERS_ONLY);
    await waitFor(() => expect(staking.readEntries).toHaveBeenCalled());
    await settle();
    expect(ladderCard()).toBeTruthy();
    expect(pageText()).not.toMatch(/lighthouse|Configured rate|Reward vault|no open stake|Nothing staked/i);
  });

  it('while the read is in flight, the old pool does not flash up', async () => {
    reply(WALLET_A, 'pending');
    mount(MEMBERS_ONLY);
    await settle();
    expect(ladderCard()).toBeTruthy();
    expect(pageText()).not.toMatch(/lighthouse|Reading your position/i);
  });

  it('a member keeps their own position, labelled, and the way to their exits', async () => {
    reply(WALLET_A, [POSITION]);
    mount(MEMBERS_ONLY);
    expect(await screen.findByText(MEMBER_KICKER)).toBeTruthy();
    expect(screen.getByText('Staked')).toBeTruthy();
    expect(pageText()).toContain('50,000');
    expect(screen.getByText(/takes no new stakes/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage position' }).getAttribute('href')).toBe('/farm');
    // The member card takes the slot, and still never advertises the pool's rate.
    expect(ladderCard()).toBeNull();
    expect(pageText()).not.toMatch(/Configured rate|The pool is live|See the pool/);
  });

  it('⚠️ a failed read is an outage, never "no position", and Try again brings the member back', async () => {
    reply(WALLET_A, 'fail');
    mount(MEMBERS_ONLY);
    const outage = await screen.findByText(/could not be checked for positions in the retired lighthouse pool/);
    expect(outage.textContent).toMatch(/outage, not an empty result/);
    expect(pageText()).not.toMatch(/no open stake|Nothing staked|Nothing in the lighthouse pool/i);

    reply(WALLET_A, [POSITION]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(MEMBER_KICKER)).toBeTruthy();
    expect(staking.readEntries).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/could not be checked/)).toBeNull();
  });

  it("a switched wallet is never shown the previous wallet's position, even for a frame", async () => {
    reply(WALLET_A, [POSITION]);
    reply(WALLET_B, 'pending');
    const { rerender } = mount(MEMBERS_ONLY);
    await screen.findByText(MEMBER_KICKER);
    fixtures.walletKey = WALLET_B;
    rerender(ui(MEMBERS_ONLY));
    expect(screen.queryByText(MEMBER_KICKER)).toBeNull();
    expect(ladderCard()).toBeTruthy();
  });
});

describe('every pool that is NOT members-only keeps the full card, unchanged', () => {
  it.each([
    ['an open Streamflow pool with no ladder (BOBO, SOY, BRAINLET, RIZZ)', OPEN],
    ['a closed pool with NO ladder configured', CLOSED_NO_LADDER],
    ['an open pool with a ladder beside it', BOTH_OPEN],
  ])('%s: a disconnected visitor still sees it, rate beside vault', async (_label, b) => {
    fixtures.walletKey = null;
    mount(b);
    expect(await screen.findByText('Configured rate')).toBeTruthy();
    expect(screen.getByText('At the lighthouse')).toBeTruthy();
    expect(screen.getByText('The pool is live')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See the pool' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'The lighthouse pool' })).toBeTruthy();
    expect(pageText()).toMatch(/your lighthouse position/);
    expect(ladderCard()).toBeNull();
  });

  it('a connected wallet with no position in an open pool is still offered the stake', async () => {
    reply(WALLET_A, []);
    mount(OPEN);
    expect(await screen.findByText('Nothing staked yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Stake BOBO' })).toBeTruthy();
    expect(screen.getByText('Configured rate')).toBeTruthy();
  });

  it('a member of an open pool sees the same position view as before', async () => {
    reply(WALLET_A, [POSITION]);
    mount(OPEN);
    expect(await screen.findByText('Staked')).toBeTruthy();
    expect(screen.getByText('At the lighthouse')).toBeTruthy();
    expect(screen.queryByText(MEMBER_KICKER)).toBeNull();
  });
});

// A failed stakes read used to be dropped, leaving "Reading your position…" up forever.
// Stored, it must never read as "nothing staked".
describe('a failed read on a pool that is NOT members-only', () => {
  const OPEN_OUTAGE = /could not be checked for a position in the lighthouse pool/;

  it.each([
    ['an open Streamflow pool with no ladder', OPEN],
    ['a closed pool with NO ladder configured', CLOSED_NO_LADDER],
    ['an open pool with a ladder beside it', BOTH_OPEN],
  ])('⚠️ %s: a failed stakes read is an outage, never "no position", and Try again recovers', async (_label, b) => {
    reply(WALLET_A, 'fail');
    mount(b);
    const outage = await screen.findByText(OPEN_OUTAGE);
    expect(outage.textContent).toMatch(/outage, not an empty result/);
    expect(pageText()).not.toMatch(/Reading your position|no open stake|Nothing staked|Nothing in the lighthouse pool/i);
    expect(screen.queryByRole('link', { name: 'Stake BAYLA' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Stake BOBO' })).toBeNull();

    // The retry is visibly a retry: the outage line gives way to the loading line.
    reply(WALLET_A, 'pending');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Reading your position…')).toBeTruthy();
    expect(screen.queryByText(OPEN_OUTAGE)).toBeNull();
  });

  it('Try again brings an open-pool member their position back', async () => {
    reply(WALLET_A, 'fail');
    mount(OPEN);
    await screen.findByText(OPEN_OUTAGE);

    reply(WALLET_A, [POSITION]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Staked')).toBeTruthy();
    expect(pageText()).toContain('50,000');
    expect(staking.readEntries).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(OPEN_OUTAGE)).toBeNull();
  });

  it('a failed pool read says the rate could not be read, instead of dropping it silently', async () => {
    fixtures.walletKey = null;
    vi.mocked(staking.readPool).mockResolvedValueOnce({ ok: false, reason: 'The pool could not be read right now.' });
    mount(OPEN);
    const outage = await screen.findByText(/rate and reward vault could not be read/);
    expect(outage.textContent).toMatch(/outage, not an empty vault/);
    expect(screen.queryByText('Configured rate')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Configured rate')).toBeTruthy();
    expect(screen.getByText('Reward vault')).toBeTruthy();
    expect(staking.readPool).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it('a connected wallet with no position still sees the pool outage beside the stake offer', async () => {
    reply(WALLET_A, []);
    vi.mocked(staking.readPool).mockResolvedValueOnce({ ok: false, reason: 'The pool could not be read right now.' });
    mount(OPEN);
    expect(await screen.findByText('Nothing staked yet')).toBeTruthy();
    expect(await screen.findByText(/rate and reward vault could not be read/)).toBeTruthy();
    expect(screen.queryByText('Configured rate')).toBeNull();
  });
});

// A member's view splits accrual by risk against the pool's reward pools. With the pool
// read failed that list is empty, so at-risk rewards would print as ordinary accrual and
// the empty-vault note could never show. The view says so in one line instead.
describe("a member's position when the pool read failed", () => {
  const SPLIT_OUTAGE = /at risk could not be separated/i;

  it.each([
    ['a members-only pool', MEMBERS_ONLY],
    ['an open pool', OPEN],
  ])('⚠️ %s: says the at-risk split could not be made, and Try again reads it', async (_label, b) => {
    reply(WALLET_A, [POSITION]);
    vi.mocked(staking.readPool).mockResolvedValueOnce({ ok: false, reason: 'The pool could not be read right now.' });
    mount(b);
    expect(await screen.findByText('Staked')).toBeTruthy();
    const line = await screen.findByText(SPLIT_OUTAGE);
    expect(line.closest('[role="status"]')).toBeTruthy();
    fireEvent.click(within(line.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(SPLIT_OUTAGE)).toBeNull());
    expect(staking.readPool).toHaveBeenCalledTimes(2);
  });

  it('a member whose pool read landed sees no such line', async () => {
    reply(WALLET_A, [POSITION]);
    mount(OPEN);
    expect(await screen.findByText('Staked')).toBeTruthy();
    await settle();
    expect(screen.queryByText(SPLIT_OUTAGE)).toBeNull();
  });

  it('the position view carries no em dash, at risk and with an empty vault', async () => {
    const pool = fixtures.pool;
    fixtures.pool = { ...pool, rewardPools: [{ ...pool.rewardPools[0]!, fundedRaw: 0n }] };
    try {
      reply(WALLET_A, [{ ...POSITION, createdTs: 1 }]);
      mount(MEMBERS_ONLY);
      await screen.findByText(/At risk \(claim may revert\)/);
      await screen.findByText(/reward vault is empty/i);
      const card = screen.getByText(MEMBER_KICKER).closest('.rounded-2xl')!;
      expect(card.textContent).toMatch(/Try the claim/);
      expect(card.textContent).not.toContain(String.fromCharCode(0x2014));
    } finally {
      fixtures.pool = pool;
    }
  });
});
