import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VenueProgramCard } from './VenueProgramCard';

// The heading is true of the program on Solana and of the source: Raydium's with our
// authority constants. It once said "with one addition" and left the changed keys out; the
// fork now adds an instruction, a check, fee limits and a swap guard, and the small print
// names each.
describe('"The program" card', () => {
  it('heads with the keys the fork changed, and names each addition in the small print', () => {
    render(<VenueProgramCard />);
    const card = screen.getByRole('region', { name: 'The program' });
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(/^Raydium’s CPMM, with our keys$/);
    expect(card).not.toHaveTextContent(/one addition/);
    // The small print names the whole difference: the added instruction, the added check, the
    // fee limits and the swap guard.
    expect(card).toHaveTextContent(/four authority constants, the program’s own name and contact text, comments, one added instruction, one added check, fee limits and a swap guard\./);
    // What the guard does, who it refuses, and that this site's own swaps are not among them.
    expect(card).toHaveTextContent(/While it is on, a pool there takes a swap only when a wallet sends it directly\. A swap that another program makes is refused/);
    expect(card).toHaveTextContent(/Swaps from this site are sent directly\. Adding and removing liquidity are not guarded\./);
    // No longer "outside three": the reviewed list of differing files is longer than that.
    expect(card).not.toHaveTextContent(/outside three/);
  });
});
