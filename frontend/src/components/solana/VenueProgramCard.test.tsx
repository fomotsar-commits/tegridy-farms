import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VenueProgramCard } from './VenueProgramCard';

// The heading is true of the program running on Solana today: it is Raydium's with our
// authority constants. It said "with one addition", an instruction that program does not
// have until its upgrade, and left the changed keys out.
describe('"The program" card', () => {
  it('heads with the keys the fork changed, not the instruction the running program does not have yet', () => {
    render(<VenueProgramCard />);
    const card = screen.getByRole('region', { name: 'The program' });
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(/^Raydium’s CPMM, with our keys$/);
    expect(card).not.toHaveTextContent(/one addition/);
    // The small print still names the whole difference, the added instruction included.
    expect(card).toHaveTextContent(/four authority constants, the program’s own name and contact text, comments and one added instruction/);
  });
});
