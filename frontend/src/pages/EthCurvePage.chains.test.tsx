// /eth-curve showed one chain's launches and never said the others existed.
//
// THE GAP THIS PINS. `activeChainId` was pinned to the wallet's chain, falling
// back to mainnet — and a disconnected visitor is always on the fallback. The
// Memetics curve is deployed on three chains, so two thirds of the launches on
// the venue's own launchpad were unreachable from the page that lists them,
// with nothing on screen to suggest they were there. Discovery is the binding
// constraint for a launchpad.
//
// AND THE HONESTY HALF. A per-chain count is a read like any other. A
// `launchCount` that did not return is NOT zero, and a chain advertised as
// having "0 launches" when we never got an answer is the fabricated-zero
// failure in miniature. Each count carries its own unread state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const chainState = vi.hoisted(() => ({
  walletChainId: 1,
  // One entry per deployed curve chain, in registry order.
  counts: [] as ({ status: 'success'; result: bigint } | { status: 'failure' })[],
  gridChainIds: [] as number[],
}));

vi.mock('wagmi', () => ({
  useChainId: () => chainState.walletChainId,
  useReadContracts: () => ({ data: chainState.counts }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));
vi.mock('../components/ui/FeatureNotDeployed', () => ({ FeatureNotDeployed: () => null }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));
vi.mock('../components/launcher/CurveCreatePanel', () => ({ CurveCreatePanel: () => null }));
vi.mock('../components/launcher/CurveTradePanel', () => ({ CurveTradePanel: () => null }));
vi.mock('../components/launcher/CurveLaunchesGrid', () => ({
  CurveLaunchesGrid: ({ chainId }: { chainId: number }) => {
    chainState.gridChainIds.push(chainId);
    return <div data-testid="grid" data-chain={String(chainId)} />;
  },
}));

import { CONFIGURED_CHAIN_IDS, getChainConfig } from '../lib/chains/registry';
import { curveLauncherOn } from '../lib/launcher/curve';
import EthCurvePage from './EthCurvePage';

/** The chains the registry actually serves the curve on — ground truth, not a fixture. */
const CURVE_CHAINS = CONFIGURED_CHAIN_IDS.filter((id) => curveLauncherOn(id).status === 'deployed');

function mount() {
  return render(<MemoryRouter><EthCurvePage /></MemoryRouter>);
}

beforeEach(() => {
  chainState.walletChainId = 1;
  chainState.gridChainIds = [];
  chainState.counts = CURVE_CHAINS.map((_, i) => ({ status: 'success' as const, result: BigInt(i + 3) }));
});

describe('cross-chain launch discovery', () => {
  it('is only worth testing because the curve is on more than one chain', () => {
    expect(CURVE_CHAINS.length).toBeGreaterThan(1);
  });

  it('names every deployed chain and its live count, not just the wallet chain', () => {
    mount();
    for (const id of CURVE_CHAINS) {
      const name = getChainConfig(id)?.name ?? '';
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    // Distinct counts per chain, so a shared render would fail this.
    for (let i = 0; i < CURVE_CHAINS.length; i++) {
      expect(screen.getByText(`${i + 3} launches`)).toBeTruthy();
    }
  });

  it('switches the grid to the chain you pick, from a mainnet-defaulted start', () => {
    const other = CURVE_CHAINS.find((id) => id !== 1);
    expect(other).toBeDefined();
    mount();
    // The default is preserved: the disconnected visitor starts on mainnet.
    expect(screen.getByTestId('grid').getAttribute('data-chain')).toBe('1');
    const name = getChainConfig(other!)?.name ?? '';
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'i') }));
    expect(screen.getByTestId('grid').getAttribute('data-chain')).toBe(String(other));
  });

  it('never renders a chain whose count did not return as zero', () => {
    chainState.counts = CURVE_CHAINS.map((_, i) =>
      i === 1 ? ({ status: 'failure' } as const) : ({ status: 'success' as const, result: 7n }),
    );
    mount();
    expect(screen.getByText('count unread')).toBeTruthy();
    expect(screen.queryByText('0 launches')).toBeNull();
  });
});
