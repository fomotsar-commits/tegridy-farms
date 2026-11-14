// The Lend tab's pitch and risk card (owner 2026-11-09, ideas 1, 2 and 4): what a lender sees
// before signing. The floor bid pitch, who buys the NFT if a loan is not repaid, and the same
// take-home rate on Gondi's own contracts. Every number under-claims when a read fails.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../../lib/gondi/loanOffer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/gondi/loanOffer.js')>()),
  GONDI_LOAN_ADDRESS: '0x5555555555555555555555555555555555555555',
}));

import { NFTLendingSection } from './NFTLendingSection';
import { WETH_ADDRESS } from '../../lib/gondi/loanOffer.js';

const LOAN = '0x5555555555555555555555555555555555555555';
const GONDI_V31 = '0xf41B389E0C1950dc0B16C9498eaE77131CC08A56';
const GONDI_V32 = '0xE365fF3cad44d19cb7aBa81df8ffd6818A66Ac0a';
const WALLET = '0x1111111111111111111111111111111111111111';

// OpenSea through /api/opensea, for JBAC (the Lend tab's first collection).
let market: { stats: unknown; statsStatus: number; offers: unknown; offersStatus: number };
const seaportBid = (eth: string, qty = 1, criteria: Record<string, unknown> = { trait: null }) => {
  const wei = (parseEther(eth) * BigInt(qty)).toString();
  return {
    order_hash: '0x01',
    price: { currency: 'WETH', value: wei },
    criteria: { collection: { slug: 'junglebay' }, ...criteria },
    protocol_data: { parameters: { offer: [{ startAmount: wei }], consideration: [{ itemType: 4, identifierOrCriteria: '0', startAmount: String(qty) }] } },
  };
};
const fetchMock = vi.fn(async (url: string) => {
  const path = url.includes('/api/opensea') ? new URL(url, 'http://x').searchParams.get('path') : null;
  if (path === 'collections/junglebay/stats') return new Response(JSON.stringify(market.stats), { status: market.statsStatus });
  if (path === 'offers/collection/junglebay') return new Response(JSON.stringify(market.offers), { status: market.offersStatus });
  if (path) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify({ offers: [], count: 0, live: true, loans: [] }));
});
vi.stubGlobal('fetch', fetchMock);

const fee = (address: string, fraction: bigint | 'failure') =>
  fraction === 'failure'
    ? wagmiMock.setReadResult({ functionName: 'getProtocolFee', address, result: undefined, status: 'failure' })
    : wagmiMock.setReadResult({ functionName: 'getProtocolFee', address, result: { recipient: '0x0000000000000000000000000000000000000001', fraction } });

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setNativeBalance(parseEther('10'));
  wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: parseEther('5') });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: parseEther('5') });
  fee(LOAN, 500n);
  fee(GONDI_V31, 1500n);
  fee(GONDI_V32, 2000n);
  fetchMock.mockClear();
  market = {
    stats: { total: { floor_price: 0.3 }, intervals: [{ interval: 'thirty_day', sales: 41 }] },
    statsStatus: 200,
    // 0.28 x 3 and 0.27 x 2 are within 10% of the 0.3 floor; 0.2 is not; the trait bid buys
    // only some tokens, so it is no way out for a lender holding the cheapest one.
    offers: { offers: [seaportBid('0.28', 3), seaportBid('0.27', 2), seaportBid('0.2'), seaportBid('0.9', 1, { trait: { type: 'Fur', value: 'Gold' } })] },
    offersStatus: 200,
  };
});

const card = () => screen.getByTestId('lender-market');
const tile = (label: string) => within(card()).getByText(label).closest('div')!;
function fillLend(amount: string, apr = '10') {
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Loan amount (WETH)' }), { target: { value: amount } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'APR (%)' }), { target: { value: apr } });
}

describe('idea 1: the pitch', () => {
  it('heads the market card, with what it means one press away', () => {
    renderWithProviders(<NFTLendingSection />);
    expect(within(card()).getByText('A floor bid that earns while it waits.')).toBeTruthy();
    const why = screen.getByTestId('lender-market-why');
    expect(why.tagName).toBe('DETAILS');
    expect(why.hasAttribute('open')).toBe(false);
    expect(why.textContent).toContain('Repaid, you keep the interest. Not repaid, you get the NFT for what you lent');
  });
});

