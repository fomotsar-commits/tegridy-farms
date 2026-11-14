// An add's card rises naming the pool's own pairing coin (SOL, USDC or an island coin): the line under the
// title, and the title it shows until the add's transaction is read (or when it cannot be).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { raiseAddReceipt } from './addReceipt';
import { ReceiptCard } from '../../ReceiptCard';
import { clearReceipt } from '../../../lib/receipt';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';

vi.mock('../../../lib/solana/receiptRead', () => ({ settleAddReceipt: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../hooks/useConfetti', () => ({ useConfetti: () => ({ fire: () => undefined }) }));

const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const TBB = '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump';
const rpc = { getTransaction: vi.fn() } as unknown as Parameters<typeof raiseAddReceipt>[0];

// Only what the raise reads of a pool; the rest of a view is the readers' own.
const add = (quote: QuoteCoin, tokenMint: string, ticker: string) =>
  raiseAddReceipt(rpc, `add-${quote.symbol}-${ticker}`, {
    view: { address: 'Pool1111111111111111111111111111111111111111', tokenMint, quote, quoteIsToken0: true, config: null } as unknown as PoolView,
    wallet: WALLET,
    ticker,
    decimals: 6,
  } as Parameters<typeof raiseAddReceipt>[2]);

beforeEach(() => {
  clearReceipt();
  render(<ReceiptCard />);
});
afterEach(cleanup);

describe('an add’s card names the pool’s pairing coin', () => {
  it.each([
    ['a SOL pool', SOL_QUOTE, BAYLA, 'BAYLA', 'Added SOL + BAYLA', 'to the SOL + BAYLA pool'],
    ['a USDC pool', USDC_QUOTE, BAYLA, 'BAYLA', 'Added USDC + BAYLA', 'to the USDC + BAYLA pool'],
    ['a BAYLA pool', BAYLA_QUOTE, TBB, 'TBB', 'Added BAYLA + TBB', 'to the BAYLA + TBB pool'],
  ] as const)('%s: the title before the read and the line under it', (_name, quote, mint, ticker, title, under) => {
    act(() => add(quote, mint, ticker));
    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
    expect(screen.getByTestId('receipt-under')).toHaveTextContent(under);
  });
});
