/**
 * VoteIncentives commit-reveal: every Reveal the page offers must be one the
 * contract accepts, and every landed commit this browser can open must be offered.
 *
 * The defect (trunk f0e3ca7b): `handleCommitVote` saved each commit with
 * `commitIndex = <length of this browser's list>`, before the wallet had even
 * answered, and the Reveal button sent that number to `revealVote`. The contract
 * numbers ONLY the commits that land (`commitIndex = voterCommits[user][epoch]
 * .length`, then push), so one commit rejected in the wallet (or reverted, or
 * made from another browser) shifted every later record off its on-chain slot.
 * The real commit's reveal then reverted (CommitNotFound / CommitHashMismatch),
 * and its 10 TOWELI bond is swept to treasury after the reveal deadline. The
 * phantom record showed a Reveal button of its own.
 *
 * The contract below is a model of exactly the checks `revealVote` makes
 * (VoteIncentives.sol: index in range, not revealed, hash at THAT index), so the
 * tests pin the invariant rather than a literal index.
 *
 * The shared wagmi mock answers every read afresh on every render, so it cannot
 * express a stale read. Reads here go through a real TanStack cache (staleTime
 * Infinity, no focus refetch) and change only when the component refetches or a
 * page is opened with a fresh cache.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { renderWithProviders } from '../../test-utils/render';

const h = vi.hoisted(() => {
  type Commit = { commitHash: string; bond: bigint; revealed: boolean };
  const state = {
    // What the contract holds right now, for (VOTER, EPOCH). A read sees it only when it fetches.
    chain: { commits: [] as Commit[], countFails: false, slotFails: -1 },
    tx: { isPending: false, isConfirming: false },
    epochTs: 0,
  };
  const listeners = new Set<() => void>();
  return {
    EPOCH: 4,
    VOTER: '0x9999999999999999999999999999999999999999' as const,
    VI: '0x4444444444444444444444444444444444444444' as const,
    PAIR_A: '0x1111111111111111111111111111111111111111' as const,
    PAIR_B: '0x2222222222222222222222222222222222222222' as const,
    BOND: 10n ** 19n,
    state,
    listeners,
    setTx(patch: Partial<typeof state.tx>) {
      state.tx = { ...state.tx, ...patch };
      listeners.forEach((l) => l());
    },
    reads: {} as Record<string, number>,
    commitVote: vi.fn(),
    revealVote: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  };
});

vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/constants')>();
  return { ...actual, VOTE_INCENTIVES_ADDRESS: h.VI };
});
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('../../hooks/useGaugeList', () => ({
  useGaugeList: () => ({
    gauges: [
      { pair: h.PAIR_A, label: 'AAA / WETH', weight: 0n, relativeWeight: 0n, emission: 0n },
      { pair: h.PAIR_B, label: 'BBB / WETH', weight: 0n, relativeWeight: 0n, emission: 0n },
    ],
    isLoading: false,
  }),
}));

vi.mock('../../hooks/useBribes', async () => {
  const React = await import('react');
  return {
    useBribes: () => {
      const tx = React.useSyncExternalStore(
        (cb: () => void) => { h.listeners.add(cb); return () => { h.listeners.delete(cb); }; },
        () => h.state.tx,
      );
      const noop = () => {};
      return {
        isDeployed: true,
        epochCount: h.EPOCH + 1,
        currentEpoch: h.EPOCH + 1, // the section votes in currentEpoch - 1
        bribeFeeBps: 300, pendingFeeBps: 0, feeChangeTime: 0,
        commitRevealEnabled: true,
        commitBond: h.BOND,
        minBribeGlobal: 0n,
        latestEpoch: { totalPower: 0n, timestamp: h.state.epochTs, usesCommitReveal: true },
        whitelistedTokens: [], claimableTokens: [],
        toweliAllowance: 10n ** 30n,
        claimBribes: noop, claimBribesBatch: noop, advanceEpoch: noop, vote: noop,
        commitVote: h.commitVote,
        revealVote: h.revealVote,
        depositBribeETH: noop, depositBribe: noop, approveToken: noop,
        approveToweliForBond: noop, withdrawPendingToken: noop,
        isPending: tx.isPending, isConfirming: tx.isConfirming,
        isSuccess: false, hash: undefined, cooldownRemaining: 0,
        refetch: noop, refetchWhitelist: noop, refetchToweli: noop,
      };
    },
  };
});

vi.mock('wagmi', async () => {
  const { useQuery } = await import('@tanstack/react-query');

  // voterCommits / voterCommitCount are keyed (user, epoch), as on-chain.
  const commitsOf = (user: unknown, epoch: unknown) =>
    String(user).toLowerCase() === h.VOTER && Number(epoch) === h.EPOCH ? h.state.chain.commits : [];

  const readChain = (functionName: string, args: readonly unknown[] = []): unknown => {
    h.reads[functionName] = (h.reads[functionName] ?? 0) + 1;
    switch (functionName) {
      case 'VOTE_DEADLINE': return 604_800n;
      case 'votingPowerAtTimestamp': return 1000n * 10n ** 18n;
      case 'userTotalVotes': return 0n;
      case 'voterCommitCount':
        if (h.state.chain.countFails) throw new Error('rpc down');
        return BigInt(commitsOf(args[0], args[1]).length);
      case 'voterCommits': {
        const c = commitsOf(args[0], args[1])[Number(args[2])];
        if (!c) throw new Error('execution reverted: array out-of-bounds');
        if (Number(args[2]) === h.state.chain.slotFails) throw new Error('rpc down');
        return [c.commitHash, c.bond, c.revealed];
      }
      default: throw new Error(`unmodelled read: ${functionName}`);
    }
  };
  type ReadCfg = { functionName: string; args?: readonly unknown[] };
  const keyOf = (c: ReadCfg) => [c.functionName, ...(c.args ?? []).map(String)];

  return {
    useAccount: () => ({ address: h.VOTER, isConnected: true }),
    useChainId: () => 1,
    useReadContract: (opts: ReadCfg & { query?: { enabled?: boolean } }) => {
      const q = useQuery({
        queryKey: ['readContract', ...keyOf(opts)],
        queryFn: () => readChain(opts.functionName, opts.args),
        enabled: opts.query?.enabled !== false,
      });
      return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error, refetch: q.refetch };
    },
    useReadContracts: (opts: { contracts?: ReadCfg[]; query?: { enabled?: boolean } }) => {
      const contracts = opts.contracts ?? [];
      const q = useQuery({
        queryKey: ['readContracts', ...contracts.map(keyOf)],
        queryFn: () => contracts.map((c) => {
          try { return { status: 'success' as const, result: readChain(c.functionName, c.args) }; }
          catch (error) { return { status: 'failure' as const, error }; }
        }),
        enabled: opts.query?.enabled !== false && contracts.length > 0,
      });
      return { data: q.data, isLoading: q.isLoading, isError: q.isError, error: q.error, refetch: q.refetch };
    },
    useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false }),
    useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false, error: null }),
    useWatchContractEvent: () => undefined,
  };
});

import { VoteIncentivesSection } from './VoteIncentivesSection';

const KEY = `tegridy:viCommit:1:${h.VOTER}:${h.EPOCH}`;
const COMMIT_WINDOW = Math.floor((604_800 * 4000) / 10_000);

/** Independent mirror of VoteIncentives.computeCommitHash on chain 1. */
function commitHashOf(pair: string, power: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'address' }, { type: 'address' },
      { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' },
    ],
    [1n, h.VI, h.VOTER, BigInt(h.EPOCH), pair as `0x${string}`, power, salt],
  ));
}

