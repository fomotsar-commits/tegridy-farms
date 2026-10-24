// ComposableCoW registration (TWAP, stop-loss) whose receipt could not be read.
//
// viem's `publicClient.waitForTransactionReceipt` RETURNS a reverted receipt, which
// both hooks already check. It throws only when the receipt could not be read: a
// 180s timeout, a node that has not indexed it, or, on these Safe-only surfaces, a
// Safe that handed back a queue hash that is not mined yet. Both hooks sent that to
// the generic catch, which toasted viem's error in red and left the form armed, so
// one more click registered a SECOND conditional order selling the same amount.
//
// The unread case must get the unconfirmed warning with the hash instead. The first
// test in each block fails on the pre-fix hook; the revert tests pin the branch that
// did not change.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WaitForTransactionReceiptTimeoutError } from 'viem';

const { toast, writeContractAsync, client } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  writeContractAsync: vi.fn(),
  client: {
    getCode: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
}));

const SAFE = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const HASH = `0x${'77'.repeat(32)}` as const;
const SELL = `0x${'3'.repeat(40)}` as const;
const BUY = `0x${'4'.repeat(40)}` as const;

vi.mock('sonner', () => ({ toast }));
vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useAccount: () => ({ address: SAFE }),
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContractAsync }),
}));
// The trigger surface only registers when an operator has configured a handler and
// both feeds; stand that configuration in so the create path is reachable.
vi.mock('../lib/triggers/armState', () => ({
  triggerArmState: () => ({
    armed: true,
    path: 'safe-composable-cow',
    blockers: [],
    handler: `0x${'5'.repeat(40)}`,
    sellFeed: { token: SELL, feed: `0x${'6'.repeat(40)}` },
    buyFeed: { token: BUY, feed: `0x${'7'.repeat(40)}` },
  }),
}));
vi.mock('../lib/triggers/triggerPlan', () => ({ stopLossDataFromLeg: () => ({}) }));
vi.mock('../lib/triggers/stopLossHandler', () => ({
  buildCreateStopLossCalldata: () => '0x',
  encodeStopLossStaticInput: () => '0x',
}));

import { useCowTwap } from './useCowTwap';
import { useTriggerOrders } from './useTriggerOrders';
import type { TriggerPlan } from '../lib/triggers/triggerPlan';

const twapData = {
  sellToken: SELL, buyToken: BUY, receiver: SAFE,
  partSellAmount: 10n ** 18n, minPartLimit: 1n, t0: 0n, n: 4n, t: 3600n, span: 0n,
  appData: `0x${'0'.repeat(64)}` as const,
};
const plan = { valid: true, error: null, kind: 'stop-loss', legs: [{}] } as unknown as TriggerPlan;
const ctx = { sellToken: SELL, buyToken: BUY, receiver: SAFE };

beforeEach(() => {
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContractAsync.mockReset().mockResolvedValue(HASH);
  client.getCode.mockReset().mockResolvedValue('0x6080');
  client.readContract.mockReset().mockResolvedValue(2n ** 255n); // allowance already set
  client.waitForTransactionReceipt.mockReset();
});

function expectUnconfirmedNotFailed() {
  expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
    description: expect.stringContaining(HASH.slice(0, 10)),
  }));
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
}

describe('useCowTwap — registration receipt', () => {
  async function submit() {
    const { result } = renderHook(() => useCowTwap());
    await waitFor(() => expect(result.current.walletKind).toBe('contract'));
    let out: unknown;
    await act(async () => { out = await result.current.submitTwap(twapData); });
    return out;
  }

  it('an unread receipt is unconfirmed, not an error', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new WaitForTransactionReceiptTimeoutError({ hash: HASH }));
    const out = await submit();
    expectUnconfirmedNotFailed();
    expect(out).toBeNull(); // never reported as registered
  });

  it('a reverted receipt still says the TWAP is not active', async () => {
    client.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    expect(await submit()).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/reverted on-chain.*NOT active/));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('useTriggerOrders — registration receipt', () => {
  async function submit() {
    const { result } = renderHook(() => useTriggerOrders({ kind: 'stop-loss', sellToken: SELL, buyToken: BUY }));
    await waitFor(() => expect(client.getCode).toHaveBeenCalled());
    let out: unknown;
    await act(async () => { out = await result.current.submit(plan, ctx); });
    return out;
  }

  it('an unread receipt is unconfirmed, not an error', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new WaitForTransactionReceiptTimeoutError({ hash: HASH }));
    const out = await submit();
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    expectUnconfirmedNotFailed();
    expect(out).toBeNull();
  });

  it('a reverted receipt still says the stop-loss is not active', async () => {
    client.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    expect(await submit()).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/reverted on-chain.*NOT active/));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
