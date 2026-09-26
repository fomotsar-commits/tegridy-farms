// Every room's farm speaks without a prose em dash, hero first. textContent, so a dash
// alone in its own text node counts here, where the e2e walk files it as the unread
// placeholder. The live pool cards are stubbed: their copy is theirs to answer for.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS, type Bungalow } from '../../lib/bungalows';

vi.mock('./LighthousePoolLive', () => ({ LighthousePoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./SolanaLadderPoolLive', () => ({ SolanaLadderPoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./EvmLadderPoolLive', () => ({ EvmLadderPoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./EvmLighthousePoolLive', () => ({ EvmLighthousePoolLive: () => <div data-testid="pool-card" /> }));
vi.mock('./SolanaPoolStack', () => ({ SolanaPoolStack: () => <div data-testid="pool-card" /> }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));

const { BungalowFarmPanel } = await import('./BungalowFarmPanel');

const EM_DASH = '—';
const ROOMS = BUNGALOWS.filter((b) => b.live && b.id !== 'toweli');

async function farm(bungalow: Bungalow) {
  const view = render(
    <MemoryRouter>
      <BungalowFarmPanel bungalow={bungalow} />
    </MemoryRouter>,
  );
  const hero = screen.getByRole('heading', { level: 1 }).nextElementSibling!;
  return { ...view, hero };
}

describe("a room's farm carries no prose em dash", () => {
  it('judges every live room but TOWELI, whose farm is its own', () => {
    expect(ROOMS.map((b) => b.id).sort()).toEqual(
      ['bayla', 'bnkr', 'bobo', 'brainlet', 'drb', 'jbm', 'mfer', 'pepe', 'qr', 'rizz', 'soy'],
    );
  });

  for (const b of ROOMS) {
    it(`${b.id}: the hero, then the whole panel`, async () => {
      const { container, hero, unmount } = await farm(b);
      expect(hero.textContent).toContain('The lighthouse pool is live for');
      expect(hero.textContent).not.toContain(EM_DASH);
      await screen.findAllByTestId('pool-card');
      expect(container.textContent).not.toContain(EM_DASH);
      unmount();
    });
  }

  it('says the same with no pool yet', async () => {
    const bare = { ...ROOMS.find((b) => b.id === 'bayla')!, stakePool: undefined, ladderPool: undefined } as Bungalow;
    const { container, hero } = await farm(bare);
    expect(hero.textContent).toContain('The lighthouse pool is being built for');
    expect(container.textContent).toContain('Not deployed yet');
    expect(container.textContent).not.toContain(EM_DASH);
  });

  // Production sets the ladder, which a test build does not, so BAYLA's closed pool goes members-only.
  it('says the same for BAYLA as production serves it, the ladder named', async () => {
    const bayla = { ...ROOMS.find((b) => b.id === 'bayla')!, ladderPool: 'LADDER' } as Bungalow;
    const { container, hero } = await farm(bayla);
    expect(hero.textContent).toContain('The lock ladder is live for BAYLA on Solana, created on-chain');
    await screen.findAllByTestId('pool-card');
    expect(container.textContent).not.toContain(EM_DASH);
  });
});
