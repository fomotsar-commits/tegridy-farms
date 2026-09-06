/**
 * SHARE THE RECEIPT, NOT A SLOGAN.
 *
 * "Share to X" used to post `Just <verb> on @JungleBayAC! 🌿 #TOWELI #DeFi`
 * plus a bare Etherscan link. Three problems, and the tests below pin all of
 * them as fixed:
 *   1. it read as spam and told a reader nothing they could act on
 *   2. the `url=` param made the post's link preview Etherscan's page, not ours
 *   3. the hashtag was hardcoded to one resident's ticker while this component
 *      mounts app-wide, so a BAYLA staker's post carried #TOWELI
 *
 * The format now sent is the receipt itself — the same block Copy Image already
 * falls back to — which is what people actually post.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TransactionReceiptProvider } from './TransactionReceipt';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';

// jsdom has no real canvas; failing the render is the honest default and drives
// the "could not copy" branch. The success branch is exercised separately below.
vi.mock('html2canvas', () => ({
  default: vi.fn(async () => {
    throw new Error('no canvas in jsdom');
  }),
}));

function Opener({ data = { amount: '50000000000000000000000', token: 'TOWELI' } }: { data?: Record<string, unknown> }) {
  const { showReceipt } = useTransactionReceipt();
  return (
    <button onClick={() => showReceipt({ type: 'stake', data } as never)}>open receipt</button>
  );
}

function openAndShare(data?: Record<string, unknown>) {
  render(
    <TransactionReceiptProvider>
      <Opener data={data} />
    </TransactionReceiptProvider>,
  );
  fireEvent.click(screen.getByText('open receipt'));
  fireEvent.click(screen.getByText('Share to X'));
}

/** The `text` param of the intent URL window.open was called with. */
function sharedText(spy: ReturnType<typeof vi.fn>): string {
  const url = new URL(String(spy.mock.calls.at(-1)?.[0]));
  return url.searchParams.get('text') ?? '';
}

let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  wagmiMock.reset();
  openSpy = vi.fn();
  vi.stubGlobal('open', openSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('receipt share — posts the receipt', () => {
  it('sends the receipt block, not the slogan', async () => {
    openAndShare();
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    const text = sharedText(openSpy);

    // The shape people actually post: venue, rule, action, then the numbers.
    expect(text).toContain('MEMETICS.FINANCE');
    expect(text).toContain('━'.repeat(30));
    expect(text).toMatch(/Amount: .*TOWELI/);

    // And none of what it replaced.
    expect(text).not.toContain('Just ');
    expect(text).not.toContain('@JungleBayAC');
    expect(text).not.toContain('#DeFi');
  });

  it('carries no hashtag at all, so it cannot tag the wrong resident', async () => {
    openAndShare();
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    // The old bug was a hardcoded #TOWELI on an app-wide component. A format
    // with no '#' anywhere has no room for that class of mistake.
    expect(sharedText(openSpy)).not.toContain('#');
  });

  it('does not append a separate url param', async () => {
    openAndShare();
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    const url = new URL(String(openSpy.mock.calls.at(-1)?.[0]));
    // `url=` is what made the post preview Etherscan's page rather than ours.
    expect(url.searchParams.get('url')).toBeNull();
  });

  it('stays inside the 280-character limit', async () => {
    openAndShare();
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(sharedText(openSpy).length).toBeLessThanOrEqual(280);
  });

  it('tells the poster the truth when the image could not be copied', async () => {
    openAndShare();
    const hint = await screen.findByTestId('receipt-share-hint');
    // html2canvas is mocked to throw, so the honest hint is the failure one —
    // never "paste the image" when nothing was put on the clipboard.
    expect(hint.textContent).toMatch(/could not copy/i);
    expect(hint.textContent).not.toMatch(/Receipt image copied/i);
  });
});
