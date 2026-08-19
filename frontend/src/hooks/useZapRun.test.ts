// The zap driver, exercised on the endings that cost money.
//
// The machine's own tests prove what a run MEANS. These prove the driver reaches those
// meanings from real wallet behaviour: a receipt that never arrives, a batch the wallet
// will not describe, a page that was closed mid-flight. Every one of them ends with the
// same question — did the driver send anything it should not have.
//
// wagmi is mocked locally rather than through test-utils/wagmi-mocks: the shared mock's
// useAccount exposes no `connector`, and the connector's EIP-1193 provider is the surface
// under test.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { CHAIN_ID, SWAP_FEE_ROUTER_ADDRESS, TOWELI_ADDRESS, WETH_ADDRESS } from '../lib/constants';
import { planZap, type ZapDescriptor, type ZapPlan } from '../lib/zap/planner';
import { loadZapRun, saveZapRun, zapRunKey } from '../lib/zap/persistence';
import { applyZapEvent, initialRunState } from '../lib/zap/machine';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;

const state = vi.hoisted(() => ({
  address: undefined as `0x${string}` | undefined,
  chainId: 1,
  request: null as null | ((args: { method: string; params?: unknown[] }) => Promise<unknown>),
  balances: {} as Record<string, bigint>,
  allowance: 0n,
  receipts: {} as Record<string, { status: string } | Error>,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: state.address,
    isConnected: !!state.address,
    connector: state.request ? { getProvider: () => Promise.resolve({ request: state.request! }) } : undefined,
  }),
  useChainId: () => state.chainId,
  usePublicClient: () => ({
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (functionName === 'allowance') return state.allowance;
      return state.balances[address.toLowerCase()] ?? 0n;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = state.receipts[hash];
      if (r instanceof Error) throw r;
      return r ?? { status: 'success' };
    },
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = state.receipts[hash];
      if (r instanceof Error) throw r;
      return r ?? null;
    },
  }),
}));

import { useZapRun } from './useZapRun';

function toweliLockPlan(): ZapPlan {
  const d: ZapDescriptor = {
    venueId: 'staking-lock',
    account: WALLET,
    chainId: 1,
    inputToken: TOWELI_ADDRESS,
    inputSymbol: 'TOWELI',
    inputIsNative: false,
    amountIn: (100n * 10n ** 18n).toString(),
    slippageBps: 50,
    lockDurationSeconds: '7776000',
  };
  const r = planZap(d, { toTowelie: null }, 1);
  if (!r.ok) throw new Error(r.detail);
  return r.plan;
}

function usdcLockPlan(): ZapPlan {
  const d: ZapDescriptor = {
    venueId: 'staking-lock',
    account: WALLET,
    chainId: 1,
    inputToken: USDC,
    inputSymbol: 'USDC',
    inputIsNative: false,
    amountIn: '1000000000',
    slippageBps: 50,
    lockDurationSeconds: '7776000',
  };
  const r = planZap(
    d,
    {
      toTowelie: {
        executor: SWAP_FEE_ROUTER_ADDRESS,
        executorTakesMaxFee: true,
        amountIn: 1_000_000_000n,
        minOut: 10n ** 21n,
        path: [USDC, WETH_ADDRESS, TOWELI_ADDRESS],
        slippageBps: 50,
      },
    },
    1,
  );
  if (!r.ok) throw new Error(r.detail);
  return r.plan;
}

