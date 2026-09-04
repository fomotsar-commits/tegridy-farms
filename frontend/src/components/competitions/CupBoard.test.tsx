// The rendered cup, pinned structurally.
//
// GeckoTerminal is reachable from the e2e a11y sweep, so at run time /competitions
// draws either the live board or the coverage notice depending on what the feed
// answers in that second. Both states have to satisfy the same markup rules, and
// a live sweep cannot guarantee it visits both — these renders are the
// deterministic half of that guarantee.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { CupBoard } from './CupBoard';
import { CupCoverageNotice } from './CupCoverageNotice';
import { YourRank } from './YourRank';
import {
  buildCupBoard,
  cupBoardStatus,
  tradeRowsFromTrades,
  type CupPool,
  type PoolOutcome,
} from '../../lib/competitions/islandCup';
import type { PoolTrade } from '../../lib/geckoTerminal/poolTrades';

const T0 = 1_780_000_000;
const iso = (at: number) => new Date(at * 1000).toISOString();

const ethPool: CupPool = {
  id: 'pepe',
  name: 'Pepe',
  symbol: 'PEPE',
  network: 'eth',
  pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  label: 'PEPE / WETH',
  chain: 'ethereum',
};

const solPool: CupPool = {
  id: 'bobo',
  name: 'BOBO',
  symbol: 'BOBO',
  network: 'solana',
  pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
  label: 'BOBO / SOL',
  chain: 'solana',
};

function trade(over: Partial<PoolTrade> = {}): PoolTrade {
  return {
    at: iso(T0),
    kind: 'buy',
    txHash: '0xtx1',
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tokenAmount: 1,
    usd: 1234.5,
    fromTokenAddress: null,
    toTokenAddress: null,
    fromTokenAmount: null,
    toTokenAmount: null,
    blockNumber: null,
    ...over,
  };
}

function ok(pool: CupPool, trades: PoolTrade[]): { pool: CupPool; outcome: PoolOutcome } {
  const { rows, returned, dropped } = tradeRowsFromTrades(pool, trades);
  return { pool, outcome: { ok: true, rows, returned, dropped } };
}

function failed(pool: CupPool): { pool: CupPool; outcome: PoolOutcome } {
  return {
    pool,
    outcome: {
      ok: false,
      reason: 'rate-limited',
      detail: 'The trades feed is rate-limiting right now. Give it a moment and try again.',
    },
  };
}

