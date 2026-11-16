import type { PoolView } from './poolFinder';
import type { TokenSafety } from './tokenSafety';
import { poolWorthUsd } from './poolList';
import { tokenSymbol } from './identity';
import type { FieldPool } from './fieldStore';

/**
 * All pools' rows as the tank farm draws them, in the rows' order: each pair by the names its row
 * gives it, and its dollars only when Jupiter's prices were read for both coins (poolWorthUsd).
 * `usd` null: the prices were not read, so every tank stays dry.
 */
export function fieldPoolsOf(
  views: readonly PoolView[],
  usd: ReadonlyMap<string, number> | null,
  safety: ReadonlyMap<string, TokenSafety>,
): FieldPool[] {
  return views.map((view) => ({
    address: view.address,
    tokenMint: view.tokenMint,
    name: `${tokenSymbol(view.tokenMint, safety.get(view.tokenMint) ?? null)}/${view.quote.symbol}`,
    usd: usd ? poolWorthUsd(view, usd) : null,
  }));
}
