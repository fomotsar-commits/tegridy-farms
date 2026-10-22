// A chain for wagmi's read hooks in tests: allPairsLength() answers `fake.length`, and every
// other call answers from `fake.answers` (keyed address:function:args) or fails as a revert
// would. `fake.calls` records what was read, with its chainId.
import { liquidityVenueOn } from '../lib/chains/liquidityVenue';

type Call = { address?: string; functionName: string; args?: readonly unknown[]; chainId?: number };

export const BASE = liquidityVenueOn(8453)!;
export const BRB = '0x0e86eFe5Ba52336c2173AD69EE726e054619e0d8' as const;
export const BRB_PAIR = '0x000000000000000000000000000000000000b4b1' as const;

export const fake = {
  length: { data: undefined as bigint | undefined, isError: false },
  answers: new Map<string, unknown>(),
  calls: [] as Call[],
};

const keyOf = (c: Call) => `${(c.address ?? '').toLowerCase()}:${c.functionName}:${(c.args ?? []).map(String).join(',')}`;

export function answer(address: string, functionName: string, result: unknown, args: readonly unknown[] = []) {
  fake.answers.set(keyOf({ address, functionName, args }), result);
}

/** Base's factory holding one BRB/WETH pool: 100,000 BRB and 0.05 ETH, the cut off. */
export function oneBrbPool() {
  fake.length = { data: 1n, isError: false };
  answer(BASE.factory, 'allPairs', BRB_PAIR, [0n]);
  answer(BRB_PAIR, 'token0', BRB);
  answer(BRB_PAIR, 'token1', BASE.weth);
  answer(BRB_PAIR, 'getReserves', [100_000n * 10n ** 18n, 5n * 10n ** 16n, 0]);
  answer(BRB_PAIR, 'kLast', 0n);
  answer(BRB, 'symbol', 'BRB');
  answer(BRB, 'decimals', 18);
  answer(BASE.weth, 'symbol', 'WETH');
  answer(BASE.weth, 'decimals', 18);
}

export function resetFake() {
  fake.length = { data: undefined, isError: false };
  fake.answers.clear();
  fake.calls.length = 0;
}

export function useReadContract(p: Call & { query?: { enabled?: boolean } }) {
  if (p.query?.enabled === false) return { data: undefined, isError: false, isPending: true };
  fake.calls.push(p);
  return { ...fake.length, isPending: fake.length.data === undefined && !fake.length.isError };
}

export function useReadContracts({ contracts, query }: { contracts: readonly Call[]; query?: { enabled?: boolean } }) {
  if (query?.enabled === false) return { data: undefined, isError: false, isPending: true };
  fake.calls.push(...contracts);
  return {
    isError: false,
    isPending: false,
    data: contracts.map((c) => (fake.answers.has(keyOf(c))
      ? { status: 'success', result: fake.answers.get(keyOf(c)) }
      : { status: 'failure', error: new Error('execution reverted') })),
  };
}
