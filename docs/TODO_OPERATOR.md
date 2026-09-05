# The remaining work — everything left, and exactly how to do it

> ### ▶ [**Jump to START HERE**](#-start-here--everything-left-in-the-order-it-should-happen)
>
> The dependency spine, the operator critical path in unblocking order, and the three things an agent
> can finish alone — each written out step by step. Everything below it is the detail behind those. **If you read one section, read
> that one.**

**Written 2026-08-21. Last revised 2026-08-24.** This is the single canonical to-do list.
Everything that could be built without you has been built, tested, and pushed. What follows needs a
key, a credential, a payment, a signature, or a decision — plus a short tail of code work that is
blocked on one of those.

**What changed in the 2026-08-22 revision:** an active address-poisoning warning (read it before you
paste any Solana address); §0.4, the 8.47 SOL released by the program closes and still unreconciled;
Decision 1, whether the Solana own venue restarts at all now that both program ids are permanently
spent; and **"What is running or waiting on me" expanded from three bullets to the real ordered
queue**, with every count re-verified against the tree rather than carried forward. Five things
closed out at the bottom.

**Scope note.** This file is the *curated* list: what unlocks the most, in the order worth doing it.
The exhaustive inventory is [`EVERYTHING_LEFT_2026_08_15.md`](EVERYTHING_LEFT_2026_08_15.md) — 211
items, last reconciled 2026-08-19. Where the two disagree, this file is newer; where this file is
silent, that one is not empty.

**How to read this.** Items are ordered by *unlock per minute you spend*, not by size. Each has
what to run, what you should see, and what a mismatch means. If a "you should see" does not match,
stop and say so — a surprise is information.

---

## 🟢 2026-08-30 — ISLAND BUILDOUT (WO-3 dry-runs done) — newest layer; supersedes everything below

Branch `claude/bungalow-buildout` (PR #341). Full plan: [`ISLAND_BUILDOUT_MASTER_PLAN_2026_08_30.md`](ISLAND_BUILDOUT_MASTER_PLAN_2026_08_30.md).

**Decision 1 below (BAYLA duration bonus) is RESOLVED ON-CHAIN — do not re-decide.** The
replacement lighthouse pool `EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f` carries the real
ladder (1.00x at 1d → 5.00x at 365d, ~21.9% → ~109.5% APR at the funded rate) and the frontend
is repinned to it. The old flat pool is retired (it still holds the operator's own 1,000 BAYLA
dust-test stake to ~2027-08; nothing can release it).

**WO-3 — Solana lighthouse dry-runs for the three settled Solana residents: DONE, nothing
signed.** All three mints verified ON-CHAIN 2026-08-30 through the ceremony script itself
(it now reads decimals + token program from the chain before planning; `--decimals` is only a
cross-check and the script refuses on mismatch):

| resident | mint | decimals | program | authorities |
|---|---|---|---|---|
| BOBO | `4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump` | 6 | Tokenkeg (classic) | mint+freeze revoked |
| SOY | `8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump` | 6 | Tokenkeg (classic) | mint+freeze revoked |
| BRAINLET | `4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump` | 6 | Tokenkeg (classic) | mint+freeze revoked |

No Token-2022, no extensions, no transfer hooks — the BAYLA ceremony flow works for all three
unmodified. **What broadcasting needs from YOU (per resident, ~10 min each):** pick the rate
(economics are your call — `--rate` is refused with a default on mainnet), then run the printed
dry-run command with `--keypair … --broadcast`, paste the pool address into the registry
`stakePool` slot, and FUND LAST in public. The BAYLA-parity shape used in the dry-runs:
`node scripts/bayla-lighthouse-ceremony.mjs --rate <yours> --mint <mint> --max-days 365
--max-weight 5 --accept-long-lock`. ⚠️ Do NOT broadcast a pool for a resident whose community
has not asked for one — a stake pool is a promise (locks with NO early exit), not a growth hack.

### ✅ THE LIGHTHOUSE ROLLOUT — 12 of 13 DONE (2026-08-30)

**⚠ THE OLD DEPLOY KIT THAT STOOD HERE HAS BEEN DELETED ON PURPOSE.** It listed
the pre-correction RIZZ / SOY / BRAINLET addresses; re-running it would deploy
pools against TICKER-COLLISION IMPOSTORS — tokens sharing the exact name and
symbol of the real residents. Nine pools already exist; do not re-deploy any of
them. Live addresses: `frontend/scripts/addresses.json` (`lighthouse-*`),
pinned in `bungalows.test.ts`.

**Live pools.** Base (vendored Synthetix StakingRewards; notifier = Base
fee-remittance Safe `0xfc5D…fbf1`; no owner role exists): QR, MFER, BNKR, DRB,
JBM. Solana (Streamflow, 1→365d ladder ramping 1.00x→5.00x): BAYLA, BOBO, SOY,
BRAINLET, RIZZ. Every reward vault is EMPTY and every card says so.

**🔴 ⬜ REDEPLOY ALL SIX EVM LADDERS — C1.** `docs/LIGHTHOUSE_AUDIT_2026_09_01.md`
proved rewards are payable out of other stakers' principal. The SOURCE is fixed
(`LighthouseLadder.sol:350` `withdrawPosition` and `:367` `earlyExit` now call
`_payRewards` before `_close`); the six LIVE pools still carry pre-fix bytecode.
**Exposure is zero only while they stay unstaked** — all six read
`totalSupply() == 0`. That is the whole window.

> ⚠️ **The command that used to sit here named `DeployLighthouseStaking.s.sol`.**
> That is the SUPERSEDED vendored-Synthetix contract whose own header (`:21`,
> `:37`) says "reward payouts spend other stakers' principal" — i.e. following
> the old runbook deployed the C1 bug again. The correct script is
> **`DeployLighthouseLadder.s.sol`**. It deploys ONE pool per invocation from
> three env vars, so this is **six separate gas-spending broadcasts**.
>
> ⚠️ **Never put `--private-key` on a PowerShell command line** — it is written
> verbatim to `ConsoleHost_history.txt`. Use `--interactive`, or a
> `cast wallet` keystore.

**PHASE A — preflight, no gas.** Stop if any step disagrees.

```powershell
cd "C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts"
& "C:\Users\jimbo\.foundry\bin\forge.exe" test --match-path "test/vendor/*Ladder*.t.sol"
cd "C:\Users\jimbo\OneDrive\Desktop\tegriddy farms"
node scripts/verify-ladder-builds.mjs --self-test
node scripts/verify-ladder-builds.mjs
```

Note the path: the script is at **repo-root `scripts/`**, not `frontend/scripts/`
— that is what `.github/workflows/registry-onchain.yml:188` runs.

**What it actually prints today (measured 2026-09-05):** PEPE reads
`prefix / replaceable`, and **the five Base pools read `UNREADABLE — eth_call
failed (transport)`**, so it reports only "1 of 6 are still inert". That is a
GUARD bug, not a chain fact — **PR #424 is the fix in flight.** Until it lands,
the guard cannot clear Base, so confirm those five yourself:

```powershell
$pools = @{ QR='0xdcc3a95A0921b83326157132B17770f02094c8E3'; MFER='0x7288DbF43D3BDBfC439B6E8a47Aef225D4816273'; BNKR='0xe0A152EBC21891FD47a7Dcd6018cfE3a64363178'; DRB='0xB62BaD165997E95C503044787b2Dcc85DC6D83F1'; JBM='0xA0D43eF39C4940e68b2f81d51E6316a45C136D93' }
foreach ($k in $pools.Keys) {
  $body = @{ jsonrpc='2.0'; id=1; method='eth_call'; params=@(@{ to=$pools[$k]; data='0x18160ddd' }, 'latest') } | ConvertTo-Json -Depth 5 -Compress
  $r = Invoke-RestMethod -Uri 'https://mainnet.base.org' -Method Post -ContentType 'application/json' -Body $body
  "{0,-5} totalSupply = {1}" -f $k, $r.result
}
```

**Every one must be all zeroes.** Measured 2026-09-05: all five returned
`0x000…000`, and PEPE is `replaceable` — so all six are unstaked and this is a
REPLACEMENT, not a migration. **Re-run it immediately before Phase B**, because
the window closes the moment anyone stakes. A non-zero result on any pool means
STOP: that pool now holds someone's principal and needs a migration plan.

**PHASE A2 — dry run each pool (no `--broadcast`, costs nothing).** This
exercises every `_validate` gate, including the decimals assumption:

```powershell
cd "C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts"; $env:EXPECTED_CHAIN_ID='8453'; $env:REWARDS_DISTRIBUTION='0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1'; $env:STAKING_TOKEN='0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf'; & "C:\Users\jimbo\.foundry\bin\forge.exe" script script/DeployLighthouseLadder.s.sol --rpc-url https://mainnet.base.org
```

**PHASE B — deploy. SPENDS GAS. IRREVERSIBLE.** Each broadcast creates a
permanent address with an **immutable** `rewardsDistribution` — there is no
setter and no undo. Do **QR first** as the cheap rehearsal, then the other four
Base pools, then PEPE on mainnet last. Add `--broadcast --interactive` to the
Phase A2 line, changing only `STAKING_TOKEN`:

| # | Pool | Chain | `STAKING_TOKEN` | replaces `stakePool` |
|---|------|-------|-----------------|----------------------|
| 1 | QR   | Base 8453 | `0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf` | `0xdcc3a95A0921b83326157132B17770f02094c8E3` |
| 2 | MFER | Base 8453 | `0xe3086852a4b125803c815a158249ae468a3254ca` | `0x7288DbF43D3BDBfC439B6E8a47Aef225D4816273` |
| 3 | BNKR | Base 8453 | `0x22af33fe49fd1fa80c7149773dde5890d3c76f3b` | `0xe0A152EBC21891FD47a7Dcd6018cfE3a64363178` |
| 4 | DRB  | Base 8453 | `0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2` | `0xB62BaD165997E95C503044787b2Dcc85DC6D83F1` |
| 5 | JBM  | Base 8453 | `0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d` | `0xA0D43eF39C4940e68b2f81d51E6316a45C136D93` |
| 6 | PEPE | Ethereum 1 | `0x6982508145454ce325ddbe47a25d4ec3d2311933` | `0xdC0B34cE782029f30382F42097f6b33F0544329c` |

Base rows use `EXPECTED_CHAIN_ID='8453'`,
`REWARDS_DISTRIBUTION='0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1'`,
`--rpc-url https://mainnet.base.org`. PEPE uses `EXPECTED_CHAIN_ID='1'`,
`REWARDS_DISTRIBUTION='0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d'`,
`--rpc-url https://ethereum-rpc.publicnode.com`.

If `L-INV-11` / `L-INV-12` revert, the build is pre-fix: **abandon that
contract and rebuild — do not repin it.**

**PHASE C — repin, in this order, no gas.** Hand the printed addresses to the
agent; it derives EIP-55 with `getAddress(addr.toLowerCase())`, **never
hand-typed** (a hand-typed checksum silently broke four Base cards on
2026-08-30). Order matters — `bungalows.ts` is what the CI gate parses:

1. `frontend/src/lib/bungalows.ts` — the six `stakePool` values (`:334-340`).
2. `frontend/scripts/addresses.json` — the `ladder-*` address fields; flip the
   superseded entries to `"status": "retired"` with a reason, don't delete them.
3. `frontend/src/lib/bungalows.test.ts:283-289`.
4. **Leave `frontend/src/lib/lighthouseLadder.ts` `C1_UNSAFE_LADDER_POOLS`
   ALONE** — it is keyed by address and self-lifts on repin. Clearing it by hand
   would un-freeze the abandoned pools.

**Why C1 cannot be proven directly on-chain:** the fix is a pure statement
reorder — no selector change, no readable value. But the C1 commit `4164294c` is
an ancestor of the `MIN_STAKE` dust-floor commit `3cba6608`, so an on-chain
`MIN_STAKE() == 100e18` transitively proves the ordering fix is in the deployed
bytecode. That is exactly what `verify-ladder-builds.mjs` gates on, and why
"registry vs chain" in `.github/workflows/registry-onchain.yml` is the check
that closes this out.

Hand the printed address to the agent: it derives the EIP-55 form with
`getAddress(addr.toLowerCase())` — NEVER hand-typed, since a hand-typed
checksum silently broke four Base cards on 2026-08-30 — wires the registry,
and pushes.

**⬜ BEFORE FUNDING ANY BASE POOL — prove the notifier Safe can execute.** All
five Base lighthouses bind `rewardsDistribution` to `0xfc5D…fbf1` PERMANENTLY
(the vendored contract exposes no setter). The registry records that Safe as
never having executed a transaction. Do a throwaway Safe transaction from it
first; if it cannot execute, those five pools can never be funded and would
have to be redeployed with a working notifier.

**⬜ FUND LAST, IN PUBLIC.** EVM: `contracts/script/FundLighthouseStaking.s.sol`
enforces the same-token law (`reward <= balanceOf(pool) - totalSupply()`) in the
broadcast path — but the broadcaster must BE the notifier Safe, so run it with
`--sender` and execute the printed calls through the Safe UI rather than
broadcasting an EOA transaction. Solana: `--fund --pool <addr> --amount <whole>`
on the ceremony script.

**⚠ VERCEL ENV FOOTGUN.** `VITE_BAYLA_STAKE_POOL`, if set in Vercel, OVERRIDES
the hardcoded BAYLA pool. It must be unset or exactly
`EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f`. The ceremony script's closing
"set this in Vercel env" line applies to BAYLA ONLY — never point that variable
at another resident's pool; every other pool is hardcoded in the registry.

---

## 🟢 2026-08-29 — SOLANA LP VENUE + BAYLA SURFACES — supersedes everything below

Two sessions' work. Full records: [`SOLANA_LP_VENUE_2026_08_29.md`](SOLANA_LP_VENUE_2026_08_29.md)
and [`BAYLA_STAKING_SWAP_2026_08_28.md`](BAYLA_STAKING_SWAP_2026_08_28.md).

**Baseline after: frontend 446 files / 6,279 tests green, tsc clean, eslint clean, a11y green on
`/pools`, `/solana` and `/swap` across chromium + iPhone + iPad + mobile-chrome.** Still unpushed.

**Landed (do not redo):** the BAYLA lighthouse staking module rebuilt on the TOWELI card pattern
(lock presets as buttons carrying each lock's rate, "paying now 0%" beside "configured 109.5%",
unstake disabled until the lock opens) · the Solana swap ungated and a `ChainSwitch` on both trade
surfaces · the Bayla dashboard reworked · **the whole cp-swap client, own-pool router and `/pools`
surface**, built to the deploy boundary.

### 🔴 THE SOLANA LP VENUE — only you can unblock it, and it is ONE instruction from live

Everything on the client side is written, tested and merged. The venue itself needs five things,
in this order. Detail and the traps are in `SOLANA_LP_VENUE_2026_08_29.md` §3.

1. **Generate a fresh keypair** for cp-swap and put its pubkey in `declare_id!`. The old id
   (`3ZvZXEBr…`) was closed 2026-08-13 and is permanently SPENT — it can never hold a program again.
2. **`admin::ID` must be a signable, system-owned, FUNDED account.** It is resolved at compile
   time, so getting it wrong costs another program upgrade. ⚠️ This is exactly what bricked
   2026-08-08: it was set to the Squads MULTISIG ACCOUNT, which can neither sign a CPI nor pay
   rent, which made `create_amm_config` permanently uncallable. Fund it above AmmConfig rent —
   the audit found it holding 0.001 SOL.
3. **`create_pool_fee_reveiver::ID` must be a WSOL TOKEN ACCOUNT, not a wallet** — the create path
   deserializes it as `InterfaceAccount<TokenAccount>` and calls `sync_native`. Also compile-time.
   Create the treasury's WSOL ATA **before** the deploy.
4. **Deploy, then run `create_amm_config`** — the two-step that has never once run in this
   program's history. Recommended args (0.25% trade / 12% protocol / 4% fund / 0.15 SOL create /
   0% creator → trader pays 0.25%, LPs keep 0.21%, venue takes 0.04%):
   `create_amm_config(0, 2500, 120000, 40000, 150000000, 0)`
5. **Publish the new id as `VITE_SOLANA_CPSWAP_PROGRAM`.** `/pools` goes live, the fee sheet starts
   reading off chain, and the swap starts quoting our own pools — no code change, no frontend
   redeploy needed beyond the env var.

Optional but cheap, and it protects the whole thing: **arm branch protection on `mvp-launch`.**
`diff-guard` — which proves the AMM is still verbatim Raydium — has **zero required checks**, so it
is advisory today. Unenforced, it is a comment.

### ⬜ REMAINING — an agent can do these alone, AFTER the deploy above

1. **Wire execution against our own pool.** The instruction builders exist and are source-verified
   (`lib/solana/cpswap/ix.ts`), but nothing sends them, because the program is not deployed and an
   unexercised money path is the ledger's most common defect class. Moot until step 4 above: with
   no venue, the router always picks the aggregator. CI's `migration-rehearsal` job is where these
   builders get their first real execution.
