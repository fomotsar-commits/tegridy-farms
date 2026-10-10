import { appendFileSync as __append } from 'node:fs';
const __log = (l) => { if (process.env.SPLIT_LOG) __append(process.env.SPLIT_LOG, '[pre-chg] ' + l +'\n'); };
const __ms = (a, b) => String(Math.round(b - a)).padStart(5);
let __base = 0;
const __tl = [];
const __mark = (n) => { __tl.push(n + '@' + Math.round(performance.now() - __base)); };
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
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
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

vi.mock('../../lib/bungalowStaking', async (importOriginal) => {
  const __o = await importOriginal<typeof import('../../lib/bungalowStaking')>();
  const __traced: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(__o)) {
    __traced[k] = typeof v !== 'function' ? v : (...a: unknown[]) => {
      const s0 = performance.now();
      const r = (v as (...x: unknown[]) => unknown)(...a);
      if (r && typeof (r as Promise<unknown>).then === 'function') void (r as Promise<unknown>).finally(() => __log(`lighthouse REAL async ${k} took ${__ms(s0, performance.now())}ms`));
      return r;
    };
  }
  return {
  ...__traced,
  readPool: vi.fn(async () => (__mark('readPool'), { ok: true as const, pool: pool() })),
  readEntries: vi.fn(async () => (__mark('readEntries'), { ok: true as const, entries: s.entries.map((f) => f()) })),
  readWalletBalance: vi.fn(async () => (__mark('readWalletBalance'), { ok: true as const, raw: 5_000_000n })),
  readShareBasis: vi.fn(async () => (__mark('readShareBasis'), s.basis)),
  readConfirmedSlot: vi.fn(async () => s.writeSlot),
  unstakeAndClaim: vi.fn(async () => ({ ok: true as const, txId: 'TX-EXIT-A' })),
}; });

const __c0 = performance.now();
const { LighthousePoolLive } = await import('./LighthousePoolLive');
__log(`lighthouse collection import=${__ms(__c0, performance.now())}ms`);

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

beforeEach(() => {
  poolState.totalEffective = 100_000_000n;
  s.entries = [A, B];
  s.basis = { mineEffectiveRaw: 20n * M, totalEffectiveRaw: 100n * M, slot: 400 };
  s.writeSlot = 500;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the lighthouse card, drawn with a wallet', () => {
  for (const __pass of ['first', 'again']) it(`jsdom does not measure layout — so these pin structure and text, not pixels (${__pass})`, async () => {
    const __b0 = performance.now();
    const __at: Record<string, number> = {};
    const __mo = new MutationObserver(() => {
      const t = document.body.textContent ?? '';
      for (const w of ['reading your stakes', 'of each payout']) if (!(w in __at) && t.includes(w)) __at[w] = performance.now();
    });
    __mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    __tl.length = 0; __base = performance.now();
    render(<LighthousePoolLive bungalow={BUNGALOW} />);
    const __b1 = performance.now();
    __mark('render-returned');
    const __q: number[] = [];
    await waitFor(() => { const s0 = performance.now(); try { expect(shareParts().note.textContent ?? '').toMatch(/of each payout/); } finally { __q.push(Math.round(performance.now() - s0)); } }, { timeout: 25000 });
    const __b2 = performance.now();
    __mo.disconnect();
    const rel = (k: string) => (k in __at ? __ms(__b1, __at[k]!) + 'ms' : 'never');
    __log(`lighthouse walletStates (${__pass}): render()=${__ms(__b0, __b1)}ms | after render: "reading your stakes" at ${rel('reading your stakes')}, "of each payout" in the DOM at ${rel('of each payout')}, the wait saw it at ${__ms(__b1, __b2)}ms | ${__q.length} shareParts() calls took [${__q.join(', ')}]ms | ${document.querySelectorAll('*').length} DOM nodes | timeline from the body's start: ${__tl.join(' ')}`);
    const r = shareParts().cell.getBoundingClientRect();
    expect([r.width, r.height]).toEqual([0, 0]);
  }, 30000);

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
