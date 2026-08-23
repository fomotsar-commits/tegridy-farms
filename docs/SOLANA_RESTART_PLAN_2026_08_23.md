> ### ⚠️ STATUS 2026-08-23 — the three code blockers below are ALREADY CLOSED
>
> This plan was written before the work. Since then, on `mvp-launch`:
> - **`b90d339f`** merged the segmented-mode removal. Both HIGHs are retired by
>   construction and the client/program size mismatch (716-byte curves against a
>   170-byte decoder) is gone.
> - **`f14701a1`** deleted the `clmm-vendor-guard` CI job (it guarded the directory the
>   merge deletes, and `all-checks-pass` depended on it), de-self-referenced the operator
>   harness's spent-id list (it was derived from the constants, so it would have INVERTED
>   the moment they were repointed — refusing the new program and permitting the spent
>   ones), and retired the runbook's `set-curve-segments` step.
>
> **§1 below is therefore historical.** Read it for WHY, then work §2 onward. The
> remaining blockers are the operator's: fresh keypairs, funding, and the `create_amm_config`
> two-step that has never once run.

# Restart Readiness Plan — Solana Own-Venue Redeploy

**Written 2026-08-23 against `mvp-launch` @ clean.** Every claim below was verified against source, not against a doc. Where the five scoping agents disagreed, the disagreement is named and adjudicated. Where something could not be settled read-only, it says UNKNOWN.

---

## 1. Can we redeploy tomorrow, and what would we be shipping?

**No — not from trunk. Trunk's Rust still contains both unresolved HIGH findings, and trunk cannot produce a working venue even if you accept them.**

Three independent blockers, in order of how quickly they bite:

### 1.1 The two segmented HIGHs are live on trunk right now

`solana/tegridy-amm/programs/tegridy-launch/src/segmented.rs` and `src/vendor/` (8 files: `big_num`, `fixed_point_64`, `full_math`, `liquidity_math`, `mod`, `sqrt_price_math`, `tick_math`, `unsafe_math`) are **present on trunk**, verified by directory listing. The findings ledger's disposition of "MOOT (program closed)" evaporates the moment a program exists again — the ledger says so itself at `docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md:33`.

- **HIGH #7** — segmented mode bypasses the graduation-price continuity band; a published curve shape can list at 35% or 122% of final curve price.
- **HIGH #8** — no reachability or supply gate; a well-formed segment table can permanently brick every launch created under it, one variant on the very first buy.

Both are one `set_curve_segments` authority signature away from reachable. `segment_count == 0` is the only thing holding them.

### 1.2 Nothing from the audit ledger has EVER landed

The last commit touching `solana/tegridy-amm/programs/tegridy-launch/src/` is **`59a63fe1`, dated 2026-08-08**. The last touching `cp-swap/src/` is **`798149b9`, also 2026-08-08**. The findings ledger is dated **2026-08-15**. Zero fixes applied. This is the applied-vs-planned confusion the brief warned about, and the answer is: nothing is applied.

The ledger holds **21 SCHEDULED and 22 MOOT** (verified counts; 43 findings total). `docs/BATTLE_PLAN.md:461`'s "~15 scheduled" understates it and, worse, directs the operator to set `BONDING_CURVE_SIZE = 716`, which is now the **wrong number** — post-removal it is 170.

### 1.3 "Redeploy with the two HIGHs" is not even an available option

This is the finding that removes the tempting shortcut, and I confirm it against source. `frontend/src/lib/launcher/solana/curve/program.ts:360-380` states outright that the client targets the **post-removal** program and that the Rust on this branch "STILL HAS segmented mode, so the two disagree, deliberately."

The decoder gates on strict size equality — `program.ts:623` returns `bad-length` unless `data.length === BONDING_CURVE_SIZE`, and `BONDING_CURVE_SIZE` resolves to 170. Trunk's Rust writes **716-byte** curves.

**Deploying trunk's Rust tomorrow ships a venue whose own frontend cannot read a single launch.** Every curve renders "unreadable." So the choice is not "clean redeploy vs. redeploy with two HIGHs" — it is "merge the branch, or ship a venue that does not function."

### 1.4 And there is a fourth blocker nobody put in the checklist

`declare_id!` in cp-swap (`lib.rs:44`) is still `3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y` — **closed on mainnet 2026-08-13, ProgramData deleted, permanently unusable.** Deploying that binary to a fresh address fails every instruction with `DeclaredProgramIdMismatch` (4100). Bricked on arrival, deterministically.

tegridy-launch's `declare_id!` (`lib.rs:114`) is `8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8`, documented in the comment immediately above as a **throwaway placeholder** corresponding to no key anybody holds.

