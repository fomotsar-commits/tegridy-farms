import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { POOLS_SECTION } from '../lib/navConfig';
import PoolsHostPage from './PoolsHostPage';

// Every Pools tab is a URL that opens this host, and the URL picks the panel.
// The network drop-down reads the wallet: no wallet here.
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
  useChainId: () => 1,
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}));
vi.mock('./LiquidityPage', () => ({ default: () => <div>add-remove panel</div> }));
vi.mock('./PoolsPage', () => ({ default: () => <div>venue-amm panel</div> }));
vi.mock('../components/zap/ZapPage', () => ({ default: () => <div>zap panel</div> }));

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf-8');

describe('PoolsHostPage', () => {
  it('routes every Pools tab to this host in App.tsx', () => {
    const tabs = POOLS_SECTION.items.map((i) => i.to);
    expect(tabs).not.toContain('/solana-lp');
    for (const to of tabs) {
      const route = new RegExp(`<Route path="${to.slice(1)}" element=\\{<Suspense fallback=\\{<\\w+ />\\}><PoolsHostPage />`);
      expect(APP, `${to} does not render PoolsHostPage`).toMatch(route);
    }
  });

  // Owner, 2026-10-24: "remove solana lp keep venue amm". A room door, a bookmark or a wallet
  // card that still says /solana-lp?mint=&task=&pool= opens the same LP section on /pools.
  it('forwards an old /solana-lp link to /pools, its query and hash kept', () => {
    expect(APP).toContain('<Route path="solana-lp" element={<SolanaLpRedirect />} />');
    expect(APP).toContain('function SolanaLpRedirect() {\n  const { search, hash } = useLocation();\n  return <Navigate to={`/pools${search}${hash}`} replace />;\n}');
  });

  it('opens /pools?mint= on the Venue AMM tab and its panel', async () => {
    render(
      <MemoryRouter initialEntries={['/pools?mint=So11111111111111111111111111111111111111112']}>
        <PoolsHostPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('tab', { name: 'Venue AMM' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Solana LP' })).toBeNull();
    expect(await screen.findByText('venue-amm panel')).toBeInTheDocument();
  });
});
