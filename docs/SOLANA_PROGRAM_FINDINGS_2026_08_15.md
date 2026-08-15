# Solana launch program — findings ledger

Wave 3, phase 04. The audit machine, pointed at the program for the first time.

6 lanes over `tegridy-launch` and the vendored cp-swap fork diff, then every
critical/high/medium finding handed to an independent verifier told to default to
REFUTED. **43 findings · 0 critical · 9 high · 10 medium · 10 low · 14 info.**
Verify pass: 16 CONFIRMED, 3 REFUTED.

Disposition is one of RESOLVED · ACCEPTED · SCHEDULED · MOOT, per the wave.

---

## ⚠ Read this before the findings

**Both programs were CLOSED on mainnet.** Verified by me on two independent RPCs
on 2026-08-15: the ProgramData accounts for `tegridy-launch`
(`6vV7DqMyGwpM18rf2Lkefa1U9YfKquZjvwA61ch3FsnS`) and the cp-swap fork
(`6TnZb1GTHhPAYsrbtwfELkqQrXyqCfv7V6s27RJKXHAF`) both return **null with 0 lamports**,
while the program stubs remain executable-flagged at 1,141,440 lamports each.

A program whose ProgramData is closed cannot execute. On Solana that address is also
not reusable, so these two program IDs are spent. This is consistent with the
close runbook that was on file to reclaim ~8.47 SOL of rent — and the reclaimed rent
is not in the Squads vault (0.001 SOL), the multisig (0.00434), the deploy authority
(0), or member A (0.0221), so it was swept elsewhere.

**Consequence for Wave 3.** Phase 02 is premised on "your upgrade authority sits at
the multisig, so the live program can still learn". There is no live program to
upgrade. Every finding below marked *reachable on deployed binary: yes* was true of
the binary that was running; none of them can be exploited now, because nothing can
be called. They are therefore **findings about the SOURCE**, and they matter exactly
as much as the source matters — which is a lot, if this rail is ever redeployed.

The `global` PDA still holds 5,922,960 lamports of rent, owned by a program that
cannot run.

---


## HIGH — 9

### The documented next step — `update-global --new-authority <squads-vault>` — would freeze tegridy-launch's admin exactly the way cp-swap is already frozen, irreversibly and with no upgrade escape

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:571-574 (handler) and :1598-1608 (UpdateGlobal accounts); frontend/scripts/addresses.json (entry `tegridy-launch-global`); frontend/scripts/tegridy-launch-operator.mjs:753 (`newAuthority: optionalPubkeyFlag(flags, 'new-authority')`)`  
lane: authority-and-pdas · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Operator follows the registry note and runs `update-global --new-authority GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`. The instruction succeeds; `global.authority` becomes the 2-of-2 vault. Because member B has never signed and has no keyfile, no vault transaction can ever reach threshold. `global.cp_swap_program` and `global.amm_config` are still `Pubkey::default()` (which is why `migrate_to_amm` returns AmmNotConfigured/6015), and `update_global` is the ONLY instruction that can set them — so graduation becomes permanently impossible even after cp-swap is upgraded. `paused` can never be toggled, `fee_recipient` can never be rotated, and `set_curve_segments` (lib.rs:1613-1622, same `has_

**Recommendation:** Do not execute the `--new-authority` rotation until Squads member B has demonstrably signed a real proposal on mainnet. Sequence it LAST, after `--cp-swap-program` and `--amm-config` are set and a graduation has been proven end-to-end. Add a pre-flight to `cmdUpdateGlobal` that refuses `--new-authority` pointing at a Squads multisig ACCOUNT (Squads-program-owned, non-zero data) outright, and requires an explicit `--i-have-proven-the-new-authority-can-sign` flag for any PDA destination.

