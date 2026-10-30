// The island's dashboard (owner, 2026-10-21 and 2026-10-22): the connected wallet first, what it
// holds and its positions here, then every pool on the island one press away. It holds the rules
// /earn's index holds for that list (venueVoice.test.tsx), and the wallet's own: a part that could
// not be read says so, never a zero or "you hold nothing".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useOnStakesChanged } from '../lib/harvest/stakesChanged';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { WalletBoard } from '../hooks/useWalletBoard';
import type { HoldingRow, Leg, NamedLeg, PositionRow } from '../lib/wallet/walletRows';

const board = vi.hoisted(() => ({ value: null as unknown as WalletBoard }));
vi.mock('../hooks/useWalletBoard', () => ({ useWalletBoard: () => board.value }));
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: ({ children }: { children: (p: { openConnectModal: () => void; mounted: boolean }) => ReactNode }) => children({ openConnectModal: () => {}, mounted: true }) },
}));
// Harvest has its own tests (farm/HarvestCard.test.tsx) and needs the app's wagmi root: here, only where it sits.
vi.mock('./farm/HarvestCard', () => ({
  HarvestCard: (p: { quiet?: boolean; headingLevel?: number }) => <div data-testid="harvest" data-quiet={String(p.quiet)} data-level={String(p.headingLevel)} />,
}));

import { IslandDashboard } from './IslandDashboard';
import { venuePoolRows } from '../lib/venuePools';
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../lib/constants';
import { getSolanaSurfaceState, resetSolanaSurfaceForTests } from '../lib/solanaSurface';

const leg = <T,>(key: string, what: string, l: Leg<T>, retry = vi.fn()): NamedLeg<T> => ({ key, what, leg: l, retry });
const holding = (o: Partial<HoldingRow>): HoldingRow => ({ key: o.symbol ?? 'x', symbol: 'BAYLA', chain: 'solana', amount: '52,000', usd: 12.5, roomId: 'bayla', to: '/bayla', ...o });
const position = (o: Partial<PositionRow>): PositionRow => ({ key: o.title ?? 'p', roomId: 'bayla', chain: 'solana', title: 'BAYLA lock', facts: ['10,000 BAYLA', 'unlocks 15 Jan 2030', '4.00×', 'earned 1.23 BAYLA'], to: '/earn/bayla', ...o });

function wallet(o: Partial<WalletBoard>): WalletBoard {
  return { solanaAddress: null, evmAddress: null, holdings: [], positions: [], refresh: vi.fn(), ...o };
}

function mount(headingLevel?: 1 | 2, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <IslandDashboard headingLevel={headingLevel} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  board.value = wallet({});
  localStorage.clear();
  resetSolanaSurfaceForTests();
});

