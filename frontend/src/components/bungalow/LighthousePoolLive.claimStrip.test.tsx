// THE CLOSED POOL IS INVISIBLE TO EVERYONE WHO IS NOT IN IT, AND STILL WORKS FOR
// EVERYONE WHO IS. A strip that rendered nothing at all would pass every "is it
// hidden" case here; the load-bearing half is that a member still gets a working
// claim, the exit once a lock opens, and never "no positions" because a read failed.
// The one exception: a connected wallet whose read failed is told it could not be checked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const RATE_CHANGED_AT = 1_788_241_201;
const NOW = Math.floor(Date.now() / 1000);
// In ISLAND_READ_POOLS: the held-time line reads "read" for it.
const EFWP = 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';

const POOL = {
  address: 'PooLAddr1111111111111111111111111111111111',
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
    rateChangedAtTs: RATE_CHANGED_AT,
  }],
};

// Counts mounts: the strip lives inside SolanaPoolStack's one context and mounts none.
const providerMounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../solana/SolanaProviders', async () => {
  const { useEffect } = await import('react');
  return {
    SolanaProviders: ({ children }: { children: React.ReactNode }) => {
      useEffect(() => { providerMounts.n += 1; }, []);
      return children;
    },
  };
});
vi.mock('../solana/useSolanaConnect', () => ({
  useSolanaConnect: () => () => {},
}));
const walletState = vi.hoisted(() => ({ key: null as string | null }));
// `invoker` is `wallet?.adapter`, and every write button is disabled without it.
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => {
    const publicKey = walletState.key ? { toBase58: () => walletState.key as string } : null;
    return { publicKey, wallet: publicKey ? { adapter: { publicKey } } : null, connected: !!publicKey };
  },
}));

type Entry = {
  address: string; nonce: number; amountRaw: bigint; durationSecs: number;
  createdTs: number; closedTs: number; effectiveAmountRaw: bigint;
  pendingRaw: Record<number, bigint | null>; accountedRaw: Record<number, bigint | null>;
  pendingUnread?: true;
};
const entry = (over: Partial<Entry>): Entry => ({
  address: 'Entry0', nonce: 0, amountRaw: 50_000_000_000n, durationSecs: 365 * DAY,
  createdTs: NOW - 10 * DAY, closedTs: 0, effectiveAmountRaw: 50_000_000_000n,
  pendingRaw: { 0: 19_524_569n }, accountedRaw: { 0: 0n }, ...over,
});
// Opened after the rate change, lock still closed: the everyday member today.
const LOCKED = entry({});
// Lock open, opened after the rate change, so nothing about it is at risk.
const MATURED = entry({ createdTs: RATE_CHANGED_AT + 100, durationSecs: 1 });
// Lock open, opened BEFORE the rate change: the claim may revert (6000 band).
const MATURED_AT_RISK = entry({ createdTs: 1, durationSecs: 1 });
// Lock open, and no reward pool priced it: nothing but the list itself says a pool is missing.
const UNPRICED_MATURED = entry({ createdTs: RATE_CHANGED_AT + 100, durationSecs: 1, pendingRaw: {}, accountedRaw: {}, pendingUnread: true });

const WALLET_A = 'WalletA111111111111111111111111111111111111';
const WALLET_B = 'WalletB111111111111111111111111111111111111';
type Reply = Entry[] | 'fail' | 'pending';
const entriesState = vi.hoisted(() => ({ byWallet: {} as Record<string, unknown> }));
const poolState = vi.hoisted(() => ({ pool: null as unknown }));
// Writes resolve through a hand-held promise so a test can hold one open while the
// wallet changes underneath it.
const writeState = vi.hoisted(() => ({
  release: null as null | ((r: { ok: true; txId: string }) => void),
  hold: false,
  fail: false,
}));
const write = vi.hoisted(() => async () => {
  if (writeState.fail) return { ok: false as const, reason: 'The claim did not go through.' };
  if (!writeState.hold) return { ok: true as const, txId: 'TX1' };
  return new Promise<{ ok: true; txId: string }>((res) => { writeState.release = res; });
});

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  claimRewards: vi.fn(write),
  unstakeAndClaim: vi.fn(write),
  unstakeAndCloseForfeitingRewards: vi.fn(write),
  readPool: vi.fn(async () => (poolState.pool === 'fail'
    ? { ok: false as const, reason: 'The pool could not be read right now. That is an outage, not a zero.' }
    : { ok: true as const, pool: poolState.pool })),
  readEntries: vi.fn(async (_pool: string, owner: string) => {
    const reply = (entriesState.byWallet[owner] ?? []) as Reply;
    if (reply === 'pending') return new Promise(() => {});
    if (reply === 'fail') return { ok: false as const, reason: 'Your stakes could not be read right now.' };
    return { ok: true as const, entries: reply };
  }),
}));