### `global.authority` is one operator-held key that can repoint the graduation venue, and `migrate_to_amm` hands the configured program signer authority over the account holding the entire raise

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:557-564 (setters), :1038-1049 (the only venue check), :1365-1382 (the invoke_signed)`  
lane: authority-and-pdas · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Whoever holds that one keyfile calls `update_global --cp-swap-program <their program> --amm-config <any account they own> --fee-recipient <their wallet>` in a single transaction. There is no timelock and no second signature. Every curve that subsequently reaches its graduation target can then be migrated by ANY caller (`migrate_to_amm` is permissionless by design, lib.rs:1024-1030), and the callee — holding `migration_authority`'s signer privilege — moves the WSOL deposit, the token leg and the lamport reserve out and returns Ok. The post-CPI assertions are satisfiable: `auth_lp` is an unconstrained `UncheckedAccount` (lib.rs:1803-1804), so the caller supplies a pre-created zero-balance ATA 

**Recommendation:** Do not leave a single hot key as `global.authority` once real raises exist — but see the previous finding: rotating to the current Squads vault trades this risk for a permanent freeze. The clean order is (a) prove the vault can sign, (b) set `cp_swap_program`/`amm_config` and graduate one launch, (c) THEN rotate. Independently, consider pinning `cp_swap_program` to a compile-time constant (it is not a value that should be governance-mutable once set) or requiring `cp_swap_program` to be an already-executable BPF program owned by the upgradeable loader — cheap, and it rules out the arbitrary-callee case.

### `decodeBondingCurve` uses BONDING_CURVE_SIZE = 162; the deployed program writes 716-byte curve accounts, so every launch reads back as `bad-length` — and the same constant understates the curve's rent floor by 3,855,840 lamports

`frontend/src/lib/launcher/solana/curve/program.ts:342 (also :494-520), frontend/src/lib/launcher/solana/curve/read.ts:233 and :509-511`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** (A) Read path, live today. `readCurve` (read.ts:214) calls `decodeBondingCurve` on a 716-byte account, gets `{ok:false, reason:'bad-length'}`, returns `{kind:'undecodable'}`; `classifyLaunch` (read.ts:341-349) turns that into `{kind:'unreadable', detail:'curve account is bad-length'}`. Every launch on the venue's own rail renders as unreadable — no phase, no progress, no quote. It fails CLOSED, so nothing is misreported as a number, but the surface is dead.

(B) Rent path, silently wrong in the permissive direction. `readRentFloors` (read.ts:233) calls `getMinimumBalanceForRentExemption(162)`, which returns (128+162)*6960 = 2,018,400 lamports. The program uses `Rent::get()?.minimum_balance(c

**Recommendation:** Set `BONDING_CURVE_SIZE = 716`, add the six missing fields to the `BondingCurve` interface, and re-derive every offset (mint 8, creator 40, vsol 72, vtok 80, rsol 88, rtok 96, trade_fee_bps 104, creator_fee_share_bps 112, graduation_target 120, migration_reserve 128, mode 136, sqrt_price_x64 137, sqrt_price_start_x64 153, segment_count 169, segments 170..682, complete 682, pool 683, bump 715). Then make the test prove the fix instead of the fixture: assert against a base64 blob captured from the live curve account, not against a locally-encoded struct. Client-side only — no program upgrade needed.

### `tradeKeys` omits the `creator` account, so every `buy`/`sell` the client can build has 9 of the program's 10 Trade accounts and cannot succeed

`frontend/src/lib/launcher/solana/curve/ix.ts:221-233 (used by `buyIx` :247-263 and `sellIx` :272-288)`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Build a buy with `buyIx({trader, mint, feeRecipient}, 100_000_000n, minOut)` and send it. Anchor matches accounts POSITIONALLY, so slot 5 (`creator`) receives `curveVaultPda(mint)`. The constraint `address = curve.creator` fails and the transaction reverts with `CreatorMismatch`; if the trailing shift is caught first it reverts with `NotEnoughAccountKeys` instead, since 9 accounts were supplied for 10 declared fields. Either way the trade never lands and the user pays a failed-transaction fee.

No funds are at risk today: nothing on a shipped surface calls these builders. `rpc.ts:263-294` declares `CurveWriteClient` as an interface with no implementation, and `CurveLaunchPage.tsx:893` hardco

**Recommendation:** Add `creator: PublicKey` to `TradeAccounts` (it must be read off the decoded curve — `curve.creator` — never guessed) and insert `acc(a.creator, false, true)` between the curve and the vault. Rewrite the test to assert TEN rows and to name `creator` explicitly, and refresh the stale `lib.rs:` line references in the surrounding comments. Client-side only — no program upgrade needed.

### `migrateToAmmIx` omits `fee_recipient`, shifting all 21 remaining accounts by one position

`frontend/src/lib/launcher/solana/curve/ix.ts:366-410 (`MigrateAccounts` interface at :335-348)`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Call `migrateToAmmIx({payer, launchMint, ammConfig, createPoolFee})` and send it with the required `setComputeUnitLimit(400_000)`. The `launch_mint` pubkey lands in the `fee_recipient` slot, so `address = global.fee_recipient` fails and the transaction reverts with `Unauthorized` (6008) during ACCOUNT VALIDATION — before the handler body runs. Note the diagnostic consequence: this builder can never produce the `AmmNotConfigured` (6015) that the operator ledger records as migration's current blocker, because 6015 is raised inside the handler (lib.rs) after validation passes. Anyone debugging graduation with this builder will chase the wrong error, and after the AmmConfig is finally created th

**Recommendation:** Add `feeRecipient: PublicKey` to `MigrateAccounts` (read it from `global.fee_recipient`, do not default it) and insert `acc(accounts.feeRecipient, false, true)` at index 2. Re-index every assertion in ix.test.ts and assert `ix.keys.length === 24`, so a future omission fails loudly. Client-side only.

### The forked cp-swap program was CLOSED on mainnet 2026-08-13; its ProgramData is deleted and program id 3ZvZXEBr… can never be redeployed

`solana/tegridy-amm/programs/cp-swap/src/lib.rs:44 (declare_id) — on-chain state, mainnet-beta`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Any invocation of 3ZvZXEBr… fails to load. `migrate_to_amm` cannot graduate into it; the AmmConfig can never be created there; the #281 `admin::ID` fix can never be applied to this program id because upgrading requires a ProgramData account that no longer exists and redeploying returns AccountAlreadyInitialized. The only path is a NEW program id, which forces (a) a new `declare_id!` at lib.rs:44, (b) re-derivation of every PDA the fork owns — the AUTH_SEED authority PDA, amm_config, pool_state, vaults, observation — and (c) a rebuild + redeploy of tegridy-launch, which was closed in the same transaction, so `global.cp_swap_program` must be repointed too. The gitignored keypair for 3ZvZXEBr… 

**Recommendation:** Treat the whole lane's "reachable on deployed binary" column as no. Before anything else, correct frontend/scripts/addresses.json (the cp-swap-program and tegridy-launch-program entries both still read "live, DEPLOYED to mainnet 2026-08-08") and docs/ISLAND_WAVE_THREE_STATUS.md / docs/OPERATOR_PACKET_2026_08_12.md. Note for custody: the reclaimed 8.467 SOL went to multisig member 5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz, an individual member key, not to the vault.

### Segmented mode bypasses the graduation-price continuity band entirely — a published curve shape can list a launch at 35% or 122% of its final curve price with nothing rejecting it

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:152-184 (check_launch_economics), :598-623 (set_curve_segments), :687-707 (create_launch Segmented arm)`  
lane: curve-math · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Live global as deployed: Vt = 1_073_000_000_000_000, S = 1_000_000_000_000_000, T = 11_621_942_308, R = 250_000_000. The operator signs `set_curve_segments` with a single well-formed segment, then a creator opens a launch with `mode = 1`. I replayed the exact buy loop (`lamports_until_target` cap -> `quote_buy_for` Segmented -> the partial-fill and real-token guards) against three tables that all return `Ok` from `validate_segments` and all reach `real_sol_reserves == T + R == 11_871_942_308`:

  sqrt 58_600_000_000_000_000 -> 117_200_000_000_000_000 (L = 3_735_...e12): issues 588_214_863_963_909 tokens, pool gets 411_785_136_036_091 against 11.62 SOL -> LISTING RATIO 6991 bps (a 30% instant

**Recommendation:** Until this is fixed, treat segmented mode as unshippable and do not call `set_curve_segments`. `segment_count = 0` is currently the only thing preventing it, and it is one authority signature away. The fix (needs the blocked upgrade): compute the segmented curve's realised end state at config/launch time — total SOL the table absorbs `Σ ceil(L_i·Δ√P_i / 2^64)`, total tokens it issues `Σ floor(L_i·2^64·Δ√P_i/(√P_a·√P_b))` — and gate the resulting listing ratio `(T / (S − issued)) / (√P_end/2^64)^2` against the SAME ±5% band, from the same shared helper, so the two modes cannot diverge again.

### Segmented mode has no reachability or supply gate; a well-formed segment table can permanently brick every launch created under it — one variant bricks on the very first buy

`solana/tegridy-amm/programs/tegridy-launch/src/segmented.rs:145-173 (validate_segments), :209-211 (sol_to_cross); lib.rs:288-291, :760-763`  
lane: curve-math · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Replaying the real buy loop against the live global (T+R = 11_871_942_308, S = 1e15), each of these tables returns `Ok` from `validate_segments` and then dead-ends:

  (a) start 20_000_000_000_000_000, one segment up 30_000_000_000_000_000 L 500_000_000_000 — capacity 0.2475 SOL. 1 buy accepted, then every buy reverts InsufficientLiquidity (lib.rs:288). real_sol 247_500_000 of 11_871_942_308; `migrate_to_amm` reverts NotReadyToGraduate forever.
  (b) start 20_000_000_000_000_000, segments (4e16, L 1.5e12) (7e16, L 3e12) (1e17, L 6e12) — issues more than S. 14 buys accepted, then every buy reverts InsufficientLiquidity (lib.rs:760). real_sol 3_465_000_000 of 11_871_942_308; permanently stuck.

**Recommendation:** Extend `validate_segments` (or a new economics helper called from BOTH `set_curve_segments` and `create_launch`) to require, at config time: (i) `Σ get_delta_amount_1_unsigned(lower_i, upper_i, L_i, true)` succeeds for every segment AND sums to more than `graduation_target + migration_reserve`; (ii) `Σ get_delta_amount_0_unsigned(...)` is strictly less than `token_total_supply`. Case (c) is caught for free by (i), because the same call that overflows on the trade path is the one being summed.

### Graduation needs an `update_global` step nobody has recorded, and the only key that can do it is a single wallet that does not exist on chain

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1038-1041, :1599-1608 (live account 7hrjMjYxoMKxrBvNkHYfyfJfFPxHi2ovXNLhownm1B6e)`  
lane: migration-and-graduation · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** The operator completes the known blocker - a cp-swap program upgrade to fix `admin::ID`, then `create_amm_config` - and `migrate_to_amm` STILL returns 6015 AmmNotConfigured, because `global.cp_swap_program` and `global.amm_config` are both still `Pubkey::default()` on the live config. That is a second, separately-signed step (`update_global(new_cp_swap_program, new_amm_config)`) that the brief, the live state, and MAINNET_RUNBOOK's framing all collapse into 'the AmmConfig does not exist'. Worse: the only signer for that step is `global.authority` = Dcjink4RG..., a single non-multisig key. If that keypair is lost or compromised, `cp_swap_program`/`amm_config` can never be set, `global.authori

**Recommendation:** Treat `update_global` as a first-class step in the graduation runbook, immediately after `create_amm_config`, and verify it by re-reading offsets 128 and 160 of 7hrjMjYxoMKxrBvNkHYfyfJfFPxHi2ovXNLhownm1B6e rather than by the transaction succeeding. Separately: rotate `global.authority` to the Squads vault GRMtSxgs... (a plain `update_global(new_authority)`) as soon as the AMM addresses are set - note `UpdateGlobal.authority` is NOT `mut`, so a zero-lamport authority can still sign with a separate fee payer, which is why nothing has failed loudly yet. Do NOT rotate it before setting the AMM addresses, or the 2-of-2 becomes a prerequisite for the very first graduation.


## MEDIUM — 10

### The protocol fee leg has no rent-band fold, unlike the creator leg — a `fee_recipient` at 0 lamports reverts every buy AND sell below ~0.171 SOL, including the holders' only exit

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:802-813 (buy) and :955-967 (sell); guard that exists only for the creator at :215-238`  
lane: authority-and-pdas · confidence: proven · verify: **CONFIRMED**  
**Disposition: MOOT (program closed)**

**Failure:** Two live routes. (a) Operator runs `update-global --fee-recipient <fresh address>` — an ordinary treasury rotation. The next buy or sell smaller than ~0.1713 SOL fails with `InsufficientFundsForRent`, which is not one of the program's error codes and will read as an RPC/wallet fault. Sells are supposed to be unblockable (design note 2, lib.rs:867-868); they are not. Unbricking requires someone to airdrop ≥ 890,880 lamports to that address. (b) The current recipient — Squads vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` — holds 0.001 SOL (MAINNET_RUNBOOK.md:56), which is 1,000,000 lamports against a 890,880 floor: only 109,120 lamports of headroom. Any operation that sweeps that vault 

**Recommendation:** Apply the same fold on the protocol leg that the creator leg already gets: if `fee_recipient.lamports() + protocol_pay < Rent::minimum_balance(fee_recipient.data_len())`, add `protocol_pay` to `lamports_to_curve` on a buy / leave it in the curve on a sell rather than reverting the trade. That keeps the path total-conserving and preserves the exit. Interim, operationally: never point `fee_recipient` at an unfunded address, and never sweep the vault below 890,880 lamports.

### cp-swap's source still tells the operator to bake the Squads MULTISIG into `admin::ID` — the exact instruction that bricked graduation on 2026-08-08 — and still claims the mainnet arms are fail-closed sentinels when they are real keys

`solana/tegridy-amm/programs/cp-swap/src/lib.rs:33-40 and :72-75; solana/tegridy-amm/programs/cp-swap/src/instructions/admin/create_support_mint_associated.rs:7-11; solana/tegridy-amm/TEGRIDY_FORK.md:31 and :66`  
lane: authority-and-pdas · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** The cp-swap upgrade is unblocked and an operator rebuilds. They open lib.rs, read the ⚠️ OPERATOR line at the top of the file (the conventional place for build instructions), and set `admin::ID` to `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK` again. The build reproduces, the sha256 matches, `verify-program-constants` reports the multisig PRESENT and `Dcjink4RG…` ABSENT — but only if someone runs it and reads it. `create_amm_config` is uncallable a second time and the fix is a third upgrade through the same 2-of-2. This has already happened once with exactly this text on the page.

**Recommendation:** Delete the two stale ⚠️ OPERATOR lines (cp-swap/src/lib.rs:38-40, create_support_mint_associated.rs:11) and the false fail-closed paragraph (lib.rs:33-37); replace with a single line pointing at the corrected note below and at MAINNET_RUNBOOK §2. Fix TEGRIDY_FORK.md:31 and :66 the same way, and while there, TEGRIDY_FORK.md:11 still reads "Status: Phase 0 … NOT ON MAINNET. Holds no real funds" for a program that has been live since 2026-08-08. Note the diff-guard cannot catch any of this: the delta is hashed, so a comment change just needs the hash re-pinned.

### The pre-submit fee-custody check reads `leftover_receiver`, not `fee_claimer` — the venue's headline Solana guarantee is verified against the wrong 32 bytes

`frontend/src/lib/launcher/solana/liveConfig.ts:68-76, consumed by frontend/src/lib/launcher/solana/feeCustody.ts:96-100 and gated on at frontend/src/lib/launcher/solana/submitLaunch.ts:242`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** `LIVE_DBC_CONFIG` is `import.meta.env.VITE_SOLANA_DBC_CONFIG` (dbc.ts:106-107) — a build-time environment variable, and the only input that names which config public launches go against. Point it at a PoolConfig whose `leftover_receiver` (offset 72) is GRMtSxgseKdes… but whose `fee_claimer` (offset 40) is a single private key. `readFeeClaimerOnChain` returns the vault, `assertFeeCustody` (submitLaunch.ts:242) returns clean, and every token launched through the public button accrues its partner trading fees to that key — while the one control that exists to make that impossible reports "verified". `leftover_receiver` only ever receives leftover base tokens after migration, so the attacker giv

**Recommendation:** Split the constant: `feeClaimer: 40` and add `leftoverReceiver: 72`. Have `readFeeClaimerOnChain` read 40. Correct the layout table in the liveConfig.ts header and the provenance sentence at dbc.ts:112-115. Make the regression test non-vacuous — the current fixture cannot distinguish the two fields, so add a synthetic account with fee_claimer != leftover_receiver and assert `assertFeeCustody` refuses when only offset 72 matches. Client-side only.

### registry-onchain CI cannot detect the closure: `expect: executable` reads only the 36-byte Program account, which still reports executable:true after a close

`frontend/scripts/verify-addresses.mjs:410 and frontend/scripts/addresses.json:65-70`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Both of the venue's mainnet programs were deleted on 2026-08-13. The one automated job whose stated purpose is catching registry-vs-chain drift has been green across that event and remains green, reporting the programs as live. An operator relying on it — as the workflow's own comments invite — has no signal that the rail is gone. This is the same failure class as the `!e.status?.startsWith('live')` bug the file's own comment at lines 393-400 documents: a check that passes for a reason unrelated to what it claims to verify.

**Recommendation:** For `expect.type === 'executable'`, do not stop at the program account. Parse the 36-byte payload (u32 enum 2 + 32-byte pointer), fetch that ProgramData address with a dataSlice of 45 bytes, and fail if it does not exist. As a bonus the same read yields the upgrade authority (bytes 13..45), so the registry can assert custody rather than assert it in prose. A positive control is cheap: the closed 6TnZb1… address is a permanent fixture that must make the check fail.

### No required status checks on trunk — the diff-guard, which is the fork's entire stated security invariant, is advisory

`.github/workflows/solana-ci.yml:55-131 (diff-guard job)`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Any change to programs/cp-swap/src/lib.rs — the file holding the whole `#[program]` dispatcher and all four authority constants — can be merged or pushed with diff-guard red or unrun. The audit scoping the venue offers auditors ("the delta is four constants, mechanically enforced") rests on a check nothing requires.

**Recommendation:** Make diff-guard and clmm-vendor-guard required checks on mvp-launch, and disallow direct pushes. Until then, treat every "the fork is upstream + 4 constants" statement as a claim, not a fact — re-run the diff manually before any redeploy (the exact command is in TEGRIDY_FORK.md and it worked unmodified for me).

### The #281 admin::ID fix downgrades the fork's top-tier fund-touching authority from a vault-capable 2-of-2 to a single operator key that does not exist on chain

`solana/tegridy-amm/programs/cp-swap/src/lib.rs:74-75`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** With a pool funded and an AmmConfig live: compromise or loss of the single Dcjink… keyfile (no seed phrase exists) lets the holder call collect_protocol_fee / collect_fund_fee with their own recipient ATAs and drain every accrued protocol and fund fee, set protocol_owner and fund_owner to themselves via update_config params 3/4, raise the trade fee toward 100%, or pause pools via update_pool_status — and repointing admin::ID away needs another program upgrade because it is a compile-time constant. Loss of the keyfile is equally terminal in the other direction: no one can ever create or update an AmmConfig. Impact today is zero — the AMM has never held a lamport of TVL and the binary is close

**Recommendation:** On the redeploy, set admin::ID to the Squads vault GRMtSxgs… (system-owned, fundable, and proven able to sign loader CPIs) and fund it — it currently holds 0.001 SOL, less than AmmConfig rent. If the operator still wants a single key for the first graduation rehearsal, at minimum fund Dcjink… before building, and treat `update_config` params 3/4 (protocol_owner, fund_owner) as a mandatory same-day follow-up so the fee-collection path is vault-gated even while admin::ID is not.

### Every document governing the fork's mainnet constants describes a source tree that no longer exists — including the runbook step that must be executed for the mandatory redeploy

`solana/tegridy-amm/programs/cp-swap/src/lib.rs:33-40, solana/tegridy-amm/MAINNET_RUNBOOK.md:77-82, scripts/verify-program-constants.mjs:26-28`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** The redeploy at a new program id is now mandatory (finding 1). An operator working MAINNET_RUNBOOK §2 looks for `1111…1111` sentinels to replace, finds real-looking mainnet values already in place, and concludes the step is done. `declare_id!` at lib.rs:44 stays 3ZvZXEBr… while the binary is deployed to the new address; every instruction then fails with Anchor's DeclaredProgramIdMismatch (4100) and the redeploy is bricked on arrival — a second full rent spend plus another Squads ceremony to recover. The runbook's own text points the operator away from this exact line by telling them declare_id is the same throwaway in both arms.

**Recommendation:** Fix the three texts in one change: delete the FAIL-CLOSED paragraph at lib.rs:33-37 (it describes a property the tree no longer has) or restore the property; change lib.rs:38-39 from "admin = Squads MULTISIG" to "admin = the Squads VAULT PDA"; rewrite MAINNET_RUNBOOK §2's preamble to say the non-devnet arms are committed live values and that `declare_id!` MUST change because 3ZvZXEBr… is a closed, permanently unusable address; and drop the stale sentinel claim from verify-program-constants.mjs:26-28. Also stale but harmless: MAINNET_RUNBOOK.md:57 says the fee receiver 2sa31z… "DOES NOT EXIST YET" — it exists (see coverage receipt).

### Off-chain quote path: BONDING_CURVE_SIZE is 162 but a live BondingCurve is 716 bytes, so every real curve fails to decode — the same bug that was found and fixed for GlobalConfig, left in the sibling function

`frontend/src/lib/launcher/solana/curve/program.ts:342 and :494-520`  
lane: curve-math · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** `readCurve` (read.ts:214) -> `decodeBondingCurve` on a real 716-byte curve account returns `{ ok: false, reason: 'bad-length' }`. `CurveLaunchPage.tsx` consumes it through `readLaunch` and then feeds `quoteBuyOnCurve` / `quoteSellOnCurve` (CurveLaunchPage.tsx:32-33, 377-381), so the buy/sell surface for any live launch renders undecodable and no quote is produced. Secondary: `read.ts:233` requests `getMinimumBalanceForRentExemption(BONDING_CURVE_SIZE)` — rent for 162 bytes, understating the curve PDA's real floor by 554·6960 = 3_855_840 lamports, which would make any 'max sell' control it feeds too generous and produce on-chain `InsufficientRentExemptBalance` reverts. It fails closed (a read

**Recommendation:** Set `BONDING_CURVE_SIZE = 716`, add the six missing fields to `decodeBondingCurve` at the correct offsets (creator_fee_share_bps 112, mode 136, sqrt_price_x64 137, sqrt_price_start_x64 153, segment_count 169, segments 170, complete 682, pool 683, bump 715), and — because the tests build their fixtures from the same constant — pin the size against a byte length captured from a real mainnet account rather than re-deriving it from a field list.

### `migrateToAmmIx` omits the `fee_recipient` account - the repo's only committed client builder for migrate_to_amm cannot succeed

`frontend/src/lib/launcher/solana/curve/ix.ts:366-410`  
lane: migration-and-graduation · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** An operator or keeper builds the first mainnet graduation with `migrateToAmmIx`. Anchor's `try_accounts` reaches field 2 (`fee_recipient`) holding `launch_mint`, which the builder passes read-only, and the instruction reverts at account validation - `ConstraintMut` (2000) or `Unauthorized` (6008) depending on Anchor 0.32's constraint emission order, and `NotEnoughAccountKeys` if it got that far. It can never succeed. Because migration is blocked upstream anyway, this surfaces for the first time on the day someone finally unblocks graduation, and the visible symptom is a launch-program error code on the highest-stakes instruction in the system - exactly the shape that gets misdiagnosed as 'th

**Recommendation:** Insert `acc(accounts.feeRecipient, false, true)` at index 2 and add `feeRecipient: PublicKey` to `MigrateAccounts` (it is `global.fee_recipient`, which the client already reads - see `read.ts`; do not derive or default it). Then change `ix.test.ts:180` from a literal 23 to an assertion that pins the INVARIANT rather than the current output: assert the key list equals the account order taken from `tests/tegridy-launch-migration.test.ts:467-492`, and add a `keys.length` check to every builder in the file (`Trade` has none either, per CREATOR_FEE_SPEC.md section 7). Update the 23-row table in docs/OWN_CURVE_FRONTEND_CONTRACT.md:391-418 and its stale `lib.rs:1323-1459` citations in the same chan

### Post-graduation creator fees are structurally impossible, and the pool's `pool_creator` is an address that can never sign again - the Wave 3 phase-02 door is bricked by construction, per pool, at migration

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1299-1382 -> programs/cp-swap/src/instructions/initialize.rs:344-359`  
lane: migration-and-graduation · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Wave 3 phase 02 ships 'creators earn forever'. The operator sets `creator_fee_rate` on the AmmConfig and launches the campaign. Every pool created by the current `migrate_to_amm` accrues exactly zero creator fees, and any pool that somehow did accrue them would have them locked in the vaults forever behind a PDA signature no deployed instruction produces. Today the cost is zero - `getProgramAccounts` on 3ZvZXEBr... returns EMPTY, so no pool has this baked in yet. The moment the first launch graduates, that pool is permanently creator-fee-less and only a new pool (i.e. a new launch) can be fixed. Impact scales with graduated TVL, of which there is currently none.

**Recommendation:** A correct fix must satisfy all five of these; each is a hard requirement I verified in the fork, not a preference.

(1) SWITCH THE CPI to `raydium_cp_swap::initialize_with_permission` - the ONLY entry point that passes `true` for `enable_creator_fee` (initialize_with_permission.rs:357-372, the `true` is line 371) and the only one that lets `creator_fee_on` be chosen. Prefer `CreatorFeeOn::OnlyToken0/1` resolved to the WSOL side so creator fees accrue in SOL, not in the launch token.

(2) BUDGET A PERMISSION PDA. `InitializeWithPermission` requires an already-existing `permission` at `["permission", payer.key()]` (initialize_with_permission.rs:153-161 - it is `Box<Account<Permission>>`, NOT `


## LOW — 10

### The sanctioned TypeScript encoder omits two address-pinned accounts that were added to `Trade` and `MigrateToAmm`; its unit tests pin the stale account counts, so nothing fails

`frontend/src/lib/launcher/solana/curve/ix.ts:221-232 (`tradeKeys`) and :366-405 (`migrateToAmmIx`); frontend/src/lib/launcher/solana/curve/ix.test.ts:181`  
lane: authority-and-pdas · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** An operator or a trading surface starts using `buyIx`/`sellIx` — the encoder MAINNET_RUNBOOK §5 explicitly points at ("The encoder used above lives in frontend/src/lib/launcher/solana/curve/ix.ts, where it is unit-tested byte by byte"). Anchor matches accounts by position, so `curve_vault` arrives where `creator` is expected and the address constraint fails with `CreatorMismatch` (6020) — a code the client's own table cannot name, so the surface renders "unknown error". `migrateToAmmIx` fails the same way with the curve arriving in `fee_recipient`'s slot. Both are hard reverts, not privilege escalations: no funds move.

**Recommendation:** Add `creator` at index 5 of `tradeKeys` (writable, not signer) and `fee_recipient` at index 2 of `migrateToAmmIx` (writable, not signer); both callers must supply `curve.creator` / `global.fee_recipient` read from chain, not derived. Change `ix.test.ts:181` to 24 and add a `keys.length` assertion to the trade builders. Fix `BONDING_CURVE_SIZE` to 716 with the shifted offsets, and add 6020 to `LAUNCH_ERROR_CODES`. Better: assert the account counts against the Rust structs in CI rather than against a literal, since a literal is what let both of these drift.

### `update-global` silently drops a flag whose value is missing or begins with `--`, encoding it as Borsh `None` ("leave unchanged") instead of refusing

`frontend/scripts/tegridy-launch-operator.mjs:155-174 (`parseArgs`), :213-217 (`optionalU64Flag`), :226-240 (`optionalPubkeyFlag`), used at :753-773`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** An operator runs `update-global --amm-config --cp-swap-program 3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y` (value omitted after `--amm-config`, or the two flags typed in that order with the AmmConfig address pasted later). `amm-config` parses to `true` → `None`; `cp-swap-program` is set. The harness builds and prints — and with `--send`, broadcasts — a transaction that sets only `cp_swap_program`. `migrate_to_amm` keeps returning `AmmNotConfigured` (6015) because `isAmmConfigured` (program.ts:535-537) requires BOTH to be non-zero, and the operator has spent a Squads ceremony believing graduation was unblocked. Partially mitigated: the echo loop at :810-812 prints only the defined args, and

**Recommendation:** Add a `VALUE_FLAGS` set alongside `BOOLEAN_FLAGS` and have `parseArgs` throw when a known value-taking flag resolves to `true` — the same fail-closed treatment `requireFlag` already gives the required path. Silently converting a typo into "leave unchanged" is the one behaviour a one-shot ceremony cannot afford. Client-side only.

### The DBC operator harness tells the operator, twice, that a security control it actually enforces does not exist

`frontend/scripts/solana-dbc-operator.mjs:31-32 and :422-426`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** An operator reads the banner, concludes the vault gate is weaker than it is, and either repeats the out-of-band Squads check every ceremony (wasted work) or — worse — stops trusting the gate's `false` results as meaningful and reaches for a bypass. This is the same stale-banner class the repo documents at tegridy-launch-operator.mjs:16-22 and ix.ts:13-16: prose that went on being believed after it stopped being true. No funds are at risk.

**Recommendation:** Rewrite both passages to say what is actually enforced (owner + PDA binding + `Multisig` discriminator + threshold >= 2) and what is not (the member set — two members could be the same person's two keys, which no on-chain read can distinguish). Keep the member-set warning; delete the threshold claim.

### diff-guard does not cover the workspace root Cargo.toml (the only file where [patch] is honored), Cargo.lock, or a build.rs added outside src/

`.github/workflows/solana-ci.yml:96-113`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** A contributor with merge rights (and, per finding 3, no required checks standing in the way) adds programs/cp-swap/build.rs or a root-manifest [patch]. solana-ci prints "✅ Delta from upstream 78f254e matches the pinned hash exactly" and the produced .so is not the audited program. Requires insider or account compromise; no external attacker path.

**Recommendation:** Extend arm 1 to the whole package directory rather than just src/ (`diff -rq "$UP" "$OURS"` with an explicit allowlist for target/), and add the workspace root Cargo.toml and Cargo.lock to the hashed delta in arm 2. Both are one-line changes and cost no wall-clock.

### The fork's on-chain security.txt advertises a source_code URL that 404s — solana/tegridy-amm has never existed on the `main` branch

`solana/tegridy-amm/programs/cp-swap/src/lib.rs:17`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** A researcher or auditor who does the standard thing — pull the deployed program's security.txt and follow source_code to verify the bytecode against source — lands on a 404 and cannot verify anything. The disclosure path itself survives (policy and contacts both resolve), so this costs verifiability rather than the ability to report. It was in the binary that shipped on 2026-08-08 and, unchanged, will ship again on the redeploy.

**Recommendation:** Point source_code at a ref that actually contains the tree — ideally the exact commit the binary is built from (…/tree/<sha>/solana/tegridy-amm), which also makes the pointer immutable and is what a verifier wants. While in the file, act on the TODO the fork itself left at lib.rs:21-22 ("add a dedicated security disclosure email here before mainnet").

### quote_sell returns Ok with lamports_out == 0 while still charging and splitting a fee — the buy path and the segmented sell path both reject this case, the constant-product sell path does not

`solana/tegridy-amm/programs/tegridy-launch/src/curve.rs:232-241`  
lane: curve-math · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** At the live graduation-point reserves (effective sol 41_871_942_308, effective tokens 1_485_242_...e15, fee 100 bps) a sell of 35_472 token base units quotes `gross = 1, fee = 1, lamports_out = 0`. The instruction proceeds: the tokens transfer into `curve_vault`, the curve is debited 1 lamport, `split_fee(1, 4800)` pays 0 to the creator and 1 to `fee_recipient`, and the seller receives nothing. `real_token_reserves` grows by 35_472 for a 1-lamport cost to the curve. Direction of loss is the trader, not the protocol, so this is a consistency defect and a footgun rather than an extraction path; at 1% the window is only `gross == 1`.

**Recommendation:** Add `if lamports_out == 0 { return Err(CurveError::ZeroAmount); }` after the subtraction, matching curve.rs:169-171 and lib.rs:341. Cheap, and it removes an asymmetry that a future reader will otherwise assume is deliberate.

### BOTH audited programs were CLOSED on mainnet 2026-08-13 — the brief's "both programs are deployed" is one day stale; 8,205,840 lamports are now permanently stranded and the deployed bytes are unrecoverable

`on-chain: tx 2xnAE7TkTgMMK5pw38fixwnVGQkW7sKA4FGBv7fHQwbaVdufcWosuaLA1EU8NyPHdioNadg5tvuuAzKc9iXjn5DP (slot 438936987) · repo pin: solana/tegridy-amm/Anchor.toml:20,23`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Three concrete consequences. (1) The global PDA's 5,922,960 lamports plus the two 1,141,440-lamport program accounts — 8,205,840 lamports total (0.00821 SOL) — are stranded: the PDA's owning program can no longer execute, and an upgradeable program id that has been closed cannot be redeployed (`solana program deploy --program-id <closed>` rejects it), so nothing can ever sign for or close that PDA. (2) Every other finding in this report, and in the rest of this audit campaign, is source-only: there is no deployed binary for any of them to be reachable on. (3) The verification technique the brief prescribes for baked `pubkey!()` constants — "searching the binary for the raw 32 bytes" — is now

**Recommendation:** Correct the ledger: these are not live programs. Before any redeploy, generate NEW program keypairs (the old ids are retired), and note that the 8,205,840 lamports do not come back. Also record that the pre-close bytes are gone, so the only remaining evidence of what constants shipped is the git history plus the close tx's absence of any upgrade after PR #281.

### The protocol fee leg has no rent-band fold — the symmetric hazard that was rated HIGH and fixed for the creator leg is still open for `fee_recipient`

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:802-813 (buy) and lib.rs:955-967 (sell), against the fold at lib.rs:215-238`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Set `global.fee_recipient`'s balance to exactly 0 (Uninitialized — the only other reachable state, since the SVM rejects a System withdrawal that would leave it strictly between 1 and 890,879). Now submit any trade. With the live config (trade_fee_bps = 100, creator_fee_share_bps = 4800) the protocol leg is fee - floor(fee*0.48) ~= 0.52 * fee = 0.0052 * trade. Crediting a 0-lamport account less than 890,880 is an Uninitialized -> RentPaying transition, which `transition_allowed` rejects, so the runtime fails the WHOLE transaction with InsufficientFundsForRent. Threshold: protocol_pay >= 890,880 needs a trade of >= 890,880 / 0.0052 ~= 171,323,100 lamports ~= 0.1714 SOL. So every buy and every

**Recommendation:** Either (a) apply the same deliverability check to the protocol leg — but note the fold has nowhere to go, so the honest fix is to SKIP the protocol credit when it would land in the band and let the trader keep it, or accrue it on the curve; or (b) if you accept the risk, make it an operational invariant instead: never let the treasury vault drop below 890,880 + margin, and say so in MAINNET_RUNBOOK. 109,120 lamports of headroom on the account that gates all trading is thin either way.

### The cp-swap admin can revert every graduation by raising `create_pool_fee`, and already-created curves cannot be retuned because the reserve is snapshotted

`solana/tegridy-amm/programs/cp-swap/src/instructions/admin/update_config.rs:32 and programs/tegridy-launch/src/lib.rs:671`  
lane: migration-and-graduation · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** With the runbook's suggested `--create-pool-fee 150000000` there is 57.8M lamports of slack, so this is not live today. But `update_amm_config(param = 5, value = 207_843_281)` - one admin transaction, no validation - makes `migrate_to_amm` revert for EVERY curve created under the current global, inside cp-swap's native fee transfer, i.e. after roughly 250k CU has been spent. Raising `global.migration_reserve_lamports` afterwards does not rescue those curves; only launches created later pick it up. Reversible (lower the fee again). Both sides are the same key (`admin::ID` = `global.authority` = Dcjink4RG...), so this is a self-inflicted footgun and a key-compromise amplifier rather than an ex

**Recommendation:** Put the ceiling in the runbook next to the `create-amm-config` command as a hard number - `create_pool_fee <= global.migration_reserve_lamports - 42,156,720`, today 207,843,280 - and read the live `global` for the reserve rather than trusting the document (the operator harness already refuses on this ground for `create-amm-config`; extend the same guard to any future `update-amm-config` command, which does not exist yet). If you want it enforced on chain, `migrate_to_amm` could deserialize `amm_config.create_pool_fee` and fail early with `MigrationReserveTooLow` instead of reverting deep inside the CPI - cheap, and it turns a confusing mid-CPI failure into a named one.

### An underfunded curve topped up by a donation reverts with `Overflow` (6000), not with a graduation error, and the donation is permanently stranded

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1053-1081 and :1530-1533`  
lane: migration-and-graduation · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** A curve sits at `real_sol_reserves == graduation_target` with the 0.25 SOL reserve not yet raised. Anyone donates 250,000,000 lamports to the curve PDA. `NotReadyToGraduate` passes (target met) and `MigrationReserveTooLow` passes (the balance check now sees target + reserve), so migration runs the ATA creations, the manual lamport move, the barrier, the WSOL wrap, the vault transfer and cp-swap's whole 20-account `initialize` - roughly 250k CU - and then reverts at lib.rs:1533 with error 6000 'Arithmetic overflow'. Atomic, so no half-migrated state, and no loss beyond the donor's own 0.25 SOL, which is stranded: `sell` only pays out up to `real_sol_reserves` (lib.rs:882-885) and a `complete`

**Recommendation:** Move the real gate forward: replace lib.rs:1053-1056 with `require!(curve.real_sol_reserves >= curve.graduation_target_lamports.checked_add(curve.migration_reserve_lamports)?, LaunchError::NotReadyToGraduate)`. That makes the subtraction at :1533 unreachable-by-construction, keeps the lamport-balance check as the second independent guard it was meant to be, and gives keepers one honest error code. It costs nothing - `buy` already caps the raise at exactly `target + reserve` (proven in the coverage receipt), so no legitimate curve is affected.


## INFO — 14

### CORRECTION: `deployer::ID` being unfunded does not block tegridy-launch — `initialize_global` is permanently spent, and `update_global` needs a signature, not a balance

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1578-1608; frontend/scripts/addresses.json (entry `deploy-authority`); frontend/scripts/tegridy-launch-operator.mjs:780-830`  
lane: authority-and-pdas · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Not a vulnerability — a mis-scoped blocker. The risk it creates is planning: the ledger currently reads as though setting `cp_swap_program`/`amm_config` waits on funding Dcjink, when it waits only on possessing its keyfile. Conversely, if the keyfile is lost, funding it changes nothing and the launch program's admin is gone with no upgrade escape (see finding 1).

**Recommendation:** Split the registry note into the two claims it is currently merging: `deployer::ID` (tegridy-launch) — spent, funding irrelevant, keyfile custody is what matters; `admin::ID` (cp-swap, post-upgrade) — must be funded before `create_amm_config`. Teach `cmdUpdateGlobal` a `--fee-payer` so an unfunded authority can still sign.

### `initialize_global` accepts `Pubkey::default()` as `fee_recipient` where `update_global` rejects it

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1584-1586 and :441; contrast :575-578`  
lane: authority-and-pdas · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** An `initialize_global` naming the System Program as `fee_recipient` would have succeeded and burned every protocol fee to a rent-exempt executable until an `update_global` fixed it. Not reachable now: `global` is initialized and `initialize_global` is `init`-gated, so this is a source-only defect that matters only to a future redeploy at a fresh program id.

**Recommendation:** Add `constraint = fee_recipient.key() != Pubkey::default()` to the `InitializeGlobal` account, so the two paths validate the same field identically — the same reasoning that produced `check_launch_economics` as one shared helper (lib.rs:146-151).

### After migration the curve PDA and its token vault are unclosable, so their rent is permanently stranded and any tokens donated to the vault are unrecoverable

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1445-1460 and :1520-1536; state.rs:176-246`  
lane: authority-and-pdas · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** Per graduated launch, roughly 5,874,240 lamports of `BondingCurve` rent (716 bytes) plus 2,039,280 of vault rent (165 bytes) ≈ 0.0079 SOL, paid by the creator at `create_launch`, is locked forever. Plus any launch tokens an attacker donated to `auth_token` pre-migration, which the drain-before-close step deliberately parks in the vault. Small and by design-consequence rather than by bug; recorded because it is an authority-reachability fact (no key exists that can ever recover it) and because rent recovery is an active operator concern.

**Recommendation:** Accept and document, or add a post-migration `close_curve` gated on `complete == true` that closes the vault (it is empty of value once cp-swap has pulled the deposit — the residual push could go to the fee recipient's ATA instead) and then the curve, refunding to `global.fee_recipient`. Note that adding accounts to `MigrateToAmm` is constrained by the 4 KB SBF frame (solana-ci.yml records one `seeds` constraint on `pool_state` pushing `try_accounts` to 4,224 bytes), so a separate instruction is the safer shape.

### Client surfaces still state the program is not deployed, and the instruction builders' `lib.rs:` line citations point at the wrong code

`frontend/src/pages/CurveLaunchPage.tsx:459-461, frontend/src/lib/launcher/solana/curve/program.ts:40-41, frontend/src/lib/launcher/solana/curve/read.ts:119-121, frontend/src/lib/launcher/solana/curve/ix.ts:206/236/290/333`  
lane: client-and-operator · confidence: proven  
**Disposition: MOOT (program closed)**

**Failure:** A visitor to the live curve page is told the venue's own mainnet program does not exist. An engineer following ix.ts's citation to check the Trade account list lands ~390 lines short of it, in the middle of a different context, and confirms nothing. Neither costs money; both are the stale-prose failure mode this codebase has now shipped four separate times (ix.ts:13-16, read.ts:16-21, program.ts:3-9 and tegridy-launch-operator.mjs:16-22 each document a prior instance).

**Recommendation:** Fix the page copy to describe the real state ("the program is live; this page has no signing path yet") and correct the two stale doc comments. For the line citations, prefer naming the symbol (`Trade`, `MigrateToAmm`) over a line range — a range in a 1,904-line file is guaranteed to rot, and here it rotted in the same direction as the bug.

### verify-program-constants' cp-swap roster pins the Squads multisig as REQUIRED-present, which will fail a future correct build

`scripts/verify-program-constants.mjs:182-190`  
lane: cpswap-fork-diff · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** On the mandatory redeploy, someone cleans up the last dead multisig constant. `node scripts/verify-program-constants.mjs --so target/deploy/raydium_cp_swap.so` exits non-zero on 'create_support_mint_associated_owner::ID is absent', and the operator either re-introduces the multisig constant to satisfy the gate or learns to ignore the gate. Both outcomes are worse than the gate not existing.

**Recommendation:** Change that entry to `expect: 'informational'` (the roster already has that state, used for the vault at line 212), so its disappearance is reported without failing the run. Whatever value the constant takes on the redeploy, re-pin the roster in the same change.

### max_reachable_real_sol is documented and tested as an exclusive upper bound on realised real SOL; it is not — rounding in the curve's favour carries real SOL above it

`solana/tegridy-amm/programs/tegridy-launch/src/curve.rs:290-293 and :671-713 (the test that claims to prove it)`  
lane: curve-math · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Vs = 10, Vt = 10, S = 10 (so the returned ceiling is 10). Buys of 3, then 7, then 2 lamports, each passing `quote_buy` and lib.rs:760's real-token check exactly as the program applies them, leave real_token_reserves = 0 and real_sol_reserves = 12 — 20% above the value the function calls an exclusive upper bound. No fund risk follows today: the only consumer is `require!(required < ceiling, ...)` (lib.rs:417, :525-528), where understating the ceiling makes the gate STRICTER, and `buy` caps the raise at `target + reserve` (verified to land exactly on it) so real SOL never approaches the ceiling in practice. The cost is that a load-bearing invariant is written down backwards with a green test n

**Recommendation:** Either restate the doc as "a conservative lower estimate of the reachable maximum, safe to use as a `required < ceiling` gate", or change the test to drive real tokens to 0 and assert what actually holds. Do not weaken the `required < ceiling` comparison on the strength of the current comment.

### `migrate_to_amm`'s affordability gate measures actual lamports while the debit measures `real_sol_reserves` — a 1-lamport donation to a curve PDA turns a clear rejection into a bogus "Arithmetic overflow"

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1053-1056, 1069-1081, 1530-1533`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Curve is one lamport short of full funding: `real_sol_reserves = target + reserve - 1`. Anyone sends 1 lamport to the curve PDA. Now `spendable = target + reserve`, so the gate at :1075 passes. Migration then runs the entire sequence — funds the authority, opens the cp-swap pool, seeds it, burns the LP, closes three token accounts — and only at :1530 does `checked_sub` underflow, returning `Overflow` (error 6000). Everything rolls back, so nothing is lost and no state is corrupted. The damage is diagnostic: a curve that is genuinely under-raised reports "Arithmetic overflow" instead of `MigrationReserveTooLow` (6017), and any operator dashboard that reads `curve_ai.lamports() - rent_floor` t

**Recommendation:** Gate on the accounting quantity, since that is what the debit uses: add `require!(curve.real_sol_reserves >= move_lamports, LaunchError::MigrationReserveTooLow)` next to the existing :1053 check. Keep the `spendable` check too — it is the correct guard for rent-exemption survival — but it should be defence-in-depth, not the primary funding test.

### Migration pays its permissionless caller 1,148,400 lamports of the traders' migration reserve — the "surplus goes to fee_recipient" fix did not close the whole bounty

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1189-1202 and lib.rs:1467-1481, with MigrateToAmm at lib.rs:1771-1786, 1803-1804`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** A bot watches for `real_sol_reserves == target + reserve` and calls `migrate_to_amm` first. It nets 1,148,400 lamports (~0.00115 SOL) minus tx fees, per graduation, taken from money buyers paid in on top of the graduation target. It is not a bug — the caller must be paid something or nobody triggers graduation — but it is 0.00115 SOL of traders' money per launch flowing to whoever wins a race, and the surrounding comments read as if the reserve leak was fully closed when the residual sweep was repointed at `fee_recipient`. At current scale (zero launches) the absolute number is nil; at 1,000 graduations it is ~1.15 SOL.

**Recommendation:** Either accept and document the exact number in MAINNET_RUNBOOK (it is a deliberate incentive), or point `auth_lp`'s close destination at `fee_recipient` instead of `payer`, which reduces the caller to exactly break-even minus the 890,880 seed and would need a compensating payment to keep migration attractive.

### Every graduated launch permanently buries 7,913,520 lamports of creator-paid rent — no instruction closes the curve or its vault, and `complete = true` freezes both

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1662-1683 (creation) and lib.rs:1535 (freeze); no `close =` constraint exists anywhere in the crate`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** A creator pays 7,913,520 lamports (~0.0079 SOL) of rent at `create_launch`. After the launch graduates, that rent is unrecoverable by any party: the curve PDA is owned by tegridy-launch and only tegridy-launch could sign a close, but no instruction does; the vault's authority is the curve PDA, same problem. Only a program upgrade could add a reclaim path — and the upgrade authority is the Squads vault, which for the closed mainnet deploy no longer has a program to upgrade. This is a creator-borne cost rather than a protocol loss, and it is correctly small; it is listed because the curve account's own doc comment budgets the segment table's extra rent at "~0.0036 SOL of extra rent on EVERY la

**Recommendation:** If you redeploy, consider a permissionless `reclaim_graduated_rent` that closes `curve_vault` (it holds only donated dust after migration) and the curve PDA, refunding to `curve.creator`. If you keep it as is, state the 0.0079 SOL as a non-refundable launch cost in the Fact Sheet rather than implying only the segment table costs rent.

### The live 0.25 SOL reserve caps cp-swap's `create_pool_fee` at exactly 208,734,160 lamports; above that every already-created curve becomes permanently unmigratable, because the reserve is snapshotted and the fee is not

`solana/tegridy-amm/programs/tegridy-launch/src/state.rs:25-50 and lib.rs:1170-1172, 1189-1190, 1252-1262; cp-swap fee charge at programs/cp-swap/src/instructions/initialize.rs:318-342`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** The AMM admin calls `update_config` and raises `create_pool_fee` above 208,734,160 lamports. Every curve already created under the current global config now fails `migrate_to_amm`: cp-swap's `invoke(system_instruction::transfer(creator -> create_pool_fee, fee))` finds the migration authority short and returns ResultWithNegativeLamports, reverting the whole instruction. `update_global` cannot repair it — raising `migration_reserve_lamports` only affects launches created afterwards. Recoverable only by lowering `create_pool_fee` back; not fund loss (holders keep selling because `complete` stays false), but every affected launch is frozen at the finish line until the AMM config is corrected. Ri

**Recommendation:** Put the number 208,734,160 in MAINNET_RUNBOOK §5b next to the reserve arithmetic, and make raising `create_pool_fee` a two-key procedure that first checks the reserve of the oldest live curve. The `MIN_MIGRATION_RESERVE_LAMPORTS` floor is correct but, as its own comment says, it is not sufficient — it omits both the fee and the 890,880 seed top-up that offsets it.

### Verified clean: the cp-swap fork delta contains zero lamport or rent logic, and the one lamport-adjacent constant in it is correct on chain

`solana/tegridy-amm/programs/cp-swap/src/lib.rs:79-91 and instructions/admin/create_support_mint_associated.rs:7-29, diffed against raydium-cp-swap @ 78f254e1023751e706df7dc15c453fc3e046697c`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** None. This entry records a negative result so the ledger shows the fork-diff half of the assignment was actually executed rather than assumed. The one thing that would have been a real lamport bug here — a wallet instead of a WSOL token account at `create_pool_fee_reveiver::ID`, which would make cp-swap's `sync_native` revert and block every graduation forever — is not present.

**Recommendation:** Nothing to fix. Keep the diff-guard hash pinned; it is doing its job. Note for the next auditor: the fork's lamport surface is entirely inherited, so cp-swap lamport findings belong upstream, not here.

### `initialize_global` has `payer = authority` pinned to a key that does not exist on chain and holds zero lamports — the rent payer for a redeploy is unavailable, and the current source's sentinel makes it unpayable by anyone

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:133-143 and lib.rs:1582-1594`  
lane: lamports-and-rent · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Two distinct blocks on any redeploy. (1) Building the current tree without `--features devnet` bakes the all-1s sentinel; nobody can sign for the System Program id, so `initialize_global` is uncallable and the program is inert — intended fail-closed behaviour, but it means the tree as committed cannot produce a working mainnet binary. (2) Even with the constant repointed at Dcjink4…, that key must be funded with at least 5,922,960 + fees before `initialize_global` will succeed, and today it holds nothing. This is the same shape as the `admin::ID` mistake documented in cp-swap/lib.rs:48-71 — a gated key that can sign but cannot pay rent — one step removed: here the key can pay in principle bu

**Recommendation:** Add a line to MAINNET_RUNBOOK: fund the deploy authority to at least 0.01 SOL before running `initialize_global`, and set the non-devnet `deployer::ID` in the same commit as the redeploy. Consider decoupling the rent payer from the authority (`payer = payer, authority = Signer<deployer::ID>`) so a funding shortfall on one key cannot block initialization.

### The residual sweep tops up `fee_recipient` rather than folding - safe at live parameters, but it is the one un-folded rent-band credit left in migration

`solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:1505-1518`  
lane: migration-and-graduation · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** Not reachable at current parameters. Recorded because the brief asks for the rent band explicitly and this is the only place in the migration path where a credit is topped up instead of folded. It would fire only if BOTH the Squads vault were drained to exactly 0 lamports AND `create_pool_fee` were set inside that ~890k-lamport window - and the symptom would be `InsufficientFundsForRent` on the whole transaction, after the pool was already built (atomic, so it reverts cleanly, but the diagnosis is opaque).

**Recommendation:** No code change warranted. If the migration reserve is ever trimmed toward `MIN_MIGRATION_RESERVE_LAMPORTS`, re-derive the window above before shipping it.

### No operator command and no write-client method exists for `migrate_to_amm`

`frontend/scripts/tegridy-launch-operator.mjs (command dispatch, ~:1231-1247) and frontend/src/lib/launcher/solana/curve/rpc.ts:290-293`  
lane: migration-and-graduation · confidence: proven  
**Disposition: SCHEDULED (source, pre-redeploy)**

**Failure:** On the day graduation is unblocked there is no tested way to call it. The operator will either hand-build a transaction or reach for `migrateToAmmIx`, which is wrong. `migrate_to_amm` also measured 264,128 CU against Solana's 200,000 default (MIGRATE_DESIGN.md:220-239), so a hand-built transaction that omits `ComputeBudgetProgram.setComputeUnitLimit` fails with 'Program failed to complete' - a third distinct way for the first graduation to look like a program bug.

**Recommendation:** Add a `migrate` command to `tegridy-launch-operator.mjs` that (a) refuses, before touching a key, on `global.cp_swap_program == 0 || global.amm_config == 0`, on `curve.complete`, and on `curveLamports - rentExempt < target + reserve`; (b) prepends `setComputeUnitLimit(MIGRATE_COMPUTE_UNITS)`; and (c) builds its accounts from the same list the Anchor rehearsal uses. Ship it in the same change as the `fee_recipient` fix so the two cannot drift apart again.
