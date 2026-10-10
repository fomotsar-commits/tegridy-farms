// What a pool card says its shares have earned (owner, 2026-10-09: "I don't see any way to
// claim rewards or even see rewards coming"). From what the finder already read, with no
// call: the last trade, what each share has grown since the pool opened, and the pace. On a
// press: the pool's last 20 transactions, and 20 more at a time. The venue's uncollected
// cut is named as the venue's, so nobody reads it as fees of their own waiting to be claimed.
// The figures are the venue's own BAYLA/SOL pool as mainnet held it at slot 455093758.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PoolCard, UnreadPoolCard } from './PoolCard';
import type { LpReaders } from './readers';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import { decodeObservationState } from '../../../lib/solana/lp/ownPrice';
import { PACE_SENTENCE } from '../../../lib/solana/lp/pace';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { POOL_PAST_BUTTON, type PoolPastPage, type PoolTx } from '../../../lib/solana/lp/poolPast';
import { pausedText } from '../../../lib/solana/lp/rpcBudget';
import { BAYLA_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { HISTORY_PAGES_MAX } from '../../../lib/solana/lp/txHistory';
import { buildPool, observationBytes, viewOf } from '../../../lib/solana/lp/testkit.fixture';

// The pool at that slot: the SOL reserve is the vault (25,648,407,921) less the venue's
// uncollected 801,600; isqrt(Rc x Rt) = 372,663,147,122 over 372,631,821,673 shares.
const VENUE_CUT = 801_600n;
const Rc = 25_647_606_321n;
const Rt = 5_414_845_326_496n;
const S = 372_631_821_673n;
const OPEN_TIME = 1_791_055_084n;
const THIRD_SWAP = 1_791_514_249n;
// 2026-10-10 02:31:00 UTC: 544,376 s, 6.3 days, after the pool opened.
const NOW = 1_791_599_460n;

const GROWTH = 'Since this pool opened on 2026-10-03 19:18 UTC, each share has grown 0.0084% from trading fees and anything else sent into the pool.';
const PACE = '0.0084% in 6.3 days. At that pace, about 0.48% a year. Past trades, not a forecast.';
const NO_TRADE = 'No trade has reached this pool yet, so there are no fees yet.';

type History = PoolView['history'];
function record(o: { initialized?: boolean; lastUpdate?: bigint } = {}): History {
  const obs = decodeObservationState(observationBytes({ pool: new PublicKey(BAYLA_MINT), initialized: o.initialized, index: 2, lastUpdate: o.lastUpdate ?? THIRD_SWAP }));
  if (!obs) throw new Error('the test bytes do not decode as a price record');
  return { kind: 'ok', obs };
}
function view(history: History = record(), creatorFee = false): PoolView {
  const b = buildPool({ plain: true, mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: S, protocolFeesSol: VENUE_CUT, openTime: OPEN_TIME });
  const v = viewOf(b, { sol: Rc, tok: Rt, origin: 'standard', history, config: recordedTier(1) });
  return creatorFee ? { ...v, snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, enableCreatorFee: true } } } : v;
}
const token = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

afterEach(cleanup);

function mount(v: PoolView, o: { chainNow?: bigint | null; poolPast?: LpReaders['poolPast'] | null } = {}) {
  const chainNow = o.chainNow === undefined ? NOW : o.chainNow;
  const safety = token(v.tokenMint);
  const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside: { kind: 'ok', solPerToken: 0.0047, source: 'Jupiter' }, safety });
  render(
    <ul>
      <PoolCard view={v} health={health} tokenDecimals={6} safety={safety} chainNow={chainNow} readers={o.poolPast === null ? null : o.poolPast ? { poolPast: o.poolPast } : {}} />
    </ul>,
  );
  return screen.getByTestId('lp-pool');
}
const rowValue = (el: HTMLElement, label: string) => within(el).getByText(label, { exact: true }).nextElementSibling?.textContent;

