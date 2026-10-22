// The island's dashboard (owner, 2026-10-21 and 2026-10-22): the connected wallet first, what it
// holds and its positions here, then every pool on the island one press away. It holds the rules
// /earn's index holds for that list (venueVoice.test.tsx), and the wallet's own: a part that could
// not be read says so, never a zero or "you hold nothing".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { WalletBoard } from '../hooks/useWalletBoard';
import type { HoldingRow, Leg, NamedLeg, PositionRow } from '../lib/wallet/walletRows';

const board = vi.hoisted(() => ({ value: null as unknown as WalletBoard }));
vi.mock('../hooks/useWalletBoard', () => ({ useWalletBoard: () => board.value }));
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: ({ children }: { children: (p: { openConnectModal: () => void; mounted: boolean }) => ReactNode }) => children({ openConnectModal: () => {}, mounted: true }) },
}));

import { IslandDashboard } from './IslandDashboard';
import { venuePoolRows } from '../lib/venuePools';
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../lib/constants';

const leg = <T,>(key: string, what: string, l: Leg<T>, retry = vi.fn()): NamedLeg<T> => ({ key, what, leg: l, retry });
const holding = (o: Partial<HoldingRow>): HoldingRow => ({ key: o.symbol ?? 'x', symbol: 'BAYLA', chain: 'solana', amount: '52,000', usd: 12.5, roomId: 'bayla', to: '/bayla', ...o });
const position = (o: Partial<PositionRow>): PositionRow => ({ key: o.title ?? 'p', roomId: 'bayla', chain: 'solana', title: 'BAYLA lock', facts: ['10,000 BAYLA', 'unlocks 15 Jan 2030', '4.00×', 'earned 1.23 BAYLA'], to: '/earn/bayla', ...o });

function wallet(o: Partial<WalletBoard>): WalletBoard {
  return { solanaAddress: null, evmAddress: null, holdings: [], positions: [], refresh: vi.fn(), ...o };
}

function mount(headingLevel?: 1 | 2) {
  return render(
    <MemoryRouter>
      <IslandDashboard headingLevel={headingLevel} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  board.value = wallet({});
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
      positions: [leg('p', 'your BAYLA locks', { status: 'ok', rows: [position({}), position({ title: 'BAYLA / SOL pool', facts: ['0.12% of the pool'], to: '/solana-lp' })] })],
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
