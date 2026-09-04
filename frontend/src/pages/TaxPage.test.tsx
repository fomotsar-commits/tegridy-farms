// THE PAGE SAYS WHAT WAS READ BEFORE IT SHOWS A NUMBER.
//
// The report panel renders totals in every state, so the only thing standing
// between "0.00 ETH realised" and a reader believing it is the status card
// above it. Each of the states below is one this deployment can genuinely be
// in, and each has its own sentence because the fixes are different: a missing
// server-side key is an operator's job, a throttle is a minute's wait, and an
// unreadable chain head means nothing was even asked for.
//
// The keyless case is also the half of the pill's honesty that lives on the
// page. /tax carries no SOON pill — the rail is a repo fact — and that is only
// honest while this copy exists and names the variable an operator must set.
// lib/tax/rails.test.ts pins the other half.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LedgerRead } from '../hooks/useWalletLedger';
import type { WalletLedger } from '../lib/tax/ledger';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

const state = vi.hoisted(() => ({
  ledger: { status: 'idle' } as LedgerRead,
  address: undefined as string | undefined,
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: state.address }) }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

// The ledger read is stubbed; everything below it — the report build, the
// coverage statement, the panel and the exports — is REAL, so this asserts the
// page's own composition rather than a mock of it.
vi.mock('../hooks/useWalletLedger', () => ({
  useWalletLedger: () => ({
    read: state.ledger,
    reload: vi.fn(),
    nextReloadAt: null,
    cooldownSeconds: 0,
  }),
  MAX_LEDGER_PAGES: 4,
  RELOAD_COOLDOWN_SECONDS: 60,
}));
vi.mock('../lib/indexer/client', () => ({ isIndexerConfigured: () => false }));
const indexed = () => ({
  status: 'idle' as const,
  items: [],
  hasMore: false,
  syncedBlock: null,
  syncedAt: null,
  detail: null,
  reload: vi.fn(),
});
vi.mock('../hooks/useIndexedSwaps', () => ({ useIndexedSwaps: () => indexed() }));
vi.mock('../hooks/useIndexedStakingHistory', () => ({ useIndexedStakingHistory: () => indexed() }));

import TaxPage from './TaxPage';

const EMPTY_LEDGER: WalletLedger = {
  wallet: ACCOUNT,
  txs: [],
  cut: null,
  belowCut: 0,
  truncated: [],
  transferCount: 0,
  unreadRows: 0,
};

beforeEach(() => {
  state.ledger = { status: 'idle' };
  state.address = undefined;
});

describe('the resting state says nothing was read, rather than drawing an empty year', () => {
  it('renders exactly one h1 and labelled controls', () => {
    render(<TaxPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText(/period/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/paste rows to import/i)).toBeInTheDocument();
  });

  it('no longer claims the venue’s indexer is the only thing it could read', () => {
    const { container } = render(<TaxPage />);
    expect(container.textContent).not.toMatch(/its indexer never recorded what came back/);
    expect(container.textContent).toMatch(/No wallet connected/);
  });

  it('gives every control a 44px touch target', () => {
    const { container } = render(<TaxPage />);
    const targets = [...container.querySelectorAll('button'), ...container.querySelectorAll('select')];
    expect(targets.length).toBeGreaterThan(3);
    for (const el of targets) {
      expect(el.className, `${el.textContent ?? el.tagName} is under 44px`).toContain('min-h-[44px]');
    }
  });
});

describe('each read failure is named as itself, with the step that fixes it', () => {
  it('prints the operator step and the variable when the deployment has no explorer key', () => {
    state.address = ACCOUNT;
    state.ledger = {
      status: 'failed',
      reason: 'explorer-keyless',
      detail: "memetics.finance can't reach Etherscan right now.",
    };
    const { container } = render(<TaxPage />);
    expect(container.textContent).toMatch(/ETHERSCAN_API_KEY/);
    expect(container.textContent).toMatch(/whole period is a declared gap on every export/);
    // …and the report below it must agree, not quietly render a clean zero.
    expect(container.textContent).toMatch(/^.*INCOMPLETE/s);
    expect(container.textContent).toMatch(/explorer-unavailable/);
  });

  it('says a throttle is a throttle, which is the one case where "try again" is honest', () => {
    state.address = ACCOUNT;
    state.ledger = { status: 'failed', reason: 'proxy-rate-limited', detail: 'HTTP 429' };
    expect(render(<TaxPage />).container.textContent).toMatch(/rate-limiting this deployment right now/);
  });

  it('says nothing was even asked for when the chain head could not be read', () => {
    state.address = ACCOUNT;
    state.ledger = {
      status: 'failed',
      reason: 'head-unavailable',
      detail:
        'The chain head could not be read over this app’s RPC, so no history window could be pinned and ' +
        'nothing was read. Nothing was concluded — try again.',
    };
    expect(render(<TaxPage />).container.textContent).toMatch(/no history window could be pinned/);
  });
});

describe('a successful read states its as-of and its scope', () => {
  it('names the block, the chain’s own clock and the chains it did not read', () => {
    state.address = ACCOUNT;
    state.ledger = {
      status: 'ready',
      ledger: EMPTY_LEDGER,
      head: { block: 21_000_000n, timestamp: Math.floor(Date.UTC(2025, 11, 31) / 1000) },
      pagesRead: { txlist: 1, txlistinternal: 1, tokentx: 1 },
      rowCounts: { txlist: 0, txlistinternal: 0, tokentx: 0 },
    };
    const { container } = render(<TaxPage />);
    expect(container.textContent).toMatch(/rows the explorer had indexed up to block 21000000/);
    expect(container.textContent).toMatch(/by the chain’s own clock/);
    expect(container.textContent).toMatch(/Base and other chains were not read/);
    // The quote is stated where the totals are, because ETH is not what a
    // jurisdiction asks for and nothing here converts it.
    expect(container.textContent).toMatch(/nothing here converts silently/);
  });
});
