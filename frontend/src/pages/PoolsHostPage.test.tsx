import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { POOLS_SECTION } from '../lib/navConfig';
import PoolsHostPage from './PoolsHostPage';

// Every Pools tab is a URL that opens this host, and the URL picks the panel.
vi.mock('./LiquidityPage', () => ({ default: () => <div>add-remove panel</div> }));
vi.mock('./SolanaLpPage', () => ({ default: () => <div>solana-lp panel</div> }));
vi.mock('./PoolsPage', () => ({ default: () => <div>venue-amm panel</div> }));
vi.mock('../components/zap/ZapPage', () => ({ default: () => <div>zap panel</div> }));

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf-8');

describe('PoolsHostPage', () => {
  it('routes every Pools tab, /solana-lp included, to this host in App.tsx', () => {
    const tabs = POOLS_SECTION.items.map((i) => i.to);
    expect(tabs).toContain('/solana-lp');
    for (const to of tabs) {
      const route = new RegExp(`<Route path="${to.slice(1)}" element=\\{<Suspense fallback=\\{<\\w+ />\\}><PoolsHostPage />`);
      expect(APP, `${to} does not render PoolsHostPage`).toMatch(route);
    }
  });

  it('opens /solana-lp?mint= on the Solana LP tab and its panel', async () => {
    render(
      <MemoryRouter initialEntries={['/solana-lp?mint=So11111111111111111111111111111111111111112']}>
        <PoolsHostPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('tab', { name: 'Solana LP' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('solana-lp panel')).toBeInTheDocument();
    expect(screen.queryByText('venue-amm panel')).toBeNull();
  });
});
