// ONE wallet context for the ladder card and the closed pool's claim strip. With two,
// a member who connects through the ladder never appears in the strip until a reload,
// and the strip hides itself while disconnected, so from their side the claim is gone.
// The strip sits UNDER the ladder in DOM order: no CSS `order`.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

vi.mock('../solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="solana-providers">{children}</div>
  ),
}));
vi.mock('./SolanaLadderPoolLive', () => ({
  SolanaLadderPoolCard: () => <div data-testid="ladder-card" />,
}));
vi.mock('./LighthousePoolLive', () => ({
  LighthouseClaimStrip: () => <div data-testid="claim-strip" />,
}));

const { SolanaPoolStack } = await import('./SolanaPoolStack');

const BAYLA = {
  id: 'bayla', name: 'BAYLA', symbol: 'BAYLA', chain: 'solana', status: 'LIVE',
  tagline: 'Test.', address: 'BaylaMint1111111111111111111111111111111111',
  stakePool: 'EFWpStreamflow111111111111111111111111111111',
  ladderPool: 'LadderPool11111111111111111111111111111111111',
  depositsClosed: true,
} as unknown as Bungalow & { ladderPool: string; stakePool: string };

describe('SolanaPoolStack', () => {
  it('mounts ONE wallet context around both the ladder and the claim strip', () => {
    render(<SolanaPoolStack bungalow={BAYLA} />);
    const providers = screen.getAllByTestId('solana-providers');
    expect(providers).toHaveLength(1);
    expect(providers[0]!.contains(screen.getByTestId('ladder-card'))).toBe(true);
    expect(providers[0]!.contains(screen.getByTestId('claim-strip'))).toBe(true);
  });

  it('stacks the strip BELOW the ladder, in one column, with nothing reordered by CSS', () => {
    render(<SolanaPoolStack bungalow={BAYLA} />);
    const ladder = screen.getByTestId('ladder-card');
    const strip = screen.getByTestId('claim-strip');
    expect(ladder.parentElement).toBe(strip.parentElement);
    expect(ladder.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ladder.parentElement!.className).toMatch(/flex-col/);
    expect(ladder.parentElement!.outerHTML).not.toMatch(/\border-/);
  });
});