const completeBoard = buildCupBoard([
  ok(ethPool, [trade(), trade({ txHash: '0xtx2', wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', usd: 10 })]),
  ok(solPool, []),
]);
const partialBoard = buildCupBoard([ok(ethPool, [trade()]), failed(solPool)]);
const deadBoard = buildCupBoard([failed(ethPool), failed(solPool)]);

const PROFIT_WORDS = /PnL|P&L|Profit|ROI|Return|Gain/i;

function renderComplete() {
  return render(
    <>
      <CupCoverageNotice
        status="complete"
        coverage={completeBoard.coverage}
        poolsTotal={2}
        onReload={() => undefined}
      />
      <CupBoard board={completeBoard} status="complete" account={null} />
      <YourRank board={completeBoard} status="complete" account={null} />
    </>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the complete board', () => {
  it('draws exactly one table, with a caption and scoped headers', () => {
    renderComplete();
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table.querySelector('caption')?.textContent ?? '').toMatch(/ranked by/i);
    const headers = [...table.querySelectorAll('th')];
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
  });

  it('shows no column or cell a reader could take for a profit', () => {
    renderComplete();
    const table = screen.getByRole('table');
    for (const cell of table.querySelectorAll('th, td')) {
      expect(cell.textContent ?? '', `cell reads as a return: ${cell.textContent}`).not.toMatch(
        PROFIT_WORDS,
      );
    }
  });

  it('numbers ranks from 1, never from 0', () => {
    renderComplete();
    const firstCell = screen.getByRole('table').querySelector('tbody tr td');
    expect(firstCell?.textContent).toBe('1');
  });

  it('prints the last fill as the fill’s own UTC time, which the clock cannot move', () => {
    // A relative "3m ago" would keep ageing after the data stopped, on a page
    // whose entire claim is "this is the window the feed served".
    const { unmount } = renderComplete();
    const before = screen.getByRole('table').querySelectorAll('tbody tr td')[6]?.textContent;
    expect(before).toMatch(/UTC$/);
    unmount();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    renderComplete();
    const after = screen.getByRole('table').querySelectorAll('tbody tr td')[6]?.textContent;
    expect(after).toBe(before);
  });

  it('states what a rank is and is not, above the table', () => {
    renderComplete();
    expect(screen.getByText(/not a ranking of all trading in these tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/pays nothing/i)).toBeInTheDocument();
  });

  it('labels the find-sender input and keeps every button at a 44px target', () => {
    renderComplete();
    const input = screen.getByLabelText(/wallet or sender address/i);
    expect(input).toHaveAttribute('id', 'competition-find-wallet');
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.className).toContain('min-h-[44px]');
  });

  it('says a wallet it cannot find has not been shown to be idle', () => {
    render(<YourRank board={completeBoard} status="complete" account="0xcccccccccccccccccccccccccccccccccccccccc" />);
    expect(screen.getByText(/not a statement that it was idle/i)).toBeInTheDocument();
  });

  it('carries the wash limits and the absence of an archive next to the numbers', () => {
    renderComplete();
    expect(screen.getByText(/two-wallet collusion is not detectable/i)).toBeInTheDocument();
    expect(screen.getByText(/yesterday is not kept anywhere/i)).toBeInTheDocument();
  });
});

describe('the partial board', () => {
  it('still draws one table, and names the pool that did not answer', () => {
    render(
      <>
        <CupCoverageNotice
          status="partial"
          coverage={partialBoard.coverage}
          poolsTotal={2}
          onReload={() => undefined}
        />
        <CupBoard board={partialBoard} status="partial" account={null} />
      </>,
    );
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByText(/totals are floors and the order is provisional/i)).toBeInTheDocument();
    const chips = screen.getByRole('list', { name: /what each pool answered/i });
    expect(within(chips).getByText(/BOBO \/ SOL: not read/i)).toBeInTheDocument();
    expect(within(chips).getByText(/PEPE \/ WETH: 1 fill/i)).toBeInTheDocument();
  });

  it('offers the share sentence with its caveats attached', () => {
    render(<YourRank board={partialBoard} status="partial" account="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />);
    expect(screen.getByText(/#1 of 1 wallets \(1 of 2 pools answered, provisional\)/i)).toBeInTheDocument();
  });
});

describe('the unavailable state', () => {
  it('draws no table at all, and calls the silence an outage', () => {
    // An empty leaderboard under a season name asserts that nobody entered.
    expect(cupBoardStatus(deadBoard)).toBe('unavailable');
    render(
      <CupCoverageNotice
        status="unavailable"
        coverage={deadBoard.coverage}
        poolsTotal={2}
        onReload={() => undefined}
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/outage of the trade feed, not a quiet day/i)).toBeInTheDocument();
  });

  it('keeps a single named reason chip per pool', () => {
    render(
      <CupCoverageNotice
        status="unavailable"
        coverage={deadBoard.coverage}
        poolsTotal={2}
        onReload={() => undefined}
      />,
    );
    const chips = screen.getByRole('list', { name: /what each pool answered/i });
    expect(within(chips).getAllByText(/not read — rate-limited/i)).toHaveLength(2);
  });
});

describe('an empty board that was read in full', () => {
  it('says it measured these pools rather than implying an empty market', () => {
    const emptyBoard = buildCupBoard([ok(ethPool, []), ok(solPool, [])]);
    render(<CupBoard board={emptyBoard} status="complete" account={null} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.getByText(/not a statement about trading elsewhere/i),
    ).toBeInTheDocument();
  });
});
