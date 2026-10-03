// THE WALLET-ONLY STATES OF THE LIGHTHOUSE CARD, DRAWN.
//
// The last layout sweep ran with no wallet connected, so it never drew the states the
// honesty rounds added. These mount the card WITH a wallet and pin, for each state, that
// the words land in the "Your share" cell/footnote — non-empty, inside their container —
// and that nothing reads "0" or "0%" where the value was not read.
//
// jsdom does not lay out: getBoundingClientRect is all zeros. So these pin STRUCTURE and
// TEXT (containment in the DOM tree), not pixel overflow. The first test proves that, so
// nobody mistakes a green here for a layout measurement.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within, configure } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

const DAY = 86_400;
const WEIGHT_SCALE = 1_000_000_000n;
const M = 1_000_000n;

const poolState = vi.hoisted(() => ({ totalEffective: 100_000_000n as bigint }));
const pool = () => ({
  address: 'PooLAddr1111111111111111111111111111111111',
  mint: 'MintAddr',
  decimals: 6,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  minDurationSecs: DAY,
  maxDurationSecs: 365 * DAY,
  minWeightScaled: WEIGHT_SCALE,
  maxWeightScaled: 5n * WEIGHT_SCALE,
  unstakePeriodSecs: 0,
  totalStakeRaw: poolState.totalEffective,
  totalEffectiveStakeRaw: poolState.totalEffective,
  rewardPools: [{
    address: 'Rp0', mint: 'MintAddr', kind: 'dynamic' as const, nonce: 0, vault: 'V0',
    decimals: 6, fundedRaw: 1_000_000_000_000n, permissionless: true,
    rewardAmountRaw: '0', rewardPeriodSecs: 0,
    fundedAmountRaw: 1_000_000_000_000n, claimedAmountRaw: 0n, claimPeriodSecs: DAY,
    rateChangedAtTs: null,
  }],
});

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => {
    const pk = { toBase58: () => 'StakerPk1111111111111111111111111111111111' };
    return { publicKey: pk, wallet: { adapter: { publicKey: pk } }, connected: true };
  },
}));
vi.mock('../solana/useSolanaConnect', () => ({ useSolanaConnect: () => () => {} }));

const entry = (address: string, nonce: number, effective: bigint) => ({
  address, nonce, amountRaw: effective, durationSecs: 1,
  createdTs: 1, closedTs: 0, effectiveAmountRaw: effective,
  pendingRaw: { 0: 1n }, accountedRaw: { 0: 0n },
});
const A = () => entry('EntryA', 0, 10n * M);
const B = () => entry('EntryB', 1, 10n * M);

const s = vi.hoisted(() => ({
  entries: [] as (() => unknown)[],
  basis: null as unknown,
  writeSlot: null as number | null,
}));

vi.mock('../../lib/bungalowStaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/bungalowStaking')>()),
  readPool: vi.fn(async () => ({ ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => ({ ok: true as const, entries: s.entries.map((f) => f()) })),
  readWalletBalance: vi.fn(async () => ({ ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => s.basis),
  readConfirmedSlot: vi.fn(async () => s.writeSlot),
  unstakeAndClaim: vi.fn(async () => ({ ok: true as const, txId: 'TX-EXIT-A' })),
}));

const { LighthousePoolLive } = await import('./LighthousePoolLive');

const BUNGALOW = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana',
  stakePool: 'PooLAddr1111111111111111111111111111111111', address: 'MintAddr',
} as unknown as Bungalow & { stakePool: string };

/** The "Your share" ledger cell (a Fact), its value paragraph, and its footnote line. */
function shareParts() {
  const figures = screen.getByRole('region', { name: 'The lighthouse pool figures' });
  const label = within(figures).getByText('Your share');
  const cell = label.parentElement as HTMLElement;
  const value = label.nextElementSibling as HTMLElement;
  const note = within(figures).getByText('Your share —').parentElement as HTMLElement;
  return { figures, cell, value, note };
}

/** Present, non-empty, and inside its container — the most jsdom can say about fit. */
function assertInCell(el: HTMLElement, container: HTMLElement) {
  expect(el).toBeTruthy();
  expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
  expect(container.contains(el)).toBe(true);
}

/** No bare 0 / 0% where the value was not read. */
function assertNoZero(text: string) {
  expect(text).not.toMatch(/(^|[^0-9.,])0(\.0+)?%/);
  expect(text).not.toMatch(/^\s*0\s*$/);
}

async function noteShows(re: RegExp) {
  await waitFor(() => expect(shareParts().note.textContent ?? '').toMatch(re));
}

// The first test to run pays for the card's first full render and the first role query
// inside its wait. That is real work (no import is left cold, no read is left real):
// 0.7 to 0.9s on a busy machine against Testing Library's 1s default. So the waits get
// 10s and the tests 20s. Both are their own clocks: --testTimeout moves neither.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  poolState.totalEffective = 100_000_000n;
  s.entries = [A, B];
  s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 400 };
  s.writeSlot = 500;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the lighthouse card, drawn with a wallet', () => {
  it('jsdom does not measure layout — so these pin structure and text, not pixels', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await noteShows(/of each payout/);
    const r = shareParts().cell.getBoundingClientRect();
    expect([r.width, r.height]).toEqual([0, 0]);
  });

  it('a normal figure: "20%" in the cell, the payout sentence in its footnote', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await noteShows(/of each payout/);
    const { cell, value, note } = shareParts();
    assertInCell(value, cell);
    expect(value.textContent).toBe('20%');
    assertInCell(note, shareParts().figures);
  });

  it('⚠️ "could not be read": the cell holds "–", never 0 or 0%', async () => {
    s.basis = null;
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await noteShows(/could not be read\./);
    const { cell, value, note } = shareParts();
    assertInCell(value, cell);
    expect(value.textContent).toBe('–');
    assertNoZero(value.textContent ?? '');
    assertNoZero(note.textContent ?? '');
  });

  it('⚠️ "updating…" after your own exit: the cell holds "–", never 0, 0% or the stale 20%', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    await noteShows(/of each payout/);
    s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 400 };
    const btn = await screen.findAllByRole('button', { name: 'Unstake & claim' });
    await act(async () => { fireEvent.click(btn[0]!); });
    await screen.findByText(/Unstake confirmed\./);
    await noteShows(/updating…/);
    const { cell, value, note } = shareParts();
    assertInCell(value, cell);
    expect(value.textContent).toBe('–');
    assertNoZero(value.textContent ?? '');
    assertNoZero(note.textContent ?? '');
    expect(value.textContent).not.toMatch(/20%/);
  });

  it('the Claim button is drawn, inside its entry, when entries exist', async () => {
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const claims = await screen.findAllByRole('button', { name: 'Claim rewards' });
    expect(claims).toHaveLength(2); // one per open entry, one reward pool each
    for (const c of claims) {
      expect((c.textContent ?? '').trim()).toBe('Claim rewards');
      expect((c as HTMLButtonElement).disabled).toBe(false);
      expect(c.parentElement).toBeTruthy();
      expect(c.parentElement!.contains(c)).toBe(true);
    }
  });
});