> **New finding, missed by all five agents:** `solana/tegridy-amm/Anchor.toml:23` sets `tegridy_launch = "CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED"` — the **spent** mainnet id — while `declare_id!` carries the placeholder `8YVjjc5i…`. These two disagree with each other, and both are wrong for a fresh deploy. Anchor.toml and `declare_id!` must be set to the same fresh keypair in the same change. `CpFnacrA…` is registered as SPENT at `frontend/src/lib/launcher/solana/spentProgramIds.test.ts:42`.

Also: tegridy-launch's non-devnet `deployer::ID` is the all-1s sentinel `11111111111111111111111111111111` (`lib.rs:141`), so `initialize_global` is **uncallable** in a default mainnet build until a real key is set.

### Verdict

> **Tomorrow is achievable only if the segmented-removal merge and the two `declare_id` changes land today.** The merge is the cheap part — it is verified conflict-free. The program-id work and the cp-swap admin ceremony are what actually consume the day.

---

## 2. What must land TODAY

### Where the agents disagreed — settled first

**The single most consequential disagreement.** The `segmented-branch` agent recommended rebasing and merging the branch wholesale. The `audit-fixes` agent recommended the opposite: *"Take ONLY the Rust and workflow changes — do NOT merge or rebase it wholesale,"* warning that a merge *"silently regresses trunk's client to the branch's older, partly-guessed version"* and that *"every conflict under `frontend/src/lib/launcher/solana/curve/**` must resolve in favour of TRUNK."*

**I believe the segmented-branch agent. The audit-fixes warning is false.** I verified `git diff --stat fd706689 claude/solana-segmented-removal`: the branch changes **19 files, every one of them under `solana/`**. It touches **zero** files under `frontend/`. There is no client regression risk because the branch never modified the client. There will be no conflicts under `frontend/src/lib/launcher/solana/curve/**` because there is nothing there to conflict.

Acting on the audit-fixes advice would mean hand-porting ~2,900 lines of deletions for a hazard that does not exist — itself a far larger risk than the merge.

**Merge cleanliness re-verified today:** `git merge-tree --write-tree mvp-launch claude/solana-segmented-removal` exits 0 with **no conflict lines**, producing tree `e67d8e3d`. Note this differs from the `8324d0d7` the segmented-branch agent reported — trunk has moved since that agent ran. The merge is still clean; the hash is simply stale. Do not treat `8324d0d7` as an expected value.

---

### 2A. Agent-executable work

