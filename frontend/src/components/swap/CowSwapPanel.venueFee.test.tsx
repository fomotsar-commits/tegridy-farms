// The fee disclosure on the one swap surface in this folder that actually signs.
//
// Scoped to the fee row on purpose — the panel's quoting, gating and order lifecycle
// are a separate subject, and folding them in here would make a fee regression look
// like a CoW regression.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PROVIDER_FEE_LEGS } from '../../lib/fees/swapFee';
import { COW_PARTNER_FEE_BPS } from '../../lib/cowProtocol';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true }),
  useChainId: () => 1,
}));

const getQuote = vi.fn(async () => ({
  sellAmount: 10n ** 18n,
  buyAmount: 2n * 10n ** 18n,
  feeAmount: 0n,
  protocolFeeBps: 0,
  validTo: 0,
  quoteId: null,
}));
vi.mock('../../hooks/useCowSwap', () => ({
  useCowSwap: () => ({ getQuote, placeSwap: vi.fn(), isPlacing: false, records: [] }),
}));

import { CowSwapPanel } from './CowSwapPanel';

const USDC = {
  symbol: 'USDC',
  name: 'USD Coin',
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  isNative: false,
} as const;
const TOWELI = {
  symbol: 'TOWELI',
  name: 'Toweli',
  address: '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca',
  decimals: 18,
  isNative: false,
} as const;

function renderPanel() {
  return render(
    <CowSwapPanel
      fromToken={USDC as never}
      toToken={TOWELI as never}
      inputAmount="100"
      slippage={0.5}
      onChainOutputFormatted="1.9"
    />,
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  getQuote.mockClear();
});

describe('the signing surface discloses the venue fee', () => {
  it('renders the fee as its own labelled row beside the quote', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Venue fee')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('shows the 0.25% before the user signs, and that third-party costs are separate', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('0.25%')).toBeInTheDocument(), { timeout: 3000 });
    const note = screen.getByText(/Added by the venue to this CowSwap route before you sign/i);
    expect(note.textContent).toMatch(/pool/i);
    expect(note.textContent).toMatch(/gas/i);
    expect(screen.queryByText('None')).toBeNull();
  });

  it('shows the CoW amount after the venue fee', async () => {
    // Mock quote: 2.0 TOWELI, no network cost, no protocol fee → 0.25% off = 1.995.
    renderPanel();
    await waitFor(() => expect(screen.getByText(/^1\.9950 TOWELI$/)).toBeInTheDocument(), { timeout: 3000 });
  });

  it('shows the rate the signed order carries, not the aggregator policy', async () => {
    // The panel reads COW_PARTNER_FEE_BPS, the rate in the market-swap appData it
    // signs. The aggregator's venue-fee setting never reaches a CoW order (that leg
    // stays withheld), so setting it must not change what this panel discloses.
    expect(PROVIDER_FEE_LEGS.cowswap.status).toBe('blocked');
    expect(COW_PARTNER_FEE_BPS).toBe(25);
    vi.stubEnv('VITE_SWAP_FEE_BPS', '40');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d');
    renderPanel();
    await waitFor(() => expect(screen.getByText('0.25%')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText(/0\.40?%/)).toBeNull();
  });
});
