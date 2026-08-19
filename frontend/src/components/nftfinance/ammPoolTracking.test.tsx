// Why "Track a Pool" has to verify before it tracks.
//
// A tracked address is not a bookmark. PoolCard renders a deposit leg against
// whatever address the list holds and sends ETH to it — so an address that
// reaches the list unchecked is a value-write target the app chose for the
// user. The tab shipped with copy promising on-chain verification while the
// handler checked nothing but the 0x-shape of the string.
//
// The factory exposes no isPool getter, so membership is proven in two hops:
// ask the address which collection it serves, then ask the factory whether it
// lists that address for that collection. Both hops are pinned here, along
// with the rule that when the factory cannot be reached the tab says so rather
// than falling through to tracking the address anyway.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { TEGRIDY_NFT_POOL_FACTORY_ADDRESS } from '../../lib/constants';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, info: vi.fn(), warning: vi.fn() },
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

const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }));
const account = { address: '0x1111111111111111111111111111111111111111', isConnected: true };

vi.mock('wagmi', () => ({
  useAccount: () => ({ ...account, isDisconnected: !account.isConnected, chain: { id: 1 } }),
  useChainId: () => 1,
  useBlockNumber: () => ({ data: 1n }),
  usePublicClient: () => ({ readContract, getLogs: vi.fn(async () => []) }),
  useReadContract: () => ({ data: undefined, isError: false, isLoading: false, refetch: vi.fn() }),
  useReadContracts: () => ({ data: [], isError: false, isLoading: false, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
  useWatchContractEvent: () => undefined,
}));

import { AMMSection } from './AMMSection';

const POOL = '0xAAaAAAaaAaAAAaAAaAAAaaaAaaaAaaAAaaAAaaAA';
const COLLECTION = '0xBBbBBBbbBbBBBbBBbBBBbbbBbbbBbbBBbbBBbbBB';
const NOT_A_POOL = '0xCCcCCCccCcCCCcCCcCCCcccCcccCccCCccCCccCC';

/** Factory-registered pool: getPoolInfo answers, factory lists it. */
function stubRegisteredPool() {
  readContract.mockImplementation(async (args: { address: string; functionName: string }) => {
    if (args.functionName === 'getPoolInfo') return [COLLECTION, 2, 1n, 0n, 0n, 0n, account.address, 0n, 0n];
    if (args.functionName === 'getPoolsForCollection') return [POOL];
    throw new Error(`unstubbed ${args.functionName}`);
  });
}

async function openMyPools() {
  renderWithProviders(<AMMSection />);
  fireEvent.click(screen.getByRole('tab', { name: 'My Pools' }));
  return screen.findByPlaceholderText('Pool address (0x...)');
}

async function trackAddress(addr: string) {
  const input = await openMyPools();
  fireEvent.change(input, { target: { value: addr } });
  fireEvent.click(screen.getByText('Track'));
}

describe('tracking a pool', () => {
  beforeEach(() => {
    localStorage.clear();
    readContract.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it('asks the factory whether the address is one of its pools', async () => {
    stubRegisteredPool();
    await trackAddress(POOL);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: POOL, functionName: 'getPoolInfo' }),
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
        functionName: 'getPoolsForCollection',
        args: [COLLECTION],
      }),
    );
    expect(JSON.parse(localStorage.getItem('tegridy-amm-tracked-pools')!)).toEqual([POOL]);
  });

  it('refuses an address the factory does not list, and stores nothing', async () => {
    readContract.mockImplementation(async (args: { functionName: string }) => {
      // A real pool contract — just not one this factory deployed.
      if (args.functionName === 'getPoolInfo') return [COLLECTION, 2, 1n, 0n, 0n, 0n, account.address, 0n, 0n];
      if (args.functionName === 'getPoolsForCollection') return [POOL];
      throw new Error('unstubbed');
    });
    await trackAddress(NOT_A_POOL);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(localStorage.getItem('tegridy-amm-tracked-pools')).toBeNull();
  });

  it('refuses an address that does not answer getPoolInfo at all', async () => {
    // An EOA or a self-destructed pre-relaunch pool: eth_call returns nothing
    // to decode. This must not degrade into tracking it anyway.
    readContract.mockRejectedValue(new Error('returned no data ("0x")'));
    await trackAddress(NOT_A_POOL);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(localStorage.getItem('tegridy-amm-tracked-pools')).toBeNull();
  });

  it('does not claim verification it did not perform', async () => {
    // The old copy asserted "Pool ownership is verified on-chain" over a
    // handler that only regex-checked the string.
    await openMyPools();
    expect(screen.queryByText(/Pool ownership is verified on-chain/)).toBeNull();
  });
});
