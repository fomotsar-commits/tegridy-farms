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

  it('a token the site does not list is headed by its short address, never by what it calls itself', () => {
    const card = mount(view(UNLISTED));
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe(`${shortAddress(UNLISTED)} / SOL · 1% tier`);
    // Its token check says it calls itself BAYLA; the amounts do not take that name.
    expect(rowValue(card, 'In the pool')).toMatch(/ tokens$/);
    expect(rowValue(card, 'Price here')).toMatch(/^1 token = /);
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

  it('says what the pool earned under its price, before the fees, the deposit checks and the Add form', () => {
    const card = mount(view());
    const price = within(card).getByText('Price here');
    const earned = within(card).getByTestId('lp-pool-earned');
    const history = within(card).getByRole('button', { name: POOL_PAST_BUTTON });
    const fees = within(card).getByText('Of that fee');
    const deposits = within(card).getByTestId('lp-pool-deposits');
    expect(follows(price, earned)).toBe(true);
    expect(follows(earned, history)).toBe(true);
    expect(follows(history, fees)).toBe(true);
    expect(follows(fees, deposits)).toBe(true);
    expect(within(card).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Price',
      'What this pool earned',
      'What each trade pays',
      'Trading and deposits',
    ]);
  });

  it('a price too far from the outside one points down to its warning, which is now under it', () => {
    const card = mount(view(), 0.000006);
    expect(rowValue(card, 'Difference')).toMatch(/apart: see the warning below\.$/);
    expect(follows(within(card).getByText('Difference'), within(card).getByTestId('lp-pool-warnings'))).toBe(true);
  });

  it('a pool that pays a creator fee keeps the wallet it pays in view, below the fee row that names it', () => {
    const card = mount(view(BAYLA_MINT, true));
    const openedBy = within(card).getByRole('group', { name: 'Opened by' });
    expect(within(card).getByTestId('lp-pool-more')).not.toContainElement(openedBy);
    expect(rowValue(card, 'Creator fee')).toMatch(/\(Opened by, below\), not to LPs$/);
    expect(follows(within(card).getByText('Creator fee'), openedBy)).toBe(true);
  });

  it('keeps every line it had: each row label, the sentences, and the deposit check', () => {
    const card = mount(view());
    for (const label of ['In the pool', 'Price here', 'Outside price (Jupiter)', 'Difference', 'Fee tier 1', 'Of that fee', 'Venue’s cut, not collected yet', 'Swaps', 'Withdrawals', 'Paired with', 'Pool shares issued']) {
      expect(within(card).getAllByText(label, { exact: true }), label).toHaveLength(1);
    }
    for (const group of ['Pool address', 'Token', 'Opened by']) expect(within(card).getByRole('group', { name: group })).toBeInTheDocument();
    expect(rowValue(card, 'Fee tier 1')).toBe('Traders pay 1% a trade');
    expect(rowValue(card, 'Of that fee')).toBe('LPs keep 0.840% of each trade, the venue 0.160%');
    expect(rowValue(card, 'Paired with')).toBe('SOL');
    expect(card).toHaveTextContent('LPs’ share of fees is not paid out separately: it stays in the pool, so each pool share is worth a little more after every trade.');
    // How an LP is paid stays on the card, never only in a drop-down.
    expect(within(card).getByText(/LPs’ share of fees is not paid out separately/)).toBeVisible();
    expect(card).toHaveTextContent('Deposits: the checks pass');
    // Fewer words (#803): the notice stays on the card, the reassurance sits in the drop-down.
    expect(within(card).getByText('Adding liquidity here is not switched on yet.')).toBeVisible();
    expect(within(card).getByTestId('lp-pool-more')).toHaveTextContent('These checks will run again before any deposit.');
    expect(card.textContent).not.toContain('—');
  });
});
