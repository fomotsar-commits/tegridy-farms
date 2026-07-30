// Declares `window.ethereum` as viem's `EIP1193Provider`.
//
// This is viem's own declaration (`viem/window` -> `_types/window/index.d.ts`),
// referenced explicitly rather than redeclared, so the type stays exactly what
// viem says it is and there is no duplicate-identifier risk if a dependency
// declares it too — identical declarations merge.
//
// Why it has to be explicit: `irysClient.ts` reads `window.ethereum` and used to
// compile only because *some* dependency in the wagmi/viem/RainbowKit tree
// happened to pull `viem/window` in transitively. That is not a contract any of
// them make. wagmi v3 stops doing it, and `tsc` immediately fails with
//
//   src/lib/irysClient.ts(21,48): error TS2339:
//   Property 'ethereum' does not exist on type 'Window & typeof globalThis'.
//
// A one-line reference is the difference between "our wallet plumbing type-checks"
// and "our wallet plumbing type-checks as long as nobody upgrades wagmi".
//
// Note `tsconfig.app.json` sets `"types": ["vite/client"]`, which suppresses
// automatic @types inclusion — so this reference is required, not merely tidy.
// Deliberately NOT a module — no `export {}`. A reference directive applies either
// way, but keeping this a global script file avoids any ambiguity about scoping.
//
// Note also that `skipLibCheck: true` means an UNRESOLVABLE reference here fails
// silently rather than erroring, so a typo in the line below would be invisible on
// a tree where viem is still pulled in transitively. It is verified against the
// wagmi v3 bump (#167), which is the only place the difference is observable.
/// <reference types="viem/window" />
