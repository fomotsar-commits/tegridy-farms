/**
 * Commit-reveal gauge voting: the salt of the commit that LANDED must survive
 * everything the page does after it.
 *
 * The defect (trunk 15c15817): the page never re-read `commitmentOf` after a
 * commit, so once the commit landed it went on showing the weight sliders and an
 * enabled Commit button. A second click saved a NEW salt over the first before
 * prompting the wallet, the repeat reverted on-chain (AlreadyCommitted), and the
 * browser no longer held a salt that could open the landed commitment. The vote
 * was lost for the epoch.
 *
 * The shared wagmi mock answers every read afresh on every render, which is the
 * one thing this defect needs to be false: a real read stays STALE until
 * something refetches it. So the reads here go through a real TanStack cache
 * (staleTime Infinity, no focus refetch), and change only when the component
 * refetches or the page is opened again with a fresh cache.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { renderWithProviders } from '../test-utils/render';

const h = vi.hoisted(() => {
  const ZERO = `0x${'0'.repeat(64)}` as const;
  type Receipt = 'idle' | 'pending' | 'success' | 'reverted' | 'unread';
  const state = {
    // What the contract holds right now. A read sees it only when it fetches.
    chain: { commitment: ZERO as string, lastVotedEpoch: 0n, revealOpen: false },
    tx: { hash: undefined as `0x${string}` | undefined, receipt: 'idle' as Receipt },
  };
  const listeners = new Set<() => void>();
  return {
    ZERO,
    EPOCH: 7,
    TOKEN_ID: 1n,
    VOTER: '0x9999999999999999999999999999999999999999' as const,
    GC: '0x3333333333333333333333333333333333333333' as const,
    GAUGE_A: '0x1111111111111111111111111111111111111111' as const,
    GAUGE_B: '0x2222222222222222222222222222222222222222' as const,
    state,
    listeners,
    setTx(patch: Partial<typeof state.tx>) {
      state.tx = { ...state.tx, ...patch };
      listeners.forEach((l) => l());
    },
    reads: {} as Record<string, number>,
    writeContract: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  };
});

vi.mock('../lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/constants')>();
  return { ...actual, GAUGE_CONTROLLER_ADDRESS: h.GC, isDeployed: () => true };
});
vi.mock('./ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/useGaugeList', () => ({ useGaugeList: () => ({ gauges: [] }) }));
vi.mock('sonner', () => ({ toast: h.toast }));

vi.mock('wagmi', async () => {
  const React = await import('react');
  const { useQuery } = await import('@tanstack/react-query');

  const readChain = (functionName: string): unknown => {
    const { chain } = h.state;
    h.reads[functionName] = (h.reads[functionName] ?? 0) + 1;
    switch (functionName) {
      case 'currentEpoch': return BigInt(h.EPOCH);
      case 'emissionBudget': return 0n;
      case 'getGauges': return [h.GAUGE_A, h.GAUGE_B];
      case 'EPOCH_DURATION': return 604800n;
      case 'genesisEpoch': return 1_700_000_000n;
      case 'userTokenId': return h.TOKEN_ID;
      case 'positions': return [10n ** 21n, 0n, 0n, 0n, 10000, 0, false, false, 0n];
      case 'lastVotedEpoch': return h.state.chain.lastVotedEpoch;
      case 'isRevealWindowOpen': return [BigInt(h.EPOCH), chain.revealOpen, 1_800_000_000n, 1_800_086_400n];
      case 'commitmentOf': return chain.commitment;
      default: throw new Error(`unmodelled read: ${functionName}`);
    }
  };

  const useTx = () => React.useSyncExternalStore(
    (cb: () => void) => { h.listeners.add(cb); return () => { h.listeners.delete(cb); }; },
    () => h.state.tx,
  );

  return {
    useAccount: () => ({ address: h.VOTER, isConnected: true }),
    useChainId: () => 1,
    useReadContract: (opts: { functionName: string; args?: unknown[]; query?: { enabled?: boolean } }) => {
      const q = useQuery({
        queryKey: ['readContract', opts.functionName, (opts.args ?? []).map(String)],
        queryFn: () => readChain(opts.functionName),
        enabled: opts.query?.enabled !== false,
      });
      return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error, refetch: q.refetch };
    },
    useReadContracts: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useWriteContract: () => {
      const tx = useTx();
      return { writeContract: h.writeContract, data: tx.hash, isPending: false };
    },
    // Real wagmi THROWS on a reverted receipt, so a revert is isError, exactly
    // like a receipt that could not be read at all.
    useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => {
      const tx = useTx();
      const r = hash ? tx.receipt : 'idle';
      return {
        data: r === 'success' ? { status: 'success' as const } : undefined,
        isLoading: r === 'pending',
        isSuccess: r === 'success',
        isError: r === 'reverted' || r === 'unread',
        error: r === 'reverted' || r === 'unread' ? new Error(r) : null,
      };
    },
    useWatchContractEvent: () => undefined,
    usePublicClient: () => undefined,
  };
});

import { GaugeVoting } from './GaugeVoting';

const KEY = `tegridy:gaugeCommit:1:${h.VOTER}:${h.TOKEN_ID}:${h.EPOCH}`;

/** Independent mirror of GaugeController.computeCommitment for this fixture. */
function commitmentOf(gauges: readonly string[], weights: readonly bigint[], salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' },
      { type: 'address[]' }, { type: 'uint256[]' }, { type: 'bytes32' }, { type: 'uint256' },
    ],
    [1n, h.GC, h.VOTER, h.TOKEN_ID, gauges as `0x${string}`[], [...weights], salt, BigInt(h.EPOCH)],
  ));
}

