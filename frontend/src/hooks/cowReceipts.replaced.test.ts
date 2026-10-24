// The four CoW surfaces' receipt waits: an approval the wallet replaced or that we could
// not read, and a ComposableCoW registration the wallet replaced.
//
// viem's `publicClient.waitForTransactionReceipt` does not fail on a replaced tx: it
// calls `onReplaced`, then RESOLVES with the replacement's receipt (pinned against the
// real client in lib/txErrors.direct.test.ts). A wallet cancel's receipt says success.
// So a cancelled APPROVE went on to sign an order the vault relayer can never pull (an
// open order that can only expire unfilled), and a cancelled REGISTRATION said "TWAP
// registered" / "Stop-loss registered" for an order that does not exist: the one claim
// the stop-loss surface's header says it must never make. An approve whose receipt we
// could not read was a red error; it is "we can't tell, check first", and no order is
// signed on an allowance nobody has seen.
//
// Each test that names a pre-fix failure fails on the pre-fix hooks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WaitForTransactionReceiptTimeoutError } from 'viem';

const { toast, writeContractAsync, signTypedDataAsync, client } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  writeContractAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  client: {
    getCode: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
}));

const SAFE = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const APPROVE_HASH = `0x${'a1'.repeat(32)}` as const;
const CREATE_HASH = `0x${'c1'.repeat(32)}` as const;
const R_HASH = `0x${'ef'.repeat(32)}` as const;
const SELL = `0x${'3'.repeat(40)}` as const;
const BUY = `0x${'4'.repeat(40)}` as const;

vi.mock('sonner', () => ({ toast }));
vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useAccount: () => ({ address: SAFE }),
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContractAsync }),
  useSignTypedData: () => ({ signTypedDataAsync }),
}));
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
// A sell amount, so the approval leg is reachable when the allowance is short.
vi.mock('../lib/triggers/triggerPlan', () => ({ stopLossDataFromLeg: () => ({ sellAmount: 10n ** 18n }) }));
vi.mock('../lib/triggers/stopLossHandler', () => ({
  buildCreateStopLossCalldata: () => '0x',
  encodeStopLossStaticInput: () => '0x',
}));

import { useCowSwap } from './useCowSwap';
import { useCowLimitOrder } from './useCowLimitOrder';
import { useCowTwap } from './useCowTwap';
import { useTriggerOrders } from './useTriggerOrders';
import type { TriggerPlan } from '../lib/triggers/triggerPlan';

/** viem on a replaced tx: onReplaced with the reason, then the REPLACEMENT's success receipt. */
function replacedWait(reason: 'cancelled' | 'repriced') {
  return async (args: { hash: `0x${string}`; onReplaced?: (r: unknown) => void }) => {
    args.onReplaced?.({ reason, replacedTransaction: { hash: args.hash }, transaction: { hash: R_HASH }, transactionReceipt: {} });
    return { status: 'success', transactionHash: R_HASH };
  };
}
const unread = () => Promise.reject(new WaitForTransactionReceiptTimeoutError({ hash: APPROVE_HASH }));
const mined = (hash: string) => Promise.resolve({ status: 'success', transactionHash: hash });

const fetchMock = vi.fn();

beforeEach(() => {
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContractAsync.mockReset();
  signTypedDataAsync.mockReset().mockResolvedValue(`0x${'5'.repeat(130)}`);
  client.getCode.mockReset().mockResolvedValue('0x6080');
  client.readContract.mockReset();
  client.waitForTransactionReceipt.mockReset();
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (String(url).includes('quote')) {
      return new Response(JSON.stringify({
        quote: { sellAmount: '1000000000000000000', buyAmount: '2000000000000000000', feeAmount: '0', validTo: Math.floor(Date.now() / 1000) + 600 },
        id: 7,
      }), { status: 200 });
    }
    return new Response(JSON.stringify('0xuid'), { status: 201 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The approval path: balance is plenty, allowance is zero. */
function needsApproval() {
  client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'allowance' ? 0n : 10n ** 24n);
  writeContractAsync.mockResolvedValue(APPROVE_HASH);
}

const orderPosts = () => fetchMock.mock.calls.filter(([url]) => !String(url).includes('quote'));

const SWAP_PARAMS = {
  sellToken: { symbol: 'SELL', address: SELL, decimals: 18 },
  buyToken: { symbol: 'BUY', address: BUY, decimals: 18 },
  sellAmount: 10n ** 18n,
  slippagePct: 0.5,
};
const LIMIT_PARAMS = {
  sellToken: { symbol: 'SELL', address: SELL, decimals: 18 },
  buyToken: { symbol: 'BUY', address: BUY, decimals: 18 },
  sellAmount: 10n ** 18n,
  buyAmount: 2n * 10n ** 18n,
  expirySeconds: 3600,
};

describe('an APPROVAL the wallet cancelled signs no order', () => {
  it('CoW swap', async () => {
    needsApproval();
    client.waitForTransactionReceipt.mockImplementation(replacedWait('cancelled'));
    const { result } = renderHook(() => useCowSwap());
    let out: unknown;
    await act(async () => { out = await result.current.placeSwap(SWAP_PARAMS); });
    expect(out).toBeNull();
    expect(signTypedDataAsync).not.toHaveBeenCalled();
    expect(orderPosts()).toEqual([]);
    expect(toast.warning).toHaveBeenCalledWith('Transaction cancelled', expect.anything());
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ onReplaced: expect.any(Function) }));
  });

  it('CoW limit order', async () => {
    needsApproval();
    client.waitForTransactionReceipt.mockImplementation(replacedWait('cancelled'));
    const { result } = renderHook(() => useCowLimitOrder());
    let out: unknown;
    await act(async () => { out = await result.current.placeOrder(LIMIT_PARAMS); });
    expect(out).toBeNull();
    expect(signTypedDataAsync).not.toHaveBeenCalled();
    expect(orderPosts()).toEqual([]);
    expect(toast.warning).toHaveBeenCalledWith('Transaction cancelled', expect.anything());
  });
});