| # | Change | Verify |
|---|---|---|
| **A1** | **Merge `claude/solana-segmented-removal` into `mvp-launch`.** Deletes `segmented.rs` (-847) and all 8 `vendor/` files (-1,490); rewrites `lib.rs` (715 changed); adds `payable_protocol_leg` (branch `lib.rs:269`), `initialize_with_permission` CPI, `MigrationPermissionMissing`/`CreatorMismatch` (branch `errors.rs:49,51`). | `git grep -iE 'segment\|CurveMode\|sqrt_price' -- solana/tegridy-amm/programs/tegridy-launch/src/` returns **only comment hits**, no code. Branch `src/` must contain exactly 4 files: `curve.rs`, `errors.rs`, `lib.rs`, `state.rs`. |
| **A2** | **Delete the `clmm-vendor-guard` CI job.** Remove the job block at `.github/workflows/solana-ci.yml:209`; remove `clmm-vendor-guard` from `needs:` at **:836**; remove it from the outputs line at **:857**. | Grep the workflow for `clmm` and `vendor` → zero hits. **Leaving it in `needs:` fails the `all-checks-pass` gate on a skipped dependency, not just the job.** Do NOT touch the sibling `diff-guard` (:151-196) — that one is still load-bearing. |
| **A3** | **Set both `declare_id!`s + Anchor.toml to fresh keypairs.** cp-swap `lib.rs:44`; tegridy-launch `lib.rs:114`; `Anchor.toml:20` (`raydium_cp_swap`) and **`Anchor.toml:23` (`tegridy_launch`, currently the spent `CpFnacrA…`)**. | All four must name the two fresh ids, and `Anchor.toml` must agree with `declare_id!` per program. Cross-check against `spentProgramIds.test.ts` — neither fresh id may equal `CpFnacrA…` or `3ZvZXEBr…`. |
| **A4** | **Set tegridy-launch's non-devnet `deployer::ID`** (`lib.rs:141`) from the all-1s sentinel to the real deploy authority. | `initialize_global` must be callable by the intended key. A sentinel here means the deploy lands and then cannot be initialized. |
| **A5** | **Ship the whole cp-swap `lib.rs` delta as ONE commit and re-pin the hash.** `diff-guard` hashes **comments as well as code**, so `declare_id`, `admin::ID`, the false FAIL-CLOSED paragraph (:33-40), and the security.txt URL must all land together. Re-pin `EXPECTED_DELTA_SHA256` at **`solana-ci.yml:162`** in the *same* PR. | Read the printed diff before re-pinning; never re-pin blind. *(Note: the audit-fixes agent cited :163; the constant is at :162.)* |
| **A6** | **Add error codes 6020/6021 to the client map.** `program.ts:307-327` ends at `6019: 'AwaitingMigration'` — confirmed. Append `6020: 'CreatorMismatch'`, `6021: 'MigrationPermissionMissing'`. `LAUNCH_ERROR_COPY` is `Record<LaunchErrorName, string>`, so TypeScript forces the copy — write it, do not cast around it. | `launchErrorName(6021)` non-null. The 6021 copy must name the actual remedy (a cp-swap admin has not run `create_permission_pda`) — this is what an operator reads when the first graduation fails. |
| **A7** | **Correct `NOTICE.md:10`** — it carries the Apache-2.0 attribution row for vendored CLMM math under `src/vendor/`, a directory A1 deletes, and cites the CI job A2 deletes. | Rewrite in past tense as a record of removed vendored code. Not a licence violation to delete vendored code, but this is the legal-facing file a counterparty reads first. |
| **A8** | **Fix `MAINNET_RUNBOOK.md`** — drop the `set-curve-segments` step (~:296-306); add the permission-PDA prerequisite; record the `create_pool_fee` ceiling **208,734,160 lamports** next to the reserve arithmetic. | Grep the whole file for `segment` rather than deleting only the cited block — trunk rewrote this runbook after the branch was cut and did not catch it. |
| **A9** | **Fix `docs/BATTLE_PLAN.md:461`** — it says `BONDING_CURVE_SIZE = 716` (now 170) and "~15 scheduled" (actually 21 SCHEDULED + 22 resurrected MOOT). | Both numbers are actively misleading instructions an operator will follow tomorrow. |
| **A10** | **Run `cargo build-sbf` and read the linker warnings.** `MigrateToAmm` grew 20→25 accounts; the 4KB SBF frame has been overflowed before and **the linker only WARNS**. | A green build is not proof unless the warning list is actually read. Also run `cargo test` and confirm the claimed 40 lib tests pass (baseline 67; the 27 delta is upstream Raydium property tests that die with the vendored code they covered — not lost coverage of surviving code). |

**Not blocking, but cheap and worth doing today:** the missing tripwire test (checklist item 2). No test under `frontend/` opens any `.rs` file today, which is exactly why the 716/170 drift went unnoticed. Guard it so it **skips loudly with a named reason** if the Rust is absent — a silently-skipped tripwire reads as coverage and is worse than none.

### 2B. Operator-key work (an agent cannot do these)

| # | Action | Note |
|---|---|---|
| **O1** | **Generate the two fresh keypairs** and hand the agent the pubkeys before A3 can be completed. | This gates A3. See the ordering trap in §5. |
| **O2** | **Fund `admin::ID`.** `create_permission_pda.rs:8-12` requires `owner` to be `crate::admin::ID` as a **`mut` Signer AND `payer`**. The audit records it holding 0.001 SOL — less than AmmConfig rent. | It must both sign and pay. Funding alone is not enough; custody must be proven. |
| **O3** | **Run `create_permission_pda`** once, after the cp-swap deploy, before any launch can graduate. | See the seed precision note below — both agents got this subtly wrong. |
| **O4** | **Arm branch protection** on `mvp-launch`. Verified live: `gh api …/branches/mvp-launch/protection` → **404 Branch not protected**. `all-checks-pass` exists at `solana-ci.yml:834` but **zero checks are required**, so `diff-guard` — the fork's entire stated security invariant — is advisory. | GitHub-side action, not a code change. The code half landed and was mistaken for the whole item once already. |
| **O5** | **Decide and prove the Squads signer** before naming any authority. | See §6. |

> **Seed precision — both agents stated this wrong.** The `segmented-branch` agent wrote the seed is `[PERMISSION_SEED, payer]`; `audit-fixes` wrote `["permission", payer]`. The source says the PDA is **created** at `[PERMISSION_SEED, permission_authority]` (`create_permission_pda.rs:19-22`) but **consumed** at `[PERMISSION_SEED, payer]` (`initialize_with_permission.rs:156-157`). Those are different account fields. They resolve to the same address **only if** the admin passes `permission_authority` = the exact pubkey tegridy-launch later passes as cp-swap's `payer` — the migration authority PDA at `[MIGRATION_AUTH_SEED]`. Get this wrong and the PDA is created at an address the CPI never looks at, and every graduation fails `MigrationPermissionMissing` with a permission account sitting right there on chain. **Derive it, print it, and compare both derivations before sending.**

