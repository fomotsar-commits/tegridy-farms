import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ChainSwitch } from './ChainSwitch';
import { BUNGALOW_STORAGE_KEY } from '../../lib/bungalows';

/**
 * The control that admits the venue trades on two chains. What it must never
 * do is strand the visitor: whichever surface is showing, the OTHER one is one
 * click away, and the token they came for survives the round trip.
 *
 * ...and what it must never do is LIE about which surface is showing, which is
 * why the URL is the only argument these tests give it. There is no `active`
 * prop any more: /pools passed `active="solana"` while sitting on /pools, and a
 * prop that a caller states is a prop a caller can state wrongly.
 */

function mount(url = '/swap') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ChainSwitch />
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
    mount('/swap');
    const eth = screen.getByRole('link', { name: /Ethereum/ });
    const sol = screen.getByRole('link', { name: /Solana/ });
    expect(eth).toHaveAttribute('aria-current', 'page');
    expect(sol).not.toHaveAttribute('aria-current');
    expect(sol).toHaveAttribute('href', '/solana');
    expect(eth).toHaveAttribute('href', '/swap');
  });

  it('always points AWAY as well as at itself — neither surface is a dead end', () => {
    mount('/solana');
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveAttribute('aria-current', 'page');
    // The Ethereum half is what was missing before: /solana had no route back
    // to the venue's other swap except the "More" menu.
    expect(screen.getByRole('link', { name: /Ethereum/ })).toHaveAttribute('href', '/swap');
  });

  it('claims no page at all on a route that is neither swap surface', () => {
    // /pools is the venue's own Solana AMM — a LIQUIDITY page, not the Jupiter
    // swap. It rendered this control with `active="solana"`, which put
    // aria-current="page" on a link to a page the visitor was not on: the strip
    // above said "Venue AMM" and the control underneath said "Solana", and a
    // screen reader was told the second one. Both halves stay — they are still
    // the two places you can go — but neither is the page you are on.
    mount('/pools');
    expect(screen.getByRole('link', { name: /Ethereum/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /Solana/ })).not.toHaveAttribute('aria-current');
    // ...and it is still a way OUT of here, on both chains — that is the whole
    // reason the control is on this page at all.
    expect(screen.getByRole('link', { name: /Ethereum/ })).toHaveAttribute('href', '/swap');
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveAttribute('href', '/solana');
  });

  it('matches on a segment boundary, so a look-alike route lights nothing', () => {
    // Mirrors SectionHost.matchesRoute: `startsWith` alone would light Solana on
    // /solana-anything. Pinned as the PROPERTY, not as today's route list.
    const first = mount('/solana-labs');
    expect(screen.getByRole('link', { name: /Solana/ })).not.toHaveAttribute('aria-current');
    first.unmount();
    mount('/swapmeet');
    expect(screen.getByRole('link', { name: /Ethereum/ })).not.toHaveAttribute('aria-current');
  });

  it('keeps ?out= on the Solana half, and never hands a Solana mint to Ethereum', () => {
    const mint = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
    mount(`/solana?out=${mint}`);
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveAttribute('href', `/solana?out=${mint}`);
    // ⚠️ AND THE ETHEREUM HALF DROPS IT, WHICH IS THE HONEST BEHAVIOUR AND NOT
    // WHAT THIS COMPONENT USED TO CLAIM. `?out=` is a Solana MINT; /swap trades
    // ERC-20s and would be handed an address it cannot resolve. So the "token
    // you came for survives the round trip" story was only ever true of the
    // Solana SELF-link above — nothing in the app ever produces /swap?out=, so
    // once you hop to Ethereum the mint is gone and hopping back cannot restore
    // it. Pinned so the claim is not re-asserted from the comment alone.
    expect(screen.getByRole('link', { name: /Ethereum/ })).toHaveAttribute('href', '/swap');
  });

  it('names the active Solana bungalow\'s token instead of leaving the visitor to guess', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    mount('/swap');
    expect(screen.getByRole('link', { name: /Solana/ })).toHaveTextContent('BAYLA · Jupiter');
  });

  it('says only "Jupiter" when the active bungalow is not a Solana one', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    mount('/swap');
    const sol = screen.getByRole('link', { name: /Solana/ });
    expect(sol).toHaveTextContent('Jupiter');
    expect(sol).not.toHaveTextContent('BAYLA');
  });
});
