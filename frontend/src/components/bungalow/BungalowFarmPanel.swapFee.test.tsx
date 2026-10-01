// The funding card's "Venue swap fees" line on every room's farm names that room's chain and
// no other, and says what that chain's swap does. Solana's follows its fee account. An EVM
// chain's follows the registry (`ammSwap`) and SwapFeeRouter, whose fee goes to stakers, POL
// and treasury, never to a room's pool. Each room is read with the Solana fee off and on.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID, type Bungalow } from '../../lib/bungalows';
import { SWAP_FEE_BPS } from '../../lib/constants';
import { getChainConfig } from '../../lib/chains/registry';

const solanaFee = vi.hoisted(() => ({ on: false }));
vi.mock('../../lib/solana', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/solana')>()),
  isSolanaFeeConfigured: () => solanaFee.on,
}));
vi.mock('./LighthousePoolLive', () => ({ LighthousePoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./SolanaLadderPoolLive', () => ({ SolanaLadderPoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./EvmLadderPoolLive', () => ({ EvmLadderPoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./EvmLighthousePoolLive', () => ({ EvmLighthousePoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./SolanaPoolStack', () => ({ SolanaPoolStack: () => <div data-testid="pool-card" /> }));
vi.mock('./HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

// TOWELI's farm is the classic one (FarmPage), so this card never shows there.
const ROOMS = BUNGALOWS.filter((b) => b.live && b.id !== DEFAULT_BUNGALOW_ID);
const EVM = ROOMS.filter((b) => b.chain !== 'solana');
const CHAIN_WORD: Record<string, string> = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base' };
const EVM_CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453 };
const swapServed = (b: Bungalow) => getChainConfig(EVM_CHAIN_ID[b.chain])!.capabilities.ammSwap;

// What the line claims, read as meaning rather than as one exact wording.
const SAYS_SWAP_RUNS = /swap surface (is live|takes|captures)/i;
const SAYS_NO_FEE = /\bno (platform |swap )?fee\b|\btakes no\b/i;
const SAYS_SHARE_REACHES_POOL = /can route here/i;

function swapFeeLine(b: Bungalow, feeOn: boolean): string {
  solanaFee.on = feeOn;
  const view = render(<MemoryRouter><BungalowFarmPanel bungalow={b} /></MemoryRouter>);
  const line = screen.getByText('Venue swap fees').closest('li')!.textContent ?? '';
  view.unmount();
  return line;
}

describe("the funding card's swap-fee line is true for the room it sits in", () => {
  it('judges the six EVM rooms, on a chain the venue swap serves and on one it does not', () => {
    expect(EVM.map((b) => b.id).sort()).toEqual(['bnkr', 'drb', 'jbm', 'mfer', 'pepe', 'qr']);
    expect(new Set(EVM.map(swapServed))).toEqual(new Set([true, false]));
    expect(ROOMS.some((b) => b.chain === 'solana')).toBe(true);
  });

  for (const b of ROOMS) {
    it(`${b.id} (${b.chain}): names its own chain, and that chain's swap fee as it is`, () => {
      for (const feeOn of [false, true]) {
        const line = swapFeeLine(b, feeOn);
        const named = Object.values(CHAIN_WORD).filter((w) => line.includes(w));
        expect(named, line).toEqual([CHAIN_WORD[b.chain]]);

        if (b.chain === 'solana') {
          expect(line).toMatch(SAYS_SWAP_RUNS);
          expect(SAYS_NO_FEE.test(line), line).toBe(!feeOn);
          expect(SAYS_SHARE_REACHES_POOL.test(line), line).toBe(feeOn);
          continue;
        }
        // Solana's fee account says nothing about an EVM chain's swap.
        expect(line).toBe(swapFeeLine(b, !feeOn));
        expect(line).not.toMatch(SAYS_SHARE_REACHES_POOL);
        if (swapServed(b)) {
          // SwapFeeRouter takes SWAP_FEE_BPS on a venue-pool fill, so "no fee" would be false.
          expect(SWAP_FEE_BPS).toBeGreaterThan(0);
          expect(line).toMatch(SAYS_SWAP_RUNS);
          expect(line).not.toMatch(SAYS_NO_FEE);
        } else {
          expect(line).not.toMatch(SAYS_SWAP_RUNS);
          expect(line).toMatch(SAYS_NO_FEE);
        }
      }
    });
  }
});
