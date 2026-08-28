import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ChainSwitch } from './ChainSwitch';
import { BUNGALOW_STORAGE_KEY } from '../../lib/bungalows';

/**
 * The control that admits the venue trades on two chains. What it must never
 * do is strand the visitor: whichever surface is showing, the OTHER one is one
 * click away, and the token they came for survives the round trip.
 */

function mount(active: 'ethereum' | 'solana', url = '/swap') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ChainSwitch active={active} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('ChainSwitch', () => {
  it('offers both chains and marks the one you are on', () => {
    mount('ethereum');
    const eth = screen.getByRole('link', { name: /Ethereum/ });
    const sol = screen.getByRole('link', { name: /Solana/ });
    expect(eth).toHaveAttribute('aria-current', 'page');
    expect(sol).not.toHaveAttribute('aria-current');
    expect(sol).toHaveAttribute('href', '/solana');
    expect(eth).toHaveAttribute('href', '/swap');
  });

  it('always points AWAY as well as at itself — neither surface is a dead end', () => {
    mount('solana', '/solana');
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveAttribute('aria-current', 'page');
    // The Ethereum half is what was missing before: /solana had no route back
    // to the venue's other swap except the "More" menu.
    expect(screen.getByRole('link', { name: /Ethereum/ })).toHaveAttribute('href', '/swap');
  });

  it('carries ?out= across the switch, so the token you came for survives', () => {
    const mint = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
    mount('solana', `/solana?out=${mint}`);
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveAttribute('href', `/solana?out=${mint}`);
  });

  it('names the active Solana bungalow\'s token instead of leaving the visitor to guess', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    mount('ethereum');
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveTextContent('BAYLA · Jupiter');
  });

  it('says only "Jupiter" when the active bungalow is not a Solana one', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    mount('ethereum');
    const sol = screen.getByRole('link', { name: /Solana/ });
    expect(sol).toHaveTextContent('Jupiter');
    expect(sol).not.toHaveTextContent('BAYLA');
  });
});
