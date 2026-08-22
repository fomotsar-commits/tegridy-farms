// The fee disclosure on the one swap surface in this folder that actually signs.
//
// Scoped to the fee row on purpose — the panel's quoting, gating and order lifecycle
// are a separate subject, and folding them in here would make a fee regression look
// like a CoW regression.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PROVIDER_FEE_LEGS } from '../../lib/fees/swapFee';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true }),
  useChainId: () => 1,
}));

const getQuote = vi.fn(async () => ({
  sellAmount: 10n ** 18n,
  buyAmount: 2n * 10n ** 18n,
  feeAmount: 0n,
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

  it('shows "None" rather than a claim that the trade is free of charges', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('None')).toBeInTheDocument(), { timeout: 3000 });
    const note = screen.getByText(/Tegridy adds no fee/i);
    expect(note.textContent).toMatch(/pool/i);
    expect(note.textContent).toMatch(/gas/i);
  });

  it('stays at zero even with the venue fee configured, because CoW’s leg is withheld', async () => {
    // Pins the reason the panel may read the policy directly: there is no CoW request
    // parameter for this module to disagree with. Unblocking the leg means wiring
    // cowProtocol.ts's appData at the same time, and this test is the tripwire.
    expect(PROVIDER_FEE_LEGS.cowswap.status).toBe('blocked');
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', '0x6d5791A660e79175F74C6D639584C98422d5956E');
    renderPanel();
    await waitFor(() => expect(screen.getByText('None')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText(/0\.25%/)).toBeNull();
  });
});