---

## 3. The curve recommendation

**Recommendation: a flat 100 bps (1.00%) trade fee, with `creator_fee_share_bps = 5000` — creator nets 50 bps, protocol nets 50 bps. No time decay. Ship it.**

### 3.1 The rejected design was never expressible

Two independent source facts kill the 2000→100bps decay proposal before any market argument:

1. **`curve.rs:37` — `MAX_FEE_BPS: u64 = 1_000`.** A 2000 bps opening fee requires *raising a deliberate safety ceiling in a program that holds other people's SOL*, enforced at `curve.rs:95` and again at `lib.rs:382,480`. That is a direct violation of the operator's "bullet proof code, never risk the integrity of our code" doctrine.
2. **There is no time input on the fee path at all.** I grepped `Clock::get|unix_timestamp|created_at|start_time` across `programs/tegridy-launch/src/` — **zero matches**. The fee is a scalar read once per trade (`lib.rs:731`: `let fee_bps = curve.trade_fee_bps;`, and `lib.rs:874` for sells), and `BondingCurve` has no timestamp field. Any decay design is net-new hot-path money code *plus* an account-layout change — on the exact rail where a layout change just cost a full client/program desync.

### 3.2 The arithmetic

The rejected curve was continuous exponential decay, `fee(t) = 2000 × 0.05^(t/600)` bps. This reproduces the operator's own rejection figure exactly (14.83% at 60s), which confirms the formula:

- `ln(0.05) = −2.9957323`
- t=60: `2000 × exp(−0.29957) = 1482.3 bps`

**What an honest buyer pays on a 1 SOL buy:**

| Arrival | Rejected decay | Fee paid | **Recommended flat** | Fee paid |
|---|---|---|---|---|
| 10 s | **19.03%** | 0.1903 SOL | **1.00%** | 0.0100 SOL |
| 60 s | **14.82%** | 0.1482 SOL | **1.00%** | 0.0100 SOL |
| 5 min | **4.47%** | 0.0447 SOL | **1.00%** | 0.0100 SOL |
| 1 hr | 1.00% | 0.0100 SOL | **1.00%** | 0.0100 SOL |

A buyer arriving one minute after launch — an ordinary, honest, enthusiastic user — pays **14.8x** the mature fee. That is the whole objection, and it is correct.

### 3.3 The competitor evidence

The 2026 market has **abandoned** time-decaying opening fees:

- **pump.fun** (volume leader): **flat 1.25%** on the bonding curve (0.95% protocol / 0.30% creator), **no decay**. Market-cap tiering applies only *after* graduation, on PumpSwap pools (1.25% at 0–420 SOL, decaying to 0.30% at 98k+ SOL).
- **LetsBonk**: flat 1%, creator takes 0.10%.
- **flaunch**: fixed-price fair-launch window plus a 0.25%-of-supply per-wallet cap and CAPTCHA. **No fee decay at all.**
- **Meteora's own Rate Limiter** (the newer anti-sniper tool): prices by **trade size**, not time — a 1 SOL buy pays 1%, a 4 SOL buy pays 4%. A small honest buyer pays base fee regardless of arrival time.
- **Clanker v4** is the *only* major venue still shipping fee decay, and it is an **optional MEV module capped at a 120-second window**. The rejected Tegridy proposal used **600 seconds — 5x longer than the largest venue that still ships the mechanism permits.**

Creator shares for calibration: pump.fun 0.30% of 1.25% (24% of fee); LetsBonk 0.10% of 1% (10%); Believe 70/30 creator/platform post-graduation; flaunch 100% to dev+community. **A 50/50 split at 100 bps puts the creator at 50 bps — roughly 1.7x pump.fun's 30 bps in absolute terms, and 50% of fee vs. their 24%.** That is a genuinely competitive creator offer while the buyer pays *less* than pump.fun's 1.25%.

### 3.4 Why not size-based instead

State plainly: **a size-based fee is defeated by order-splitting across wallets.** Splitting 20 SOL into 40 × 0.5 SOL buys pays 1% instead of a capped 10%. The existing `splitting_a_buy_never_beats_one_shot` test (`curve.rs:504`) protects the *curve math*, not the fee. No purely on-chain mechanism stops a determined sniper. pump.fun's revealed answer is the right one: **do not charge honest buyers for a problem you cannot solve.**

