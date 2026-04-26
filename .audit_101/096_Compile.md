# Agent 096 — Compile & Lint Audit

Scope: does the code compile and lint? AUDIT-ONLY (no fixes).
Date: 2026-04-25

## Summary table

| Surface | Tool | Exit | Errors | Warnings | Notes |
|---|---|---|---|---|---|
| contracts | `forge build` | 0 (PASS) | 0 | 429 | 751 |
| frontend | `npx tsc --noEmit` | 0 (PASS) | 0 | – | – |
| frontend | `npm run lint` (eslint) | 1 (FAIL) | 127 | 35 | – |
| indexer | `npx tsc --noEmit` | 2 (FAIL) | 135 (102 src) | – | – |

Overall: **contracts compile cleanly, frontend types pass, but frontend lint and indexer typecheck both fail. Heavy forge-lint debt (1180 warnings+notes).**

---

## 1. contracts — `forge build` (PASS, with smell)

Exit code 0. `No files changed, compilation skipped` on second run, so the cache was hot — first run output was 417 KB but contained zero `error[...]` lines.

### Forge-lint warning histogram (429 total)

```
349  warning[erc20-unchecked-transfer]   ERC20 transfer/transferFrom return value ignored
 78  warning[unsafe-typecast]            typecast that can truncate values not checked
  2  warning[divide-before-multiply]     precision loss
```

### Forge-lint note histogram (751 total)

```
406  note[unaliased-plain-import]        `import "x"` should be `import {A, B} from "x"`
152  note[mixed-case-variable]           e.g. `amountETH` should be `amountEth`
 87  note[mixed-case-function]           e.g. `addLiquidityETH` should be `addLiquidityEth`
 61  note[screaming-snake-case-immutable] e.g. `poolManager` -> `POOL_MANAGER`
 10  note[unused-import]                 dead imports (test/TegridyNFTPool_Sandwich.t.sol etc.)
  8  note[unwrapped-modifier-logic]
  4  note[named-struct-fields]
```

### Excerpts

```
warning[erc20-unchecked-transfer]: ERC20 'transfer' and 'transferFrom' calls should check the return value
  --> test\RedTeam_POLPremium.t.sol:61:9
   |
61 |         IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);

note[screaming-snake-case-immutable]: immutables should use SCREAMING_SNAKE_CASE
  --> src\TegridyFeeHook.sol:37:35
   |
37 |     IPoolManager public immutable poolManager;

note[unused-import]: unused imports should be removed
 --> test\TegridyNFTPool_Sandwich.t.sol:8:9
  |
8 | import {IWETH} from "../src/lib/WETHFallbackLib.sol";
```

### Cross-check on flagged claim

Another agent reported `ReferralSplitter.sol` has literal `\` instead of `//` for comments. **FALSE.** I checked head and grep:
- `contracts/src/ReferralSplitter.sol:1: // SPDX-License-Identifier: MIT` (proper `//`)
- `grep -E "^\\\\" contracts/src/ReferralSplitter.sol` → No matches.
- The file compiles.

No `\` typo, no BOM, no syntax errors found in any `.sol` file under `contracts/src`.

### Compile-masked-by-stale-build risk

`No files changed, compilation skipped` is shown on consecutive runs — cache is sticky. CI must run `forge clean && forge build` to rule out stale-artifact masking. The `cache/` and `out/` directories are present and warm.

---

## 2. frontend — `npx tsc --noEmit` (PASS)

Exit 0. Zero TS errors.

`@ts-ignore` / `@ts-expect-error` count in `frontend/src`: **1**
- `frontend/src/lib/irysClient.ts:25` — single ts-ignore, with code-comment justification (Irys constructable type).

No `@ts-nocheck` anywhere. TypeScript surface is honest — no errors hidden via suppression.

---

## 3. frontend — `npm run lint` (FAIL: 127 errors, 35 warnings, 162 problems)

`eslint .` exit 1.

### Top error rule classes
```
32  react-hooks/exhaustive-deps
25  react-hooks/rules-of-hooks            (HOOKS CALLED CONDITIONALLY — runtime crash risk)
22  typescript-eslint/no-unused-vars
16  react-hooks/set-state-in-effect       (cascading renders)
14  react-hooks/preserve-manual-memoization
10  typescript-eslint/no-explicit-any
 9  react-hooks/purity                    (impure functions during render)
 5  react-hooks/static-components
 3  react-refresh/only-export-components
 2  react-hooks/incompatible-library
