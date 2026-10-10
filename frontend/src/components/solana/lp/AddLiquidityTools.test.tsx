// Two small tools on the Add liquidity form (2026-10-10):
//   1. A part of what the wallet can put in: 25%, 50% and 75% with each box, beside its
//      Max. For SOL the part is of what can go in after fees and account deposits (the
//      figure Max uses), never of the wallet's balance. The other box follows the pool.
//   2. "What if the price moves": a short table under Review whose three rows are worked
//      out by priceMove.ts, with nothing shown for a pool the note cannot speak of.
//
// The write layer is a fake (fakeLpWriteApi.fixture.ts); the pool and the wallet are fake
// readers. Nothing here touches a chain.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import { WhatIfPriceMoves } from './WhatIfPriceMoves';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { vsHolding } from '../../../lib/solana/lp/priceMove';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import type { LpWriteApi } from '../curve/ports';
import { fakeLpApi, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';

const OWNER = key();
const wallet = vi.hoisted(() => ({
  publicKey: null as null | PublicKey,
  signTransaction: undefined as undefined | ((t: unknown) => Promise<unknown>),
  signMessage: undefined,
  connecting: false,
  wallet: null,
}));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const MINT = key();
const M = MINT.toBase58();
const UNIT = 10n ** 6n;

/** A SOL pool: 10 SOL and 1,000 tokens. Any other coin: 1,000 of it and 100,000 tokens. Either way 0.01 of the coin a token. */
function view(coin: QuoteCoin = SOL_QUOTE): PoolView {
  const q = coin.native ? 10n * 10n ** 9n : 1_000n * UNIT;
  const t = coin.native ? 1_000n * UNIT : 100_000n * UNIT;
  const b = buildPool({ plain: true, mint: MINT, quote: coin, configIndex: 1, quoteReserve: q, tokenReserve: t, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint === coin.mint;
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? q : t, vault1Amount: quoteIsToken0 ? t : q, reserve0: quoteIsToken0 ? q : t, reserve1: quoteIsToken0 ? t : q },
    config,
    tokenMint: M,
    quote: coin,
    quoteIsToken0,
    quoteReserve: q,
    tokenReserve: t,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

function search(v: PoolView): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: [v.address], truncated: false },
      pools: [{ kind: 'pool' as const, view: v }],
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

type OkFacts = Extract<WalletFacts, { kind: 'ok' }>;
/** 5 SOL, 500 tokens, and 250 of the coin when the coin is not SOL. */
const walletOf = (coin: QuoteCoin, over: Partial<OkFacts> = {}): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 500n * UNIT },
  wsol: { exists: false, amount: 0n },
  coin: coin.native ? null : { address: key().toBase58(), exists: true, amount: 250n * UNIT },
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, ...(coin.native ? {} : { coinAccount: 2_039_280n }) },
  ...over,
});

/** The coin's own price in SOL, as Jupiter answers it; the token's makes the pool's 0.01 of its coin the market price. */
const COIN_IN_SOL = 0.005;
function readers(v: PoolView, facts: WalletFacts = walletOf(v.quote)): LpReaders {
  const tokenInSol = v.quote.native ? 0.01 : 0.01 * COIN_IN_SOL;
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search(v)),
    outsidePrice: vi.fn(async (mint: string) => ({ kind: 'ok' as const, solPerToken: mint === M ? tokenInSol : COIN_IN_SOL, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
  };
}

const notSent = () => vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } }));

/** The pool's card with its Add form open. `read`: what the form shows once the wallet answered. */
async function openAdd(r: LpReaders, read: string | RegExp, api: LpWriteApi = fakeLpApi({ prepareLpDeposit: notSent() })) {
  const writes: LpWritesOverrides = { mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc };
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
      <LpInner readers={r} writes={writes} />
    </MemoryRouter>,
  );
  const card = await screen.findByTestId('lp-pool');
  fireEvent.click(await within(card).findByRole('button', { name: 'Add liquidity' }));
  const panel = await screen.findByTestId('lp-add-panel');
  await within(panel).findAllByText(read);
  const box = (label: string) => within(panel).getByLabelText(label) as HTMLInputElement;
  const parts = (legend: string) => within(panel).queryByRole('group', { name: legend });
  const part = (legend: string, pct: string) => within(parts(legend)!).getByRole('button', { name: pct });
  const pressed = (legend: string) => within(parts(legend)!).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
  return { panel, api, box, parts, part, pressed };
}

