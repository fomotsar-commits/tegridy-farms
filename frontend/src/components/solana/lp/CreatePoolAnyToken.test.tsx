// Any token may have a pool (owner ruling 2026-10-04). Four things that used to stop an
// opening are warnings now: a token with no market price, a price more than 3% from the
// market, a token its creator can freeze, and a copy of a well-known name.
//
// THE RULE THESE TESTS HOLD THE FORMS TO. Each warning is said BEFORE Review (on the card
// and in the form), in the checker's own words, in the pool's own coin, and never switches
// Review off. What still stops an opening (a transfer fee) is refused in the checker's own
// words. A price that was not READ is never a warning: it keeps Review off.
//
// The tokens here are judged by the real checker from mint bytes (anyToken.fixture.ts), and
// the opening by the real check (opening.ts). The write layer is a fake; nothing touches a chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_QUOTE, USDC_QUOTE, quotesFor, type QuoteCoin, type QuoteSymbol } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { tokenReasons } from '../../../lib/solana/lp/poolHealth';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { key } from '../../../lib/solana/lp/testkit.fixture';
import type { LpWriteApi, Prepared } from '../curve/ports';
import { TIER1_ADDRESS, fakeLpApi, LP_PROGRAM, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { realToken, reasonText } from './anyToken.fixture';

// web3's address derivation cannot run under jsdom: the public tier's address is the fixture's fixed key.
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

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
const USDC = USDC_QUOTE.mint;
const BAYLA = BAYLA_QUOTE.mint;
/** A whole flow on a loaded machine: well past the default 5 s. */
const LONG = 30_000;

// Prices in SOL, as Jupiter gives them: the token 0.01, USDC 0.005 (so the token is 2 USDC),
// BAYLA 0.0001 (so the token is 100 BAYLA).
const ok = (solPerToken: number): OutsidePrice => ({ kind: 'ok', solPerToken, source: 'Jupiter' });
const COIN_SOL: Record<string, number> = { [USDC]: 0.005, [BAYLA]: 0.0001 };
const priceOf = (mint: string) => ok(COIN_SOL[mint] ?? 0.01);
/** Jupiter ANSWERED that it has no market for the token. A failed read is 'unread', never this. */
const NO_ROUTE: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };

// ── the tokens, each judged by the real checker ──
const FREEZER = key();
const BOBO_REAL_MINT = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';
const clean = realToken(MINT);
const freezable = realToken(MINT, { freeze: FREEZER });
const copy = realToken(MINT, { name: 'BOBO', symbol: 'BOBO' });
const freezableCopy = realToken(MINT, { freeze: FREEZER, name: 'BOBO', symbol: 'BOBO' });
const feeToken = realToken(MINT, { transferFee: true });

const STANDARD: Record<QuoteSymbol, string> = { SOL: key().toBase58(), USDC: key().toBase58(), BAYLA: key().toBase58() };
function noPools(): PoolSearchRead {
  const coins = quotesFor(M);
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: coins.map((q) => ({ index: 1, config: TIER1_ADDRESS.toBase58(), address: STANDARD[q.symbol], quote: q.mint })) },
      index: { kind: 'ok', pools: [], truncated: false },
      pools: [],
      otherPairs: 0,
      knownState: Object.fromEntries(coins.map((q) => [STANDARD[q.symbol], 'absent' as const])),
      chainNow: 1_000n,
    },
  };
}

/** 5 SOL, 500 tokens, and 250 USDC or 7,000 BAYLA on the coin's side. */
function walletFor(quote: QuoteCoin | undefined): WalletFacts {
  const coin = !quote || quote.native ? null : { address: key().toBase58(), exists: true, amount: quote === USDC_QUOTE ? 250_000_000n : 7_000_000_000n };
  return {
    kind: 'ok',
    lamports: 5_000_000_000n,
    token: { address: key().toBase58(), amount: 500_000_000n },
    wsol: { exists: false, amount: 0n },
    coin,
    lpAccountExists: false,
    rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, neverRefunded: 40_000_000n, ...(coin ? { coinAccount: 2_039_280n } : {}) },
  };
}

