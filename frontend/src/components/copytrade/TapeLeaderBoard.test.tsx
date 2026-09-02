// The board's render, in the branch CI's a11y sweep can never reach.
//
// The e2e sweep runs in mock mode with no route to api.geckoterminal.com, so it
// only ever exercises the all-unread state. Everything a reader actually sees
// when the tape DOES answer is pinned here instead.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TapeLeaderBoard } from './TapeLeaderBoard';
import { TapeReadLedger } from './TapeReadLedger';
import { buildTapeLeaderboard, TAPE_SENDER_NOTICE } from '../../lib/copytrade/tapeLeaderboard';
import type { IslandPool, IslandTape, TapeFill } from '../../lib/copytrade/tape';
import { WETH_ADDRESS } from '../../lib/constants';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX = `0x${'cd'.repeat(32)}`;
const AT = 1_780_000_000;

const pool: IslandPool = {
  bungalowId: 'pepe',
  symbol: 'PEPE',
  network: 'eth',
  family: 'evm',
  pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  label: 'PEPE / WETH',
  baseToken: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
  quoteToken: WETH_ADDRESS.toLowerCase(),
};

const qrPool: IslandPool = { ...pool, bungalowId: 'qr', symbol: 'QR', label: 'QR / WETH', pool: '0xf02c' };

function fill(over: Partial<TapeFill> = {}): TapeFill {
  return {
    pool,
    txHash: TX,
    wallet: A,
    side: 'buy',
    at: AT,
    usd: 1200,
    quoteAmount: '0.5',
    blockNumber: null,
    ...over,
  };
}

function tapeOf(fills: TapeFill[], extra: IslandTape['reads'] = [], stoppedEarly = false): IslandTape {
  return {
    fetchedAt: AT * 1000,
    stoppedEarly,
    reads: [
      {
        status: 'read',
        pool,
        fills,
        fetchedAt: AT * 1000,
        newestAt: fills.length ? Math.max(...fills.map((f) => f.at)) : null,
        oldestAt: fills.length ? Math.min(...fills.map((f) => f.at)) : null,
        capped: false,
        undated: 0,
      },
      ...extra,
    ],
  };
}

function renderBoard(tape: IslandTape) {
  const board = buildTapeLeaderboard(tape)!;
  render(
    <MemoryRouter>
      <TapeLeaderBoard
        board={board}
        followerRecord={[]}
        followerRecordReadable
        followed={new Set<string>()}
      />
    </MemoryRouter>,
  );
  return board;
}

describe('TapeLeaderBoard', () => {
  it('prints the return refusal and the sender caveat in full, above the table', () => {
    renderBoard(tapeOf([fill()]));
    expect(screen.getByText(/No wallet on this board is ranked by profit/)).toBeTruthy();
    expect(screen.getByText(/activity, not skill and not outcome/)).toBeTruthy();
    expect(screen.getByText(TAPE_SENDER_NOTICE)).toBeTruthy();
    // The column says what the value IS. "Trader" is a claim this data cannot make.
    expect(screen.getByRole('columnheader', { name: 'Sender' })).toBeTruthy();
  });

  it('has no column header a reader would take for a return', () => {
    renderBoard(tapeOf([fill()]));
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header.textContent ?? '').not.toMatch(/PnL|P&L|Profit|ROI|Return|Gain/i);
    }
  });

  it('says "unpriced" for a row with no priced fill, never $0', () => {
    renderBoard(tapeOf([fill({ wallet: B, usd: null }), fill({ wallet: B, usd: null })]));
    expect(screen.getByText(/unpriced \(2 fills\)/)).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('links the last fill only when the hash is one', () => {
    renderBoard(tapeOf([fill()]));
    expect(screen.getByRole('link', { name: /most recent fill/i }).getAttribute('href')).toBe(
      `https://etherscan.io/tx/${TX}`,
    );

    document.body.innerHTML = '';
    renderBoard(tapeOf([fill({ wallet: B, txHash: null })]));
    expect(screen.queryByRole('link', { name: /most recent fill/i })).toBeNull();
  });

  it('splits buys, sells and unclassified on the row', () => {
    renderBoard(
      tapeOf([fill(), fill({ side: 'sell' }), fill({ side: 'unclassified', quoteAmount: null })]),
    );
    const row = screen.getByRole('row', { name: /0xaaaa/i });
    expect(within(row).getByText(/1 buy \/ 1 sell \/ 1 unclassified/)).toBeTruthy();
  });

  it('says the lag is not measured rather than showing a zero', () => {
    renderBoard(tapeOf([fill()]));
    expect(screen.getByText(/Not measured — you have no matched mirror/)).toBeTruthy();
  });

  it('gives every button a 44px target', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'components', 'copytrade', 'TapeLeaderBoard.tsx'), 'utf8');
    // Sliced rather than regex-matched on the opening tag: a JSX arrow handler
    // contains `>`, so `<button[\s\S]*?>` stops before the className.
    const starts = [...src.matchAll(/<button\b/g)].map((m) => m.index!);
    expect(starts.length).toBeGreaterThan(0);
    for (const i of starts) {
      expect(src.slice(i, src.indexOf('</button', i)), `button at ${i}`).toContain('min-h-11');
    }
  });
});

describe('TapeReadLedger', () => {
  it('names each unread pool with its own reason, and does not call it quiet', () => {
    const tape = tapeOf([fill()], [
      { status: 'unread', pool: qrPool, reason: 'rate-limited', detail: 'The trades feed is rate-limiting right now.' },
    ], true);
    const board = buildTapeLeaderboard(tape)!;
    render(
      <TapeReadLedger status="partial" tape={tape} board={board} onRefresh={() => {}} refreshAvailableAt={null} />,
    );
    expect(screen.getByText(/The island tape: 1 of 2 pools answered/)).toBeTruthy();
    expect(screen.getByText(/QR \/ WETH/)).toBeTruthy();
    expect(screen.getByText(/rate-limited/)).toBeTruthy();
    // The as-of line leads with the SOURCE's own time, not the fetch.
    expect(screen.getByText(/Newest fill on the tape: 2026-/)).toBeTruthy();
  });

  it('says nothing answered rather than drawing an empty board', () => {
    const tape: IslandTape = {
      fetchedAt: AT * 1000,
      stoppedEarly: false,
      reads: [{ status: 'unread', pool, reason: 'network', detail: 'The trades feed could not be reached.' }],
    };
    expect(buildTapeLeaderboard(tape)).toBeNull();
    render(
      <TapeReadLedger status="unavailable" tape={tape} board={null} onRefresh={() => {}} refreshAvailableAt={null} />,
    );
    expect(screen.getByText(/Not one pool answered on this pass/)).toBeTruthy();
    expect(screen.getByText(/nothing here says these pools were quiet/)).toBeTruthy();
  });

  it('says when a refused refresh will be armed instead of doing nothing', () => {
    const tape = tapeOf([fill()]);
    render(
      <TapeReadLedger
        status="ready"
        tape={tape}
        board={buildTapeLeaderboard(tape)}
        onRefresh={() => {}}
        refreshAvailableAt={AT * 1000 + 60_000}
      />,
    );
    expect(screen.getByText(/reads at most once a minute/)).toBeTruthy();
  });
});
