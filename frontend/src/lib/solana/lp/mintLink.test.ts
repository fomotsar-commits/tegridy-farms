import { describe, it, expect } from 'vitest';
import { withMint } from './mintLink';

const M = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const q = (s: string) => new URLSearchParams(s);

describe('withMint: a link between the Solana LP tabs keeps the token being looked at', () => {
  it('carries a ?mint= that has the shape of an address', () => {
    expect(withMint('/solana-lp', q(`mint=${M}`))).toBe(`/solana-lp?mint=${M}`);
    expect(withMint('/pools', q(`mint=%20${M}%20`))).toBe(`/pools?mint=${M}`);
  });

  it('carries nothing else from the URL', () => {
    expect(withMint('/pools', q(`mint=${M}&amount=5&side=add&slippage=50`))).toBe(`/pools?mint=${M}`);
    expect(withMint('/pools', q('amount=5'))).toBe('/pools');
  });

  it('drops a ?mint= that is not shaped like an address, so nothing typed into a URL is echoed', () => {
    for (const bad of ['', 'abc', 'not a mint<b>', `${M}&x=1`, `${M}0`, '../pools', 'javascript:alert(1)']) {
      expect(withMint('/solana-lp', q(`mint=${encodeURIComponent(bad)}`))).toBe('/solana-lp');
    }
    expect(withMint('/solana-lp', q(''))).toBe('/solana-lp');
  });
});