describe('IslandDashboard: the wallet', () => {
  it('asks a visitor with no wallet to connect one, on either chain', () => {
    mount();
    expect(screen.getByText(/Connect a wallet to see what it holds and your positions here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Solana wallet/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Ethereum wallet/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Holdings' })).toBeNull();
  });

  it('shows what the wallet holds and its positions, each a door to its room, and the total', () => {
    board.value = wallet({
      solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [holding({ symbol: 'SOL', roomId: null, to: null, amount: '1.5', usd: 300 }), holding({})] })],
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [position({})] })],
    });
    mount();
    const holdings = screen.getByRole('region', { name: 'Holdings' });
    expect(within(holdings).getByText('52,000')).toBeInTheDocument();
    expect(within(holdings).getByText('$12.50')).toBeInTheDocument();
    expect(within(holdings).getByRole('link', { name: /BAYLA: 52,000/ })).toHaveAttribute('href', '/bayla');
    const positions = screen.getByRole('region', { name: 'Positions' });
    const lock = within(positions).getByRole('link', { name: /BAYLA lock/ });
    expect(lock).toHaveAttribute('href', '/earn/bayla');
    expect(lock).toHaveTextContent('earned 1.23 BAYLA');
    // Every coin held was read and priced, so the total is printed.
    expect(screen.getByText('$312.50')).toBeInTheDocument();
    // The chain whose wallet is missing can still be connected.
    expect(screen.getByRole('button', { name: /Connect Ethereum wallet/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect Solana wallet/ })).toBeNull();
  });

  it('says which part could not be read, with Try again, and never reads it as holding nothing', () => {
    const retry = vi.fn();
    board.value = wallet({
      solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      holdings: [leg('h', 'your Solana coins', { status: 'unread', detail: '429' }, retry)],
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [] })],
    });
    mount();
    const holdings = screen.getByRole('region', { name: 'Holdings' });
    expect(holdings).toHaveTextContent('Couldn’t read your Solana coins just now');
    expect(holdings).not.toHaveTextContent(/No SOL, ETH or island coins/);
    fireEvent.click(within(holdings).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    // A total over an unread part is no total.
    expect(screen.queryByText('$0')).toBeNull();
    expect(screen.getByText('not every coin priced')).toBeInTheDocument();
  });

  it('prints no total while any coin held has no price read', () => {
    board.value = wallet({
      evmAddress: '0x1111111111111111111111111111111111111111',
      holdings: [leg('h', 'your Ethereum coins', { status: 'ok', rows: [holding({ usd: 10 }), holding({ symbol: 'PEPE', usd: null, roomId: 'pepe', to: '/pepe' })] })],
    });
    mount();
    // The priced coin's own row keeps its $10.00; the header prints no total that leaves PEPE out.
    expect(screen.getAllByText('$10.00')).toHaveLength(1);
    expect(screen.getByText('no price read')).toBeInTheDocument();
    expect(screen.getByText('not every coin priced')).toBeInTheDocument();
  });

  it('says it is reading while a part is in flight', () => {
    board.value = wallet({ solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', holdings: [leg('h', 'your Solana coins', { status: 'loading' })] });
    mount();
    expect(within(screen.getByRole('region', { name: 'Holdings' })).getByRole('status')).toHaveTextContent('Reading the chain');
  });

  it('draws a part from its last read at once, saying when that was and that it is updating', () => {
    board.value = wallet({
      solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      holdings: [{ ...leg('h', 'your Solana coins', { status: 'ok', rows: [holding({})] }), readAt: Date.now() - 3 * 3600_000 }],
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [position({})] })],
    });
    mount();
    expect(within(screen.getByRole('region', { name: 'Holdings' })).getByText('52,000')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('As of 3h ago · updating');
  });

  it('restores a Solana wallet connected here before as the dashboard opens, not after the page settles', () => {
    localStorage.setItem('tegridy-solana-restore', '1');
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    mount(1, '/dashboard');
    expect(getSolanaSurfaceState().ownWanted).toBe(true);
  });

  it('loads no Solana for a visitor who never connected it here, nor where the page restores its own', () => {
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    mount(1, '/dashboard');
    expect(getSolanaSurfaceState().ownWanted, 'a saved name alone (an "Open app" tap) restores nothing').toBe(false);
    localStorage.setItem('tegridy-solana-restore', '1');
    mount(2, '/');
    expect(getSolanaSurfaceState().ownWanted, 'the home: its cards restore their own connection').toBe(false);
  });

  it('says nothing of updating once every part is the new read', () => {
    board.value = wallet({
      solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [holding({})] })],
    });
    mount();
    expect(screen.queryByText(/updating/)).toBeNull();
  });

  it('says plainly when the wallet holds nothing, once that was read', () => {
    board.value = wallet({
      solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [] })],
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [] })],
    });
    mount();
    expect(screen.getByText('No SOL, ETH or island coins in this wallet.')).toBeInTheDocument();
    expect(screen.getByText(/No locks, stakes or pool shares here yet/)).toBeInTheDocument();
  });
});

