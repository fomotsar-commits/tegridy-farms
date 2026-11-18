import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUNGALOWS } from '../lib/bungalows';
import type { PoolRead } from '../lib/city/plan';
import type { CityReads } from '../hooks/useCityReads';

// The page under test is its words and its list. The drawing is lib/city/scene.ts, proven in
// scene.test.ts; jsdom has no canvas to draw on, so the canvas stands in as an empty one.
const reads = vi.hoisted(() => ({ current: null as CityReads | null }));
vi.mock('../hooks/useCityReads', async (actual) => ({
  ...(await actual<typeof import('../hooks/useCityReads')>()),
  useCityReads: () => reads.current!,
}));
vi.mock('../components/city/CityCanvas', () => ({ CityCanvas: () => <canvas aria-hidden="true" data-testid="city-canvas" /> }));

import CityPage from './CityPage';
import { cityRooms } from '../hooks/useCityReads';

const rooms = cityRooms();
const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
const base = (over: Partial<CityReads> = {}): CityReads => ({ rooms, pools: new Map<string, PoolRead>(), poolsReadAt: null, wallet: 'none', pay: { rooms: [], unread: 0 }, ...over });
const mount = (r: CityReads) => {
  reads.current = r;
  return render(<MemoryRouter><CityPage /></MemoryRouter>);
};
const card = () => within(screen.getByTestId('city-card'));
const wallet = () => within(screen.getByTestId('city-wallet'));

// jsdom lays nothing out, so it has no scrollIntoView: the page calls the browser's.
const intoView = vi.fn();
beforeEach(() => {
  reads.current = null;
  intoView.mockClear();
  Element.prototype.scrollIntoView = intoView;
});

describe('/city', () => {
  it('opens on one heading, one line and the drawing, which screen readers skip', () => {
    mount(base());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('City.');
    expect(screen.getByTestId('city-canvas').getAttribute('aria-hidden')).toBe('true');
  });

  it('never says Tegridy: it is a venue page, and the venue has no coin', () => {
    const { container } = mount(base({ wallet: 'read', pay: { rooms: ['bayla'], unread: 2 } }));
    expect(container.textContent).not.toMatch(/tegridy/i);
  });

  it('lists every plot as a button, so a keyboard reaches what a press on the drawing does', () => {
    mount(base());
    const list = within(screen.getByRole('navigation', { name: 'Every plot' }));
    const names = list.getAllByRole('button').map((b) => b.textContent);
    expect(names).toHaveLength(20);
    for (const r of rooms) expect(names).toContain(r.symbol);
  });

  it("shows a room with its ticker, its chain, its coin's whole address and its own door", () => {
    mount(base());
    expect(card().getByRole('heading').textContent).toBe(bayla.name);
    expect(card().getByText(bayla.symbol)).toBeTruthy();
    expect(card().getByText(bayla.address!)).toBeTruthy();
    expect(card().getByRole('link').getAttribute('href')).toBe('/bayla');
  });

  it('says a pool was not read rather than showing it empty, and gives its dollars only with where and when they were read', () => {
    mount(base());
    expect(card().getByText('Pool not read.')).toBeTruthy();
    document.body.innerHTML = '';
    mount(base({ pools: new Map<string, PoolRead>([['bayla', { state: 'still' }]]), poolsReadAt: 1_800_000_000 }));
    expect(card().getByText('Pool read, with no dollar figure.')).toBeTruthy();
    document.body.innerHTML = '';
    mount(base({ pools: new Map<string, PoolRead>([['bayla', { state: 'level', usd: 520_000 }]]), poolsReadAt: 1_800_000_000 }));
    expect(card().getByText(/^\$520,000 in its market pool, GeckoTerminal at \d\d:\d\d\.$/)).toBeTruthy();
  });

  it('shows the plot a visitor picks from the list', () => {
    mount(base());
    const list = within(screen.getByRole('navigation', { name: 'Every plot' }));
    const other = rooms.find((r) => r.id !== 'bayla')!;
    fireEvent.click(list.getByRole('button', { name: other.symbol }));
    expect(card().getByRole('heading').textContent).toBe(other.name);
    expect(list.getByRole('button', { name: other.symbol }).getAttribute('aria-pressed')).toBe('true');
    // the drawing is brought back into view: on a phone the list sits a screen below it
    expect(intoView).toHaveBeenCalledTimes(1);
    fireEvent.click(list.getByRole('button', { name: 'TREASURY' }));
    expect(card().getByRole('heading').textContent).toBe('Treasury');
    // the venue's treasury is not TOWELI's treasury page: no door is offered
    expect(card().queryByRole('link')).toBeNull();
  });

  it('asks for a wallet before it says anything about pay', () => {
    mount(base());
    expect(wallet().getByText(/^Connect a wallet at the top\./)).toBeTruthy();
    expect(wallet().queryByRole('link')).toBeNull();
  });

  it('says it is reading while a wallet is read, and claims nothing yet', () => {
    mount(base({ wallet: 'reading' }));
    expect(wallet().getByText('Reading your pools.')).toBeTruthy();
    expect(wallet().queryByText(/No staking pay/)).toBeNull();
  });

  it('names each pool holding pay for the wallet, and sends the claim to Earn', () => {
    mount(base({ wallet: 'read', pay: { rooms: ['bayla'], unread: 0 } }));
    const pools = within(wallet().getByRole('list', { name: 'Pools holding pay for you' }));
    expect(pools.getAllByRole('button').map((b) => b.textContent)).toEqual([bayla.symbol]);
    expect(wallet().getByRole('link', { name: 'Claim on Earn' }).getAttribute('href')).toBe('/earn');
  });

  it('says so when no pay is waiting', () => {
    mount(base({ wallet: 'read' }));
    expect(wallet().getByText('No staking pay is waiting for this wallet.')).toBeTruthy();
  });

  it('never says no pay is waiting while a pool is unread', () => {
    mount(base({ wallet: 'read', pay: { rooms: [], unread: 1 } }));
    expect(wallet().getByText('One pool was not read.')).toBeTruthy();
    expect(wallet().queryByText(/No staking pay/)).toBeNull();
    document.body.innerHTML = '';
    mount(base({ wallet: 'read', pay: { rooms: ['bayla'], unread: 3 } }));
    expect(wallet().getByText('3 pools were not read.')).toBeTruthy();
  });

  it('lets a visitor stop the motion', () => {
    mount(base());
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pause);
    expect(pause.getAttribute('aria-pressed')).toBe('true');
  });
});
