# Agent 092 — V1 vs V2 Drift Forensics

**Mission:** Per user memory `project_scope_decision.md`, bulletproofing scope deletes V1 Launchpad + V1 Drop ONLY. Find any V1 surfaces still wired at runtime, ABIs, addresses, branches, and docs.

**Verdict:** V1 contract sources are **deleted** from `contracts/src/` (good). V1 frontend duplicates **still exist** as orphan source files but **internally call V2 ABIs** — they are not real V1-runtime drift, they are dead-code aliases. One historical V1 factory address is still embedded in a frontend file as an Etherscan link constant. No runtime path routes to a V1 contract.

---

## A. Contracts (PASS)

| File | Status |
|---|---|
| `contracts/src/TegridyDropV1.sol` | DELETED (good) |
| `contracts/src/TegridyLaunchpadV1.sol` | DELETED (good) |
| `contracts/src/TegridyDropV2.sol` | present |
| `contracts/src/TegridyLaunchpadV2.sol` | present |

Glob `contracts/src/**/*V1*.sol` → 0 matches. **Clean.**

---

## B. Frontend orphan files — KILL-LIST

These are legacy source files no longer imported anywhere except their own internal references / tests. They survive the V1 deletion pass because they import V2 ABIs (`TEGRIDY_DROP_V2_ABI`) — so the **runtime danger is zero**, but the duplication is real and confuses readers.

### B.1 `frontend/src/components/launchpad/CollectionDetail.tsx` — DEAD (285 lines)
- **L6:** `import { useNFTDrop } from '../../hooks/useNFTDrop';` — uses orphan V1 hook
- **L9:** `import { OwnerAdminPanel } from './OwnerAdminPanel';` — uses orphan V1 panel
- **L11:** `export function CollectionDetail({ ... })`
- Only `LaunchpadSection.tsx` is wired to detail views — and it imports `CollectionDetailV2` exclusively (`LaunchpadSection.tsx:9, :114`). **No external import of V1 file.**
- **Action:** delete the file.

### B.2 `frontend/src/components/launchpad/OwnerAdminPanel.tsx` — DEAD (262 lines)
- **L4:** `import { TEGRIDY_DROP_V2_ABI }` — already on V2 ABI; semantic V1 only
- **L10:** `export function OwnerAdminPanel(...)`
- Only consumer is `CollectionDetail.tsx:282` (also dead) and `CollectionDetail.tsx:9` import. **No active import.**
- **Action:** delete the file.

### B.3 `frontend/src/hooks/useNFTDrop.ts` — DEAD (131 lines)
- **L4:** `import { TEGRIDY_DROP_V2_ABI }` — V2 ABI, not V1
- **L7:** `export function useNFTDrop(...)`
- Consumers: `CollectionDetail.tsx:6` (dead) + `useNFTDrop.test.ts` (188 lines of tests for the dead hook).
- **Action:** delete the hook + the test file `useNFTDrop.test.ts`.

### B.4 `frontend/src/hooks/useNFTDrop.test.ts` — DEAD (188 lines)
- **L16:** `import { useNFTDrop } from './useNFTDrop';`
- 17 test cases targeting the orphan V1 hook. Tests pass because hook works against V2 ABI, but they exercise nothing the V2 hook doesn't already cover.
- **Action:** delete; ensure `useNFTDropV2.test.ts` (if exists) covers the surface.

### B.5 `frontend/src/hooks/useNFTDropV2.ts` — KEEP
- **L159:** comment `// Re-entry guard identical to v1 hook (see useNFTDrop comments).` — references soon-to-be-deleted file. **Update comment** to inline the explanation rather than refer to the deleted hook.

---

## C. ABIs / generated.ts / abi-supplement (PASS)

- `frontend/src/generated.ts` — no V1 ABI matches.
- `frontend/src/lib/abi-supplement.ts` — no `V1`/`v1` matches.
- `frontend/src/lib/contracts.ts:330` — `TEGRIDY_LAUNCHPAD_V2_ABI` is present; **no `TEGRIDY_DROP_V1_ABI` / `TEGRIDY_LAUNCHPAD_V1_ABI` exports.**
- `frontend/src/lib/contracts.ts:378` — `// Mint surface (same bytes4s as v1)` — comment-only reference, harmless. **Optional cleanup.**

**Clean — no V1 ABI imported but uncalled, no V1 ABI shipped.**

---

## D. Address constants (PASS)

- `frontend/src/lib/constants.ts:34-35` — V1 address `0x5d597647...FF3C2` referenced **only in a comment**, no constant export.
- `frontend/src/lib/constants.ts:53` — `TEGRIDY_LAUNCHPAD_V2_ADDRESS = 0x000...000` (placeholder, broadcast pending — Wave 0 already deployed; track in `project_wave0_pending.md`).
- **No `TEGRIDY_LAUNCHPAD_V1_ADDRESS` / `TEGRIDY_DROP_V1_ADDRESS` exports.** Frontend cannot accidentally route to V1.