describe('what the shares have earned, with no press and no read of its own', () => {
  it('the venue’s pool: its last trade, 0.0084% more behind each share since it opened, and the pace with its basis', () => {
    const poolPast = vi.fn();
    const card = mount(view(), { poolPast });
    const earned = within(card).getByTestId('lp-pool-earned');
    expect(within(earned).getByTestId('lp-pool-trade').textContent).toBe('Last trade: 2026-10-09 02:50:49 UTC');
    expect(within(earned).getByTestId('lp-pool-growth').textContent).toBe(GROWTH);
    expect(within(earned).getByTestId('lp-pace').textContent).toBe(PACE);
    // Nothing was read for it: the pool's past is asked for on a press only.
    expect(poolPast).not.toHaveBeenCalled();
    // The sentence trunk already had stays: where the providers' share of a fee goes.
    expect(card).toHaveTextContent('LPs’ share of fees is not paid out separately: it stays in the pool, so each pool share is worth a little more after every trade.');
  });

  it('the yearly figure is on the card only inside the whole pace sentence: with it removed, no forecast word is left', () => {
    const card = mount(view());
    const text = card.textContent ?? '';
    expect(text).toMatch(FORECAST_WORDS);
    expect(text.replace(PACE_SENTENCE, '')).not.toMatch(FORECAST_WORDS);
    expect(text).not.toContain('—');
  });

  it('the pace is measured to the chain’s clock: with none read, the growth is said and no pace', () => {
    const card = mount(view(), { chainNow: null });
    expect(within(card).getByTestId('lp-pool-growth').textContent).toBe(GROWTH);
    expect(within(card).queryByTestId('lp-pace')).toBeNull();
    expect(card.textContent).not.toMatch(FORECAST_WORDS);
  });

  it('a pool no trade has reached says so plainly, and prints no percent', () => {
    const card = mount(view(record({ initialized: false, lastUpdate: 0n })));
    const earned = within(card).getByTestId('lp-pool-earned');
    expect(earned.textContent).toBe(NO_TRADE);
    expect(within(card).queryByTestId('lp-pool-growth')).toBeNull();
    expect(within(card).queryByTestId('lp-pace')).toBeNull();
  });

  it('a trade record that could not be read: the reason, and no figure of any kind', () => {
    const card = mount(view({ kind: 'unread', detail: 'its price record account is missing' }));
    const earned = within(card).getByTestId('lp-pool-earned');
    expect(earned.textContent).toBe('Its trade record could not be read (its price record account is missing).');
    expect(earned.textContent).not.toMatch(/\d/);
    expect(within(card).queryByTestId('lp-pool-growth')).toBeNull();
    expect(within(card).queryByTestId('lp-pace')).toBeNull();
  });

  it('a pool that could not be read at all shows no earnings line, no percent and no history button', () => {
    render(
      <ul>
        <UnreadPoolCard entry={{ kind: 'unread', address: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', detail: 'the chain did not answer in 20 seconds' }} />
      </ul>,
    );
    const card = screen.getByTestId('lp-pool');
    expect(card).toHaveTextContent('We could not read this pool (the chain did not answer in 20 seconds). Nothing about it is checked.');
    expect(within(card).queryByTestId('lp-pool-earned')).toBeNull();
    expect(within(card).queryByTestId('lp-pool-past')).toBeNull();
    expect(card.textContent).not.toMatch(/%|grown|Last trade/);
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('a record nobody asked for says nothing', () => {
    const card = mount(view({ kind: 'not-read' }));
    expect(within(card).queryByTestId('lp-pool-earned')).toBeNull();
  });
});

describe('the fees the pool holds for others are named for whose they are', () => {
  it('the venue’s uncollected cut is the venue’s by its label, and nothing on the card reads as fees waiting for a provider', () => {
    const card = mount(view());
    expect(rowValue(card, 'Venue’s cut, not collected yet')).toBe('0.0008 SOL and 0 tokens');
    expect(card).not.toHaveTextContent(/fees waiting|unclaimed|your fees|to claim/i);
    // Every row about an uncollected amount says whose it is, first.
    const labels = [...card.querySelectorAll('span')].map((s) => s.textContent ?? '').filter((t) => /not collected/i.test(t));
    expect(labels).toEqual(['Venue’s cut, not collected yet']);
    for (const label of labels) expect(label).toMatch(/^(Venue|Creator)’s /);
  });

  it('a pool that charges a creator fee names that amount as the creator’s', () => {
    const card = mount(view(record(), true));
    const labels = [...card.querySelectorAll('span')].map((s) => s.textContent ?? '').filter((t) => /not collected/i.test(t));
    expect(labels).toEqual(['Venue’s cut, not collected yet', 'Creator’s fee, not collected yet']);
    expect(card).not.toHaveTextContent(/fees waiting/i);
  });
});

// ── the pool's past, on a press ──

const T0 = 1_791_055_083; // the opening's block time
const W = Array.from({ length: 19 }, (_, i) => `wallet-${i}`);
const at = (n: number) => ({ signature: `sig-${n}`, slot: 1_000 + n, blockTime: T0 + n * 1_000, final: true });
const deposit = (n: number, signer: string): PoolTx => ({ kind: 'deposit', ...at(n), signer });
const swap = (n: number, lamports: bigint): PoolTx => ({ kind: 'swap', ...at(n), inSide: 'coin', inAmount: lamports });
const SWAPS: Record<number, bigint> = { 30: 122_000_000n, 25: 369_000_000n, 20: 10_000_000n };
/** The newest 20 of 34 (numbered 33 down to 14): 3 swaps and 17 deposits from 13 wallets. */
function newest(): PoolTx[] {
  let d = 0;
  return Array.from({ length: 20 }, (_, i) => 33 - i).map((n) => (SWAPS[n] !== undefined ? swap(n, SWAPS[n]!) : deposit(n, W[d++ % 13]!)));
}
/** The 14 before them: 13 deposits from 8 wallets, two of which are on the first page too, and the opening. */
function oldest(): PoolTx[] {
  const signers = [11, 12, 13, 14, 15, 16, 17, 18];
  const deposits = Array.from({ length: 13 }, (_, i) => deposit(13 - i, W[signers[i % 8]!]!));
  return [...deposits, { kind: 'opening', ...at(0), signer: W[13]! }];
}
const FIRST_PAGE = /^Last 20 transactions on this pool, 2026-10-03 23:11 UTC to 2026-10-04 04:28 UTC: 3 swaps, 17 deposits from 13 wallets, 0 withdrawals, 0 other\. Traded in: 0\.501 SOL and 0 BAYLA\. Fees are this tier’s rate on that volume; the rate can change, so no total is shown\. Older transactions were not read\.$/;
const WHOLE = 'All 34 transactions since this pool opened on 2026-10-03 19:18 UTC: 3 swaps, 30 deposits from 19 wallets, 0 withdrawals, 1 opening, 0 other. Traded in: 0.501 SOL and 0 BAYLA. Fees are this tier’s rate on that volume; the rate can change, so no total is shown.';

const pastButton = (card: HTMLElement) => within(card).getByRole('button', { name: POOL_PAST_BUTTON });
const more = (card: HTMLElement) => within(card).queryByRole('button', { name: 'Read 20 more' });
const pastText = (card: HTMLElement) => within(card).findByTestId('lp-pool-past-text');
const pages = (...answers: PoolPastPage[]) => {
  const fn = vi.fn<NonNullable<LpReaders['poolPast']>>();
  for (const a of answers) fn.mockResolvedValueOnce(a);
  return fn;
};

describe('the pool’s last 20 transactions, on a press', () => {
  it('a build without the reader shows no button and no block', () => {
    const card = mount(view(), { poolPast: null });
    expect(within(card).queryByTestId('lp-pool-past')).toBeNull();
    cleanup();
    expect(within(mount(view())).queryByTestId('lp-pool-past')).toBeNull();
  });

  it('one press reads one page and prints its swaps, deposits, wallets and what was traded in; the buttons are finger-sized', async () => {
    const poolPast = pages({ kind: 'page', items: newest(), more: true });
    const v = view();
    const card = mount(v, { poolPast });
    expect(pastButton(card).className).toMatch(/min-h-\[44px\]/);
    fireEvent.click(pastButton(card));
    expect((await pastText(card)).textContent).toMatch(FIRST_PAGE);
    expect(poolPast).toHaveBeenCalledTimes(1);
    expect(poolPast).toHaveBeenCalledWith(v);
    expect(more(card)!.className).toMatch(/min-h-\[44px\]/);
    expect(within(card).getByRole('button', { name: 'Read again' }).className).toMatch(/min-h-\[44px\]/);
    expect(within(card).getByTestId('lp-pool-past')).toHaveAttribute('data-past', 'ok');
  });

  it('Read 20 more reads the page before the oldest entry held and totals both pages together: 19 wallets, not 13 + 8', async () => {
    const poolPast = pages({ kind: 'page', items: newest(), more: true }, { kind: 'page', items: oldest(), more: false });
    const v = view();
    const card = mount(v, { poolPast });
    fireEvent.click(pastButton(card));
    await pastText(card);
    fireEvent.click(more(card)!);
    await waitFor(() => expect(within(card).getByTestId('lp-pool-past-text').textContent).toBe(WHOLE));
    expect(poolPast).toHaveBeenNthCalledWith(2, v, { before: 'sig-14' });
    // The whole history is read: there is nothing more to ask for.
    expect(more(card)).toBeNull();
  });

  it(`stops at ${HISTORY_PAGES_MAX} pages: the button goes, and the sentence still says older ones were not read`, async () => {
    let n = 1_000;
    const full = (): PoolPastPage => ({ kind: 'page', items: Array.from({ length: 20 }, () => deposit(n--, W[0]!)), more: true });
    const poolPast = vi.fn<NonNullable<LpReaders['poolPast']>>(async () => full());
    const card = mount(view(), { poolPast });
    fireEvent.click(pastButton(card));
    await pastText(card);
    for (let page = 2; page <= HISTORY_PAGES_MAX; page++) {
      fireEvent.click(more(card)!);
      await waitFor(() => expect(within(card).getByTestId('lp-pool-past-text').textContent).toMatch(new RegExp(`^Last ${page * 20} transactions on this pool`)));
    }
    expect(more(card)).toBeNull();
    expect(poolPast).toHaveBeenCalledTimes(HISTORY_PAGES_MAX);
    expect(within(card).getByTestId('lp-pool-past-text').textContent).toMatch(/Older transactions were not read\.$/);
  });

  it('a read that was paused, failed or came back in part prints its reason and no count, and can be pressed again', async () => {
    const partial: PoolPastPage = { kind: 'page', items: [...newest().slice(0, 19), { kind: 'unread', signature: 'sig-14', blockTime: null, detail: 'the node has no record of it' }], more: true };
    const cases: [PoolPastPage, string][] = [
      [{ kind: 'paused' }, pausedText()],
      [{ kind: 'unread', detail: 'the chain did not answer in 20 seconds' }, 'This pool’s history could not be read (the chain did not answer in 20 seconds).'],
      [partial, '1 of the 20 could not be read, so no totals are shown. Read again.'],
    ];
    for (const [answer, said] of cases) {
      const card = mount(view(), { poolPast: pages(answer) });
      fireEvent.click(pastButton(card));
      const block = within(card).getByTestId('lp-pool-past');
      await waitFor(() => expect(block).toHaveTextContent(said));
      expect(within(card).queryByTestId('lp-pool-past-text')).toBeNull();
      expect(block.textContent).not.toMatch(/swaps?,|deposits? from|Traded in/);
      expect(more(card)).toBeNull();
      expect(within(block).getAllByRole('button')).toHaveLength(1);
      cleanup();
    }
  });

  it('a reader that throws is a read that failed, with its reason', async () => {
    const card = mount(view(), { poolPast: vi.fn(async () => { throw new Error('the chain did not answer in 20 seconds'); }) });
    fireEvent.click(pastButton(card));
    await waitFor(() => expect(within(card).getByTestId('lp-pool-past')).toHaveTextContent('This pool’s history could not be read (the chain did not answer in 20 seconds).'));
  });

  it('an older page that could not be read whole is left out: what was read stays as it was, and the reason is said under it', async () => {
    const broken: PoolPastPage = { kind: 'page', items: [...oldest().slice(0, 13), { kind: 'unread', signature: 'sig-0', blockTime: null, detail: 'x' }], more: false };
    const cases: [PoolPastPage, string][] = [
      [broken, '1 of the older transactions could not be read, so none of that page is counted. Press Read 20 more again.'],
      [{ kind: 'unread', detail: 'HTTP 502' }, 'The older transactions could not be read (HTTP 502).'],
      [{ kind: 'paused' }, pausedText()],
    ];
    for (const [older, said] of cases) {
      const card = mount(view(), { poolPast: pages({ kind: 'page', items: newest(), more: true }, older) });
      fireEvent.click(pastButton(card));
      await pastText(card);
      fireEvent.click(more(card)!);
      await waitFor(() => expect(within(card).getByTestId('lp-pool-past')).toHaveTextContent(said));
      expect(within(card).getByTestId('lp-pool-past-text').textContent).toMatch(FIRST_PAGE);
      expect(more(card)).not.toBeNull();
      cleanup();
    }
  });

  it('a press while a read is running starts no second read', async () => {
    let answer: (p: PoolPastPage) => void = () => {};
    const poolPast = vi.fn<NonNullable<LpReaders['poolPast']>>(() => new Promise<PoolPastPage>((resolve) => { answer = resolve; }));
    const card = mount(view(), { poolPast });
    fireEvent.click(pastButton(card));
    expect(within(card).getByRole('status')).toHaveTextContent('Reading this pool’s transactions…');
    fireEvent.click(pastButton(card));
    fireEvent.click(pastButton(card));
    expect(poolPast).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ kind: 'page', items: newest(), more: true }); });
    expect((await pastText(card)).textContent).toMatch(FIRST_PAGE);
    expect(within(card).queryByRole('status')).toBeNull();
  });
});
