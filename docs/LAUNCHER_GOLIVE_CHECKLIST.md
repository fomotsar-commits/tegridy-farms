# Tegridy Launcher — Go-Live Runbook (operator handoff)

> Single actionable checklist to take the launcher from **built + gated** to **live**.
> Strategy: [LAUNCHER_STRATEGY.md](./LAUNCHER_STRATEGY.md). This doc is the *how to turn it on*.
> Compiled 2026-07-17. Nothing here is live; the code is committed and gated.

## 0. Current status (what's done)

- **Mainnet leg: built, fork-proven, reviewed, green.** `frontend/src/lib/launcher/` +
  `frontend/src/pages/LaunchPage.tsx` + `frontend/src/components/launcher/`. 101 tests,
  0 tsc errors, `npm run build` green. Independently reviewed (3 adversarial lenses);
  the one real bug (disclosure-integrity) fixed.
- **Fork-proven:** a real Doppler `createDynamicAuction` through our exact policy mined
  **green on a mainnet fork** — token deployed as a Solady clone of `DopplerERC20V1`
  (`0xdb7b…`, `isPoolLocked()==true`), the impl our gate whitelists. Full loop validated.
- **Gate is SHUT:** `config.ts` `LAUNCHER_ENABLED = false`, integrator = zero address.
  `/launch` renders the "SOON" placeholder.
- **Solana leg: deliberately NOT built** — gated behind EVM signal (Strategy §3).

## 1. Hard gates — ALL must pass before un-gating (Strategy §6)

1. **Core-loop go-live** — TOWELI's own swap/AMM loop live (see `docs/GOLIVE_CORELOOP.md`).
2. **Safe re-homing** — the 3 multisigs rebuilt; ownership re-transferred + accepted
   (see `project_pending_operator_tasks` / the deployer is currently a clean hot wallet).
3. **TOWELI liveness** — non-zero organic daily volume + a staking-participation floor.
   *A launcher on a dormant token advertises its own emptiness — do not un-gate before this.*

## 2. Decisions only the operator can make (blockers)

| Decision | Where it lands | Notes |
|---|---|---|
| **Integrator multisig** | `config.ts` `LAUNCHER_INTEGRATOR_ADDRESS` | Captures Doppler integrator fees (~80–95% of trade fees). MUST be a **re-homed Safe** — never the flagged deployer or the old 0xA360 Safe. |
| ~~Fee constitution~~ **DONE** | `config.ts` `DEFAULT_FEE_CONSTITUTION` | **Finalized 2026-07-17: 1% total — creator 70 / attention 10 / Tegridy 15 / Doppler 5.** Tegridy 15% is below Clanker's 20% survivor ceiling; routes to RevenueDistributor. Doppler ≥5% enforced. Tunable ~10–20% Tegridy if posture changes. |

## 3. Un-gate steps (code — once gates + decisions are met)

1. **`frontend/src/lib/launcher/config.ts`**
   - `LAUNCHER_ENABLED = true`
   - `LAUNCHER_INTEGRATOR_ADDRESS = <re-homed Safe>`
   - confirm `DEFAULT_FEE_CONSTITUTION` final numbers.
2. **Outcomes data source** (Strategy §2.5) — extend the **existing** aggregator catchall
   (`frontend/api/`, do NOT add a serverless fn — Vercel Hobby 12-fn cap, main=9):
   - add a `resource=launcher-outcomes` branch that builds a `LauncherDataFetcher`
     (`fetchMarket` via GeckoTerminal `networks/eth/pools/{pool}` — use
     `base_token_price_native_currency` to stay ETH-denominated; `fetchChainStats`
     via Etherscan `tokenholdercount` + `txlist`, **key server-side only**),
   - call `buildOutcomeRecords` / `buildLaunchSummaries` (`outcomesReader.ts`),
   - feed the discovery list from GeckoTerminal `new_pools` / Etherscan token-tx
     (**not** `eth_getLogs` — dead on free RPCs),
   - resolve the one open input: `feeRevenueEth24h` source (24h volume × fee bps, or
     protocol fee accounting) — pick authoritative, don't guess.
   - wire the returned arrays into `<LaunchExplorer launches=… outcomes=… />` in `LaunchPage`.
3. **Afterlife (optional, Strategy §2.1)** — to un-gate boosted-LP farming, add the
   canonical Uniswap V4 **PositionManager** address to `constants.ts` and set it in
   `afterlife.ts` `defaultAfterlifeAddressBook()`. Until then eligibility honestly
   reports `pending-deployment`. Gauge application auto-flips when
   `GAUGE_CONTROLLER_ADDRESS` is set.

## 4. Fork-verified launch params (bake these into the wizard→SDK wiring)

These are the constraints a real `createDynamicAuction` enforced on-chain (see
`launcher/README.md` findings). `airlock.ts` already encodes them; keep them if the
wizard is wired to submit:

- **Numeraire = native ETH** (`address(0)`) — WETH reverts `InvalidTokenOrder()`.
- **Market cap = `{ start, min }`** (Dutch descends), fee tier **10000 (1%)** (auto-derives
  a valid tickSpacing ≤ 30; `poolConfig(…,60)` reverts `InvalidGamma`).
- **`startTimeOffset ≥ 600s`** — else `InvalidStartTime()` when the tx mines after a delay.
- **Token template pinned `type: 'dopplerERC20V1'`** — SDK default deploys the unverified
  `CloneERC20`; only `DopplerERC20V1` (`0xdb7b…`) passes our gate.
