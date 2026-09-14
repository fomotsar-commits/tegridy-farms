/**
 * THE MINT BUTTON'S CHAIN GUARD, NOW THAT THE SALE IS READ FROM EVERY CHAIN.
 *
 * useNFTDropV2 gated its batch on `useChainId() === CHAIN_ID`. wagmi persists the
 * wallet's chain and keeps it through a disconnect, so for a visitor last
 * connected on Base or Robinhood Chain every read was disabled and this page
 * described a sale nobody had read: "0/0" minted, a "Closed" phase, and "Minting
 * closed — the creator hasn't opened the sale yet". The reads are pinned to
 * mainnet, so the gate is gone and that visitor sees the sale.
 *
 * The same gate was also, by accident, what disarmed Mint off mainnet: with no
 * price read, `!drop.priceReadOk` held the button down under its "Switch to
 * Ethereum Mainnet" label. The price now lands there too, so mintDisabled states
 * the chain guard itself.
 *
 * MUTATION CHECK: restore the hook's gate and the logged-out cases fail; drop
 * `!drop.onMainnet` from mintDisabled and the connected off-mainnet cases fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
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
// These read wagmi hooks the shared mock does not model; none is under test.
// ArtCard and PhaseIndicator stay real.
vi.mock('./launchpadShared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./launchpadShared')>()),
  useExplorerAddressUrl: () => 'https://etherscan.io/address/0x',
  LiveMintFeed: () => null,
  CreatorRevenueDashboard: () => null,
}));
vi.mock('./OwnerAdminPanelV2', () => ({ OwnerAdminPanelV2: () => null }));

import { CollectionDetailV2 } from './CollectionDetailV2';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const DROP = '0x2222222222222222222222222222222222222222';
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

/** A live PUBLIC sale on mainnet: 0.08 ETH, 3 of 100 minted. */
function stubLiveSale() {
  const sale: Record<string, unknown> = {
    mintPhase: 2,
    currentPrice: parseEther('0.08'),
    totalSupply: 3n,
    maxSupply: 100n,
    maxPerWallet: 5n,
    paused: false,
  };
  for (const [functionName, result] of Object.entries(sale)) {
    wagmiMock.setReadResult({ address: DROP, functionName, result });
  }
}

function renderAt(chainId: number) {
  wagmiMock.setChainId(chainId);
  return renderWithProviders(<CollectionDetailV2 dropAddress={DROP} onClose={() => {}} deployed />);
}

/** The value node of a stats tile, found through its label. */
function tileValue(label: string): string {
  const value = screen.getByText(label, { selector: 'p' }).nextElementSibling;
  if (!value) throw new Error(`stat tile "${label}" has no value node`);
  return value.textContent ?? '';
}

beforeEach(() => {
  wagmiMock.reset();
  stubLiveSale();
});

describe('CollectionDetailV2 — logged out, wallet chain persisted from another network', () => {
  beforeEach(() => wagmiMock.setAccount({ address: undefined, isConnected: false }));

  it.each(OFF_MAINNET)('on %s it describes the live sale, not a closed and empty one', (_label, chainId) => {
    renderAt(chainId);
    expect(screen.queryByText(/creator hasn't opened the sale/i)).toBeNull();
    expect(tileValue('Minted')).toBe('3/100');
    expect(tileValue('Phase')).toBe('Public');
  });

  it.each(OFF_MAINNET)('on %s it renders exactly what a mainnet visitor sees', (_label, chainId) => {
    const mainnet = renderAt(CHAIN_ID).container.textContent;
    cleanup();
    const offMainnet = renderAt(chainId).container.textContent;
    // Non-vacuity: two renders of an unread sale would also be equal.
    expect(mainnet).toContain('3/100');
    expect(offMainnet).toBe(mainnet);
  });
});

describe('CollectionDetailV2 — a wallet connected off mainnet', () => {
  beforeEach(() => wagmiMock.setAccount({ address: USER, isConnected: true }));

  it('on mainnet the same sale arms Mint (the control for the cases below)', () => {
    renderAt(CHAIN_ID);
    expect(screen.getByRole('button', { name: 'Mint 1 for 0.0800 ETH' })).toBeEnabled();
  });

  it.each(OFF_MAINNET)('on %s Mint stays disarmed under its switch label, though the price was read', (_label, chainId) => {
    renderAt(chainId);
    expect(screen.getByRole('button', { name: 'Switch to Ethereum Mainnet' })).toBeDisabled();
    // The chain is what holds it down: this total renders only on a price that was read.
    expect(screen.getByText('Total: 0.0800 ETH')).toBeInTheDocument();
  });
});