```

### Most dangerous failures (error transcript excerpts)

**Hooks-of-rules violations (real correctness bugs, will break under StrictMode/ Concurrent React 19):**
```
src/pages/...:127:31  React Hook "useReadContract" is called conditionally
src/pages/...:128:32  React Hook "useReadContract" is called conditionally
src/pages/...:129:32  React Hook "useReadContract" is called conditionally
src/pages/...:140:21  React Hook "useCountdown" is called conditionally. Did you accidentally call a React Hook after an early return?
src/pages/...:143:26  React Hook "useMemo" is called conditionally. Did you accidentally call a React Hook after an early return?
e2e/a11y-smoke.spec.ts:97:11  React Hook "use" is called in function "walletMock" — names must start with `use`
```

**setState in effect (cascading renders):**
```
src/pages/LearnPage.tsx:40:5    setTab(next) inside useEffect
src/pages/LendingPage.tsx:66:45 setSection(fromQuery) inside useEffect
```

**Impure functions during render:**
```
src/pages/...:89:34  Cannot call impure function during render
```

### Inline lint suppression count: 13 directives

```
frontend/src/components/launchpad/OwnerAdminPanelV2.tsx:89   eslint-disable @typescript-eslint/no-explicit-any
frontend/src/components/launchpad/wizard/Step2_Upload.tsx:52   eslint-disable react-hooks/exhaustive-deps
frontend/src/components/launchpad/wizard/Step3_Preview.tsx:30  eslint-disable react-hooks/exhaustive-deps
frontend/src/components/launchpad/wizard/Step4_FundUpload.tsx:61 eslint-disable react-hooks/exhaustive-deps
frontend/src/components/ui/OnboardingModal.tsx:50            eslint-disable react-hooks/exhaustive-deps
frontend/src/lib/irysClient.ts:28                            eslint-disable @typescript-eslint/no-explicit-any
frontend/src/lib/txErrors.ts:73                              eslint-disable no-console
frontend/src/nakamigos/App.jsx:484                           eslint-disable react-hooks/exhaustive-deps
frontend/src/nakamigos/components/Modal.jsx:151              eslint-disable react-hooks/exhaustive-deps
frontend/src/nakamigos/components/PageTransition.jsx:195     eslint-disable react-hooks/exhaustive-deps
frontend/src/nakamigos/components/WhaleIntelligence.jsx:409  eslint-disable react-hooks/exhaustive-deps
frontend/src/nakamigos/hooks/useCollection.js:88             eslint-disable react-hooks/exhaustive-deps
frontend/src/pages/FarmPage.tsx:165                          eslint-disable react-hooks/exhaustive-deps
```

Pattern: `react-hooks/exhaustive-deps` is being suppressed widely (10/13). That is correlated with the 32 unsuppressed violations of the same rule — many are likely also dependency-array bugs.

`precommit` script in `frontend/package.json` runs `npm run lint && tsc --noEmit`. Today it would fail at the lint step — meaning either the precommit hook is not enforced, or no one is committing through it.

---

## 4. indexer — `npx tsc --noEmit` (FAIL: exit 2)

135 total TS errors. 33 in node_modules (drizzle-orm + pglite type leaks) — those are dep bugs and not actionable. **102 errors in indexer source code** are real.

### Source-level breakdown (representative)

```
ponder-env.d.ts(8,41):  TS2344  Type 'CreateConfigReturnType<unknown, {}, {}, {}>' does not satisfy constraint 'Config'
ponder-env.d.ts(12,3):  TS2439  Import declaration in ambient module cannot reference module through relative path
ponder.config.ts(354,3): TS2353  'chains' does not exist in type '{ database?, networks, contracts?, accounts?, blocks? }'
src/index.ts(23,11):    TS2345  '"TegridyStaking:Staked"' is not assignable to parameter of type 'never'
src/index.ts(24,67):    TS2339  Property 'args' does not exist on type 'never'
src/index.ts(25,20):    TS2339  Property 'block' does not exist on type 'never'
src/index.ts(39,15):    TS2339  Property 'log' does not exist on type 'never'
src/index.ts(45,19):    TS2339  Property 'transaction' does not exist on type 'never'
... (repeats for every event handler in src/index.ts)
```

### Root cause

The Ponder registry type `Virtual.Registry<config, schema>` resolves to `never` because `ponder.config.ts` uses a `chains` key that the installed `ponder@^0.8.30` Config type does not accept (it expects `networks`). The whole event-handler call chain in `src/index.ts` collapses to `never`, so every `event.args` / `event.block` / `event.log` / `event.transaction` access is a TS error. **The indexer source ships in a non-typechecking state.**

The `ponder-env.d.ts` file is documented as "auto-updated by `ponder codegen`" — running codegen against a config that the type system rejects has produced an incoherent ambient type, and nobody has run typecheck recently.

There is no `typecheck` script in indexer `package.json` — it is never enforced.

---

## Top-5 compile/lint blockers

1. **Indexer ponder.config.ts uses `chains` key, Ponder Config type expects `networks`** — collapses every handler to `never` and produces ~100 cascading TS errors. The indexer cannot be type-checked. (`indexer/ponder.config.ts:354`, fans out to all of `indexer/src/index.ts`.)
2. **Frontend has 25 `react-hooks/rules-of-hooks` violations** — `useReadContract`, `useMemo`, `useCountdown` called conditionally / after early return. These are real React 19 correctness bugs, not stylistic.
3. **Frontend has 16 `react-hooks/set-state-in-effect` violations** — including `LearnPage.tsx:40` and `LendingPage.tsx:66`. Causes cascading renders; React 19 will warn loudly.
4. **349 `erc20-unchecked-transfer` forge-lint warnings** — primarily in tests + a few prod paths (RedTeam_POLPremium proxy contracts). Tests using non-checked transfers can mask transfer-failure bugs in the system under test.
5. **78 `unsafe-typecast` warnings** — every `uint256 -> uintN` truncation is unguarded. At least one is in pricing math (`divide-before-multiply` co-occurs in 2 spots), where silent truncation is a precision/security risk.

## Honourable mentions

- `precommit` script (`npm run lint && tsc --noEmit`) is configured but is failing today — therefore not running on commit, or being bypassed.
- 13 inline `eslint-disable` lines, 10 of them suppressing `react-hooks/exhaustive-deps` — same rule is also failing in 32 unsuppressed sites. A code-quality drift is in progress.
- Foundry build cache is hot and persistent — CI must `forge clean` before build to defeat stale-artifact masking. With 12 `.t.sol` files unchanged, current incremental builds may not even re-typecheck recently-touched src.
- ReferralSplitter `\` claim from another agent is **FALSE** — the file is syntactically clean.
- No BOM characters detected in any contracts/src/*.sol file.
