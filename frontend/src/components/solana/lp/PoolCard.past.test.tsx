// The pool past block inside the card's fold (DESIGN 2.C1, 2.B1): a 44px press reads the
// pool's last 20 transactions through `readers.poolPast`, never on page load (a search lists
// up to 103 pools; that would be 2,000 calls), and prints B1's sentence for each of its four
// answers. A build without the reader shows no button. Red on e33a42ed: the card had no
// pool past at all.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PoolCard } from './PoolCard';
import type { LpReaders } from './readers';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { POOL_PAST_BUTTON, type PoolPastRead } from '../../../lib/solana/lp/poolPast';
import { pausedText } from '../../../lib/solana/lp/rpcBudget';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { BUNGALOWS } from '../../../lib/bungalows';

const BAYLA = BUNGALOWS.find((b) => b.id === 'bayla' && b.chain === 'solana')?.address;
if (!BAYLA) throw new Error('the BAYLA room has no Solana mint in the registry');

/** The BAYLA/SOL pool after its eight transactions (MAINNET_FACTS.md), nobody has traded. */
const RC = 4_832_878_899n;
const RT = 1_062_021_556_414n;
function view(): PoolView {
  const b = buildPool({ plain: true, mint: new PublicKey(BAYLA!), configIndex: 1, quoteReserve: RC, tokenReserve: RT, openTime: 1n });
  const history: PoolView['history'] = { kind: 'ok', obs: { initialized: false, index: 0, poolId: new Uint8Array(32), observations: [], lastUpdate: 0n } };
  return viewOf(b, { sol: RC, tok: RT, origin: 'standard', history, config: recordedTier(1) });
}
const token = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

/** The eight mainnet transactions, as B1 totals them: no swap, seven deposits from six wallets, the opening. */
const EIGHT: PoolPastRead = {
  kind: 'ok', count: 8, swaps: 0, deposits: 7, withdrawals: 0, openings: 1, wallets: 6, other: 0,
  volumeIn: { token: 0n, coin: 0n },
  from: Math.floor(Date.UTC(2026, 9, 3, 19, 18, 3) / 1000), to: Math.floor(Date.UTC(2026, 9, 4, 18, 11, 12) / 1000),
  complete: true, reachedOpening: true,
};
const EIGHT_TEXT =
  'All 8 transactions since this pool opened on 2026-10-03 19:18 UTC: 0 swaps, 7 deposits from 6 wallets, 0 withdrawals, 1 opening, 0 other. Traded in: 0 SOL and 0 BAYLA. Fees are this tier’s rate on that volume; the rate can change, so no total is shown.';

afterEach(cleanup);

/** Only `poolPast` is read here; the card asks the readers for nothing else. */
const readersWith = (poolPast: LpReaders['poolPast']): Pick<LpReaders, 'poolPast'> => (poolPast ? { poolPast } : {});

function mount(readers: Pick<LpReaders, 'poolPast'> | undefined) {
  const v = view();
  render(
    <ul>
      <PoolCard view={v} health={assessPool({ view: v, tokenDecimals: 6, chainNow: 1_000n, outside: { kind: 'ok', solPerToken: 0.0045, source: 'Jupiter' }, safety: token(v.tokenMint) })} tokenDecimals={6} safety={token(v.tokenMint)} readers={readers} />
    </ul>,
  );
  return screen.getByTestId('lp-pool');
}

/** Open the fold as a visitor does, by its summary (jsdom does not toggle a details on that click, so the attribute is set when it did not). */
function openFold(card: HTMLElement): HTMLDetailsElement {
  const more = within(card).getByTestId('lp-pool-more') as HTMLDetailsElement;
  fireEvent.click(within(more).getByText('More about this pool'));
  if (!more.open) more.open = true;
  return more;
}
const pastButton = (scope: HTMLElement) => within(scope).getByRole('button', { name: POOL_PAST_BUTTON });
const pastText = (scope: HTMLElement) => within(scope).findByTestId('lp-pool-past-text');

describe('a build without the reader', () => {
  it('no readers at all, or readers without poolPast: no button and no block', () => {
    const card = mount(undefined);
    expect(within(card).queryByRole('button', { name: POOL_PAST_BUTTON })).toBeNull();
    expect(within(card).queryByTestId('lp-pool-past')).toBeNull();
    cleanup();
    const other = mount(readersWith(undefined));
    expect(within(other).queryByTestId('lp-pool-past')).toBeNull();
  });
});

