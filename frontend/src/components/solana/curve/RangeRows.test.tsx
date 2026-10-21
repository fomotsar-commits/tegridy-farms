import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../../lib/launcher/solana/write/plant';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { RangeRows } from './RangeRows';
import type { RangeSummary } from './ports';

/** A range position's review says the fee, the venue's cut and where that cut goes, from the pool's tier. */

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const STRANGER = key(77).toBase58();

function opening(owners: { owner: string; fundOwner: string }): RangeSummary {
  return {
    kind: 'range-open',
    nftMint: key(1),
    max: { token: 5_000_000n, quote: 1_000_000n },
    quoted: { token: 5_000_000n, quote: 990_000n },
    rentLamports: 7_000_000n,
    unwrapsWsol: true,
    notices: [],
    poolLine: {
      pool: key(2), tokenMint: key(3), tokenDecimals: 6, quote: SOL_QUOTE, tokenIsToken0: true,
      tradeFeeRate: 10_000, venueShareRate: 160_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, ...owners,
    },
    range: { tickLower: 0, tickUpper: 1200, minPrice: 0.0002, maxPrice: 0.0005, holds: 'both' },
  };
}

describe('the range review’s fee lines', () => {
  it('the agreed split is said plainly', () => {
    render(<RangeRows summary={opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() })} />);
    expect(screen.getByText(/it keeps 16% of each swap’s fee \(0\.16% of the swap\)/)).toBeInTheDocument();
    expect(screen.getByText(/The venue’s cut is split: 10\.4% of each fee \(0\.104% of the swap\) to the team’s shared wallet/)).toBeInTheDocument();
    expect(document.querySelector('strong')).toBeNull();
  });

  it('any other wallet is said in bold, with its address', () => {
    render(<RangeRows summary={opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: STRANGER })} />);
    expect(document.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split/);
    expect(document.body.textContent).toContain(STRANGER);
  });

  it('the vault collecting the island’s part is said in bold too, with what each wallet gets', () => {
    render(<RangeRows summary={opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: PLATFORM_TREASURY_VAULT.toBase58() })} />);
    expect(document.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split .* 16% of each fee \(0\.16% of the swap\) to the team’s shared wallet, 0% of each fee \(0% of the swap\) to the island’s Workshop\./);
  });
});
