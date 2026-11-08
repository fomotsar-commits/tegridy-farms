// Which other coins an Ethereum or Base wallet holds, and each one's market price, as
// /api/aggregator?resource=wallet-coins answers it (api/_lib/walletCoins.js): Alchemy's list of the
// wallet's coins, priced by DefiLlama, cut to those worth $1 or more. The board trusts the answer
// for which coins to look at and their price only: each balance, its decimals and its ticker are
// read from the coin's own contract (useWalletBoard), so a wrong answer can leave a coin out or
// price it wrong, never put an amount the wallet does not hold on the board.
import { BUNGALOWS } from '../bungalows';
import { EVM_BASKET } from '../islandBasket';
import type { WalletChain } from './walletRows';

export type EvmWalletChain = Exclude<WalletChain, 'solana'>;

export interface WalletCoin {
  address: `0x${string}`;
  priceUsd: number;
}

export type WalletCoinsRead =
  | { status: 'loading' }
  | { status: 'unread'; detail: string }
  | { status: 'ok'; coins: WalletCoin[] };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** More than this in one answer is not the server's answer: the server sends at most 60. */
const MAX_COINS = 100;

export function walletCoinsUrl(chain: EvmWalletChain, address: string): string {
  return `/api/aggregator?resource=wallet-coins&chain=${chain}&address=${address.toLowerCase()}`;
}

/** The answer's coins; null for an answer that is not one. The island's own coins are left out: the board lists them already. */
export function parseWalletCoins(body: unknown, chain: EvmWalletChain): WalletCoin[] | null {
  const list = (body as { coins?: unknown } | null)?.coins;
  if (!Array.isArray(list) || list.length > MAX_COINS) return null;
  const island = new Set(BUNGALOWS.filter((b) => b.chain === chain && b.address).map((b) => b.address!.toLowerCase()));
  const out: WalletCoin[] = [];
  for (const c of list as { address?: unknown; priceUsd?: unknown }[]) {
    if (typeof c?.address !== 'string' || !ADDRESS.test(c.address)) return null;
    if (typeof c.priceUsd !== 'number' || !Number.isFinite(c.priceUsd) || c.priceUsd <= 0) return null;
    const address = c.address.toLowerCase() as `0x${string}`;
    if (!island.has(address) && !out.some((o) => o.address === address)) out.push({ address, priceUsd: c.priceUsd });
  }
  return out;
}

export async function fetchWalletCoins(chain: EvmWalletChain, address: string, fetchImpl: typeof fetch = fetch): Promise<WalletCoinsRead> {
  try {
    const r = await fetchImpl(walletCoinsUrl(chain, address), { signal: AbortSignal.timeout(25_000) });
    if (!r.ok) return { status: 'unread', detail: `the coin list answered ${r.status}` };
    const coins = parseWalletCoins(await r.json(), chain);
    return coins ? { status: 'ok', coins } : { status: 'unread', detail: 'the coin list answered in a shape it does not send' };
  } catch (e) {
    return { status: 'unread', detail: e instanceof Error ? e.message : 'the coin list did not answer' };
  }
}

/**
 * A coin's own ticker, cleaned for the screen: letters, digits and a few marks, at most 16. A
 * ticker that copies an island coin's at another address is "fake X", as on the pools (identity.ts).
 */
export function evmTicker(symbol: unknown, chain: EvmWalletChain, address: string): string | null {
  if (typeof symbol !== 'string') return null;
  const shown = symbol.replace(/[^\p{L}\p{N} $._-]/gu, '').trim().slice(0, 16);
  if (!shown) return null;
  // An island coin carried here over a bridge the bridge itself names (islandBasket.ts) is the room's own.
  const ours = [...BUNGALOWS.filter((b) => b.chain === chain && b.address).map((b) => b.address!), ...EVM_BASKET[chain].map((c) => c.token)];
  if (ours.some((a) => a.toLowerCase() === address.toLowerCase())) return shown;
  const bare = (s: string) => s.toUpperCase().replace(/^\$/, '');
  return BUNGALOWS.some((b) => b.address && bare(b.symbol) === bare(shown)) ? `fake ${shown}` : shown;
}
