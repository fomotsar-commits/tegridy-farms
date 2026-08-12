// CommunityPage — what the four governance tabs claim about the chain.
//
// THE BUG THIS PINS. Every one of the four tabs told visitors its feature
// "isn't live yet" and would open "once the contract is deployed for the
// relaunch". Verified by live mainnet reads on 2026-08-12, all four contracts
// were already deployed, unpaused, and carrying non-empty bytecode:
//
//   CommunityGrants 0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471
//   MemeBountyBoard 0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890
//   VoteIncentives  0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF
//   GaugeController 0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054
//
// The zero addresses in constants.ts are a FRONTEND WIRING GATE, and
// `isDeployed()` reading that zero is not evidence about the chain. So the page
// was stating the opposite of on-chain reality on a surface navConfig promotes
// into the menu.
//
// The distinction is narrow and the test is written to hold exactly it:
//   "not live"                  → FALSE, must never appear
//   "deployed, not enabled here" → TRUE, must appear, with the address
// A future edit that walks either half back fails here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));

import CommunityPage from './CommunityPage';

/** Deployed-on-mainnet addresses each tab's placeholder must be able to prove. */
const CONTRACTS = {
  '': { name: /CommunityGrants/, address: '0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471' },
  bounties: { name: /MemeBountyBoard/, address: '0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890' },
  bribes: { name: /VoteIncentives/, address: '0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF' },
  gauges: { name: /GaugeController/, address: '0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054' },
} as const;

function renderTab(section: string) {
  const path = section ? `/community?section=${section}` : '/community';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CommunityPage />
    </MemoryRouter>,
  );
}

/** The false claim, in every phrasing the page used to ship. */
const NOT_LIVE_CLAIMS = [
  /isn't live yet/i,
  /aren't live yet/i,
  /is not live yet/i,
  /are not live yet/i,
  /once the .*contract is deployed/i,
  /once the gauge controller is deployed/i,
  /coming with the relaunch/i,
];

beforeEach(() => { vi.clearAllMocks(); });

describe('CommunityPage — deployed-but-unwired is not the same as "not live"', () => {
  for (const [section, contract] of Object.entries(CONTRACTS)) {
    const label = section || 'grants';

    it(`the ${label} tab does not claim its contract is undeployed`, () => {
      renderTab(section);
      const page = document.body.textContent ?? '';
      for (const claim of NOT_LIVE_CLAIMS) {
        expect(claim.test(page), `page still claims: ${claim}`).toBe(false);
      }
    });

    it(`the ${label} tab says deployed-but-not-enabled-here, and proves it with the address`, () => {
      renderTab(section);
      const page = document.body.textContent ?? '';
      // The correction itself: the contract exists on chain…
      expect(contract.name.test(page), 'the contract must be named').toBe(true);
      expect(/deployed and unpaused on Ethereum mainnet/i.test(page)).toBe(true);
      // …and the reason it is unusable here is the app, not the chain.
      expect(/not yet enabled here|hasn.t been pointed at it yet|wired into the frontend/i.test(page)).toBe(true);
      // The address is a full 20-byte value, never truncated, and linkable.
      const link = Array.from(document.querySelectorAll('a[href]')).find((a) =>
        (a.getAttribute('href') ?? '').toLowerCase().includes(contract.address.toLowerCase()),
      );
      expect(link, `no explorer link for ${contract.address}`).toBeTruthy();
      expect(page).toContain(contract.address);
    });
  }

  it('states the extra truth about vote incentives: no gauge controller is wired on-chain', () => {
    // VoteIncentives.gaugeController() == 0x0 (read 2026-08-12). "It's deployed"
    // on its own would over-correct — bribes still have nothing to settle
    // against. Both facts have to survive together.
    renderTab('bribes');
    const page = document.body.textContent ?? '';
    expect(/not yet pointed at a gauge controller/i.test(page)).toBe(true);
    expect(/setGaugeController/.test(page)).toBe(true);
  });

  it('keeps the "Live now" section and every tab — the claim changed, nothing was removed', () => {
    // HARD RULE: additive only. These are the surfaces that were already on the
    // page and must still be there.
    renderTab('');
    expect(screen.getByText(/Live now/i)).toBeTruthy();
    expect(screen.getByText(/Tegridy Score/)).toBeTruthy();
    expect(screen.getByText(/Community chat/)).toBeTruthy();
    expect(screen.getByText(/Gallery/)).toBeTruthy();
    for (const tab of ['Governance', 'Bounties', 'Vote Incentives', 'Gauge Voting']) {
      expect(screen.getByRole('tab', { name: tab })).toBeTruthy();
    }
  });
});
