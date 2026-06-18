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

// Solana RPC the wallet/swap UI talks to directly (sendRawTransaction + status
// polling — we deliberately avoid WS subscriptions).
//
// OPERATOR — SECRET HAZARD: VITE_* is statically inlined into the PUBLIC client
// bundle (the repo already learned this for Alchemy/OpenSea — vite.config.ts
// [H-35]). NEVER put an API key here: a keyed URL (Helius `?api-key=…`,
// QuickNode/Triton `/<TOKEN>/`) ships to every browser and gets scraped/drained.
// Use ONLY a keyless/public RPC. A private/keyed RPC must go behind a same-origin
// hardened proxy (like /api/jupiter) — a follow-up batch, not this VITE_ var.
export const SOLANA_RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined)?.trim() ||
  'https://api.mainnet-beta.solana.com';

// Dev-only guard: shout if a keyed RPC URL was pasted into the public env var.
if (import.meta.env.DEV && /api-key=|helius-rpc\.com|quiknode|rpcpool\.com/i.test(SOLANA_RPC_URL)) {
  console.warn(
    '[solana] VITE_SOLANA_RPC_URL looks like a KEYED RPC — VITE_ vars are public, so this key will ship in the client bundle. Use a keyless RPC or a same-origin proxy.',
  );
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

// Gate: the Solana swap surface is live only once the operator sets a fee account.
export function isSolanaConfigured(): boolean {
  return SOLANA_FEE_ACCOUNT.length > 0;
}