const staking = await import('../../lib/bungalowStaking');
const { LighthouseClaimStrip } = await import('./LighthousePoolLive');

const BAYLA = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: POOL.address, address: POOL.mint, depositsClosed: true,
} as unknown as Bungalow & { stakePool: string };

const reply = (wallet: string, r: Reply) => { entriesState.byWallet[wallet] = r; };
/** Let the mocked reads resolve and their setState land. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const FIRE = /forfeit rewards & take principal/i;
const ARM = /take principal without rewards/i;

beforeEach(() => {
  vi.mocked(staking.readEntries).mockClear();
  vi.mocked(staking.readPool).mockClear();
  vi.mocked(staking.claimRewards).mockClear();
  vi.mocked(staking.unstakeAndClaim).mockClear();
  vi.mocked(staking.unstakeAndCloseForfeitingRewards).mockClear();
  providerMounts.n = 0;
  entriesState.byWallet = {};
  poolState.pool = POOL;
  writeState.hold = false;
  writeState.fail = false;
  writeState.release = null;
  walletState.key = WALLET_A;
});

describe('who sees the closed pool', () => {
  it('a disconnected visitor sees nothing, and costs the pool no reads', async () => {
    walletState.key = null;
    const { container } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await settle();
    expect(container.innerHTML).toBe('');
    expect(staking.readEntries).not.toHaveBeenCalled();
    expect(staking.readPool).not.toHaveBeenCalled();
  });

  it('a connected wallet with no position here sees nothing', async () => {
    reply(WALLET_A, []);
    const { container } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await waitFor(() => expect(staking.readEntries).toHaveBeenCalled());
    await settle();
    expect(container.innerHTML).toBe('');
  });

  it('a wallet whose positions here are all CLOSED sees nothing', async () => {
    reply(WALLET_A, [entry({ closedTs: NOW - DAY })]);
    const { container } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await waitFor(() => expect(staking.readEntries).toHaveBeenCalled());
    await settle();
    expect(container.innerHTML).toBe('');
  });

  it('nothing flashes while the read is still in flight', async () => {
    reply(WALLET_A, 'pending');
    const { container } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await settle();
    expect(container.innerHTML).toBe('');
  });

  it('a FAILED read is an outage, never "not a member", and it can be retried', async () => {
    reply(WALLET_A, 'fail');
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByText(/could not be checked/i)).toBeTruthy();
    const calls = vi.mocked(staking.readEntries).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(vi.mocked(staking.readEntries).mock.calls.length).toBeGreaterThan(calls));
  });

  it('⚠️ the outage line never names the closed pool: a non-member may be the one reading it', async () => {
    reply(WALLET_A, 'fail');
    const { container } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const line = await screen.findByText(/could not be checked/i);
    expect(line.textContent).toMatch(/BAYLA positions/);
    expect(line.textContent).toMatch(/outage, not an empty result/);
    expect(container.textContent).not.toMatch(/lighthouse|retired/i);
  });

  it('Try again drops the failed result while it re-reads, so a retry that fails again is not a dead click', async () => {
    reply(WALLET_A, 'fail');
    const { container } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByText(/could not be checked/i);
    reply(WALLET_A, 'pending');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.queryByText(/could not be checked/i)).toBeNull();
    await settle();
    expect(container.innerHTML).toBe('');
  });
});

describe('what a member sees', () => {
  it('a locked position gets a working claim, and nothing else to press', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const claim = await screen.findByRole('button', { name: /^claim rewards$/i });
    expect((claim as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/unlocks in/i)).toBeTruthy();
    expect(screen.getByText(/19\.524569 BAYLA earned/)).toBeTruthy();
  });

  it('carries none of the old card: no stats, no banner, no stake form, no pool links', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByRole('button', { name: /claim rewards/i });
    expect(screen.queryByText(/reward vault/i)).toBeNull();
    expect(screen.queryByText(/total staked/i)).toBeNull();
    expect(screen.queryByText(/paying now|configured|max boost/i)).toBeNull();
    expect(screen.queryByText(/closed to new deposits/i)).toBeNull();
    expect(screen.queryByText(/lock duration/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /stake & lock|enter an amount|connect/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /stake pool|reward vault/i })).toBeNull();
  });

  it('the exit appears the moment a lock OPENS, so principal is never stranded', async () => {
    reply(WALLET_A, [MATURED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const exit = await screen.findByRole('button', { name: /^unstake & claim$/i });
    expect((exit as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /^claim rewards$/i })).toBeTruthy();
    // Not at risk, so no rescue: it would only forfeit rewards that pay.
    expect(screen.queryByRole('button', { name: /take principal/i })).toBeNull();
  });

  it('an OPEN lock in the 6000 band gets the principal rescue, armed in two steps', async () => {
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByRole('button', { name: /claim rewards \(may revert\)/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /unstake & claim \(may revert\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ARM }));
    expect(screen.getByRole('button', { name: FIRE })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
  });

  it('the rescue says it claims first, and gives up only what the chain says can never pay', async () => {
    // unstakeAndCloseForfeitingRewards tries every pool with something pending and
    // stops on any failure the chain has not called permanent.
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const title = (await screen.findByRole('button', { name: ARM })).getAttribute('title') ?? '';
    expect(title).toMatch(/first tries to claim/i);
    expect(title).toMatch(/stops/i);
    expect(title).not.toMatch(/cannot be blocked/i);
    // Each claim is its own transaction: one can pay before a later one stops the rescue.
    expect(title).not.toMatch(/before anything moves/i);
    expect(title).toMatch(/principal/i);
  });

  it('a LOCKED position in the 6000 band gets no rescue: the program refuses any unstake', async () => {
    reply(WALLET_A, [entry({ createdTs: 1_788_000_000, durationSecs: 10 * 365 * DAY })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByRole('button', { name: /claim rewards \(may revert\)/i });
    expect(screen.queryByRole('button', { name: /take principal|unstake/i })).toBeNull();
  });

  it('an UNKNOWN pending figure leaves the claim live instead of reading as zero', async () => {
    // readEntries prices only the first eight open entries; the rest arrive with
    // no pending key at all.
    reply(WALLET_A, [entry({ pendingRaw: {}, pendingUnread: true })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const claim = await screen.findByRole('button', { name: /^claim rewards$/i });
    expect((claim as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/BAYLA earned/)).toBeNull();
  });

  it('⚠️ an entry marked pendingUnread prints no earned figure, even with a figure for the pools it found', async () => {
    // A failed search half leaves the found pools priced and the entry marked: the sum
    // over what was found is partial, and printed as "earned" it reads as complete.
    reply(WALLET_A, [entry({ pendingUnread: true })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const claim = await screen.findByRole('button', { name: /^claim rewards$/i });
    expect((claim as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/BAYLA earned/)).toBeNull();
  });

  it('a KNOWN zero disables the claim', async () => {
    reply(WALLET_A, [entry({ pendingRaw: { 0: 0n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const claim = await screen.findByRole('button', { name: /^claim rewards$/i });
    expect((claim as HTMLButtonElement).disabled).toBe(true);
  });

  it('accrual beyond the vault says so and holds the claim, rather than letting it revert', async () => {
    reply(WALLET_A, [entry({ pendingRaw: { 0: 2_000_000_000n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const claim = await screen.findByRole('button', { name: /nothing claimable yet/i });
    expect((claim as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/claims wait for a top-up/i)).toBeTruthy();
  });

  it('a pool that does not stake this token shows the configuration error and no buttons', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={{ ...BAYLA, address: 'SomeOtherMint' }} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/does not stake BAYLA/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('switching wallets never shows the previous wallet\'s positions', async () => {
    reply(WALLET_A, [LOCKED]);
    reply(WALLET_B, 'pending');
    const { container, rerender } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByRole('button', { name: /claim rewards/i });
    walletState.key = WALLET_B;
    rerender(<LighthouseClaimStrip bungalow={BAYLA} />);
    await settle();
    expect(container.innerHTML).toBe('');
  });
});

describe('the rescue confirm is armed against one read', () => {
  it('an arm on one wallet does not come up armed on the next wallet\'s same nonce', async () => {
    reply(WALLET_A, [MATURED_AT_RISK]);
    reply(WALLET_B, [MATURED_AT_RISK]);
    const { rerender } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    expect(screen.getByRole('button', { name: FIRE })).toBeTruthy();
    walletState.key = WALLET_B;
    rerender(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByRole('button', { name: ARM })).toBeTruthy();
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
  });

  it('⚠️ switching away and BACK disarms it: a confirm belongs to the read it was given against', async () => {
    reply(WALLET_A, [MATURED_AT_RISK]);
    reply(WALLET_B, [entry({ address: 'EntryB', amountRaw: 777_000_000n })]);
    const { rerender } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    walletState.key = WALLET_B;
    rerender(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByText('777')).toBeTruthy();
    walletState.key = WALLET_A;
    rerender(<LighthouseClaimStrip bungalow={BAYLA} />);
    await waitFor(() => expect(screen.queryByText('777')).toBeNull());
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /take principal|forfeit/i })).toHaveLength(1));
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
  });

  it('⚠️ a claim that confirms disarms it: the rows are re-read under it', async () => {
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    fireEvent.click(screen.getByRole('button', { name: /claim rewards \(may revert\)/i }));
    expect(await screen.findByText(/claim confirmed/i)).toBeTruthy();
    await settle();
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
    expect(screen.getByRole('button', { name: ARM })).toBeTruthy();
  });

  it('⚠️ the write itself disarms it, before any re-read: a claim still waiting on the wallet leaves no armed rescue', async () => {
    writeState.hold = true;
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    const reads = vi.mocked(staking.readEntries).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /claim rewards \(may revert\)/i }));
    expect(await screen.findByText(/waiting for the wallet/i)).toBeTruthy();
    // No re-read has started, so only the write's own clear can have removed it.
    expect(vi.mocked(staking.readEntries).mock.calls.length).toBe(reads);
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
    await act(async () => { writeState.release!({ ok: true, txId: 'TX1' }); });
    await settle();
  });

  it('Cancel disarms it', async () => {
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
    expect(screen.getByRole('button', { name: ARM })).toBeTruthy();
  });

  it('any write disarms it, even one that fails', async () => {
    writeState.fail = true;
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    fireEvent.click(screen.getByRole('button', { name: /claim rewards \(may revert\)/i }));
    expect(await screen.findByText(/did not go through/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: FIRE })).toBeNull();
  });
});

describe('the reads and the receipts', () => {
  it('⚠️ a pool read that lost its reward pools draws NO exit: that unstake would claim nothing and close the entry', async () => {
    // No pending figure either (an unpriced entry, or entries read from the same empty
    // search), so only the empty-list rule can catch it.
    poolState.pool = { ...POOL, rewardPools: [] };
    reply(WALLET_A, [UNPRICED_MATURED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByText(/reward program could not be read/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /unstake|claim|take principal/i })).toBeNull();
    expect(screen.queryByText(/0 BAYLA earned/)).toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('a pool read missing a reward pool the entry has a figure for is the same outage', async () => {
    reply(WALLET_A, [entry({ createdTs: RATE_CHANGED_AT + 100, durationSecs: 1, pendingRaw: { 0: 5n, 1: 7n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByText(/reward program could not be read/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /unstake|claim/i })).toBeNull();
  });

  it('a FAILED pool read says so, draws no buttons, and can be retried', async () => {
    poolState.pool = 'fail';
    reply(WALLET_A, [MATURED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByText(/pool could not be read/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /unstake|claim|take principal/i })).toBeNull();
    poolState.pool = POOL;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: /^unstake & claim$/i })).toBeTruthy();
    expect(staking.readPool).toHaveBeenCalledTimes(2);
  });

  it('a claim that confirms re-reads for the CURRENT wallet, never over it with the old one', async () => {
    reply(WALLET_A, [LOCKED]);
    reply(WALLET_B, [entry({ address: 'EntryB', amountRaw: 777_000_000n })]);
    writeState.hold = true;
    const { rerender } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: /^claim rewards$/i }));
    await waitFor(() => expect(writeState.release).not.toBeNull());
    // Switch while A's claim is still confirming.
    walletState.key = WALLET_B;
    rerender(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findByText('777')).toBeTruthy();
    await act(async () => { writeState.release!({ ok: true, txId: 'TXA' }); });
    await settle();
    // B is still on screen, and every read since the switch was for B.
    expect(screen.getByText('777')).toBeTruthy();
    const owners = vi.mocked(staking.readEntries).mock.calls.map((c) => c[1]);
    expect(owners.slice(owners.indexOf(WALLET_B))).not.toContain(WALLET_A);
  });

  it('one wallet\'s receipt is not shown under the next wallet\'s positions', async () => {
    reply(WALLET_A, [LOCKED]);
    reply(WALLET_B, [LOCKED]);
    const { rerender } = render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: /^claim rewards$/i }));
    expect(await screen.findByText(/claim confirmed/i)).toBeTruthy();
    walletState.key = WALLET_B;
    rerender(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByRole('button', { name: /^claim rewards$/i });
    expect(screen.queryByText(/claim confirmed/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /view transaction/i })).toBeNull();
  });

  it('exiting the LAST position keeps its receipt on screen', async () => {
    reply(WALLET_A, [MATURED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const exit = await screen.findByRole('button', { name: /^unstake & claim$/i });
    // The re-read after the exit finds the position closed.
    reply(WALLET_A, [{ ...MATURED, closedTs: NOW }]);
    fireEvent.click(exit);
    expect(await screen.findByText(/unstake confirmed/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /unstake/i })).toBeNull());
    await settle();
    expect(screen.getByText(/unstake confirmed/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /view transaction/i }).getAttribute('href')).toMatch(/TX1$/);
  });
});

describe('the shell and its tap targets', () => {
  const tall = (el: Element) => /\bmin-h-\[44px\]/.test(el.getAttribute('class') ?? '');

  it('every button a member can press is a 44px tap target, the rescue pair included', async () => {
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(expect.arrayContaining([
      expect.stringMatching(/claim rewards/i), expect.stringMatching(/unstake/i),
      expect.stringMatching(/forfeit/i), expect.stringMatching(/cancel/i),
    ]));
    for (const b of buttons) expect(tall(b), b.textContent ?? '').toBe(true);
  });

  it.each([
    ['a failed stakes read', () => reply(WALLET_A, 'fail')],
    ['a failed pool read', () => { poolState.pool = 'fail'; reply(WALLET_A, [LOCKED]); }],
    ['a lost reward-pool list', () => { poolState.pool = { ...POOL, rewardPools: [] }; reply(WALLET_A, [UNPRICED_MATURED]); }],
  ])('Try again after %s is a 44px tap target', async (_label, arrange) => {
    arrange();
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(tall(await screen.findByRole('button', { name: /try again/i }))).toBe(true);
  });

  it('the receipt link is a 44px tap target', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: /^claim rewards$/i }));
    const link = await screen.findByRole('link', { name: /view transaction/i });
    expect(link.className).toMatch(/\binline-flex\b/);
    expect(tall(link)).toBe(true);
  });

  // jsdom cannot measure width, so this pins the wrap rule on the note line. An outcome-unknown
  // note carries an 88-character signature, and above the failed-read line nothing clips it.
  it('a receipt note may break inside a word, so a signature never runs past a phone\'s width', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: /^claim rewards$/i }));
    const note = (await screen.findByText(/claim confirmed/i)).closest('p')!;
    expect(note.className).toMatch(/\bbreak-words\b/);
  });

  it('sits back like the closed full card: no glow loop, the quiet border, the 0.62 scrim', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const section = (await screen.findByRole('region', { name: /lighthouse pool/i }));
    expect(section.className).not.toMatch(/glass-card-animated/);
    expect(section.getAttribute('style') ?? '').toMatch(/purple-25/);
    expect(section.innerHTML).toMatch(/rgba\(4,\s*9,\s*18,\s*0\.62\)/);
    expect(section.querySelector('[id]')!.className).toMatch(/text-\[11px\]/);
  });
});

describe('the held-time line', () => {
  const lineOf = () => document.querySelector('[data-held-time]');

  it('shows under a member\'s figures, keyed from the registry', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={{ ...BAYLA, stakePool: EFWP }} />);
    await screen.findByRole('button', { name: /^claim rewards$/i });
    expect(lineOf()?.getAttribute('data-held-time')).toBe('read');
  });

  it.each([
    ['the pool read failed', () => { poolState.pool = 'fail'; }],
    ['the reward-pool list was lost', () => { poolState.pool = { ...POOL, rewardPools: [] }; }],
  ])('is absent when no figures show: %s', async (_label, arrange) => {
    arrange();
    reply(WALLET_A, [UNPRICED_MATURED]);
    render(<LighthouseClaimStrip bungalow={{ ...BAYLA, stakePool: EFWP }} />);
    await screen.findByRole('button', { name: /try again/i });
    expect(lineOf()).toBeNull();
  });
});

describe('what each write sends', () => {
  // Two same-mint reward pools, so a list that lost one is visibly shorter.
  const TWO_POOLS = { ...POOL, rewardPools: [POOL.rewardPools[0]!, { ...POOL.rewardPools[0]!, address: 'Rp1', nonce: 1, vault: 'V1' }] };

  it('Claim sends the row\'s own entry and the reward pool on its button', async () => {
    poolState.pool = TWO_POOLS;
    reply(WALLET_A, [entry({ nonce: 3, pendingRaw: { 0: 5n, 1: 7n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: /^claim rewards · pool #1$/i }));
    await waitFor(() => expect(staking.claimRewards).toHaveBeenCalledTimes(1));
    const args = vi.mocked(staking.claimRewards).mock.calls[0]![0];
    expect(args.entryNonce).toBe(3);
    expect(args.rewardPool.nonce).toBe(1);
  });

  it('⚠️ Unstake & claim hands over EVERY listed reward pool: a pool left out is closed unclaimed', async () => {
    poolState.pool = TWO_POOLS;
    reply(WALLET_A, [entry({ nonce: 3, createdTs: RATE_CHANGED_AT + 100, durationSecs: 1, pendingRaw: { 0: 5n, 1: 7n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: /^unstake & claim$/i }));
    await waitFor(() => expect(staking.unstakeAndClaim).toHaveBeenCalledTimes(1));
    const args = vi.mocked(staking.unstakeAndClaim).mock.calls[0]![0];
    expect(args.entryNonce).toBe(3);
    expect(args.pool.rewardPools.map((rp) => rp.nonce)).toEqual([0, 1]);
  });

  it('⚠️ the rescue hands over the row\'s own entry with its real pending figures: they decide what is claimed before the close', async () => {
    poolState.pool = TWO_POOLS;
    const row = entry({ nonce: 3, createdTs: 1, durationSecs: 1, pendingRaw: { 0: 5n, 1: 7n } });
    reply(WALLET_A, [row]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    fireEvent.click(screen.getByRole('button', { name: FIRE }));
    await waitFor(() => expect(staking.unstakeAndCloseForfeitingRewards).toHaveBeenCalledTimes(1));
    const args = vi.mocked(staking.unstakeAndCloseForfeitingRewards).mock.calls[0]![0];
    expect(args.entryNonce).toBe(3);
    expect(args.entry.pendingRaw).toEqual({ 0: 5n, 1: 7n });
    expect(args.entry.createdTs).toBe(1);
    expect(args.pool.rewardPools.map((rp) => rp.nonce)).toEqual([0, 1]);
  });

  it('⚠️ a rescue that FAILS still re-reads: a claim it made first may have paid', async () => {
    writeState.fail = true;
    reply(WALLET_A, [MATURED_AT_RISK]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    fireEvent.click(await screen.findByRole('button', { name: ARM }));
    const before = vi.mocked(staking.readEntries).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: FIRE }));
    expect(await screen.findByText(/did not go through/i)).toBeTruthy();
    await waitFor(() => expect(vi.mocked(staking.readEntries).mock.calls.length).toBeGreaterThan(before));
  });
});

describe('one write at a time', () => {
  it('⚠️ while a write waits on the wallet, every write button on every row is disabled', async () => {
    writeState.hold = true;
    reply(WALLET_A, [MATURED_AT_RISK, entry({ address: 'Entry1', nonce: 1, createdTs: RATE_CHANGED_AT + 100, durationSecs: 1 })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const claims = await screen.findAllByRole('button', { name: /^claim rewards/i });
    const writes = () => screen.getAllByRole('button', { name: /claim rewards|unstake|take principal|forfeit/i }) as HTMLButtonElement[];
    expect(writes().every((b) => !b.disabled)).toBe(true);
    fireEvent.click(claims[0]!);
    expect(await screen.findByText(/waiting for the wallet/i)).toBeTruthy();
    const held = writes();
    // Two claims, two exits and the rescue's first step: the whole row set, not one button.
    expect(held.length).toBeGreaterThanOrEqual(5);
    for (const b of held) expect(b.disabled, b.textContent ?? '').toBe(true);
    await act(async () => { writeState.release!({ ok: true, txId: 'TX1' }); });
    await settle();
    expect(writes().some((b) => !b.disabled)).toBe(true);
  });

  it('an open lock whose accrual is past the vault holds the EXIT too, not only the claim', async () => {
    reply(WALLET_A, [entry({ createdTs: RATE_CHANGED_AT + 100, durationSecs: 1, pendingRaw: { 0: 2_000_000_000n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    const exit = await screen.findByRole('button', { name: /exit waits for a vault top-up/i });
    expect((exit as HTMLButtonElement).disabled).toBe(true);
    // A short vault is not the 6000 band: the rescue would only forfeit rewards that pay after a top-up.
    expect(screen.queryByRole('button', { name: /take principal/i })).toBeNull();
  });

  it('the rescue is offered for an open lock in the 6000 band, and not for an open lock outside it', async () => {
    reply(WALLET_A, [MATURED_AT_RISK, entry({ address: 'Entry1', nonce: 1, createdTs: RATE_CHANGED_AT + 100, durationSecs: 1 })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    expect(await screen.findAllByRole('button', { name: ARM })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /unstake & claim/i })).toHaveLength(2);
  });
});

describe('the strip keeps its own clock', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a lock that opens while the page is open shows Unstake & claim within a minute', async () => {
    // Only the interval and the clock are faked: the mocked reads still settle on real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t0 = Math.floor(Date.now() / 1000);
    reply(WALLET_A, [entry({ createdTs: t0 - 10, durationSecs: 40 })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByRole('button', { name: /^claim rewards$/i });
    expect(screen.queryByRole('button', { name: /unstake/i })).toBeNull();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole('button', { name: /^unstake & claim$/i })).toBeTruthy();
  });
});

describe('the earned figure', () => {
  it('counts only reward pools paying in the staked token: another mint has other decimals', async () => {
    poolState.pool = {
      ...POOL,
      rewardPools: [POOL.rewardPools[0]!, { ...POOL.rewardPools[0]!, address: 'Rp1', nonce: 1, vault: 'V1', mint: 'OtherMint', decimals: 9 }],
    };
    reply(WALLET_A, [entry({ pendingRaw: { 0: 19_524_569n, 1: 5_000_000_000n } })]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findAllByRole('button', { name: /^claim rewards/i });
    expect(screen.getByText(/^19\.524569 BAYLA earned$/)).toBeTruthy();
  });
});

describe('the wallet context', () => {
  it('the strip mounts no wallet context of its own: it shares the ladder card\'s', async () => {
    reply(WALLET_A, [LOCKED]);
    render(<LighthouseClaimStrip bungalow={BAYLA} />);
    await screen.findByRole('button', { name: /^claim rewards$/i });
    expect(providerMounts.n).toBe(0);
  });
});
