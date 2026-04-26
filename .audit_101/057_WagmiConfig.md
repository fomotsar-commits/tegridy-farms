# Agent 057 — Wagmi Config Forensic Audit

**Targets:** `frontend/src/lib/wagmi.ts`, `frontend/src/lib/contracts.ts`, `frontend/src/lib/explorer.ts`, `frontend/src/lib/constants.ts`, `frontend/src/main.tsx`, `frontend/src/App.tsx`.

**Scope:** AUDIT-ONLY. No code changes.

---

## Counts

| Severity | Count |
|----------|-------|
| HIGH     | 0     |
| MEDIUM   | 3     |
| LOW      | 4     |
| INFO     | 4     |
| **TOTAL**| **11**|

---

## Findings

### MEDIUM-1 — Public RPC fallback chain has rate-limit / production cost-storm risk
**File:** `frontend/src/lib/wagmi.ts:10-17`
**Detail:** The transports use unauthenticated public RPCs (`ethereum-rpc.publicnode.com`, `eth.llamarpc.com`, `rpc.ankr.com/eth`, plus default wagmi fallback). All three providers throttle aggressively under load (typical 30 req/s/IP). Under normal user activity wagmi/viem multicalls can easily breach 30 req/s — symptoms manifest as "loading…" screens and missing balances rather than hard errors. There is no authenticated/paid RPC (Alchemy/Infura/QuickNode) configured. This is a production reliability risk during traffic spikes (launches, viral moments, token-listing windows).
**Recommendation:** Add an authenticated primary endpoint (Alchemy/Infura) gated behind an env var like `VITE_RPC_URL` and put it first in `fallback([…])`. Pair with `batch: { multicall: true }` in `http()` to consolidate eth_calls.

### MEDIUM-2 — `VITE_WALLETCONNECT_PROJECT_ID` ships in client bundle (acceptable per WC spec, but no domain allowlist enforced in code)
**File:** `frontend/src/lib/wagmi.ts:7`
**Detail:** `VITE_WALLETCONNECT_PROJECT_ID` is correctly prefixed with `VITE_` because WalletConnect projectIds are *designed* to be public-bundle (WC enforces domain allowlist server-side at cloud.walletconnect.com). Risk is informational unless the WC dashboard's allowed-origins list is empty/wildcarded. Audit cannot verify WC dashboard state from code alone — flag for ops verification.
**Recommendation:** Verify on cloud.walletconnect.com that allowed origins are restricted to `app.tegridy.farms` and any preview deploys. Otherwise an attacker can re-use the projectId in their own phishing dapp.

### MEDIUM-3 — wagmi/RainbowKit cache TTL not explicitly tuned; React Query defaults applied app-wide
**File:** `frontend/src/App.tsx:70-78`
**Detail:** `QueryClient` has `staleTime: 30_000` and `gcTime: 300_000` set globally. wagmi v2 reads use these defaults unless individual `useReadContract({ query: { staleTime } })` is passed. 30s is reasonable for prices/balances but too short for static data (e.g. token name, decimals, totalSupply, contract owners) — these refetch every 30s, multiplying RPC cost by N tabs × N reads. Combined with MEDIUM-1, this contributes to the rate-limit risk. No `refetchOnWindowFocus: false` set — every tab refocus triggers a refetch storm.
**Recommendation:** Set `refetchOnWindowFocus: false` globally. Override `staleTime: Infinity` on static reads (decimals, name, etc.).

### LOW-1 — `transports` table only includes mainnet — no L2 transports configured though L2 chain IDs are referenced in `explorer.ts`
**File:** `frontend/src/lib/wagmi.ts:10-17` ↔ `frontend/src/lib/explorer.ts:15-22`
**Detail:** `explorer.ts` enumerates explorers for Optimism (10), Base (8453), Arbitrum (42161), Polygon (137), BSC (56), Avalanche (43114), plus testnets. Wagmi config only has `chains: [mainnet]` and a single transport. If any code path (deep link, share-link import, future router) hits a non-mainnet chain, wagmi has no transport and wallet connection would silently fall through. Not a current vulnerability (no L2 use) but invitation for a chainId-drift bug.
**Recommendation:** Either prune `explorer.ts` to mainnet-only, or wire matching transports in `wagmi.ts`. The two files should agree on the supported-chain set.

### LOW-2 — `CHAIN_ID = 1` hardcoded in `constants.ts` while wagmi exports `mainnet.id` — drift surface
**File:** `frontend/src/lib/constants.ts:74`
**Detail:** `export const CHAIN_ID = 1;` is a bare numeric literal duplicated from wagmi's `mainnet.id`. If the project ever needs a testnet build (Sepolia/Holesky) for QA, two places must be edited consistently. No current bug, but classic drift hazard. Same applies to the hardcoded `https://etherscan.io/...` and `https://app.uniswap.org/...?chain=ethereum` URLs in lines 106-110 — they assume mainnet forever.
**Recommendation:** `import { mainnet } from 'wagmi/chains'; export const CHAIN_ID = mainnet.id;` Use `getExplorerBase()` from `explorer.ts` for the etherscan URL.

