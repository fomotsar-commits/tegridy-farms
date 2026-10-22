import { BUNGALOWS } from './bungalows';

/**
 * "Buy all bungalows": a dollar amount split evenly across every island room's coin on
 * one chain, bought in one order. This file is the list: which coins, on which chain,
 * through which pools. The swap pages read it; nothing here signs or sends.
 *
 * EVERY POOL BELOW WAS READ ON CHAIN 2026-10-18, not taken from an index:
 *   - the pool's own factory, its two tokens and its fee tier;
 *   - what it holds (WETH, or SOL in its vault), so a pool nobody uses is not listed;
 *   - for a pump.fun coin, that its launch curve is complete (migrated, 0 SOL left):
 *     the basket never touches a migrated pool, only the PumpSwap pool it moved to.
 *
 * A COIN CARRIED TO ANOTHER CHAIN IS LISTED THERE TOO, but only when the bridge itself
 * names it. Wormhole's token bridge on Base answers `wrappedAsset(chain, address)` with
 * these two, which is the proof they are the room's own coin and not a namesake:
 *   - TOWELI (Ethereum 0x4206…8F9D) -> Base 0x279e…87ca; the 52,681,394 TOWELI locked in
 *     Wormhole's Ethereum bridge equal that token's whole Base supply.
 *   - RIZZ (Solana 5ad4…BS8k) -> Base 0x58d6…b238.
 * Wormhole also holds copies of PEPE (Base, Solana) and $mfer (Solana): none has a pool
 * that trades (no pool, "not tradable", or one worth $98), so none is listed.
 * BOBO on Ethereum and Base is another coin with the same name: bobothebear.io names only
 * the Solana mint, and no bridge links them.
 *
 * Our own pools are not listed: the order reads them live (our factory on EVM, our pool
 * program on Solana) and takes one whenever it pays at least as much, the swap's rule.
 */

export type BasketChain = 'ethereum' | 'base' | 'solana';

/** Fewer dollars than this per coin and fees eat the buy; the order asks for more. */
export const MIN_USD_PER_COIN = 1;

/** A coin that reached this chain over a bridge, from its room's home chain. */
export interface Bridged {
  from: 'ethereum' | 'solana';
  by: 'Wormhole';
}

export type EvmPool =
  /** Uniswap V2 pair with WETH. */
  | { dex: 'uniswap-v2'; address: `0x${string}` }
  /** Uniswap V3 pool with WETH, at its fee tier (hundredths of a basis point). */
  | { dex: 'uniswap-v3'; address: `0x${string}`; fee: 100 | 500 | 3000 | 10000 };

export interface EvmBasketCoin {
  /** The room (bungalows.ts id). */
  room: string;
  symbol: string;
  token: `0x${string}`;
  decimals: number;
  bridged?: Bridged;
  /** Every outside pool worth asking. The order quotes each and takes the one that pays most. */
  pools: readonly EvmPool[];
}

export interface SolBasketCoin {
  room: string;
  symbol: string;
  mint: string;
  decimals: number;
  /** The one outside pool. Jupiter is asked for a direct route on this DEX only, and must name this pool. */
  pool: { dex: 'pumpswap' | 'raydium-amm-v4'; address: string; jupiterLabel: 'Pump.fun Amm' | 'Raydium' };
}

export const EVM_BASKET: Readonly<Record<'ethereum' | 'base', readonly EvmBasketCoin[]>> = {
  ethereum: [
    {
      room: 'toweli', symbol: 'TOWELI', token: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', decimals: 18,
      // 7.40 WETH.
      pools: [{ dex: 'uniswap-v2', address: '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D' }],
    },
    {
      room: 'pepe', symbol: 'PEPE', token: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18,
      // 5,966 WETH.
      pools: [{ dex: 'uniswap-v2', address: '0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f' }],
    },
  ],
  base: [
    {
      room: 'qr', symbol: 'QR', token: '0x2b5050F01d64FBb3e4Ac44dc07f0732BFb5ecadF', decimals: 18,
      // 9.03 WETH. Its V2 pair holds under a millionth of an ETH.
      pools: [{ dex: 'uniswap-v3', address: '0xF02C421e15ABDF2008Bb6577336B0F3D7aeC98F0', fee: 10000 }],
    },
    {
      room: 'mfer', symbol: '$mfer', token: '0xE3086852A4B125803C815a158249ae468A3254Ca', decimals: 18,
      // V2 40.3 WETH, V3 21.1 WETH; at 0.001 ETH the V2 pair paid 1.6% more.
      pools: [
        { dex: 'uniswap-v2', address: '0xb08A99AB559E5456907278727a3b0d968C0A313b' },
        { dex: 'uniswap-v3', address: '0x7EC18ABf80E865c6799069df91073335935C4185', fee: 10000 },
      ],
    },
    {
      room: 'bnkr', symbol: 'BNKR', token: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b', decimals: 18,
      // 401 WETH.
      pools: [{ dex: 'uniswap-v3', address: '0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703', fee: 10000 }],
    },
    {
      room: 'drb', symbol: 'DRB', token: '0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2', decimals: 18,
      // 259 WETH.
      pools: [{ dex: 'uniswap-v3', address: '0x5116773e18A9C7bB03EBB961b38678E45E238923', fee: 10000 }],
    },
    {
      room: 'jbm', symbol: 'JBM', token: '0x3313338Fe4bB2A166B81483bfCb2d4A6A1ebBa8D', decimals: 18,
      // 8.74 WETH. It has no V2 pair at all.
      pools: [{ dex: 'uniswap-v3', address: '0xbc6156458bc948cba71dd0be99bfa472bd636331', fee: 10000 }],
    },
    {
      room: 'toweli', symbol: 'TOWELI', token: '0x279e7CFf2dBC93ff1F5cae6CBd072F98d75987ca', decimals: 18,
      bridged: { from: 'ethereum', by: 'Wormhole' },
      // 0.76 WETH; priced within 0.4% of the Ethereum pair.
      pools: [{ dex: 'uniswap-v3', address: '0xafaa9dcb906837d67145506bef0ac6f5769f73bc', fee: 10000 }],
    },
    {
      room: 'rizz', symbol: 'RIZZ', token: '0x58d6E314755C2668F3d7358cc7a7a06c4314b238', decimals: 6,
      bridged: { from: 'solana', by: 'Wormhole' },
      // 1.84 WETH; priced within 1% of RIZZ on Solana.
      pools: [{ dex: 'uniswap-v3', address: '0x05cdb532193b8732ebc65aff0ad207186628a3be', fee: 10000 }],
    },
  ],
};

