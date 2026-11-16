// The venue's own bidder never makes a loan look safe (BUILD-SPEC 3.2, item 3).
//
// With a house wallet in lib/house/houseRegistry.json, its bid is the highest one on the
// book here. A lender reading "Best bid 0.29" or "A buyer already bids 0.29" would be relying
// on the venue's own bid to get their money back. So the house bid counts in no tile, no exit
// check and no "covered" stretch of the floor bar, and the card says so in one line.
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
// One house wallet registered, through the real registry logic.
vi.mock('../../lib/house/houseRegistry.js', async () => {
  const core = await import('../../lib/house/houseRegistryCore.js');
  const house = core.createHouseRegistry({
    version: 1,
    note: 'test',
    wallets: [{ address: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', label: 'House bidder', collections: ['junglebay'], since: '2026-11-16' }],
  });
  return { ...house, HOUSE_LABEL: core.HOUSE_LABEL, createHouseRegistry: core.createHouseRegistry };
});

import { NFTLendingSection } from './NFTLendingSection';
import { WETH_ADDRESS } from '../../lib/gondi/loanOffer.js';

const HOUSE = '0x8ba1f109551bd432803012645ac136ddd64dba72';
const WALLET = '0x1111111111111111111111111111111111111111';
const CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';

let n = 0;
const seaportBid = (eth: string, qty = 1, offerer?: string) => {
  const wei = (parseEther(eth) * BigInt(qty)).toString();
  n += 1;
  return {
    order_hash: `0x0${n}`,
    price: { currency: 'WETH', value: wei },
    criteria: { collection: { slug: 'junglebay' }, trait: null },
    protocol_data: {
      parameters: {
        offerer: offerer ?? '0x' + n.toString(16).padStart(40, '0'),
        conduitKey: CONDUIT_KEY,
        offer: [{ startAmount: wei }],
        consideration: [{ itemType: 4, identifierOrCriteria: '0', startAmount: String(qty) }],
      },
    },
  };
};

let offers: unknown[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    const path = url.includes('/api/opensea') ? new URL(url, 'http://x').searchParams.get('path') : null;
    if (path === 'collections/junglebay/stats') {
      return new Response(JSON.stringify({ total: { floor_price: 0.3 }, intervals: [{ interval: 'thirty_day', sales: 41 }] }));
    }
    if (path === 'offers/collection/junglebay') return new Response(JSON.stringify({ offers }));
    if (path) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ offers: [], count: 0, live: true, loans: [] }));
  }),
);

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setNativeBalance(parseEther('10'));
  wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: parseEther('5') });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: parseEther('5') });
  // The house bids highest, for two; outside bidders bid 0.28 x 3 and 0.27 x 2.
  offers = [seaportBid('0.29', 2, HOUSE), seaportBid('0.28', 3), seaportBid('0.27', 2)];
});

const card = () => screen.getByTestId('lender-market');
const tile = (label: string) => within(card()).getByText(label).closest('div')!;
function fillLend(amount: string) {
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Loan amount (WETH)' }), { target: { value: amount } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'APR (%)' }), { target: { value: '10' } });
}

describe("the house's own bid on the lending card", () => {
  it('is not the best bid, and its two NFTs are not near the floor', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    await waitFor(() => expect(within(tile('Near floor')).getByText('5')).toBeTruthy());
  });

  it('never tells a lender a buyer is there because the house bids', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    fillLend('0.285');
    expect(screen.getByTestId('lender-exit-check').textContent).toMatch(/^Your 0.285 WETH is 0.005 over the best bid/);
    expect(screen.getByTestId('floor-bar').getAttribute('data-zone')).toBe('under-floor');
  });

  it('says once that house bids are left out', async () => {
    renderWithProviders(<NFTLendingSection />);
    await waitFor(() => expect(within(tile('Best bid')).getByText('0.28 WETH')).toBeTruthy());
    expect(screen.getByTestId('lender-market-house').textContent).toBe('Our own house bids are not counted here.');
  });
});
