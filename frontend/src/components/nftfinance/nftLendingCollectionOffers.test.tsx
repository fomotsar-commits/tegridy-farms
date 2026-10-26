// Whole-collection NFT loan offers (Gondi collection offers).
//
// The lending contract now takes `createOffer(..., tokenId, isFullContractOffer,
// expiry)` and `acceptOffer(offerId, tokenId)`. These tests pin what the screen
// SENDS, because a wrong argument here is not a cosmetic bug: it is an offer
// pinned to the wrong NFT, or a borrower locking a token they did not pick.
//   • Lend: the default is "any NFT in the collection" — token 0 + flag true.
//     "One specific NFT" sends the typed id with the flag false.
//   • Borrow: a collection offer asks which NFT to lock and sends THAT id to
//     both the approval and acceptOffer; a specific offer sends the lender's id.
//   • The screen reads the flag exactly as the contract does: a non-zero token
//     id with the flag set is still an exact match, so it is shown as fixed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

import { NFTLendingSection } from './NFTLendingSection';
import { TEGRIDY_NFT_LENDING_ADDRESS } from '../../lib/constants';

const ME = '0x00000000000000000000000000000000000000aa' as const;
const SOMEONE_ELSE = '0x00000000000000000000000000000000000000bb' as const;
const LENDER = '0x00000000000000000000000000000000000000cc' as const;
const JBAC = '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9' as const;

function connect() {
  wagmiMock.setAccount({ address: ME, isConnected: true });
  wagmiMock.setChainId(1);
}

/** One open offer on chain, shaped like the contract's getOffer return. */
function stubOneOffer(tokenId: bigint, isFullContractOffer: boolean) {
  wagmiMock.setReadResult({ functionName: 'offerCount', address: TEGRIDY_NFT_LENDING_ADDRESS, result: 1n });
  wagmiMock.setReadResult({
    functionName: 'getOffer',
    address: TEGRIDY_NFT_LENDING_ADDRESS,
    result: [LENDER, 10n ** 18n, 1000n, 30n * 86400n, JBAC, tokenId, true, isFullContractOffer],
  });
}

function lastWrite(): { functionName: string; args: readonly unknown[] } {
  const calls = wagmiMock.writeContract().mock.calls;
  return calls[calls.length - 1]![0];
}

function openBorrowOffer() {
  fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
  fireEvent.click(screen.getByText('Offer #0'));
}

describe('Lend: whole-collection offers are the default', () => {
  beforeEach(() => {
    wagmiMock.reset();
    connect();
  });

  function fillTerms() {
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 1000 = 10%'), { target: { value: '1000' } });
  }

  it('sends token 0 with the collection flag on, and asks for no token id', () => {
    renderWithProviders(<NFTLendingSection />);

    expect(screen.getByRole('button', { name: 'Any NFT in the collection' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('Token ID')).toBeNull();

    fillTerms();
    fireEvent.click(screen.getByRole('button', { name: 'Create Loan Offer' }));

    const w = lastWrite();
    expect(w.functionName).toBe('createOffer');
    expect(w.args[3]).toBe(JBAC);
    expect(w.args[4]).toBe(0n);
    expect(w.args[5]).toBe(true);
  });

  it('pins the offer to the typed token when "One specific NFT" is chosen', () => {
    renderWithProviders(<NFTLendingSection />);

    fireEvent.click(screen.getByRole('button', { name: 'One specific NFT' }));
    fillTerms();
    fireEvent.change(screen.getByLabelText('Token ID'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Loan Offer' }));

    const w = lastWrite();
    expect(w.args[4]).toBe(1234n);
    expect(w.args[5]).toBe(false);
  });

  it('refuses a specific offer with no token id instead of sending token 0', () => {
    renderWithProviders(<NFTLendingSection />);

    fireEvent.click(screen.getByRole('button', { name: 'One specific NFT' }));
    fillTerms();
    fireEvent.click(screen.getByRole('button', { name: 'Create Loan Offer' }));

    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });
});

describe('Borrow: the borrower names the NFT on a collection offer', () => {
  beforeEach(() => {
    wagmiMock.reset();
    connect();
  });

  it('approves and accepts with the token the borrower typed', () => {
    stubOneOffer(0n, true);
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: JBAC, result: ME });
    renderWithProviders(<NFTLendingSection />);
    openBorrowOffer();

    expect(screen.getByText('JBAC · any NFT')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Your JBAC to lock/ }), { target: { value: '77' } });
    expect(screen.getByText('You own JBAC #77.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Approve NFT' }));
    let w = lastWrite();
    expect(w.functionName).toBe('approve');
    expect(w.args).toEqual([TEGRIDY_NFT_LENDING_ADDRESS, 77n]);

    fireEvent.click(screen.getByRole('button', { name: 'Accept Offer' }));
    w = lastWrite();
    expect(w.functionName).toBe('acceptOffer');
    expect(w.args).toEqual([0n, 77n]);
  });

  it('blocks approve and accept until a token id is entered', () => {
    stubOneOffer(0n, true);
    renderWithProviders(<NFTLendingSection />);
    openBorrowOffer();

    expect((screen.getByRole('button', { name: 'Approve NFT' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Accept Offer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so, and blocks the buttons, when the typed NFT belongs to someone else', () => {
    stubOneOffer(0n, true);
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: JBAC, result: SOMEONE_ELSE });
    renderWithProviders(<NFTLendingSection />);
    openBorrowOffer();

    fireEvent.change(screen.getByRole('spinbutton', { name: /Your JBAC to lock/ }), { target: { value: '5' } });
    expect(screen.getByText('JBAC #5 is not in your wallet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve NFT' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not call an unreadable owner "yours"', () => {
    stubOneOffer(0n, true);
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: JBAC, result: undefined, status: 'failure' });
    renderWithProviders(<NFTLendingSection />);
    openBorrowOffer();

    fireEvent.change(screen.getByRole('spinbutton', { name: /Your JBAC to lock/ }), { target: { value: '5' } });
    expect(screen.queryByText(/You own/)).toBeNull();
    expect(screen.getByText(/Couldn't find JBAC #5/)).toBeTruthy();
  });
});

describe('Borrow: a specific offer keeps the lender\'s token', () => {
  beforeEach(() => {
    wagmiMock.reset();
    connect();
  });

  it('accepts with the token the lender fixed', () => {
    stubOneOffer(55n, false);
    renderWithProviders(<NFTLendingSection />);
    openBorrowOffer();

    expect(screen.getByText('Fixed by lender')).toBeTruthy();
    expect(screen.queryByLabelText(/to lock/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Offer' }));
    expect(lastWrite().args).toEqual([0n, 55n]);
  });

  it('treats the flag with a non-zero token as fixed, as the contract does', () => {
    stubOneOffer(9n, true);
    renderWithProviders(<NFTLendingSection />);
    openBorrowOffer();

    expect(screen.getAllByText('JBAC #9').length).toBeGreaterThan(0);
    expect(screen.queryByText('JBAC · any NFT')).toBeNull();
    expect(screen.getByText('Fixed by lender')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Offer' }));
    expect(lastWrite().args).toEqual([0n, 9n]);
  });
});
