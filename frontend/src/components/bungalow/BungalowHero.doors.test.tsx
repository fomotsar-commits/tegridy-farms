// Owner, 2026-10-14: "the bayla bungalow doesnt even show the marketplace and nft
// finance we should add them". The hero's button row carries both doors, in every room.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../../lib/bungalows';
import { BungalowHero } from './BungalowHero';

const bayla = BUNGALOWS.find((b) => b.id === 'bayla') as Parameters<typeof BungalowHero>[0]['bungalow'];

describe('the room hero shows the marketplace and NFT loans doors', () => {
  it('links Marketplace to /nakamigos and NFT loans to /nft-finance, beside Trade, Stake and Scan', () => {
    render(
      <MemoryRouter>
        <BungalowHero bungalow={bayla} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Marketplace' }).getAttribute('href')).toBe('/nakamigos');
    expect(screen.getByRole('link', { name: 'NFT loans' }).getAttribute('href')).toBe('/nft-finance');
    expect(screen.getByRole('link', { name: 'Stake BAYLA' }).getAttribute('href')).toBe('/earn/bayla');
    expect(screen.getByRole('link', { name: 'Scan BAYLA' })).toBeTruthy();
  });

  it('keeps the hero paragraph, word for word, one press away', () => {
    const { container } = render(
      <MemoryRouter>
        <BungalowHero bungalow={bayla} />
      </MemoryRouter>,
    );
    const details = container.querySelector('details');
    expect(details?.textContent).toContain(bayla.identity.heroCopy);
    expect(details?.hasAttribute('open')).toBe(false);
  });
});
