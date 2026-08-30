// What the distribution card puts on screen, and — the half that matters — what
// it refuses to: no scan until asked, and never a number it did not read.
//
// The success path cannot be exercised against a live endpoint from a dev box:
// `getTokenLargestAccounts` is an indexed request that every keyless Solana RPC
// refuses (measured 2026-08-28 — mainnet-beta answers 429 to a single call,
// publicnode answers "Indexed requests require a personal token"). So the render
// is pinned here against a mocked scan instead of a one-off eyeball.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';

const scan = vi.hoisted(() => ({
  calls: 0,
  lastChain: undefined as string | undefined,
  state: {
    status: 'idle' as string,
    outcome: null as unknown,
    errorMessage: null as string | null,
    chain: 'solana',
    reload: () => {},
  },
}));

vi.mock('../../hooks/useTokenScan', () => ({
  useTokenScan: (address: string, chainOverride?: string) => {
    // The card must pass an EMPTY address until armed — that is the whole
    // mechanism by which it issues no RPC on mount.
    if (address) { scan.calls += 1; scan.lastChain = chainOverride; }
    return address
      ? scan.state
      : { status: 'idle', outcome: null, errorMessage: null, chain: null, reload: () => {} };
  },
}));

const { BungalowHolders } = await import('./BungalowHolders');

const BAYLA = {
  id: 'bayla',
  name: 'Bayla',
  symbol: 'BAYLA',
  chain: 'solana',
  address: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
  status: 'NEWEST',
  tagline: 'The muse was always here.',
  accent: '#8ef0d8',
  thumb: '/art/bayla/bayla-14.jpg',
  live: true,
} as unknown as Bungalow;

function successOutcome() {
  return {
    source: 'Solana RPC (top-20 token accounts)',
    enumeratedHolders: 20,
    holderCoverage: 'top-n',
    coverageNotes: ['Only the largest 20 accounts were read, so these shares are an upper bound.'],
    analysis: {
      band: 'mixed',
      headline: 'About 9 effective holders among the accounts read.',
      caveats: ['An address is not a person.'],
      metrics: {
        topN: { top1: 0.184, top5: 0.402, top10: 0.611, top20: 0.79 },
        nakamotoCoefficient: 7,
      },
    },
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <BungalowHolders bungalow={BAYLA} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  scan.calls = 0;
  scan.lastChain = undefined;
  scan.state = { status: 'idle', outcome: null, errorMessage: null, chain: 'solana', reload: () => {} };
});

describe('BungalowHolders', () => {
  it('issues no scan until the reader asks for one', () => {
    mount();
    expect(scan.calls, 'mounting must not trigger a chain scan').toBe(0);
    expect(screen.getByRole('button', { name: /read distribution/i })).toBeTruthy();
  });

  it('scans once armed, and then offers a refresh instead', () => {
    scan.state = { ...scan.state, status: 'success', outcome: successOutcome() };
    mount();
    fireEvent.click(screen.getByRole('button', { name: /read distribution/i }));
    expect(scan.calls).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
  });

  it('renders the band, the top-N shares and the Nakamoto coefficient', () => {
    scan.state = { ...scan.state, status: 'success', outcome: successOutcome() };
    mount();
    fireEvent.click(screen.getByRole('button', { name: /read distribution/i }));
    expect(screen.getByText('mixed')).toBeTruthy();
    expect(screen.getByText('18.4%')).toBeTruthy();
    expect(screen.getByText('40.2%')).toBeTruthy();
    expect(screen.getByText('61.1%')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('states the coverage limit rather than implying a full read', () => {
    scan.state = { ...scan.state, status: 'success', outcome: successOutcome() };
    mount();
    fireEvent.click(screen.getByRole('button', { name: /read distribution/i }));
    expect(screen.getByText(/largest 20 accounts were read/i)).toBeTruthy();
    // "upper bound" is said twice on purpose — once in the scanner's own
    // coverage note, once in the source line under the figures.
    expect(screen.getAllByText(/upper bound/i).length).toBeGreaterThanOrEqual(2);
  });

  it('scans a Base bungalow on Base, and its Full-scan link carries the chain', () => {
    // Pre-fix, chain collapsed to `=== 'solana' ? 'solana' : 'ethereum'` and
    // the link was chain-less — a Base token's 0x address would wrong-chain
    // scan both ways (0x is format-ambiguous with Ethereum).
    const DRB = {
      ...BAYLA,
      id: 'drb',
      symbol: 'DRB',
      chain: 'base',
      address: '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2',
    } as unknown as Bungalow;
    scan.state = { ...scan.state, status: 'success', outcome: successOutcome() };
    render(
      <MemoryRouter>
        <BungalowHolders bungalow={DRB} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /read distribution/i }));
    expect(scan.lastChain, "the scan must run on the token's own chain").toBe('base');
    const full = screen.getByRole('link', { name: /full scan/i });
    expect(full.getAttribute('href')).toContain('chain=base');
  });

  it('renders a failed read as an outage, never as a distribution', () => {
    scan.state = {
      ...scan.state,
      status: 'error',
      errorMessage: 'Too many scans right now — try again in a moment.',
    };
    mount();
    fireEvent.click(screen.getByRole('button', { name: /read distribution/i }));
    expect(screen.getByText(/too many scans right now/i)).toBeTruthy();
    // The failure must not paint any concentration figure.
    expect(screen.queryByText(/%$/)).toBeNull();
  });
});