### 3.5 Two implementation notes

- **Post-graduation fees are additive, not a split.** In our cp-swap fork, `fees.rs:73` computes `trade_fee_rate + creator_fee_rate`. So pump.fun's mature 0.30% tier is reproducible exactly as `2000` (0.20% LP) + `1000` (0.10% creator) in the 10⁻⁶ denominator.
- **The graduation target is NOT freely choosable.** It is pinned by the virtual reserves through the ±5% continuity band (`curve.rs:49`, `PRICE_CONTINUITY_BAND_BPS = 500`), and `continuity_target()` at `curve.rs:414` already solves for it. **Do not hand-pick a round number** — `curve.rs:769`'s test `the_original_parameters_gapped_badly` records that the original 30 vSOL / 2 SOL parameters opened the pool at ~14% of the curve's final price, a ~7x instant drop.

> **UNKNOWN:** the competitor agent's final finding was truncated mid-sentence ("pump.fun's current bon…"). pump.fun's exact current bonding-curve reserve parameterisation is therefore **not confirmed** by this pass. The agent separately flagged that our `curve.rs` test constants may mis-model it — using `V_TOK = 1_073_000_000_000_000` as the *virtual-only* leg (`curve.rs:450-451`) and adding a 1000T supply on top, giving max reachable ~27.96 SOL, whereas pump.fun's 1073T appears to be the *effective* (virtual + real) opening reserve. **Re-derive our own parameters from `continuity_target()` and do not copy pump.fun's numbers on the strength of this.**

---

## 4. The Meteora retirement

Operator decision: *"0 Meteora — we only want launchers that graduate to US. Any other ones should be retired."*

### 4.1 The rail audit — which rails graduate to us

| Route | Rail | Graduates to | Owned target exists? | Verdict |
|---|---|---|---|---|
| `/solana-launch` | Meteora DBC | Meteora DAMM v2 | **No — architecturally impossible** | **RETIRE** |
| `/curve-launch` | tegridy-launch + cp-swap fork | Our own cp-swap pool | **Yes, this repo** | **KEEP** (ids spent, restart pending) |
| `/launch` | Doppler / Whetstone EVM | Doppler's UniswapV4Migrator *today* | **Yes — written, undeployed** | **KEEP — do NOT retire** |

There is no fourth launcher.

**The EVM rail must NOT be retired, and this is the finding most likely to be got wrong by a literal reading of the operator's instruction.** It graduates externally today *only* because `TEGRIDY_V4_MIGRATOR_ADDRESS` is the zero address (`constants.ts:75`, verified: `0x0000…0000`), and `venue.ts:203-213` branches on that. The Tegridy-owned target is **written and in-repo**: `contracts/src/v4/TegridyLiquidityMigrator.sol` (29,740 bytes, confirmed present) graduates into a canonical V4 pool carrying `TegridyV4Hook`. The gap is **a deploy plus an Airlock `setModuleState(migrator, 4)` — not a missing design.**

Meteora is different **in kind**: its DBC config names DAMM v2 unconditionally, and a venue-owned Solana target would be a new program deploy, not an address flip. It can never graduate to us. That asymmetry is the whole basis of the decision and must be written into `venue.ts`'s header **before** anything is deleted — otherwise the next "retire non-graduating launchers" pass reads `ownership: 'external'` on both rails and deletes the EVM launcher too.

> **That would destroy live mainnet revenue.** `contracts/src/LockerClaimer.sol` (deployed `0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7`, verified 2026-08-01) is the **only** address that can originate `releaseFees()` on the Doppler locker. The locker is pull-based and pays `msg.sender` only, and `RevenueDistributor`'s deployed ABI has no arbitrary-call path — so deleting it strands **the protocol fee line permanently** — every wei that would otherwise reach it, after the 20% referral share that comes off the top and cannot be set to zero.
>
> *(This sentence originally claimed totality over that fee line. `src/lib/docsClaimHonesty.test.ts` caught it on the way in — the referral split contradicts any such claim — and then caught the first correction too, because the correction quoted the offending phrase in order to explain it. Both are the guard working. It is worth recording that it fired twice on a document about honesty.)*

### 4.2 DELETE

Six lib modules forming a closed cluster (delete as a unit):
`dbc.ts`, `dbcClient.ts`, `liveConfig.ts`, `feeSchedule.ts`, `feeCustody.ts`, `submitLaunch.ts` — all under `frontend/src/lib/launcher/solana/`.

Eight tests with their subjects: `dbc.test.ts`, `dbcClient.test.ts`, `liveConfig.test.ts`, `feeSchedule.test.ts`, `feeCustody.test.ts`, `submitLaunch.test.ts`, `submitLaunch.gate.test.ts`, `submitLaunch.custody.test.ts`.

