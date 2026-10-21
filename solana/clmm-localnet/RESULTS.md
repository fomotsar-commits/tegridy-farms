# Range pools on a local chain: results

> Step 1 of "What is left, in order" in [docs/RANGE_POOLS_PLAN.md](../../docs/RANGE_POOLS_PLAN.md). The one to-do list is [docs/TODO_OPERATOR.md](../../docs/TODO_OPERATOR.md). This file is written by `report.mjs`; rerun the harness rather than editing it.

**What it means.** The range-pool program (our copy of Raydium's concentrated-liquidity program, built the way a
release would be) ran every instruction a visitor or the venue would use on a local chain, against copies of
mainnet's BAYLA, wrapped SOL, Squads and token programs. 104 checks: 104 pass, none fail.
104 of 104 broken inputs turned their check red first (12 against this build, the rest, whose checks did not change, against the build before it); the clean run after them passed every check with the program and its source unchanged (restore proven).
Every admin action was signed by the vault's real address through a real Squads 2-of-2 with a time lock. No path
sent anything to a Raydium address. The fee tiers are the owner's (2026-10-20): of each fee the LPs collected 84%,
the venue's 10.4% was collectable only by the vault, and the island's 5.6% only by its Workshop's role: the vault
is refused (check V9), though one proposal can **re-point the island's share** (check V6). No tier may charge
more than 4% of a swap or give the venue and the island more than 16% of each fee, made or changed (K1 to K5),
and a dynamic fee is held to 4% too (K6). A reward's unpaid rest goes back only to whoever started it, whoever owns
the pool (R11, R13, R14). (A fee earned where no LP's range is in use, when a swap fills a limit order there, goes to
the venue's share.) What the vault can still do, the pause of any part of a pool included, is in
docs/RANGE_POOLS_PLAN.md.

Run 2026-10-21T03:12:57.668Z to 2026-10-21T03:24:03.335Z. Nothing was deployed anywhere, no program key exists, and nothing was
signed or sent on mainnet: mainnet was only read.

## The local chain

- **Program**: `solana/tegridy-clmm` built with `cargo build-sbf --features placeholder-id -- --locked` (the
  release shape CI builds; every role is the vault, so no `devnet`/`localnet` feature and no `test-chain-keys`
  is needed). Solana tools 3.1.11 in WSL (CI pins 3.1.10), sha256 `d30cdef7caeb519729e552fda467fe71cb1d681ad00069ce96f75bac3e31a6bb`,
  loaded at the placeholder id `RangePoo1PLACEHo1DERnotDep1oyed111111111111` with the vault as upgrade authority.
- **Copied from mainnet** (read at slot 459,478,387, 2026-10-21T03:24Z): the programs Squads v4, Token-2022, SPL Token,
  Associated Token, Memo and Metaplex (each byte-identical to mainnet's: table below); the BAYLA mint
  `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump`; the wrapped-SOL mint; the Squads multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`;
  Squads' own published IDL. Every address came from `frontend/scripts/addresses.json`, `solana/guards/allowed-keys.json`
  or the frontend's Squads constant.
- **What differs from mainnet, and nothing else**: the multisig's two member keys are local test keys and its
  172,800 s time lock is **10 s** (threshold 2, no config authority and proposal numbering stay
  mainnet's, so its vault 0 is the real vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`); BAYLA's mint had a local mint authority
  until the test wallets were funded, then none, as on mainnet (check S2); the 29 runtime features mainnet has not
  switched on were switched off (`features.mjs`), including the raise of the program-call depth limit from 4 to 8.
- **Starting price**: the venue's BAYLA/SOL pool on mainnet, 6.2743e-6 SOL per BAYLA.

| Program copied from mainnet | Address | Bytes | sha256 | Last deployed (slot) |
|---|---|---|---|---|
| squads | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | 1,470,416 | `dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c` | 302,582,236 |
| token2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | 1,382,016 | `0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469` | 427,147,035 |
| token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | 108,600 | `8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697` | 419,472,000 |
| ata | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | 105,032 | `6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d` | not upgradeable |
| memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | 74,800 | `f520eaf096361abbb9639ea4dc3e5388a87b9330e121f476607b87c46ef67954` | not upgradeable |
| metaplex | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | 793,991 | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` | 380,725,176 |

## Every check

"Red first" names the broken input each check was run against before it passed: the check had to come out FAIL on
it. Every check was seen red first.
Each broken input ran alone on a fresh chain and stopped once its check was judged; those runs used a 3 s lock to save
time (the clean runs use 10 s). The restore after them: a clean run from nothing, 104 checks, none failed, the program's sha256 `d30cdef7caeb519729e552fda467fe71cb1d681ad00069ce96f75bac3e31a6bb` as before and its source unchanged.

| ID | Instruction | What was checked | Clean run | Red first | Counts |
|---|---|---|---|---|---|
| S0 | `setup` | vault 0 of the multisig (registry row squads-multisig) is the registry vault | pass | red: vault 0 is derived at index 1 instead of 0 | GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd |
| S1 | `setup` | local multisig: 2 of 2, members are the two local keys, lock 10 s (mainnet 172800 s, threshold 2) | pass | red: the local multisig is 1 of 2 | next proposal 15, as on mainnet |
| S2 | `setup` | BAYLA's mint is mainnet's byte for byte, except its supply (the test wallets' coins) | pass | red: BAYLA is minted to the test wallets but its mint authority is left in place | 408 bytes, 472,000,000 BAYLA minted locally |
| S3 | `setup` | the vault's wrapped-SOL account here is the one the registry names (cpswap-fee-receiver-wsol-ata) | pass | red: the vault's wrapped-SOL account is derived for the multisig account instead of the vault | 2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa |
| T1 | `create_amm_config` | a stranger cannot make a fee tier | pass | red: the fee tier is created by the vault through Squads instead of by a stranger directly | refused: NotApproved |
| T2 | `Squads: vault_transaction_execute` | one approval of two cannot execute a vault action | pass | red: the local multisig is 1 of 2 (CLMM_THRESHOLD=1) | proposal 15: Active, execute InvalidProposalStatus |
| T3 | `Squads: proposal_approve` | someone outside the multisig cannot approve | pass | red: the second approval comes from member B instead of a non-member | refused: NotAMember |
| T4 | `Squads: vault_transaction_execute` | an execute sent before the 10 s lock runs out is refused, and the proposal stays approved | pass | red: the local multisig has no time lock (CLMM_TIME_LOCK=0) | refused: TimeLockNotReleased |
| T5 | `create_amm_config` | the vault makes fee tier 0 through Squads, executed only after the lock | pass | red: member B never approves tier 0's proposal | proposal 16, executed 10 s after the second approval |
| T6 | `create_amm_config + update_amm_config` | one proposal makes tier 0 (1%, spacing 120) with the split: 104,000 per million of each fee to the venue (owner: the vault), 56,000 to the island (fund owner: its Workshop) | pass | red: tier 0's proposal leaves out the step that points its fund share at the Workshop | protocol 104000, fund 56000 per million; fund owner G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu |
| T7 | `create_amm_config + update_amm_config` | one proposal makes tier 1 (0.25%, spacing 60) with the same split and the same two owners | pass | red: tier 1's proposal leaves out the step that points its fund share at the Workshop | proposal 17 |
| T8 | `update_amm_config` | a stranger cannot change a fee tier | pass | red: the fee-tier change is signed by the vault through Squads instead of by a stranger | refused: NotApproved |
| T9 | `update_amm_config` | the vault changes a tier and changes it back | pass | red: the change back to 104,000 is never proposed | 100000 then 104000 per million |
| K1 | `create_amm_config` | the vault cannot make a tier that charges more than 4% of a swap | pass | red: the tier asks for exactly 4% (40,000), which is allowed | refused: RequireGteViolated |
| K2 | `create_amm_config` | the vault cannot make a tier that gives the venue and the island together more than 16% of each fee | pass | red: the tier's venue and island parts come to exactly 16% (160,000), which is allowed | refused: RequireGteViolated |
| K3 | `update_amm_config` | the vault cannot raise a tier above 4% of a swap | pass | red: the change asks for exactly 4%, which is allowed | refused: RequireGteViolated |
| K4 | `update_amm_config` | the vault cannot raise the venue's part past the 16% ceiling | pass | red: the venue's part is set to 104,000, keeping the total at the 16% ceiling | refused: RequireGteViolated |
| K5 | `update_amm_config` | the vault cannot raise the island's part past the 16% ceiling | pass | red: the island's part is set to 56,000, keeping the total at the 16% ceiling | refused: RequireGteViolated |
| P1 | `create_pool` | the pool opens with the given price, no liquidity, empty vaults, opener as owner | pass | red: pool A opens at twice the square-root price it was given | 1 BAYLA = 6.2743e-6 SOL, tick 50715 |
| P2 | `create_pool` | opening takes no coins from the opener: only the rent of its five accounts and the fee | pass | red: the pool-opening transaction also moves 1 BAYLA base unit out of the opener | 0.06148464 SOL rent locally |
| P3 | `create_pool` | a pool opens on the 0.25% tier with spacing 60 | pass | red: pool B is opened against tier 0 instead of tier 1 | tick -17149 |
| L1 | `open_position_with_token22_nft` | a range around the price takes both coins, within the caps, and the pool vaults receive exactly that | pass | red: alice's range is placed wholly above the price | 3,999,999.999997 BAYLA + 24.770966963 SOL, ticks 41520..59760, 120350 CU |
| L2 | `open_position_with_token22_nft` | the position is a Token-2022 NFT (supply 1, 0 decimals) held by its owner, named "Memetics Range Position", "MEM-RANGE", linking memetics.finance/position/<position>.json | pass | red: the position is opened without its name record (with_metadata false) | https://memetics.finance/position/6mNHayrvwdF7r9xXYzVRW5jBfYDxGYrLBukJXBFifBFy.json |
| L3 | `open_position_with_token22_nft` | a BAYLA-only position above the price takes BAYLA and not one lamport of SOL | pass | red: bob's BAYLA-only range is widened to straddle the price | 5,000,000 BAYLA, 0 lamports, ticks 39720..48000 |
| L4 | `open_position_with_token22_nft` | a SOL-only position below the price takes SOL and not one unit of BAYLA | pass | red: carol's SOL-only range is widened to straddle the price | 15 SOL, 0 BAYLA base units, ticks 53280..61680 |
| L5 | `open_position_with_token22_nft` | a far-away BAYLA-only position opens (it should earn nothing below) | pass | red: dave's position is opened with no BAYLA | ticks 13800..20640 |
| L6 | `open_position_with_token22_nft` | without the name record the NFT mint is smaller (a choice the client makes) | pass | red: erin's position is opened with the name record after all | 202 vs 469 bytes |
| L7 | `increase_liquidity_v2` | adding to a position raises its liquidity and takes both coins | pass | red: the increase is sent with both caps at 0 | +1,999,999.999996 BAYLA, +12.385483482 SOL, 49532 CU |
| L9 | `decrease_liquidity_v2` | removing a quarter lowers liquidity by exactly that and pays both coins back to the owner | pass | red: the removal is sent with 0 liquidity | 1,499,999.999996 BAYLA, 9.28911261 SOL back, 45803 CU |
| L8 | `decrease_liquidity_v2` | only the holder of the position NFT can withdraw from it | pass | red: alice, who holds the NFT, withdraws instead of a stranger | refused: ConstraintTokenOwner |
| W1 | `swap_v2` | a buy moves the price up into the BAYLA-only range and across into another tick array | pass | red: the buy stops before the next band of prices (price limit inside the current tick array) | 6.2743e-6 -> 1.3803e-5 SOL per BAYLA, 2 array boundary crossed, 68564 CU |
| W2 | `swap_v2` | the trader's coins and the pool's vaults move by exactly the same amounts | pass | red: the swap transaction also moves 1 lamport of wrapped SOL to bob | paid 73.654756114 SOL, got 7,347,320.101355 BAYLA |
| W3 | `swap_v2` | of a 1% swap, 0.104% of what the trader paid waits for the venue and 0.056% for the island | pass | red: the 1% tier is created with the old plan split (16% to the venue, nothing to the island) | venue 0.076600944 SOL (0.10400%), island 0.041246662 SOL (0.05600%) of 73.654756114 SOL |
| W4 | `swap_v2` | a sell moves the price the other way, across several tick arrays, into the SOL-only range | pass | red: the sell stops at 0.95x, above the SOL-only range | 1.3803e-5 -> 3.1371e-6, 3 boundaries, 89633 CU |
| W5 | `swap_v2` | the same split in the other coin | pass | red: the 1% tier is created with the old plan split | venue 15,355.301975 BAYLA (0.10400%), island 8,268.239523 BAYLA (0.05600%) |
| W6 | `swap_v2` | an exact-output buy delivers exactly what was asked, for no more than the cap | pass | red: the exact-output buy is sent as an exact-input one | got 100,000 BAYLA for 0.317997997 SOL |
| W7 | `swap_v2` | a swap that would pay less than the trader asked is refused and moves nothing | pass | red: the swap asks for no minimum output | refused: TooLittleOutputReceived |
| F1 | `decrease_liquidity_v2 (0)` | the wide range collects fees in both coins and keeps its liquidity | pass | red: alice collects once before the measured collect | 76,663.161146 BAYLA + 0.315721525 SOL |
| F2 | `decrease_liquidity_v2 (0)` | the BAYLA-only range, which both swaps passed, earned fees in both coins | pass | red: bob collects once before the measured collect | 28,504.149284 BAYLA + 0.30384057 SOL |
| F3 | `decrease_liquidity_v2 (0)` | the SOL-only range earned BAYLA fees from the sell that reached it | pass | red: carol collects once before the measured collect | 18,653.877172 BAYLA + 0.001050799 SOL |
| F4 | `decrease_liquidity_v2 (0)` | a range no swap reached earned nothing | pass | red: dave's far position is placed where the swaps pass | 0 + 0 base units |
| F5 | `swap_v2 + decrease_liquidity_v2` | of every fee the LPs collected 84%, 10.4% waits for the venue and 5.6% for the island; together they are 1% of what traders paid | pass | red: the 1% tier is created with the old plan split | BAYLA: LPs 84.000%, venue 10.400%, island 5.600%; SOL: LPs 84.000%, venue 10.400%, island 5.600%; fee 1.000% and 1.000% of input |
| V1 | `collect_protocol_fee` | a stranger cannot collect the venue's share | pass | red: the protocol fee is collected by the vault through Squads instead of by a stranger | refused: NotApproved |
| V2 | `collect_protocol_fee` | the vault collects exactly the venue's share that built up, and the pool's count goes to zero | pass | red: the vault asks for 1 base unit of the venue's share, not all of it | 15,355.301975 BAYLA + 0.076931661 SOL, proposal 26 |
| V3 | `collect_protocol_fee` | the venue's share landed in token accounts the vault owns | pass | red: the vault's collection is sent to mallory's token accounts | GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd |
| V6 | `update_amm_config (param 4)` | the vault can point a tier's fund share at any account, at any time (an admin path over the island's share) | pass | red: the re-point names the Workshop again instead of another account | fund owner re-pointed by one vault proposal |
| V5 | `collect_fund_fee` | a stranger cannot collect the island's share | pass | red: the island's share is collected by its fund owner (the stand-in) instead of by a stranger | refused: NotApproved |
| V7 | `collect_fund_fee` | the fund owner collects exactly the island's share that built up, into its own accounts | pass | red: a stranger, not the fund owner, collects the island's share | 8,268.239523 BAYLA + 0.041424739 SOL |
| V8 | `update_amm_config (param 4)` | tier 0's fund owner is the Workshop again | pass | red: the vault never points the fund owner back at the Workshop |  |
| R1 | `create_operation_account` | the vault creates the operation account rewards need | pass | red: the operation account is never created |  |
| R2 | `initialize_reward` | the vault funds a 1 BAYLA a second reward for 7 days: exactly 604,800 BAYLA leave the vault for the reward vault | pass | red: the reward is funded at 0.5 BAYLA a second | 604,800 BAYLA |
| R3 | `initialize_reward` | a stranger cannot set up a reward on the pool | pass | red: the reward is set up by the pool opener instead of a stranger | refused: NotApproved |
| R4 | `initialize_reward` | the pool's opener funds a second reward from her own coins | pass | red: the second reward is funded at 0.25 REWARD a second | 302,400 REWARD |
| R5 | `set_reward_params` | before a reward opens, the vault can move its window (here to 90 s, paying 90 BAYLA more) | pass | red: the new window is 100 s, not 90 | window 1792552707..1792552797, paid 90 BAYLA |
| R6 | `update_reward_infos` | anyone can bring the reward counters up to date | pass | red: the update names the price history instead of the pool | 6129 CU |
| R7A | `decrease_liquidity_v2 (rewards)` | an LP in range collects both rewards, no more than the stream paid so far | pass | red: alice collects before the stream opens | 18.767023 BAYLA after 31 s, 14.226614 REWARD |
| R7 | `decrease_liquidity_v2 (rewards)` | a position out of range earns no reward | pass | red: dave's far position is placed in range | 0 + 0 base units |
| R8 | `decrease_liquidity_v2 (rewards)` | over the whole window the LPs together collect what the stream emitted (90 BAYLA), never more | pass | red: alice never collects after the end | 89.999997 of 90 BAYLA |
| R9 | `collect_remaining_rewards` | after the end the vault takes back everything the stream did not owe | pass | red: the vault tries to take back alice's running reward instead | 604,800 BAYLA back |
| R10 | `collect_remaining_rewards` | a reward still running cannot be taken back | pass | red: the vault takes back the ended stream again instead of alice taking back a running one | refused: NotApproved |
| R12 | `transfer_reward_owner` | a stranger cannot take over a pool's rewards | pass | red: the pool is handed over by the vault instead of by a stranger | refused: NotApproved |
| R11 | `transfer_reward_owner` | the vault can hand a pool to someone else, and each reward's authority stays with whoever funded it | pass | red: the vault hands pool B to carol instead of bob | pool B owner bob, reward authority alice |
| R13 | `collect_remaining_rewards` | a pool's new owner cannot take back the unpaid rest of a reward someone else funded | pass | red: the reward's funder (alice) takes back its unpaid rest instead of the pool's new owner | refused: RequireKeysEqViolated (the reward is alice's) |
| R14 | `collect_remaining_rewards` | after the end, the funder takes back the unpaid rest of her reward, whoever owns the pool now, and with it what the vault paid in to move the window: a top-up of someone else's reward goes to its funder | pass | red: the pool's new owner (bob) takes back the unpaid rest instead of its funder | 604.83 REWARD back to alice: 604.8 hers, 0.03 the vault's |
| O1 | `open_limit_order` | the order takes exactly its BAYLA into the pool and records owner, price and side | pass | red: the order is placed for 999,999 BAYLA | tick 55800 (3.7736e-6 SOL per BAYLA) |
| O2 | `increase_limit_order` | adding to an order raises its total | pass | red: the order is raised by 400,000 | 1,500,000 BAYLA |
| O3 | `decrease_limit_order` | cutting an unfilled order pays the coins back to its owner | pass | red: the order is cut by 100,000 | 200,000 BAYLA back |
| O4 | `swap_v2 (fills the order)` | a buy moves the price past the order | pass | red: the buy stops at 0.55x, short of the order | 3.1593e-6 -> 4.7057e-6 |
| O5 | `settle_limit_order` | a stranger cannot settle someone's order | pass | red: the order's owner settles instead of a stranger | refused: ConstraintRaw |
| O6 | `settle_limit_order` | the keeper (the vault) cannot settle an order into its own account | pass | red: the keeper settles into the order owner's account instead of its own | refused: ConstraintTokenOwner |
| O7 | `settle_limit_order` | the keeper settles the filled order; the SOL goes to the order's owner, at the order's price, and the vault gets nothing | pass | red: the buy stops short of the order, so nothing is filled | 4.905703583 SOL for 1,300,000 BAYLA (expected 4.905704), proposal 36 |
| O8 | `close_limit_order` | closing the order refunds its rent to the order's owner, none to the keeper | pass | red: the close names the vault as the rent receiver | 0.00209496 SOL to erin |
| O9 | `decrease_limit_order + close_limit_order` | an owner can cancel an order in full and close it herself | pass | red: erin cancels only half of the second order | all 200,000 BAYLA and 0.00209496 SOL rent back |
| A3 | `update_pool_status` | a stranger cannot pause a pool | pass | red: the pause is sent by the vault through Squads instead of by a stranger | refused: ConstraintAddress |
| A1 | `update_pool_status` | when the vault pauses swaps, a swap is refused | pass | red: the pool is not paused before the swap | refused: NotApproved |
| A2 | `update_pool_status` | after the vault lifts the pause, swaps work again | pass | red: the vault never lifts the pause | 208,500.082181 BAYLA |
| V9 | `collect_fund_fee` | the vault cannot collect the island's share, even while the Workshop is the fund owner: only the fund owner can | pass | red: the vault collects the venue's share, which it may, instead of the island's | refused: NotApproved |
| V10 | `update_amm_config (param 4) + collect_fund_fee` | kept and disclosed: in one proposal the vault can point a tier's island share at itself, collect it, and point it back | pass | red: the proposal collects without first pointing the island's share at the vault | 0 BAYLA + 0.014531855 SOL, proposal 41 |
| E3 | `collect_excess_lamports` | a stranger cannot sweep spare SOL | pass | red: the sweep is sent by the vault through Squads instead of by a stranger | refused: NotApproved |
| E1 | `collect_excess_lamports` | the vault receives exactly the spare SOL, and the BAYLA in the pool is untouched | pass | red: the sweep leaves out the BAYLA vault | 0.8 SOL to the vault |
| E2 | `collect_excess_lamports` | the sweep cannot take LPs' SOL out of the wrapped-SOL vault: its balance and lamports are unchanged | pass | red: a swap lands between the two reads of the wrapped-SOL vault | swept only the 0.1 SOL gift; balance 33.194159088 SOL kept |
| C1 | `close_position` | closing burns the NFT, closes its mint, account and record, and refunds all three rents to the owner | pass | red: carol closes without withdrawing first | 0.00907584 SOL back |
| X1 | `update_operation_account` | a stranger cannot make anyone an operator | pass | red: the operator is added by the vault through Squads instead of by a stranger | refused: NotApproved |
| X2 | `update_operation_account + initialize_reward` | the third reward may only be set up by the vault or an operator: carol, made an operator by the vault, can | pass | red: carol is never made an operator | 0.6048 USD funded |
| X3 | `update_operation_account` | the vault adds and removes operators and whitelisted reward coins | pass | red: REWARD is never taken off the whitelist | add, remove, both seen |
| X4 | `create_pool` | a coin with an unusual Token-2022 feature (a permanent delegate) cannot get a pool by default | pass | red: the coin is made without the permanent delegate | refused: NotSupportMint |
| X6 | `create_support_mint_associated` | a stranger cannot let an unusual coin in | pass | red: the pass is issued by the vault through Squads instead of by a stranger | refused: NotApproved |
| X7 | `create_pool + create_support_mint_associated` | once the vault lets a coin in, anyone can open its pool | pass | red: the pool is opened without passing the pass | pool opened |
| X8 | `close_support_mint_associated` | the vault can withdraw the pass | pass | red: the vault never withdraws ODD's pass | closed |
| X9 | `create_dynamic_fee_config` | a stranger cannot make a dynamic fee setting | pass | red: the dynamic fee setting is made by the vault instead of by a stranger | refused: NotApproved |
| X10 | `create_dynamic_fee_config + update_dynamic_fee_config` | the vault makes a dynamic fee setting and changes it | pass | red: the decay period is never changed | decay 600 -> 900 s |
| X11 | `create_customizable_pool` | anyone can open a pool that takes its fee in one coin only, with the dynamic fee the vault set | pass | red: the custom pool is opened without the dynamic fee | fee_on 1, decay 900 s |
| K6 | `swap_v2 (dynamic fee)` | a swap through a pool whose dynamic fee would add more than 1% to its 3% pays exactly 4%, the ceiling | pass | red: pool D is opened without the dynamic fee | 21.3 steps moved, volatility 220000, second swap paid 4.000% |
| X12 | `create_permission_pda` | a stranger cannot grant the right to open extra pools | pass | red: the permission is granted by the vault instead of by a stranger | refused: NotApproved |
| X13 | `create_permissioned_pool` | a permission holder can open another pool for a pair that has one | pass | red: the vault never grants the permission | pool #1 opened |
| X14 | `close_permission_pda` | once the vault withdraws the permission, no more extra pools | pass | red: the vault never withdraws the permission | refused: AccountNotInitialized |
| X15 | `swap_router_base_in` | a two-hop route through both tiers spends exactly the BAYLA in, pays USD out, and leaves no SOL behind | pass | red: the route asks for 2^62 USD base units out | 100,000 BAYLA -> 83.14734 USD, 92453 CU, 1026 bytes |
| X16 | `swap (old)` | the old swap cannot move a Token-2022 coin, so it cannot trade BAYLA: it is refused at BAYLA's own account | pass | red: the old swap is run on the SPL-only SOL/USD pool instead | refused: AccountOwnedByWrongProgram at output_token_account |
| X17 | `open_position_v2` | the old path still works for a stranger, who pays Metaplex from her own wallet; the vault pays nothing | pass | red: the old path is used without the Metaplex name record | Metaplex name record 607 bytes; 0.01 SOL above its rent stays in it as Metaplex's fee |
| G1 | `every transaction` | no transaction touched any of the 39 keys Raydium's code hard-codes, except the SPL Memo program, which the deny list also carries; it was only named, never paid | pass | red: one transaction also sends 1 lamport to a key Raydium hard-codes | 227 transactions, 223 accounts; Memo named in 29; no other deny key |
| G2 | `every transaction` | every account any transaction touched is one this run made or named (wallets, vault, pools, programs) | pass | red: one transaction also sends 1 lamport to a key nothing in the run made | 223 accounts, all named |
| G3 | `every transaction` | every coin that moved anywhere landed with a test wallet, the vault or a pool | pass | red: one transaction also moves 1 BAYLA unit to an owner nothing in the run named | all landed with named owners |
| G4 | `the program itself` | the running program's bytes hold none of Raydium's 39 keys, as bytes or as text | pass | red: a Raydium key is written into a copy of the running program's bytes | 1522736 bytes searched |
| G5 | `the program itself` | the local program sits at the placeholder id with the vault as its upgrade authority (the deploy pack decides the real one) | pass | red: the chain loads the program with the System Program as its upgrade authority | program data 1522781 bytes |

## Instructions covered

| Instruction | Checks |
|---|---|
| `create_amm_config` | T1, T5, T6, T7, K1, K2 |
| `create_support_mint_associated` | X6, X7 |
| `update_amm_config` | T6, T7, T8, T9, K3, K4, K5, V6, V8, V10 |
| `create_dynamic_fee_config` | X9, X10 |
| `update_dynamic_fee_config` | X10 |
| `create_permission_pda` | X12 |
| `close_permission_pda` | X14 |
| `close_support_mint_associated` | X8 |
| `create_pool` | P1, P2, P3, X4, X7 |
| `create_customizable_pool` | X11 |
| `create_permissioned_pool` | X13 |
| `update_pool_status` | A3, A1, A2 |
| `create_operation_account` | R1 |
| `update_operation_account` | X1, X2, X3 |
| `transfer_reward_owner` | R12, R11 |
| `initialize_reward` | R2, R3, R4, X2 |
| `collect_remaining_rewards` | R9, R10, R13, R14 |
| `update_reward_infos` | R6 |
| `set_reward_params` | R5 |
| `collect_protocol_fee` | V1, V2, V3 |
| `collect_fund_fee` | V5, V7, V9, V10 |
| `open_position` | not run: deprecated: makes an SPL Token NFT with a Metaplex name record; open_position_v2 (X17) covers that path |
| `open_position_v2` | X17 |
| `open_position_with_token22_nft` | L1, L2, L3, L4, L5, L6 |
| `close_position` | C1 |
| `increase_liquidity` | not run: deprecated, SPL Token only: it cannot move BAYLA (Token-2022), as the old swap cannot (X16) |
| `increase_liquidity_v2` | L7 |
| `decrease_liquidity` | not run: deprecated, SPL Token only, for the same reason |
| `decrease_liquidity_v2` | L9, L8, F1, F2, F3, F4, F5, R7A, R7, R8 |
| `swap` | X16 |
| `swap_v2` | W1, W2, W3, W4, W5, W6, W7, F5, O4, K6 |
| `swap_router_base_in` | X15 |
| `close_protocol_position` | not run: closes the deprecated protocol-position accounts; a new deployment never makes one, so there is nothing to close |
| `open_limit_order` | O1 |
| `increase_limit_order` | O2 |
| `decrease_limit_order` | O3, O9 |
| `settle_limit_order` | O5, O6, O7 |
| `close_limit_order` | O8, O9 |
| `collect_excess_lamports` | E3, E1, E2 |

## Rent and sizes, measured

Measured on the local chain. Mainnet cost is (bytes + 128) x 5,080 lamports, mainnet's rate read
2026-10-21. The local chain charges 6,960 a byte, so its own numbers are higher; only bytes carry over.

| Account | Bytes | Mainnet rent, SOL | Local rent, SOL | Paid by |
|---|---|---|---|---|
| fee tier (AmmConfig) | 117 | 0.0012 | 0.0017 | vault |
| pool record (PoolState) | 1,544 | 0.0085 | 0.0116 | pool opener |
| price history (ObservationState) | 4,483 | 0.0234 | 0.0321 | pool opener |
| range map (TickArrayBitmapExtension) | 1,832 | 0.0100 | 0.0136 | pool opener |
| pool vault 0 (WSOL, SPL Token) | 165 | 0.0015 | 0.0020 | pool opener |
| pool vault 1 (BAYLA, Token-2022) | 170 | 0.0015 | 0.0021 | pool opener |
| position record (PersonalPositionState) | 281 | 0.0021 | 0.0028 | LP |
| position NFT mint (Token-2022, with name and link) | 469 | 0.0030 | 0.0042 | LP |
| position NFT account (Token-2022) | 170 | 0.0015 | 0.0021 | LP |
| tick array (a band of 60 prices) | 10,240 | 0.0527 | 0.0722 | first LP whose range needs it |
| position NFT mint without the name record | 202 | 0.0017 | 0.0023 | LP |
| operation account (OperationState) | 3,529 | 0.0186 | 0.0255 | vault |
| reward vault (Token-2022, BAYLA) | 170 | 0.0015 | 0.0021 | reward funder |
| reward vault (SPL Token, REWARD) | 165 | 0.0015 | 0.0020 | reward funder |
| limit order (LimitOrderState) | 173 | 0.0015 | 0.0021 | order owner |
| limit order nonce (LimitOrderNonce) | 81 | 0.0011 | 0.0015 | order owner |
| support-mint pass (SupportMintAssociated) | 105 | 0.0012 | 0.0016 | vault |
| dynamic fee setting (DynamicFeeConfig) | 88 | 0.0011 | 0.0015 | vault |
| Metaplex name record (old path only) | 607 | 0.0037 | 0.0151 | the stranger who chose that path |
| program data account (the program's code) | 1,522,781 | 7.7364 | 10.5994 | deployer |
| program account | 36 | 0.0008 | 0.0011 | deployer |

## Heaviest transactions

| Transaction | Compute units | Bytes (limit 1,232) |
|---|---|---|
| alice swaps 1.5 SOL into pool D, moving its price many steps | 226,292 | 746 |
| a stranger opens a position the old way, with a Metaplex name record | 141,829 | 930 |
| alice adds SOL and USD to pool B | 124,592 | 896 |
| alice: open position | 120,350 | 896 |
| dave: open position | 114,061 | 896 |
| carol: open position | 113,727 | 896 |
| bob: open position | 113,453 | 896 |
| alice adds a narrow range to pool D | 106,832 | 896 |
| dave routes BAYLA -> SOL -> USD | 92,453 | 1026 |
| erin-nometa: open position | 90,692 | 896 |
| dave sells BAYLA for SOL, down through every range | 89,633 | 812 |
| carol withdraws everything | 77,036 | 879 |
| alice opens pool D with the strong dynamic fee | 76,803 | 633 |
| a visitor opens a custom pool: fee in SOL only, dynamic fee on | 70,741 | 665 |

## What surprised us

1. **The vault keeps power over the island's 5.6%.** As admin it can collect the fund share itself, into any
   account, and re-point a tier's fund owner at any time (V6, V9). The same is true of our cp-swap. Each takes a
   vault proposal, so two signatures and the 48-hour lock, which the island can watch for.
2. **The vault cannot pay for rewards today.** Every reward stream, even one a pool's opener pays for, needs the
   operation account first (3,529 bytes, 0.0186 SOL at mainnet's rate), made and paid by the vault. The vault held
   0.0152 SOL on 2026-10-20. Two tiers take 0.0025 more.
3. **Raydium's key list also holds the SPL Memo program.** `solana/guards/upstream/deny-keys.txt` is every key
   Raydium's code writes, less three system keys, so it carries Memo, which every v2 swap and withdrawal must name.
   G1 went red on it in the first run; it now treats Memo as named-only and fails on any other key.
4. **`cargo build-sbf` writes a fresh program key** (`target/deploy/raydium_clmm-keypair.json`) when none exists. A
   plain `solana program deploy` would use it. It was deleted; nothing here used it.
5. **A BAYLA pool's BAYLA vault is 170 bytes, not 165** (Token-2022 adds 5), so a pool is 8,194 bytes. The cost is
   still 0.0449 SOL.
6. **The spare-SOL sweep does not reach LPs' wrapped SOL.** Mainnet's own Token program let the vault sweep exactly
   the 0.1 SOL gift sitting above a wrapped-SOL vault's rent and balance; the LPs' 32.5 SOL stayed (E2).
7. **A reward not yet open can be given any window by the vault** (here 90 s): the 7-day minimum binds only when a
   reward is made, or extended by someone who is not the admin. That is how the whole life of a stream, including
   taking back what it did not pay (604,800 BAYLA), ran in minutes on the release build (R5 to R9).
8. **The old position path still works for anyone** (`open_position_v2` with a Metaplex name record). The stranger
   who uses it leaves 0.01 SOL of their own with Metaplex (X17); the vault pays nothing. The site never offers it.
9. **Once the vault makes any dynamic fee setting, any visitor can open a pool with it, on either tier, with its fee
   taken in one coin only** (X11). The vault should make one only on purpose.
10. **Two things the local chain could not do.** It cannot wait out the real 172,800 s lock: the same Squads check
    refused an early execute at 10 s (T4) and accepted one after (T5). And it cannot sign as the island's Workshop:
    a local key stood in for it in the fund-owner role (V7), then the tier was pointed back at the Workshop (V8).
11. **WSL here has no network, and stops its machine about a minute after the last `wsl.exe` client exits**,
    detached validators and all. The harness reads mainnet from Windows and holds a client open for each run.

## How to run

From `solana/clmm-localnet`, with the frontend's dependencies installed and WSL holding Solana's tools and a build
of the program at `CLMM_SO` (default `/root/clmm-p1/tegridy-clmm/target/deploy/raydium_clmm.so`):

```
node run.mjs                  # setup, fresh validator, the whole suite (about 15 minutes)
node run-mutants.mjs          # every broken input, then a clean run as the restore
node report.mjs               # this file
```