2. **The LP forms on `/pools`** — create-pool / deposit / withdraw. Same reason, same unblock.
3. ⚠️ **PICK ONE HOME for cp-swap client code — this is the repo's THIRD "two
   implementations of one thing".** `lib/launcher/solana/curve/program.ts` grew
   cp-swap PDA helpers (`cpAmmConfigPda`, `cpAmmAuthorityPda`, `cpLpMintPda`,
   `cpPoolVaultPda`, `cpObservationPda`) because `migrate_to_amm` has to derive the
   pool it migrates into; `lib/solana/cpswap/program.ts` (2026-08-29) derived them
   again. They are pinned EQUAL by `cpswap/pdaAgreement.test.ts`, so the duplication
   is safe today and any divergence fails loudly — but it should be one home.
   **Recommendation: `lib/solana/cpswap/` wins** (it is the dedicated client, its
   seeds are checked against the Rust source, and it refuses to default to the SPENT
   program id, which the launcher helpers do). Do it AFTER the branch below merges —
   refactoring under an open branch on the same file is how a divergence becomes an
   unreviewable conflict.
4. 🔀 **Review and merge `claude/create-amm-config-builder`** (worktree `C:/tw`,
   commit `c16191e7`, clean, unmerged). A parallel session built the
   `create_amm_config` / `update_amm_config` instruction builders — the one thing
   `/pools` does NOT build (it renders the args for the operator to run by CLI).
   Its `createAmmConfig` discriminator matches the one derived independently here
   byte-for-byte, and it documents the same BE-seed / LE-arg asymmetry. It lands in
   the curve client's `ix.ts`; per item 3 it probably belongs in
   `lib/solana/cpswap/ix.ts` instead.
5. **Move Jupiter routing to the self-hosted swap API.** The routing ENGINE stays (most volume,
   longest track record on Solana; swapping to a smaller aggregator is backwards from rule 0). The
   hosted `lite-api.jup.ag` endpoint is the real dependency — if it rate-limits, our swap dies.
   ⚠️ The aggregator security-history research was interrupted and never finished; if an engine
   change is ever considered, finish that first.

### 🔴 Two decisions on the BAYLA lighthouse pool

1. ✅ **RESOLVED ON-CHAIN 2026-08-30 — see the 08-30 layer at the top.** The ladder pool exists
   (`EFWpSpH9…EZ9f`, 1.00x→5.00x) and the frontend points at it; the flat pool is retired.
   Original text kept for the record:
   **The pool grants NO duration bonus.** `minWeight == maxWeight == 1e9`, so a 365-day lock earns
   exactly what a 1-day lock earns — only the exit date changes. `maxWeight` is set at pool
   CREATION, so a TOWELI-style "lock longer, earn more" curve needs a **new pool and a staker
   migration**. The UI already implements the program's real weight curve and would light up with
   zero code changes. Decide; do not assume either way.
   ✅ **The tool for it already exists:** a parallel session added `--max-weight <x>` to
   `frontend/scripts/bayla-lighthouse-ceremony.mjs` (`d9ab6c92`), which sets the bonus at
   `--max-days` ramping linearly from 1.00x, and prints the resulting LOCK LADDER (weight,
   effective daily rate, simple APR per tier) before anything is signed. It independently
   confirmed the same finding: `maxWeight` is a stake-pool field with **no update
   instruction**, so it is fixed for the life of a pool.
2. **A one-click "top up the reward vault"** is buildable (the reward pool is `permissionless:
   true`, and the SDK ships `fundPool`) and was left out only because Streamflow takes a protocol
   fee on funding that must be read and disclosed first. Say the word.
3. **The vault is still empty**, so the lighthouse pays 0% — unchanged, and the panel says so in
   four places.

---

## 🟢 2026-08-28 (LATE) — CONSOLIDATION SWEEP — newest layer; supersedes everything below

A wrap-up pass over every parallel session. Full record:
[`CONSOLIDATION_2026_08_28.md`](CONSOLIDATION_2026_08_28.md).

**Trunk is now 49 commits ahead of `origin/mvp-launch` and UNPUSHED.**
Ten branches merged, two stranded worktree fixes rescued. Verified before commit:
**frontend 437 files / 6,126 tests green, tsc clean; contracts 81 tests green across the 8 merged
suites.** Nothing here is pushed and nothing is deployed.

**Landed this sweep (do not redo):** NativeBuyRouter first coverage · restaking bonus-insolvency
fix (CONFIRMED HIGH) · nftfi vault seizure-race fix (CONFIRMED) · v4 BoostedLP zero-oracle
`emergencyWithdraw` · v2 forfeit deletion + additive power legs · row 8 TWAP re-anchor + the
V2-provenance CI gate (this carries **PR #335**'s commits) · the 08-28 frontend audit (53 findings,
46 fixed, incl. the `/bayla` infinite-reload) · the components ghost-code guard.

### ⬜ REMAINING — an agent can do these alone

1. **Rebase `prep/island-wave-five`** (1 commit, 25 files — the homepage "arrival inversion").
   Conflicts with the avantgarde audit on `frontend/index.html` + `frontend/vercel.json`; the CSP
   header is the only genuinely contested line. Both changes are wanted.
2. **Reconcile `claude/bungalow-buildout`** (2 commits, 43 files — Base scanner, curve trust strip,
   dead-end funnels) against the Bayla parity work. Conflicts on `lib/bungalows.ts` and
   `ArtStudioPage.tsx`: two divergent implementations of the same bungalow surface. **Pick one** —
   this is the third "two incompatible versions of the same feature" in this repo.
3. **Retire `claude/curve-discovery-grid`** — superseded by trunk's own curve discovery
   (`c8bd1a31` + the origin curve commits). Confirm nothing unique is stranded, then delete.
4. **Prune ~40 April-2026 agent worktrees** that carry dirty trees. They are 4 months and 100+
   commits stale and they poison every future worktree sweep with false positives.
   ⚠️ Remove junctions with `cmd /c rmdir`, **never** `rm -rf` — that has already deleted 961
   vendored-lib files out of the main checkout once.
5. **Un-pin foundry.** `ci/pin-foundry-toolchain` pinned 1.7.1 because the two reentrancy suites
   flipped red under 1.8.0. The actual cause is now fixed on trunk (`a04b8a8a`, non-zero sentinel
   arming). Re-test on 1.8.0 and drop the pin if green.

### 🔴 REMAINING — only you can do these

1. **THE SIGNING SESSION — closes Sept 2–3.** Unchanged and still the top item; see the
   2026-08-28 layer below and [`SIGNING_SESSION_2026_08_28.md`](SIGNING_SESSION_2026_08_28.md).
2. **Decide whether to push.** 48 commits sit local. Nothing reaches prod until you push; prod
   auto-deploys on green trunk, so **pushing this sweep deploys the frontend audit's 46 fixes.**
3. ⚠️ **The LIVE staking over-mint is pinned but NOT fixed** (`StakingRewardOverMint.t.sol` is a
   passing `_KNOWN_DEFECT` characterization — it goes red when the bug is fixed). Reward liability
   inflates ~2× as the pool nears depletion. **Interim, no redeploy: keep the reward pool funded
   ahead of emission — top up, or cut `rewardRate` — BEFORE the reserve depletes (~2026-10-11).**
   That keeps the cap from binding. The real fix is the Synthetix funded-period rebase, a migration
   on a live contract.
4. **US regulatory decisions** + **distribution** — unchanged, see the layer below.
5. **Exclude the repo from OneDrive sync.** Now also implicated in wedged `forge` invocations
   (two builds hung at ~2s CPU and had to be killed this session), not just stale `node_modules`.

---

## 🟢 2026-08-28 STATE — the curve / audit / US-compliance layer

A curve-launchpad + audit + US-compliance session. The launchpad now has a **usable, tested front
door** (token identity, discovery, honest copy) and the fleet closed a real trapped-NFT bug. What's
left needs YOU — a signature, a decision, or counsel — in unlock-per-minute order.

**CLOSED this session — do not redo (all pushed + prod-verified):**
- Curve **token identity** (image/description/socials via Irys, no redeploy) + **discovery** (Live
  Launches grid + permanent `/eth-curve/:token` page + creator claim UI). The launchpad's #1–#3
  competitive gaps. Live on prod (verified in the deployed chunk).
- **17/17 L2 contracts verified** on Base (Etherscan) + Robinhood (Blockscout).
- **v4 BoostedLPStaker**: audit found a REAL trapped-NFT path (oracle ABI-break re-traps under
  0.8.26, both cases); fixed with a zero-external-call `emergencyWithdraw` hatch, mutation-verified.
- **US misleading-claims copy fix** (`cdedbc22`): the curve reserve claim now matches what the code
  enforces ("ecosystem reserve… discretionary, not enforced on-chain"; dropped the "bribes"/"survival"
  over-promise) + a creator-issuer/securities line at the create point. Live.
- **First-creator flow now regression-protected** (`0f1ae62b`): 4 mutation-checked container tests
  pin the upload-before-tx safety ordering, receipt-log parse, and identity-retry path.
- **CORRECTION to the "redeploy on ask" standing item below:** prod **auto-deploys on green trunk**
  now — verified this session on multiple commits (Vercel posted success without the CLI). The
  CLI-redeploy standing item is retired unless a deploy visibly fails.

**WHAT NEEDS YOU — in order:**

1. 🔴 **THE SIGNING SESSION — dated, closes Sept 2–3.** One sitting, 11 transactions, every value
   read live and every selector derived. Full runbook with paste-ready calldata:
   [`SIGNING_SESSION_2026_08_28.md`](SIGNING_SESSION_2026_08_28.md).
   - **Part A — 2-of-2 accept ceremony**, 4 tx per L2 from the multisig Safe `0xBC4E…Be5B`
     (Base `acceptFeeToSetter` deadline **2026-09-02 07:20 UTC**; RH **2026-09-03 05:02 UTC**). The
     TWAP `acceptOwnership` is ordered first as each nonce-0 Safe's smoke test — if it fails, STOP,
     nothing is lost.
   - **Part B — reserve-recipient → Treasury Safe**, one `setLaunchConfig` per chain (mainnet + both
     L2s). **FREE while `launchCount` is 0 on all three (verified); permanently impossible for any
     launch created before it** (recipient is snapshotted per-launch). Do it in the same sitting.
   - Miss the deadline = re-propose + wait; not fatal, but roles stay on the hot deployer EOA.

2. 🟡 **US regulatory decisions — counsel + operator.** Copy is now honest (done); "within bounds"
   still needs you. Risk-ranked with cost-to-mitigate: [`US_COMPLIANCE_BRIEF_2026_08_28.md`](US_COMPLIANCE_BRIEF_2026_08_28.md).
   Cheapest-high-impact, no lawyer needed: **geoblock US/sanctioned jurisdictions** (representation-only
   today, no geofence in code) and **form an entity before the first fee dollar** (Terms admit none
   exists). Needs counsel: securities status of the curve tokens + the promoted-earnings model. The
   pump.fun SDNY docket (all-memecoins-are-securities + RICO/"casino") is the roadmap — your model has
   MORE ecosystem features, so more exposure, but zero launches = low target profile today.

3. 🟢 **Distribution — the actual Sept-30 bet.** The product is done; the constraint is one external
   human paying us. Highest-probability path is a NAMED person, not SEO: a BAYLA/island community
   member launching a sister token, or one of hood.fun's ~68 orphaned creators (hood.fun died —
   "for sale" — leaving working tokens with no venue). Outreach is operator work; Claude can build
   the target list + pitch assets on request.

4. ⚙️ **Environment — exclude the repo (or `frontend/node_modules`) from OneDrive sync.** OneDrive
   keeps reverting the checkout's installed deps to a stale cloud snapshot (~20-min half-life),
   breaking local tooling repeatedly. A settings change only you can make; zero effect on prod/CI.

**Still moving (fleet, not you):** v2 forfeit-deletion residuals (dead views + a contradictory doc
comment), NativeBuyRouter test-gaps, and the #336 provenance stack (equivalence independently proven
bit-identical; its operator half — redeploy the SwapFeeRouter stack to actually LAND row 8 — is
tracked in this file's row-8 section).

---

## 🟢 2026-08-25 STATE — this layer supersedes the sections below where they disagree

An 08-24 full scan → same-day fix session → 08-25 go-live + an 8-lane verified sweep moved a lot.
Every claim here is probe- or read-verified today, not carried forward.

