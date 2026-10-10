// The pool card's identity, its trade record, what a wish asked of it, and its fold
// (DESIGN 2.C1, 2.A2, 2.A6). Red on e33a42ed: the heading was the pool's kind ("Standard
// address, fee tier 1"), two same-pair cards read alike, the trade record was not printed
// for any pool, and the addresses sat in full on the open card.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PoolCard, UnreadPoolCard } from './PoolCard';
import { LpWritesProvider } from './useLpWrites';
import type { LpReaders } from './readers';
import { fakeLpApi, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { assessPool, formatWhen } from '../../../lib/solana/lp/poolHealth';
import { pairAccessibleName, pairLabel } from '../../../lib/solana/lp/identity';
import { shortAddress } from '../../../lib/solana/lp/format';
import { NO_TRADE_YET } from '../../../lib/solana/lp/poolPast';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { BUNGALOWS } from '../../../lib/bungalows';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));

const BAYLA = BUNGALOWS.find((b) => b.id === 'bayla' && b.chain === 'solana')?.address;
if (!BAYLA) throw new Error('the BAYLA room has no Solana mint in the registry');

/** The BAYLA/SOL pool's reserves after its eight transactions (MAINNET_FACTS.md). */
const RC = 4_832_878_899n;
const RT = 1_062_021_556_414n;
const OPENED = BigInt(Math.floor(Date.UTC(2026, 9, 3, 19, 18, 3) / 1000));

const untraded = (): PoolView['history'] => ({ kind: 'ok', obs: { initialized: false, index: 0, poolId: new Uint8Array(32), observations: [], lastUpdate: 0n } });
const tradedAt = (time: bigint): PoolView['history'] => ({
  kind: 'ok',
  obs: { initialized: true, index: 0, poolId: new Uint8Array(32), observations: [{ blockTimestamp: time, cumulative0: 0n, cumulative1: 0n }], lastUpdate: time },
});

/** A pool of `mint` paired with SOL: the mainnet reserves, the recording's tier 1, open since the start. */
function view(mint: PublicKey = key(), o: { history?: PoolView['history']; origin?: PoolView['origin']; protocolFeesSol?: bigint } = {}): PoolView {
  const b = buildPool({ plain: true, mint, configIndex: 1, quoteReserve: RC, tokenReserve: RT, openTime: 1n, protocolFeesSol: o.protocolFeesSol });
  return viewOf(b, { sol: RC, tok: RT, origin: o.origin ?? 'standard', history: o.history ?? untraded(), config: recordedTier(1) });
}

const token = (mint: string, name = 'Some Token', symbol = 'SOME'): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name, symbol, metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});
const healthOf = (v: PoolView, safety: TokenSafety) => assessPool({ view: v, tokenDecimals: 6, chainNow: 1_000n, outside: { kind: 'ok', solPerToken: 0.0045, source: 'Jupiter' }, safety });

afterEach(cleanup);

function mount(v: PoolView, o: { safety?: TokenSafety; showNow?: number; shownAs?: 'add' | 'show'; onActed?: (n: number) => void; chainNow?: bigint | null } = {}) {
  const safety = o.safety ?? token(v.tokenMint);
  render(
    <ul>
      <PoolCard view={v} health={healthOf(v, safety)} tokenDecimals={6} safety={safety} showNow={o.showNow} shownAs={o.shownAs} onActed={o.onActed} chainNow={o.chainNow} />
    </ul>,
  );
  return screen.getByTestId('lp-pool');
}
const heading = (card: HTMLElement) => within(card).getByRole('heading', { level: 3 });