- **Beneficiaries include the Airlock owner ≥5%** — else `InvalidProtocolOwnerBeneficiary()`.

## 5. Pre-launch verification (before flipping the switch)

```bash
cd frontend
npm run build            # THE gate — tsc -b (erasableSyntaxOnly/noUnchecked…) + vite build
npx vitest run src/lib/launcher src/components/launcher   # 101 green
```
Then a **fork/testnet rehearsal** of one real launch end-to-end (the spike harness in
the session scratchpad is the template: anvil fork + doppler-sdk; token mining is slow,
viem confirmation-poll may time out but the tx still mines — check the receipt status).

## 6. Sequencing (don't skip ahead)

- **Phase 1 (mainnet):** un-gate wizard + integrator fees → RevenueDistributor;
  curated first cohort from grants/bounty communities; outcomes dashboard.
- **Phase 1b (Solana):** ONLY after EVM shows signal (≥N real launches). Meteora DBC
  config-key integration; Squads v4 vault as feeClaimer; separate sub-brand; CCTP fee
  repatriation. **No TOWELI on Solana.** (Strategy §3 / Solana research.)
- **Phase 2 (traction + audit gated):** BidWall (Flaunch MIT) on the V4 hook; custom
  Doppler migrator → graduate into own AMM/POL/TWAP (Whetstone whitelist; canonical-V4
  fallback holds); afterlife farming (needs the V4-stack external audit — already a
  relaunch blocker; scope it to cover launcher usage).

## 7. Kill criteria

- Brand-critical incident = a rug executed through a power the **automated gate failed
  to detect** or the Fact Sheet failed to disclose → halt launches, publish post-mortem.
- Disclosed-risk outcomes (post-cliff dumps, abandonment) = tracked on the dashboard,
  NOT incidents.
- <10 real launches or negligible volume at +6 months → freeze Phase 1b/2; the rail
  stays up (marginal cost ≈ 0).

## 8. Deferred quality follow-ups (non-blocking, tracked)

Low-severity items from the code review, safe to leave until touched: viem `zeroAddress`
reuse in `afterlife.ts`; a shared `evaluateFeature()` helper for the two eligibility
blocks; `holderCount` nullable through `OutcomeRecord`; per-line disclosure severity in
`LaunchExplorer`. None affect gated runtime.

## 9. Exotic (token/TOWELI) launches — separate gate

A second, independent gate for pairing launches against **TOWELI** instead of ETH
(`EXOTIC_LAUNCHES_ENABLED` in `frontend/src/lib/launcher/config.ts`, ships **false**).
Everything is built and unit-tested behind that flag; ETH launches are unaffected.

**Why it's safe by construction:** Doppler's dynamic auction mines the token's CREATE2
address to sort against ANY numeraire (`mineHookAddress`), and the initializer's ordering
check is symmetric with no numeraire allowlist. TOWELI's low address (`0x42…`) takes native
ETH's exact path (numeraire = currency0), unlike WETH (`0xC0…`) — so §4's blanket "WETH
reverts `InvalidTokenOrder()`" is a misdiagnosis (it's WETH's HIGH address, not ERC20-ness).
The re-attestation reader (`lockerStream.ts`) derives the migration PoolId per-numeraire; a
mis-derived key can only revert (fail-safe), never surface a wrong split.

**Pre-flip gate (run before setting the flag true):**
1. `node scripts/exotic-toweli-fork-rehearsal.mjs` — spawns an anvil mainnet fork and
   simulates `createDynamicAuction(numeraire=TOWELI)`. Must print `✅ PASS`.
   - Needs an ARCHIVE fork RPC. Keyless `https://eth-mainnet.public.blastapi.io` worked
     2026-07-26; publicnode 403s and drpc-free times out on archive state. Prefer a paid
     endpoint (`ANVIL_FORK_URL=…`) for a stable run.
   - **Result 2026-07-26:** PASS — fork block 25,621,617; no revert; mined token
     `0x65cC…b665` sorted above TOWELI → migration pool `(currency0=TOWELI, currency1=token)`,
     matching the reader's assumption.
2. **Extended lifecycle (do once before prod):** on the same fork, buy the auction through
   to `maxProceeds`, trigger `migrate`, and assert the `StreamableFeesLocker` holds a
   TOWELI/token V4 position with fees streaming. This closes the only source-unverifiable
   residual (the post-graduation path with an ERC20 numeraire). The create step is already
   proven three ways (source, fork simulation, mining).
3. Confirm the live **TOWELI/USD** price feed is fresh (`priceInUsd`, `priceSafeForSwaps`);
   the launch UI already refuses a TOWELI launch on a stale/unavailable price.

**Flip:** set `EXOTIC_LAUNCHES_ENABLED = true`, update the `config.test.ts` "ships GATED
OFF today" tripwire, redeploy. The wizard's base-pair selector and the exotic proceeds band
(`EXOTIC_RAISE_USD`, USD-anchored → TOWELI units) activate automatically. Reversible.

**Solana exotic pairs:** `dbc.ts` accepts any SPL quote mint (SOL/USDC curated, custom with
decimals) — but the Solana rail stays behind its own `SOLANA_LAUNCHER_ENABLED` gate and is
preview-only. **Never TOWELI on Solana.**