describe('IslandDashboard: Harvest (owner, 2026-10-30: "should be a harvest all button on the dashboard too")', () => {
  it.each([1, 2] as const)('sits under the positions on the board, quiet, at heading level 3 (board heading h%i: /dashboard and the home)', (level) => {
    board.value = wallet({
      solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [position({})] })],
    });
    mount(level);
    const harvest = screen.getByTestId('harvest');
    expect(harvest.dataset.quiet).toBe('true');
    expect(harvest.dataset.level).toBe('3');
    const positions = screen.getByRole('region', { name: 'Positions' });
    expect(positions.compareDocumentPosition(harvest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not drawn for a visitor with no wallet', () => {
    mount();
    expect(screen.queryByTestId('harvest')).toBeNull();
  });

  it('Refresh reads the whole page again: the board, and Harvest with it', () => {
    const refresh = vi.fn();
    board.value = wallet({ solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', refresh });
    const page = {};
    const heard = vi.fn();
    const listener = renderHook(() => useOnStakesChanged(page, heard));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    listener.unmount();
  });
});

describe('IslandDashboard: what is drawn, from what was read', () => {
  const sol = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  it('draws the holdings by value, and each coin’s share on its row, once every coin is priced', () => {
    board.value = wallet({
      solanaAddress: sol,
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [holding({ symbol: 'SOL', roomId: null, to: null, amount: '1.5', usd: 300 }), holding({})] })],
    });
    mount();
    expect(screen.getByRole('img', { name: 'Holdings by value: SOL 96%, BAYLA 4%' })).toBeInTheDocument();
    const holdings = screen.getByRole('region', { name: 'Holdings' });
    expect(within(holdings).getByRole('link', { name: /BAYLA: 52,000/ })).toHaveTextContent('4%');
    // The total is printed once; the split says shares, not dollars.
    expect(screen.getAllByText('$312.50')).toHaveLength(1);
  });

  it('says which chain a coin is on when the same word is held on two (ETH on Ethereum and on Base)', () => {
    board.value = wallet({
      evmAddress: '0x1111111111111111111111111111111111111111',
      holdings: [
        leg('e', 'your Ethereum coins', { status: 'ok', rows: [holding({ key: 'ethereum:eth', symbol: 'ETH', chain: 'ethereum', roomId: null, to: null, amount: '0.1', usd: 300 })] }),
        leg('b', 'your Base coins', { status: 'ok', rows: [holding({ key: 'base:eth', symbol: 'ETH', chain: 'base', roomId: null, to: null, amount: '0.05', usd: 100 }), holding({ key: 'base:qr', symbol: 'QR', chain: 'base', roomId: 'qr', to: '/qr', usd: 100 })] }),
      ],
    });
    mount();
    expect(screen.getByRole('img', { name: 'Holdings by value: ETH on Ethereum 60%, ETH on Base 20%, QR 20%' })).toBeInTheDocument();
  });

  it('draws no split, and no share, while a coin has no price or a part is unread', () => {
    board.value = wallet({
      evmAddress: '0x1111111111111111111111111111111111111111',
      holdings: [leg('h', 'your Ethereum coins', { status: 'ok', rows: [holding({ usd: 10 }), holding({ symbol: 'PEPE', usd: null, roomId: 'pepe', to: '/pepe' })] })],
    });
    const { unmount } = mount();
    expect(screen.queryByTestId('holdings-split')).toBeNull();
    expect(screen.getByRole('region', { name: 'Holdings' })).not.toHaveTextContent('%');
    unmount();
    board.value = wallet({
      solanaAddress: sol,
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [holding({ usd: 10 })] }), leg('e', 'your Ethereum coins', { status: 'unread', detail: '429' })],
    });
    mount();
    expect(screen.queryByTestId('holdings-split')).toBeNull();
  });

  it('marks a lock’s place on the ladder from the share its pool reported, and nothing for a lock without one', () => {
    board.value = wallet({
      solanaAddress: sol,
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [position({}), position({ title: 'BAYLA / SOL pool', facts: ['0.12% of the pool'], to: '/pools' })] })],
    });
    mount();
    expect(screen.getByRole('img', { name: `4.00× on the ladder, from ${(MIN_BOOST_BPS / 10_000).toFixed(2)}× to ${(MAX_BOOST_BPS / 10_000).toFixed(2)}×` })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /on the ladder/ })).toHaveLength(1);
  });

  it('numbers the rows it draws, as the pool index does', () => {
    board.value = wallet({
      solanaAddress: sol,
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [holding({ symbol: 'SOL', roomId: null, to: null, amount: '1.5', usd: 300 }), holding({})] })],
    });
    mount();
    const items = within(screen.getByRole('region', { name: 'Holdings' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('01');
    expect(items[1]).toHaveTextContent('02');
  });
});

