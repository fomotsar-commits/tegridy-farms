import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VenueProgramCard } from './VenueProgramCard';

// The heading is true of the program on Solana and of the source: Raydium's with our
// authority constants. It once said "with one addition" and left the changed keys out; the
// fork now adds an instruction and a check, and the small print names both.
describe('"The program" card', () => {
  it('heads with the keys the fork changed, and names each addition in the small print', () => {
    render(<VenueProgramCard />);
    const card = screen.getByRole('region', { name: 'The program' });
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(/^Raydium’s CPMM, with our keys$/);
    expect(card).not.toHaveTextContent(/one addition/);
    // The small print names the whole difference: the added instruction and the added check.
    expect(card).toHaveTextContent(/four authority constants, the program’s own name and contact text, comments, one added instruction and one added check/);
  });
});