Page, route and script: `frontend/src/pages/SolanaLaunchPage.tsx`; the lazy import and `<Route path="solana-launch">` in `frontend/src/App.tsx`; `frontend/scripts/solana-dbc-operator.mjs`.

Dependency, **last, after the tree is green**: `@meteora-ag/dynamic-bonding-curve-sdk` from `frontend/package.json`. Keep `@solana/web3.js` and the wallet adapters — `SolanaSwapPage` and the curve rail need them.

> **Corrections to the retirement brief, both verified:**
> - **`scripts/verify-dbc-config.mjs` DOES NOT EXIST.** The meteora agent listed it for deletion and flagged the path as unconfirmed; I checked both `frontend/scripts/` and `scripts/` — **absent from both.** It is cited at `docs/TODO_OPERATOR.md:285`, which is itself a stale doc reference to a script that was never committed. Do not try to delete it; do fix the doc.
> - **Retiring DBC frees ZERO Vercel functions.** All 11 are shared infrastructure; none is DBC-specific, and `solrpc.js` is needed by the restarted curve rail. Headroom stays 11/12.
> - **`verify-addresses.mjs` needs no structural change** — check 5b (`:304-364`) scans only `curve/program.ts`, so no DBC literal was ever under drift control.

### 4.3 REWRITE (do not delete)

- **`graduation/venue.ts`** — the honesty spine for *both* rails. Rewrite `resolveSolanaGraduationVenue()` against the own venue, but **report honestly that the rail is not deployed.** Mirror the EVM half's `plannedVenueMigrator`/`configured` split. The tempting shortcut — marking Solana `venue-owned` now that Meteora is gone — would ship a graduation promise the chain cannot keep, the precise failure `venue.ts:10-22` exists to prevent.
- **`graduation/solanaVenueFacts.ts`** — re-exports `MIGRATION_TARGET_LABEL`, `MIGRATED_POOL_FEE_BPS`, `DEFAULT_LIQUIDITY_DISTRIBUTION` from `../solana/dbc` (verified at :8-12), so deleting `dbc.ts` breaks it and transitively breaks `venue.ts`. Re-derive from the curve/cp-swap config. **Its entire purpose is that no disclosure hand-copies a fee number** — if the replacement hardcodes "1%", the retirement reintroduces the drift-into-a-lie failure it was built to prevent.
- **`navConfig.ts`** (:17, :160), **`HomePage.tsx`** (:9, `isSolanaSubmitReady`), **`termsLauncherCoverage.test.ts`** (:12, :65, :67).
- **`towelieKnowledge.ts:243,250-251`** — **highest exposure**: the chatbot currently tells users `/solana-launch` launches on Meteora's bonding curve, in production. Must change in the same commit as the route removal.
- **`TermsPage.tsx`** §2 names Meteora as a binding term.
- **`docs/TODO_OPERATOR.md`** — strike §1.3 (`:238-288`, the now-moot "DBC config v2" work), the roadmap chain at `:896-897`, and the stale three-option paragraph at `:421` that still offers "stay on Meteora DBC."

### 4.4 MOVE, KEEP, and what survives as record

- **MOVE `squads.ts`**, do not delete. Its only importers are DBC code, so it *looks* deletable — but tegridy-launch's `global.fee_recipient` **is** the Squads vault, and the restarted rail needs its `deriveSquadsVaultPda` / `verifySquadsVault` / discriminator-guarded threshold read. **Its only test lives inside `dbcClient.test.ts` (:39-40), which is being deleted — extract those assertions into a standalone test in the SAME commit**, or the guarantee preventing a single-key drain of all Solana fees ships untested.
- **KEEP `metadataUri.ts`** — venue-neutral. Tokens are created `AUTHORITY_IMMUTABLE`, so the URI is permanent and unfixable after launch, equally true on the curve rail. Its only importer is being deleted, leaving it temporarily unimported — **do not let a dead-code sweep remove it.**
- **KEEP the Rust untouched.** `segmented.rs:1-24`'s Meteora references are the **licence-provenance record** establishing the segmented shape came from *public documentation*, not Meteora's non-commercially-licensed source. Note this survives A1 only as history — the file is deleted by the merge, so **preserve that provenance paragraph in `CREATOR_FEE_SPEC.md` or `NOTICE.md` rather than losing it.** A literal "zero Meteora" sweep that discards it deletes the legal defence for the curve: costs nothing to keep, could cost a derivative-work claim to remove.
- **KEEP `indexer-solana` as-is** — it classifies by balance deltas *precisely because* Meteora's IDL is not vendored and its licence forbids forking. DBC ids there are test fixtures and a base58 vector.
- **KEEP both `addresses.json` entries** (`meteora-dbc-program`, `meteora-locker-program`), rewriting each role to say it is a **RETIRED** third-party counterparty, with the retirement date. Deleting them passes CI and erases the record of a rail that really did go live on mainnet — and a retired rail that leaves no trace is how a future session re-adds it.
- **ADD a retirement tripwire** modelled on `spentProgramIds.test.ts` (which is itself untouched by this work — it guards the *own-venue* ids). Same `ASSERTS_LIVE` / `RETRACTS` / `WINDOW` structure so past-tense history stays legal and a present-tense live claim does not.

