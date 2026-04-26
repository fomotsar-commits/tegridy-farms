# Agent 051 — Forensic Audit: frontend/src/pages/AdminPage.tsx

**Scope:** AUDIT-ONLY. Static review for client-only auth, admin RPC actions without confirmation, RBAC mismatch, CSRF, telemetry/PII leakage, private-key surface, env leakage, dangerouslySetInnerHTML, hardcoded multisig, missing chainId guards, and audit-log surface.

---

## Summary Counts

| Severity      | Count |
|---------------|-------|
| CRITICAL      | 0     |
| HIGH          | 1     |
| MEDIUM        | 3     |
| LOW           | 4     |
| INFO          | 3     |
| **Total**     | **11** |

---

## Findings

### HIGH

#### H-1 — Client-only auth via `owner()` read; no server-side enforcement of admin UI
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 191-206, 345-361
- **Detail:** Admin gate is a pure client-side wagmi `useReadContract` of the staking contract's `owner()`, then a string compare against `address` (line 205). No server attestation, no signature challenge, no session token. An attacker who can patch the bundle locally (e.g. via DevTools or a tampered bundler) can bypass the `if (!isOwner) return <NotAuthorized/>` block (line 345) and render the panel. The on-chain protection is the only real defence — every write would still revert at the contract — but ANY linked-API/telemetry/off-chain action triggered from this page (none currently, see findings below) would have **no server-side enforcement** at all. **Mitigating:** All actions on this page today are on-chain writes signed by the wallet, which the contracts gate via `onlyOwner`. **Recommend:** if any off-chain admin endpoint is ever added (audit-log API, Telegram alert, etc.), the backend MUST independently verify the signed admin role via a signed challenge — not trust the rendered UI.

### MEDIUM

#### M-1 — `pause()/unpause()` is the only write surface with a typed-confirmation guard; future writes added here have no scaffold
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 72-178, 437
- **Detail:** Only `PauseControls` enforces typed-input confirmation before sending the destructive write (line 91, requires literal "PAUSE" / "UNPAUSE"). This is good. However the page exposes 4 `ContractCard`s with a comment line 65-67 *"Pending timelock operations are managed via direct contract interaction"* — implying any future addition of in-UI fee/treasury/reward writes needs the same gate. Without an enforced abstraction (e.g. shared `<TypedConfirmButton>`), this is left to author discipline. **Recommend:** factor confirmation into a reusable component before any new write call site is added.

#### M-2 — Owner refetch interval (30s) is long enough to leave a stale-RBAC window
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 196-200
- **Detail:** `refetchInterval: 30_000` means after `transferOwnership` + `acceptOwnership` to a new wallet, the previous owner can still see admin UI for up to 30s. The author already added a manual "Refresh role" button (line 391-397), and writes would revert in-wallet (mitigating), but a sophisticated attacker who lost ownership but still controls the browser tab could attempt a spam of a write within that window expecting the wallet to sign. **Recommend:** drop interval to 10s, or refetch on every write attempt before sending.

#### M-3 — `contractReadsError.message` rendered raw to DOM
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 401-407
- **Detail:** `{contractReadsError.message || ...}` is rendered as a child node (safe — React escapes by default, no `dangerouslySetInnerHTML` anywhere in this file). However, RPC error messages from a malicious provider could contain embedded URLs or social-engineering text that the operator might trust. **Severity reduced to MEDIUM** because there is no XSS vector (React escapes children), but the **content is operator-trusted on a privileged page**. **Recommend:** truncate to a fixed-length safe string or whitelist known error codes.

### LOW

#### L-1 — No audit-log surface for ops actions
- **Detail:** `pause()/unpause()` is sent on-chain (good — that gives an immutable on-chain log via tx history), but there is **no client-side audit-log surface** (e.g. a list of recent admin actions with tx hash, timestamp, signer address) rendered on the page. An operator viewing the panel cannot see "what did the previous admin do at 14:02 UTC?" without leaving for the explorer. **Recommend:** add a "Recent admin actions" panel reading on-chain `Paused/Unpaused` events for the last N blocks.

#### L-2 — No telemetry / no PII leakage
- **Detail:** Confirmed: zero `fetch()`, no `analytics.track`, no `Sentry.captureMessage`, no `console.log` of `address`. **Pass** for this audit dimension. (Counted as a LOW finding only because the absence of telemetry is itself an "admin actions are not centrally observable" gap — see L-1.)

#### L-3 — `explorerBaseUrl` falls back to `https://etherscan.io` on chain-config miss
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 211-212
- **Detail:** `chains.find((c) => c.id === CHAIN_ID)?.blockExplorers?.default?.url ?? 'https://etherscan.io'`. If `CHAIN_ID` is a testnet/L2 and the chain config is misregistered in wagmi, the operator gets etherscan.io links pointing at addresses that don't exist on mainnet — confusing but not exploitable. **Recommend:** fall back to empty string + render plain address (no link) instead of mainnet etherscan.

#### L-4 — `tx hash` (txHash) not surfaced in UI on success
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 73, 82-88
- **Detail:** `useWriteContract` returns `txHash` and `useWaitForTransactionReceipt` confirms — but neither the toast (line 84) nor any DOM element shows the tx hash or links to the explorer. Operator cannot easily archive proof of the action. **Recommend:** include shortened tx hash + explorer link in the success toast and a short post-action panel.

### INFO

#### I-1 — chainId pinned correctly on every read and the only write
- **File:** `frontend/src/pages/AdminPage.tsx`
- **Lines:** 95-100, 195, 235
- **Detail:** **PASS.** `writeContract({ ..., chainId: CHAIN_ID })` is explicit on the pause/unpause call. `useReadContract` for `owner()` pins `chainId: CHAIN_ID`. `useReadContracts` is gated by `isOwner && onCorrectChain`. Wrong-chain users get the `WrongChainScreen` (line 318-325) before any read fires.

#### I-2 — No private-key surface, no copy-paste of secrets, no env-var leakage
- **Detail:** **PASS.** No `import.meta.env.*` exposure beyond `CHAIN_ID` (which is a public constant), no clipboard write of `address`, no `mnemonic`/`privateKey` strings anywhere in the file.

#### I-3 — No `dangerouslySetInnerHTML`, no inline `eval`, no hardcoded multisig
- **Detail:** **PASS.** All addresses come from `'../lib/constants'`. No inline HTML injection. The `style={...}` blocks (e.g. line 122-128, 142, 167-169) use object form, not string form — no CSS-injection vector.

---

## Net assessment

The file is in **good shape** relative to the threat model. The single dominant risk is **client-only auth** (H-1), which is acceptable today because every action is an on-chain write gated by `onlyOwner` at the contract layer. The moment any **off-chain endpoint** (audit log API, alerting webhook, Telegram notification) is wired into this page, that endpoint MUST do its own signed-message verification — do not trust this page's "isOwner" gate. The pause control's typed-confirmation pattern is exemplary and should be the template for any future destructive write added here.

**No CRITICAL findings.** Recommend prioritizing M-1 (factor confirmation into a shared component) before any new write surface is added.