type WalletFn = LpReaders['wallet'];
function readers(token: TokenSafety, o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, token]])),
    findPools: vi.fn(async () => noPools()),
    outsidePrice: vi.fn(async (mint: string) => priceOf(mint)),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => walletFor(opts?.quote)),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

const notBuilt = () => vi.fn(async (): Promise<Prepared> => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'x' } }));
const handed = (prepareLpCreate: ReturnType<typeof notBuilt>) => (prepareLpCreate.mock.calls.at(-1) as unknown[] | undefined)?.[3];

function mount(r: LpReaders, api: Partial<LpWriteApi> = {}) {
  const full = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), ...api });
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
      <LpInner readers={r} writes={{ mode: 'on', load: vi.fn(async () => full), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
}

async function settled(state: string) {
  const card = await screen.findByTestId('lp-create');
  await waitFor(() => expect(card).toHaveAttribute('data-create', state));
  return card;
}
async function openPanel() {
  const card = await settled('offer');
  fireEvent.click(within(card).getByRole('button', { name: 'Open a pool' }));
  const panel = await screen.findByTestId('lp-create-panel');
  return { card, panel };
}
async function pair(panel: HTMLElement, symbol: QuoteSymbol) {
  fireEvent.click(within(panel).getByRole('radio', { name: symbol }));
  await within(panel).findByRole('button', { name: `Max ${symbol}` });
}

const coinBox = (p: HTMLElement, symbol: QuoteSymbol) => within(p).getByLabelText(`${symbol} to put in`);
const tokens = (p: HTMLElement) => within(p).getByLabelText('Tokens to put in');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const reviewButton = (p: HTMLElement) => within(p).getByRole('button', { name: 'Review: open the pool' });
const market = (p: HTMLElement) => within(p).getByTestId('lp-create-market');
const price = (p: HTMLElement) => within(p).getByTestId('lp-create-price');
const after = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const NO_MARKET_FORM =
  'Jupiter has no market price for this token, so there is nothing to compare your opening price with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.';

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe('the tokens these tests use are what the real checker says they are', () => {
  const codes = (s: TokenSafety) => (s.kind === 'read' ? { verdict: s.verdict, blocks: s.blocks.map((r) => r.code), warnings: s.warnings.map((r) => r.code) } : s.kind);

  it('clean, freezable, a copy, both, and one that charges a transfer fee', () => {
    expect(codes(clean)).toEqual({ verdict: 'ok', blocks: [], warnings: [] });
    expect(codes(freezable)).toEqual({ verdict: 'warn', blocks: [], warnings: ['freeze-authority'] });
    expect(codes(copy)).toEqual({ verdict: 'warn', blocks: [], warnings: ['copies-known-name'] });
    expect(codes(freezableCopy)).toEqual({ verdict: 'warn', blocks: [], warnings: ['freeze-authority', 'copies-known-name'] });
    expect(codes(feeToken)).toEqual({ verdict: 'blocked', blocks: ['transfer-fee'], warnings: [] });
  });
});

describe('the token’s own card', () => {
  it('a token its creator can freeze is "Allowed, with warnings", never blocked, and the freeze sentence is a warning', async () => {
    mount(readers(freezable));
    const card = await screen.findByTestId('token-safety');
    expect(card).toHaveAttribute('data-verdict', 'warn');
    expect(within(card).getByTestId('token-safety-verdict')).toHaveTextContent(/^Allowed, with warnings$/);
    expect(card).not.toHaveTextContent(/blocked/i);
    const sentence = within(card).getByText(reasonText(freezable, 'freeze-authority'));
    // Amber is a warning; rose is a block.
    expect(sentence).toHaveClass('text-amber-300/90');
    expect(sentence).not.toHaveClass('text-rose-300/90');
  });

  it('a token that charges a transfer fee is still "Blocked on this site", and its sentence is a block', async () => {
    mount(readers(feeToken));
    const card = await screen.findByTestId('token-safety');
    expect(card).toHaveAttribute('data-verdict', 'blocked');
    expect(within(card).getByTestId('token-safety-verdict')).toHaveTextContent(/^Blocked on this site$/);
    expect(within(card).getByText(reasonText(feeToken, 'transfer-fee'))).toHaveClass('text-rose-300/90');
  });
});

describe('all of it at once: a freezable copy with no market price, paired with USDC', () => {
  it('the card offers it and says each warning before the button; the form says them above Review, in USDC, and Review is ON', async () => {
    const prepareLpCreate = notBuilt();
    // USDC's own price is never answered: with no market price for the token nothing is
    // compared, so that price is not needed and must not hold Review off.
    const outsidePrice = vi.fn((mint: string) => (mint === M ? Promise.resolve(NO_ROUTE) : new Promise<OutsidePrice>(() => {})));
    const r = readers(freezableCopy, { outsidePrice });
    mount(r, { prepareLpCreate });
    const { card, panel } = await openPanel();

    // ── the card: each warning, before any button ──
    const cautions = within(card).getByTestId('lp-create-cautions');
    const copyWarning = reasonText(freezableCopy, 'copies-known-name');
    const freezeWarning = reasonText(freezableCopy, 'freeze-authority');
    expect(copyWarning).toContain(`NOT the real BOBO (whose mint is ${BOBO_REAL_MINT})`);
    expect(freezeWarning).toContain(`freeze authority ${FREEZER.toBase58()}`);
    expect(cautions).toHaveTextContent(copyWarning);
    expect(cautions).toHaveTextContent(freezeWarning);
    expect(cautions).toHaveTextContent(
      'Jupiter has no market price for this token, so there is nothing to compare an opening price with. If you open a pool, you set its first price yourself.',
    );
    expect(after(cautions, within(card).getByRole('button', { name: 'Open a pool' }))).toBe(true);
    expect(card).not.toHaveTextContent(/does not open pools|opens pools only for tokens/);
    // The token's own card does not call it blocked either.
    expect(screen.getByTestId('token-safety')).toHaveAttribute('data-verdict', 'warn');

    // ── the form, on USDC ──
    await pair(panel, 'USDC');
    // The coin's price was not asked for at all: there is nothing to compare.
    expect(outsidePrice).not.toHaveBeenCalledWith(USDC, expect.anything());
    expect(market(panel)).toHaveTextContent(/^Market price \(Jupiter, read \d\d:\d\d:\d\d\): there is none for this token\. You are setting this pool’s first price yourself\.$/);
    expect(within(panel).queryByTestId('lp-create-match')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Match the market price' })).toBeNull();
    expect(within(panel).queryByTestId('lp-create-coin-price')).toBeNull();
    // Above the amount boxes the form has no list for these: on a phone it would push the boxes off the first screen.
    expect(within(panel).queryByText('Read these about this token first:')).toBeNull();
    expect(panel).not.toHaveTextContent(freezeWarning);

    // Before anything is typed, the token's warnings are already above Review.
    const [copyLine, freezeLine] = tokenReasons(freezableCopy, 'pools').warned;
    expect(copyLine).toContain('It calls itself by a well-known token’s name but has a different mint');
    expect(freezeLine).toContain('Its creator can freeze the vault of the pool you open');
    const early = within(panel).getByTestId('lp-create-warnings');
    expect(early).toHaveTextContent(copyLine!);
    expect(early).toHaveTextContent(freezeLine!);
    expect(early).not.toHaveTextContent(NO_MARKET_FORM);

    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'no-market');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2 USDC. There is no market price to compare it with.');
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings).toHaveTextContent(copyLine!);
    expect(warnings).toHaveTextContent(freezeLine!);
    expect(warnings).toHaveTextContent(NO_MARKET_FORM);
    // Three warnings, each its own notice, each a warning in tone.
    const notices = [...warnings.querySelectorAll('p')];
    expect(notices.map((p) => p.textContent)).toEqual([copyLine, freezeLine, NO_MARKET_FORM]);
    for (const p of notices) expect(p).toHaveClass('text-amber-300/90');
    // Under the boxes and above Review.
    expect(after(tokens(panel), warnings)).toBe(true);
    expect(after(warnings, reviewButton(panel))).toBe(true);
    // No loss is claimed: nothing was compared.
    expect(warnings).not.toHaveTextContent(/a move back to the market price/);
    expect(warnings).not.toHaveTextContent('SOL');

    // A warning never switches Review off.
    expect(within(panel).getByRole('alert')).toHaveTextContent('');
    expect(within(panel).queryByTestId('lp-review-why')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    // USDC's mint and USDC's own base units: 50 is 50,000,000, never 50,000,000,000.
    expect(prepareLpCreate).toHaveBeenCalledTimes(1);
    expect(handed(prepareLpCreate)).toMatchObject({ tokenMint: MINT, quoteMint: new PublicKey(USDC), quote: 50_000_000n, token: 25_000_000n });
  }, LONG);

  it('the same token on SOL and on BAYLA: the same warnings, and Review is ON under each coin', async () => {
    mount(readers(freezableCopy, { outsidePrice: vi.fn(async (mint: string) => (mint === M ? NO_ROUTE : priceOf(mint))) }));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    expect(within(panel).getByTestId('lp-create-warnings')).toHaveTextContent(NO_MARKET_FORM);
    expect(reviewButton(panel)).toBeEnabled();
    await pair(panel, 'BAYLA');
    type(coinBox(panel, 'BAYLA'), '1000');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 10 BAYLA. There is no market price to compare it with.');
    expect(within(panel).getByTestId('lp-create-warnings')).toHaveTextContent(NO_MARKET_FORM);
    expect(reviewButton(panel)).toBeEnabled();
  }, LONG);
});

describe('a freezable copy that HAS a market price, opened off the market in USDC', () => {
  it('the token warnings and the price warning are all above Review, the loss is in USDC, and Review is ON', async () => {
    const prepareLpCreate = notBuilt();
    mount(readers(freezableCopy), { prepareLpCreate });
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    // 75 USDC for 25 tokens is 3 USDC a token: 50% above the market's 2.
    type(coinBox(panel, 'USDC'), '75');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    const warnings = within(panel).getByTestId('lp-create-warnings');
    const [copyLine, freezeLine] = tokenReasons(freezableCopy, 'pools').warned;
    expect([...warnings.querySelectorAll('p.text-amber-300\\/90')].map((p) => p.textContent)).toEqual([
      copyLine,
      freezeLine,
      'Your opening price is 50.0% above the market price (Jupiter). The first trades would move it to the market price, at your cost.',
      // (√75 − √(25 × 2))² USDC = 2.525512… USDC, rounded up to USDC's smallest unit.
      'At these amounts, a move back to the market price would take up to about 2.525513 USDC of what you put in. That is an estimate.',
    ]);
    expect(within(warnings).getByRole('button', { name: 'Match the market price' })).toBeEnabled();
    expect(reviewButton(panel)).toBeEnabled();
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(handed(prepareLpCreate)).toMatchObject({ quoteMint: new PublicKey(USDC), quote: 75_000_000n, token: 25_000_000n });
  }, LONG);
});

describe('one warning at a time, on SOL', () => {
  it('a token its creator can freeze: the pool-level sentence is above Review before anything is typed, and Review is ON at the market', async () => {
    mount(readers(freezable));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    const [freezeLine] = tokenReasons(freezable, 'pools').warned;
    expect(freezeLine).toBe(
      'Its creator can freeze the vault of the pool you open, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.',
    );
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings).toHaveTextContent(freezeLine!);
    expect(after(coinBox(panel, 'SOL'), warnings)).toBe(true);
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    // At the market there is no price warning and no Match in the warnings: only the token's line.
    expect([...within(panel).getByTestId('lp-create-warnings').querySelectorAll('p')].map((p) => p.textContent)).toEqual([freezeLine]);
    expect(within(within(panel).getByTestId('lp-create-warnings')).queryByRole('button')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
  });

  it('a copy of a well-known name: the same, and the form still asks to check the address', async () => {
    mount(readers(copy));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(within(panel).getByText('Calls itself').nextElementSibling).toHaveTextContent('BOBO (BOBO)');
    expect(panel).toHaveTextContent('Check this is the token you mean: compare the address with the one its project publishes. Names can be copied.');
    const [copyLine] = tokenReasons(copy, 'pools').warned;
    expect(within(panel).getByTestId('lp-create-warnings')).toHaveTextContent(copyLine!);
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    expect(reviewButton(panel)).toBeEnabled();
  });

  it('a clean token at the market has no warnings block at all: the form reads as it always did', async () => {
    mount(readers(clean));
    const { card, panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 0.01 SOL. Market: 0.01 SOL. Yours is 0.0% above the market. Close enough to the market.');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(within(card).queryByTestId('lp-create-cautions')).toBeNull();
    expect(within(panel).getByTestId('lp-create-match')).toBeEnabled();
    expect(reviewButton(panel)).toBeEnabled();
  });
});

// Review 2026-10-04 (A1). The warnings are plain paragraphs, in no live region, so someone
// who tabs from the boxes to Review with a screen reader never heard the token's lines.
// Review is described by their block, as on the Add form. With no warnings it names no
// block: an id that points at nothing is not left on the button.
describe('Review is described by the warnings above it', () => {
  it('a token with a warning: the button’s aria-describedby is the warnings block, and its description is the warning', async () => {
    mount(readers(freezable));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings.id).not.toBe('');
    expect(document.getElementById(warnings.id)).toBe(warnings);
    expect(reviewButton(panel)).toHaveAttribute('aria-describedby', warnings.id);
    // What a screen reader says with the button: the block's own words.
    const [freezeLine] = tokenReasons(freezable, 'pools').warned;
    expect(reviewButton(panel)).toHaveAccessibleDescription(freezeLine!);
  });

  it('a clean token: described by nothing; a price typed off the market brings the block and the description, and back at the market both go', async () => {
    mount(readers(clean));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(reviewButton(panel)).not.toHaveAttribute('aria-describedby');
    // 2 SOL for 100 tokens is 0.02 SOL a token: 100% above the market's 0.01.
    type(coinBox(panel, 'SOL'), '2');
    type(tokens(panel), '100');
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings.id).not.toBe('');
    expect(reviewButton(panel)).toHaveAttribute('aria-describedby', warnings.id);
    expect(reviewButton(panel)).toHaveAccessibleDescription(
      expect.stringContaining('Your opening price is 100.0% above the market price (Jupiter). The first trades would move it to the market price, at your cost.'),
    );
    expect(reviewButton(panel)).toBeEnabled();
    type(coinBox(panel, 'SOL'), '1');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(reviewButton(panel)).not.toHaveAttribute('aria-describedby');
  });
});

