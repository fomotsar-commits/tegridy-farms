// Wiring pins for the EVM lighthouse CARD. The math itself is unit-pinned in
// lib/evmLighthouse.test.ts; what only THIS file can catch is the index wiring
// between the useReadContracts batch and the derivation — a reordered batch
// would swap stats silently (vault reading rewardRate, etc.), which no type
// checks and no lib test would ever see.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';

type ReadCell = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Query = { address: string; functionName: string; args?: readonly unknown[] };
const wagmiState = vi.hoisted(() => ({
  // ANSWERS BY QUERY, not by position: the mock inspects each requested
  // (address, functionName, args) and returns that call's value. This is what
  // makes the wiring pin real — if the component's batch order desyncs from
  // its big(i) index reads, the answers land under the wrong indices and the
  // stats visibly swap. (First version returned a fixed array and the
  // index-swap mutation sailed through green — vacuous, per the house rule.)
  answers: new Map<string, ReadCell>(),
}));

const keyOf = (q: Query) => `${q.functionName}:${(q.args ?? []).map(String).join(',')}`;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useChainId: () => 8453,
  useSwitchChain: () => ({ switchChain: () => {} }),
  useReadContracts: ({ contracts }: { contracts: Query[] }) => ({
    data: contracts.map(
      (q) => wagmiState.answers.get(keyOf(q)) ?? { status: 'failure', error: new Error(`unmocked ${keyOf(q)}`) },
    ),
    isLoading: false,
    refetch: () => Promise.resolve(),
  }),
  useWriteContract: () => ({ writeContractAsync: () => Promise.resolve('0x' as `0x${string}`) }),
  useWaitForTransactionReceipt: () => ({ data: undefined }),
}));

const { EvmLighthousePoolLive } = await import('./EvmLighthousePoolLive');

const E18 = 10n ** 18n;
const DRB = {
  id: 'drb',
  name: 'DRB',
  symbol: 'DRB',
  chain: 'base',
  address: '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2',
  stakePool: '0x00000000000000000000000000000000000c0FfE',
  status: 'SETTLED',
  tagline: 'x',
  thumb: '/art/x.jpg',
  live: false,
} as unknown as Bungalow & { stakePool: string };

const ok = (result: unknown): ReadCell => ({ status: 'success', result });
const fail = (): ReadCell => ({ status: 'failure', error: new Error('rpc') });

const PLACEHOLDER = '0x0000000000000000000000000000000000000001';

function seedReads(over: Record<string, ReadCell> = {}) {
  const future = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  const base: Record<string, ReadCell> = {
    'totalSupply:': ok(200n * E18), //                     staked principal
    [`balanceOf:${DRB.stakePool}`]: ok(260n * E18), //     200 principal + 60 funded
    'rewardRate:': ok(1_000n),
    'periodFinish:': ok(future),
    'rewardsDuration:': ok(BigInt(60 * 86_400)),
    'decimals:': ok(18),
    [`balanceOf:${PLACEHOLDER}`]: ok(0n),
    [`earned:${PLACEHOLDER}`]: ok(0n),
    [`allowance:${PLACEHOLDER},${DRB.stakePool}`]: ok(0n),
    // AUDIT TF-035 (breadth): the pool agrees it stakes THIS token.
    'stakingToken:': ok(DRB.address),
  };
  wagmiState.answers = new Map(Object.entries({ ...base, ...over }));
}

beforeEach(() => seedReads());

describe('EvmLighthousePoolLive', () => {
  it('the vault stat is balance MINUS principal — end-to-end through the batch wiring', () => {
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.getByText('60 DRB')).toBeTruthy(); // NOT 260 (raw) and NOT 200 (principal)
    expect(screen.queryByText('260 DRB')).toBeNull();
    expect(screen.getByText('200 DRB')).toBeTruthy(); // total staked, its own stat
  });

  it('renders the no-locks disclosure and reads without a wallet', () => {
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.getByText(/No locks on this pool/)).toBeTruthy();
    expect(screen.getByText(/Reading the pool needs no wallet/)).toBeTruthy();
  });

  it('a failed core read shows the outage card, never zeros', () => {
    seedReads({ [`balanceOf:${DRB.stakePool}`]: fail() });
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.getByText(/could not be read just now/)).toBeTruthy();
    expect(screen.queryByText(/Reward vault/)).toBeNull();
  });

  it('principal-only balance reads as an unfunded vault with the safety line', () => {
    seedReads({ [`balanceOf:${DRB.stakePool}`]: ok(200n * E18) }); // balance == principal, zero funded
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.getByText('0 DRB')).toBeTruthy();
    expect(screen.getByText(/staking works but earns nothing until funding/)).toBeTruthy();
    expect(screen.getByText(/principal is NEVER at the vault/)).toBeTruthy();
  });

  // AUDIT TF-035 (breadth). The registry's `stakePool` is a hand-pasted
  // literal sitting in a row of near-identical siblings. If it names someone
  // else's pool, every figure on this card is a true reading of the WRONG
  // pool rendered under our symbol — and the stake button points at it. The
  // ladder card has asked the pool to confirm its own staking token since its
  // design review; this card never did.
  it('a pool that stakes a DIFFERENT token shows no figures and no stake path', () => {
    seedReads({ 'stakingToken:': ok('0x000000000000000000000000000000000000BEEF') });
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.getByText(/does not stake DRB/)).toBeTruthy();
    expect(screen.getByText(/configuration error, not a network problem/)).toBeTruthy();
    // The figures must be gone — not merely accompanied by a warning.
    expect(screen.queryByText(/Reward vault/)).toBeNull();
    expect(screen.queryByText('200 DRB')).toBeNull();
  });

  it('an UNREADABLE identity is an outage, never a mismatch accusation', () => {
    // A failed read must not accuse the operator of a mispaste.
    seedReads({ 'stakingToken:': fail() });
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.queryByText(/does not stake DRB/)).toBeNull();
    expect(screen.getByText('60 DRB')).toBeTruthy(); // figures still render
  });

  it('a matching identity is invisible — no banner on the happy path', () => {
    render(<EvmLighthousePoolLive bungalow={DRB} />);
    expect(screen.queryByText(/does not stake/)).toBeNull();
  });
});