describe('identity: the pair by the site’s registry, the tier by the pool’s own settings', () => {
  it('the BAYLA mint on the recording’s tier 1 is headed BAYLA / SOL · 1% tier', () => {
    const card = mount(view(new PublicKey(BAYLA)));
    expect(heading(card)).toHaveTextContent(/^BAYLA \/ SOL · 1% tier$/);
  });

  it('a mint the registry does not list is headed by its short address, never by what the token calls itself', () => {
    const v = view();
    const card = mount(v, { safety: token(v.tokenMint, 'BAYLA', 'BAYLA') });
    expect(heading(card)).toHaveTextContent(`${shortAddress(v.tokenMint)} / SOL · 1% tier`);
    expect(heading(card)).not.toHaveTextContent('BAYLA');
    expect(heading(card).textContent).toBe(pairLabel(v));
  });

  it('a screen reader hears where the pool sits, so two same-pair cards are told apart', () => {
    const v = view(new PublicKey(BAYLA));
    const card = mount(v);
    expect(heading(card)).toHaveAttribute('aria-label', pairAccessibleName(v));
    expect(heading(card).getAttribute('aria-label')).toBe(`BAYLA / SOL · 1% tier pool at ${shortAddress(v.address)}`);
  });

  it('the sub-line says where the pool sits in a few words, and shows its address short', () => {
    const card = mount(view());
    expect(card).toHaveTextContent('Standard address for its tier');
    expect(card).not.toHaveTextContent('Standard address, fee tier');
    const row = within(card).getByRole('group', { name: 'Pool address' });
    expect(row).toHaveTextContent('Show whole');
  });

  it('In the pool names the registry’s symbol for a listed token, and says tokens for any other', () => {
    const bayla = mount(view(new PublicKey(BAYLA)));
    expect(within(bayla).getByText('In the pool').nextElementSibling).toHaveTextContent(/SOL and [\d,.]+ BAYLA$/);
    cleanup();
    const other = mount(view());
    expect(within(other).getByText('In the pool').nextElementSibling).toHaveTextContent(/SOL and [\d,.]+ tokens$/);
  });
});

describe('the trade record, from the pool’s own price record (A2)', () => {
  const record = (card: HTMLElement) => within(card).getByTestId('lp-pool-trade');

  it('not initialized: No trade has reached this pool yet., whatever the fee counters hold', () => {
    const card = mount(view(key(), { protocolFeesSol: 5_000n }));
    expect(record(card)).toHaveTextContent(NO_TRADE_YET);
    expect(card).not.toHaveTextContent(/Last trade/);
  });

  it('initialized: Last trade at the record’s own time, never the word active', () => {
    const card = mount(view(key(), { history: tradedAt(OPENED) }));
    expect(record(card)).toHaveTextContent(`Last trade: ${formatWhen(OPENED)}`);
    expect(record(card)).toHaveTextContent('Last trade: 2026-10-03 19:18:03 UTC');
    expect(card).not.toHaveTextContent(/\bactive\b/i);
    expect(card).not.toHaveTextContent(NO_TRADE_YET);
  });

  it('a record that belongs to another pool is said as unread, not as no trade', () => {
    const card = mount(view(key(), { history: { kind: 'unread', detail: 'its price record belongs to another pool' } }));
    expect(record(card)).toHaveTextContent('Its trade record could not be read (its price record belongs to another pool).');
    expect(card).not.toHaveTextContent(NO_TRADE_YET);
  });
});

describe('what a wish asked of this card (shownAs)', () => {
  it("'add' on a pool that offers no form: the why line, and the heading is described by it", async () => {
    const onActed = vi.fn();
    const card = mount(view(), { showNow: 1, shownAs: 'add', onActed });
    const why = within(card).getByTestId('lp-wish-why');
    expect(why).toHaveTextContent('This is your position’s pool. Its Add form was not opened: adding liquidity is not open right now.');
    expect(heading(card)).toHaveAttribute('aria-describedby', why.id);
    await waitFor(() => expect(heading(card)).toHaveFocus());
    expect(onActed).toHaveBeenCalledWith(1);
  });

  it("'show': the heading takes focus and nothing is said about a form", async () => {
    const onActed = vi.fn();
    const card = mount(view(), { showNow: 1, shownAs: 'show', onActed });
    await waitFor(() => expect(heading(card)).toHaveFocus());
    await act(async () => {});
    expect(within(card).queryByTestId('lp-wish-why')).toBeNull();
    expect(heading(card)).not.toHaveAttribute('aria-describedby');
    expect(card).not.toHaveTextContent(/Add form/);
    expect(onActed).toHaveBeenCalledWith(1);
  });

  it('a pool that was not read: the same two ways', async () => {
    const entry = { kind: 'unread' as const, address: key().toBase58(), detail: 'HTTP 502' };
    render(<ul><UnreadPoolCard entry={entry} showNow={1} shownAs="add" /></ul>);
    let card = screen.getByTestId('lp-pool');
    expect(within(card).getByTestId('lp-wish-why')).toHaveTextContent('this pool could not be read just now. Press Add more liquidity on your position again in a minute.');
    await waitFor(() => expect(heading(card)).toHaveFocus());
    cleanup();
    render(<ul><UnreadPoolCard entry={entry} showNow={1} shownAs="show" /></ul>);
    card = screen.getByTestId('lp-pool');
    await waitFor(() => expect(heading(card)).toHaveFocus());
    expect(within(card).queryByTestId('lp-wish-why')).toBeNull();
    expect(card).toHaveTextContent('We could not read this pool (HTTP 502). Nothing about it is checked.');
    expect(within(card).getByRole('group', { name: 'Pool address' })).toHaveTextContent(shortAddress(entry.address));
  });
});

