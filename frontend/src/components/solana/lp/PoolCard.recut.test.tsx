// The pool card reads like a pool (owner, 2026-10-13: "do what you think best"). It was
// headed "Standard address, fee tier 1", opened with two whole 44-character addresses, ended
// with a third, called BAYLA "tokens", and kept what the pool earned under the deposit checks
// and the Add form. Now: the pair and tier on top, the price, then what it earned, then the
// fees, then the checks; every address short with the whole one a press away; the token by
// its registry symbol. Nothing it said before is gone (the last test lists every line).
// The pool is the venue's BAYLA/SOL pool as mainnet held it at slot 455093758.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PoolCard } from './PoolCard';
import type { LpReaders } from './readers';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { shortAddress } from '../../../lib/solana/lp/format';
import { decodeObservationState } from '../../../lib/solana/lp/ownPrice';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { assessPool } from '../../../lib/solana/lp/poolHealth';
import { POOL_PAST_BUTTON } from '../../../lib/solana/lp/poolPast';
import { BAYLA_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, observationBytes, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const Rc = 25_647_606_321n;
const Rt = 5_414_845_326_496n;
const S = 372_631_821_673n;
const NOW = 1_791_599_460n;
// A mint the site's registry does not list.
const UNLISTED = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

function view(mint = BAYLA_MINT, creatorFee = false): PoolView {
  const obs = decodeObservationState(observationBytes({ pool: new PublicKey(mint), index: 2, lastUpdate: 1_791_514_249n }));
  if (!obs) throw new Error('the test bytes do not decode as a price record');
  const b = buildPool({ plain: true, mint: new PublicKey(mint), configIndex: 1, quoteReserve: Rc, tokenReserve: Rt, lpSupply: S, protocolFeesSol: 801_600n, openTime: 1_791_055_084n });
  const v = viewOf(b, { sol: Rc, tok: Rt, origin: 'standard', history: { kind: 'ok', obs }, config: recordedTier(1) });
  return creatorFee ? { ...v, config: recordedTier(0), snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, enableCreatorFee: true } } } : v;
}
const token = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'BAYLA', symbol: 'BAYLA', metadataSource: 'token-2022',
  facts: { program: 'token-2022', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

afterEach(cleanup);

/** `solPerToken`: the outside price. 0.0000047 agrees with the pool's own; 0.0000060 is 21% off it. */
function mount(v: PoolView, solPerToken = 0.0000047) {
  const safety = token(v.tokenMint);
  const health = assessPool({ view: v, tokenDecimals: 6, chainNow: NOW, outside: { kind: 'ok', solPerToken, source: 'Jupiter' }, safety });
  const poolPast = vi.fn<NonNullable<LpReaders['poolPast']>>();
  render(
    <ul>
      <PoolCard view={v} health={health} tokenDecimals={6} safety={safety} chainNow={NOW} readers={{ poolPast }} />
    </ul>,
  );
  return screen.getByTestId('lp-pool');
}
const rowValue = (el: HTMLElement, label: string) => within(el).getByText(label, { exact: true }).nextElementSibling?.textContent;
const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the pool card reads like a pool', () => {
  it('is headed by its pair and tier, the way a position names its pool, and still says where it sits', () => {
    const card = mount(view());
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('BAYLA / SOL · 1% tier');
    expect(card).toHaveTextContent('At the standard address for its fee tier (anyone could have opened it)');
    expect(card).not.toHaveTextContent('Standard address, fee tier');
  });

  it('a token off the registry that calls itself BAYLA is headed "fake BAYLA", never BAYLA', () => {
    const card = mount(view(UNLISTED));
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('fake BAYLA / SOL · 1% tier');
    // Its token check says it calls itself BAYLA; the amounts say the same "fake BAYLA".
    expect(rowValue(card, 'In the pool')).toMatch(/ fake BAYLA$/);
    expect(rowValue(card, 'Price here')).toMatch(/^1 fake BAYLA = /);
  });

  it('prints no address whole before a press; each is short, and a press shows the whole one', () => {
    const v = view();
    const card = mount(v);
    for (const whole of [v.address, v.tokenMint, v.snapshot.pool.poolCreator]) {
      // A whole address: 32 bytes in base58 run 32 to 44 characters (a random key is 43 about 1 time in 17).
      expect(whole.length).toBeGreaterThanOrEqual(32);
      expect(whole.length).toBeLessThanOrEqual(44);
      expect(card.textContent).not.toContain(whole);
    }
    const pool = within(card).getByRole('group', { name: 'Pool address' });
    fireEvent.click(within(pool).getByRole('button', { name: `${shortAddress(v.address)} Show full address` }));
    expect(rowValue(pool, 'Pool address')).toBe(v.address);
    for (const label of ['Token', 'Opened by']) {
      const group = within(card).getByRole('group', { name: label });
      expect(within(card).getByTestId('lp-pool-more')).toContainElement(group);
      fireEvent.click(within(group).getByRole('button', { name: /Show full address/ }));
      expect(rowValue(group, label)).toBe(label === 'Token' ? v.tokenMint : v.snapshot.pool.poolCreator);
    }
  });

  it('names BAYLA by its symbol in the reserves, the price and the venue’s cut', () => {
    const card = mount(view());
    expect(rowValue(card, 'In the pool')).toMatch(/^25\.6476 SOL and [\d,.]+ BAYLA$/);
    expect(rowValue(card, 'Price here')).toMatch(/^1 BAYLA = [\d.]+ SOL$/);
    expect(rowValue(card, 'Outside price (Jupiter)')).toMatch(/^1 BAYLA = [\d.]+ SOL$/);
    expect(rowValue(card, 'Venue’s cut, not collected yet')).toBe('0.0008 SOL and 0 BAYLA');
    expect(card.textContent).not.toMatch(/\btokens?\b/);
  });

  // Owner, 2026-10-17: "i dont want people to see too much text unless they want to". In view:
  // the fee split, the price, trading and deposits, and Add; what the pool earned and what a trade
  // pays are under More about this pool. The price came out of it on 2026-10-21 (owner: "super
  // important info about the pool").
  it('keeps the fee split, the price and the deposit checks in view, and what it earned and the fees a press away', () => {
    const card = mount(view());
    const more = within(card).getByTestId('lp-pool-more');
    expect(more).not.toHaveAttribute('open');
    const split = within(card).getByTestId('lp-pool-split');
    const deposits = within(card).getByTestId('lp-pool-deposits');
    expect(more).not.toContainElement(split);
    expect(more).not.toContainElement(deposits);
    // Every price row is on the card itself, between the fee split and the deposit checks.
    for (const label of ['In the pool', 'Price here', 'Outside price (Jupiter)', 'Difference']) {
      const row = within(card).getByText(label, { exact: true });
      expect(more, label).not.toContainElement(row);
      expect(row, label).toBeVisible();
      expect(follows(split, row), label).toBe(true);
      expect(follows(row, deposits), label).toBe(true);
    }
    const earned = within(more).getByTestId('lp-pool-earned');
    const history = within(more).getByRole('button', { name: POOL_PAST_BUTTON });
    const fees = within(more).getByText('Of that fee');
    expect(follows(earned, history)).toBe(true);
    expect(follows(history, fees)).toBe(true);
    expect(within(card).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Price',
      'Trading and deposits',
      'What this pool earned',
      'What each trade pays',
    ]);
  });

  it('a price too far from the outside one is said in the warning colour, against what it is off from, with its warning under it', () => {
    const card = mount(view(), 0.000006);
    const value = within(card).getByText('Difference', { exact: true }).nextElementSibling!;
    expect(value.textContent).toMatch(/^\d+\.\d% below the outside price$/);
    expect(value).toHaveClass('text-amber-300/90');
    // The warning and the figure it rests on are both in view, the figure first.
    const warnings = within(card).getByTestId('lp-pool-warnings');
    expect(within(card).getByTestId('lp-pool-more')).not.toContainElement(warnings);
    expect(within(card).getByTestId('lp-pool-more')).not.toContainElement(value as HTMLElement);
    expect(value).toBeVisible();
    expect(follows(value, warnings)).toBe(true);
    // A price that agrees stays a plain figure.
    cleanup();
    const plain = within(mount(view())).getByText('Difference', { exact: true }).nextElementSibling!;
    expect(plain.textContent).toMatch(/^\d+\.\d% (above|below)$/);
    expect(plain).not.toHaveClass('text-amber-300/90');
  });

  it('a pool that pays a creator fee keeps the wallet it pays in view, below the fee row that names it', () => {
    const card = mount(view(BAYLA_MINT, true));
    const openedBy = within(card).getByRole('group', { name: 'Opened by' });
    expect(within(card).getByTestId('lp-pool-more')).not.toContainElement(openedBy);
    expect(rowValue(card, 'Creator fee')).toMatch(/\(Opened by, on this card\), not to LPs$/);
    // In view, right under the fee split that names the creator's share.
    expect(within(card).getByTestId('lp-pool-split').nextElementSibling).toBe(openedBy);
  });

  it('keeps every line it had: each row label, the sentences, and the deposit check', () => {
    const card = mount(view());
    for (const label of ['In the pool', 'Price here', 'Outside price (Jupiter)', 'Difference', 'Fee tier 1', 'Of that fee', 'Venue’s cut, not collected yet', 'Paired with', 'Pool shares issued']) {
      expect(within(card).getAllByText(label, { exact: true }), label).toHaveLength(1);
    }
    // Swaps and withdrawals both open: one line (anything else keeps its own row).
    expect(within(card).getByTestId('lp-pool-open')).toHaveTextContent('Swaps and withdrawals open');
    for (const group of ['Pool address', 'Token', 'Opened by']) expect(within(card).getByRole('group', { name: group })).toBeInTheDocument();
    expect(rowValue(card, 'Fee tier 1')).toBe('Traders pay 1% a trade');
    expect(rowValue(card, 'Of that fee')).toBe('LPs keep 0.840% of each trade, the venue 0.160%');
    expect(rowValue(card, 'Paired with')).toBe('SOL');
    expect(card).toHaveTextContent('LPs’ share of fees is not paid out separately: it stays in the pool, so each pool share is worth a little more after every trade.');
    // How an LP is paid stays in view as the fee split; the longer sentence is a press away.
    expect(within(card).getByTestId('lp-pool-split')).toBeVisible();
    expect(within(card).getByTestId('lp-pool-split')).toHaveTextContent('LPs keep 0.840% of each trade, the venue 0.160%.');
    expect(within(card).getByTestId('lp-pool-more')).toHaveTextContent('LPs’ share of fees is not paid out separately');
    expect(card).toHaveTextContent('Deposits: the checks pass');
    // Fewer words (#803): the notice stays on the card, the reassurance sits in the drop-down.
    expect(within(card).getByText('Adding liquidity here is not switched on yet.')).toBeVisible();
    expect(within(card).getByTestId('lp-pool-more')).toHaveTextContent('These checks will run again before any deposit.');
    expect(card.textContent).not.toContain('—');
  });
});
