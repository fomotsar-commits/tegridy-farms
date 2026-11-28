import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BaylaLiberation, LIBERATION_ROOM } from './BaylaLiberation';
import { BUNGALOWS, bungalowLpDoor } from '../../lib/bungalows';
import { VENUE_TVL_URL, flipPercent, flipShare, isLiberated, parseBaylaFlip } from '../../lib/venueTvl';

const bayla = BUNGALOWS.find((b) => b.id === LIBERATION_ROOM)!;
// The answer as the server sends it, with only the fields this card reads.
const answer = (over: Record<string, unknown> = {}) => ({ state: 'current', usd: 1, readAt: '2026-11-26T20:00:00.000Z', baylaFlip: { ours: 20_442_463, pump: 63_746_791 }, ...over });

function serve(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const mount = () =>
  render(
    <MemoryRouter>
      <BaylaLiberation bungalow={bayla} />
    </MemoryRouter>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseBaylaFlip', () => {
  it('reads the two counts from a read answer, current or partial', () => {
    expect(parseBaylaFlip(answer())).toEqual({ ours: 20_442_463, pump: 63_746_791 });
    expect(parseBaylaFlip(answer({ state: 'partial' }))).toEqual({ ours: 20_442_463, pump: 63_746_791 });
  });

  it('reads anything it cannot trust as no reading, never as an empty side', () => {
    expect(parseBaylaFlip(answer({ baylaFlip: undefined }))).toBeNull();
    expect(parseBaylaFlip(answer({ state: 'unread' }))).toBeNull();
    expect(parseBaylaFlip(answer({ baylaFlip: { ours: 5, pump: 0 } }))).toBeNull();
    expect(parseBaylaFlip(answer({ baylaFlip: { ours: -1, pump: 9 } }))).toBeNull();
    expect(parseBaylaFlip(answer({ baylaFlip: { ours: '5', pump: 9 } }))).toBeNull();
    expect(parseBaylaFlip(null)).toBeNull();
  });
});

describe('flipPercent and flipShare', () => {
  it('rounds down, so the bar never says more than is there', () => {
    expect(flipPercent({ ours: 20_442_463, pump: 63_746_791 })).toBe('32%');
    expect(flipPercent({ ours: 9_999, pump: 10_000 })).toBe('99%');
    expect(flipPercent({ ours: 1, pump: 10_000 })).toBe('under 1%');
    expect(flipPercent({ ours: 0, pump: 10_000 })).toBe('0%');
  });

  it('is full only once ours holds MORE, and stays full past it', () => {
    expect(flipPercent({ ours: 10_001, pump: 10_000 })).toBe('100%');
    expect(flipShare({ ours: 10_001, pump: 10_000 })).toBe(1);
    expect(flipShare({ ours: 30_000, pump: 10_000 })).toBe(1);
    expect(flipShare({ ours: 2_500, pump: 10_000 })).toBe(0.25);
  });

  it('calls a tie 99%, never the flip', () => {
    expect(isLiberated({ ours: 10_000, pump: 10_000 })).toBe(false);
    expect(flipPercent({ ours: 10_000, pump: 10_000 })).toBe('99%');
    expect(flipShare({ ours: 10_000, pump: 10_000 })).toBe(0.99);
  });
});

describe('BaylaLiberation', () => {
  it("fills the bar with our BAYLA against pump.fun's, from the venue's own count", async () => {
    const fetchMock = serve(answer());
    mount();
    expect(await screen.findByTestId('bayla-liberation-figure')).toHaveTextContent('32%');
    expect(fetchMock).toHaveBeenCalledWith(VENUE_TVL_URL, expect.anything());
    const bar = screen.getByRole('progressbar', { name: 'BAYLA liberation' });
    expect(bar).toHaveAttribute('aria-valuenow', '32');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${(20_442_463 / 63_746_791) * 100}%`);
    expect(screen.getByTestId('bayla-liberation-line')).toHaveTextContent("20.44M BAYLA in our BAYLA/SOL pools · 63.74M in pump.fun's");
  });

  it('says Liberated, with a full bar, once our pools hold more', async () => {
    serve(answer({ baylaFlip: { ours: 64_000_000, pump: 63_746_791 } }));
    mount();
    expect(await screen.findByTestId('bayla-liberation-figure')).toHaveTextContent('Liberated');
    const bar = screen.getByRole('progressbar', { name: 'BAYLA liberation' });
    expect(bar).toHaveAttribute('aria-valuetext', 'Liberated');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
    expect(screen.queryByText('of the way')).toBeNull();
  });

  it('shows a tie as 99% of the way, with the bar short of full', async () => {
    serve(answer({ baylaFlip: { ours: 63_746_791, pump: 63_746_791 } }));
    mount();
    expect(await screen.findByTestId('bayla-liberation-figure')).toHaveTextContent('99%');
    const bar = screen.getByRole('progressbar', { name: 'BAYLA liberation' });
    expect(bar).toHaveAttribute('aria-valuenow', '99');
    expect(bar).toHaveAttribute('aria-valuetext', '99% of the way');
  });

  it('says its count is from when the page opened, not that it stays a minute fresh', () => {
    serve(answer());
    mount();
    expect(screen.getByText(/Read from Solana when this page opened\./)).toBeInTheDocument();
    expect(screen.queryByText(/at most a minute old/)).toBeNull();
  });

  it('shows no bar at all when the count could not be read: an outage, never an empty bar', async () => {
    serve({ state: 'unread' }, 502);
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('The pools could not be read. An outage, not a zero.');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it("shows no bar for an answer from before the bar was counted (an edge copy just after a deploy)", async () => {
    serve(answer({ baylaFlip: undefined }));
    mount();
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it("points at her SOL pool's Add form, the move that fills it", () => {
    serve(answer());
    mount();
    const door = bungalowLpDoor(bayla)!;
    expect(screen.getByTestId('bayla-liberation-add')).toHaveAttribute('href', door.to);
    expect(screen.getByTestId('bayla-liberation-add')).toHaveTextContent('Add SOL + BAYLA');
  });
});
