// "Buy all bungalows" as it is drawn (owner, 2026-10-22: the button "deserves a lot of
// attention", "avant-garde, cutting edge"): a ticket stub on the swap card, a numbered order
// sheet behind it. IslandBasketSolana.test.tsx and IslandBasketEvm.test.tsx hold what each chain
// quotes, decides and sends; this file holds only what both chains draw.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { BasketCta, IslandBasketButton, IslandBasketDialog, type BasketRow } from './IslandBasket';

const SOLANA = ['BAYLA', 'BOBO', 'SOY', 'BRAINLET', 'RIZZ'];

describe('IslandBasketButton: the ticket stub', () => {
  it('is numbered with the count and runs every coin of the order on its tape', () => {
    const onOpen = vi.fn();
    render(<IslandBasketButton count={5} symbols={SOLANA} onOpen={onOpen} />);
    const stub = screen.getByTestId('island-basket-open');
    expect(stub).toHaveAccessibleName('Island order: Buy all bungalows, 5 coins');
    expect(stub).toHaveTextContent('05');
    expect(stub).toHaveTextContent('Buy all bungalows');
    for (const s of SOLANA) expect(stub).toHaveTextContent(s);
    // The tape is the same run twice, so the loop has no seam (index.css editorial-tape).
    expect(stub.querySelector('.editorial-tape')?.children).toHaveLength(2);
    fireEvent.click(stub);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('IslandBasketDialog: the order sheet', () => {
  const rows: BasketRow[] = [
    { key: 'bayla', room: 'bayla', symbol: 'BAYLA', venue: 'PumpSwap via Jupiter', pays: '≈ 1.2M', status: { tone: 'ok', text: 'Bought' } },
    { key: 'bobo', room: 'bobo', symbol: 'BOBO', venue: 'PumpSwap via Jupiter', pays: '≈ 3.4M', status: { tone: 'busy', text: 'At your wallet' } },
    { key: 'rizz', room: 'rizz', symbol: 'RIZZ', venue: null, pays: null },
  ];
  const mount = (o: { rows?: BasketRow[]; locked?: boolean } = {}) =>
    renderWithProviders(
      <IslandBasketDialog
        open onClose={() => {}} closable chainName="Solana" usd="25" setUsd={() => {}} locked={o.locked ?? false}
        summary="3 coins · $8.33 each" rows={o.rows ?? rows} feeLine="Site fee: 0.50% of each coin bought through Jupiter goes to the venue."
        cta={<BasketCta label="Buy all 3" disabled={false} onClick={() => {}} />}
        finePrint={<p>How.</p>}
      />,
    );

  it('numbers every coin, shows its room’s door, and keeps where it is bought and what it pays beside it', () => {
    mount();
    const list = screen.getByRole('list', { name: 'Coins in this order' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('01');
    expect(items[2]).toHaveTextContent('03');
    expect(items[0]!.querySelector('img'), 'BAYLA’s door picture').not.toBeNull();
    expect(within(items[0]!).getByText(/· PumpSwap via Jupiter$/)).toBeInTheDocument();
    expect(within(items[0]!).getByText('≈ 1.2M')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Bought')).toBeInTheDocument();
    // A coin not yet quoted says so with an ellipsis, never a figure.
    expect(within(items[2]!).getByText(/· …$/)).toBeInTheDocument();
    expect(screen.getByTestId('island-basket-fee')).toHaveTextContent(/goes to the venue/);
    expect(screen.getByLabelText('Dollars to spend')).toHaveValue('25');
  });

  it('counts the order’s progress from the rows’ own statuses, once a coin has moved', () => {
    mount();
    expect(screen.getByTestId('island-basket-progress')).toHaveTextContent('1 of 3 bought');
  });

  it('draws no progress before anything was sent, even with a note on a row', () => {
    mount({ rows: [{ key: 'bayla', room: 'bayla', symbol: 'BAYLA', venue: 'PumpSwap via Jupiter', pays: '≈ 1.2M', status: { tone: 'muted', text: 'Our pools not read' } }] });
    expect(screen.queryByTestId('island-basket-progress')).toBeNull();
  });

  it('is the island’s sheet: hard corners, the heading face on its title, and the Buy button leads', () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Buy all bungalows' });
    expect(dialog.className).toContain('rounded-none');
    expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 3');
  });
});