**CLOSED — do not redo:**
- ~~§0.1 login change-set~~ — **DONE 08-25, live**: DROPs + 014 + 013 applied; SIWE `?action=nonce`
  → 200 (production's first ever); analytics `accepted:1`. Never run 008 after — rule stands.
- ~~§0.2 redeploy~~ — done 08-25 morning… **and already owed again**: six fix-pushes since (see
  the new standing item below).
- ~~§1.2 birth secret~~ — set + verified (invalid-body probe passes the secret gate → 400).
- ~~§1.3 DBC v2~~ — stays retired. ~~Decision 4 light-scrim~~ — superseded by the 08-23
  light-mode removal. The Slither triage is NOT "unrefuted": `SLITHER_TRIAGE_2026_08_22.md`
  Appendix A IS the refutation pass — 12 verdicts rejected, **8 real pre-deploy contract defects
  to fix; no suppressions until then**.

**NEW STANDING ITEM — redeploy on ask.** Prod deploys are CLI-only and agent-blocked, so after
any fix batch: `npx vercel --prod --yes` from repo root. Right now prod is 6 pushes behind trunk
(incl. the 332KB vendor-solana first-paint unweld and the API timeout/failover batch).

**CLOCK CORRECTION — the top decision is now dated ~Sept 30.** Live reads 08-25:
`rewardsRemaining` = 2,549,296 TOWELI at 71,219/day ⇒ **the staking reward pool runs dry in
~5 weeks** (docs said ~Oct 11; the balance-based figure is an upper bound). Top-up or rate-cut —
one sentence, then it's executable.

**THE ONE-SESSION SWITCHBOARD (§2.1 grew):** migrations **016–021 plus the new 022/023**
(`frontend/supabase/migrations/` — 022 = the recovered native_orders/trade_offers REVOKE with its
preflight inline; 023 = 004 §2 standalone). Order: 017 AFTER 015 (done), rest order-free, never
008 after any of them. Probe-verified today: all six stores answer schema-missing/store-unavailable;
**every env var except `BOT_LINK_SECRET` is already set** — the doc's env worries are stale.

**MULTICHAIN (M.2 gate):** M.1's four role Safes verified live on BOTH chains — but all eight
instances have **nonce()==0: the "proven signers" smoke test has never run** and is the sole
blocker before M.2. Full addresses + warnings now in `frontend/scripts/addresses.json`
(`l2-*-safe`); receipts on trunk; **4663 deploys use `docs/ROBINHOOD_CAST_REPLAY.md`** (forge
cannot broadcast there — the old script headers said otherwise and are fixed).

**CORRECTION to an 08-24 note:** the Whetstone petition is NOT "no longer necessary" in
general — the own-curve rail doesn't need it, but the Doppler/V4 graduate-to-us leg still does
(§ TIER 3 stands). Its merge precondition is now satisfied; re-run the §15 reads before sending.

**Fee rail (pre-deepening precondition):** re-verified unchanged — 2.4e12 wei still parked in
`ReferralSplitter.callerCredit`; permissionless `recoverCallerCredit()` never called. The
registry's false "earned 0 wei" note is corrected.

**Dependabot:** all 8 open PRs (#324–331) rebased onto today's green trunk — merge them when
their checks finish. Two absorbed doc branches still owed a delete:
`git push origin --delete claude/sad-almeida-bde63d todo-update` (agent-blocked).

⛔ **NEW 2026-08-26 — the Robinhood curve launcher is LIVE and its reserve recipient is an EOA.**
`TegridyCurveLauncher` deployed to Robinhood 4663 at **`0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5`**
(tx `0x0b18e2dd…d2bc`, block 46343018). Verified on chain 2026-08-26 — owner, pauseGuardian and
treasury are all the correct L2 role Safes, WETH matches, and the FACTORY answers `getPair`, so
graduation is **not** stranded.

**One thing is wrong and it is worth fixing before the first launch:**
`reserveRecipient` = `0x14898258122C0740106391E6e8E4F17F3b6d456E` — **the deployer EOA, not a Safe.**
`reserveBps` is 369, so **3.69% of every launch's 1,000,000,000 supply transfers to that single key
at graduation**, while every other role on the same contract went to a 2-of-2 Safe.

- Fix: `setLaunchConfig(...)` with the same values and a Safe as `reserveRecipient`. It is
  **owner-only**, and the owner is `l2-multisig-safe`.
- **`launchCount()` is 0**, so this currently costs nothing. After the first launch it does.
- Convenient side effect: that transaction is exactly the **"prove the Safe can sign" smoke test**
  the M.2 gate has been waiting on — all eight role-Safe instances still read `nonce() == 0`.

Also noted, same shape as mainnet: the Robinhood factory's `feeToSetter` is still the deployer EOA
(`feeTo` is correctly `l2-fee-remittance-safe`), so the fee-rotation ordering in
`docs/GOLIVE_HANDOFF.md` applies on this chain too — **`executeFeeToChange()` before
`acceptFeeToSetter()`, and the first is the deployer's call, not the Safe's.**

🛑 **NEW 2026-08-26 — two PRE-DEPLOY defects in `StreamingRevenueDistributor`, found by an
adversarial review and confirmed by independent adjudicators.** The contract is deployed nowhere
(no `addresses.json` entry, no `lib/constants.ts` constant), so this is **not live money** — but
both are true of trunk today and both must be closed before it ships:

1. **A stranger can drive a victim's grace anchor BACKWARDS.** `_observeLockEnd` assigns
   `lastObservedLockEnd` with no `>` guard and is reachable from the permissionless `sync`.
   `StakingRewardLib.afterTokenTransfer` writes `userTokenId[to] = id` unconditionally, and its
   `AlreadyHasPosition` guard only fires when `userTokenId[to] != 0` — exactly 0 for someone who
   just withdrew. So transferring an EXPIRED dust veNFT to a victim (an ERC-721 transfer needs no
   consent) and calling `sync(victim)` slams their claim grace shut and flips them to forfeitable.
   On trunk that is a complete stranger-executed confiscation, because trunk's `sync` forfeits
   directly.
2. **A permissionless `sync` moves value BETWEEN accounts.** An unreadable escrow/restaking read
   collapses to zero, `_updateReward` writes that zero into `effectiveBalanceOf`, and the stream
   re-prices onto whoever stayed mirrored. Measured **22× amplification** via `syncMany` over 50
   victims; the victim has no defence, and it ignores the staking kill switch.

Full account, plus the three regressions that refuted the attempted fix:
[`V2_FORFEIT_ATTEMPT4_REFUTED_2026_08_26.md`](V2_FORFEIT_ATTEMPT4_REFUTED_2026_08_26.md).
⛔ Branch `fix/v2-owner-timelocked-forfeit-v4` is **attempt 4 and is REFUTED — do not merge it.**

**Five standing rules.**

0. 🏛️ **ETHOS — stand on battle-tested, billion-dollar, never-hacked protocol code.**
   *Operator instruction, 2026-08-26.* Where a mechanism has already been solved by a protocol that
   has held nine or ten figures for years without being drained — OpenZeppelin, Uniswap, Curve,
   Synthetix, Aave, Safe, Solady — **use theirs, unmodified, and inherit their audit history.**
   Novel Solidity is a liability we underwrite ourselves; forked Solidity is a liability someone
   else has already paid millions to have attacked.

   How to apply it, so it is a rule and not a slogan:
   - **New code:** before writing a contract, name the upstream that already does this and say why
     it cannot be used as-is. "Ours is nicer" is not a reason. Gas is rarely a reason.
   - **Forks:** track the upstream version and keep the diff SMALL and WRITTEN DOWN. A fork that has
     drifted far enough that upstream's audits no longer describe it is bespoke code wearing a
     trusted name — the most dangerous category, because it reads as safe.
   - **Existing code:** the audit in
     [`CONTRACT_PROVENANCE_AUDIT_2026_08_26.md`](CONTRACT_PROVENANCE_AUDIT_2026_08_26.md) grades
     every contract against this rule. Work the un-anchored ones down in risk order, live first.
   - **The honest tension:** ~47,000 lines of Solidity across 72 contracts already exist and ~30 are
     live. This rule cannot be applied retroactively by rewriting everything. It governs (a) every
     new contract from today, and (b) the prioritised remediation list in that audit.

**Four standing rules.**
1. Claude never types a secret into a field. Where a step involves a key, you set it. Never paste a
   secret into a chat, including to me.
2. Claude never changes security settings on live infrastructure and never signs anything that
   moves value.
3. ⏸️ **The Safe / custody situation is deferred by your instruction.** It is not on this list, it
   is not a blocker, and no session should reopen it. Facts preserved in
   [`WHAT_I_NEED_FROM_YOU.md`](WHAT_I_NEED_FROM_YOU.md) §0.3.
   *Update 2026-08-22:* the **Squads 2-of-2 is no longer an unknown** — it executed both program
   closes on 2026-08-13, so both member keys are real and usable. That removes the standing risk
   that 8.4 SOL and two programs were locked behind a threshold nobody could reach.
4. 🎣 **Never copy a Solana address out of wallet history or an explorer activity feed.** See the
   poisoning warning immediately below. Take addresses from `frontend/scripts/addresses.json`.

---

# 🎣 READ THIS BEFORE YOU PASTE ANY SOLANA ADDRESS

You are being **address-poisoned**, currently and specifically.

```
Dcj1fGKYXCCyNsovXYtbyoKfDkUb8Hzty3gkoYVYADZ7   <- theirs
Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7   <- the real deploy authority
```

`Dcj1` versus `Dcji` — a digit one where the letter i belongs. Both are legal base58 and they are
indistinguishable at a glance in a wallet's transaction list. That address sent 1000-lamport dust to
an operator wallet **59 seconds after** a 3.4566 SOL deposit landed there, and again on a separate
day. A second sprayer, `5GHWLcQBAc9vMeZprtVFtqrzstX8SG3oTscNrfsbAdfV`, blasts 1-lamport dust at many
wallets at once.

The dust exists for one reason: to sit in your history looking like an address you already use, so
that a later copy-paste goes to them. It costs them nothing and it only has to work once.

**The rule:** addresses come from `addresses.json`, and `node frontend/scripts/verify-addresses.mjs
--onchain` decodes them. Never from history, never from a screenshot, never from a chat message —
including mine. Compare character-for-character against the registry before any transfer.

---

# TIER 0 — free, minutes each, unlocks the most

## 0.1 ⭐ Run the login change-set — the single biggest unlock

**Time:** ~2 minutes. **Cost:** nothing. **Unlocks:** the entire social tier.

Login has never worked in production: `siwe_nonces` does not exist, so every sign-in 500s. Until it
works, profiles, DMs, watchlists, votes, push notifications, alerts, referral claims and real
analytics are all dark — and analytics events are currently printed to the visitor's own console
and discarded.

**Do this in the Supabase dashboard → SQL Editor, one session, in this order.**

**Step 1 — the eight DROPs** (this is the security fix; it is a no-op on empty tables):

```sql
BEGIN;
DROP POLICY IF EXISTS "Anyone can delete favorites"   ON public.user_favorites;
DROP POLICY IF EXISTS "Anyone can insert favorites"   ON public.user_favorites;
DROP POLICY IF EXISTS "Anyone can upsert own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Anyone can update own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Anyone can delete watchlist"   ON public.user_watchlist;
DROP POLICY IF EXISTS "Anyone can insert watchlist"   ON public.user_watchlist;
DROP POLICY IF EXISTS "Anyone can insert votes"       ON public.votes;
DROP POLICY IF EXISTS "Anyone can update own vote"    ON public.votes;
COMMIT;
```

⛔ Run **Section 1 only** of `015_drop_permissive_policy_overrides.sql`. Section 2 is commented out
deliberately — enabling it blanks the public vote tally until an aggregate view exists.

**Step 2 — verify, both queries.** The first must return **zero rows**:

```sql
select tablename, cmd, policyname from pg_policies
 where schemaname='public' and permissive='PERMISSIVE' and cmd <> 'SELECT'
   and coalesce(qual, with_check)='true'
   and tablename in ('user_favorites','user_profiles','user_watchlist','votes');
```

The second must show the **owner** policies survived — including **both** `votes` twins
(`"Owner can insert votes"` *and* `"Owner can update own vote"`). The votes write is an upsert; with
only one twin, voting writes fail after the drops:

```sql
select tablename, cmd, policyname from pg_policies
 where schemaname='public'
   and tablename in ('user_favorites','user_profiles','user_watchlist','votes')
 order by tablename, cmd;
```

**Step 3 — run `014_siwe_nonces.sql` whole, same session.** It ends with
`NOTIFY pgrst, 'reload schema';` — **do not stop before that line**, or the table exists while the
API keeps insisting it does not.

⛔ **Never run migration 008 after 014.** Its blanket GRANT undoes 014. If you have ever run it,
tell me — repairable, but it has to be known.

**Step 4 — prove the lock bit.** With the **anon** key (not the service key), try an insert into
`user_favorites`. You want it **rejected** with `42501`. A `23502` not-null error instead means the
policy did *not* bite and the write got through — stop and tell me.

**Tell me:** the row count from re-running the full enumeration. **It should be 13** (down from 21).

*Already verified for you:* I ran the enumeration against your live database. All 21 permissive
policies are accounted for — 8 targets, 4 deferred read-side, 9 intentional public/service-role.

---

## 0.2 Redeploy Vercel

**Time:** ~5 minutes including build.

`VITE_*` variables are baked in at **build** time, so setting one without redeploying changes
nothing. Several shipped fixes are waiting on this:
- the CSP fix that currently **browser-blocks Pro Pass collection creation**
- the write-proxy repoint (so writes survive step 0.1)
- the analytics endpoint

**While you are in Settings → Environment Variables, set:**

| Variable | Value | Why |
|---|---|---|
| `VITE_ANALYTICS_ENDPOINT` | `/api/analytics` | Events currently print to the visitor's console and vanish |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` | Push; nothing can subscribe until 0.1 is done |
| `VITE_VAPID_PUBLIC_KEY` | same public value | The browser needs the public half |
| `VAPID_SUBJECT` | `mailto:` your address | Currently points at a dead domain |

**And confirm two that already exist** (check, do not change): `SUPABASE_SERVICE_KEY` must be
present and the SIWE JWT must carry a `jti` claim — the write proxy fails closed without them, so
every write would 503 the moment login starts working.

Then run `013_analytics_events.sql` and redeploy once more so both halves land.

---

## 0.3 Back up the deployer keystore + password — offline, two locations

**Time:** ~10 minutes. **This is not a custody decision; it is a backup.**

`OwnableNoRenounce` disables renounce and rejects transferring to the zero address. Lose that one
file and **18 mainnet contracts become permanently unownable.** Cheapest item on this page against
the worst tail on it.

**Same trip, same drawer:** `mainnet-deploy-authority.json`. It has **no seed phrase** — generated
`--no-bip39-passphrase --silent`, so the keyfile *is* the backup, and it is the key any Solana
restart deploys from. Verified 2026-08-22: the keys directory is gitignored, no keypair JSON has
ever been committed, and `README-IDENTITIES.md` beside it holds only public pubkeys — no mnemonic,
no secret-key blob. That hygiene is good; it is also why losing the file is unrecoverable.

## 0.4 Account for the 8.47 SOL released by the program closes

**Time:** ~2 minutes, and it is the only unreconciled money on this page.

Closing both Solana programs on 2026-08-13 released **8.467160160 SOL** of ProgramData rent
(4.886289 from cp-swap, 3.580871 from tegridy-launch). The registry records it as *"not recovered to
any address this registry knows"* — the close instruction names a recipient, and whichever address
you gave it is not in `addresses.json`.

This is bookkeeping, not a search: you know where you sent it. Tell me the recipient and I will
either register it with a role and custody, or record deliberately that it left to a personal wallet
that does not belong in a public registry — **do not put a personal trading wallet in
`addresses.json`.** Either answer closes it; silence leaves the largest single number in the Solana
column pointing nowhere.

While you are looking: `swap-fee-account` `DVGiHe98CzEf7VuCS6YpVDFnp38ubJmKNLt6aMJwAyER` holds
0.006477 SOL plus two ATAs (~0.004 more), and **its key is not on this machine.** I scanned
`.solana-operator`, `tegridy-ops\solana` and `.config\solana` and derived the pubkey of every
keypair file in them; none matches. Either it is somewhere else, or ~0.010 SOL is written off.
Worth one sentence so the registry stops implying it is spendable.

## 0.5 ⏳ EXECUTE THE TWAP FLOOR CHANGE — open now, expires 2026-08-30 18:03 UTC

**Time:** ~30 seconds. **Cost:** ~$0.02 of gas. **Half of this is already done.**

The proposal is staged on chain. `proposeAdminMinReserveFloor1(native pair, 1e18)` landed
2026-08-22 18:03:59 UTC in tx
[`0x29cd52c0…6771f`](https://etherscan.io/tx/0x29cd52c0ed433f32a9438ddaadad8afd764cf7979899d6b3be70980864d6771f),
block 25,812,358, and `pendingMinReserveFloor1` reads `1000000000000000000`. The 24-hour timelock
opened **2026-08-23 18:03:59 UTC**.

**If you do nothing it expires on 2026-08-30 18:03:59 UTC** and the 24-hour wait starts over. That
is the only cost of missing it — nothing breaks — but it is a day back on the critical path for no
reason.

```
& "C:\Users\jimbo\.foundry\bin\cast.exe" send 0xdFdd6D72539A425dC917F49FB834901105cA98c9 "executeAdminMinReserveFloor1(address)" 0x55875887B43C2E23aE424AF0FC8606Fdb058a481 --account deployer --rpc-url https://ethereum-rpc.publicnode.com
```

Then the check that actually proves it — this must go from `10000000000000000000` to
`1000000000000000000`:

```
& "C:\Users\jimbo\.foundry\bin\cast.exe" call 0xdFdd6D72539A425dC917F49FB834901105cA98c9 "effectiveMinReserveFloor1(address)(uint256)" 0x55875887B43C2E23aE424AF0FC8606Fdb058a481 --rpc-url https://ethereum-rpc.publicnode.com
```

Changed your mind? `cancelAdminMinReserveFloor1(address)` on the same contract, same signer.

**⚠️ This does NOT turn the oracle on, and nobody should read it as having done so.** Two gates
remain after it lands, both verified on chain 2026-08-22:

- the native pair holds **0.0794 WETH** against the new **1.0** floor, so `consult()` still reverts
  — that is §Tier 3's 1.98 ETH deepen; and
- `observationCount(native pair)` is **0**. `consult()` needs **≥2**, at least 15 minutes apart
  (`MIN_PERIOD`), written by `update(pair)`. That is gas, not capital, but it needs a keeper running
  from then on. Fund the pool and skip the keeper and the oracle still refuses to answer.

What executing buys you is that the 24-hour wait is no longer sitting between you and a working
oracle on the day the pool gets funded. It adds no exposure in the meantime: a 1.0 floor against a
0.0794 pool fails closed exactly as a 10.0 floor does.

⛔ `cast` is **not on PATH** on this box. The leading `&` is PowerShell's call operator and is
required — without it the quoted path is treated as a string and nothing happens. Sign with
`--account deployer` (the encrypted keystore, prompts for its password), never `--interactive`,
which asks you to paste a raw private key.

---

# TIER 1 — one account or one paste, unlocks the largest built-but-dark surface

## 1.1 Host the indexer (~$5–20/month) — the biggest remaining unlock

**Runbook:** [`indexer/DEPLOY.md`](../indexer/DEPLOY.md). **Time:** ~30–45 minutes.

Six finished surfaces currently render "unavailable" for exactly one reason — the indexer runs
nowhere: **the pro terminal, copy-trading, competitions, charting, the portfolio history, and tax
reports.** None of them are broken. They are honest about being unhosted.

1. Railway account → provision Postgres → deploy `indexer/`.
2. Set `PONDER_RPC_URL_1` to an **authenticated** mainnet RPC (your Alchemy key). Public nodes
   rate-limit `eth_getLogs` hard enough that the historical backfill never finishes.
3. ⛔ **Put it behind a proxy with a rate limit. Never expose the raw port.** Ponder ships no auth
   and no rate limiting of its own. This is not optional hardening.
4. In Vercel set `VITE_INDEXER_URL` to the **public proxy origin, no path**, and redeploy.

**Tell me when the URL is live** and I will wire the first consumer pages.

## 1.2 Set `MEMETICS_BIRTH_SECRET`

A **server-side** Vercel variable — never `VITE_`, which would ship it to every browser. Then
redeploy.

It must be the **exact secret seacasa issued**: it is a shared HMAC key, and a self-generated value
fails on their side where you cannot see it. After setting it, launch or replay a birth and read
the answer — it is unambiguous:

| Response | Meaning |
|---|---|
| `200` + `status: enrolled` | The key matches. Done. |
| `422` + `retryable: false` | Wrong or rotated secret — the island rejected the signature. |
| `503 no_secret` | The variable never reached the deployment. Redeploy. |
| `502` | Their socket is down. Says nothing about your key. Retry later. |

## 1.3 ~~Mint DBC config v2~~ → **RETIRED. Zero Meteora.**

**Operator decision 2026-08-23: "no, I want 0 Meteora — we only want launchers that
graduate to US; any other ones should be retired."**

Everything this section used to say is void. Do **not** mint a DBC config v2, do not pick
curve numbers for it, and do not publish `VITE_SOLANA_DBC_CONFIG`. The six measured
constraints that lived here applied to a rail being removed; they are preserved in git
history if the decision is ever revisited.

The Solana rail going forward is **our own** — `tegridy-launch` graduating into our
cp-swap fork — and it is being **redeployed at fresh program ids**. That has its own
document:

▶ **[`SOLANA_RESTART_PLAN_2026_08_23.md`](SOLANA_RESTART_PLAN_2026_08_23.md)** — the
ordered ceremony, the curve recommendation with its arithmetic, and the Meteora delete list.

### ✅ The curve numbers are settled — a flat 100 bps, 50/50 split

You asked me to study the competition and recommend. The answer is **no decay at all**:

| Arrival | The rejected decay design | **Recommended flat** |
|---|---|---|
| 10 s | 19.03% | **1.00%** |
| 60 s | **14.82%** | **1.00%** |
| 5 min | 4.47% | **1.00%** |
| 1 hr | 1.00% | **1.00%** |

`trade_fee_bps = 100`, `creator_fee_share_bps = 5000`. **Creator nets 50 bps, protocol
nets 50 bps.** No code changes — both fields already exist and are snapshotted per launch.

**Two source facts killed the decay design before any market argument.** `curve.rs:37` sets
`MAX_FEE_BPS = 1_000`, so a 2000 bps opening fee would require **raising a deliberate safety
ceiling in a program holding other people's SOL**. And there is **no time input on the fee
path at all** — zero matches for `Clock::get` / `unix_timestamp` across the program — so any
decay is net-new hot-path money code *plus* an account-layout change, on the exact rail
where a layout change just caused a full client/program desync.

The market agrees: **pump.fun charges a flat 1.25%** with no decay (tiering applies only
after graduation), **LetsBonk a flat 1%**, **flaunch** uses a per-wallet cap instead, and
**Meteora's own newer tool prices by trade size, not time**. **Clanker v4 is the only major
venue still shipping decay, capped at 120 seconds — the rejected proposal used 600.**

At 100 bps our buyer pays **less than pump.fun's 1.25%**, while our creator takes 50 bps
against their 30. ⚠️ Do **not** hand-pick the graduation target: it is pinned by the virtual
reserves through the ±5% continuity band, and `continuity_target()` at `curve.rs:414`
already solves for it.

---

# TIER 2 — switches, all deliberately off

## 2.1 Apply six migrations, in this order

`016_alert_rules` · `017_api_keys` · `018_airdrop_manifests` · `019_referral_codes` ·
`020_telegram_links` · `021_commerce`

All written, none applied. Two things to know:
- Each surface answers **`503 schema-missing` with the migration path attached** until you run its
  file — never a confident empty result. A surface that looks broken is telling you which migration
  is missing.
- `019`, `020` and `021` end with `NOTIFY pgrst, 'reload schema'`. Do not stop before that line.

## 2.2 Deploy the contracts (all written, all deployed nowhere)

Thirteen constants in `frontend/src/lib/constants.ts` are the zero address, and every surface gates
on `isDeployed()`. **Filling in an address is the entire activation step** — no code change.

`AIRDROP_FACTORY` · `VESTING_FACTORY` · `TEGRIDY_LOCK_VAULT` · `LAUNCH_LOCK_VIEW` ·
`POSITION_MARKET` · `LaunchRugEscrow` · `DecayingFeeHook` · the ERC-4626 harvest vault ·
`TEGRIDY_LENDING` (⛔ oracle-gated — see below) · `TEGRIDY_RESTAKING` (⛔ needs external re-audit) ·
`TEGRIDY_PRO_PASS` · and the governance set (`GAUGE_CONTROLLER`, `VOTE_INCENTIVES`,
`COMMUNITY_GRANTS`, `MEME_BOUNTY_BOARD` — these are **already deployed on mainnet**, zeroed here on
purpose because they spend).

**Orderings that cost you something if reversed:**
- ⛔ **`setFeeSink(...)` BEFORE `setFee(...)`** on the escrow and factories. A fee with a zero sink
  is snapshotted as zero, so the reverse order silently ships free escrows until the next one opens.
- ⛔ **The rug escrow ships with openings disabled.** `setOpeningsEnabled(true)` is a separate
  deliberate act.
- ⛔ **The decaying-fee hook's owner is set in the constructor**, because the deploy script mines a
  CREATE2 address over the constructor args. Decide the owner *before* deploying — rotating
  afterwards changes the address and invalidates the mine.
- ⛔ **The decaying-fee hook's pool must be opened by the owner Safe ITSELF**, and steps 1-3 must
  go as ONE MultiSend batch: `configurePool` → `poolManager.initialize` → mint the launch
  position. `DecayingFeeHook._afterInitialize` (`contracts/src/v4/DecayingFeeHook.sol`) compares
  v4's `sender` against `owner()`, and v4 sets `sender` to whoever **called** `initialize`
  (`Hooks.sol:190` encodes `msg.sender`). So `PositionManager.multicall([initializePool, mint])`
  arrives as the *router* and is rejected — and v4-periphery's `PoolInitializer_v4` wraps that
  call in `try/catch`, returning `type(int24).max` on any revert, so **the failure is silent**:
  nothing surfaces, the pool simply is not open, and the `mint` leg then fails against a pool that
  does not exist. Batching also closes a real front-run: `configurePool` publishes the exact
  `PoolKey` in its calldata, so a separate later `initialize` lets whoever gets there first choose
  the opening price and start the decay clock. There is no operator lever to relax the check and
  there is not meant to be — that check is what stops the front-run entirely. It fails CLOSED (no
  pool, no clock, no funds moved), which is the opposite of the pre-fix behaviour. *(Graduation is
  unaffected: `TegridyLiquidityMigrator` carries `TegridyV4Hook`, whose `allowedInitializers`
  grant already covers the migrator.)*
- ⛔ **`TegridyLending` must not deploy before the TWAP is warm.** Origination calls
  `_assertSpotWithinTWAP` against an oracle with zero observations; it would revert on every
  valuation. That needs the pool deepen first.

## 2.3 Two tiny changes with outsized effect

**(a) Add `getcontractcreation` to the Etherscan proxy's `ALLOWED_ACTIONS`**
(`frontend/api/etherscan.js`). Right now a token's deployer cannot be resolved, so **most terminal
rows show UNRATED** — that is the honest state, and this one line is what turns the terminal from
sparse into the product. The deployer-reputation score is the whole differentiator.

**(b) Add an output amount to the indexer's `swap` table** (`indexer/ponder.schema.ts`). The row
records `amountIn` but no output and no price, so **no realised return is computable anywhere** —
not for copy-trading leaders, not for competitions, not for tax cost-basis. It is not caution; the
number does not exist. One column makes all three real.

## 2.4 Fee dials — a flag and a price are two decisions

Nothing charges anything today. Each needs both halves:
- **Swap/trigger/terminal:** `VITE_SWAP_FEE_BPS` + `VITE_SWAP_FEE_RECIPIENT`
- **Heat-tier launch pricing:** `VITE_LAUNCH_TIER_PRICING=on` + a **full five-tier** bps table (all
  five tier words, or it refuses to apply — a partial table would silently price someone at a
  default they never chose)
- **Creator revenue share:** `VITE_CREATOR_FEE_SHARE=on` + `VITE_CREATOR_FEE_SHARE_BPS`

The venue's take is **structurally capped** at today's rate: no configuration can raise it, because
the resolver rejects any tier priced above the standard line.

## 2.5 Services built and hosted nowhere

Besides the indexer: the **Solana indexing leg** (same host, runs beside Ponder) and the
**Telegram bot** (`bot/DEPLOY.md` — zero npm dependencies on purpose, non-custodial by
construction: its credential can bind a chat and can *never* attach a wallet).

---

# TIER 3 — external, long lead times, start early

| # | Action | Note |
|---|---|---|
| 3.1 | **Send the Whetstone petition** | Written, fact-checked, ready. It asks them to whitelist the graduation migrator on deploy. Without it, venue graduation reverts at pool initialization. The BUSL grant question travels with it. |
| 3.2 | **Send the Solana audit RFQ** | Written, never sent. Audit *calendars* are the schedule constraint, not engineering — send before you think you need it. |
| 3.3 | **Send the seacasa wave-three packet** | Written, never handed over. Add the fifth question: **when does the island publish its attestation signing key, and at what route?** Without it the Heat gate stays advisory — anyone reading the Airlock ABI can launch around it. |
| 3.4 | Book the EVM firm audit | Sequenced after any admin-model change so the report is not invalidated. |
| 3.5 | SEAL 911 / Safe Harbor · Immunefi (fix the 404'd link in `AUDITS.md:178` first) · DefiLlama (after the pool deepen) · legal entity + tax scoping | None started; none pending on anyone else. |

---

# Decisions I need one sentence on

1. ~~⭐ **Does the Solana own venue restart at all?**~~ **ANSWERED — restart. Superseded
   2026-08-23 by [`SOLANA_RESTART_PLAN_2026_08_23.md`](SOLANA_RESTART_PLAN_2026_08_23.md)** and
   carried as row 3 of the operator critical path above.

   *Left in place because the reasoning below is still the accurate account of why the ids are
   spent and what a restart costs — but the three options it closes with are stale. Meteora is
   retired (§1.3, "Zero Meteora"), so "stay on Meteora DBC" is no longer on the table, and the
   answer is not open.*

   Both programs were closed on 2026-08-13 and **their program ids are spent** — Solana will not
   redeploy a closed id, so `CpFnacr…zED` and `3ZvZXEBr…PM9y` are gone permanently, along with every
   PDA derived from them. The `global` config PDA still sits on chain holding 0.005923 SOL, orphaned
   and unreachable: its owning program no longer exists.

   Graduation never worked while they were live — `AmmNotConfigured` (6015) was never cleared,
   because `admin::ID` had been set to the Squads *multisig account*, which can neither sign nor
   pay. That was diagnosed and fixed in source (trunk now points it at a system-owned, fundable
   address) but the fix was never deployed, and now cannot be: [#282](https://github.com/fomotsar-commits/tegridy-farms/pull/282)
   is closed for exactly that reason.

   **A restart costs roughly what the first one did:** two fresh program keypairs, new `declare_id!`
   values, **8.46 SOL settled / 13.4 SOL peak float** of rent, and a re-derivation of every PDA the
   fork owns. At SOL $96.94 that is ~$820 settled, ~$1,299 peak — but quote the SOL, not the
   dollars: rent is denominated in lamports and does not move with the price, so only the dollar
   figure ages. Full derivation, re-priced 2026-08-22, in
   [`CAPITAL_REQUIREMENTS_2026_08_15.md`](CAPITAL_REQUIREMENTS_2026_08_15.md).

   Note the shape of it: **8.46 SOL is within 0.01 of the 8.467 SOL that closing the two programs
   released.** It is the same rent coming back out. So this is only a funding ask if that SOL has
   been spent — which is exactly what §0.4 is asking you to confirm.

   The deploy authority is currently empty, so it needs funding either way. Before spending any of
   it, run
   `node scripts/verify-program-constants.mjs --so <artifact> --program cp-swap` against the built
   binary — that check exists because getting `admin::ID` wrong once already cost the whole
   deployment.

   ~~Three honest options: restart · stay on Meteora DBC · park Solana.~~ **Closed 2026-08-23:
   restart, and Meteora is retired outright** — see the restart plan and §1.3. The option list above
   is kept struck through rather than deleted so a reader who remembers being asked can see it was
   answered, not dropped.

2. **The PWA app name.** The manifest description is corrected but the *name* is untouched — the
   app is "Tegridy Farms" at memetic.fun with a Tradermigos marketplace inside it, and installing
   from the marketplace produces an app named after the venue. Renaming an installed app out from
   under someone is not a call to make by inference.
2. **The flagged wing** — perps, the synthetic dollar, the gambling items. Built nothing; each
   conflicts with a written house law and would need that law amended in a commit first.

*Already answered, recorded, and acted on:* graduation venue → **V4 hooked pool** · airdrop
manifests → **hosted** (they went to Supabase, not the indexer: a Ponder table is rebuilt from
chain on every re-index, which would have destroyed every manifest).

---

# ⏰ Clocks that run whether or not you act

| When | What | If missed |
|---|---|---|
| **2026-08-30 18:03 UTC** | ⏳ **TWAP floor proposal expires** — §0.5, staged and waiting, ~30 seconds to execute | The staged 10 → 1.0 WETH change is discarded and the 24-hour timelock restarts. Nothing breaks; you just lose a day off the oracle's critical path for free |
| **~2026-10-11** | Staking reserve runway ends | **Not an honesty problem — corrected 2026-08-23, see below.** Refill when convenient. |
| **~Aug 2027** | `memetics.finance` renewal (1-year, registered 2026-08-02) | A second production domain lapses while monitoring stays green |
| Standing | `TegridyStaking` has **22 bytes** of EIP-170 headroom; `VoteIncentives` has **99** | The next one-line edit to either makes its redeploy artifact undeployable. The extraction is unbuilt. Do not casually edit those two files. |

---

# What is running or waiting on me

Ordered. Counts re-verified 2026-08-22 against the tree, not carried forward from the sweep — the
long tail lives in [`EVERYTHING_LEFT_2026_08_15.md`](EVERYTHING_LEFT_2026_08_15.md) §"87 items",
which is still broadly right but predates three merges.

**1. 🟡 Get trunk green — two of five checks left.**

**Updated 2026-08-23.** Three of the five red checks are fixed, and one of those turned out never
to have run at all. What is left on trunk:

| Check | State | Where it stands |
|---|---|---|
| `advisories — frontend` / `— indexer` | ✅ **FIXED** (`5565506b`) | Was never an advisory problem. GitHub runs every `run:` block under `bash -e`, and `set -uo pipefail` does not clear errexit, so the unguarded `npm audit --json` ended the step the instant it found anything and **the gate never ran once** since it was armed on 08-18. Running the gate against the real reports: 0 blocking in both projects, every finding already baselined, zero stale suppressions. Nothing was allowlisted to force green. |
| `Static analysis` (Slither) | 🔴 **STILL RED — and it was masking** | See item 8. |
| `E2E Tests` | ✅ **GREEN** (`d2d43bdb`) | **524 passed, 32 skipped, 0 failed** on run 32609788572 — the first green on this job. All four projects, including both WebKit ones. See item **1b**: the service worker was answering every stubbed fetch before `page.route` could, and fixed chrome was parking the click target underneath itself. |
| `E2E Tests (Anvil fork)` | 🟡 **18 passed / 1 failed** (was 4 legs failing) | Fixed and merged (`c6e64cd3`, `deb43a29`). `stake`, `swap` and `claim-rewards` pass clean. The one failure is a REAL broken repay transaction that the old false-green assertion hid — see **①.2**. |
| `Lint, Type Check & Test` | ✅ green (and `Build`) | Went red for ~15 minutes today on my own `no-fallthrough` mistake (`a0c83c42`); see the note at the end of item 8. |

The failures are not the problem. A permanently-red trunk is: once red is the normal state, the
next real regression is indistinguishable from the noise. This repo has already shipped **three**
gates that could not fail — a `tsc --noEmit` over zero files, a chain read behind a flag nothing
passed, and a CI check satisfied by a two-second echo — so that is a demonstrated failure mode here,
not a worry.

## 1a. The Anvil money-path job — DIAGNOSED 2026-08-22. The old diagnosis was wrong.

**Everything this entry used to say has been disproven by measurement. Do not act on it.**
It said *"order-dependent, not unseeded — seeding landed and did not fix it; bisect the pair that
collides, do not add more seeding."* The truth is close to the opposite: **more seeding is exactly
what is needed**, and there is no collision.

**Anvil is healthy. This is NOT an operator item and the RPC needs nothing.** Positive proof, not
absence of errors:
- `[e2e] fork ready at block 25813292` prints only after the harness POSTs `eth_blockNumber` and
  rejects any head below 1,000,000 (`run-e2e-with-anvil.mjs:162-181`) — the guard exists precisely
  because "anvil listens before the fork handshake completes".
- **`swap.spec.ts:72 execute ETH → TOWELI swap and confirm receipt (Anvil only)` PASSES in 1.6s.**
  That is a full write path — `anvil_setBalance`, impersonate, `eth_sendTransaction`, receipt, and a
  matched `/tx/0x[0-9a-f]{64}` link. A dead or rate-limited fork cannot produce it.
- `ANVIL_FORK_URL` is `https://ethereum-rpc.publicnode.com`, hardcoded at `ci.yml:400`. **No secret
  is involved**, and `ANVIL_FORK_BLOCK` is unset, so there is no stale block pin. Both of the usual
  suspects are ruled out by construction.

**The ~21-second clustering is not a shared hang.** It is a literal `{ timeout: 20_000 }`
copy-pasted into the first blocking assertion of each spec (`claim-rewards:64`, `lending:75`,
`liquidity:79`, `stake:88`). 20s assertion + ~1-2s page load = the observed 20.3 / 21.5 / 22.4s.

**The `reducedMotion` hypothesis is also disproven** — it is correctly under `contextOptions` now,
and independently the fixture pre-seeds `sessionStorage.tf_loaded` to skip the splash
(`wallet.ts:167-171`). **16 of 20 tests finish in 0.9–2.7s.** A 15-19s prologue cannot fit inside a
962 ms test.

## ⚠️ CORRECTED AGAIN 2026-08-22 (late). "Seed the preconditions" was wrong for three of four.

The recipe that stood here — *"the fixture seeds two things and these four tests need more; each
spec's own error message says what to seed"* — was derived from the specs' assertion messages and is
**wrong for three of the four**. An agent then reproduced all four against a live Anvil mainnet fork,
leg by leg. They are **four different bugs**, and missing fork state is the answer to exactly one.

**Three of the four were FALSE GREENS or dead locators on trunk today:**

1. **`liquidity` never added liquidity, and the fork was never short of anything.** Its CTA regex is
   `/(supply|add liquidity|deposit|approve)/i`; this app labels the add submit **"Grow the Crop"**.
   Cold, the only match is *"Approve TOWELI"* — so the spec clicked the **approval**, and
   `expectTxReceipt` was satisfied by the approval's receipt. The remove side then correctly rendered
   nothing, because the account held no LP. **One cause explains all three CI durations**: cold it
   fails at ~6.5 s (CI's unexplained attempt 0), warm the CTA reads "Grow the Crop", the regex
   matches nothing, and the 20 s guard fires — CI's 22.4 s and 21.9 s retries.
2. **`stake` clicks once in a two-step cascade.** `StakingCard` renders ONE self-relabelling button;
   cold, that click is the **approve**, which shows no receipt by design. Its retry-#1 pass was
   attempt 0's allowance surviving on the fork — not a warm cache, as previously recorded here.
3. **`claim-rewards` waits on `/^claim\s+\d/i`, which matches no CTA `/farm` can draw in any state.**
   The only "Claim &lt;n&gt; TOWELI" is the restaking panel's, gated at `FarmPage.tsx:452` on
   `TEGRIDY_RESTAKING_ADDRESS = 0x0`; LP farming says "Claim Rewards" — no digit.
   **Pre-funding reward storage, which both earlier diagnoses recommended and which this document
   told you to do, would not have turned it green.**
4. **`lending` is the one with genuinely missing state** — `offerCount()` is 0 on mainnet, read with
   `cast`. Plus two blockers nobody saw: the spec never expands the offer card (it is a `div`, not a
   button), and it demands a `/tx/0x` receipt from `NFTLendingSection`, which renders **no explorer
   link anywhere** (`grep getTxUrl` → zero hits).

**A completed implementation exists and is NOT merged, deliberately.** Worktree
`.claude/worktrees/wf_2d4792a8-b87-6`. It adds `advancePastApproval` (walks a self-relabelling
approve→act CTA to its ACT state and **refuses to accept the approval as the action**),
`expectTxReceipt` returning its hash plus a `notHash` argument (these surfaces overwrite one receipt
line, so leg two was being satisfied by leg one's link), `seedNftLendingOffer`,
`useIsolatedForkAccount()`, and `advanceForkTime`.

🔴 **It was adversarially verified and came back REFUTED on one leg — do not merge it as-is.**
`lending.spec.ts:134` asserts `repay.toHaveCount(0)` on a button located by accessible name
`/^Repay Loan$/`. `NFTLendingSection.tsx:1138` renders
`{repaying ? 'Confirm in Wallet...' : repayConfirming ? 'Repaying...' : 'Repay Loan'}` — so the name
changes the instant the click sets `repaying`, and the count reaches 0 **whether or not the
repayment ever confirmed**. That is a fresh false green in the fix for a false green.
▶ **Watch contract state, not the button's label.** Then the track is genuinely done; the verifier
found everything else in it sound.

⚠️ Also flagged there: `liquidity.spec.ts:75`'s `panel.locator('button:not([aria-pressed])').last()`
resolves correctly **today but positionally** — appending any button to `LiquidityTab` silently
retargets the spec's submit. Give the cascade button a `data-testid`.

⛔ **DO NOT** fix any of these by loosening an assertion, widening a per-assertion timeout, or adding
a retry. Two of the four were *already* passing on something that was not the thing under test.

### ✅ Result after the merge — and what the two remaining failures actually mean

CI run 32663349825: **18 passed, 1 failed**, down from four failing legs.

| Leg | Now |
|---|---|
| `stake` | ✅ passes clean, 7.5 s, no retry |
| `swap` | ✅ passes clean |
| `claim-rewards` | ✅ passes |
| `liquidity` | 🟡 fails attempt 0 (33.5 s), **passes retry #1** (4.4 s) |
| `lending` | 🔴 fails all attempts |

**Neither remaining failure is a regression — both are the truth becoming visible.**

- **`lending`** fails on the assertion that replaced the false green:
  *"the repay was submitted but the loan never read back as repaid — the repayment did not confirm
  on chain."* The old `toHaveCount(0)` on `/^Repay Loan$/` would have **passed here**, because the
  button's accessible name changes to *"Confirm in Wallet…"* the instant it is clicked. So this leg
  was always broken and the test was reporting otherwise. ▶ Debug the repay transaction itself; the
  spec is now correct.
- **`liquidity`** fails attempt 0 on the `notHash` guard —
  *"the only receipt on the page is still the PREVIOUS step's (0x75475ba0…)"* — which is that guard
  working: without it the add's own receipt link would have satisfied the burn. It passes on a warm
  retry, so this is a **state/ordering issue between the two legs**, not a false green. ▶ Likely the
  allowance or the receipt line not clearing between legs; do **not** "fix" it by dropping `notHash`.

## 1b. The heat-door failures — ✅ DIAGNOSED AND FIXED (`d2d43bdb`)

**And they were never chromium.** Desktop chromium passes heat-gate **5/5 in isolation and 142/142
in a full serial run**. The failures were on the other three projects, from **two independent
causes, neither of them a race and neither order-dependent** — the third hypothesis from item 1 to
fall to measurement today.

**1. The network stubs were never applying.** `webServer` runs `vite preview`, which serves a
**production** build, and `registerAppServiceWorker` enables itself on `import.meta.env.PROD`
(`src/lib/pwa/serviceWorker.ts:125`). So `public/sw.js` takes control of the page mid-test, and once
it does **`page.route()` stops intercepting** — the worker answers the fetch before Playwright sees
it. `heat-gate.spec.ts`'s `/api/aggregator?resource=heat` stub was a no-op, and LaunchGate fell to
its **fail-closed STALE** state.

⚠️ **Correction, because the wrong version of this sent two investigations after a 404 that does not
exist:** an unrouted `/api` call does **not** 404. `vite preview` answers unknown paths with the SPA
fallback, so it returns **`200 text/html`** — `res.ok` passes, then `res.json()` throws on the HTML
and `heatClient.ts` raises `HeatUnavailableError('The instrument returned something unreadable.')`.
Same destination, different road.

> That means `element(s) not found` for `WARM` and `41.20°` was **the honesty gate working
> correctly** — the app refusing to render numbers it did not have, against a fixture that was never
> delivered. The suspicion recorded here yesterday ("the door self-gates when the payload fails its
> schema") was the right instinct pointed at the wrong layer: the payload never arrived at all.

Fixed with `serviceWorkers: 'block'` in `playwright.config.ts`. Not a loosening — it is what makes
the stub real, and the worker keeps its own unit coverage in `src/lib/pwa/serviceWorker.test.ts`.

**2. A layout race, measured.** `openLaunch` waits for the verdict word, but the COLD branch then
mounts `<HeatCard variant="embedded">`, which reads the island itself and **grows when it answers** —
so the audit toggle beneath it is still moving when the test clicks. Sampled at 250 ms on a 412×763
Pixel 5, the toggle travels **316 px** after the verdict renders. Both audit tests now wait on the
card's own content (`/Where the 62\.40° comes from/`) before touching the control. One of them was
only surviving by accident, because its `toHaveAttribute` happens to poll.
⚠️ The jank is real and still ships — a genuine CLS on the COLD door, worth its own item.

**3. The `locator.click` timeout is an app defect, and a WCAG 2.4.11 violation.** Two bars overlay
the scrollport and neither is in flow: `TopNav` is `fixed top-0 z-50` (56 px, every width) and
`BottomNav` is `fixed bottom-0 z-50 sm:hidden` (65 px). Nothing reserved room for them, so every
scroll-into-view the browser performs parks the element **underneath** one of them. Measured at
412 × 763: the audit toggle lands at y=36 under the header on top alignment and y=709 under the nav
on bottom alignment — reachable only by the one alignment nothing picks. Fixed with `scroll-padding`
on the scrollport, which costs no layout. `ConsentBanner` was a third fixed overlay the fixture's
skip list missed; it is seeded `denied`, never `granted`.

✅ **CONFIRMED on run 32609788572: 524 passed, 32 skipped, 0 failed** — the first green this job has
had, across all four projects including both WebKit ones.

▶ **One follow-up worth taking:** `WEBKIT_EXCLUDED_TEST_TITLES` in `playwright.config.ts` excludes
six titles from the WebKit projects for cross-origin `pageerror` noise. **Some of that noise was
very likely the service worker**, which is now blocked — the 32 skips are those exclusions. Re-derive
the list by removing entries one at a time and re-running; every title that now passes is coverage
the matrix gets back for free. `src/test/playwrightDeviceMatrix.test.ts` keeps the list honest, so it
will tell you if you get it wrong.

**2. ✅ The five non-Dependabot PRs are decided AND resolved — nothing is left open.** Every verdict re-derived against trunk rather
than taken from the PR's own claims.

- **`#306`** selector-guard ABI registration — **merged** (`dce626c3`). It un-skipped the contracts
  matrix. Contracts CI had failed on every trunk run since 08-19 and the forge slices `needs:` that
  job, so they reported *skipped*, not *failure* — **every merge in that window landed with zero
  contract test coverage and nothing went red.**
- **`#205`** foundry 1.3.1 → 1.9.1 — **merged** (`6dedcb53`). Its dependabot mute named one release
  condition ("a run where all nine slices are green"); that run exists, on a head rebased onto trunk
  exactly. The mute is now lifted too (`22823be3`) — an ignore whose stated condition has been met
  stops being a decision and becomes a mute nobody owns.
- **`#278`** Heat launch gate — **CLOSED**, superseded on every file. Trunk's gate is *newer*
  (`657c5170`, #286, 08-11 — three days after #278 opened) and this PR's actual purpose is already
  delivered: `assertMayLaunch` is wired into both rails. The one thing not carried over, the
  180-day floor, was removed on purpose per the island spec and is documented twice. If you want
  that floor it is a config change (`VITE_HEAT_LAUNCH_FLOOR`), not a re-merge.
- **`#304`** restaking ABI alignment — ✅ **MERGED** (`0d4ec7e4`).
  Real live drift: `TegridyRestaking.sol` declares a **6-field** `RestakeInfo`, trunk's frontend ABI
  declares 5. The four `docs(todo)` commits were dropped (redundant with trunk, and the only files
  that conflicted).
- **`#265`** Solana metadata-URI check — ✅ **MERGED** (`461d8b1e`), with one hunk dropped and one
  finding fixed first. Scope note that changed the verdict: this targets the **live Meteora DBC rail**, not the
  dead own-curve rail, so it is revenue-path work and not dead-rail polish. Tokens are created
  `AUTHORITY_IMMUTABLE`, so the URI is permanent and unfixable after launch.
  - *Dropped:* its `liveConfig.ts` hunk deleted `feeClaimer: 72`. Trunk has since answered that
    question the other way and correctly (`feeClaimer: 40` / `leftoverReceiver: 72`, pinned
    separately), and `feeCustody.ts` reads `feeClaimer` for the custody gate. Taking the hunk would
    have broken it.
  - *Fixed before merge:* a single IPFS gateway 404 would have **blocked legitimate launches** —
    freshly pinned CIDs 404 for minutes while they propagate. It now tries a second gateway and, if
    both miss, warns in amber instead of blocking. `https://` and `ar://` 404s still block, because
    those hosts are authoritative for their own paths.

**3. Sweep the 15 Dependabot PRs.** Hold `#296` (framer-motion 12 → **13**, a major). The rest are
minor/patch and grouped.

**Status 2026-08-22 (late):** all 14 non-major PRs have been sent `@dependabot rebase` onto the
fixed trunk; they will re-run CI on their own. Do not read their previous red as a verdict on the
bumps. `#303` (eslint /
vite tooling) and `#287` (viem / wagmi) were failing `Lint, Type Check & Test` for **my** lint
regression, not for anything in the bump — that is fixed in `a0c83c42` and they need a re-run. The
CodeQL-action bumps (`#268`–`#271`) and `#302` were red on the pre-existing trunk failures, which
are now two-thirds resolved. The eight package bumps (`#289`–`#295`) report `UNKNOWN` mergeable,
which means GitHub has not computed a merge base recently, not that they conflict.

▶ **The order that costs least:** re-run CI on all of them (pushing trunk already retriggers most),
then merge the ones that come back green **one at a time** — each merge moves trunk and Dependabot
rebases the rest, so batching them just means N rounds of CI either way. Leave `#296` alone.

**4–5. ✅ DONE 2026-08-22 (`01b26b86`).** All 53 cleared, `tsconfig.test.json` wired, and the guard
extended to assert coverage rather than spelling. Verified by mutation in both directions: a
deliberate type error in a `.test.ts` now fails `tsc -b`, and unwiring the reference turns the new
guard red. `tsc -b --noEmit` → 0 across all three projects; 6,025 tests green.

Both production bugs were real, and one of them **bears directly on item 1**:

- **`playwright.config.ts` — `reducedMotion` was never applied.** It is a `BrowserContextOptions`
  key, not a top-level `use` key, so it was never forwarded to `newContext()`. The app therefore
  never saw `prefers-reduced-motion: reduce`, and **every e2e test has been sitting through the
  ~15–19 s fullscreen canvas intro** that `AppLoader.shouldSkipAtMount` exists to skip. Now inside
  `contextOptions`, where it applies. ⚠️ **Check this against the E2E failures before bisecting
  anything** — a 15–19 s prologue on every spec is a plausible cause of timeout-shaped flake, and
  it would look exactly like order-dependence when workers contend.
- **`irysClient.ts` ambient-`Window` split** — `tsconfig.test.json` *overrides* `include` rather
  than extending it, so the global declaration file never entered the test program. Fixed at the
  root with a `src/**/*.d.ts` glob rather than the one filename.

And several tests were **passing for the wrong reason**, which is worth knowing before trusting a
green suite: `chains/registry` compared two `as const` literals, so the expression folded at compile
time and the assertion was literally `expect(false).toBe(false)`; the airlock SDK mock was missing a
method the code under test calls, green only because the migrator address is still zero and it would
have died the day that changed; `CurveLaunchPage` fixtures omitted the exact field whose absence
caused the documented silent Borsh offset shift.

*Residual, recorded not hidden:* `tsconfig.test.json` relaxes five flags relative to `src/` —
`noUncheckedIndexedAccess`, `strictFunctionTypes`, `verbatimModuleSyntax` and the two unused checks.
Test files are checked now, but not as strictly. Tightening them is its own piece of work.

**6. ✅ Honesty debt — closed (`514942c5`, `b0484908`).** It was **eight** files, not five. Two were
not on any list and were found by scanning rather than by counting: `geometry.ts` had *not* been
fixed, and `rpc.ts` carried a claim nobody had counted. All eight now say what is true — deployed
08-08, closed 08-13, permanently spent, and graduation never ran once because cp-swap's `AmmConfig`
was never created.

**The part that was a live defect, not a comment.** `readDeployment` reported `deployed` for both
spent ids, and every surface gating on it believed the rail was up for the nine days since the
close. `solana program close` deletes the ProgramData account and leaves the 36-byte program stub
**still executable-flagged**, so `getAccountInfo` — and `readDeployment`, built on it — answers "a
program is here" for an id that can never execute again. This is the one place where "trust the
chain read, not the comment" fails: **the chain read agreed with the wrong comment.**

`readDeployment` now follows the stub's pointer and reads the ProgramData account before saying
`deployed`; any failure in that second read is `unreadable`, never `deployed`. `closed` is its own
variant in `Deployment` and `LaunchPhase` rather than folded into `not-deployed` — a spent id is
not an id you can still deploy to, and adding the variant made the exhaustiveness checks fail at
all four render sites, which is how they were found. The operator script refuses both spent ids from
a literal list, not a chain read, for the same reason.

While in the page: the deployment banner had been telling every visitor *"That id is a placeholder
generated so the program compiles… expected to return nothing today"* for two weeks after the
deploy made it false.

**8. 🔴 NEW — Slither: 362 findings at `fail-on: medium`, and the check was being masked.**

Two separate problems, one now fixed.

**Fixed (`cdd58b06`) — four required checks could be satisfied by a two-second echo.** Measured on
`#205` (head `a4706efb`): two check runs named `Slither / Static analysis` existed at once — the
real 4-minute analysis **FAILED**, a 2-second shim **passed**, and the PR's check list surfaced only
the pass, with the real result absent entirely. `all-tests-pass` was doubled on the same PR and
agreed by luck. A required-status rule on either name would have been satisfied by an echo. **This
is the third instance of this repo's documented failure mode.**

The cause was GitHub's own "skipped but required" recipe: `paths` fires when *any* changed file
matches, `paths-ignore` when *any* does not — they are not complements, so a PR touching both sides
triggered the real workflow **and** its `-not-applicable.yml` companion. The companions carried a
comment arguing the overlap was safe on finish order, and `requiredCheckSynthesis.test.ts` enforced
that pairing and repeated the argument. Nobody had measured it.

The four companions are deleted. Each workflow now triggers on every PR — so exactly one check run
per name can exist — and a `scope` job decides whether the expensive jobs run
(`.github/scripts/diff-scope.mjs`). Every uncertain answer **runs** the real job, including a scope
job that failed outright. `requiredCheckSynthesis.test.ts` is rewritten to enforce the shape that
cannot regress, and its header records what was measured and why the old reasoning was wrong.

*Proven in production on `#265`,* a frontend-only PR: exactly one check run per name, all four
`scope` jobs green, `Static analysis` and `registry vs chain` **SKIPPED**, and `all-tests-pass` /
`all-checks-pass` **SUCCESS** via their out-of-scope step. Under the old arrangement that PR would
have carried two `Static analysis` runs and two `all-tests-pass` runs.

**Still open — but much smaller than 362, and now measured.**

**Only 48 of the 362 findings gate anything.** `fail-on: medium` ignores Low and Informational, and
the split is **5 High / 43 Medium / 200 Low / 114 Informational**. The 48 sit in 16 files:

- **5 High**, all reentrancy, in exactly **two** files — `TegridyFeeExecutorRouter.sol` (3) and
  `vaults/TegridyHarvestVault.sol` (2).
- **43 Medium**, dominated by two FP-prone detectors: `incorrect-equality` (21) and
  `uninitialized-local` (13), plus `unused-return` (6), `divide-before-multiply` (2),
  `reentrancy-no-eth` (1).

✅ **The config question is SETTLED — do not spend time on it.** The TODO previously said to check
whether `contracts/slither.config.json` loads. **It loads and it works.** Proof from the report
itself: **zero** of its 12 excluded detectors (`timestamp`, `dead-code`, `naming-convention`, …)
produced a single finding, and detectors that are *not* on its promoted list (`costly-loop`,
`cyclomatic-complexity`, `missing-inheritance`, `return-bomb`, `unused-state`) *did* fire. That
second half also disproves the feared failure mode recorded in the config's own comment — the
promoted `detectors_to_include` list has **not** gutted the detector set. 20 detectors produced the
362 findings.

⚠️ **A stale claim to fix while you are in there:** `contracts/slither.config.json`'s `_scope` note
lists 15 in-scope contracts and says 12 others "have been moved off this branch". **Every file
producing findings today appears on neither list** (TegridyFeeExecutorRouter, TegridyHarvestVault,
StreamingRevenueDistributor, NftfiBnpl, TegridyFeeLocker, TegridyPositionMarket, LaunchRugEscrow,
AirdropFactory, VestingFactory…). `_scope` is a **comment and enforces nothing** — `filter_paths`
only drops `lib/ node_modules/ test/ script/ out/ cache/ broadcast/`. The note is badly stale and
its FP rationale ("verified across RevenueDistributor / ReferralSplitter / POLAccumulator /
TegridyStaking / TegridyRestaking / TegridyTWAP, 2026-05-31") covers almost none of the files that
actually fire. Rewrite or delete it; do not inherit its conclusions.

🔴 **BOTH PASSES ARE DONE, AND THE ANSWER IS: DO NOT SUPPRESS.** Full write-up with every verdict
and both passes verbatim: [`SLITHER_TRIAGE_2026_08_22.md`](SLITHER_TRIAGE_2026_08_22.md).

Five agents triaged all 48 against the Solidity and returned a clean sweep — **54 FALSE_POSITIVE,
2 REAL_BUT_ACCEPTED, 0 REAL_BUG** — with confident, heavily line-cited reasoning. Three more agents
were then told to **refute** every `FALSE_POSITIVE`, because that is the verdict that makes work
disappear. **They rejected 12 of them**, including *all three* fee-router HIGH reentrancy findings
the first pass had argued down most forcefully.

**That gap is the finding.** Careful agents, reading real code and citing real line numbers, were
still wrong about roughly a fifth of what they cleared. Had the first pass been actioned — and it
was one command away from being actioned — 18 inline suppressions would have landed and taken
`uninitialized-local`, `incorrect-equality` and `unused-return` out of the `fail-on: medium` gate
across **nine contracts**. All three are on `detectors_to_include`, the list the config itself
labels *"Fund-loss detector class… run loud."*

**Eight real defects were found underneath the dismissals.** None is what the detector claimed; each
surfaced while checking whether the detector's claim was false. The three worth naming here:

- **`StreamingRevenueDistributor` (v2)** — `_effectivePower` silently degrades to zero **three ways**,
  one of which is *the default post-deploy state* (`restakingContract` unset). So `isSynced` returns
  **true for every un-registered restaker** — the house's cardinal sin, and exactly what its own natspec
  says it exists to prevent. (ATTRIBUTION FIX 2026-08-27: `_effectivePower`/`isSynced` live in
  `src/v2/StreamingRevenueDistributor.sol`, NOT `RestakingMonitorView` — a re-auditor following the old
  name opened the wrong file.)
- **`NftfiPooledLendingVault.repay`** is **not** revert-on-failure: it clamps and under-applies
  silently at `:386`, and `NftfiBnpl` has no rescue path. A suppression would have made the gate
  blind to it.
- **`TegridyHarvestVault:370/:386`** — a **one-wei donation** floors `swapAmount` to zero and grieves
  `harvest` into `NothingToCompound`. Anyone can do it, for one wei.

**And the tests meant to back the suppressions do not all hold.** The HarvestVault ones rest on
selector-precise reentrancy tests with a disarmed-hook control; the FeeExecutorRouter ones rest on a
bare `vm.expectRevert()` **whose revert is swallowed by `_execSwap` at line 343**.

▶ **THE ORDER OF WORK, and it is not "suppress and move on":**
1. Fix the eight defects, each in its own PR **with a test**. Several are cheap; the
   `RestakingMonitorView` and `NftfiPooledLendingVault` ones are not, and a `CLAIM_GRACE_PERIOD`
   contradiction needs a human decision.
2. **Re-run Slither after the fixes** — the finding set will have moved, and the remaining triage
   belongs against the new report, not this one.
3. For whatever genuinely survives, prefer an **assertion or an initializer** over a comment.
   Reserve `// slither-disable-next-line` (with a reason, at the site) for invariants the code
   truly cannot express.
4. ⛔ **Never** add `reentrancy-balance` or `incorrect-equality` to `detectors_to_exclude`, and
   **never** lower `fail-on` or add `continue-on-error`.

⚠️ Even among the 32 **upheld** verdicts the refutation found reasoning errors — id 38's "no caller
can zero another account's power" is false, id 7's divergence figure is 3× high, id 40 misses a
third writer. Do not lean on an upheld proof without re-reading it.

*Standing context that lowers the stakes and should not lower the care:* **none of these contracts
is deployed.** Nothing here is live risk today; the value is catching a real bug at the cheapest
possible moment, which is before the deploy ceremony.

*One process note, recorded because it cost trunk 15 minutes of red:* I verified `b0484908` with
`tsc -b` and `vitest` and **did not run `npm run lint`**, which is the other third of the
`Lint, Type Check & Test` job. An explanatory comment placed between two empty `case` labels made
`no-fallthrough` read the case above it as a falling-through body. Fixed in `a0c83c42`, and found
by reading why two Dependabot PRs were failing rather than by my own check. **Run all three.**

**7. Repo hygiene — the numbers moved, so here they are fresh.** 122 worktrees · 329 local branches,
**120 of them fully merged** into `mvp-launch` · 12 stashes, nine on `main`, which is not the trunk ·
roughly 27 GB reclaimable, because `.git/worktrees` holds a duplicate submodule clone per worktree.
⛔ Prune with `git worktree remove` **only** — 93 are dirty, and deleting the directories by hand
leaves the metadata behind. This is safe, boring, and worth doing before the count grows again.

**Closed 2026-08-22 (late session), so nobody re-opens them:**

- **The advisory gate had never run** (`5565506b`) — errexit killed the audit step before the gate
  was reached, every run since it was armed. See item 1.
- **Four required checks could be satisfied by an echo** (`cdd58b06`) — the `-not-applicable.yml`
  companions are gone. See item 8.
- **`readDeployment` called a closed program deployed** (`b0484908`) — a live honesty failure, not a
  comment. See item 6.
- **Eight stale "the Solana rail is live" claims** (`514942c5`) — two of them found by scanning
  rather than by list.
- **The foundry-toolchain dependabot mute** (`22823be3`) — its stated release condition was met by
  `#205`.
- **`#278` closed as superseded**, `#304` and `#265` rebased onto trunk and ready to merge. See
  item 2.

**Closed since the previous revision (2026-08-22), so nobody re-opens them:**

- **Registry chain read hardened** — [#280](https://github.com/fomotsar-commits/tegridy-farms/pull/280)
  (`cbc60f15`). Batched to two requests for 58 addresses; three outcomes instead of two, so a
  rate-limited endpoint skips and is counted rather than failing the build; `registry-onchain.yml`
  now fails a **total** skip, closing the "green means nothing was checked" hole one level below its
  existing grep. New **check 5b** covers Solana literals in `launcher/solana/curve/program.ts`,
  which `constants.ts` — being EVM-only — never saw.
  ⚠️ On a real GitHub runner the public endpoints answered all 58 with **0 NOT CHECKED**, so do
  **not** buy keyed RPC endpoints on spec. Watch the `NOT CHECKED` count and act only if it moves.
- **Keyfile hygiene verified** — keys directory gitignored, no keypair JSON ever committed, and the
  identities readme holds no secret material. See §0.3.
- **Squads 2-of-2 proven usable** — it executed both program closes. See standing rule 3.
- **A self-inflicted trap fixed** — `base58Decode` returned **33 bytes** for an all-zero key, so the
  System Program would have been rejected as "NOT A SOLANA ADDRESS": the exact verdict that function
  exists to reserve for a fabricated key. Found by a self-test case, not by a registry entry.
- **The gotchas that were only in my head are now in the repo** —
  [`DEVELOPING.md § Common gotchas`](DEVELOPING.md#common-gotchas). Two of them can destroy work on
  this box: a worktree's `node_modules` may be a **junction**, so `rm -rf` follows it and deletes
  the real tree (`cmd /c rmdir` removes only the link); and PowerShell 5.1 mangles the encoding of
  any non-ASCII file it round-trips, which is every runbook and `addresses.json`. The rest are
  verification discipline — including why "the search did not run" must never be reported as "it is
  not there", which produced two confident wrong claims before it was written down.

**When you finish any Tier 0 or Tier 1 item, tell me and I will wire what it unlocks the same
hour.** Most of the remaining code work is one env var away from being reachable.

---

# 🧭 START HERE — everything left, in the order it should happen

Written 2026-08-22 at the close of the session that landed the eleven commits listed under "Closed
2026-08-22 (late session)". This section is the single entry point; the tiers above are the detail.

**Read this rule first, because it is the one the repo keeps re-learning.** Three gates have shipped
here that could not fail: a `tsc --noEmit` over zero files, a chain read behind a flag nothing
passed, and a CI check satisfied by a two-second echo. Every one of them was *green*. So the
question to ask of any check is never "is it passing" but **"could it fail if the thing it guards
broke?"** Two of the three were found by someone reading *why* something unrelated was red.

## The dependency spine — what actually blocks what

```
  Safe re-home ─────────────► contract deploys ────► lending / gauges / community un-gate
   (Tier 0.1 §0.3, 7 [op])          (Tier 2.2)              (~2,500 lines of finished UI)

  Login change-set ─────────► social layer + push + profiles
   (4 items, strict order)

  DBC config v2 ────────────► first public Solana launch ────► fee-claim ceremony
   (1 [op] session)

  Indexer hosted ($5-20/mo) ► Leaderboard/History/TVL ────► fact sheets, afterlife, Dune
   (1 [op] decision)              (client already written)

  trunk green ──────────────► everything is cheaper, nothing is blocked by it
```

Only the **first** box in each row is blocked on you. Everything to the right of it is written and
dark. That is the whole shape of this project right now: **over-built and under-lit.**

## Order of operations

### ① What an agent can finish alone — three items, all with the work already written

Updated **2026-08-24**. `E2E Tests` is green (524/0). Zero open PRs. Trunk is clean and all five
frontend gates pass: `tsc -b` · `npm run lint` · 5,957 tests · `npm run build` · Playwright.

⚠️ **Run all five before committing.** Trunk went red on 2026-08-22 because a session verified with
`tsc -b` and `vitest` and skipped `npm run lint`, and the break was found two days later by reading
why unrelated Dependabot PRs were failing.

---

#### ①.1 🔴 The v2 distributor — WRITTEN AND GREEN, needs an independent review before merge

**Branch [`wip/v2-timelocked-forfeit-UNREVIEWED`](https://github.com/fomotsar-commits/tegridy-farms/tree/wip/v2-timelocked-forfeit-UNREVIEWED). 40/40 tests pass. DO NOT MERGE YET.**

This is the **third** attempt at this contract. Attempts 1 and 2 each looked exactly this clean and
were each refuted by two independent adversarial passes. Attempt 3 has had **none** — the review
workflow failed on API 529s five times.

**What it does.** It stops trying to make a permissionless confiscation safe and removes the
permissionless confiscation. `sync`/`syncMany` now only update the mirror; they cannot reduce
`rewards`, touch `totalForfeitedToPool`, or cost any account a wei. The forfeit moved behind an
owner timelock (`proposeForfeit` → 48h → `executeForfeit`, plus `cancelForfeit` and a
`pendingForfeit()` view). The refuted `exitedAt` anchor is deleted, and `_claimDeadlineOf` now
returns **UNKNOWN** where no durable anchor exists — the two callers resolve unknown in opposite
directions, both toward the staker.

**There is deliberately NO value cap**, and that decision is the thing most likely to be second-
guessed, so the reasoning is in the source at the `MAX_LIFETIME_FORFEIT_BPS` block. In short: a 1%
cap copied from v1 made the mechanism unusable (its first realistic test hit
`ForfeitCapExceeded(1.75e18, 6.99e16)` — v1's 1% reclaims *dust*), and this contract has **no
owner-side ETH exit at all** — verified across the whole file and every inherited base, exactly one
ETH-moving call exists and it pays `msg.sender` their own reward. So a compromised owner can
**redistribute but not extract**, and eligibility is the real cap: only accounts with positive
evidence of abandonment can ever be touched. Active stakers are unreachable by construction.

▶ **RUN THE SAVED REVIEW.** It is resumable and nothing is cached, so it is a clean run:

```
Workflow({scriptPath: '.../workflows/scripts/refute-timelocked-forfeit-wf_4f0670ec-855.js',
          resumeFromRunId: 'wf_4f0670ec-855'})
```

▶ **The two questions self-review could NOT answer**, and which the pass must:
1. Can a permissionless `sync` shift value **between** accounts through the mirror, without touching
   `rewards`? A mirror write is not obviously harmless — trace `earned()` and `rewardPerTokenStored`.
2. Can the owner forfeit an account whose rewards **arrive during** the 48h window?

✅ **Already verified mechanically** (do not redo): three mutations killed — `_isForfeitable`
returning true, `onlyOwner` dropped from `proposeForfeit`, and the no-anchor case returning
`(true, 0)` (that last is the exact shape attempts 1 and 2 died on, and four tests object to it).
Zero `testFuzz_*` names. Size 12,770 / 24,576 bytes.

⚠️ **Accepted trade-off, asserted by two tests so nobody "fixes" it with a third anchor:** a
fully-exited staker and a former restaker can **never** be forfeited, by anyone including the owner
— the burnt NFT leaves no `lockEnd` and a restaker's `userTokenId` is 0 for life. Their ETH stays
claimable by them forever and never recycles. That is the safe direction: the protocol has no claim
on user funds it cannot prove were abandoned.

---

#### ①.2 🟡 The `lending` repay — a real broken transaction, now visible

`E2E Tests (Anvil fork)` is **18 passed / 1 failed**, down from four failing legs
(`c6e64cd3`, `deb43a29`). `stake`, `swap` and `claim-rewards` pass clean.

**The remaining failure is not a test problem.** `lending.spec.ts` reports *"the repay was submitted
but the loan never read back as repaid — the repayment did not confirm on chain."* That is the
assertion which replaced a false green: the old `toHaveCount(0)` on `/^Repay Loan$/` would have
**passed here**, because the button's accessible name changes to *"Confirm in Wallet…"* the instant
it is clicked. So this leg was always broken and the test was reporting otherwise.

▶ **Debug the repay transaction, not the spec.** The spec is now correct.

Also amber: `liquidity` fails attempt 0 on the `notHash` guard — *"the only receipt on the page is
still the PREVIOUS step's"* — and passes on a warm retry. That guard is working; without it the
add's own receipt link would satisfy the burn. It is a state/ordering issue between the two legs.
⛔ **Do not "fix" it by dropping `notHash`.**

---

#### ①.3 🔴 The eight Slither defects — fix, do not suppress

Unchanged and still the largest open item. Both triage passes are done; the answer is **not** to
suppress. Full account with every verdict and both passes verbatim:
[`SLITHER_TRIAGE_2026_08_22.md`](SLITHER_TRIAGE_2026_08_22.md). The short version, and the ordered
defect list, is in item **8** below.

The three worth naming here, because they are the same defect class as the distributor work above —
a silent zero standing in for an unknown:

1. **`StreamingRevenueDistributor` (v2)** — `_effectivePower` degrades to zero **three ways**, one of
   which is the default post-deploy state, so `isSynced` answers **true for every un-registered
   restaker**. (These live in `src/v2/StreamingRevenueDistributor.sol`, not `RestakingMonitorView`.)
2. **`NftfiPooledLendingVault.repay`** is **not** revert-on-failure: it clamps and under-applies
   silently at `:386`, and `NftfiBnpl` has no rescue path.
3. **`TegridyHarvestVault:370/:386`** — a **one-wei donation** grieves `harvest` into
   `NothingToCompound`.

⛔ Never add `reentrancy-balance` or `incorrect-equality` to `detectors_to_exclude`; never lower
`fail-on` or add `continue-on-error`. And do not trust the FeeExecutorRouter's existing reentrancy
test as cover — its `vm.expectRevert()` is bare and **its revert is swallowed by `_execSwap` at line
343**.

---

#### ①.4 ✅ Dependabot — DONE, nothing open

Fifteen PRs closed, thirteen bumps landed (`e5f78839` for twelve as one verified batch, plus
framer-motion 13 separately in `87690e42` with its own 524-test e2e matrix, plus
`@vitejs/plugin-react` 6.1.0). **Zero open PRs.**

Every one of those PRs had been reporting `Lint, Type Check & Test` red, and **every red was stale**
— runs from 2026-08-22 20:23 failing on a `no-fallthrough` error fixed hours later in `a0c83c42`.
None had re-run. If a batch of Dependabot PRs ever looks uniformly red again, check the run
timestamps before believing it.

### ② The operator critical path — nothing to the right of it moves until you act

Ordered by *what unblocks the most*, not by effort. Each row links to the section that has the
commands, what you should see, and what a mismatch means.

| # | Do this | Time | Unlocks | Detail |
|---|---|---|---|---|
| **0** | ⏳ **Execute the staged TWAP floor change** — *expires 2026-08-30 18:03 UTC* | ~30 sec | Nothing on its own. Takes the 24h timelock off the oracle's critical path, so the deepen day is same-day. Half already done and on chain | §0.5 |
| 1 | **Vercel env session + redeploy** | ~5 min | The CSP fix currently **browser-blocking Pro Pass creation**, the write-proxy repoint, the analytics endpoint | §0.2 |
| 2 | **Login change-set** | ~2 min of SQL | Profiles, DMs, watchlists, votes, push, alerts, referral claims, real analytics — the entire social tier | §0.1 |
| 3 | **Redeploy the Solana own venue** | one ceremony | The only Solana rail — Meteora is retired | [restart plan](SOLANA_RESTART_PLAN_2026_08_23.md) |
| 4 | **Host the indexer** | $5–20/mo | Leaderboard, History, per-pool volume/TVL, treasury feed, timelock queue — client already merged (`088ed89e`) | §1.1 |
| 5 | **`MEMETICS_BIRTH_SECRET`** | one paste | Births signed, tokens enrolled from birth. Prod answers `503 no_secret` today | §1.2 |
| 6 | **Safe re-home** | multi-session | Every contract deploy, and ~2,500 lines of finished community UI behind them | §0.3 / Tier 2.2 |

**Why 1 comes before 2, and it is not a preference.** `VITE_*` variables are baked in at **build**
time. `castVote → proxyWrite` is merged (`c66e6064`) but **not deployed**, so production still serves
the anon-key writer. If you run the 015 §1 DROPs while prod serves the old bundle, writes are refused
with `42501` and the old code returns a bare boolean — **they vanish silently**, which is the exact
failure `c66e6064` exists to prevent. Redeploy first.

**On 2 — the order inside it is a correctness requirement:**
`015 §1 DROPs → 014 whole (same session) → verify 42501 on all four tables + nonce 200 → 016 →
prune_revoked_jwts → 013 + VITE_ANALYTICS_ENDPOINT → redeploy`.
⛔ **Never run 008 after 014** — its blanket GRANT undoes 014. ⛔ **Never run 004 as a unit.**
Expect the permissive-policy count to drop **21 → 13**.

**On 3 — the curve question is closed and the answer is a flat 1.00%.** No decay: the market
abandoned it (pump.fun flat 1.25%, LetsBonk flat 1%), and our own program cannot express it anyway
— there is no time input on the fee path, and a 2000 bps opening fee would need `MAX_FEE_BPS` raised
in a program holding other people's SOL. An honest buyer pays **1.00% at sixty seconds instead of
14.82%**. ✅ The three CODE blockers are closed (`b90d339f` merged the segmented removal, `f14701a1`
cleared the CI guard, the self-referential spent-id list and the stale runbook step).
⚠️ The step that has **never once run** is `create_amm_config` → `update_global`. Its absence is why
`migrate_to_amm` failed `AmmNotConfigured` for the whole life of the old program, so no launch could
ever graduate. **Two signatures, not one.**

**On 6 — ⏸️ the Safe topology decision itself stays deferred by your instruction** and nothing in
this document reopens it (§0.3). Two things sit explicitly *outside* that deferral and are still
worth doing: the **deployer keystore backup** to two offline geographies, and the `guardianPause()`
correction in `INCIDENT_RESPONSE.md` (the runbook tells the guardian to call `pause()`, which
reverts — `onlyOwner`; the real entry is `guardianPause()`, selector `0xd4593872`).

### ③ After ① and ② — the standing backlog

**18 `[code]` items are buildable today**, ~2 h to ~20 h each, ordered cheapest-first with a written
how-to per item — files, approach, trap, verification command — in
[**`CODE_ITEMS_AUDIT_2026_08_22.md`**](CODE_ITEMS_AUDIT_2026_08_22.md).

Point an agent at that document and the queue, not at this file. The top of it: guided first-run
onboarding (2 h) · the rest of the honesty-debt sweep (2.5 h) · extending the ghost-code guard to
components (3 h) · the indexer gaps (3 h) · the keyless scanner API (3 h).

Three of those items sit **behind ②**, and the audit says so per item — most notably the whole
indexer/GraphQL cluster, which is written and dark until ②.4.

### ④ Clocks — these run whether or not you act

| When | What | Days left as of 2026-08-22 |
|---|---|---|
| ~2026-10-11 | Staking reserve runway ends. **Downgraded** — the app already shows this honestly; refill when convenient | ~49 |
| ~Aug 2027 | `memetics.finance` renewal | ~345 |
| Standing | `TegridyStaking` has **22 bytes** of EIP-170 headroom, `VoteIncentives` **99** | — |

**The October date was over-stated here and is now downgraded** (operator decision, 2026-08-23:
*"we always show what is real — if there are no rewards it shows zero, and we will refill; with
volume that becomes a flywheel"*). Verified against the code, and the claim holds at every layer:

- `TegridyStaking` credits what it can and routes the shortfall to `unsettledRewards[holder]` — a
  **real claimable balance**, not a promise — and emits `KickRewardPoolShortfall` when
  `pending > rewardPool`, plus a loud `RewardsForfeitedDuringKick` if even that bucket saturates.
- The UI reads it per user (`useUserPosition.ts:35`) and renders it as a named line with its own
  button: *"Unsettled: … TOWELI"* / **Claim Unsettled** (`StakingCard.tsx:232-237`).
- `usePoolData.ts:44` computes the remaining pool as
  `balanceOf(staking) − totalStaked − totalUnsettledRewards`, so **owed rewards are never counted as
  available**, and clamps to zero rather than showing a negative.
- The runway itself is already on the page — `IncentivesStrip.tsx` surfaces seconds-of-emission-left
  as a humanised countdown, `0` when dry.

So there is **no silent partial payment and no fabricated number** — a dry pool reads as a real zero,
which is the correct behaviour. Refill is a business decision on its own timetable, not a
correctness deadline.

## The plan documents, and which to open when

| Document | What it is | When to open it |
|---|---|---|
| **`TODO_OPERATOR.md`** (this file) | The operative runbook — what to do next, in order | Always start here |
| `YEAR_PLAN_2026_2027.md` | The 12-month checklist. **105 unticked: 44 `[code]`, 44 `[op]`, 4 `[ext]`, 1 `[island]`** | Quarterly planning |
| `BATTLE_PLAN.md` | 9 foundation tracks, 8 waves, per-item build instructions | When you are about to build one of them |
| `TOP_100_BUILDS.md` | Revenue-ranked backlog with comparables | Choosing what is worth building at all |
| `WHAT_I_NEED_FROM_YOU.md` | The operator asks, with §0.3 recording the Safe deferral | Before a signing session |

⚠️ **A convention that matters:** in `YEAR_PLAN`, a ticked box means **merged and tested — NOT
deployed, NOT switched on.** `BATTLE_PLAN` uses the stricter pair (`✅ shipped` vs `🟡 in the tree`).
A box ticked on a half-done item is a lie the next session inherits.

## The `[code]` backlog — audited, and there is a queue

**✅ The audit ran.** Six agents plus a completeness critic checked all 44 unticked `[code]` lines
against source files, tests and git history, treating the plan as a claim rather than as evidence.
Full results, one section per item with a written how-to:
[**`CODE_ITEMS_AUDIT_2026_08_22.md`**](CODE_ITEMS_AUDIT_2026_08_22.md).

| | |
|---|---|
| Audited | **44** items |
| Status | 7 DONE · 27 PARTIAL · 10 NOT_STARTED |
| Buildable **today** | **25** (no keys, no deploy, no third party, no live DB) |
| Blocked on you | 13 |
| Blocked on a third party | 6 |

**Seven were already done and are now ticked** with the commit that proves each — including three
nobody had recorded: the arb-linkage monitor is on a real 15-minute cron and **firing** (six
consecutive successful scheduled runs verified), the EIP-5792 pair and `gateAudit` surface are
**mounted**, and one-click launch-buy shipped in `436c5aad` with the ratchet exemption gone.

**Eighteen more are buildable right now**, ~2 h to ~20 h each, ordered cheapest-first in that
document. The top of the queue: guided first-run onboarding (2 h) · the rest of the honesty-debt
sweep (2.5 h) · extending the ghost-code guard to components (3 h) · the indexer gaps (3 h) · the
keyless scanner API (3 h).

▶ **Point an agent at that document and the queue, not at this file.** Every item there names the
exact files, the approach, the trap, and the verification command.

⚠️ **Three plan lines are stale in a way ticking cannot fix**, and the audit says so per item:
line 40 (`castVote → proxyWrite`) is **merged but not deployed**, and the deploy must precede the
015 §1 DROPs or writes fail silently — which is the exact failure that commit exists to prevent.
Line 39 is mislabeled `[code]`: it needs a live database read. Line 71's "companion workflow"
prescription would **reintroduce** the defect fixed in `cdd58b06`.

---

# 🔴 NEW 2026-08-23 — the v2 distributor can confiscate a staker's ETH, permissionlessly

Found while answering "grace or block?" on the `CLAIM_GRACE_PERIOD` contradiction. The question
turned out to be malformed, and the answer is much worse than either option.

**None of this is deployed.** `StreamingRevenueDistributor` is v2 and unbuilt. v1 is live at
`0xF993316E2fC079de4358c489A935E01e03E23E17` but **holds 0** and has never received a distribution.
So there is no money at risk today — and every item below becomes live the moment the fee rail is
switched on, which is exactly what §"First revenue" is for.

## What is actually wrong

`_lockEndOf` returns `0` on three conditions that mean different things: no position, `positions()`
reverted, `userTokenId()` reverted. Two call sites then read that `0` in opposite directions and
**both hurt the staker** — `:499` forfeits with no grace, `:617` refuses the claim.

But the outage is not the headline. Three findings reorder it:

1. **🔴 CRITICAL — restakers are structurally forfeitable, with no outage at all.**
   `StakingRewardLib.sol:890` zeroes `userTokenId[from]` on every outbound transfer, and
   `TegridyStaking.sol:790` force-returns 0 voting power for the restaking contract. So
   `_lockEndOf(restaker)` is **permanently 0 by construction**. The only thing between a restaker
   and confiscation is `_isRestaked` — one uncapped external call whose catch arm returns `false`.
2. **🔴 CRITICAL — `_effectivePower` is the precondition, not a bystander.** It degrades to 0 on
   three conditions, one of which is **the default shipping state** (`restakingContract` unset,
   armed only by a 48 h timelock). `_updateReward` then *writes* that 0 into `effectiveBalanceOf`,
   which is exactly what makes the "fully exited" early-return fall through. One escrow failure
   cascades through **four** swallowed reads to confiscate an account in perfect standing.
3. **🟠 HIGH — the forfeit is permissionless and the attacker is paid for it.** `sync(address)` and
   `syncMany(address[])` (batch of 100) have no access control — the natspec says "Permissionless by
   design". Forfeited wei goes to `totalForfeitedToPool` and re-streams to **remaining** stakers, so
   a large staker is paid pro-rata for confiscating everyone else's accrual. One call, gas only.

**v1 has the same conflation but does NOT outrank v2**, and this was checked rather than assumed:
v1's only forfeit is owner-timelocked (48 h, 1% lifetime cap, 14-day dust grace), so an escrow
failure there is a **retryable lockout, not confiscation**. Its outage arms are also near
unreachable — `userTokenId`/`positions` are plain public-mapping auto-getters that cannot revert,
and `votingEscrow` is immutable. v1's real exposure is the no-outage path: a staker who unstakes
before claiming has `pendingETH` report **0** on ETH they already earned. Fabricated zero.

**🟡 One more, pointing the other way:** `_isStakingPaused` fails **OPEN** — its catch arm returns
`false`, so an unreadable escrow silently **disarms the kill switch**. Do not let the fix's
tolerance for an unreadable escrow extend to `notifyRewardAmount`, or an outage becomes a window for
scheduling revenue against corrupt data.

## A fix was written and REFUTED — twice, independently

Branch **`wip/lockend-sentinel-REFUTED`** (`fe560b06`). It is good work and worth reading: it copies
the two-value return from `LaunchRugEscrow._readCovenantBps` (existing in-repo pattern, not
invented), gives `_isRestaked` the same treatment, and carries 12 mutations with zero survivors.

**It does not ship.** Both adversarial passes found the same defect, and the second reproduced it in
an isolated sandbox byte-identically. The fix adds `exitedAt[account]` as a grace anchor, stamped
when this contract first *notices* the mirror zero — and **the account chooses that moment**:

- `TegridyStaking.withdraw` is gated on `block.timestamp >= p.lockEnd`, and it burns the NFT. So
  **the only permitted exit is the one that erases the anchor the grace is measured from.** Not an
  edge case — the normal path.
- The account is normally the first to move the mirror, via the `updateReward(msg.sender)` modifier
  on `getReward`.

Result: an account already past `lockEnd + 7 days` can withdraw, manufacture a fresh 7-day window,
and be paid ETH already assigned to `totalForfeitedToPool`. The refutation test is on that branch as
`contracts/test/v2/RefuteAnchorReset.t.sol` and inverts across the commit boundary.

▶ **What a passing fix needs.** The grace anchor must not be selectable or timeable by the account it
protects. Record the anchor from a **staking-side durable value observed while the position still
exists** — store the `lockEnd` *value*, not the observation *time* — so `withdraw` cannot reset it
and a delayed first observation cannot extend it. The open question that remains is what to do when
no observation ever happened before the burn; failing toward the staker there means abandoned
rewards never recycle for un-synced accounts, and that trade-off is a decision, not a detail.

⚠️ **A ninth vacuous-gate instance, found in passing:** every unit slice runs
`--no-match-test "^(invariant_|testFuzz_)"`, so **any test named `testFuzz_*` under `test/v2/`
compiles, is reported as part of the slice, and never executes.** Do not name new tests that way.

---

# 🌿 The `wip/` branches — what is parked on origin and why

Five branches are pushed to origin deliberately. Agent worktrees get cleaned up, and three of these
existed only as untracked files in a temp directory at some point today. **Nothing here is garbage;
each is either work held back for review or evidence of why something does not ship.**

| Branch | State | What to do with it |
|---|---|---|
| **`wip/v2-timelocked-forfeit-UNREVIEWED`** | ✅ 40/40 green, self-reviewed, **NOT independently reviewed** | The live one. Run the saved refutation workflow (see **①.1**), then merge if it survives. This is attempt **3**; the first two looked just as clean. |
| **`wip/lockend-sentinel-REFUTED`** | ❌ Refuted twice | **Read before touching the distributor.** Carries `RefuteAnchorReset.t.sol`, the test that proves its `exitedAt` anchor was resettable by the account it protected. Attempt 3 keeps its two-value `_lockEndOf` / `_isRestaked` — those parts were never refuted. |
| **`wip/lockend-anchor-attempt2-REFUTED`** | ❌ Refuted in design | Attempt 2, the monotone `lockEnd` high-water mark. 1,079 lines including 637 of tests. Refuted because **restakers can never satisfy it** — their `userTokenId` is 0 for life, so no `lockEnd`-derived anchor exists for them. Kept because its test cases may cover ground attempt 3 does not. |
| **`wip/e2e-anvil-money-paths`** | ✅ Merged to trunk (`c6e64cd3`) | Historical. Safe to delete once you are comfortable the merge is settled. |
| **`wip/e2e-heat-door-full`** | ✅ Fully harvested | Its assertions landed in `ef70d013`. Only an `E2E_PORT` parameterisation remains unharvested — a nicety for running the suite on a non-default port. Safe to delete. |

⚠️ **Do not delete the two REFUTED branches without reading them first.** They are the only record of
two designs that looked correct and were not. A fourth attempt that re-invents either one would be
rediscovering a refutation at the cost of another full review cycle.

---

# ⚠️ UNCOMMITTED IN THE WORKING TREE — the bungalows feature

**Not mine, not committed, and deliberately left alone.** Recorded here so it cannot be lost or
mistaken for stray files.

A complete in-progress feature sits in the working tree, timestamped 2026-08-24 00:47:

| Untracked | Modified (committed versions do NOT import it) |
|---|---|
| `src/lib/bungalows.ts` | `src/components/layout/AppLayout.tsx` |
| `src/lib/bungalows.test.ts` | `src/components/layout/Footer.tsx` |
| `src/components/BungalowPicker.tsx` | `src/lib/artConfig.ts` |
| `public/art/bayla/` — **24 pieces, 8.5 MB** | `e2e/fixtures/wallet.ts` |

✅ **TRUNK IS SAFE.** The three integration files are committed WITHOUT the bungalows import, so
`HEAD` builds and a fresh clone works. The feature is self-consistent in the working tree only.

I did not commit it. It is someone else's in-flight work, it touches **art** — which the standing
instruction says never to alter — and committing a mid-flight feature on someone's behalf is not
mine to do. The `wallet.ts` edit is part of it too: it seeds `tegridy-bungalow` so `BungalowPicker`
(a **fourth** full-viewport overlay) does not block e2e specs, following the same pattern the
ConsentBanner fix established.

▶ **To land it:** commit all four modified files together with the four untracked ones and the art
directory, in one change. Splitting them leaves trunk importing a module that does not exist.
▶ **⚠️ Correction to my own reporting:** the "5,957 tests" figure quoted throughout this session was
measured against the working tree, so it **includes `bungalows.test.ts`**. Trunk's own count is
lower. Re-measure from a clean checkout before treating that number as trunk's baseline.

---

# 📌 Session close-out, 2026-08-24

Trunk is clean of MY work — **zero open PRs**, and the five frontend gates pass (`tsc -b` · lint ·
tests · build · Playwright 524/0), with the test-count caveat immediately above.

**Three of five CI checks recovered this session.** `advisories` (the gate had never once executed —
errexit killed the audit step before it ran), `Static analysis`'s masking shim (a 2-second echo was
publishing a pass under the same check name as a failing 4-minute analysis), and **`E2E Tests`, green
for the first time**. Two remain: the Anvil repay (**①.2**) and Slither's eight defects (**①.3**).

**What changed structurally, and is worth not undoing:**
- The Meteora DBC rail is **retired** — 5,307 lines, with the registry record kept, a mutation-checked
  tripwire, and the licence provenance rescued into `NOTICE.md`. §1.3 explains why the EVM rail was
  **not** swept up with it.
- Four `-not-applicable.yml` companion workflows are **gone**. They could publish a pass under the
  same check name as a real failure, and did. The filter lives in a `scope` job now
  (`.github/scripts/diff-scope.mjs`), so exactly one check run per name can exist.
- Light mode is **dropped**, with the contrast suite rewritten as a tripwire rather than deleted.
- The Solana own venue is **ready to redeploy** — three code blockers closed, curve settled at a flat
  100 bps with a 50/50 creator split. See
  [`SOLANA_RESTART_PLAN_2026_08_23.md`](SOLANA_RESTART_PLAN_2026_08_23.md); §1 is history, start at §2.

**The pattern that produced most of the value, recorded because it will recur:** five separate things
this session were *green or passing without checking anything* — the advisory gate, the Slither shim,
`readDeployment`, and two e2e specs passing on an approval receipt rather than the transaction under
test. A sixth was one command from shipping: a Slither triage cleared 54 of 56 findings with careful
line-cited reasoning, and the adversarial pass rejected twelve of them and found eight real defects
underneath. **Ask of any check: could it fail if the thing it guards broke?** Two of the five were
found by reading why something *unrelated* was red.

---

## 2026-08-28 — Row 8's OPERATOR half: the live ConvertLib still runs the old bytecode

The row-8 re-anchor (PR #336) replaced `SwapFeeRouterConvertLib._readCurrentCumulative`'s
hand-derived cumulative-price bridge with a provenance-pinned port of canonical
`UniswapV2OracleLibrary` — **in source**. The DEPLOYED delegatecall library
(`0x96A4Ed675eA203c4b4ae02F8Ad6D4f300Ee97295` on mainnet, plus the Base/RH stack copies)
still executes the old hand-rolled math, which the ROW8 equivalence tests pin as
behaviorally identical (`Audit_SFR_H01.t.sol` — idle-window integral, same-block no-bridge,
uint256 wrap; a fleet critique agent is independently re-proving bit-equivalence as of
2026-08-28). So this is NOT urgent and changes no live behavior — but "row 8 source half
closed" must not be read as done-done while the money path runs old bytecode.

**Operator item (bundle with the NEXT planned SwapFeeRouter-stack deploy, do not deploy for
this alone):**
1. Redeploy `SwapFeeRouterConvertLib` + relink/redeploy the SwapFeeRouter stack on all
   three chains (mainnet / Base 8453 / Robinhood 4663).
2. Re-run the ownership + pending-role ceremonies for the fresh addresses (2-of-2 Safe —
   same shape as the M.2 ceremony; prove-it-signs first, as always).
3. Update `frontend/scripts/addresses.json` + chains/registry + re-verify sources on the
   three explorers (the Standard-JSON method from the 08-27 L2 verification is recorded in
   project_2026_08_20_multichain memory / docs).
4. Only then may docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md row 8 drop its "live bytecode
   unchanged" caveat.


---

## Two things waiting on a human, 2026-09-04

Both are blocked on credentials or a signature, not on code. Everything else from the audit
remediation is merged.

### 1. Apply migrations 024 and 025

Both are on trunk and neither has been applied. `025` is the one that matters: it takes the anon
role's INSERT/UPDATE/DELETE away from `user_profiles`, `user_favorites`, `user_watchlist` and
`votes`. Until it lands, RLS is the *only* thing between the published anon key and every user's
rows — and `008`'s `ALTER DEFAULT PRIVILEGES` silently re-grants those verbs every time someone
re-runs it to clear a 42501 (audit TF-056).

⛔ **Do not use `supabase db push`.** It applies files in filename order, and filename order here
runs `014` before `015`, which by 015's own analysis publishes every user's favourites, watchlist,
profile and votes to anyone holding the anon key. `supabase/MIGRATIONS.md` says this outright.
These go into the Supabase SQL editor by hand, in this order.

**The ordering precondition for 024 is already satisfied.** 024 requires the frontend read to move
off the anon key first, or every user silently gets zero rows. That shipped — both tables now read
through `proxyRead()` and the proxy allowlist admits them. Verified on trunk 2026-09-04.

1. Run each file's ⛔ PREFLIGHT block. They were rewritten on 2026-09-04 because the originals
   could not fail: 024 read an HTTP status code (PostgREST answers an RLS-**denied** select with
   `200` and `[]`, not 403) and both 024 and 025 grepped a built bundle for a URL supabase-js
   assembles by concatenation. The replacements distinguish the cases and say which outcomes are
   inconclusive.
   - The 025 write-side check is already answered: **zero anon writers**, verified 2026-09-04. The
     only textual match is a comment at `userdata.js:466` describing an `.upsert()` already removed.
2. Paste `024_personal_tables_read_lockdown.sql`, then `025_user_tables_anon_write_lockdown.sql`.
   Both are idempotent — `DROP ... IF EXISTS`, ledger insert `ON CONFLICT DO NOTHING`.
3. Confirm both rows landed:
   ```sql
   select filename, applied_at, note from public.schema_migrations
    where filename in ('024_personal_tables_read_lockdown.sql',
                       '025_user_tables_anon_write_lockdown.sql')
    order by filename;
   ```
4. ⛔ **Never re-run `008` after this.** It re-grants what 025 revokes.

### 2. `recoverCallerCredit()` — and WHEN, which is the whole point

`ReferralSplitter.callerCredit[SwapFeeRouter]` holds the non-referral 80% of every ETH swap fee.
It is not locked: anyone may pull it with the permissionless `SwapFeeRouter.recoverCallerCredit()`,
which folds it into `accumulatedETHFees`.

```
node scripts/pull-caller-credit.mjs          # reads the chain, prices the pull, prints the command
```

That prints the exact `cast send ... "recoverCallerCredit()" --rpc-url <rpc> --ledger`, plus an
Etherscan write-tab URL for a wallet without Foundry. **Sign it from hardware.** No signing key
belongs in CI, which is the repo's most consistently held ops rule and why nothing automates this.

⛔ **Do not pull yet.** It is still negative EV — the gas costs more than the credit recovers. As of
2026-09-04 the alert distinguishes those two states properly: `stranded_worth_pulling` is now a
first-class output key and a fingerprint fact, and the workflow raises a distinct `::error::PULL NOW`
only when the pull actually pays for itself. Wait for that. Nothing pays a staker until cumulative
front-door fees reach ~1.25 ETH anyway, roughly 417 ETH of routed volume at 0.3%.

⛔ **But do pull it BEFORE any SwapFeeRouter redeploy, not after.** `callerCredit` is keyed to the
router address. Once a new router is live, the old balance is reachable only through the
owner-gated `recoverCallerCreditFrom(oldSplitter)`. The standing note "wire it before deepening" is
really *before redeploying*. This matters because TF-010 and TF-015 both land on a router redeploy.

## What is left after the 2026-09-04 audit sweep

The sweep closed TF-011, TF-012, TF-016, TF-043 and (in this change) TF-010 + TF-015. Nothing below
is a known-exploitable hole in a live contract. It is the honest remainder: decisions, deploy-gated
work, and things worth watching.

### ⛔ Blocked on you — nobody else can do these

| | What | Why it cannot be automated |
| - | - | - |
| **O1** | **Apply migrations 024 then 025** by hand in the Supabase SQL editor. Runbook above. | Needs the service-role credential. Never `supabase db push` — filename order runs 014 before 015 and publishes every user's rows. |
| **O2** | **Call `recoverCallerCredit()`** — but only when the alert flips, and **before any router redeploy**. | It moves protocol funds and must be signed from hardware. No signing key belongs in CI. |

**O2 has become time-ordered, which it was not before.** TF-010 and TF-015 land on a
`SwapFeeRouter` redeploy. `ReferralSplitter.callerCredit` is keyed to the **router address**, so once
a new router is live the old balance is reachable only through the owner-gated
`recoverCallerCreditFrom`. Pull first, redeploy second.

### ❓ Decisions only you can make

- **D1 - TF-015 is OPEN, and the reason is worth reading.** The fix was designed, implemented and
  then WITHDRAWN before commit, because its tests did not actually test it. Mutation **M9**
  (`floorAmountIn` -> `swapAmount` at the FoT 2-hop call site) is *literally the pre-fix state*, and
  the headline test `test_TF015_haircutMakesFoTConversionReachable` **passed under it**. So the test
  suite could not tell the fixed contract from the broken one.
  **The root cause is now MEASURED, not guessed (2026-09-05).** With reserves 100 WETH : 100_000 TOK
  (spot 1e-3 ETH/TOK) and a 100 TOK pile, the enforced floor came back **4.925e16 - exactly HALF**
  the correct 9.85e16. The snapshot captures 7200s of accumulation while the delta over the
  consulted window is only 3600s worth, because `_bootstrapPriced` pokes the pair's cumulative once
  BEFORE the clock advances and once after. A floor at half spot never binds, so neither the
  gross-sizing bug nor its correction is observable - and every test still passes.
  **To reopen it:** build a rig where the TWAP floor demonstrably binds (assert the floor value
  itself, not just that the call reverted), then re-apply the design - it is recorded in full in the
  PR that ships TF-010. Until then, fee-on-transfer token fees remain stranded, which is the status
  quo rather than a regression, and no new governance lever exists.
- **D2 - if TF-015 is revived, it adds a lever that does not exist today.** The withdrawn design put
  a per-token `fotFloorHaircutBps` behind a 7-day timelock, capped at 1000 bps. That still lets a
  patient compromised owner loosen the sandwich floor on any token routed through
  `convertTokenFeesToETHFoT`, including a plain ERC20 - bounded, delayed, and strictly weaker than
  the existing reset-then-bootstrap route which removes the floor entirely on the same delay. The
  cap is a constant: trivial to change before a deploy, impossible after.
- **D3 - the owner's bootstrap conversion still has no ETH floor but the one they type.** The owner
  conjunct in `_enforceMinETHValue` preserves today's behaviour exactly; it does not worsen it.
  Flooring the bootstrap too would red six audit-pinned tests and could permanently strand a token
  whose first pile is genuinely small. Separate change-set if you want it.

### 🚀 Deploy-gated — correct in source, not yet on chain

- **P1 — `SwapFeeRouter` + `SwapFeeRouterConvertLib` redeploy** carries TF-010 and TF-015. The
  library is **link-time delegatecall**, its address baked into the router bytecode at two offsets,
  so both must be redeployed together. `SwapFeeRouterAdmin` is forced too (its constructor takes the
  router address). Before the ceremony:
  - `forge inspect src/SwapFeeRouter.sol:SwapFeeRouter storage-layout` and confirm
    `accumulatedTokenFees` has not moved — **seven** existing tests hardcode its slot for `vm.store`.
  - `forge build --sizes` against EIP-170. Baseline was 21,531 B (3,045 B headroom).
  - `MIN_TOKEN_FEE_FOR_CONVERSION()` **disappears from the ABI.** Nothing on- or off-chain was found
    to read it — re-check any dashboard before you deploy.
  - Do O2 first (see above).
- **P2 — `POLAccumulator` redeploy** carries TF-011's fee-netting. Live and not upgradeable.
- **P3 — first deploy of `LaunchRugEscrow`** carries TF-012's two fixes.
- **P4 — first deploy of `DecayingFeeHook`** is constrained by TF-016: the owner Safe must open the
  pool itself, and steps 1-3 must go as ONE MultiSend batch. See the TF-016 bullet above.

### 👀 Worth watching, not blocking

- **W1 — Slither now analyses `contracts/src/lib/`** for the first time. `filter_paths` was
  unanchored and silently excluded all nine files there; anchoring it took findings 323 → 345 and
  Medium 3 → 4. The gate is `fail-on: medium`. When a red appears on a branch touching that
  directory, **diff the findings against a trunk run before believing it is yours.**
- **W2 — TF-010 lowers the permissionless conversion bar** from "1 whole token" to ">= 1e14 wei of
  value (~$0.30)". More conversions will happen, so more sandwich *opportunities* exist — each still
  TWAP-floored and rate-limited by the 1h cooldown. This is the point of the finding, but it is a
  real change to keeper economics; watch the first weeks after P1.
- **W3 — `convertTokenFeesToETHFoT` now has its first coverage (2026-09-05) — but NOT on the
  floor.** An earlier revision of this bullet claimed eleven tests existed; that was wrong. Those
  eleven were withdrawn with TF-015, because seven of them could not distinguish the fixed
  contract from the broken one. EIGHT tests exist now, covering the guards a permissionless
  caller actually meets: WETH/zero-token rejection, both deadline bounds, the empty-pile reject,
  the per-token cooldown, owner-only multi-hop, and the property that makes the function exist —
  an FoT token delivers strictly less to the pair than the router sent (mutation-checked: set the
  mock's fee to 0 and that assertion fails).
  **Still missing, deliberately: any assertion on the TWAP floor value.** The rig cannot produce
  a trustworthy one (D1), and a floor test written against it would be decoration. Fixing the
  poke sequence so the enforced floor matches spot is the precondition for BOTH a real floor
  test and for reviving TF-015 — the highest-value test infrastructure left here.
- **W4 — the 640-790px viewport dead band** still has no reachable Connect control and no nav
  fallback. Unrelated to this sweep; still open.