describe('idea 4: who buys it', () => {
  it('shows the floor, the best bid for ANY token, the bids near the floor and the month\'s sales', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    expect(within(tile('Floor')).getByText('0.3 ETH')).toBeTruthy();
    expect(within(tile('Near floor')).getByText('5')).toBeTruthy();
    expect(within(tile('Sales, 30d')).getByText('41')).toBeTruthy();
  });

  it('under the best bid: a buyer is already there, and how far under the floor', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    fillLend('0.25');
    expect(screen.getByTestId('lender-exit-check').textContent).toBe(
      'A buyer already bids 0.28 WETH, at or above your 0.25. 17% under the floor.',
    );
  });

  it('over the best bid: says what selling today would lose', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    fillLend('0.35');
    expect(screen.getByTestId('lender-exit-check').textContent).toBe(
      'Your 0.35 WETH is 0.07 over the best bid: unrepaid, selling today loses that. 17% over the floor.',
    );
  });

  it('far over the floor: the percent reads with thousands separators (owner 2026-11-12 saw "1114877%")', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    fillLend('3000');
    expect(screen.getByTestId('lender-exit-check').textContent).toContain(' 999,900% over the floor.');
  });

  it('no open bids is said plainly', async () => {
    market.offers = { offers: [] };
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('None')).toBeTruthy());
    fillLend('0.25');
    expect(screen.getByTestId('lender-exit-check').textContent).toContain('No open bids right now');
  });

  it('a failed bid read shows "–", never "None", and draws no verdict', async () => {
    market.offersStatus = 500;
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Floor')).getByText('0.3 ETH')).toBeTruthy());
    expect(within(tile('Best bid')).getByText('–')).toBeTruthy();
    expect(within(tile('Near floor')).getByText('–')).toBeTruthy();
    expect(within(card()).queryByText('None')).toBeNull();
    fillLend('0.25');
    expect(screen.queryByTestId('lender-exit-check')).toBeNull();
  });
});

describe('idea 2: same take-home on Gondi\'s own contracts', () => {
  it('compares with the LOWER Gondi fee: 10% here keeps what 11.18% keeps at 15%', async () => {
    renderWithProviders(<NFTLendingSection />);
    fillLend('1', '10');
    await waitFor(() =>
      expect(screen.getByTestId('lend-same-take-home').textContent).toBe(
        "Same take-home as 11.18% APR on Gondi's own contracts, which keep 15.00% of the interest or more.",
      ),
    );
  });

  it('says nothing when either Gondi fee is unread: the missing one could be the lower', async () => {
    fee(GONDI_V31, 'failure');
    renderWithProviders(<NFTLendingSection />);
    fillLend('1', '10');
    await waitFor(() => expect(screen.getByText(/after the venue's 5.00% of the interest/)).toBeTruthy());
    expect(screen.queryByTestId('lend-same-take-home')).toBeNull();
  });

  it('says nothing when our own fee is unread', async () => {
    fee(LOAN, 'failure');
    renderWithProviders(<NFTLendingSection />);
    fillLend('1', '10');
    await waitFor(() => expect(screen.getByText('Interest a loan earns, repaid at term')).toBeTruthy());
    expect(screen.queryByTestId('lend-same-take-home')).toBeNull();
  });
});

describe('one-tap amounts as a share of the floor', () => {
  it('fills the amount box with 90% of the floor it read', async () => {
    renderWithProviders(<NFTLendingSection />);
    const name = '90% of the floor: 0.2700 WETH';
    await screen.findByRole('button', { name });
    expect(screen.getByRole('button', { name: '60% of the floor: 0.1800 WETH' })).toBeTruthy();
    // This file's framer-motion stand-in builds a new component on every parent render, so
    // the form remounts while the section's own reads land: press the chip that is on screen.
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name }));
      expect((screen.getByRole('spinbutton', { name: 'Loan amount (WETH)' }) as HTMLInputElement).value).toBe('0.2700');
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('offers none when the floor could not be read', async () => {
    market.statsStatus = 500;
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Floor')).getByText('–')).toBeTruthy());
    expect(screen.queryByRole('group', { name: 'Share of the floor' })).toBeNull();
  });
});