### LOW-3 — `TEGRIDY_LAUNCHPAD_V2_ADDRESS` is `0x0000…0000` (zero address) — UI must guard
**File:** `frontend/src/lib/constants.ts:53`
**Detail:** Documented placeholder. `isDeployed()` helper is exported but easy to forget. Any `useReadContract({ address: TEGRIDY_LAUNCHPAD_V2_ADDRESS })` will silently return undefined and could be misinterpreted as "no collections" rather than "not deployed yet." Not strictly a wagmi bug but a chain-config integrity issue.
**Recommendation:** Either gate Launchpad v2 routes behind `isDeployed(TEGRIDY_LAUNCHPAD_V2_ADDRESS)` checks (probably already done — verify), or default-export a sentinel that throws on read attempts.

### LOW-4 — No `autoConnect` flag visible; `getDefaultConfig` defaults vary across RainbowKit versions
**File:** `frontend/src/lib/wagmi.ts:21-26`, `frontend/src/lib/wagmi.ts:45-49`
**Detail:** RainbowKit v2's `getDefaultConfig` enables auto-reconnect by default; raw `createConfig` does NOT. The two branches of `buildConfig()` therefore behave differently when WC project id is set vs unset — a user with no WC env var would have to manually reconnect on every page load while a user with WC env would auto-reconnect. Inconsistent UX between dev and prod and between branches.
**Recommendation:** Pass `multiInjectedProviderDiscovery: true` and explicit `ssr: false` in both branches; consider explicit `storage: createStorage({ storage: cookieStorage | localStorage })` so the reconnect behavior is identical.

### INFO-1 — `WalletConnect projectId: ''` empty string fallback (line 42) is technically a malformed config but harmless
**File:** `frontend/src/lib/wagmi.ts:42`
**Detail:** `connectorsForWallets([…], { appName: 'Tegridy Farms', projectId: '' })`. RainbowKit may log a warning. WalletConnect connector is not in the wallets list anyway when this branch runs, so practically no-op.

### INFO-2 — No `mainnet.contracts.multicall3` override; uses viem default — fine for mainnet
**File:** `frontend/src/lib/wagmi.ts`
**Detail:** No issue, just noting that custom multicall override is absent. Stock viem multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) is correct on mainnet.

### INFO-3 — `VITE_ANALYTICS_ENDPOINT`, `VITE_ERROR_ENDPOINT`, `VITE_VAPID_PUBLIC_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — all `VITE_`-prefixed env vars in client
**Files:** `lib/analytics.ts:5`, `lib/errorReporting.ts:108`, `nakamigos/lib/notifications.js:31`, `nakamigos/lib/supabase.js:85-86`
**Detail:** Out of scope for this agent's targets but worth documenting that ALL of these are client-bundled. Supabase anon key and VAPID public key are designed to be public; analytics/error endpoints exposing internal hostnames is informational risk only. None of these should be a "secret."
**Recommendation:** Confirm with infra that the analytics/error URLs do not encode bearer tokens or shared-secret query strings.

### INFO-4 — `getDefaultConfig` does not pass `wallets:` array, so RainbowKit's default wallet roster is used (when WC id is set)
**File:** `frontend/src/lib/wagmi.ts:21-26`
**Detail:** When `projectId` is set, the explicit `[injectedWallet, metaMaskWallet, coinbaseWallet]` curation is *ignored* — RainbowKit ships its full default roster (Rainbow, MetaMask, Coinbase, WalletConnect, plus 30+ injected). Inconsistent with the no-WC branch. Probably fine but worth a comment.

---

## Top-3 (most actionable)

1. **MEDIUM-1** — Add authenticated RPC (Alchemy/Infura) as the primary fallback. The current public-only stack will rate-limit during high traffic.
2. **MEDIUM-3** — Set `refetchOnWindowFocus: false` and per-query `staleTime: Infinity` on static contract reads. Combined with MEDIUM-1, this is the highest-impact cost/UX win.
3. **LOW-1 / LOW-2** — Reconcile chain support: either prune `explorer.ts` to mainnet, or add transports for the L2s it lists. Replace `CHAIN_ID = 1` literal with `mainnet.id` to eliminate drift surface.

---

## Not Found (negative results)

- **No chainId drift:** `contracts.ts` has no per-chain address map; everything is single-chain mainnet, consistent with `wagmi.ts`.
- **No leaked RPC tokens / API keys:** No Alchemy/Infura/QuickNode URLs with `?apiKey=` or path-token patterns. (Conversely, this means no authenticated RPC at all — see MEDIUM-1.)
- **No malformed chain config:** Block-explorer table in `explorer.ts` is correct (basescan.org, arbiscan.io, snowtrace.io all match canonical URLs).
- **No `useNetwork` mismatch:** wagmi v2 has deprecated `useNetwork` (replaced by `useAccount().chain` / `useChainId`); none of the targets use the old API.
- **No duplicate `WagmiProvider`:** Single instance in `App.tsx:191`. `main.tsx` is clean.
- **No client-side `VITE_ETHERSCAN_API_KEY` leak:** `HistoryPage.tsx:204` documents historical removal of that var — confirmed absent now.

---

*Audit completed by agent 057 on 2026-04-25.*
