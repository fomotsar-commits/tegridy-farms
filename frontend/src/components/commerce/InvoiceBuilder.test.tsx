// The merchant's side, tested for the two things that decide whether a link is
// safe to hand out: that it can only be minted on a chain whose settlement asset
// this repo has verified, and that no link is shown until the merchant's own
// browser has verified the signature the wallet returned.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const MERCHANT = '0x1111111111111111111111111111111111111111' as const;
const SIGNATURE = `0x${'cd'.repeat(65)}` as const;

interface Harness {
  chain: { id: number } | undefined;
  address: `0x${string}` | undefined;
  sign: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  hasClient: boolean;
}

const h: Harness = {
  chain: { id: 1 },
  address: MERCHANT,
  sign: vi.fn(),
  verify: vi.fn(),
  hasClient: true,
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.address, isConnected: h.address !== undefined, chain: h.chain }),
  useChainId: () => h.chain?.id ?? 1,
  useSignTypedData: () => ({ signTypedDataAsync: h.sign }),
  usePublicClient: () =>
    h.hasClient
      ? { verifyTypedData: h.verify, getCode: () => Promise.resolve('0x60'), readContract: () => Promise.resolve(0) }
      : undefined,
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false, error: null }),
  useBlock: () => ({ data: undefined }),
}));

import { InvoiceBuilder } from './InvoiceBuilder';

beforeEach(() => {
  h.chain = { id: 1 };
  h.address = MERCHANT;
  h.hasClient = true;
  h.sign = vi.fn().mockResolvedValue(SIGNATURE);
  h.verify = vi.fn().mockResolvedValue(true);
  localStorage.clear();
});

/** Fill the one field with no usable default. */
function fillAmount(value = '100') {
  fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value } });
}