describe('an APPROVAL whose receipt we could not read: not an error, and no order on it', () => {
  it('CoW swap', async () => {
    needsApproval();
    client.waitForTransactionReceipt.mockImplementation(unread);
    const { result } = renderHook(() => useCowSwap());
    await act(async () => { await result.current.placeSwap(SWAP_PARAMS); });
    expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything());
    expect(toast.error).not.toHaveBeenCalled();
    expect(signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('CoW limit order', async () => {
    needsApproval();
    client.waitForTransactionReceipt.mockImplementation(unread);
    const { result } = renderHook(() => useCowLimitOrder());
    await act(async () => { await result.current.placeOrder(LIMIT_PARAMS); });
    expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything());
    expect(toast.error).not.toHaveBeenCalled();
    expect(signTypedDataAsync).not.toHaveBeenCalled();
  });

  it('a sped-up approval still lets the order through (the same approve ran)', async () => {
    needsApproval();
    client.waitForTransactionReceipt.mockImplementation(replacedWait('repriced'));
    const { result } = renderHook(() => useCowSwap());
    let out: unknown;
    await act(async () => { out = await result.current.placeSwap(SWAP_PARAMS); });
    expect(out).toBe('0xuid');
    expect(signTypedDataAsync).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

const twapData = {
  sellToken: SELL, buyToken: BUY, receiver: SAFE,
  partSellAmount: 10n ** 18n, minPartLimit: 1n, t0: 0n, n: 4n, t: 3600n, span: 0n,
  appData: `0x${'0'.repeat(64)}` as const,
};
const plan = { valid: true, error: null, kind: 'stop-loss', legs: [{}] } as unknown as TriggerPlan;
const ctx = { sellToken: SELL, buyToken: BUY, receiver: SAFE };

async function submitTwap() {
  const { result } = renderHook(() => useCowTwap());
  await waitFor(() => expect(result.current.walletKind).toBe('contract'));
  let out: unknown;
  await act(async () => { out = await result.current.submitTwap(twapData); });
  return out;
}
async function submitStopLoss() {
  const { result } = renderHook(() => useTriggerOrders({ kind: 'stop-loss', sellToken: SELL, buyToken: BUY }));
  await waitFor(() => expect(client.getCode).toHaveBeenCalled());
  let out: unknown;
  await act(async () => { out = await result.current.submit(plan, ctx); });
  return out;
}

describe.each([
  ['TWAP', submitTwap, /TWAP registered/],
  ['stop-loss', submitStopLoss, /Stop-loss registered/],
] as const)('%s registration', (_name, submit, registered) => {
  it('a cancelled APPROVAL registers nothing', async () => {
    needsApproval();
    client.waitForTransactionReceipt.mockImplementation(replacedWait('cancelled'));
    expect(await submit()).toBeNull();
    expect(writeContractAsync).toHaveBeenCalledTimes(1); // the approve; no create
    expect(toast.warning).toHaveBeenCalledWith('Transaction cancelled', expect.anything());
  });

  it('a cancelled REGISTRATION is never called registered', async () => {
    client.readContract.mockResolvedValue(2n ** 255n); // allowance already set
    writeContractAsync.mockResolvedValue(CREATE_HASH);
    client.waitForTransactionReceipt.mockImplementation(replacedWait('cancelled'));
    expect(await submit()).toBeNull();
    const said = toast.success.mock.calls.map((c) => String(c[0]));
    expect(said.filter((m) => registered.test(m))).toEqual([]);
    expect(toast.warning).toHaveBeenCalledWith('Transaction cancelled', expect.objectContaining({
      description: expect.stringContaining(CREATE_HASH.slice(0, 10)),
    }));
  });

  it('a sped-up registration is registered, under the hash that mined', async () => {
    client.readContract.mockResolvedValue(2n ** 255n);
    writeContractAsync.mockResolvedValue(CREATE_HASH);
    client.waitForTransactionReceipt.mockImplementation(replacedWait('repriced'));
    const out = await submit();
    expect(out).toMatchObject({ txHash: R_HASH });
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(registered));
  });

  it('an approval that mined, then a registration that mined: registered (control)', async () => {
    needsApproval();
    writeContractAsync.mockResolvedValueOnce(APPROVE_HASH).mockResolvedValueOnce(CREATE_HASH);
    client.waitForTransactionReceipt.mockImplementation(({ hash }: { hash: string }) => mined(hash));
    expect(await submit()).toMatchObject({ txHash: CREATE_HASH });
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(registered));
  });
});