### D.1 `frontend/src/components/nftfinance/LaunchpadSection.tsx:16` — V1 Etherscan link constant
```ts
const V1_FACTORY_ETHERSCAN = 'https://etherscan.io/address/0x5d597647D5f57aEFba727C160C4C67eEcC0FF3C2';
```
- Used at L104 as a user-facing link for browsing historical V1 collections. **NOT a wagmi target.** Acceptable per migration narrative.
- **Action: KEEP** (intentional historical link, not runtime drift).

### D.2 `frontend/src/pages/ContractsPage.tsx:328`
- Stale UX copy: `Frontend falls back to V1 or reads are gated on isDeployed().` — promises a V1 fallback that no longer exists in code. **Misleading.**
- **Action:** update copy to remove the "falls back to V1" promise; current behavior is the V2-not-deployed empty state in `LaunchpadSection.tsx:98-108`.

---

## E. Runtime branches "if V1" (PASS)

Searched `frontend/src` for `V1` and `v1`:
- No `if (v1)` / `if (isV1)` / V1-vs-V2 ternary branches.
- `LaunchpadSection.tsx:98` `if (!v2Live)` — early return showing "V2 not deployed yet" + Etherscan link to V1 factory. **Not a runtime fallback to V1 contracts.**
- All wagmi `writeContract` / `useReadContract` calls reference `TEGRIDY_DROP_V2_ABI` or V2 addresses. **No V1 chain calls anywhere.**

---

## F. Supabase migrations (PASS)

- `frontend/supabase/migrations/` (3 files: `001_siwe_auth_rls.sql`, `002_native_orders_trades_push.sql`, `003_revoked_jwts.sql`) — **0 matches** for `v1`/`V1`/`drop_v1`/`launchpad_v1`/`tegridy_drop_v1`/`tegridy_launchpad_v1`. Schema is V1-free.

---

## G. Docs

### G.1 `CONTRACTS.md` — well-marked, KEEP
- **L63:** `**TegridyDropV2** ... Successor to V1 TegridyDrop.` — accurate historical narrative.
- **L64:** `**TegridyLaunchpadV2** ... V1 source deleted 2026-04-19 — V1 clones remain live on-chain, readable via the V2 Drop ABI (strict superset).` — accurate.
- No "still wired" claims. **No action.**

### G.2 `docs/MIGRATION_HISTORY.md` — well-marked, KEEP
- L14, L31, L75, L83, L96-97, L125, L126 — all explicitly tag entries as DEPRECATED / RETIRED with dates. Historical ledger as-intended.
- **No action.**

### G.3 `frontend/src/pages/ArtStudioPage.tsx:140, :154, :238`
- `CV1`, `CGV1`, `PV1` — **NOT** version markers. They're art-config IDs (`Community Vote 1`, `Community Gauge Voting 1`, `Privacy V 1`). **False positive — KEEP.**

---

## H. Counts

| Bucket | V1 surfaces still wired at runtime | Files-to-delete | Files-to-edit |
|---|---|---|---|
| Contracts | 0 | 0 | 0 |
| Frontend components | 0 | 2 (`CollectionDetail.tsx`, `OwnerAdminPanel.tsx`) | 0 |
| Frontend hooks | 0 | 2 (`useNFTDrop.ts`, `useNFTDrop.test.ts`) | 1 (`useNFTDropV2.ts:159` comment) |
| ABIs | 0 | 0 | 1 optional (`contracts.ts:378` comment) |
| Constants | 0 | 0 | 0 (V1_FACTORY_ETHERSCAN is intentional) |
| Pages copy | 0 (cosmetic only) | 0 | 1 (`ContractsPage.tsx:328` stale "falls back to V1") |
| Supabase | 0 | 0 | 0 |
| Docs | 0 | 0 | 0 |

**Total runtime-wired V1 surfaces: 0.**
**Total dead V1 source files in tree: 4** (CollectionDetail.tsx, OwnerAdminPanel.tsx, useNFTDrop.ts, useNFTDrop.test.ts) — totaling 866 LOC of orphan code.

---

## I. Recommended kill-list (deletion order)

1. `frontend/src/hooks/useNFTDrop.test.ts` — delete first (drops the only Vitest reference to the V1 hook)
2. `frontend/src/hooks/useNFTDrop.ts` — delete (no remaining external import once test is gone)
3. `frontend/src/components/launchpad/OwnerAdminPanel.tsx` — delete
4. `frontend/src/components/launchpad/CollectionDetail.tsx` — delete (its only referenced hook + panel are now gone)
5. Edit `frontend/src/hooks/useNFTDropV2.ts:159` — replace "see useNFTDrop comments" with the inlined comment
6. (Optional) Edit `frontend/src/lib/contracts.ts:378` — soften "same bytes4s as v1" to a generic comment
7. (Optional) Edit `frontend/src/pages/ContractsPage.tsx:328` — remove "falls back to V1" claim

After this pass, the only remaining V1 string in app source is `V1_FACTORY_ETHERSCAN` in `LaunchpadSection.tsx` (intentional user-facing link to historical collections).

---

**Audit-only — no edits performed by agent 092.**
