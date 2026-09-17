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
import { screen, cleanup, fireEvent } from '@testing-library/react';
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
// The connect modal's opener is a spy the tests control. Unmocked, it is `undefined`
// here: test-utils/render installs no RainbowKitProvider, and RainbowKit's context
// default carries no opener. That is how #578's guard passed while proving nothing:
// an ENABLED button wired to `undefined` satisfies toBeEnabled() and opens nothing.
const connectModal = vi.hoisted(() => ({ open: undefined as (() => void) | undefined }));
vi.mock('@rainbow-me/rainbowkit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rainbow-me/rainbowkit')>()),
  useConnectModal: () => ({ connectModalOpen: false, openConnectModal: connectModal.open }),
}));
const openConnectModal = vi.fn();

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
  openConnectModal.mockClear();
  connectModal.open = openConnectModal;
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

describe('CollectionDetailV2 — the connect control a disconnected visitor is offered', () => {
  beforeEach(() => wagmiMock.setAccount({ address: undefined, isConnected: false }));

  // A button that READS "Connect Wallet" and is `disabled` on the same !isConnected that
  // produced the label is a dead control: a native disabled button dispatches no click, and
  // handleMint only calls drop.mint — it never opened a modal. So every disconnected
  // visitor to a live drop met a greyed-out control named for the exact thing they needed.
  // The two tests above prove such a visitor reaches this page on ANY chain, which is what
  // makes the state reachable rather than theoretical.
  it.each([CHAIN_ID, ...OFF_MAINNET.map(([, id]) => id)])(
    'on chain %s the Connect control is real, not a greyed-out label',
    (chainId) => {
      renderAt(chainId);
      const connect = screen.getByRole('button', { name: /connect wallet/i });
      expect(connect).toBeEnabled();
      // Enabled is not enough: `onClick={undefined}` is enabled too. The click must
      // reach the modal.
      fireEvent.click(connect);
      expect(openConnectModal).toHaveBeenCalledTimes(1);
      // And it must not LOOK disabled while it is live: the greyed, not-allowed class
      // tracks the disabled attribute, not the connection state.
      // (classList, so a `disabled:cursor-not-allowed` variant is not mistaken for it.)
      expect(connect.classList.contains('cursor-not-allowed')).toBe((connect as HTMLButtonElement).disabled);
    },
  );

  it('with no connect modal to open, the control is disabled rather than live and inert', () => {
    // useConnectModal is typed `(() => void) | undefined`: no RainbowKitProvider above,
    // or a connection status RainbowKit does not open the modal from.
    connectModal.open = undefined;
    renderAt(CHAIN_ID);
    const connect = screen.getByRole('button', { name: /connect wallet/i });
    expect(connect).toBeDisabled();
    expect(connect.classList.contains('cursor-not-allowed')).toBe(true);
  });

  it('an undeployed drop offers a disabled label, not a connect control', () => {
    renderWithProviders(<CollectionDetailV2 dropAddress={DROP} onClose={() => {}} deployed={false} />);
    const button = screen.getByRole('button', { name: /contract not deployed/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(openConnectModal).not.toHaveBeenCalled();
  });

  it('offers exactly one connect control, and no disabled one wearing the word', () => {
    renderAt(CHAIN_ID);
    const connects = screen.getAllByRole('button', { name: /connect wallet/i });
    expect(connects).toHaveLength(1);
    // The load-bearing half: whatever else this page renders, nothing labelled for
    // connecting may be inert. This is the assertion that fails on the pre-fix component.
    for (const b of connects) expect(b).toBeEnabled();
  });

  it('does not offer the mint action to someone who cannot send it', () => {
    renderAt(CHAIN_ID);
    expect(screen.queryByRole('button', { name: /^Mint \d/ })).toBeNull();
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
