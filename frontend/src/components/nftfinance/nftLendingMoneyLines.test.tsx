// How money moves on the lending tab, said where each side decides (owner, 2026-10-09: say how
// people earn and how the venue earns). Two facts the tab left out, checked against Gondi's
// v3.2 loan contract:
//   - The venue's 5% is taken from interest when interest is paid (a repayment, or another
//     lender taking the loan over). A loan that is not repaid pays no interest, so the venue
//     gets nothing from it.
//   - Every offer signed here lets another lender take the loan over (lenderRefinanceDisabled
//     false): between 15% and 85% of the term, at a better rate, without the borrower signing.
//     The first lender is paid principal plus interest so far; the borrower's deadline can
//     only move later, and the amount owed can grow if the new lender lends more.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
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
import { WETH_ADDRESS, ZERO_ADDRESS, wholeCollectionValidators, type LoanOfferJson } from '../../lib/gondi/loanOffer.js';

const LOAN = '0x5555555555555555555555555555555555555555';
const NAKA = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';
const NOW = Math.floor(Date.now() / 1000);

const offer: LoanOfferJson = {
  offerId: '99',
  lender: '0x4444444444444444444444444444444444444444',
  fee: '0',
  capacity: '0',
  nftCollateralAddress: NAKA,
  nftCollateralTokenId: '0',
  principalAddress: WETH_ADDRESS,
  principalAmount: parseEther('1').toString(),
  aprBps: '1000',
  expirationTime: String(NOW + 86400),
  duration: String(30 * 86400),
  maxSeniorRepayment: '0',
  validators: wholeCollectionValidators(),
  lenderRefinanceDisabled: false,
  borrower: ZERO_ADDRESS,
};

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    if (url.includes('action=loans')) return new Response(JSON.stringify({ loans: [], live: true }));
    return new Response(JSON.stringify({ offers: [{ offer, signature: `0x${'ab'.repeat(65)}`, createdAt: '' }], count: 1, live: true }));
  }),
);

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: '0x1111111111111111111111111111111111111111', isConnected: true });
  wagmiMock.setReadResult({ functionName: 'getProtocolFee', address: LOAN, result: { recipient: LOAN, fraction: 500n } });
  wagmiMock.setReadResult({ functionName: 'isOfferCancelled', address: LOAN, result: false });
  wagmiMock.setReadResult({ functionName: 'getUsedCapacity', address: LOAN, result: 0n });
  wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: parseEther('5') });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: parseEther('5') });
});

describe('how the venue earns', () => {
  it('the fee tile says the venue is paid only from interest, so an unpaid loan earns it nothing', async () => {
    renderWithProviders(<NFTLendingSection />);
    const label = await screen.findByText('Venue Fee');
    fireEvent.click(within(label.closest('p')!).getByRole('button', { name: 'More info' }));
    const tip = await screen.findByText(/The venue keeps this share of the interest/);
    expect(tip.textContent).toMatch(/A loan that is not repaid pays no interest, so the venue gets nothing from it\./);
  });
});

describe('another lender can take a loan over', () => {
  it('the lender reads it before signing: paid back early, with interest so far', () => {
    renderWithProviders(<NFTLendingSection />);
    const about = screen.getByText('About signed offers').closest('details')!;
    expect(about.textContent).toMatch(/another lender can take the loan over/i);
    expect(about.textContent).toMatch(/at a lower rate without asking you or the borrower/);
    expect(about.textContent).toMatch(/your WETH back plus the interest so far/i);
  });

  it('the borrower reads it before taking a loan: new lender, a later deadline, maybe more owed', async () => {
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    fireEvent.click(await screen.findByText('NAKA · any NFT'));
    const details = screen.getAllByText('Details').map((s) => s.closest('details')!);
    const text = details.map((d) => d.textContent).join(' ');
    expect(text).toMatch(/another lender can take this loan over/i);
    expect(text).toMatch(/deadline can only move later/i);
    // Before a token is picked the NFT is "your NAKA", and here it starts the paragraph.
    expect(text).toMatch(/Your NAKA is locked in Gondi's loan contract/);
    expect(text).not.toMatch(/your NAKA is locked/);
  });
});
