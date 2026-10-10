import { BUNGALOWS } from '../../bungalows';
import type { AmmConfigView } from '../cpswap/program';
import { feeRateText, shortAddress } from './format';
import type { PoolView } from './poolFinder';
import { quoteCoin } from './quotes';

/**
 * How a pool is named on a card. The name comes from the site's own registry, matched by
 * mint address, never from the token's metadata: a token calling itself BAYLA at another
 * mint is headed by its short address, and what it claims stays in the token check's
 * "Calls itself" row. Eight base58 characters can be grinded to collide, so the short
 * form is never the only identity: the pair heading and the whole address come first.
 */

/** The room whose Solana mint is `mint` (lib/bungalows.ts), by address alone; null when the site lists none. */
export function registryToken(mint: string): { id: string; symbol: string } | null {
  const room = BUNGALOWS.find((b) => b.chain === 'solana' && b.address === mint);
  return room ? { id: room.id, symbol: room.symbol } : null;
}

/** The registry's symbol, else a pairing coin's (quotes.ts), else the short address. */
export function tokenSymbol(mint: string): string {
  return registryToken(mint)?.symbol ?? quoteCoin(mint)?.symbol ?? shortAddress(mint);
}

/** "1% tier" from the pool's own fee settings; "tier not read" when that account was not read. */
export function tierLabel(config: AmmConfigView | null): string {
  return config ? `${feeRateText(config.tradeFeeRate)} tier` : 'tier not read';
}

/** The pair heading: "BAYLA / SOL · 1% tier". */
export function pairLabel(view: Pick<PoolView, 'tokenMint' | 'quote' | 'config'>): string {
  return `${tokenSymbol(view.tokenMint)} / ${view.quote.symbol} · ${tierLabel(view.config)}`;
}
