// The lines under every launch door (island answer 16): the exact words, in the exact
// order, and the Ethereum rails never carry the plant, which waits there (ruling 4).

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VenueLaunchLines } from './VenueLaunchLines';
import { PLANT_LINE, VENUE_LINE } from './venueLaunchCopy';

const EM_DASH = String.fromCharCode(0x2014);
const lines = () => Array.from(screen.getByTestId('venue-launch-lines').querySelectorAll('p')).map((p) => p.textContent);

describe('the lines under the launch door', () => {
  it('pins the words exactly, with 100,000 as a literal and no em dash', () => {
    expect(PLANT_LINE).toBe('A plant is 100,000 $BAYLA, half burned.');
    expect(VENUE_LINE).toBe('This is a venue launch.');
    for (const line of [PLANT_LINE, VENUE_LINE]) {
      expect(line).not.toContain(EM_DASH);
      expect(line).not.toMatch(/island coin|born in \$?BAYLA/i);
    }
  });

  it('Solana: the plant line, then the venue line, and nothing else', () => {
    render(<VenueLaunchLines rail="solana" />);
    expect(lines()).toEqual([PLANT_LINE, VENUE_LINE]);
  });

  it('Ethereum: only the venue line; the plant is not stated where it is not charged', () => {
    render(<VenueLaunchLines rail="ethereum" />);
    expect(lines()).toEqual([VENUE_LINE]);
    expect(screen.getByTestId('venue-launch-lines')).not.toHaveTextContent(/plant|BAYLA|100,000/);
  });
});