describe('what still stops an opening', () => {
  it('a token that charges a transfer fee is refused in the checker’s own words, and no form can be opened for it', async () => {
    const r = readers(feeToken);
    mount(r);
    const card = await settled('token-refused');
    const block = reasonText(feeToken, 'transfer-fee');
    expect(block).toBe(
      'It uses a transfer-fee setting, which lets the token take a fee out of every transfer. This site cannot build exact deposits and withdrawals for a token with one, so it does not open or add to pools for it.',
    );
    expect(card).toHaveTextContent(`This site does not open pools for this token: ${block}`);
    expect(within(card).queryByRole('button', { name: 'Open a pool' })).toBeNull();
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    // Jupiter is not even asked about a token that is blocked.
    expect(r.outsidePrice).not.toHaveBeenCalled();
  });

  // The form is open on a freezable copy when Jupiter stops answering. Not read is not
  // "no market price": Review goes off, and the price is not said as a warning.
  it('a price that could not be READ keeps Review off, whatever warnings the token carries', async () => {
    const outsidePrice = vi.fn<(mint: string) => Promise<OutsidePrice>>(async (mint) => priceOf(mint));
    mount(readers(freezableCopy, { outsidePrice }));
    const { card, panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    expect(reviewButton(panel)).toBeEnabled();
    outsidePrice.mockResolvedValue({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(card).toHaveAttribute('data-create', 'price-unread'));
    expect(reviewButton(panel)).toBeDisabled();
    expect(price(panel)).toHaveAttribute('data-price', 'unread');
    // The token's own warnings are still said. The unread price is not one of them.
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings).not.toHaveTextContent(/no market price|market price \(Jupiter\)/);
    expect(warnings.querySelectorAll('p')).toHaveLength(2);
  }, LONG);
});
