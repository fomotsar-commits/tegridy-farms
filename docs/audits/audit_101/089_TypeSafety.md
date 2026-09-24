# 089 — Type Safety Audit (forensic)

**Scope:** root, frontend, indexer, contracts. Solidity not in scope.
**Status:** AUDIT-ONLY. No code modified.

---

## tsconfig posture (per project)

| Project | strict | noImplicitAny | strictNullChecks | noUnchecked-IndexedAccess | allowJs | Notes |
|---|---|---|---|---|---|---|
| `frontend/tsconfig.app.json` | ✅ true | (via strict) | (via strict) | ✅ true | ⚠️ true | excludes `src/**/*.test.ts(x)` and `src/test` from typecheck — see F1 |
| `frontend/tsconfig.node.json` | ✅ true | (via strict) | (via strict) | ❌ off | — | only vite.config + wagmi.config |
| `indexer/tsconfig.json` | ✅ true | (via strict) | (via strict) | ❌ off | — | composite |
| root | (none) | — | — | — | — | no top-level tsconfig |
| `contracts/` | (none) | — | — | — | — | no contracts/tsconfig.json; only foundry deps under `lib/` |

Strict-mode is **on everywhere** TS is configured. There is no project-level `noImplicitAny:false`, no `strictNullChecks:false`, no `@ts-nocheck`. Good.