/** A page load: fresh query cache, fresh wallet mutation state. */
function openPage() {
  h.setTx({ hash: undefined, receipt: 'idle' });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  return renderWithProviders(<QueryClientProvider client={qc}><GaugeVoting /></QueryClientProvider>);
}

/** Put 100% on one gauge and press Commit; returns the commitment it sent. */
async function commitAllTo(gauge: string): Promise<Hex> {
  const sliders = await screen.findAllByRole('slider');
  const idx = gauge === h.GAUGE_A ? 0 : 1;
  fireEvent.change(sliders[1 - idx]!, { target: { value: '0' } });
  fireEvent.change(sliders[idx]!, { target: { value: '10000' } });
  const before = h.writeContract.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Commit Vote' }));
  expect(h.writeContract.mock.calls.length).toBe(before + 1);
  const call = h.writeContract.mock.calls.at(-1)![0] as { functionName: string; args: [bigint, Hex] };
  expect(call.functionName).toBe('commitVote');
  return call.args[1];
}

/** Press Reveal and return the commitment its arguments open. */
async function revealedCommitment(): Promise<Hex> {
  fireEvent.click(await screen.findByRole('button', { name: 'Reveal Vote' }));
  const call = h.writeContract.mock.calls.at(-1)![0] as {
    functionName: string; args: [bigint, string[], bigint[], Hex];
  };
  expect(call.functionName).toBe('revealVote');
  const [, gauges, weights, salt] = call.args;
  return commitmentOf(gauges, weights, salt);
}

/**
 * Wait until the page has READ the commitment slot. Without this a test could
 * set the landed commitment before the first read, and that first read, not a
 * refetch, would find it.
 */
async function commitmentRead() {
  const before = h.reads.commitmentOf ?? 0;
  await waitFor(() => expect(h.reads.commitmentOf ?? 0).toBeGreaterThan(before));
  await act(async () => { await Promise.resolve(); });
}

