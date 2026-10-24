// The NFT owner panel against the contract it actually talks to.
//
// Every TegridyDropV2 (the template deployed today at 0xA35ec3e2… and the source
// after pull request 799 alike) reverts on configureDutchAuction, setMintPrice and
// setMerkleRoot: those changes are propose, wait 24 hours, then carry out. The
// panel called the three one-step setters, so every price, allowlist and auction
// change it offered reverted. These pin the propose / carry out / cancel flow, the
// holds on "Set Phase", and that the panel reads which template a collection runs
// (from its code) before it explains the switch between a fixed price and an auction.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { toFunctionSelector } from 'viem';
import { renderWithProviders } from '../../test-utils/render';
import { DROP_TIMELOCK_KEYS } from '../../lib/dropRules';

const { writeContract, reads, readCalls, client } = vi.hoisted(() => ({
  writeContract: vi.fn(),
  reads: new Map<string, unknown>(),
  readCalls: [] as { functionName: string; enabled: boolean }[],
  client: { getCode: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

// Reads are keyed by function name and first argument, so the three proposal
// clocks (one function, three keys) answer separately. Anything unset is unread.
vi.mock('wagmi', () => ({
  useChainId: () => 1,
  usePublicClient: () => client,
  useReadContract: (opts: { functionName: string; args?: readonly unknown[]; query?: { enabled?: boolean } }) => {
    const enabled = opts.query?.enabled !== false;
    readCalls.push({ functionName: opts.functionName, enabled });
    const key = opts.args?.length ? `${opts.functionName}:${String(opts.args[0])}` : opts.functionName;
    const data = enabled ? reads.get(key) : undefined;
    return { data, refetch: vi.fn(), isError: enabled && !reads.has(key), isLoading: false };
  },
  useWriteContract: () => ({ writeContract, data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
}));

import { OwnerAdminPanelV2 } from './OwnerAdminPanelV2';

const DROP = '0x1234567890123456789012345678901234567890';
const TEMPLATE = 'a35ec3e20c4361144b0d99573dea00b67873e872';
const CLONE_CODE = `0x363d3d373d3d3d363d73${TEMPLATE}5af43d82803e903d91602b57fd5bf3`;
const NEW_PRICE_FLAG = toFunctionSelector('fixedPriceNeedsProposal()').slice(2);
/** A dispatcher fragment: PUSH4 <selector> EQ, as solc writes one per function. */
const dispatch = (...selectors: string[]) => `0x6080${selectors.map((s) => `63${s}14`).join('')}00`;
const OTHER = toFunctionSelector('mintPhase()').slice(2);

const NOW = Math.floor(Date.now() / 1000);
const eta = (key: `0x${string}`) => `proposalExecuteAfter:${key}`;

function noneWaiting() {
  reads.set(eta(DROP_TIMELOCK_KEYS.mintPrice), 0n);
  reads.set(eta(DROP_TIMELOCK_KEYS.dutchAuction), 0n);
  reads.set(eta(DROP_TIMELOCK_KEYS.merkleRoot), 0n);
}

/** The drop is a clone of a template whose dispatcher has (or lacks) the new-price flag. */
function templateHasNewPriceFlag(has: boolean) {
  client.getCode.mockImplementation(async ({ address }: { address: string }) =>
    address.toLowerCase() === DROP.toLowerCase() ? CLONE_CODE : dispatch(OTHER, ...(has ? [NEW_PRICE_FLAG] : [])));
}

function openPanel() {
  renderWithProviders(<OwnerAdminPanelV2 dropAddress={DROP} deployed />);
  fireEvent.click(screen.getByText('Owner Admin (V2)'));
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const calledWith = (functionName: string, args?: unknown[]) =>
  expect(writeContract).toHaveBeenCalledWith(expect.objectContaining(args ? { functionName, args } : { functionName }), expect.anything());

beforeEach(() => {
  writeContract.mockReset();
  client.getCode.mockReset();
  reads.clear();
  readCalls.length = 0;
  reads.set('mintPhase', 0n); // CLOSED: the only phase a price or auction can be proposed in
  reads.set('paused', false);
  reads.set('totalSupply', 0n);
  reads.set('maxSupply', 100n);
  noneWaiting();
  templateHasNewPriceFlag(true);
});

describe('changes the contract makes wait 24 hours are proposed, never set in one step', () => {
  it('proposes an auction with proposeDutchAuction', () => {
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('Start (ETH)'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('End (ETH)'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByText('Start in 1 hour'));
    fireEvent.change(screen.getByPlaceholderText('Duration (sec)'), { target: { value: '3600' } });
    fireEvent.click(button('Propose Auction'));
    const call = writeContract.mock.calls[0]?.[0] as { functionName: string; args: bigint[] };
    expect(call.functionName).toBe('proposeDutchAuction');
    expect(call.args.slice(0, 2)).toEqual([10n ** 18n, 10n ** 17n]);
    expect(call.args[3]).toBe(3600n);
  });

  it('proposes an allowlist root with proposeMerkleRoot', () => {
    openPanel();
    const root = `0x${'ab'.repeat(32)}`;
    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: root } });
    fireEvent.click(button('Propose Root'));
    calledWith('proposeMerkleRoot', [root]);
  });

  it('holds a price proposal while the sale is open, and says why', () => {
    reads.set('mintPhase', 2n);
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('0.05'), { target: { value: '0.2' } });
    expect(button('Propose Price').disabled).toBe(true);
    expect(screen.getByText('Close the sale to propose a price.')).toBeInTheDocument();
  });

  it('never sends a one-step setter the contract reverts on', () => {
    openPanel();
    // Every field a setter would take, filled, so each control that could send one is live.
    fireEvent.change(screen.getByPlaceholderText('0.05'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: `0x${'ab'.repeat(32)}` } });
    fireEvent.change(screen.getByPlaceholderText('Start (ETH)'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('End (ETH)'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByText('Start in 1 hour'));
    fireEvent.change(screen.getByPlaceholderText('Duration (sec)'), { target: { value: '3600' } });
    // Re-found each time: the framer-motion stand-in remounts the panel on every render.
    const labels = screen.getAllByRole('button')
      .filter((b) => !b.hasAttribute('disabled') && !b.textContent?.startsWith('Owner Admin'))
      .map((b) => b.textContent);
    for (const label of labels) {
      const b = screen.getAllByRole('button').find((x) => x.textContent === label);
      if (b && !b.hasAttribute('disabled')) fireEvent.click(b);
    }
    expect(writeContract).toHaveBeenCalled();
    const sent = writeContract.mock.calls.map(([req]) => (req as { functionName: string }).functionName);
    expect(sent).not.toContain('configureDutchAuction');
    expect(sent).not.toContain('setMintPrice');
    expect(sent).not.toContain('setMerkleRoot');
  });
});

describe('a waiting change', () => {
  it('shows the proposed price and when it is ready, and cannot be carried out before', () => {
    reads.set(eta(DROP_TIMELOCK_KEYS.mintPrice), BigInt(NOW + 3600));
    reads.set('pendingMintPrice', 3n * 10n ** 17n);
    openPanel();
    expect(screen.getByText(/0\.3 ETH: proposed, ready /)).toBeInTheDocument();
    expect(button('Carry Out').disabled).toBe(true);
  });

  it('carries out with the proposal\'s own price and time once ready', () => {
    const at = BigInt(NOW - 60);
    reads.set(eta(DROP_TIMELOCK_KEYS.mintPrice), at);
    reads.set('pendingMintPrice', 3n * 10n ** 17n);
    openPanel();
    expect(screen.getByText('0.3 ETH: ready to carry out.')).toBeInTheDocument();
    fireEvent.click(button('Carry Out'));
    calledWith('executeMintPrice', [3n * 10n ** 17n, at]);
  });

  it('carries out a waiting auction with all four of its values and its time', () => {
    const at = BigInt(NOW - 60);
    reads.set(eta(DROP_TIMELOCK_KEYS.dutchAuction), at);
    reads.set('pendingDutchConfig', [10n ** 18n, 10n ** 17n, BigInt(NOW + 7200), 3600n]);
    openPanel();
    fireEvent.click(button('Carry Out'));
    calledWith('executeDutchAuction', [10n ** 18n, 10n ** 17n, BigInt(NOW + 7200), 3600n, at]);
  });

  it('can be cancelled, and an expired one says to cancel it', () => {
    reads.set(eta(DROP_TIMELOCK_KEYS.merkleRoot), BigInt(NOW - 8 * 86_400));
    reads.set('pendingMerkleRoot', `0x${'cd'.repeat(32)}`);
    openPanel();
    expect(screen.getByText(/expired\. Cancel it to propose again\./)).toBeInTheDocument();
    expect(button('Carry Out').disabled).toBe(true);
    fireEvent.click(button('Cancel'));
    calledWith('cancelMerkleRoot');
  });

  it('holds "Set Phase" while it waits', () => {
    reads.set('mintPhase', 2n);
    reads.set(eta(DROP_TIMELOCK_KEYS.merkleRoot), BigInt(NOW + 3600));
    reads.set('pendingMerkleRoot', `0x${'cd'.repeat(32)}`);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Closed/ }));
    expect(screen.getByText('A change is waiting. Carry it out or cancel it first.')).toBeInTheDocument();
    expect(button(/Set Phase → Closed/).disabled).toBe(true);
  });

  it('says so when the wait could not be read', () => {
    reads.delete(eta(DROP_TIMELOCK_KEYS.mintPrice));
    openPanel();
    expect(screen.getByText('Waiting change: could not be read.')).toBeInTheDocument();
  });
});

describe('switching a sale between a fixed price and an auction', () => {
  it('is never one step from this panel: a live public sale closes first', () => {
    reads.set('mintPhase', 2n);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Dutch Auction/ }));
    expect(screen.getByText('Close the sale first.')).toBeInTheDocument();
    expect(button(/Set Phase → Dutch Auction/).disabled).toBe(true);
  });

  it('on the fixed template, shows the new-price flag and holds a fixed-price sale until a price is proposed', async () => {
    reads.set('fixedPriceNeedsProposal', true);
    openPanel();
    expect(await screen.findByText(/runs on the template with the 2026-10-14 fixes/)).toBeInTheDocument();
    expect(screen.getByTestId('needs-new-price')).toHaveTextContent('A fixed-price sale needs a new price first.');
    fireEvent.click(screen.getByRole('button', { name: /^Public/ }));
    expect(screen.getByText('Propose a new price first.')).toBeInTheDocument();
    expect(button(/Set Phase → Public/).disabled).toBe(true);
  });

  it('on the fixed template, opens a fixed-price sale once no new price is needed', async () => {
    reads.set('fixedPriceNeedsProposal', false);
    openPanel();
    await waitFor(() => expect(screen.getByTestId('needs-new-price')).toHaveTextContent('No new price needed'));
    fireEvent.click(screen.getByRole('button', { name: /^Public/ }));
    expect(button(/Set Phase → Public/).disabled).toBe(false);
  });

  it('on the template deployed today, says it switches in one step and never reads the flag it lacks', async () => {
    templateHasNewPriceFlag(false);
    openPanel();
    expect(await screen.findByText(/deployed before the 2026-10-14 fixes/)).toBeInTheDocument();
    expect(screen.queryByTestId('needs-new-price')).toBeNull();
    expect(readCalls.filter((c) => c.functionName === 'fixedPriceNeedsProposal').every((c) => !c.enabled)).toBe(true);
  });

  it('says so when the template could not be read', async () => {
    client.getCode.mockRejectedValue(new Error('rpc down'));
    openPanel();
    expect(await screen.findByText('Which template this collection runs on could not be read.')).toBeInTheDocument();
  });
});
