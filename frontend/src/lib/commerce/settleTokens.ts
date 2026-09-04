// Which (chain, asset) pairs a merchant may be OWED in, and how a buyer checks
// that the asset the invoice names is really at the address it names.
//
// ─── WHY THIS TABLE IS NOT `DEFAULT_TOKENS` ─────────────────────────────────
//
// DEFAULT_TOKENS is a list of things a person might want to TRADE. A settlement
// asset is a different thing: it is what a merchant agrees to be paid in, and
// the whole payment link is only as good as this venue's knowledge of the
// address behind it. Every entry below was read on chain — code, `symbol()`,
// `decimals()` — and is registered in frontend/scripts/addresses.json, so the
// set of things a link can be minted for is exactly the set this repo has
// verified. Narrower than the trade list on purpose.
//
// ─── WHY THE SYMBOL IS SOMETIMES NOT THE TRADE LIST'S SYMBOL ────────────────
//
// The invoice restates what the contract says about itself, because the buyer
// re-reads `symbol()` from the chain and refuses a payment when the string does
// not match the one that was signed. TOWELI is the case that proves it: the
// trade list displays `TOWELI`, and the contract at
// 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D answers `symbol() = "Toweli"`
// (mainnet read 2026-09-02, block 25888254, two independent RPCs). Signing the
// display string would have made every TOWELI invoice refuse itself as a token
// mismatch. So the display string is overridden here by the string the chain
// actually returns, and only where a real read says it differs.
//
// ─── ADDING A CHAIN ─────────────────────────────────────────────────────────
//
// One verified addresses.json entry (with `chainId`) plus one line in
// SETTLE_TOKENS_BY_CHAIN. PAYMENT_LINK_CHAIN_IDS, the merchant's chain guard and
// every sentence that names a chain are derived from the table, so they extend
// themselves. Base (8453) and Robinhood (4663) are deliberately absent: neither
// has an on-chain-verified, registered settlement asset in this repo yet, and a
// link a buyer could never pay is worse than no link.

import { CONFIGURED_CHAIN_IDS } from '../chains/registry';
import { DEFAULT_TOKENS, type TokenInfo } from '../tokenList';
import type { Invoice } from './invoice';

/**
 * The mainnet settlement set, by the trade list's display symbol.
 *
 * Addresses are never written here — they come from tokenList.ts (USDC, USDT,
 * DAI) and constants.ts (WETH, TOWELI), so this file adds no address literal
 * that the registry would have to be taught about separately.
 */
const SETTLE_SYMBOLS_MAINNET: ReadonlySet<string> = new Set(['USDC', 'USDT', 'DAI', 'WETH', 'TOWELI']);

/**
 * Display symbol → the string the contract's own `symbol()` returns.
 *
 * Only entries whose chain read DISAGREES with the trade list belong here, and
 * each one is a read that happened. An entry added from a block explorer's
 * rendering rather than from an `eth_call` would be the exact class of guess
 * this whole module exists to keep out of a signed document.
 */
const ON_CHAIN_SYMBOL: Readonly<Record<string, string>> = {
  // eth_call symbol() -> "Toweli", mainnet 2026-09-02.
  TOWELI: 'Toweli',
};

function withOnChainSymbol(token: TokenInfo): TokenInfo {
  const actual = ON_CHAIN_SYMBOL[token.symbol];
  return actual === undefined ? token : { ...token, symbol: actual };
}

export const SETTLE_TOKENS_BY_CHAIN: Readonly<Record<number, readonly TokenInfo[]>> = Object.freeze({
  1: Object.freeze(
    DEFAULT_TOKENS.filter((t) => !t.isNative && SETTLE_SYMBOLS_MAINNET.has(t.symbol)).map(withOnChainSymbol),
  ),
});

/**
 * The assets a link may be minted for on a chain. Empty for every chain with no
 * verified row — an empty list is the answer, never a fallback to mainnet's.
 */
export function settleTokensFor(chainId: number | null | undefined): readonly TokenInfo[] {
  if (chainId == null) return [];
  return SETTLE_TOKENS_BY_CHAIN[chainId] ?? [];
}

/** The table's entry for a (chain, address) pair, or null. Address compare is case-insensitive. */
export function settleTokenKnownOnChain(chainId: number | null | undefined, token: string): TokenInfo | null {
  const wanted = token.toLowerCase();
  return settleTokensFor(chainId).find((t) => t.address.toLowerCase() === wanted) ?? null;
}

/**
 * The chains a signed payment link can be minted on.
 *
 * DERIVED from the settle table rather than from CONFIGURED_CHAIN_IDS, and the
 * difference is the whole point: viemChains.ts:96 throws when the configured set
 * is empty, so a condition keyed on it could never be false and would be a
 * tautology wearing a check's clothes. This can genuinely be empty — remove the
 * mainnet row and it is — and it grows the moment a verified L2 asset lands.
 */
export const PAYMENT_LINK_CHAIN_IDS: readonly number[] = Object.freeze(
  CONFIGURED_CHAIN_IDS.filter((id) => settleTokensFor(id).length > 0),
);

/** Whether any served chain can mint or pay a signed invoice at all. The nav pill's input. */
export function hasPaymentLinkChain(): boolean {
  return PAYMENT_LINK_CHAIN_IDS.length > 0;
}

// ─── Re-reading the signed token from the chain ──────────────────────────────

/**
 * What a browser managed to learn about the address an invoice names.
 *
 * `unread` is a statement about this browser's connection. `read` is a statement
 * about the chain. They are separate cases because the refusal each one earns is
 * different, and telling a buyer "that is not the token" when the truth is "we
 * could not ask" accuses a merchant of a forgery that did not happen.
 *
 * Within `read`, a null `symbol` or `decimals` means THAT call did not answer
 * while the code read did — a partial read, which is still not knowledge.
 */
export type SettleTokenRead =
  | { kind: 'unread'; detail: string }
  | { kind: 'read'; hasCode: boolean; symbol: string | null; decimals: number | null };

/**
 * Four outcomes, and none of them may ever be rendered as another.
 *
 *   matches   the contract agrees with every figure the merchant signed
 *   no-code   there is nothing at that address on that chain
 *   mismatch  something is there and it is not what the invoice names
 *   unread    we do not know, and saying anything else would be inventing it
 */
export type SettleTokenStanding = 'matches' | 'no-code' | 'mismatch' | 'unread';

export function judgeSettleToken(inv: Invoice, read: SettleTokenRead): SettleTokenStanding {
  if (read.kind === 'unread') return 'unread';
  if (!read.hasCode) return 'no-code';
  // A partial read cannot convict. Falling through to the comparison with a null
  // on either side would compare against nothing and answer 'mismatch', which is
  // the collapse this union was shaped to prevent.
  if (read.symbol === null || read.decimals === null) return 'unread';
  // Case-SENSITIVE on the symbol: the string is part of what the merchant signed
  // and what the buyer reads, and the table above carries the chain's own casing
  // precisely so an honest invoice matches exactly.
  if (read.symbol !== inv.settleSymbol) return 'mismatch';
  if (read.decimals !== inv.settleDecimals) return 'mismatch';
  return 'matches';
}