describe('a link is only minted on a chain with a verified settlement asset', () => {
  it('refuses to sign when the wallet is on a chain this build does not serve', async () => {
    // `useAccount().chain` is undefined exactly here — wagmi's useChainId would
    // have reported a configured chain and hidden it.
    h.chain = undefined;
    render(<InvoiceBuilder />);
    fillAmount();
    const button = screen.getByRole('button', { name: /sign the invoice/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/a chain this build does not serve/i)).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(h.sign).not.toHaveBeenCalled());
  });

  it('refuses to sign on Base and names the chain the wallet is actually on', async () => {
    h.chain = { id: 8453 };
    render(<InvoiceBuilder />);
    fillAmount();
    expect(screen.getByRole('button', { name: /sign the invoice/i })).toBeDisabled();
    // Both chain names come from lib/explorer's label table, so this sentence
    // self-extends the day a Base settlement asset is verified and registered.
    expect(screen.getByText(/Signed payment links are minted on Mainnet/i)).toBeInTheDocument();
    expect(screen.getByText(/Your wallet is on Base/i)).toBeInTheDocument();
    // And there is nothing to pick, because nothing on 8453 is registered.
    expect(screen.getByRole('option', { name: /no verified asset on this chain/i })).toBeInTheDocument();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('offers only the five verified mainnet assets on chain 1', () => {
    render(<InvoiceBuilder />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.sort()).toEqual(['DAI', 'Toweli', 'USDC', 'USDT', 'WETH']);
  });

  it('says to connect a wallet rather than offering a payee field', () => {
    h.address = undefined;
    render(<InvoiceBuilder />);
    expect(screen.getByText(/Connect a wallet to sign as the payee/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/merchant|payee address/i)).toBeNull();
    expect(screen.getByRole('button', { name: /sign the invoice/i })).toBeDisabled();
  });
});

describe('no link is shown until this browser verified the signature', () => {
  it('mints a fragment link on the canonical origin once the self-check passes', async () => {
    render(<InvoiceBuilder />);
    fillAmount();
    fireEvent.click(screen.getByRole('button', { name: /sign the invoice/i }));

    expect(await screen.findByText('Your payment link')).toBeInTheDocument();
    const link = screen.getByText(/\/checkout#i=/);
    expect(link.textContent).toContain('/checkout#i=');
    // The document names the signer in full, and the copy tells the buyer to
    // compare it — the signature proves integrity, never identity.
    expect(screen.getByText(new RegExp(`signed by ${MERCHANT}`, 'i'))).toBeInTheDocument();
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it('produces NO link when the wallet\'s signature does not verify against the merchant', async () => {
    // The Safe-below-threshold case: a signature the wallet returned happily and
    // that no buyer's browser would ever accept.
    h.verify = vi.fn().mockResolvedValue(false);
    render(<InvoiceBuilder />);
    fillAmount();
    fireEvent.click(screen.getByRole('button', { name: /sign the invoice/i }));

    expect(await screen.findByText('The signature did not verify')).toBeInTheDocument();
    expect(screen.getByText(/smart-account wallets need their on-chain validator/i)).toBeInTheDocument();
    expect(screen.queryByText('Your payment link')).toBeNull();
    expect(screen.queryByText(/\/checkout#i=/)).toBeNull();
  });

  it('produces NO link when the self-check could not run at all', async () => {
    h.verify = vi.fn().mockRejectedValue(new Error('rpc: 429 rate limited'));
    render(<InvoiceBuilder />);
    fillAmount();
    fireEvent.click(screen.getByRole('button', { name: /sign the invoice/i }));

    expect(await screen.findByText('The signature did not verify')).toBeInTheDocument();
    expect(screen.getByText(/429/)).toBeInTheDocument();
    expect(screen.queryByText('Your payment link')).toBeNull();
  });

  it('says nothing was signed when the merchant rejected it in the wallet', async () => {
    h.sign = vi.fn().mockRejectedValue(new Error('User rejected the request'));
    render(<InvoiceBuilder />);
    fillAmount();
    fireEvent.click(screen.getByRole('button', { name: /sign the invoice/i }));

    expect(await screen.findByText(/User rejected the request/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was signed and nothing was sent anywhere/i)).toBeInTheDocument();
    expect(h.verify).not.toHaveBeenCalled();
    expect(screen.queryByText('Your payment link')).toBeNull();
  });
});

describe('the store is an accessory, and the copy says so', () => {
  it('keeps the short link behind a disclosure that states it is weaker', () => {
    render(<InvoiceBuilder />);
    // Not the primary action any more: publishing needs a table an operator may
    // never create, and the signed link needs nothing.
    expect(screen.queryByRole('button', { name: /^publish the short link$/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /also publish a short link/i }));
    expect(screen.getByRole('button', { name: /publish the short link/i })).toBeInTheDocument();
    expect(screen.getByText(/strictly weaker/i)).toBeInTheDocument();
    expect(screen.getByText(/The signed link above needs nothing/i)).toBeInTheDocument();
  });

  it('keeps the unsigned-callback disclosure with the callback field', () => {
    render(<InvoiceBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /also publish a short link/i }));
    expect(screen.getByLabelText(/callback url/i)).toBeInTheDocument();
    expect(screen.getByText(/an unsigned callback is one anybody could forge/i)).toBeInTheDocument();
  });
});

describe('accessibility and touch targets', () => {
  it('gives every control a 44px minimum height', () => {
    render(<InvoiceBuilder />);
    for (const el of [
      screen.getByLabelText(/invoice id/i),
      screen.getByLabelText(/settlement asset/i),
      screen.getByLabelText(/^amount$/i),
      screen.getByLabelText(/payable for/i),
      screen.getByLabelText(/memo/i),
      screen.getByRole('button', { name: /sign the invoice/i }),
      screen.getByRole('button', { name: /also publish a short link/i }),
    ]) {
      expect(el.className).toContain('min-h-11');
    }
  });

  it('renders no h1 of its own — the page owns the only one', () => {
    render(<InvoiceBuilder />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
