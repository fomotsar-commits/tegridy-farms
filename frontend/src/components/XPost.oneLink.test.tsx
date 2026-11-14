// ONE LINK A POST (island answer thirty-five).
//
// X draws one card under a post: the card of the FIRST link in it. And X links a bare domain
// by itself, so "memetics.finance" inside a sentence is a link of its own. The add's post said
// "Just added liquidity to $BAYLA on memetics.finance." ahead of its share link, so every
// posted add drew the front page's card and never the add's own (seen on four posted adds,
// 2026-11-10 and 11-11). X's web composer hides this: it previews the LAST link's card.
//
// Pinned here, for every post the venue writes whose link carries a card of its own (the
// add's, the heat card's, the clock line's): the post holds exactly one thing X would link,
// it is that link, and it comes last. A new post with a card of its own belongs in this file.
//
// The farm's receipt (TransactionReceipt.tsx) is not here on purpose: it opens with the venue's
// name and ends on an explorer link, which has no card of the venue's to lose.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RECEIPT_WORDS } from '../lib/arrival';
import { SITE_URL } from '../lib/constants';
import { parseHeatReading, type HeatReading } from '../lib/heat/heatOracle';

const h = vi.hoisted(() => ({
  fetchHeat: vi.fn(),
  peekHeat: vi.fn(),
  fetchFlames: vi.fn(),
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
// Only the reads are stubbed: every other export of the heat client stays the real one.
vi.mock('../lib/heat/heatClient', async (orig) => ({
  ...(await orig<typeof import('../lib/heat/heatClient')>()),
  fetchHeat: (...a: unknown[]) => h.fetchHeat(...a),
  peekHeat: (...a: unknown[]) => h.peekHeat(...a),
  isSupportedHeatAddress: () => true,
}));
vi.mock('../lib/heat/flamesClient', async (orig) => ({
  ...(await orig<typeof import('../lib/heat/flamesClient')>()),
  fetchFlames: (...a: unknown[]) => h.fetchFlames(...a),
}));
vi.mock('../hooks/useIslandTorches', () => ({ useIslandTorches: () => ({ warming: 28 }) }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const { HeatCard } = await import('./HeatCard');
const { ClockLine } = await import('./ClockLine');
const { setLastBuy } = await import('../lib/heat/lastBuy');

/**
 * What X turns into a link in a post: anything with a scheme, and a bare domain (a letter or a
 * number, a dot, two letters or more), the reading TransactionReceipt.tsx's LINKABLE has of it.
 * Wider than X's own list of endings on purpose: a post that passes here passes there.
 */
const LINKS = /(?:https?:\/\/)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?:\/\S*)?/gu;
const linksIn = (text: string) => text.match(LINKS) ?? [];
/** The post X's composer opens with. */
function posted(intent: string | null): string {
  const u = new URL(intent ?? '');
  expect(`${u.origin}${u.pathname}`).toBe('https://x.com/intent/post');
  return u.searchParams.get('text') ?? '';
}
function expectOneLink(text: string, link: string) {
  expect(linksIn(text)).toEqual([link]);
  expect(text.endsWith(` ${link}`)).toBe(true);
}

const NOW = 1_788_700_000;
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  h.fetchFlames.mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the reading of a link', () => {
  it('finds a bare domain inside a sentence, and the share link, and nothing else', () => {
    expect(linksIn("Just added liquidity to $BAYLA on memetics.finance. I'm part of the floor now.")).toEqual(['memetics.finance']);
    expect(linksIn('MEMETICS.FINANCE')).toEqual(['MEMETICS.FINANCE']);
    expect(linksIn(`Held time counts here. ${SITE_URL}/lp/bayla`)).toEqual([`${SITE_URL}/lp/bayla`]);
    expect(linksIn("1862.4° on Jungle Bay Island's instrument. Elder. 1694 days held. 0.05 SOL. I'm part of $WIF's floor now.")).toEqual([]);
  });
});

describe('the add’s post: one link, the add’s own', () => {
  it.each([
    ['a room’s coin', 'BAYLA', 'bayla'],
    ['a coin with no room', 'WIF', WIF],
    ['a ticker that carries its own $', '$WIF', WIF],
    ['the longest ticker the venue prints, a copy’s', `fake ${'W'.repeat(12)}`, WIF],
  ])('%s', (_name, coin, target) => {
    expectOneLink(posted(RECEIPT_WORDS.lpIntent(coin, target)), `${SITE_URL}/lp/${target}`);
  });

  it('names the coin and no site: the link and its card name the site', () => {
    expect(RECEIPT_WORDS.lpPost('BAYLA')).toBe("Just added liquidity to $BAYLA. I'm part of the floor now. Every trade in the pool pays me.");
    expect(linksIn(RECEIPT_WORDS.lpPost('BAYLA'))).toEqual([]);
  });
});

describe('the heat card’s post: one link, the reader’s own card', () => {
  const ADDR = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';
  const AS_OF = NOW - 3600;
  const reading = (over: Record<string, unknown> = {}) =>
    parseHeatReading({
      address: ADDR,
      degrees: 1785.14,
      tier: 'Elder',
      is_cold: false,
      held_since_unix: AS_OF - 1694 * 86_400,
      as_of_unix: AS_OF,
      token_count: 18,
      breakdown: [],
      observedAt: AS_OF,
      ...over,
    });
  const room = { token_address: BAYLA, chain: 'solana', name: 'BAYLA', symbol: 'BAYLA', heat_degrees: 412.5, first_seen_at_unix: AS_OF - 400 * 86_400, last_transfer_at_unix: null };

  it.each([
    ['an Elder with no room read', reading()],
    ['an Elder with a room', reading({ breakdown: [room] })],
    ['a reading under Observer', reading({ degrees: 12.5, tier: 'Drifter' })],
  ])('%s', async (_name, served) => {
    h.fetchHeat.mockResolvedValue(served);
    const { container } = render(
      <MemoryRouter>
        <HeatCard address={ADDR} variant="embedded" countdown={false} />
      </MemoryRouter>,
    );
    await screen.findAllByText(/°/);
    const posts = Array.from(container.querySelectorAll('a[href^="https://x.com/intent/post"]'));
    expect(posts.length).toBeGreaterThan(0);
    for (const a of posts) expectOneLink(posted(a.getAttribute('href')), `${SITE_URL}/read/${ADDR}`);
  });
});

describe('the clock line’s post: one link, the buyer’s own card', () => {
  const BUYER = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
  const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
  const buy = { hash: '0xabc', symbol: 'PEPE', tokenAddress: PEPE, chain: 'ethereum' as const, buyer: BUYER, atUnix: 1786104000 };
  const held = {
    address: BUYER, degrees: 12, tier: 'Ember', isCold: false, heldSinceUnix: 1739235449, asOfUnix: 1786104024, tokenCount: 1, observedAt: 1786104024, xHandle: null,
    breakdown: [{ tokenAddress: PEPE, chain: 'ethereum', name: 'PEPE', symbol: 'PEPE', degrees: 12, firstSeenAtUnix: 1739235449, lastTransferAtUnix: 1786102091, retired: false }],
  } as unknown as HeatReading;

  it.each([
    ['no reading: "is running"', null],
    ['a reading that holds the coin: "keeps running"', held],
  ])('%s', (_name, served) => {
    setLastBuy(buy);
    h.peekHeat.mockReturnValue(served);
    render(<ClockLine />);
    const door = screen.getByRole('link', { name: 'Post' });
    expectOneLink(posted(door.getAttribute('href')), `${SITE_URL}/read/${BUYER}`);
  });
});
