/**
 * OUTAGE-AS-OPEN — CollectionDetailV2's Mint button and what the page says
 * about the sale.
 *
 * `useNFTDropV2` batches twelve reads and, until 2026-09-10, signalled one of
 * them (the price). Five more gate the Mint button, and each collapse landed on
 * the side that DISARMS a guard or asserts a state nobody read:
 *
 *   - `paused` -> false          : Mint armed on a paused drop;
 *   - `maxSupply` -> 0           : `isSoldOut = maxSupply > 0 && …` read "not sold
 *                                  out", Mint armed on a sold-out drop, "10/0";
 *   - `totalSupply` -> 0         : "0/100" and an empty progress bar;
 *   - `maxPerWallet` -> 0        : the contract's own "no cap" (TegridyDropV2.sol:528);
 *   - `mintPhase` -> 0 (CLOSED)  : "Minting closed — the creator hasn't opened the
 *                                  sale yet", a lit "Closed" step and a "Closed" tile,
 *                                  all about a sale whose phase was never read.
 *
 * Every mint above reverts on-chain rather than losing funds, which is the same
 * bar the price fix set: the button arms only on a POSITIVE read of everything
 * it gates on. Both directions are pinned, because treating every 0 as an
 * outage would refuse a real sale that has simply sold nothing yet.
 *
 * Driven through the REAL hook against the shared wagmi mock, which answers by
 * functionName — so a desynced index shows up as the wrong read failing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';
import { CHAIN_ID } from '../../lib/constants';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
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
// These three read wagmi hooks the shared mock does not model (useChains,
// usePublicClient); none of them is under test. PhaseIndicator and ArtCard stay real.
vi.mock('./launchpadShared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./launchpadShared')>();
  return {
    ...actual,
    useExplorerAddressUrl: () => 'https://etherscan.io/address/0x',
    LiveMintFeed: () => null,
    CreatorRevenueDashboard: () => null,
  };
});
vi.mock('./OwnerAdminPanelV2', () => ({ OwnerAdminPanelV2: () => null }));

import { CollectionDetailV2 } from './CollectionDetailV2';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const DROP = '0x1111111111111111111111111111111111111111';

/** A live PUBLIC sale at 0.01 ETH with room left — every gating read landed. */
function stubLiveSale(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    mintPhase: 2,
    currentPrice: parseEther('0.01'),
    totalSupply: 10n,
    maxSupply: 100n,
    maxPerWallet: 5n,
    paused: false,
  };
  for (const [functionName, result] of Object.entries({ ...base, ...overrides })) {
    wagmiMock.setReadResult({ functionName, result });
  }
}
function failRead(functionName: string) {
  wagmiMock.setReadResult({ functionName, result: undefined, status: 'failure' });
}

function renderDetail() {
  renderWithProviders(<CollectionDetailV2 dropAddress={DROP} onClose={() => {}} deployed />);
}

/** The value node of a stats tile, found through its label. */
function tileValue(label: string): string {
  const value = screen.getByText(label, { selector: 'p' }).nextElementSibling;
  if (!value) throw new Error(`stat tile "${label}" has no value node`);
  return value.textContent ?? '';
}
/** An armed CTA reads "Mint N for X ETH" and nothing else does. */
const armedMint = () => screen.queryByRole('button', { name: /^Mint \d+ for/i });
const stateNotice = () => screen.queryByTestId('collection-detail-v2-state-unread');
const closedEmptyState = () => screen.queryByText(/creator hasn't opened the sale/i);
/** The "Closed" step of the PhaseIndicator — the tile's value is a <p>, this is a <span>. */
function closedStepIsLit(): boolean {
  const step = screen.getByText('Closed', { selector: 'span' });
  return step.className.split(/\s+/).includes('text-white');
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  wagmiMock.setAccount({ address: USER, isConnected: true });
});

describe('CollectionDetailV2 — sale state UNREAD', () => {
  it('does not arm Mint on a supply cap it could not read', () => {
    // OLD: maxSupply collapsed to 0, isSoldOut read false, and with the price
    // read fine the CTA was a live "Mint 1 for 0.0100 ETH" — tile said "10/0".
    stubLiveSale();
    failRead('maxSupply');
    renderDetail();

    expect(screen.getByRole('button', { name: /sale state unknown/i })).toBeDisabled();
    expect(armedMint()).toBeNull();
    expect(tileValue('Minted')).toBe('–');
    // Nor a per-mint total, which presents the mint as available at that price.
    expect(screen.queryByText(/^Total:/)).toBeNull();
    expect(stateNotice()).toHaveTextContent(/not a statement that minting is closed, open, paused or sold out/i);
  });

  it('does not report nothing minted when the minted count was not read', () => {
    // OLD: totalSupply collapsed to 0 beside a landed maxSupply of 100 — the tile
    // read "0/100" and the progress bar drew an empty sale.
    stubLiveSale();
    failRead('totalSupply');
    renderDetail();

    expect(tileValue('Minted')).toBe('–');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(armedMint()).toBeNull();
  });

  it('does not arm Mint on a pause switch it could not read', () => {
    // OLD: paused collapsed to false — "Mint 1 for 0.0100 ETH", armed.
    stubLiveSale();
    failRead('paused');
    renderDetail();

    expect(screen.getByRole('button', { name: /sale state unknown/i })).toBeDisabled();
    expect(armedMint()).toBeNull();
    expect(stateNotice()).toBeInTheDocument();
  });

  it('does not tell buyers the sale is closed when the phase was not read', () => {
    // OLD: mintPhase collapsed to 0 = CLOSED, so the page said so four ways: the
    // "Minting Closed" CTA, the "creator hasn't opened the sale" panel, a
    // "Closed" tile and a lit "Closed" step.
    stubLiveSale();
    failRead('mintPhase');
    renderDetail();

    expect(screen.queryByRole('button', { name: /minting closed/i })).toBeNull();
    expect(screen.getByRole('button', { name: /sale state unknown/i })).toBeDisabled();
    expect(closedEmptyState()).toBeNull();
    expect(tileValue('Phase')).toBe('–');
    expect(closedStepIsLit()).toBe(false);
  });
});

describe('CollectionDetailV2 — sale state GENUINE', () => {
  // NOT DISCRIMINATING against the old code — these behave identically before
  // and after. They are the other guard rail: each fails if the fix is ever
  // widened into treating a real zero as an outage.
  it('a phase of 0 that WAS read is a closed sale, and says so', () => {
    stubLiveSale({ mintPhase: 0 });
    renderDetail();

    expect(screen.getByRole('button', { name: /minting closed/i })).toBeDisabled();
    expect(closedEmptyState()).toBeInTheDocument();
    expect(tileValue('Phase')).toBe('Closed');
    expect(closedStepIsLit()).toBe(true);
    expect(stateNotice()).toBeNull();
  });

  it('nothing minted yet and no wallet cap still arm Mint', () => {
    stubLiveSale({ totalSupply: 0n, maxPerWallet: 0n });
    renderDetail();

    expect(screen.getByRole('button', { name: /^Mint 1 for 0\.0100 ETH$/ })).toBeEnabled();
    expect(tileValue('Minted')).toBe('0/100');
    expect(stateNotice()).toBeNull();
  });

  it('a pause that WAS read says paused', () => {
    stubLiveSale({ paused: true });
    renderDetail();

    expect(screen.getByRole('button', { name: /minting paused/i })).toBeDisabled();
    expect(screen.getByText(/contract is paused by the owner/i)).toBeInTheDocument();
    expect(stateNotice()).toBeNull();
  });
});