// The big frame on a phone and an iPad (owner, 2026-10-24: "the mobile and ipad versions to have
// the dashboard too"). jsdom lays nothing out, so the screen is drawn here: the frame pinned under
// the top bar (top 56, bottom 244) above rows 80px tall from `rowsTop` down, as on a phone; or,
// with `beside`, the frame in a column of its own to the right of the rows, as on an iPad.
describe('IslandDashboard: the frame on a phone and an iPad', () => {
  const sol = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  let touch = true;
  let short = false;
  let beside = false;
  let rowsTop = 600;
  let frames: FrameRequestCallback[] = [];
  const realRect = Element.prototype.getBoundingClientRect;

  const rect = (top: number, height: number, left = 0, width = 390) =>
    ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  beforeEach(() => {
    touch = true;
    short = false;
    beside = false;
    rowsTop = 600;
    frames = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({
        matches: (q.includes('pointer: coarse') && touch) || (q.includes('max-height') && short),
        media: q, addEventListener() {}, removeEventListener() {},
      }),
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    // A long page, so the frame's end-of-page rule stays out of the way unless a test asks for it.
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 100_000 });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if ((this as HTMLElement).dataset?.testid === 'dashboard-figure') return beside ? rect(80, 339, 600, 224) : rect(56, 188);
      const key = (this as HTMLElement).dataset?.figKey;
      if (!key) return rect(0, 0, 0, 0);
      const rows = Array.from(document.querySelectorAll('[data-fig-key]')).filter((el) => !el.closest('details:not([open])'));
      return rect(rowsTop + rows.indexOf(this) * 80, 80, 0, beside ? 560 : 390);
    };
    return () => {
      Element.prototype.getBoundingClientRect = realRect;
      Reflect.deleteProperty(window, 'matchMedia');
      Reflect.deleteProperty(document.documentElement, 'scrollHeight');
      vi.unstubAllGlobals();
      vi.useRealTimers();
    };
  });

  const flush = () => act(() => { while (frames.length) frames.shift()!(0); });
  // A scroll, then the rest that lets the picture settle (it waits 150ms; the lit row does not).
  const scrollTo = (top: number, rest = true) => {
    rowsTop = top;
    act(() => { window.dispatchEvent(new Event('scroll')); });
    flush();
    if (rest) act(() => { vi.advanceTimersByTime(200); });
  };
  const figure = () => screen.getByTestId('dashboard-figure');
  const lit = () => Array.from(document.querySelectorAll('[data-current]')).map((el) => el.getAttribute('data-fig-key'));

  function wallet3() {
    board.value = wallet({
      solanaAddress: sol,
      holdings: [leg('h', 'your Solana coins', { status: 'ok', rows: [holding({ key: 'sol', symbol: 'SOL', roomId: null, to: null, amount: '1.5', usd: 300 }), holding({ key: 'bayla' })] })],
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [position({ key: 'lock' })] })],
    });
  }

  it('with a wallet, draws the frame first in the board, pinned, so a phone can hold it above the rows', () => {
    wallet3();
    mount();
    const fig = figure();
    expect(fig.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(fig.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(fig.style.position).toBe('');
    const holdings = screen.getByRole('region', { name: 'Holdings' });
    expect(fig.compareDocumentPosition(holdings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A box with hidden overflow is a scroll box of its own, and nothing inside it can pin to the screen.
    expect(fig.closest('section')!.className).toContain('supports-[overflow:clip]:overflow-clip');
    // The frame pins inside a slot that owns its grid area: pinned straight in the grid, it rode on
    // over the pool list below its row.
    expect(fig.parentElement!.className).toContain('[grid-area:fig]');
    expect(fig.className).not.toContain('grid-area');
  });

  it('without a wallet, follows the connect buttons and is not pinned over them below 1024px', () => {
    mount();
    const fig = figure();
    expect(fig.className).not.toMatch(/(^|\s)sticky(\s|$)/);
    expect(fig.className).toContain('lg:sticky');
    const connect = screen.getByRole('button', { name: /Connect Solana wallet/ });
    expect(connect.compareDocumentPosition(fig) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And with nothing of the wallet's to follow, a scroll lights nothing.
    scrollTo(100);
    expect(lit()).toEqual([]);
  });

  it('pins nothing on a screen 500px tall or less, a phone held sideways', () => {
    short = true;
    wallet3();
    mount();
    expect(figure().style.position).toBe('static');
  });

  it('follows the scroll on a phone: the first row you can read whole under the frame is shown, and it lights', () => {
    wallet3();
    mount();
    scrollTo(600);
    // Nothing has reached the frame yet: the wallet's first row with a room, and no row lit.
    expect(figure()).toHaveTextContent('fig. 01.02');
    expect(figure()).toHaveTextContent('BAYLA · Solana');
    expect(lit()).toEqual([]);

    scrollTo(245); // SOL at the line, all of it in view: its chain's mark, drawn, on the dark plate.
    expect(figure()).toHaveTextContent('fig. 01.01');
    expect(figure()).toHaveTextContent('SOL · Solana');
    const plate = screen.getByTestId('chain-plate');
    expect(plate.querySelector('svg')).not.toBeNull();
    expect(plate.textContent).toBe('');
    expect(lit()).toEqual(['h:sol']);

    scrollTo(230); // SOL's top has slid under the frame: the next row takes over.
    expect(figure()).toHaveTextContent('BAYLA · Solana');
    expect(lit()).toEqual(['h:bayla']);

    scrollTo(100);
    expect(figure()).toHaveTextContent('fig. 02.01');
    expect(figure()).toHaveTextContent('BAYLA lock · Solana');
    expect(lit()).toEqual(['p:lock']);
    expect(screen.getByTestId('figure-progress').style.transform).toBe('scaleX(1)');
  });

  it('lights the row at once, and turns the picture only once the scroll rests', () => {
    wallet3();
    mount();
    scrollTo(600);
    scrollTo(245, false);
    expect(lit()).toEqual(['h:sol']);
    expect(figure()).toHaveTextContent('BAYLA · Solana'); // the picture has not turned yet
    act(() => { vi.advanceTimersByTime(100); });
    expect(figure()).toHaveTextContent('BAYLA · Solana');
    act(() => { vi.advanceTimersByTime(100); });
    expect(figure()).toHaveTextContent('SOL · Solana');
  });

  it('follows the scroll beside the frame (an iPad): the row at 45% down the screen is shown', () => {
    beside = true;
    wallet3();
    mount();
    scrollTo(240); // Rows at 240, 320, 400; the line at 45% of 768 is 346: BAYLA spans it.
    expect(lit()).toEqual(['h:bayla']);
    expect(figure()).toHaveTextContent('BAYLA · Solana');
  });

  it('shows the last row at the bottom of the page, where the rows can no longer reach the line', () => {
    wallet3();
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: window.innerHeight });
    mount();
    scrollTo(600);
    expect(lit()).toEqual(['p:lock']);
  });

  it('leaves the rows of a closed pool list out, and follows them once it is opened', () => {
    wallet3();
    mount();
    scrollTo(-110);
    expect(lit()).toEqual(['p:lock']);
    // Opening the list is read at once, before any scroll: the third pool is the first you can read.
    const details = screen.getByRole('list', { name: 'Pools on the island' }).closest('details')!;
    details.open = true;
    act(() => { details.dispatchEvent(new Event('toggle')); });
    flush();
    act(() => { vi.advanceTimersByTime(200); });
    const third = venuePoolRows()[2]!;
    expect(lit()).toEqual([`pool:${third.id}`]);
    expect(figure()).toHaveTextContent(third.name);
  });

  it('gives the frame to a row a finger taps or the keyboard reaches, until the next scroll', () => {
    wallet3();
    mount();
    scrollTo(230);
    expect(lit()).toEqual(['h:bayla']);
    act(() => { vi.advanceTimersByTime(400); }); // the scroll is over
    act(() => { document.querySelector<HTMLElement>('[data-fig-key="p:lock"]')!.focus(); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(lit()).toEqual([]);
    expect(figure()).toHaveTextContent('BAYLA lock · Solana');
    scrollTo(245);
    expect(lit()).toEqual(['h:sol']);
    expect(figure()).toHaveTextContent('SOL · Solana');
  });

  it('keeps the frame on the scroll when a row slides under a resting pointer during it', () => {
    wallet3();
    mount();
    scrollTo(230);
    fireEvent.mouseEnter(document.querySelector('[data-fig-key="p:lock"]')!);
    act(() => { vi.advanceTimersByTime(200); });
    expect(lit()).toEqual(['h:bayla']);
    expect(figure()).toHaveTextContent('BAYLA · Solana');
  });

  it('with a mouse, follows the pointer and not the scroll, at any width, and lights nothing', () => {
    touch = false;
    wallet3();
    mount();
    scrollTo(100);
    expect(figure()).toHaveTextContent('BAYLA · Solana');
    expect(lit()).toEqual([]);
    expect(screen.queryByTestId('figure-progress')).toBeNull();
    // Pointing at SOL, which has no room, shows its chain rather than nothing.
    fireEvent.mouseEnter(document.querySelector('[data-fig-key="h:sol"]')!);
    expect(figure()).toHaveTextContent('SOL · Solana');
  });
});

describe('IslandDashboard: every pool on the island', () => {
  it('lists every pool, each opening its own room', () => {
    mount();
    const rows = venuePoolRows();
    expect(rows.length, 'precondition: the island has several pools').toBeGreaterThan(3);
    const list = screen.getByRole('list', { name: 'Pools on the island' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(rows.map((r) => `Open ${r.symbol}`));
    for (const r of rows) {
      expect(within(list).getByRole('link', { name: `Open ${r.symbol}` })).toHaveAttribute('href', `/earn/${r.id}`);
    }
    expect(links.filter((l) => l.getAttribute('aria-label') === 'Open TOWELI')).toHaveLength(1);
  });

  it('is one press away, and its summary counts the pools and chains from the same list', () => {
    mount();
    const rows = venuePoolRows();
    const chains = new Set(rows.map((r) => r.chain).filter((c) => c !== 'tbd')).size;
    const details = screen.getByRole('list', { name: 'Pools on the island' }).closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('summary')).toHaveTextContent(`All ${rows.length} pools on the island · ${chains} chains`);
  });

  it('publishes no rate, and states the ladder at its real floor and ceiling', () => {
    mount();
    const list = screen.getByRole('list', { name: 'Pools on the island' });
    expect(list.textContent).not.toMatch(/%/);
    expect(list.textContent).toContain(`${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`);
    expect(list.textContent).toContain(`${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`);
    expect(list.textContent).not.toContain('1.00×');
    expect(screen.getByText(/No rate is shown here because none is read here/)).toBeInTheDocument();
  });

  it('is the page heading on /dashboard and a section heading on the home', () => {
    const { unmount } = mount(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dashboard');
    unmount();
    mount();
    expect(screen.getByRole('heading', { level: 2, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('routes to the venue\'s own liquidity', () => {
    mount();
    expect(screen.getByRole('link', { name: /provide liquidity on venue pools/i })).toHaveAttribute('href', '/liquidity');
  });
});