> **Do not run a regex sweep** deleting any test matching `/meteora|dbc/`. Several honesty suites — Heat gate, birth-record, covenant — mention Meteora only in a fixture string or comment and have nothing to do with the rail.

---

## 5. The restart runbook

**The ordering trap that determines everything:** if `cp_swap_program` is pinned as a compile-time constant in tegridy-launch (recommended, §5 step 0), then **cp-swap's final id must be known before tegridy-launch is built.** Generate both keypairs first. Getting this backwards is another bricked-on-arrival deploy.

```
STEP 0 — TODAY, before any deploy
  Land §2A (A1–A10). Generate both fresh keypairs (O1).
  Set declare_id! ×2 + Anchor.toml ×2 to the fresh ids.
  Set deployer::ID and admin::ID.
  Re-pin EXPECTED_DELTA_SHA256. Get CI green.
  cargo build-sbf  → READ THE LINKER WARNINGS for MigrateToAmm::try_accounts

STEP 1 — Deploy both programs to the fresh ids
  Rehearse on devnet first (deploy-devnet.sh).
  Budget ~9 SOL of fresh rent.

STEP 2 — initialize_global   [tegridy-launch]
  Fund the deploy authority to >= 0.01 SOL FIRST — rent is 5,922,960
  lamports and payer = authority.
  node frontend/scripts/tegridy-launch-operator.mjs init-global ...

STEP 3 — create-amm-config   [cp-swap]   *** MISSED LAST TIME ***
  node frontend/scripts/tegridy-launch-operator.mjs create-amm-config \
      --create-pool-fee 0   ...
  The harness DOES support this (operator.mjs:921; runbook :203-209) and
  enforces the create_pool_fee ceiling itself (:979-1005).
  SET create_pool_fee = 0. We own the AmmConfig; initialize.rs:319 wraps the
  transfer in `if != 0` and skips it entirely. This drops the migration
  reserve requirement from ~0.1922 SOL to the ~0.0422 SOL rent floor AND
  means no third party is paid at migration ("we pay nothing").

STEP 4 — update_global with cp_swap_program + amm_config
  VERIFY BY RE-READING THE ACCOUNT BYTES, not by the transaction succeeding.

STEP 5 — create_permission_pda   [cp-swap admin]  *** NEW PREREQUISITE ***
  Derive [MIGRATION_AUTH_SEED] -> migration authority PDA. Print it.
  Derive ["permission", <that PDA>]. Print it.
  Confirm both derivations agree with what initialize_with_permission will
  look up at [PERMISSION_SEED, payer]  (see §2B seed note).
  admin::ID must SIGN and PAY. One account, once, program-wide — not per launch.

STEP 6 — Prove ONE dust launch graduating end-to-end
  Prepend setComputeUnitLimit — migration measured 264,128 CU against a
  200,000 default. A missing limit fails as "Program failed to complete",
  which is ALSO what a stack-frame overflow looks like. Measure both;
  do not infer one from the other.

STEP 7 — ONLY THEN rotate global.authority to the proven Squads vault
  Rotating earlier makes the 2-of-2 a prerequisite for the first graduation.
  If member B has never signed, that freezes the protocol irreversibly
  with no upgrade escape.
```

**Recommended in step 0, unfixed on both trunk and the branch:** pin `cp_swap_program` so a single hot key cannot repoint the graduation venue. Today whoever holds `global.authority` can call `update_global --cp-swap-program <their program>` in one transaction with no timelock and no second signature; `migrate_to_amm` is permissionless and hands the configured program signer authority over the account holding **the entire raise**. This is the one finding where the whole raise is the loss, and it is redeploy-only — adding it later needs an upgrade.

**Also worth adding before step 6:** the operator harness has **no `migrate` command** (dispatch at `operator.mjs:1191-1205`: `status`, `derive`, `check-config`, `init-global`, `update-global`, `create-amm-config`, `help`). Without it, the first mainnet graduation gets hand-built — and there are now *three* distinct ways that failure will be misread as a program bug (missing compute limit, stack frame, missing permission PDA).

