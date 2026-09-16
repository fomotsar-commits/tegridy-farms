// CLOSING THE DOOR MUST NOT LOCK ANYONE IN.
//
// `depositsClosed` retires the BAYLA Streamflow pool while it keeps running for
// up to a year, because its stakers are locked and Streamflow has no migration
// between pools. The whole risk of a flag like this is scope: it is supposed to
// remove ONE control — the stake form — and it sits in the same component as
// every exit those stakers have.
//
// So the load-bearing assertions here are the NEGATIVE ones. "The stake button
// is gone" is easy and would pass even if the flag had hidden the entire card.
// What only this file can catch is a closed door that also took the claim, the
// unstake, or the principal rescue with it — and that failure traps exactly the
// cohort the flag exists to protect.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const RATE_CHANGED_AT = 1_788_241_201;

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

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
const walletState = vi.hoisted(() => ({
  publicKey: null as { toBase58: () => string } | null,
}));
// `invoker` is `wallet?.adapter` (LighthousePoolLive.tsx:265) and every write
// button is disabled without it. A harness that leaves it null makes "the claim
// button is enabled" unassertable, so it is supplied here — otherwise the
// negative assertions below would pass against a permanently dead control.
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: walletState.publicKey,
    wallet: walletState.publicKey ? { adapter: { publicKey: walletState.publicKey } } : null,
    connected: !!walletState.publicKey,
  }),
}));
// useSolanaConnect returns the click HANDLER itself, not a {connect} object —
// the old shape here was never exercised, because until the disconnected cases
// below existed every test in this file ran with a wallet already attached, and
// the one button that consumes it never rendered. A mock that cannot be used as
// an onClick is how a missing Connect button stays invisible to its own suite.
vi.mock('../solana/useSolanaConnect', () => ({
  useSolanaConnect: () => () => {},
}));

// An OPEN, MATURED position: the lock has expired, so every exit control the
// component has is supposed to be on screen. That is what makes this fixture
// the right one to close the door in front of.
const MATURED = {
  address: 'Entry0', nonce: 0, amountRaw: 1_000_000n, durationSecs: 1,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: 1_000_000n,
  pendingRaw: { 0: 900_000n }, accountedRaw: { 0: 0n },
};
const entriesState = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: POOL })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: entriesState.list })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const base = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: POOL.address, address: POOL.mint,
};
const OPEN_POOL = base as unknown as Bungalow & { stakePool: string };
const CLOSED_POOL = { ...base, depositsClosed: true } as unknown as Bungalow & { stakePool: string };

beforeEach(() => {
  walletState.publicKey = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
  entriesState.list = [MATURED];
});

