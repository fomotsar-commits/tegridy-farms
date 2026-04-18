/**
 * Shared wagmi mock scaffolding for hook unit tests.
 *
 * Why this exists:
 *   Hook-level tests don't want to stand up a real WagmiConfig provider +
 *   viem transport for every spec. Instead we `vi.mock('wagmi', ...)` with
 *   a controllable surface, set per-test responses, and assert on what the
 *   hook does with them.
 *
 * Usage:
 *   // At the top of your test file — just import this module. The vi.mock
 *   // for `wagmi` is installed as a side effect at the top level (required
 *   // for Vitest hoisting to recognise it).
 *   import { wagmiMock } from '@/test-utils/wagmi-mocks';
 *   import { describe, it, expect, beforeEach } from 'vitest';
 *   import { useMyHook } from './useMyHook';
 *
 *   describe('useMyHook', () => {
 *     beforeEach(() => wagmiMock.reset());
 *     it('does the thing', () => {
 *       wagmiMock.setAccount({ address: '0xabc…', isConnected: true });
 *       wagmiMock.setReadResult({ functionName: 'balanceOf', result: 1000n });
 *       // render / call hook ...
 *     });
 *   });
 *
 * Design:
 *   - All state lives on `wagmiMock` so tests can manipulate between renders.
 *   - `useReadContract` / `useReadContracts` match by functionName and/or
 *     address; `addReadPredicate` supports fully custom matchers.
 *   - `useReadContracts` returns `status: 'failure'` when no stub matches so
 *     consuming hooks cleanly fall back to their defaults.
 *   - `useWriteContract` exposes a Vitest mock fn you can assert against to
 *     verify the hook's action functions actually call the right args.
 *   - `useWaitForTransactionReceipt` returns flags the test sets via
 *     `setWriteStatus`.
 */
import { vi } from 'vitest';

export type Address = `0x${string}`;

interface ReadStub {
  match: (spec: { functionName?: string; address?: string }) => boolean;
  result: unknown;
  status?: 'success' | 'failure';
}

interface AccountState {
  address?: Address;
  isConnected: boolean;
}

interface WriteStatus {
  isPending: boolean;
  isConfirming: boolean;
  isSuccess: boolean;
  isTxError: boolean;
  hash?: Address;
}

interface WagmiMockState {
  account: AccountState;
  reads: ReadStub[];
  writeStatus: WriteStatus;
  writeContractMock: ReturnType<typeof vi.fn>;
  chainId: number;
}

function defaultWriteStatus(): WriteStatus {
  return { isPending: false, isConfirming: false, isSuccess: false, isTxError: false };
}

function defaultState(): WagmiMockState {
  return {
    account: { isConnected: false },
    reads: [],
    writeStatus: defaultWriteStatus(),
    writeContractMock: vi.fn(),
    chainId: 1,
  };
}

const state: WagmiMockState = defaultState();

export const wagmiMock = {
  reset() {
    const next = defaultState();
    state.account = next.account;
    state.reads = next.reads;
    state.writeStatus = next.writeStatus;
    state.writeContractMock.mockReset();
    state.chainId = next.chainId;
  },
  setAccount(partial: Partial<AccountState>) {
    state.account = { ...state.account, ...partial };
  },
  setChainId(id: number) {
    state.chainId = id;
  },
  setReadResult(stub: { functionName?: string; address?: string; result: unknown; status?: 'success' | 'failure' }) {
    state.reads.push({
      match: (spec) => {
        if (stub.functionName && spec.functionName !== stub.functionName) return false;
        if (stub.address && spec.address?.toLowerCase() !== stub.address.toLowerCase()) return false;
        return true;
      },
      result: stub.result,
      status: stub.status ?? 'success',
    });
  },
  addReadPredicate(predicate: ReadStub) {
    state.reads.push(predicate);
  },
  setWriteStatus(partial: Partial<WriteStatus>) {
    state.writeStatus = { ...state.writeStatus, ...partial };
  },
  /** Get the Vitest mock for the `writeContract` callback — assert args against it. */
  writeContract: () => state.writeContractMock,
};

function findRead(spec: { functionName?: string; address?: string }): ReadStub | undefined {
  // Last match wins — tests can stack overrides.
  for (let i = state.reads.length - 1; i >= 0; i--) {
    if (state.reads[i].match(spec)) return state.reads[i];
  }
  return undefined;
}

// The vi.mock factory is at module top-level so Vitest hoists it correctly.
// Tests simply `import { wagmiMock } from './test-utils/wagmi-mocks'` at the
// top of their file to activate the mock, then manipulate `wagmiMock` state
// inside their describe blocks.
vi.mock('wagmi', () => {
  const useAccount = () => ({
    address: state.account.address,
    isConnected: state.account.isConnected,
    isConnecting: false,
    isDisconnected: !state.account.isConnected,
    chain: { id: state.chainId },
  });

  const useChainId = () => state.chainId;

  const useReadContract = (opts: { address?: string; functionName?: string; args?: unknown[] }) => {
    const stub = findRead({ address: opts?.address, functionName: opts?.functionName });
    if (!stub) {
      return { data: undefined, error: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    }
    if (stub.status === 'failure') {
      return { data: undefined, error: new Error('read failed'), isLoading: false, isError: true, refetch: vi.fn() };
    }
    return { data: stub.result, error: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  };

  const useReadContracts = (opts: { contracts?: Array<{ address?: string; functionName?: string }> }) => {
    const arr = (opts?.contracts ?? []).map((c) => {
      const stub = findRead({ address: c?.address, functionName: c?.functionName });
      // No matching stub => simulate a failed read so consumers fall back
      // to their default values.
      if (!stub) return { status: 'failure' as const, error: new Error('no stub configured') };
      if (stub.status === 'failure') return { status: 'failure' as const, error: new Error('read failed') };
      return { status: 'success' as const, result: stub.result };
    });
    return { data: arr, error: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  };

  const useWriteContract = () => ({
    writeContract: state.writeContractMock,
    data: state.writeStatus.hash,
    isPending: state.writeStatus.isPending,
    error: state.writeStatus.isTxError ? new Error('write failed') : undefined,
    reset: vi.fn(),
  });

  const useWaitForTransactionReceipt = () => ({
    isLoading: state.writeStatus.isConfirming,
    isSuccess: state.writeStatus.isSuccess,
    isError: state.writeStatus.isTxError,
  });

  return {
    useAccount,
    useChainId,
    useReadContract,
    useReadContracts,
    useWriteContract,
    useWaitForTransactionReceipt,
  };
});

/**
 * Deprecated no-op — kept so existing imports don't break. The mock is now
 * installed at module import time via the top-level `vi.mock` above.
 * @deprecated Just importing `wagmi-mocks` is enough; remove calls to this.
 */
export function installWagmiMocks(): void {
  /* no-op: vi.mock is hoisted automatically from module top level. */
}