export const SOL_BASKET: readonly SolBasketCoin[] = [
  // SOL in each pool's vault: BAYLA 336, BOBO 1,534, SOY 87, BRAINLET 192, RIZZ 106.
  { room: 'bayla', symbol: 'BAYLA', mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump', decimals: 6, pool: { dex: 'pumpswap', address: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n', jupiterLabel: 'Pump.fun Amm' } },
  { room: 'bobo', symbol: 'BOBO', mint: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', decimals: 6, pool: { dex: 'pumpswap', address: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX', jupiterLabel: 'Pump.fun Amm' } },
  { room: 'soy', symbol: 'SOY', mint: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', decimals: 6, pool: { dex: 'pumpswap', address: 'H8yiDq5XaNkiT6J3QXDeBVfsFHNaVwTRNicbWZnibexi', jupiterLabel: 'Pump.fun Amm' } },
  // Its launch curve migrated to this PumpSwap pool on 2026-04-10; the curve holds 0 SOL.
  { room: 'brainlet', symbol: 'BRAINLET', mint: '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump', decimals: 6, pool: { dex: 'pumpswap', address: '3whYbw26asxFG5Qh9emHA6Mi6uizvduYg1cVKLQ1eetq', jupiterLabel: 'Pump.fun Amm' } },
  { room: 'rizz', symbol: 'RIZZ', mint: '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', decimals: 6, pool: { dex: 'raydium-amm-v4', address: 'dgaDYLCP67MqAzt28WAYtE6pYCHUbRMHtWYLniH1DaL', jupiterLabel: 'Raydium' } },
];

/** The EVM basket for a chain id, or null where there is none (Robinhood, any other). */
export function evmBasketFor(chainId: number | null | undefined): readonly EvmBasketCoin[] | null {
  if (chainId === 1) return EVM_BASKET.ethereum;
  if (chainId === 8453) return EVM_BASKET.base;
  return null;
}

/** The room's name on its card, for a line that says whose coin it is. */
export function roomName(room: string): string {
  return BUNGALOWS.find((b) => b.id === room)?.name ?? room;
}

/**
 * `total` base units in `n` shares that add up to exactly `total`: the first `total % n`
 * shares carry one unit more. Null when there is nothing to split.
 */
export function splitEvenly(total: bigint, n: number): bigint[] | null {
  if (!Number.isInteger(n) || n <= 0 || total <= 0n) return null;
  const count = BigInt(n);
  const base = total / count;
  const extra = Number(total % count);
  if (base === 0n) return null;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1n : 0n));
}

/**
 * Dollars typed -> base units of the coin paid with, at `priceUsd` per whole coin. Null
 * for anything that is not a positive finite amount or price: never a guess.
 */
export function usdToBaseUnits(usd: string, priceUsd: number | null | undefined, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(usd.trim())) return null;
  const dollars = Number(usd);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const whole = dollars / priceUsd;
  // Six significant decimals of the coin is far below a cent at any price these chains see.
  const micro = Math.floor(whole * 1e6);
  if (!Number.isFinite(micro) || micro <= 0) return null;
  return decimals >= 6 ? BigInt(micro) * 10n ** BigInt(decimals - 6) : BigInt(micro) / 10n ** BigInt(6 - decimals);
}

/**
 * The least a leg may return: `out` less `slippageBps`, rounded down. Null, never 0, for
 * a quote or a slippage that makes no sense: a floor of 0 would accept any price.
 */
export function minOut(out: bigint, slippageBps: number): bigint | null {
  if (out <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) return null;
  const floor = out - (out * BigInt(slippageBps)) / 10_000n;
  return floor > 0n ? floor : null;
}

/** The order's quick amounts, in dollars. */
export const QUICK_USD = ['10', '25', '100'] as const;

/**
 * Accepts digits with at most two decimals, nothing else. Whatever this lets through is a
 * dollar amount `usdToBaseUnits` reads.
 */
export function acceptUsd(v: string, set: (s: string) => void): void {
  const s = v.replace(/^\$/, '').trim();
  if (s === '' || /^\d{0,7}(\.\d{0,2})?$/.test(s)) set(s);
}

/** "1,234,567.89" -> "1.23M": a row has room for four figures. */
export function shortAmount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [v, s] of units) if (n >= v) return `${(n / v).toLocaleString('en-US', { maximumFractionDigits: 2 })}${s}`;
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 });
}

/** Dollars, two decimals. */
export function usdText(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
