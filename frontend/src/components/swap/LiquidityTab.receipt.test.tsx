/**
 * THE CARD'S "Confirmed!" LINE BELONGS TO THE LIQUIDITY ACTION, NEVER TO ITS APPROVAL.
 *
 * LiquidityTab renders `Confirmed! View on Explorer` under the form. It used to render
 * for ANY confirmed write from useAddLiquidity — so after "Approve TOWELI" or "Approve
 * LP" the card said "Confirmed!" under a form whose real action had not been sent. The
 * hook's toast already told the two apart (2026-07-26, "Token approved — one more
 * step"), and FarmPage ruled the same way for staking: an approval is a prerequisite,
 * not a completion, so it gets no receipt.
 *
 * Driven through the real component and the real hook; only wagmi is stubbed. Every
 * case CLICKS the CTA and lands a receipt addressed to whatever that click actually
 * sent, so "an approval receipt" here is what an approval really produces — not an
 * address this file picked.
 *
 * The link is found with e2e/fixtures/wallet.ts's own selector (`a[href*="/tx/0x"]`).
 * The add and remove legs of e2e/liquidity.spec.ts wait for exactly that element, and an
 * approval's link is what used to satisfy them in the burn's place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

type Sent = { address: `0x${string}`; functionName: string };

const w = vi.hoisted(() => ({
  pair: '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a' as `0x${string}`,
  hash: undefined as `0x${string}` | undefined,
  receipt: undefined as { status: 'success'; to: `0x${string}`; transactionHash: `0x${string}` } | undefined,
  allowance: 0n,
  lpBalance: 0n,
  writeContract: vi.fn<(args: Sent) => void>(),
}));

vi.mock('wagmi', async () => {
  const { CHAIN_ID } = await import('../../lib/constants');
  // Answered BY QUERY, so the pair's LP reads and the tokens' reads cannot trade places.
  const answer = (c: { address: string; functionName: string }): unknown => {
    const onPair = c.address.toLowerCase() === w.pair.toLowerCase();
    switch (c.functionName) {
      // Equal reserves: the pool quotes B == A whichever side is token0.
      case 'getReserves': return [10n ** 21n, 10n ** 21n, 0];
      case 'token0': return '0x000000000000000000000000000000000000dead';
      case 'totalSupply': return 10n ** 21n;
      case 'balanceOf': return onPair ? w.lpBalance : 10n ** 24n;
      case 'allowance': return w.allowance;
      default: throw new Error(`unstubbed read: ${c.functionName}`);
    }
  };
  return {
    useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true }),
    useChainId: () => CHAIN_ID,
    useWalletClient: () => ({ data: undefined }),
    useBalance: () => ({ data: { value: 10n ** 20n, decimals: 18 } }),
    useReadContract: () => ({ data: w.pair, refetch: vi.fn() }),
    useReadContracts: ({ contracts }: { contracts: ReadonlyArray<{ address: string; functionName: string }> }) => ({
      data: contracts.map((c) => ({ status: 'success' as const, result: answer(c) })),
      refetch: vi.fn(),
      isLoading: false,
    }),
    useWriteContract: () => ({ writeContract: w.writeContract, data: w.hash, isPending: false, reset: vi.fn(), error: null }),
    useWaitForTransactionReceipt: () => ({ data: w.receipt, isLoading: false, isSuccess: !!w.receipt, isError: false }),
  };
});

vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('./TokenSelectModal', () => ({ TokenSelectModal: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { LiquidityTab } from './LiquidityTab';
import { toast } from 'sonner';
import { liquidityVenueOn } from '../../lib/chains/liquidityVenue';
import { getTxUrl } from '../../lib/explorer';
import { CHAIN_ID } from '../../lib/constants';

const HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const ROUTER = liquidityVenueOn(CHAIN_ID)!.router;
const receiptLink = () => document.querySelector('a[href*="/tx/0x"]');

function openAdd() {
  const view = render(<LiquidityTab />);
  // Token B is auto-paired from the reserves inside A's onChange.
  fireEvent.change(screen.getAllByPlaceholderText('0.0')[0], { target: { value: '0.001' } });
  return view;
}

function openRemove() {
  const view = render(<LiquidityTab />);
  fireEvent.click(screen.getByRole('button', { name: 'Pull Crop Out' }));
  fireEvent.click(screen.getByRole('button', { name: '100%' }));
  return view;
}

/** Click the card's one CTA, then land a successful receipt for exactly what that click sent. */
function sendAndConfirm(rerender: ReturnType<typeof render>['rerender']): Sent {
  const cta = screen.getByTestId('liquidity-submit');
  expect(cta).toBeEnabled();
  fireEvent.click(cta);
  expect(w.writeContract).toHaveBeenCalledTimes(1);
  const sent = w.writeContract.mock.calls[0][0];
  w.hash = HASH;
  // A node returns `to` in lowercase while the venue's router is checksummed. Real
  // receipts look like this, so the comparison has to survive it.
  w.receipt = { status: 'success', to: sent.address.toLowerCase() as `0x${string}`, transactionHash: HASH };
  rerender(<LiquidityTab />);
  return sent;
}