const SOL_PARTS = 'Part of the SOL that can go in';
const TOKEN_PARTS = 'Part of your tokens';
/** 5 SOL less 1,005,000 for the fee, 2,039,280 for the pool-share account and 2,039,280 kept for the wrapped-SOL account. */
const SPENDABLE = 5_000_000_000n - 5_083_560n;
const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe('Add liquidity: a part of what the wallet can put in', () => {
  it('offers 25%, 50% and 75% under each box, with no All and no typed percent: Max is beside the box', async () => {
    const { panel, box, parts } = await openAdd(readers(view()), /Up to 4\.9949 SOL can go in/);
    for (const legend of [SOL_PARTS, TOKEN_PARTS]) {
      expect(within(parts(legend)!).getAllByRole('button').map((b) => b.textContent)).toEqual(['25%', '50%', '75%']);
      for (const b of within(parts(legend)!).getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false');
    }
    expect(within(panel).queryByRole('button', { name: 'All' })).toBeNull();
    expect(within(panel).queryByLabelText('Other percent')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Max SOL' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Max tokens' })).toBeInTheDocument();
    // Each set sits under its own box: the SOL box, its parts, the token box, its parts.
    expect(follows(box('SOL to add'), parts(SOL_PARTS)!)).toBe(true);
    expect(follows(parts(SOL_PARTS)!, box('Tokens to add'))).toBe(true);
    expect(follows(box('Tokens to add'), parts(TOKEN_PARTS)!)).toBe(true);
    // Nothing is typed by offering them.
    expect(box('SOL to add')).toHaveValue('');
  });

  it('for SOL the part is of what can go in after fees and account deposits, never of the balance', async () => {
    const { panel, api, box, part, pressed } = await openAdd(readers(view()), /Up to 4\.9949 SOL can go in/);
    expect(SPENDABLE).toBe(4_994_916_440n);
    fireEvent.click(part(SOL_PARTS, '50%'));
    // Half of 4.99491644 SOL. Half of the 5 SOL balance would be 2.5.
    expect(box('SOL to add')).toHaveValue('2.49745822');
    expect(box('SOL to add')).toHaveAttribute('data-driving', 'true');
    expect(pressed(SOL_PARTS)).toEqual(['50%']);
    expect(pressed(TOKEN_PARTS)).toEqual([]);
    // The token box follows the pool, exactly as it does for a typed amount.
    const followed = box('Tokens to add').value;
    expect(Number(followed)).toBeGreaterThan(240);
    fireEvent.change(box('SOL to add'), { target: { value: '1' } });
    fireEvent.change(box('SOL to add'), { target: { value: '2.49745822' } });
    expect(box('Tokens to add')).toHaveValue(followed);

    fireEvent.click(part(SOL_PARTS, '25%'));
    expect(box('SOL to add')).toHaveValue('1.24872911');
    fireEvent.click(part(SOL_PARTS, '75%'));
    expect(box('SOL to add')).toHaveValue('3.74618733');
    expect(pressed(SOL_PARTS)).toEqual(['75%']);

    // Review sends that part, to the lamport, as the SOL side's limit.
    fireEvent.click(part(SOL_PARTS, '50%'));
    const review = within(panel).getByRole('button', { name: 'Review: add liquidity' });
    expect(review).toBeEnabled();
    await act(async () => {
      fireEvent.click(review);
    });
    expect(api.prepareLpDeposit).toHaveBeenCalledWith(conn.connection, expect.objectContaining({ kind: 'open' }), expect.anything(), expect.objectContaining({ driving: 'quote', maxIn: SPENDABLE / 2n }));
  });

  it('the token side: a part of the tokens held, and the SOL box follows the pool', async () => {
    const { box, part, pressed } = await openAdd(readers(view()), /Up to 4\.9949 SOL can go in/);
    fireEvent.click(part(TOKEN_PARTS, '25%'));
    expect(box('Tokens to add')).toHaveValue('125');
    expect(box('Tokens to add')).toHaveAttribute('data-driving', 'true');
    expect(pressed(TOKEN_PARTS)).toEqual(['25%']);
    expect(pressed(SOL_PARTS)).toEqual([]);
    // 125 tokens at 0.01 SOL a token, less the 1% tolerance: a little under 1.25 SOL.
    expect(Number(box('SOL to add').value)).toBeGreaterThan(1.2);
    expect(Number(box('SOL to add').value)).toBeLessThan(1.25);
  });

  it('a part reads as pressed only while the box still holds exactly that amount', async () => {
    const { box, part, pressed } = await openAdd(readers(view()), /Up to 4\.9949 SOL can go in/);
    fireEvent.click(part(SOL_PARTS, '50%'));
    expect(pressed(SOL_PARTS)).toEqual(['50%']);
    fireEvent.change(box('SOL to add'), { target: { value: '2.4' } });
    expect(pressed(SOL_PARTS)).toEqual([]);
    // Typing in the other box takes the amount over: nothing stays pressed on this side.
    fireEvent.click(part(SOL_PARTS, '50%'));
    fireEvent.change(box('Tokens to add'), { target: { value: '10' } });
    expect(pressed(SOL_PARTS)).toEqual([]);
  });

  it('a coin that is not SOL: the part is of the wallet’s balance of that coin, in its own decimals', async () => {
    const { box, parts, part, pressed } = await openAdd(readers(view(USDC_QUOTE)), 'You have 250 USDC.');
    expect(parts(SOL_PARTS)).toBeNull();
    fireEvent.click(part('Part of your USDC', '50%'));
    // Half of 250 USDC: its fees are paid in SOL, so the whole balance can go in.
    expect(box('USDC to add')).toHaveValue('125');
    expect(pressed('Part of your USDC')).toEqual(['50%']);
  });

  it('a wallet that could not be read is offered no part, and no Max: an unread balance is never 0', async () => {
    const { panel, parts } = await openAdd(readers(view(), { kind: 'unread', detail: 'the node did not answer' }), /You have: could not read/);
    expect(parts(SOL_PARTS)).toBeNull();
    expect(parts(TOKEN_PARTS)).toBeNull();
    expect(within(panel).queryByRole('button', { name: /^(25|50|75)%$/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Max SOL' })).toBeNull();
  });

  // A quarter of either is less than one smallest unit, so there is no part to offer.
  it.each([
    ['no token account at all', null],
    ['three of the token’s smallest unit', { address: key().toBase58(), amount: 3n }],
  ])('a side with nothing to take a part of (%s) is offered none, and the other side still is', async (_name, token) => {
    const { parts } = await openAdd(readers(view(), walletOf(SOL_QUOTE, { token })), /Up to 4\.9949 SOL can go in/);
    expect(parts(TOKEN_PARTS)).toBeNull();
    expect(parts(SOL_PARTS)).not.toBeNull();
  });

  it('four of the smallest unit is enough: a quarter of it is one', async () => {
    const { box, part } = await openAdd(readers(view(), walletOf(SOL_QUOTE, { token: { address: key().toBase58(), amount: 4n } })), /Up to 4\.9949 SOL can go in/);
    fireEvent.click(part(TOKEN_PARTS, '25%'));
    expect(box('Tokens to add')).toHaveValue('0.000001');
  });
});

describe('Add liquidity: what if the price moves', () => {
  const rowsOf = (note: HTMLElement) => Array.from(note.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent));

  it('is on the form, with three rows worked out by the function and one closing line', async () => {
    const { panel } = await openAdd(readers(view()), /Up to 4\.9949 SOL can go in/);
    const note = within(panel).getByTestId('lp-price-move');
    expect(within(note).getByRole('heading', { name: 'What if the price moves' })).toBeInTheDocument();
    expect(within(note).getByRole('table', { name: 'What if the price moves' })).toBeInTheDocument();
    expect(within(note).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'This token’s price in SOL, against when you added',
      'Your position, against just holding both tokens',
    ]);
    expect(rowsOf(note)).toEqual([
      ['the same', 'the same'],
      ['double or half', 'about 5.7% less'],
      ['4 times or a quarter', '20% less'],
    ]);
    // The figures on screen are the function's: 5.719...% and 20%, for the move and for its inverse.
    expect(-vsHolding(2)! * 100).toBeCloseTo(5.719, 3);
    expect(-vsHolding(0.5)! * 100).toBeCloseTo(5.719, 3);
    expect(-vsHolding(4)! * 100).toBeCloseTo(20, 9);
    expect(-vsHolding(0.25)! * 100).toBeCloseTo(20, 9);
    expect(note).toHaveTextContent('Fees are not counted in this: trading fees are what is meant to make up for it. It is arithmetic for this kind of pool, not a forecast.');
    // No promise of a return, no money figure and no em dash, on the note or anywhere on the form.
    expect(panel).not.toHaveTextContent(FORECAST_WORDS);
    expect(note.textContent).not.toMatch(/[$€£]|\bUSD\b|dollar|—/i);
  });

  // Measured on a build, 2026-10-10: above Review, even folded to one line, it pushed the
  // button off the first screen at 1280x800. So it is always open, and always under Review.
  it('sits under Review and above the long notes, open, so it never pushes Review down', async () => {
    const { panel } = await openAdd(readers(view()), /Up to 4\.9949 SOL can go in/);
    const note = within(panel).getByTestId('lp-price-move');
    expect(follows(within(panel).getByRole('button', { name: 'Review: add liquidity' }), note)).toBe(true);
    expect(follows(note, within(panel).getByTestId('lp-before-you-add'))).toBe(true);
    expect(note.closest('details')).toBeNull();
    expect(within(note).getByText('20% less')).toBeVisible();
    // The line above Review still points down to it.
    expect(panel).toHaveTextContent('Read the notes under this form before you review.');
  });

  it('names the pool’s own coin', async () => {
    const { panel } = await openAdd(readers(view(USDC_QUOTE)), 'You have 250 USDC.');
    expect(within(within(panel).getByTestId('lp-price-move')).getAllByRole('columnheader')[0]).toHaveTextContent('This token’s price in USDC, against when you added');
  });

  it('shows nothing when the pool could not be read: no fee tier, or a side with nothing in it', () => {
    const v = view();
    for (const unread of [{ ...v, config: null }, { ...v, quoteReserve: 0n }, { ...v, tokenReserve: 0n }]) {
      const { container, unmount } = render(<WhatIfPriceMoves view={unread} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    // The same pool, read: it is there.
    expect(render(<WhatIfPriceMoves view={v} />).getByTestId('lp-price-move')).toBeInTheDocument();
  });
});
