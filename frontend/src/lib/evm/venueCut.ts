import { TEGRIDY_FACTORY_ABI, UNISWAP_V2_PAIR_ABI } from '../contracts';

// The venue's one-sixth cut of one of our EVM pools is on only once kLast() is non-zero
// (TegridyPair: the factory's feeToSetter starts it with harvest()). The old free factories
// still open pools for anyone, so a pool is listed or routed only when its cut reads on.
// A read that did not land is 'unread': never 'off' (dropped as if read) and never 'on'.

export type VenueCut = 'on' | 'off' | 'unread';

type Hex = `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';

/** One pool's cut from its kLast() read. Anything but a bigint is a read that did not land. */
export function venueCutOf(kLast: unknown): VenueCut {
  if (typeof kLast !== 'bigint') return 'unread';
  return kLast > 0n ? 'on' : 'off';
}

/** A route is on only when every pool on it is: one off pool makes it off, else one unread makes it unread. */
export function routeCutOf(cuts: readonly VenueCut[]): VenueCut {
  if (cuts.length === 0) return 'unread';
  if (cuts.includes('off')) return 'off';
  if (cuts.includes('unread')) return 'unread';
  return 'on';
}

/** The pools a router swap along `path` trades through, one per hop. */
export function hopsOf(path: readonly Hex[]): [Hex, Hex][] {
  return path.slice(1).map((to, i) => [path[i]!, to]);
}

/** A pair address as getPair answered it: null when it did not answer, ZERO when there is no pool. */
export function isNoPool(pair: unknown): boolean {
  return typeof pair === 'string' && pair.toLowerCase() === ZERO;
}

interface ReadClient {
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

/**
 * The cut of every pool a swap along `path` on `factory` trades through, read live. A hop with
 * no pool is 'off' (there is nothing of ours to route through); a read that throws is 'unread'.
 */
export async function readRouteCut(client: ReadClient, factory: Hex, path: readonly Hex[]): Promise<VenueCut> {
  const hops = hopsOf(path);
  if (hops.length === 0) return 'unread';
  const cuts = await Promise.all(hops.map(async ([a, b]): Promise<VenueCut> => {
    try {
      const pair = await client.readContract({ address: factory, abi: TEGRIDY_FACTORY_ABI, functionName: 'getPair', args: [a, b] });
      if (typeof pair !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(pair)) return 'unread';
      if (isNoPool(pair)) return 'off';
      return venueCutOf(await client.readContract({ address: pair as Hex, abi: UNISWAP_V2_PAIR_ABI, functionName: 'kLast' }));
    } catch {
      return 'unread';
    }
  }));
  return routeCutOf(cuts);
}
