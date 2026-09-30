// The door with no wallet connected, on the Solana rail. The island measures a Solana-only
// wallet today, so the door says how a person is read whole, in the island's words.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));

vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: vi.fn(),
  isSupportedHeatAddress: () => false,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

const { LaunchGate } = await import('./LaunchGate');

function doorWords(rail: 'ethereum' | 'solana') {
  render(
    <MemoryRouter>
      <LaunchGate rail={rail} />
    </MemoryRouter>,
  );
  return screen.getByText(/Connect the Ethereum wallet that carries it/).closest('p')?.textContent?.replace(/\s+/g, ' ') ?? '';
}

describe('the door with no wallet, on the Solana rail', () => {
  it('says the island reads a person whole, in the island words, and keeps the Ethereum connect line', () => {
    const words = doorWords('solana');
    expect(words).toContain('Connect the Ethereum wallet that carries it, or read any address below.');
    expect(words).toContain(
      'One person, every wallet. Link Ethereum and Base, link Solana, and the island reads you whole.',
    );
    expect(words).not.toMatch(/cannot yet be measured|—/);
  });

  it('says it only on the Solana rail', () => {
    expect(doorWords('ethereum')).not.toContain('One person, every wallet.');
  });
});