describe('a pool closed to new deposits', () => {
  it('still offers CLAIM to someone already in it', async () => {
    render(<LighthousePoolLive bungalow={CLOSED_POOL} />);
    // The single most important assertion in this file. A flag that removed the
    // claim would silently strand every reward in a pool nobody can leave for
    // a year, and the stake-button assertion below would still be green.
    const claim = await screen.findByRole('button', { name: /claim rewards/i });
    expect(claim).toBeTruthy();
    expect((claim as HTMLButtonElement).disabled).toBe(false);
  });

  it('still offers UNSTAKE on a matured position', async () => {
    render(<LighthousePoolLive bungalow={CLOSED_POOL} />);
    const exit = await screen.findByRole('button', { name: /unstake/i });
    expect(exit).toBeTruthy();
    expect((exit as HTMLButtonElement).disabled).toBe(false);
  });

  it('removes the stake form: no amount field, no lock picker, no submit', async () => {
    render(<LighthousePoolLive bungalow={CLOSED_POOL} />);
    await screen.findByText(/closed to new deposits/i);
    // The section heading goes with the section.
    expect(screen.queryByText(/^Stake BAYLA$/)).toBeNull();
    // The submit button's label is dynamic - "Stake & lock for 3 months" once an
    // amount is entered, "Enter an amount" before that - so both are excluded.
    expect(screen.queryByRole('button', { name: /stake & lock|enter an amount/i })).toBeNull();
    // The lock ladder and the balance/MAX control belong to the form and go with it.
    // "Lock duration" is STATIC text inside the form, so it is present the
    // instant the form is. The lock-preset BUTTONS are not usable as a marker:
    // their labels are derived from the pool read, so their accessible names
    // are empty until it resolves and a role+name query races it.
    expect(screen.queryByText(/lock duration/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /balance:/i })).toBeNull();
  });

  it('says the POOL did not change, the venue did', async () => {
    render(<LighthousePoolLive bungalow={CLOSED_POOL} />);
    const notice = await screen.findByText(/closed to new deposits/i);
    const text = notice.parentElement?.textContent ?? '';
    // The stake program has no update_pool at all, so the terms are immutable
    // and anyone can still stake by building the instruction themselves.
    // Claiming the chain closed would be a plain falsehood on the card.
    expect(text).toMatch(/venue/i);
    expect(text).toMatch(/still exists on-chain|immutable/i);
    // And it must not read as an outage or a loss to the people already in.
    expect(text).toMatch(/keeps running|comes back in full/i);
  });

  it('leaves an OPEN pool completely alone', async () => {
    render(<LighthousePoolLive bungalow={OPEN_POOL} />);
    // Absent-by-default: no other resident is touched by a BAYLA decision.
    expect(await screen.findByText(/^Stake BAYLA$/)).toBeTruthy();
    expect(screen.getByText(/lock duration/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /stake & lock|enter an amount/i })).toBeTruthy();
    expect(screen.queryByText(/closed to new deposits/i)).toBeNull();
  });
});

// THE COHORT THE TESTS ABOVE COULD NOT SEE.
//
// Every case above runs with a wallet already attached, because `beforeEach`
// supplies one. That is the state `autoConnect` puts a returning staker in, and
// it is exactly why this shipped: the only Connect button on the card lived
// inside the block `depositsClosed` removes, so the exits all survived the flag
// while the way to REACH them did not. Anyone arriving disconnected — a new
// device, a cleared browser, or a wallet that only became selectable later —
// found a pool that promises "claims work" and offered no way to claim.
describe('a closed pool, arrived at with no wallet connected', () => {
  beforeEach(() => {
    walletState.publicKey = null;
  });

  it('still offers a way to CONNECT', async () => {
    render(<LighthousePoolLive bungalow={CLOSED_POOL} />);
    expect(await screen.findByText(/closed to new deposits/i)).toBeTruthy();
    const connect = screen.getByRole('button', { name: /connect solana wallet/i });
    expect(connect).toBeTruthy();
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });

  it('says what connecting is FOR here — leaving, not staking', async () => {
    render(<LighthousePoolLive bungalow={CLOSED_POOL} />);
    await screen.findByRole('button', { name: /connect solana wallet/i });
    // A closed pool must not invite a deposit it cannot accept.
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/claim rewards|unstake/i);
    expect(screen.queryByRole('button', { name: /stake & lock|enter an amount/i })).toBeNull();
  });

  it('an OPEN pool still offers connect too (the flag is not the only path)', async () => {
    render(<LighthousePoolLive bungalow={OPEN_POOL} />);
    expect(await screen.findByRole('button', { name: /connect solana wallet/i })).toBeTruthy();
  });

  it('renders exactly ONE connect button, never two', async () => {
    // The closed-pool CTA sits outside the `!depositsClosed` block and the open
    // one inside it. If that guard is ever loosened, a disconnected visitor to
    // an open pool would see the control twice.
    render(<LighthousePoolLive bungalow={OPEN_POOL} />);
    await screen.findByRole('button', { name: /connect solana wallet/i });
    expect(screen.getAllByRole('button', { name: /connect solana wallet/i })).toHaveLength(1);
  });
});
