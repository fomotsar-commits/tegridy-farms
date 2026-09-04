// /exposure — the two ways this page could answer a question it did not read.
//
// 1. THE "AS OF" STAMP. The method footer said "balances read on-chain as of
//    <time>", where <time> fell back to `new Date()` whenever no exposure
//    carried an `observedAt` — i.e. while every scan was still pending, or when
//    every scan had failed. That stamps the current clock onto a read that did
//    not happen, which is exactly the Date.now()-driven liveness claim this
//    repo forbids.
//
// 2. THE QUESTION THE PAGE ASKS. It offers to tell you what you are holding but
//    could only read a hand-curated token list, so a wallet full of memecoins
//    got "No tracked ERC-20 balances in this wallet" and left. Discovery reads
//    the wallet's own transfer log through the existing explorer proxy and
//    hands the distinct contracts to the SAME on-chain multicall. What is
//    pinned here is the honesty of it: a FAILED log read must never render as
//    an empty wallet, and the result must never read as a complete index.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HoldingExposure } from '../lib/detection/walletExposure';

const WALLET = '0x1111111111111111111111111111111111111111';

const hookState = vi.hoisted(() => ({
  exposures: {} as Record<string, HoldingExposure>,
  lastExtraTokens: [] as string[],
}));

const explorer = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: WALLET, isConnected: true }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));
vi.mock('../components/HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../components/ui/ConnectPrompt', () => ({ ConnectPrompt: () => null }));
vi.mock('../lib/scanner', () => ({ scanTokenLive: () => Promise.resolve(null) }));

vi.mock('../hooks/useWalletExposure', () => ({
  useWalletExposure: (opts: { extraTokens?: string[] }) => {
    hookState.lastExtraTokens = opts.extraTokens ?? [];
    return {
      isConnected: true,
      isWrongNetwork: false,
      isLoading: false,
      error: false,
      address: WALLET,
      holdings: [],
      unreadableBalances: [],
      exposures: hookState.exposures,
      scanning: false,
    };
  },
}));

vi.mock('../lib/txHistory', async (orig) => {
  const actual = await orig<typeof import('../lib/txHistory')>();
  return { ...actual, readExplorerPage: (...a: unknown[]) => explorer.read(...a) };
});

import WalletExposurePage from './WalletExposurePage';

function mount() {
  return render(<MemoryRouter><WalletExposurePage /></MemoryRouter>);
}

function tokenTxRow(contract: string) {
  return {
    hash: '0xaa', from: WALLET, to: WALLET, contractAddress: contract,
    value: '1', tokenSymbol: 'X', tokenName: 'X', tokenDecimal: '18',
    timeStamp: '1750000000', blockNumber: '1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hookState.exposures = {};
  hookState.lastExtraTokens = [];
  explorer.read.mockResolvedValue({ kind: 'empty' });
});

describe('the "as of" stamp', () => {
  it('does not stamp a time when nothing has been read', () => {
    mount();
    // The whole bug in one assertion: with no observation there is no time to
    // report, so the claim itself has to go — not merely its value.
    expect(screen.queryByText(/balances read on-chain as of/)).toBeNull();
    expect(screen.getByText(/no distribution read has completed yet/)).toBeTruthy();
  });

  it('reports the real observation time once a read HAS completed', () => {
    // The other half: a genuine timestamp must survive. A "fix" that deleted
    // the sentence outright would pass the test above and lose the disclosure.
    hookState.exposures = {
      '0xabc': {
        status: 'unmeasured', analysis: null, band: null, headline: null,
        confidence: null, reason: 'no holder source', observedAt: 1_750_000_000,
      },
    };
    mount();
    const stamp = new Date(1_750_000_000 * 1000).toLocaleString();
    const escaped = stamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(screen.getByText(new RegExp(`balances read on-chain as of ${escaped}`))).toBeTruthy();
    expect(screen.queryByText(/no distribution read has completed yet/)).toBeNull();
  });
});

describe('discovering the wallet own tokens', () => {
  it('feeds the distinct contracts from the transfer log into the on-chain reads', async () => {
    const a = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
    const b = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    explorer.read.mockResolvedValue({
      kind: 'rows',
      rows: [tokenTxRow(a), tokenTxRow(b), tokenTxRow(a.toLowerCase())],
      full: false, dropped: 0, oldestRawAt: null,
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /discover my tokens/i }));
    await waitFor(() => expect(hookState.lastExtraTokens).toHaveLength(2));
    // De-duplicated by contract, case-insensitively.
    expect(hookState.lastExtraTokens.map((t) => t.toLowerCase()).sort())
      .toEqual([a.toLowerCase(), b.toLowerCase()].sort());
    expect(screen.getByText(/2 distinct tokens ever received/)).toBeTruthy();
  });

  it('renders a FAILED log read as a failed read, never as an empty wallet', async () => {
    explorer.read.mockResolvedValue({
      kind: 'failed', reason: 'proxy-rate-limited',
      detail: 'Activity service is rate-limiting this deployment (HTTP 429). Nothing was read.',
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /discover my tokens/i }));
    await waitFor(() =>
      expect(screen.getByText(/failed read, not an empty wallet/i)).toBeTruthy(),
    );
    expect(hookState.lastExtraTokens).toHaveLength(0);
    // And the empty-holdings copy must not imply the wallet was enumerated.
    expect(screen.getByText(/says nothing about the rest of the wallet/i)).toBeTruthy();
  });

  it('discloses the cap rather than letting a short list read as a complete one', async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      tokenTxRow(`0x${(i + 1).toString(16).padStart(40, '0')}`),
    );
    explorer.read.mockResolvedValue({ kind: 'rows', rows: many, full: true, dropped: 0, oldestRawAt: null });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /discover my tokens/i }));
    await waitFor(() => expect(screen.getByText(/70 distinct tokens ever received/)).toBeTruthy());
    expect(screen.getByText(/Only the 60 most recent were added/)).toBeTruthy();
    expect(screen.getByText(/older than that page were not read/)).toBeTruthy();
    expect(hookState.lastExtraTokens).toHaveLength(60);
  });

  it('labels the source exactly: received-per-explorer, not a wallet index', () => {
    mount();
    expect(screen.getByText(/not a complete\s+wallet index/i)).toBeTruthy();
  });
});