describe('LiquidityTab: an approval is not a confirmation', () => {
  beforeEach(() => {
    w.hash = undefined;
    w.receipt = undefined;
    w.allowance = 0n;
    w.lpBalance = 0n;
    w.writeContract.mockReset();
    vi.mocked(toast.success).mockClear();
  });

  it('Approve TOWELI confirms with NO "Confirmed!" line and no receipt link', () => {
    const { rerender } = openAdd();
    expect(screen.getByTestId('liquidity-submit')).toHaveTextContent('Approve TOWELI');

    const sent = sendAndConfirm(rerender);
    expect(sent.functionName).toBe('approve');
    // The receipt WAS processed as a success (the hook toasted it), so the absence
    // below is the gate at work, not a receipt that never landed.
    expect(toast.success).toHaveBeenCalled();
    expect(screen.queryByText(/Confirmed!/)).toBeNull();
    expect(receiptLink()).toBeNull();
  });

  it('Approve LP confirms with NO "Confirmed!" line and no receipt link', () => {
    w.lpBalance = 10n ** 18n;
    const { rerender } = openRemove();
    expect(screen.getByTestId('liquidity-submit')).toHaveTextContent('Approve LP');

    const sent = sendAndConfirm(rerender);
    expect(sent.functionName).toBe('approve');
    expect(toast.success).toHaveBeenCalled();
    expect(screen.queryByText(/Confirmed!/)).toBeNull();
    expect(receiptLink()).toBeNull();
  });

  it('the add, sent to the router, renders "Confirmed!" linking its own transaction', () => {
    // Precondition: the lowercase receipt `to` really differs in case from the router.
    expect(ROUTER).not.toBe(ROUTER.toLowerCase());
    w.allowance = 2n ** 256n - 1n;
    const { rerender } = openAdd();
    expect(screen.getByTestId('liquidity-submit')).toHaveTextContent('Grow the Crop');

    const sent = sendAndConfirm(rerender);
    expect(sent.address).toBe(ROUTER);
    expect(screen.getByText(/Confirmed!/)).toBeInTheDocument();
    expect(receiptLink()?.getAttribute('href')).toBe(getTxUrl(CHAIN_ID, HASH));
  });

  it('the remove, sent to the router, renders "Confirmed!" linking its own transaction', () => {
    expect(ROUTER).not.toBe(ROUTER.toLowerCase());
    w.allowance = 2n ** 256n - 1n;
    w.lpBalance = 10n ** 18n;
    const { rerender } = openRemove();
    expect(screen.getByTestId('liquidity-submit')).toHaveTextContent('Pull Crop Out');

    const sent = sendAndConfirm(rerender);
    expect(sent.address).toBe(ROUTER);
    expect(screen.getByText(/Confirmed!/)).toBeInTheDocument();
    expect(receiptLink()?.getAttribute('href')).toBe(getTxUrl(CHAIN_ID, HASH));
  });
});