/** An EIP-1193 stub. `sent` records every write the driver attempted. */
function stubWallet(options: {
  capabilities?: unknown;
  hashes?: string[];
  sendError?: unknown;
  callsStatus?: unknown;
  onSend?: (args: { method: string; params?: unknown[] }) => void;
}) {
  const sent: { method: string; params?: unknown[] }[] = [];
  let hashIndex = 0;
  state.request = async (args) => {
    if (args.method === 'wallet_getCapabilities') {
      if (options.capabilities === undefined) throw new Error('Method not found');
      return options.capabilities;
    }
    if (args.method === 'wallet_getCallsStatus') return options.callsStatus;
    sent.push(args);
    options.onSend?.(args);
    if (options.sendError !== undefined) throw options.sendError;
    if (args.method === 'wallet_sendCalls') return { id: '0xbatch' };
    return options.hashes?.[hashIndex++] ?? `0xhash${hashIndex}`;
  };
  return sent;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe('useZapRun — a clean sequential run', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('sends each leg in order and reports complete only when all of them landed', async () => {
    const plan = toweliLockPlan();
    const sent = stubWallet({ hashes: ['0xa', '0xb'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    expect(result.current.canBatch).toBe(false);

    await act(async () => {
      await result.current.start();
    });
    expect(sent.map((s) => s.method)).toEqual(['eth_sendTransaction', 'eth_sendTransaction']);
    expect(result.current.readout?.isComplete).toBe(true);
    expect(result.current.readout?.tone).toBe('success');
  });

  it('skips an approval the allowance already covers, and still reports complete', async () => {
    const plan = toweliLockPlan();
    state.allowance = 10n ** 30n;
    const sent = stubWallet({ hashes: ['0xa'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(sent).toHaveLength(1);
    expect(result.current.run?.steps[0]!.status).toBe('skipped');
    expect(result.current.readout?.isComplete).toBe(true);
  });
});

describe('useZapRun — a leg that reverts', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('stops there, never claims success, and offers a resume at that leg', async () => {
    const plan = toweliLockPlan();
    state.receipts = { '0xb': { status: 'reverted' } };
    const sent = stubWallet({ hashes: ['0xa', '0xb'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.readout?.isComplete).toBe(false);
    expect(result.current.run?.steps[1]!.status).toBe('reverted');
    expect(result.current.resume).toEqual({ kind: 'resume', fromStep: 1 });

    // Resuming re-sends ONLY the reverted leg — the confirmed approval is not repeated.
    state.receipts = {};
    const before = sent.length;
    await act(async () => {
      await result.current.resumeRun();
    });
    expect(sent.length - before).toBe(1);
    expect(result.current.readout?.isComplete).toBe(true);
  });
});

describe('useZapRun — a receipt that never arrives', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('records the leg as unread, blocks the resume, and sends nothing more', async () => {
    const plan = toweliLockPlan();
    state.receipts = { '0xa': new Error('timed out waiting for receipt') };
    const sent = stubWallet({ hashes: ['0xa', '0xb'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.run?.steps[0]!.status).toBe('unknown');
    expect(result.current.readout?.isComplete).toBe(false);
    expect(result.current.readout?.tone).toBe('danger');
    expect(result.current.resume?.kind).toBe('blocked');
    expect(sent).toHaveLength(1);

    // The resume button cannot get past it — this is the double-spend guard.
    await act(async () => {
      await result.current.resumeRun();
    });
    expect(sent).toHaveLength(1);
  });

  it('unblocks once the chain is read for that leg, and resumes without repeating it', async () => {
    const plan = toweliLockPlan();
    state.receipts = { '0xa': new Error('timed out') };
    const sent = stubWallet({ hashes: ['0xa', '0xb'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.resume?.kind).toBe('blocked');

    // The receipt exists after all — the approval did land.
    state.receipts = { '0xa': { status: 'success' } };
    await act(async () => {
      await result.current.verifyStep(0);
    });
    expect(result.current.run?.steps[0]!.status).toBe('confirmed');

    state.receipts = {};
    const before = sent.length;
    await act(async () => {
      await result.current.resumeRun();
    });
    expect(sent.length - before).toBe(1);
    expect(result.current.readout?.isComplete).toBe(true);
  });

  it('leaves the leg unread when the lookup itself fails — a failed read proves nothing', async () => {
    const plan = toweliLockPlan();
    state.receipts = { '0xa': new Error('timed out') };
    stubWallet({ hashes: ['0xa'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.verifyStep(0);
    });
    expect(result.current.run?.steps[0]!.status).toBe('unknown');
    expect(result.current.resume?.kind).toBe('blocked');
  });

  it('treats a send error with no hash as unread, not as a rejection', async () => {
    // A wallet that throws after relaying is indistinguishable from one that threw before.
    const plan = toweliLockPlan();
    stubWallet({ sendError: new Error('network error while sending') });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.run?.steps[0]!.status).toBe('unknown');
    expect(result.current.resume?.kind).toBe('blocked');
  });

  it('treats an explicit user rejection as inert, because nothing was broadcast', async () => {
    const plan = toweliLockPlan();
    stubWallet({ sendError: Object.assign(new Error('User rejected the request'), { code: 4001 }) });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.run?.steps[0]!.status).toBe('rejected');
    expect(result.current.resume).toEqual({ kind: 'resume', fromStep: 0 });
  });
});

describe('useZapRun — a page that went away mid-flight', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('restores an in-flight leg as unread, never as never-sent', async () => {
    const plan = toweliLockPlan();
    // Exactly what the previous tab wrote: a leg submitted, no receipt recorded.
    const stored = applyZapEvent(initialRunState(plan, { towelie: 0n, lp: 0n }, 1), {
      type: 'submitted',
      steps: [0],
      txHash: '0xa',
      at: 2,
    });
    saveZapRun(plan.descriptor, stored);
    expect(loadZapRun(WALLET, 1).kind).toBe('run');

    stubWallet({ hashes: ['0xz'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();

    expect(result.current.run?.steps[0]!.status).toBe('unknown');
    expect(result.current.resume?.kind).toBe('blocked');
    expect(result.current.readout?.isComplete).toBe(false);
  });

  it('refuses to resume a stored run whose plan no longer matches', async () => {
    const stored = toweliLockPlan();
    saveZapRun(stored.descriptor, initialRunState(stored, { towelie: 0n, lp: 0n }, 1));

    // The same wallet composes a DIFFERENT zap. The stored record must not attach to it.
    const other = usdcLockPlan();
    stubWallet({ hashes: ['0xz'] });
    const { result } = renderHook(() => useZapRun(other));
    await settle();
    expect(result.current.run).toBeNull();
    expect(result.current.blockedReason).toMatch(/Check your balances/);
  });
});

describe('useZapRun — an unfinished run the composer has moved past', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  /** A run stopped halfway: leg 0 confirmed, leg 1 reverted. */
  function strandedRecord() {
    const stored = toweliLockPlan();
    let stranded = initialRunState(stored, { towelie: 0n, lp: 0n }, 1);
    stranded = applyZapEvent(stranded, { type: 'confirmed', steps: [0], txHash: '0xa', at: 2 });
    stranded = applyZapEvent(stranded, { type: 'reverted', steps: [1], txHash: '0xb', detail: 'paused', at: 3 });
    saveZapRun(stored.descriptor, stranded);
    return stored;
  }

  it('is surfaced rather than buried when the composer moves to a different zap', async () => {
    strandedRecord();
    stubWallet({ hashes: ['0xz'] });
    const { result } = renderHook(() => useZapRun(usdcLockPlan()));
    await settle();
    expect(result.current.orphanedRun).not.toBeNull();
    expect(result.current.orphanedRun!.summary).toMatch(/TOWELI/);
  });

  it('refuses to start a new zap over it, so the record is never silently overwritten', async () => {
    strandedRecord();
    const sent = stubWallet({ hashes: ['0xz'] });
    const { result } = renderHook(() => useZapRun(usdcLockPlan()));
    await settle();

    await act(async () => {
      await result.current.start();
    });
    expect(sent).toHaveLength(0);
    expect(result.current.blockedReason).toMatch(/would overwrite/);
    // The stranded record is still exactly where it was.
    const loaded = loadZapRun(WALLET, CHAIN_ID);
    expect((loaded as { record: { run: { steps: { status: string }[] } } }).record.run.steps[0]!.status).toBe(
      'confirmed',
    );
  });

  it('lets a new zap start once the stranded one is forgotten', async () => {
    strandedRecord();
    const sent = stubWallet({ hashes: ['0x1', '0x2', '0x3', '0x4'] });
    const { result } = renderHook(() => useZapRun(usdcLockPlan()));
    await settle();
    act(() => result.current.discard());
    expect(result.current.orphanedRun).toBeNull();

    await act(async () => {
      await result.current.start();
    });
    expect(sent.length).toBeGreaterThan(0);
  });

  it('does not treat a FINISHED run as something to protect', async () => {
    const stored = toweliLockPlan();
    let done = initialRunState(stored, { towelie: 0n, lp: 0n }, 1);
    done = applyZapEvent(done, { type: 'confirmed', steps: [0, 1], txHash: '0xa', at: 2 });
    saveZapRun(stored.descriptor, done);

    const sent = stubWallet({ hashes: ['0x1', '0x2', '0x3', '0x4'] });
    const { result } = renderHook(() => useZapRun(usdcLockPlan()));
    await settle();
    expect(result.current.orphanedRun).toBeNull();
    await act(async () => {
      await result.current.start();
    });
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe('useZapRun — a stage that cannot be bound', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('sends nothing and says why, when the previous leg produced nothing measurable', async () => {
    // The swap confirms but the TOWELI balance never moves — a fee-on-transfer surprise, a
    // reorg, a wrong token. The deposit leg must not be sent against a made-up amount.
    const plan = usdcLockPlan();
    const sent = stubWallet({ hashes: ['0xa', '0xb', '0xc', '0xd'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });

    expect(sent).toHaveLength(2); // stage 0 only: approve + swap
    expect(result.current.blockedReason).toMatch(/has not produced anything measurable/);
    expect(result.current.readout?.isComplete).toBe(false);
    // Nothing in stage 1 moved status, so the run is resumable once the balance is there.
    expect(result.current.run?.steps[2]!.status).toBe('pending');
  });

  it('binds the deposit to the delta once the balance moves, and finishes', async () => {
    const plan = usdcLockPlan();
    const captured: unknown[] = [];
    const sent = stubWallet({
      hashes: ['0xa', '0xb', '0xc', '0xd'],
      onSend: (args) => captured.push(args.params),
    });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(sent).toHaveLength(2);

    // The swap's output shows up.
    state.balances = { [TOWELI_ADDRESS.toLowerCase()]: 1234n };
    await act(async () => {
      await result.current.resumeRun();
    });
    expect(sent).toHaveLength(4);
    expect(result.current.readout?.isComplete).toBe(true);
  });
});

describe('useZapRun — batching', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('groups a stage into one wallet_sendCalls when the wallet advertises it', async () => {
    const plan = toweliLockPlan();
    const sent = stubWallet({
      capabilities: { '0x1': { atomic: { status: 'supported' } } },
      callsStatus: { status: 200, receipts: [{ status: '0x1', transactionHash: '0xbatchtx' }] },
    });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    expect(result.current.canBatch).toBe(true);

    await act(async () => {
      await result.current.start();
    });
    expect(sent.map((s) => s.method)).toEqual(['wallet_sendCalls']);
    expect(result.current.readout?.isComplete).toBe(true);
  });

  it('records a partially-executed batch per call, and resumes at the one that reverted', async () => {
    const plan = toweliLockPlan();
    stubWallet({
      capabilities: { '0x1': { atomic: { status: 'supported' } } },
      callsStatus: {
        status: 200,
        receipts: [
          { status: '0x1', transactionHash: '0xok' },
          { status: '0x0', transactionHash: '0xbad' },
        ],
      },
    });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.run?.steps[0]!.status).toBe('confirmed');
    expect(result.current.run?.steps[1]!.status).toBe('reverted');
    expect(result.current.readout?.isComplete).toBe(false);
    expect(result.current.resume).toEqual({ kind: 'resume', fromStep: 1 });
  });

  it('marks every leg of an undescribable batch unread rather than guessing', async () => {
    const plan = toweliLockPlan();
    stubWallet({
      capabilities: { '0x1': { atomic: { status: 'ready' } } },
      callsStatus: { status: 500 },
    });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.run?.steps.map((s) => s.status)).toEqual(['unknown', 'unknown']);
    expect(result.current.resume?.kind).toBe('blocked');
  });
});

describe('useZapRun — the record', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('is written as the run moves, so a reload after a revert still finds it', async () => {
    const plan = toweliLockPlan();
    state.receipts = { '0xb': { status: 'reverted' } };
    stubWallet({ hashes: ['0xa', '0xb'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    const loaded = loadZapRun(WALLET, CHAIN_ID);
    expect(loaded.kind).toBe('run');
    expect((loaded as { record: { run: { steps: { status: string }[] } } }).record.run.steps[1]!.status).toBe('reverted');
  });

  it('warns when the browser will not store it, before anything is signed', async () => {
    const plan = toweliLockPlan();
    stubWallet({ hashes: ['0xa', '0xb'] });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.persisted).toBe(false);
    expect(result.current.persistWarning).toMatch(/check your balances by hand/i);
    vi.restoreAllMocks();
  });

  it('clears on discard without claiming anything was undone', async () => {
    const plan = toweliLockPlan();
    stubWallet({ hashes: ['0xa', '0xb'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(localStorage.getItem(zapRunKey(WALLET, CHAIN_ID))).not.toBeNull();
    act(() => result.current.discard());
    expect(result.current.run).toBeNull();
    expect(localStorage.getItem(zapRunKey(WALLET, CHAIN_ID))).toBeNull();
  });
});

describe('useZapRun — wrong chain and no wallet', () => {
  beforeEach(() => {
    localStorage.clear();
    state.address = WALLET;
    state.chainId = CHAIN_ID;
    state.balances = {};
    state.allowance = 0n;
    state.receipts = {};
  });

  it('sends nothing while the wallet is on another chain', async () => {
    const plan = toweliLockPlan();
    state.chainId = 8453;
    const sent = stubWallet({ hashes: ['0xa'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(sent).toHaveLength(0);
    expect(result.current.run).toBeNull();
    expect(result.current.canBatch).toBe(false);
  });

  it('sends nothing with no wallet connected', async () => {
    const plan = toweliLockPlan();
    state.address = undefined;
    const sent = stubWallet({ hashes: ['0xa'] });
    const { result } = renderHook(() => useZapRun(plan));
    await settle();
    await act(async () => {
      await result.current.start();
    });
    expect(sent).toHaveLength(0);
  });
});