/** What VoteIncentives.revealVote does with these arguments (its index + hash checks). */
function contractVerdict(args: unknown[]): string {
  const [epoch, commitIndex, pair, power, salt] = args as [number, number, string, bigint, Hex];
  if (epoch !== h.EPOCH) return 'wrong epoch';
  if (!Number.isInteger(commitIndex) || commitIndex < 0) return 'not a uint256';
  const commits = h.state.chain.commits;
  if (commitIndex >= commits.length) return 'CommitNotFound';
  const c = commits[commitIndex]!;
  if (c.revealed) return 'AlreadyRevealed';
  if (commitHashOf(pair, power, salt) !== c.commitHash) return 'CommitHashMismatch';
  return 'ok';
}

type Phase = 'commit' | 'reveal';

/** A page load at `phase`: fresh query cache, idle wallet. */
function openPage(phase: Phase) {
  const now = Math.floor(Date.now() / 1000);
  h.state.epochTs = phase === 'commit' ? now - 3_600 : now - COMMIT_WINDOW - 3_600;
  h.setTx({ isPending: false, isConfirming: false });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  return renderWithProviders(<QueryClientProvider client={qc}><VoteIncentivesSection /></QueryClientProvider>);
}

/** Commit `power` whole votes to the first gauge; returns the hash sent to commitVote. */
async function commit(power: string): Promise<Hex> {
  fireEvent.change(await screen.findByPlaceholderText('Voting power'), { target: { value: power } });
  const button = await screen.findByRole('button', { name: /^Commit \(/ });
  await waitFor(() => expect(button).toBeEnabled());
  const before = h.commitVote.mock.calls.length;
  fireEvent.click(button);
  expect(h.commitVote.mock.calls.length).toBe(before + 1);
  return h.commitVote.mock.calls.at(-1)![1] as Hex;
}

/** The wallet prompt is dismissed: nothing is sent. */
function walletRejects() {
  act(() => h.setTx({ isPending: true }));
  act(() => h.setTx({ isPending: false }));
}

/** The commit is signed and mines. */
function lands(commitHash: Hex) {
  act(() => h.setTx({ isPending: true }));
  act(() => h.setTx({ isPending: false, isConfirming: true }));
  h.state.chain.commits.push({ commitHash, bond: h.BOND, revealed: false });
  act(() => h.setTx({ isConfirming: false }));
}

/** Press every Reveal the page offers; what the contract says to each. */
async function offeredReveals(): Promise<string[]> {
  await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Reveal' }).length).toBeGreaterThan(0));
  // Let any read still in flight land, so a late row cannot slip in after the count.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const buttons = screen.queryAllByRole('button', { name: 'Reveal' });
  return buttons.map((b) => {
    fireEvent.click(b);
    return contractVerdict(h.revealVote.mock.calls.at(-1)!);
  });
}

describe('VoteIncentives commit-reveal — reveals target the commit that landed', () => {
  beforeEach(() => {
    localStorage.clear();
    h.commitVote.mockReset();
    h.revealVote.mockReset();
    Object.values(h.toast).forEach((f) => f.mockReset());
    for (const k of Object.keys(h.reads)) delete h.reads[k];
    h.state.chain = { commits: [], countFails: false, slotFails: -1 };
  });

  it('control: one commit that landed reveals at its slot', async () => {
    const view = openPage('commit');
    lands(await commit('5'));
    view.unmount();

    openPage('reveal');
    expect(await offeredReveals()).toEqual(['ok']);
  });

  it('a commit rejected in the wallet does not shift the next one off its on-chain slot', async () => {
    const view = openPage('commit');
    await commit('5');
    walletRejects();
    lands(await commit('7'));
    view.unmount();

    openPage('reveal');
    // Trunk offered two: the phantom (CommitHashMismatch at slot 0) and the real
    // commit at slot 1 (CommitNotFound), so the bond could not be recovered here.
    expect(await offeredReveals()).toEqual(['ok']);
    expect(screen.getByText(/never reached the chain/i)).toBeInTheDocument();
  });

  it('a commit made from another browser first does not shift this browser\'s commit', async () => {
    h.state.chain.commits.push({ commitHash: `0x${'ee'.repeat(32)}`, bond: h.BOND, revealed: false });
    const view = openPage('commit');
    lands(await commit('5'));
    view.unmount();

    openPage('reveal');
    expect(await offeredReveals()).toEqual(['ok']);
    // And the commit this browser cannot open is named, since its bond is at stake.
    expect(screen.getByText(/no saved secret in this browser/i)).toBeInTheDocument();
  });

  it('does not report a commit already revealed from another browser as at risk', async () => {
    h.state.chain.commits.push({ commitHash: `0x${'ee'.repeat(32)}`, bond: 0n, revealed: true });
    const view = openPage('commit');
    lands(await commit('5'));
    view.unmount();

    openPage('reveal');
    expect(await offeredReveals()).toEqual(['ok']);
    expect(screen.queryByText(/no saved secret in this browser/i)).toBeNull();
  });

  it('reveals records saved by the previous build, whose stored index is wrong', async () => {
    const saltA = `0x${'a1'.repeat(32)}` as Hex;
    const saltB = `0x${'b2'.repeat(32)}` as Hex;
    const power = 7n * 10n ** 18n;
    const phantom = commitHashOf(h.PAIR_A, 5n * 10n ** 18n, saltA);
    const real = commitHashOf(h.PAIR_A, power, saltB);
    localStorage.setItem(KEY, JSON.stringify([
      { salt: saltA, pair: h.PAIR_A, power: (5n * 10n ** 18n).toString(), commitHash: phantom, commitIndex: 0, committedAt: 1 },
      { salt: saltB, pair: h.PAIR_A, power: power.toString(), commitHash: real, commitIndex: 1, committedAt: 2 },
    ]));
    h.state.chain.commits.push({ commitHash: real, bond: h.BOND, revealed: false });

    openPage('reveal');
    expect(await offeredReveals()).toEqual(['ok']);
  });

  it('re-reads the chain when a commit confirms, so the open page sees it land', async () => {
    openPage('commit');
    await waitFor(() => expect(h.reads.voterCommitCount ?? 0).toBeGreaterThan(0));
    lands(await commit('5'));
    expect(await screen.findByText(/Commit #0/)).toBeInTheDocument();
  });

  it('does not offer Reveal again once the chain says the commit is revealed', async () => {
    const view = openPage('commit');
    lands(await commit('5'));
    view.unmount();

    openPage('reveal');
    expect(await offeredReveals()).toEqual(['ok']);
    act(() => h.setTx({ isPending: true }));
    act(() => h.setTx({ isPending: false, isConfirming: true }));
    h.state.chain.commits[0]!.revealed = true;
    act(() => h.setTx({ isConfirming: false }));

    expect(await screen.findByText(/Revealed — bond refunded/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });

  it('offers no Reveal while the on-chain commits cannot be read', async () => {
    const view = openPage('commit');
    lands(await commit('5'));
    view.unmount();

    h.state.chain.countFails = true;
    openPage('reveal');
    expect(await screen.findByText(/could not read your on-chain commits/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });

  it("offers no Reveal when one of the slots cannot be read, since it may be the record's", async () => {
    h.state.chain.commits.push({ commitHash: `0x${'ee'.repeat(32)}`, bond: h.BOND, revealed: false });
    const view = openPage('commit');
    lands(await commit('5'));
    view.unmount();

    h.state.chain.slotFails = 1; // this browser's commit sits at slot 1
    openPage('reveal');
    expect(await screen.findByText(/could not read your on-chain commits/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });

  it('saves the salt before the commit is sent, so a closed tab can still reveal', async () => {
    let savedWhenSent: string | null = null;
    h.commitVote.mockImplementation(() => { savedWhenSent = localStorage.getItem(KEY); });
    openPage('commit');
    const sent = await commit('5');
    const records = JSON.parse(savedWhenSent ?? '[]') as { commitHash: string; salt: string }[];
    expect(records.map((r) => r.commitHash)).toEqual([sent]);
  });
});
