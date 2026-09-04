/**
 * A11Y-R07 — the /community section tabs clear the 44px floor.
 *
 * They shipped `px-3 py-2 text-xs` with no `min-h`: about 32px of tap target,
 * for the primary way to move between the sections of the page, while the
 * structurally identical `role="tablist"` on /swap already carries
 * `min-h-[44px]`. Fails on the pre-change file.
 *
 * The /nft-finance strip is the same one-class change and is pinned GEOMETRICALLY
 * in e2e/tab-target-size.spec.ts instead of here. Rendering LendingPage in a
 * vitest file pulls its four `lazy(() => import(...))` NFT-Finance sections into
 * the TEST TypeScript program, where `strictFunctionTypes: false`
 * (tsconfig.test.json) makes `useTabListKeys(TABS, activeTab, setActiveTab)` in
 * NFTLendingSection.tsx:113 fail to infer — a latent error in a file this lane
 * does not own. The e2e pin measures the rendered box, which is the better
 * assertion anyway, and leaves that file's fix to its owner.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined }),
  useChainId: () => 1,
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));

import CommunityPage from './CommunityPage';

describe('CommunityPage section tabs', () => {
  it('clear the 44px floor', () => {
    render(
      <MemoryRouter initialEntries={['/community']}>
        <CommunityPage />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) expect(tab.className).toContain('min-h-[44px]');
  });
});
