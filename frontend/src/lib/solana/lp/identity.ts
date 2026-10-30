import { BUNGALOWS } from '../../bungalows';
import { displaySafe } from '../../launchMetadata/validate';
import type { AmmConfigView } from '../cpswap/program';
import { feeRateText, shortAddress } from './format';
import type { PoolView } from './poolFinder';
import { quoteCoin } from './quotes';
import { copiedWellKnownName, type TokenSafety } from './tokenSafety';

/**
 * How a pool is named on a card. Our own coins come from the site's registry, matched by
 * mint address, and the pairing coins from quotes.ts. Every other coin shows the ticker it
 * gives itself (owner ruling 2026-10-22: every coin shows its ticker), cleaned for the
 * screen. A ticker that reads as one of the well-known coins (tokenSafety.ts
 * WELL_KNOWN_NAMES: ours, SOL, USDC, USDT) at another mint is shown as "fake BAYLA", so a
 * copy never heads a card as the real one. A coin whose ticker was not read is headed by
 * its short address. A ticker is the coin's own claim, and eight base58 characters can be
 * grinded to collide, so every card that names a coin off the registry shows its whole
 * address too.
 */

/** A longer ticker is cut to this many characters, the last one an ellipsis. */
const TICKER_CHARS = 12;

/** The room whose Solana mint is `mint` (lib/bungalows.ts), by address alone; null when the site lists none. */
export function registryToken(mint: string): { id: string; symbol: string } | null {
  const room = BUNGALOWS.find((b) => b.chain === 'solana' && b.address === mint);
  return room ? { id: room.id, symbol: room.symbol } : null;
}

/** Named by the site itself: one of our coins, or a pairing coin. Any other coin's name is its own claim. */
export function siteNamed(mint: string): boolean {
  return registryToken(mint) !== null || quoteCoin(mint) !== null;
}

/**
 * The registry's symbol, else a pairing coin's, else the ticker the coin's check read
 * ("fake X" for a copy); null when there is none to show.
 */
export function tokenTicker(mint: string, safety?: TokenSafety | null): string | null {
  return claimedTicker(mint, safety?.kind === 'read' && safety.mint === mint ? safety.symbol : null);
}

/**
 * The same name from a ticker read anywhere else (Jupiter's token list on the swap page):
 * the registry's symbol, else a pairing coin's, else `symbol` cleaned for the screen,
 * "fake X" for a copy; null when there is none to show.
 */
export function claimedTicker(mint: string, symbol: string | null | undefined): string | null {
  const ours = registryToken(mint)?.symbol ?? quoteCoin(mint)?.symbol;
  if (ours) return ours;
  if (!symbol) return null;
  const shown = displaySafe(symbol, TICKER_CHARS);
  if (shown === '') return null;
  return copiedWellKnownName(mint, [symbol, shown]) ? `fake ${shown}` : shown;
}

/** The ticker (tokenTicker), else the short address. */
export function tokenSymbol(mint: string, safety?: TokenSafety | null): string {
  return tokenTicker(mint, safety) ?? shortAddress(mint);
}

/** "1% tier" from the pool's own fee settings; "tier not read" when that account was not read. */
export function tierLabel(config: AmmConfigView | null): string {
  return config ? `${feeRateText(config.tradeFeeRate)} tier` : 'tier not read';
}

/** The pair heading: "BAYLA / SOL · 1% tier". `safety` is the token's check, for a coin off the registry. */
export function pairLabel(view: Pick<PoolView, 'tokenMint' | 'quote' | 'config'>, safety?: TokenSafety | null): string {
  return `${tokenSymbol(view.tokenMint, safety)} / ${view.quote.symbol} · ${tierLabel(view.config)}`;
}