**Numbers to write down rather than leave implicit:**
- Migration pays its permissionless caller **~1,148,400 lamports** of the traders' reserve per graduation (`auth_lp` closes to `payer` on trunk *and* the branch). Deliberate incentive — document it, do not silently repoint it.
- Every graduated launch buries **7,913,520 lamports** of creator-paid rent with no close path. A `reclaim_graduated_rent` instruction is additive and can follow — **but under a tight or burned upgrade authority, "later" may mean never.** Decide consciously now.
- `create_pool_fee` ceiling: **208,734,160 lamports**, above which every already-created curve becomes unmigratable (reserve is snapshotted; the fee is not).

---

## 6. Open questions for the operator

Only things genuinely nobody else can answer.

1. **Has Squads member B demonstrably signed and executed a real mainnet proposal?** The ledger's first HIGH is that naming an unprovable authority is exactly how the old rail died. Both the `admin::ID` choice and the step-7 rotation hang on this. *(Reminder from the #281 incident: the multisig ACCOUNT `EVGSnRZ…` can never sign; only the VAULT PDA `GRMtSxgs…` can.)*

2. **Where are the two fresh keypairs generated and held, and do you keep or burn the upgrade authority after graduation is proven?** This gates step 0 and determines which deferred items are genuinely deferrable — particularly the buried-rent reclaim, which needs a *new instruction*, not a patch.

3. **Should creator fees be turned ON after graduation, or only left available?** The branch deliberately ships `creator_fee_rate` at zero on the AmmConfig. Enabling it is a separate cp-swap admin decision nobody has recorded a position on. Note the asymmetry: pools graduated under the *old* path are creator-fee-less **forever** with no remediation, since `complete` is one-way.

4. **Are `TegridyLiquidityMigrator` and `TegridyFeeLocker` deployed on mainnet, and has Whetstone been asked to whitelist the migrator?** `addresses.json` has **no entry for either**, which reads as "written but never deployed" — consistent with `TEGRIDY_V4_MIGRATOR_ADDRESS` still being zero. **UNKNOWN: no chain read was performed (read-only, no RPC).** This decides whether "only launchers that graduate to US" currently has **any** satisfied member.

5. **With Meteora gone and the curve program not yet redeployed, the protocol has zero live launch surface. Should `/solana-launch` 404, or render a retirement notice pointing at `/curve-launch`?** A silent 404 on a route that was in the nav is how a user concludes the product died.

6. **Does anything OUTSIDE this repo decode the 716-byte `BondingCurve` layout** — indexer, keeper, Dune queries, fact sheets? The merge breaks that layout permanently. Only `frontend/` and `solana/` were audited.

7. **The live Meteora DBC partner config (mainnet, 2026-08-01, opening at a 99% fee) is immutable and will outlive this retirement. Any residual partner fees to claim before the tooling is deleted, or is the balance confirmed zero?** Once `dbcClient.ts` and `solana-dbc-operator.mjs` are gone, `claimPartnerFees` has no caller in the repo.

8. **Was the ~8.47 SOL of reclaimed rent from the 2026-08-13 close ever recovered?** The ledger records it went to individual multisig member `5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz` rather than to the vault. `BATTLE_PLAN` #4 budgets ~9 SOL of fresh rent for this redeploy.

---

## Appendix — UNKNOWNs, stated plainly

- **Checklist item 6 is UNVERIFIED.** I did not build. `cargo build-sbf` and `cargo test` were not run (read-only mandate). The `MigrateToAmm::try_accounts` stack frame, the claimed 40 passing lib tests, and the 264,128 CU migration budget are all **UNKNOWN until A10 runs.** The compute budget and TypeScript integration tests cannot be settled on this box at all — `MIGRATE_DESIGN.md` records the local machine cannot run a validator (os error 1314; `openssl-sys` fails for `solana-program-test` and `litesvm`), so CI's Ubuntu runner is the gate.
- **The branch's `tests/*.ts` edits were authored without a type-check or a run.** Trunk did not touch those files, so they merge cleanly — but they are the most likely thing to break first.
- **pump.fun's exact current bonding-curve reserve parameterisation is UNKNOWN** (source finding truncated; see §3.5).
- **EVM migrator/fee-locker mainnet deployment status is UNKNOWN** (no chain read performed).
- **Merge tree hash `8324d0d7` reported by the segmented-branch agent is stale.** Today's verified value is `e67d8e3d`. Both are conflict-free; do not gate on the old hash.