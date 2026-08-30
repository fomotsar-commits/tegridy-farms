// Solana fee-capture surface (Surface A) — config + gating helpers.
//
// "Buy other Solana tokens on Tegridy, skim a platform fee." Swaps route
// through the Jupiter Swap API (keyless lite-api) via our hardened aggregator
// proxy at /api/jupiter/*. There is NO own on-chain program, NO bridge, and
// TOWELI never touches Solana. Full plan: docs/SOLANA_FEE_CAPTURE_PLAN.md.
//
// This lives in its OWN module (not src/lib/constants.ts) on purpose:
// constants.ts is imported by wagmi.config.ts, which is compiled under the node
// tsconfig (types: ["node"], no "vite/client"), so `import.meta.env` is untyped
// there and would fail `tsc -b`. Keeping env-dependent Solana config here keeps
// it in the app project (types: ["vite/client"]) only.

// Same-origin proxy base. The browser calls our own origin; the proxy forwards
// to https://lite-api.jup.ag server-side — so no Solana host needs a CSP
// connect-src entry for quotes/swaps. (A Solana RPC WILL need one when the
// wallet + swap UI lands; that's a later batch.)
export const JUPITER_PROXY_BASE = '/api/jupiter/swap/v1';

// Base for Jupiter's token API (search + paste-a-mint resolve) through the same
// proxy provider. Client calls /api/jupiter/tokens/v2/search?query=…
export const JUPITER_TOKENS_BASE = '/api/jupiter';

// Same-origin Solana RPC proxy (/api/solrpc). The browser NEVER talks to a
// Solana RPC host directly: a production RPC embeds an API key in its URL, and a
// VITE_* client var would inline that key into the PUBLIC bundle (the repo's
// own [H-35] lesson). The keyed URL lives server-side in the `SOLANA_RPC_URL`
// env on the api/solrpc serverless function; the browser only hits our origin.
// Because of that, RPC needs only CSP 'self' — no Solana host in connect-src.
export const SOLANA_RPC_PROXY_PATH = '/api/solrpc';

// web3.js Connection needs an ABSOLUTE URL — resolve against our own origin.
export function solanaRpcEndpoint(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}${SOLANA_RPC_PROXY_PATH}`;
}

// The platform fee accrues to a Tegridy-owned Solana associated token account
// (ATA), ideally owned by a Squads multisig. OPERATOR: set the base58 pubkey of
// that fee account in Vercel env as VITE_SOLANA_FEE_ACCOUNT. The Solana swap
// surface stays gated until it's a non-empty value, then auto-un-gates —
// mirroring isDeployed() for EVM contracts in constants.ts.
export const SOLANA_FEE_ACCOUNT =
  (import.meta.env.VITE_SOLANA_FEE_ACCOUNT as string | undefined)?.trim() ?? '';

// Platform fee in basis points (100 = 1.0%). Keep <= 100: above ~1% the quote
// degrades vs free direct Jupiter and users bounce. Disclosed in the UI.
// Clamped to a sane [0, 1000] bps range; falls back to 100 on bad input.
export const SOLANA_PLATFORM_FEE_BPS = ((): number => {
  const raw = (import.meta.env.VITE_SOLANA_PLATFORM_FEE_BPS as string | undefined)?.trim();
  const n = raw ? Number(raw) : 100;
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 100;
})();

// Canonical mainnet mints (the curated allowlist lands with the swap UI).
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Gate: does the venue TAKE a platform fee on a Solana swap?
 *
 * This is a question about revenue, not about capability — Jupiter quotes and
 * builds a swap perfectly well with no `feeAccount` (jupiter.ts `feeEnabled()`
 * already keeps `platformFeeBps` and `feeAccount` coupled, sending neither
 * when this is false). Whichever way it answers, the swap itself works.
 */
export function isSolanaFeeConfigured(): boolean {
  return SOLANA_FEE_ACCOUNT.length > 0;
}

/**
 * Gate: should the in-venue Solana swap surface be offered?
 *
 * It used to be `isSolanaFeeConfigured()`, and that conflation had a real
 * cost: with no VITE_SOLANA_FEE_ACCOUNT set, /solana rendered "coming soon",
 * the nav hid it, and `bungalowTradeRoute()` sent every Solana bungalow
 * OUT to jup.ag — so the venue's own Solana token (BAYLA) had no in-venue
 * trade route at all and "Trade" in the nav meant the Ethereum swap. The
 * missing piece was a fee recipient, which is a reason to charge nothing,
 * not a reason to send traffic away.
 *
 * The surface depends on the same-origin Jupiter proxy (/api/jupiter →
 * api/aggregator.js, deployed) and a Solana RPC proxy (/api/solrpc, deployed)
 * — both of which exist regardless of the fee account. So: always live, and
 * the fee line below it tells the truth either way.
 */
export function isSolanaSwapLive(): boolean {
  return true;
}