describe('GaugeVoting — commit-reveal keeps the landed commit revealable', () => {
  beforeEach(() => {
    localStorage.clear();
    h.writeContract.mockReset();
    Object.values(h.toast).forEach((f) => f.mockReset());
    for (const k of Object.keys(h.reads)) delete h.reads[k];
    h.state.chain = { commitment: h.ZERO, lastVotedEpoch: 0n, revealOpen: false };
  });

  it('re-reads the commitment when the commit confirms, so Commit is not offered again', async () => {
    openPage();
    await commitmentRead();
    const landed = await commitAllTo(h.GAUGE_A);
    act(() => h.setTx({ hash: '0xa1', receipt: 'pending' }));
    h.state.chain.commitment = landed; // it mines
    act(() => h.setTx({ receipt: 'success' }));

    expect(await screen.findByText(/Your committed ballot/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit Vote' })).toBeNull();
  });

  it('re-reads the commitment when the receipt cannot be read, since the commit may have landed', async () => {
    openPage();
    await commitmentRead();
    const landed = await commitAllTo(h.GAUGE_A);
    act(() => h.setTx({ hash: '0xa1', receipt: 'pending' }));
    h.state.chain.commitment = landed;
    act(() => h.setTx({ receipt: 'unread' }));

    expect(await screen.findByText(/Your committed ballot/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit Vote' })).toBeNull();
  });

  it('a second commit, sent while the page could not see the first, does not destroy the first salt', async () => {
    // Commit A, and close the tab while it is still pending.
    let view = openPage();
    await commitmentRead();
    const first = await commitAllTo(h.GAUGE_A);
    act(() => h.setTx({ hash: '0xa1', receipt: 'pending' }));
    view.unmount();

    // Reopen before it mines: the slot reads EMPTY, so the sliders come back,
    // and the user commits a different ballot.
    view = openPage();
    await commitmentRead();
    const second = await commitAllTo(h.GAUGE_B);
    expect(second).not.toBe(first);
    // The first commit mines; the second reverts with AlreadyCommitted.
    h.state.chain.commitment = first;
    view.unmount();

    // Reveal time, on a fresh load: nothing in this session can help.
    h.state.chain.revealOpen = true;
    openPage();
    expect(await revealedCommitment()).toBe(first);
  });

  it('reveals with the LATER salt when it is the later commit that landed', async () => {
    // Negative control for the test above: "keep the first record" would pass
    // it and fail this. The first commit was rejected in the wallet.
    const view = openPage();
    await commitmentRead();
    await commitAllTo(h.GAUGE_A);
    const second = await commitAllTo(h.GAUGE_B);
    h.state.chain.commitment = second;
    view.unmount();

    h.state.chain.revealOpen = true;
    openPage();
    expect(await revealedCommitment()).toBe(second);
  });

  it('still reveals a record saved by the previous build (one object, not a list)', async () => {
    const salt = `0x${'ab'.repeat(32)}` as Hex;
    const hash = commitmentOf([h.GAUGE_A], [10000n], salt);
    localStorage.setItem(KEY, JSON.stringify({
      salt, gauges: [h.GAUGE_A], weights: ['10000'], commitmentHash: hash, committedAt: 1,
    }));
    h.state.chain = { commitment: hash, lastVotedEpoch: 0n, revealOpen: true };
    openPage();
    expect(await revealedCommitment()).toBe(hash);
  });

  it('does not offer a reveal with a salt that cannot open the on-chain commitment', async () => {
    // This browser saved a salt, but the commitment on-chain is another one
    // (committed from a different browser): a reveal could only revert.
    const view = openPage();
    await commitmentRead();
    await commitAllTo(h.GAUGE_A);
    view.unmount();

    h.state.chain = { commitment: `0x${'ee'.repeat(32)}`, lastVotedEpoch: 0n, revealOpen: true };
    openPage();
    expect(await screen.findByText(/no local salt to reveal it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal Vote' })).toBeNull();
  });

  it('re-reads the vote marker when a reveal confirms, and confirms it once', async () => {
    const view = openPage();
    await commitmentRead();
    const landed = await commitAllTo(h.GAUGE_A);
    view.unmount();

    h.state.chain = { commitment: landed, lastVotedEpoch: 0n, revealOpen: true };
    openPage();
    expect(await revealedCommitment()).toBe(landed);
    act(() => h.setTx({ hash: '0xb2', receipt: 'pending' }));
    // revealVote deletes the commitment and marks the epoch voted.
    h.state.chain.commitment = h.ZERO;
    h.state.chain.lastVotedEpoch = BigInt(h.EPOCH);
    act(() => h.setTx({ receipt: 'success' }));

    expect(await screen.findByText('Vote recorded for this epoch')).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
    expect(h.toast.success.mock.calls.filter(([m]) => m === 'Transaction confirmed')).toHaveLength(1);
  });
});