describe('on a press only', () => {
  it('nothing is read on mount, or when the fold opens; one press reads the pool once', async () => {
    const poolPast = vi.fn(async (): Promise<PoolPastRead> => EIGHT);
    const card = mount(readersWith(poolPast));
    await act(async () => {});
    expect(poolPast).not.toHaveBeenCalled();
    const more = openFold(card);
    await act(async () => {});
    expect(poolPast).not.toHaveBeenCalled();
    const button = pastButton(more);
    expect(button.className).toMatch(/min-h-\[44px\]/);
    fireEvent.click(button);
    expect(await pastText(more)).toHaveTextContent(EIGHT_TEXT);
    expect(poolPast).toHaveBeenCalledTimes(1);
    expect(poolPast.mock.calls[0]![0]).toMatchObject({ address: card.getAttribute('data-pool') });
  });

  it('the block sits inside the fold, closed by default', () => {
    const card = mount(readersWith(vi.fn(async (): Promise<PoolPastRead> => EIGHT)));
    const more = within(card).getByTestId('lp-pool-more');
    expect(more).not.toHaveAttribute('open');
    expect(more.contains(within(card).getByTestId('lp-pool-past'))).toBe(true);
  });

  it('after a read, Read again reads again; a press while a read runs does nothing more', async () => {
    let release!: (r: PoolPastRead) => void;
    const poolPast = vi.fn(() => new Promise<PoolPastRead>((res) => (release = res)));
    const card = mount(readersWith(poolPast));
    const more = openFold(card);
    const button = pastButton(more);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(poolPast).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await act(async () => release(EIGHT));
    expect(await pastText(more)).toHaveTextContent(EIGHT_TEXT);
    expect(within(more).getByTestId('lp-read-at')).toBeInTheDocument();
    fireEvent.click(within(more).getByRole('button', { name: 'Read again' }));
    expect(poolPast).toHaveBeenCalledTimes(2);
    await act(async () => release({ kind: 'partial', unreadCount: 2 }));
    await waitFor(() => expect(within(more).getByTestId('lp-pool-past-text')).toHaveTextContent('2 of the 20 could not be read, so no totals are shown. Read again.'));
  });
});

describe('the four answers, in B1’s words', () => {
  const press = async (read: PoolPastRead | (() => Promise<PoolPastRead>)) => {
    const poolPast = vi.fn(typeof read === 'function' ? read : async () => read);
    const card = mount(readersWith(poolPast));
    const more = openFold(card);
    fireEvent.click(pastButton(more));
    return pastText(more);
  };

  it('ok: the sentence, the opening counted under openings, no fee total', async () => {
    const text = await press(EIGHT);
    expect(text).toHaveTextContent(EIGHT_TEXT);
    expect(text).toHaveAttribute('data-kind', 'ok');
    expect(text).not.toHaveTextContent(/fees? (earned|so far|total)/i);
  });

  it('ok but incomplete: the sentence says older transactions were not read', async () => {
    const text = await press({ ...EIGHT, count: 20, complete: false, reachedOpening: false });
    expect(text).toHaveTextContent(/^Last 20 transactions on this pool, 2026-10-03 19:18 UTC to 2026-10-04 18:11 UTC: /);
    expect(text).toHaveTextContent('Older transactions were not read.');
  });

  it('partial: how many of the 20 could not be read, and no totals', async () => {
    const text = await press({ kind: 'partial', unreadCount: 3 });
    expect(text).toHaveTextContent('3 of the 20 could not be read, so no totals are shown. Read again.');
    expect(text).not.toHaveTextContent(/swaps|deposits/);
  });

  it('unread: the detail, and never a zero', async () => {
    const text = await press({ kind: 'unread', detail: 'HTTP 502' });
    expect(text).toHaveTextContent('This pool’s history could not be read (HTTP 502).');
    expect(text).not.toHaveTextContent(/\b0\b/);
    expect(text).not.toHaveTextContent(/swaps|deposits/);
  });

  it('paused: the budget gate’s own sentence', async () => {
    const text = await press({ kind: 'paused' });
    expect(text).toHaveTextContent(pausedText());
    expect(text).not.toHaveTextContent(/swaps|deposits/);
  });

  it('a reader that throws is an unread, said with its message', async () => {
    const text = await press(async () => { throw new Error('the chain did not answer in 20 seconds'); });
    expect(text).toHaveTextContent('This pool’s history could not be read (the chain did not answer in 20 seconds).');
  });
});
