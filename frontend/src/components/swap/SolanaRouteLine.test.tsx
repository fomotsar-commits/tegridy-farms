import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SolanaRouteLine } from './SolanaRouteLine';

// The line only shows the sentence it is given; every sentence is venueChoice.test.ts's.
// What it must not do is claim anything of its own, so it carries no other words.
describe('SolanaRouteLine', () => {
  it('says the sentence it is given, after its label, and nothing else', () => {
    render(<SolanaRouteLine text="Jupiter quotes 1% more than our pool, so Buy sends this trade to Jupiter." />);
    expect(screen.getByTestId('solana-route-line')).toHaveTextContent('RouteJupiter quotes 1% more than our pool, so Buy sends this trade to Jupiter.');
  });

  it('is marked when our pool takes the trade, and plain otherwise', () => {
    const { rerender } = render(<SolanaRouteLine text="x" good />);
    expect(screen.getByTestId('solana-route-line').getAttribute('style')).toContain('rgba(34, 197, 94, 0.08)');
    rerender(<SolanaRouteLine text="x" />);
    expect(screen.getByTestId('solana-route-line').getAttribute('style')).not.toContain('rgba(34, 197, 94');
  });
});
