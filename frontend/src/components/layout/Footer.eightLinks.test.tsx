// The footer is eight links on one screen (the island's venue review, item 1; owner 2026-10-03).
// The drawer carries what the footer used to (navReach.test.tsx proves nothing is stranded), and
// the collective's signature keeps its two music links (IslandSound.test.tsx). The one-screen
// height is measured in a browser: e2e/nav-five-words.spec.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Footer } from './Footer';

const EIGHT = ['FAQ', 'Security', 'Risks', 'Terms', 'Privacy', 'For your AI', 'Twitter / X', 'Discord'];

function footerAt(path: string) {
  const { container } = render(
    <MemoryRouter initialEntries={[path]}>
      <Footer />
    </MemoryRouter>,
  );
  return container.querySelector('footer')!;
}

/** A link's visible name, with the new-tab arrow dropped. */
const name = (a: Element) => (a.textContent ?? '').replace('↗', '').trim();

afterEach(() => {
  localStorage.clear();
});

describe('the footer', () => {
  it.each(['/', '/swap', '/earn', '/launch', '/trust'])('lists eight links on %s, in this order', (path) => {
    const list = within(footerAt(path)).getByRole('navigation', { name: 'Footer' });
    expect(within(list).getAllByRole('link').map(name)).toEqual(EIGHT);
  });

  it('has no other link on a venue route but the collective’s two music links', () => {
    const footer = footerAt('/swap');
    const outside = within(footer)
      .getAllByRole('link')
      .filter((a) => !a.closest('nav'))
      .map(name);
    expect(outside).toEqual(['spotify', 'youtube']);
  });

  it('opens each page link where it says, and the AI file as a plain link', () => {
    const list = within(footerAt('/')).getByRole('navigation', { name: 'Footer' });
    const href = (n: string) => within(list).getByRole('link', { name: new RegExp(`^${n}`) }).getAttribute('href');
    expect(href('FAQ')).toBe('/faq');
    expect(href('Security')).toBe('/security');
    expect(href('Risks')).toBe('/risks');
    expect(href('Terms')).toBe('/terms');
    expect(href('Privacy')).toBe('/privacy');
    expect(href('For your AI')).toBe('/llms.txt');
  });

  it("carries no room button and no column headings: the bar's Island word opens the hall", () => {
    const footer = footerAt('/');
    expect(within(footer).queryByRole('button', { name: /Bungalows/ })).toBeNull();
    for (const heading of ['Product', 'Resources', 'Community', 'Legal', 'Trust & Safety']) {
      expect(within(footer).queryByRole('heading', { name: heading }), heading).toBeNull();
    }
  });

  // The public line agreed with Jungle Bay Island on 2026-10-18, word for word, typed out here
  // rather than read from VENUE, on every kind of page: the venue's, a room's and the farm's.
  it.each(['/', '/swap', '/bayla', '/toweli'])('carries the agreed public line, verbatim, in the bottom bar on %s', (path) => {
    const footer = footerAt(path);
    const line = within(footer).getByText(
      "memetics.finance is the island's venue: built and run by greencifer, its take shared across the island after the venue's costs, every month, read on chain.",
    );
    expect(line.tagName).toBe('P');
    expect(line.closest('nav')).toBeNull();
    // Added beside the bar's lines, never in place of one.
    expect(footer).toHaveTextContent('Experimental protocol. Use at your own risk. Not financial advice.');
    expect(footer).toHaveTextContent('© 2026 memetics.finance · built by the jungle bay artists collective');
  });

  it('keeps the farm’s market links in its own room, beside its contract card', () => {
    const footer = footerAt('/toweli');
    for (const market of ['Trade on Uniswap', 'Etherscan', 'GeckoTerminal']) {
      expect(within(footer).getByRole('link', { name: new RegExp(market) })).toBeInTheDocument();
    }
    const list = within(footer).getByRole('navigation', { name: 'Footer' });
    expect(within(list).getAllByRole('link').map(name), 'the room adds to the eight, never into them').toEqual(EIGHT);
  });
});
