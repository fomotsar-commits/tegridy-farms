// /eth-curve puts only the create form behind the heat door. The launches grid, trade by
// address and how-it-works stay open to anyone. The door's own verdicts are pinned in
// LaunchGate.children.test.tsx; here the door is a stand-in that is open or shut.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const door = vi.hoisted(() => ({ open: true, rails: [] as string[] }));

// The curve's launch switch (curveChains.ts CURVE_LAUNCH_OPEN) is committed closed (island answer
// twenty-six); these tests read the page the day it opens.
const curveLaunch = vi.hoisted(() => ({ open: true }));
vi.mock('../lib/launcher/curveChains', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/curveChains')>()),
  isCurveLaunchOpen: () => curveLaunch.open,
}));

vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useReadContracts: () => ({ data: [] }),
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
vi.mock('../components/LaunchGate', () => ({
  LaunchGate: ({ rail, children }: { rail?: string; children?: React.ReactNode }) => {
    door.rails.push(rail ?? 'ethereum');
    return <section data-testid="door">{door.open ? children : null}</section>;
  },
}));
vi.mock('../components/launcher/CurveCreatePanel', () => ({
  CurveCreatePanel: () => <div data-testid="create-form" />,
}));
vi.mock('../components/launcher/CurveTradePanel', () => ({ CurveTradePanel: () => null }));
vi.mock('../components/launcher/CurveLaunchesGrid', () => ({
  CurveLaunchesGrid: () => <div data-testid="grid" />,
}));

import EthCurvePage from './EthCurvePage';

function mount() {
  return render(<MemoryRouter><EthCurvePage /></MemoryRouter>);
}

beforeEach(() => {
  door.open = true;
  door.rails = [];
});

describe('/eth-curve: only the create form sits behind the door', () => {
  it('mounts the create form inside the Ethereum door', () => {
    mount();
    const doors = screen.getAllByTestId('door');
    expect(doors).toHaveLength(1);
    expect(within(doors[0]).getByTestId('create-form')).toBeInTheDocument();
    expect(door.rails).toContain('ethereum');
    expect(door.rails.every((r) => r === 'ethereum')).toBe(true);
  });

  it('with launching closed (answer twenty-six): no Live mark, no create form, what it waits on, and the launches', () => {
    curveLaunch.open = false;
    try {
      const { container } = mount();
      expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
      expect(screen.queryByTestId('door')).not.toBeInTheDocument();
      expect(screen.getByTestId('curve-launch-closed')).toHaveTextContent('Launching here is not switched on yet.');
      expect(container.textContent).not.toMatch(/Live on/i);
      expect(screen.getByTestId('grid')).toBeInTheDocument();
      expect(screen.getByLabelText('Curve token address to trade')).toBeInTheDocument();
    } finally {
      curveLaunch.open = true;
    }
  });

  it('a shut door hides the create form and nothing else', () => {
    door.open = false;
    mount();
    expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
    // Open to anyone: the launches, trade by address and how the curve works.
    const outside = screen.getByTestId('door');
    for (const el of [
      screen.getByTestId('grid'),
      screen.getByLabelText('Curve token address to trade'),
      screen.getByText('How the Memetics curve works'),
    ]) {
      expect(outside.contains(el)).toBe(false);
    }
  });
});