But two structural issues:
- `frontend/tsconfig.app.json` line 34 **excludes test files** from typecheck. `tsc --noEmit` will not catch the `: any` props in test mocks (#5 below) and any test relying on a stale prod type signature drifts silently until vitest runs.
- `frontend/tsconfig.node.json` and `indexer/tsconfig.json` do **not** set `noUncheckedIndexedAccess` — array/Record indexing is silently typed `T` instead of `T | undefined` in those projects (small surface but worth flagging).

---

## Counts (top-level)

| Metric | Frontend src | Indexer src | Contracts (TS) | Notes |
|---|---|---|---|---|
| `: any` / `<any>` / `as any` (non-comment) | **13** across 8 files | 0 | 0 (only commented-out in v4-core gas spec) | see breakdown |
| `as unknown as X` (lying-cast) | **9** in `src/`, 1 in test, 1 in `useSwap.test.ts`, 7 in `e2e/` | 0 | 0 | mostly Irys Buffer + e2e window-mocks |
| `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` | **0 active** (1 stale comment in `src/lib/irysClient.ts:25` describing a `@ts-ignore` that is no longer present — comment lies about what the code does) | 0 | 0 | strong signal |
| `as never[]` / `as never` (compiler-blinding) | **6** (4 in OwnerAdminPanel(V2), 2 in AMMSection) | 0 | 0 | all wrap wagmi `writeContract` calls |
| Default exports of inferred types | 25 of 29 default exports are `function`/`class` (named); the other 4 are inferred | — | — | low risk |
| Total `as <Type>` casts (`as bigint`/`as string`/`as Address`/`` as `0x... ``) | **291** across 55 files | small | — | dominated by hooks decoding wagmi `useReadContracts` results |

### `: any` breakdown by directory (frontend)

| Path | Count | Reason |
|---|---|---|
| `src/components/community/VoteIncentivesSection.tsx:1038` | 1 | `Array<any>` for heterogeneous wagmi contracts list |
| `src/components/launchpad/OwnerAdminPanelV2.tsx:93` | 1 | `as any` after `as never[]` to silence wagmi `writeContract` overloads |
| `src/components/loader/fx/audio.ts:16-17` | 2 | `(navigator as any).userActivation` — modern API not in TS lib |
| `src/components/SeasonalEvent.test.tsx:11,13` | 2 | framer-motion mock factory props (test) |
| `src/components/ui/OnboardingModal.test.tsx:13,18,19` | 3 | framer-motion mock factory props (test) |
| `src/hooks/usePoolTVL.ts:29` | 1 | wagmi `useReadContracts` heterogeneous tuple |
| `src/lib/irysClient.ts:29` | 1 | `WebUploader(WebEthereum as any)` — Irys SDK type loosely-defined |
| `src/pages/ArtStudioPage.tsx:301` | 1 | comment only ("any state change") — not actually `: any` |

True non-comment, non-test `any` count: **6** (audio, irys, pool TVL, vote-incentives, owner-admin × 1, plus the irys-client cast). Tests add 5 more.

### `as unknown as X` by directory

| Path | Count | What is being cast |
|---|---|---|
| `src/hooks/useIrysUpload.ts:127,144,161,181,197` | 5 | `Uint8Array as unknown as Buffer` (Vite polyfill — runtime safe, types lie) |
| `src/hooks/useSwap.test.ts:14` | 1 | `null as unknown as ReturnType<typeof vi.fn>` — lazy-init stub |
| `src/hooks/useToweliPrice.test.ts:45` | 1 | `vi.fn() as unknown as typeof fetch` — fetch stub |
| `e2e/wallet-connect.spec.ts:23,65` + `e2e/fixtures/wallet.ts × 7` | 9 | `window as unknown as { … }` for injected wallet mock |
| `src/components/chart/PriceChart.tsx:66` | 1 | `time as unknown as Time` — lightweight-charts brand-type |

---

## Zod posture

- Zod is **only used in 1 file** in this monorepo: `frontend/api/_lib/proxy-schemas.js` (Supabase write proxy). It validates row-shape and JWT-claim ownership for 5 tables.
- All other API responses (GeckoTerminal, Odos, KyberSwap, OpenOcean, ParaSwap, LiFi, CowSwap, OpenSea, Etherscan, Alchemy, the proxy responses themselves) are read with `await res.json()` and **no runtime validation** beyond ad-hoc `typeof === 'string'` / `Number.isFinite` shape probes (e.g. `aggregator.ts:48`, `usePriceHistory.ts:65`).
  - The compiler thinks `data` is `any` (since `.json()` is `Promise<any>`), and the code happily reads `.outAmounts[0]`, `.amountOut`, `.priceImpact`, `.data.attributes.ohlcv_list[N][4]`, etc. **TS gives zero protection on any external API surface.**
  - There is **no zod ↔ TS type drift** because there are no zod-derived types to drift from outside the proxy. Drift risk is therefore "TS believes the API shape is whatever the assignment-target type implies, with no runtime check."

## ABI / wagmi codegen freshness

- `frontend/src/generated.ts` (mtime 2026-04-21 23:34) is **younger than every `.sol` file in `contracts/src/`** (latest `TegridyNFTPool.sol` at 2026-04-21 22:40). Codegen is fresh.
- `frontend/src/lib/contracts.ts` (591 lines) re-exports manually-curated ABI subsets — risk of drift if a contract function signature changes without updating both `generated.ts` AND `contracts.ts`. Worth a follow-up audit on `contracts.ts` vs. `generated.ts` overlap.

---

## Top-5 highest-risk type holes

### #1 — `OwnerAdminPanelV2.tsx:93` & `OwnerAdminPanel.tsx:55`: `args as never[] } as any` / `} as never` for wagmi `writeContract`
The compiler is **completely blinded** for any owner-only admin write on TegridyDropV2. `fn` is a freeform string; `args` is `unknown[]`. A typo in `fn` or wrong `args` arity will only surface as an on-chain revert. Owner-only surface, but every drop deployer admin uses it. **Severity: HIGH** — admin write path with zero compile-time guarantees.

### #2 — Every `await res.json()` site (11 hooks/lib + 4 nakamigos files) with no zod
`aggregator.ts` has 7 `res.json()` calls returning swap quotes that drive **swap routing decisions**. A malicious or buggy aggregator returning `{ amountOut: "fakebignum", priceImpact: -1e308 }` would pass the ad-hoc checks. `usePriceHistory.ts:65` reads `json?.data?.attributes?.ohlcv_list` with TS thinking it's `any`. The display layer only protects against `NaN`, not against semantic poisoning. **Severity: HIGH** — runtime trust boundary with no schema.

### #3 — `frontend/tsconfig.app.json:34` excludes `src/**/*.test.ts(x)` from typecheck
Test mocks (`vi.fn().mockResolvedValue(...) as unknown as typeof fetch`, the `wagmiState.writeContractMock = null as unknown as ReturnType<typeof import('vitest').vi.fn>` in `useSwap.test.ts`) are **never typechecked at build time**. If a hook signature changes, only `vitest` will catch it — and only on the test paths it exercises. CI typecheck is a partial check. **Severity: MEDIUM-HIGH** — silent test/prod drift.

### #4 — `useIrysUpload.ts × 5`: `Uint8Array as unknown as Buffer`
Five sites cast browser `Uint8Array` to Node `Buffer` purely to satisfy the Irys SDK's loose `Buffer|string|Readable` typing. Comment says "Vite polyfills Buffer at runtime so Uint8Array works" — accurate today, but if Irys ever stops accepting plain Uint8Array on a minor version bump, **uploads will fail at runtime** with a misleading type-error-shaped exception. NFT mint manifest uploads, art studio uploads, premium content. **Severity: MEDIUM** — third-party SDK contract assumed.

### #5 — `usePoolTVL.ts:29` and `VoteIncentivesSection.tsx:1038`: heterogeneous-tuple `as any` / `Array<any>` to wagmi `useReadContracts`
Each `result` is decoded with another `as bigint` / `as readonly [bigint, bigint, number]` / `as string`. There are ~291 such narrowing-casts across 55 files in `src/`. **Any change to a contract function's return type will not be caught by tsc** — only by runtime decode failure. The wider issue is **the hook layer trusts ABI codegen but locally re-asserts types**, so an ABI/codegen mismatch silently mis-decodes. **Severity: MEDIUM** — broad attack surface, but bounded by ABI codegen freshness (currently fresh).

---

## Other notable observations

- `frontend/src/lib/irysClient.ts:25-29` — comment claims to use `@ts-ignore` but the code uses `as any`. **Comment is misleading**; cleanup candidate.
- `e2e/fixtures/wallet.ts` and `e2e/wallet-connect.spec.ts` use 9 `window as unknown as { … }` casts. Acceptable for test fixtures but worth a typed `declare global` to make the contract explicit.
- No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` actually present — strong discipline.
- Indexer (`indexer/src/index.ts`, 479 LOC) is **completely clean** of `any`, `as any`, `as unknown as`, and `@ts-*` directives. Best-in-class TS hygiene.
- `frontend/src/nakamigos/` is mostly **`.js` / `.jsx`** (allowJs:true) — those files have no type checking at all (e.g. `siweAuth.js`, `orderbook.js` parse `await res.json()` straight into `data.x`). Worth flagging as a parallel "untyped surface" but not strictly type-safety drift since they are JS.

---

## Recommendations (audit-only — informational)

1. **Add zod schemas for the 7 aggregator responses + price feeds + activity websocket.** Bulk effort: ~150 LOC of schemas.
2. **Drop the `tsconfig.app.json` exclude of test files** — run `tsc --noEmit` over them with a separate `tsconfig.test.json` if needed.
3. **Replace `args as never[] } as any` in OwnerAdminPanel(V2)** with a proper discriminated union over `TEGRIDY_DROP_V2_ABI` function names — wagmi v2 supports this with `Abi`-typed helpers.
4. **Wrap Irys `Uint8Array as unknown as Buffer` in a tiny `toIrysBody()` helper** so the cast lives in one place; lock the Irys SDK version with a CHANGELOG-watch reminder.
5. **Audit `lib/contracts.ts` against `generated.ts`** to confirm no drift between hand-curated ABI subsets and codegen.
