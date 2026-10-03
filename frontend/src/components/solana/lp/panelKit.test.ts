// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { tokenText } from '../../../lib/solana/lp/format';
import { solAbout, tokensAbout, unitsExact } from './panelKit';

describe('the "about" amounts on the liquidity panels', () => {
  it('never say a real amount is 0, on the token side as on the SOL side', () => {
    // 5,000 base units of an 8-decimal token (0.00005) pairs with real SOL in a pool of
    // a token priced in hundreds of SOL. The rows used to read "0.03 SOL and 0 tokens".
    for (const raw of [1n, 5_000n, 9_999n, 10_000n, 123_456_789n]) {
      expect(tokensAbout(raw, 8), `${raw}`).toMatch(/[1-9]/);
      expect(tokenText(raw, 8), `${raw}`).toMatch(/[1-9]/);
      // At SOL's own decimals the two halves of a row are the same figure.
      expect(tokensAbout(raw, 9).replace(' tokens', '')).toBe(solAbout(raw).replace(' SOL', ''));
    }
    expect(tokensAbout(0n, 8)).toBe('0 tokens');
  });

  it('leaves an exact amount exact', () => {
    expect(unitsExact(5_000n, 8)).toBe('0.00005');
    expect(unitsExact(1n, 8)).toBe('0.00000001');
  });
});