describe('the fold: More about this pool', () => {
  it('closed by default; holds the pairing coin, the venue’s share, the compounding line, the shares issued, Opened by, the token and the chain clock', () => {
    const v = view(new PublicKey(BAYLA));
    const card = mount(v, { chainNow: OPENED });
    const more = within(card).getByTestId('lp-pool-more');
    expect(more).not.toHaveAttribute('open');
    expect(within(more).getByText('More about this pool')).toBeInTheDocument();
    const value = (label: string) => within(more).getByText(label, { exact: true }).nextElementSibling?.textContent;
    expect(value('Paired with')).toBe('SOL');
    expect(value('Venue’s share of fees waiting')).toBe('0 SOL and 0 BAYLA');
    expect(within(more).queryByText('Creator’s share of fees waiting')).toBeNull();
    expect(value('Pool shares issued')).toMatch(/shares$/);
    expect(value('Opened by')).toBe(v.snapshot.pool.poolCreator);
    expect(within(more).getByRole('group', { name: 'Token' })).toHaveTextContent(shortAddress(v.tokenMint));
    expect(more).toHaveTextContent(`Chain clock at the read: ${formatWhen(OPENED)}`);
    // Outside the fold these are not repeated.
    const outside = (card.textContent ?? '').replace(more.textContent ?? '', '');
    expect(outside).not.toMatch(/Paired with|Opened by|Pool shares issued|Chain clock/);
  });

  it('the chain clock that was not read says so, and is never a time', () => {
    const card = mount(view(), { chainNow: null });
    expect(within(card).getByTestId('lp-pool-more')).toHaveTextContent('Chain clock at the read: not read');
    expect(card).not.toHaveTextContent(/Chain clock at the read: \d/);
  });

  it('a creator fee switched on adds the creator’s share to the fold', () => {
    const v = view();
    v.snapshot.pool.enableCreatorFee = true;
    const card = mount(v);
    const more = within(card).getByTestId('lp-pool-more');
    expect(within(more).getByText('Creator’s share of fees waiting')).toBeInTheDocument();
  });
});

describe('addresses: short on the card, whole one press away, an explorer link when the write code is loaded', () => {
  it('without the write code there is no explorer link; the copy button carries the whole address', () => {
    const v = view();
    const card = mount(v);
    expect(within(card).queryByRole('link', { name: 'Explorer' })).toBeNull();
    expect(within(card).getByRole('group', { name: 'Pool address' })).toHaveTextContent(shortAddress(v.address));
  });

  it('with the write code loaded, the pool address and the token mint link to the explorer', async () => {
    const v = view();
    const readers: LpReaders = {
      programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
      safety: vi.fn(async () => new Map()),
      findPools: vi.fn(async () => { throw new Error('not read here'); }),
      outsidePrice: vi.fn(async () => { throw new Error('not read here'); }),
      positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
      feeTiers: vi.fn(async () => { throw new Error('not read here'); }),
      wallet: vi.fn(async () => { throw new Error('not read here'); }),
      placeShareOnChain: vi.fn(async () => { throw new Error('not read here'); }),
    };
    render(
      <LpWritesProvider readers={readers} mode="on" load={vi.fn(async () => fakeLpApi())} gateRpc={unusedGateRpc}>
        <ul>
          <PoolCard view={v} health={healthOf(v, token(v.tokenMint))} tokenDecimals={6} safety={token(v.tokenMint)} />
        </ul>
      </LpWritesProvider>,
    );
    const card = screen.getByTestId('lp-pool');
    const links = await within(card).findAllByRole('link', { name: 'Explorer' });
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain(`https://explorer.test/address/${v.address}`);
    expect(hrefs).toContain(`https://explorer.test/address/${v.tokenMint}`);
    for (const l of links) expect(l).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
