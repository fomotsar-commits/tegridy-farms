// The Open a pool form names the account deposits that never come back: a cost, so it is
// rounded up at the fourth decimal and never reads below what leaves the wallet.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LpBeforeYouOpen } from './LpDisclosures';

describe('Open a pool: the deposits that never come back', () => {
  it('0.040012345 SOL reads about 0.0401 SOL, where a cut read 0.04', () => {
    const { container } = render(<LpBeforeYouOpen fee={150_000_000n} neverRefunded={40_012_345n} />);
    expect(container.textContent).toContain('about 0.0401 SOL in account deposits that never come back');
  });

  it('an exact amount is unchanged', () => {
    const { container } = render(<LpBeforeYouOpen fee={150_000_000n} neverRefunded={40_000_000n} />);
    expect(container.textContent).toContain('about 0.04 SOL in account deposits that never come back');
  });
});
