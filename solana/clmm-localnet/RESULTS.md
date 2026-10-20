# Range pools on a local chain: results

> Step 1 of "What is left, in order" in [docs/RANGE_POOLS_PLAN.md](../../docs/RANGE_POOLS_PLAN.md). The one to-do list is [docs/TODO_OPERATOR.md](../../docs/TODO_OPERATOR.md). This file is written by `report.mjs`; rerun the harness rather than editing it.

**What it means.** The range-pool program (our copy of Raydium's concentrated-liquidity program, built the way a
release would be) ran every instruction a visitor or the venue would use on a local chain, against copies of
mainnet's BAYLA, wrapped SOL, Squads and token programs. 95 checks: 95 pass, none fail.
**No mutant sweep has been run.**
Every admin action was signed by the vault's real address through a real Squads 2-of-2 with a time lock. No path
sent anything to a Raydium address, and the venue's share was collectable only by the vault.

Run 2026-10-20T17:01:45.465Z to 2026-10-20T17:09:55.285Z. Nothing was deployed anywhere, no program key exists, and nothing was
signed or sent on mainnet: mainnet was only read.

## The local chain

- **Program**: `solana/tegridy-clmm` built with `cargo build-sbf --features placeholder-id -- --locked` (the
  release shape CI builds; every role is the vault, so no `devnet`/`localnet` feature and no `test-chain-keys`
  is needed). Solana tools 3.1.11 in WSL (CI pins 3.1.10), sha256 `see manifest`,
  loaded at the placeholder id `RangePoo1PLACEHo1DERnotDep1oyed111111111111` with the vault as upgrade authority.
- **Copied from mainnet** (read at slot 459,305,700, 2026-10-20T17:01Z): the programs Squads v4, Token-2022, SPL Token,
  Associated Token, Memo and Metaplex (each byte-identical to mainnet's, sha256 in the manifest); the BAYLA mint
  `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump`; the wrapped-SOL mint; the Squads multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`;
  Squads' own published IDL. Every address came from `frontend/scripts/addresses.json`, `solana/guards/allowed-keys.json`
  or the frontend's Squads constant.
- **What differs from mainnet, and nothing else**: the multisig's two member keys are local test keys and its
  172,800 s time lock is **10 s** (threshold 2, no config authority and proposal numbering stay
  mainnet's, so its vault 0 is the real vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`); BAYLA's mint had a local mint authority
  until the test wallets were funded, then none, as on mainnet (check S2); the 29 runtime features mainnet has not
  switched on were switched off (`features.mjs`), including the raise of the program-call depth limit from 4 to 8.
- **Starting price**: the venue's BAYLA/SOL pool on mainnet, 5.9711e-6 SOL per BAYLA.

## Every check

"Red first" names the broken input each check was run against before it passed: the check had to come out FAIL on
it. Checks with no broken input of their own: S0, S1, S2, S3, T1, T2, T3, T4, T5, T6, T7, T8, T9, P1, P2, P3, L1, L2, L3, L4, L5, L6, L7, L9, L8, W1, W2, W3, W4, W5, W6, W7, F1, F2, F3, F4, F5, V1, V2, V3, V5, V6, V7, V8, R1, R2, R3, R4, R5, R6, R7A, R7, R8, R9, R10, R12, R11, O1, O2, O3, O4, O5, O6, O7, O8, O9, A3, A1, A2, V9, E3, E1, E2, C1, X1, X2, X3, X4, X6, X7, X8, X9, X10, X11, X12, X13, X14, X15, X16, X17, G1, G2, G3, G4, G5. Each of these reads a value an earlier red-first check already guards, or is a setup fact.

| ID | Instruction | What was checked | Clean run | Red first | Counts |
|---|---|---|---|---|---|
| S0 | `setup` | vault 0 of the multisig (registry row squads-multisig) is the registry vault | pass | no broken input (see below) | GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd |
| S1 | `setup` | local multisig: 2 of 2, members are the two local keys, lock 10 s (mainnet 172800 s, threshold 2) | pass | no broken input (see below) | next proposal 15, as on mainnet |
| S2 | `setup` | BAYLA's mint is mainnet's byte for byte, except its supply (the test wallets' coins) | pass | no broken input (see below) | 408 bytes, 472,000,000 BAYLA minted locally |
| S3 | `setup` | the vault's wrapped-SOL account here is the one the registry names (cpswap-fee-receiver-wsol-ata) | pass | no broken input (see below) | 2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa |
| T1 | `create_amm_config` | a stranger cannot make a fee tier | pass | no broken input (see below) | refused: NotApproved |
| T2 | `Squads: vault_transaction_execute` | one approval of two cannot execute a vault action | pass | no broken input (see below) | proposal 15: Active, execute InvalidProposalStatus |
| T3 | `Squads: proposal_approve` | someone outside the multisig cannot approve | pass | no broken input (see below) | refused: NotAMember |
| T4 | `Squads: vault_transaction_execute` | an execute sent before the 10 s lock runs out is refused, and the proposal stays approved | pass | no broken input (see below) | refused: TimeLockNotReleased |
| T5 | `create_amm_config` | the vault makes fee tier 0 through Squads, executed only after the lock | pass | no broken input (see below) | proposal 16, executed 10 s after the second approval |
| T6 | `create_amm_config + update_amm_config` | one proposal makes tier 0 (1%, spacing 120) with the split: 104,000 per million of each fee to the venue (owner: the vault), 56,000 to the island (fund owner: its Workshop) | pass | no broken input (see below) | protocol 104000, fund 56000 per million; fund owner G2EHPseT... |
| T7 | `create_amm_config + update_amm_config` | one proposal makes tier 1 (0.25%, spacing 60) with the same split and the same two owners | pass | no broken input (see below) | proposal 17 |
| T8 | `update_amm_config` | a stranger cannot change a fee tier | pass | no broken input (see below) | refused: NotApproved |
| T9 | `update_amm_config` | the vault changes a tier and changes it back | pass | no broken input (see below) | 100000 then 104000 per million |
| P1 | `create_pool` | the pool opens with the given price, no liquidity, empty vaults, opener as owner | pass | no broken input (see below) | 1 BAYLA = 5.9711e-6 SOL, tick 51210 |
| P2 | `create_pool` | opening takes no coins from the opener: only the rent of its five accounts and the fee | pass | no broken input (see below) | 0.06148464 SOL rent locally |
| P3 | `create_pool` | a pool opens on the 0.25% tier with spacing 60 | pass | no broken input (see below) | tick -17149 |
| L1 | `open_position_with_token22_nft` | a range around the price takes both coins, within the caps, and the pool vaults receive exactly that | pass | no broken input (see below) | 3,999,999.999998 BAYLA + 23.758005772 SOL, ticks 42000..60360, 120060 CU |
| L2 | `open_position_with_token22_nft` | the position is a Token-2022 NFT (supply 1, 0 decimals) held by its owner, named "Memetics Range Position", "MEM-RANGE", linking memetics.finance/position/<position>.json | pass | no broken input (see below) | https://memetics.finance/position/5hWVFeqt8kP9BcopLbtwzj5casYfoUc76fpmkcB1WSsu.json |
| L3 | `open_position_with_token22_nft` | a BAYLA-only position above the price takes BAYLA and not one lamport of SOL | pass | no broken input (see below) | 4,999,999.999999 BAYLA, 0 lamports, ticks 40200..48480 |
| L4 | `open_position_with_token22_nft` | a SOL-only position below the price takes SOL and not one unit of BAYLA | pass | no broken input (see below) | 15 SOL, 0 BAYLA base units, ticks 53760..62160 |
| L5 | `open_position_with_token22_nft` | a far-away BAYLA-only position opens (it should earn nothing below) | pass | no broken input (see below) | ticks 14280..21240 |
| L6 | `open_position_with_token22_nft` | without the name record the NFT mint is smaller (a choice the client makes) | pass | no broken input (see below) | 202 vs 469 bytes |
| L7 | `increase_liquidity_v2` | adding to a position raises its liquidity and takes both coins | pass | no broken input (see below) | +1,999,999.999997 BAYLA, +11.879002886 SOL, 49220 CU |
| L9 | `decrease_liquidity_v2` | removing a quarter lowers liquidity by exactly that and pays both coins back to the owner | pass | no broken input (see below) | 1,499,999.999997 BAYLA, 8.909252164 SOL back, 45582 CU |
| L8 | `decrease_liquidity_v2` | only the holder of the position NFT can withdraw from it | pass | no broken input (see below) | refused: ConstraintTokenOwner |
| W1 | `swap_v2` | a buy moves the price up into the BAYLA-only range and across into another tick array | pass | no broken input (see below) | 5.9711e-6 -> 1.3136e-5 SOL per BAYLA, 1 array boundary crossed, 68877 CU |
| W2 | `swap_v2` | the trader's coins and the pool's vaults move by exactly the same amounts | pass | no broken input (see below) | paid 69.985831379 SOL, got 7,333,378.874345 BAYLA |
| W3 | `swap_v2` | of a 1% swap, 0.104% of what the trader paid waits for the venue and 0.056% for the island | pass | no broken input (see below) | venue 0.072785263 SOL (0.10400%), island 0.039192064 SOL (0.05600%) of 69.985831379 SOL |
| W4 | `swap_v2` | a sell moves the price the other way, across several tick arrays, into the SOL-only range | pass | no broken input (see below) | 1.3136e-5 -> 2.9855e-6, 2 boundaries, 87046 CU |
| W5 | `swap_v2` | the same split in the other coin | pass | no broken input (see below) | venue 15,456.652566 BAYLA (0.10400%), island 8,322.812919 BAYLA (0.05600%) |
| W6 | `swap_v2` | an exact-output buy delivers exactly what was asked, for no more than the cap | pass | no broken input (see below) | got 100,000 BAYLA for 0.302611754 SOL |
| W7 | `swap_v2` | a swap that would pay less than the trader asked is refused and moves nothing | pass | no broken input (see below) | refused: TooLittleOutputReceived |
| F1 | `decrease_liquidity_v2 (0)` | the wide range collects fees in both coins and keeps its liquidity | pass | no broken input (see below) | 76,562.713715 BAYLA + 0.300043184 SOL |
| F2 | `decrease_liquidity_v2 (0)` | the BAYLA-only range, which both swaps passed, earned fees in both coins | pass | no broken input (see below) | 28,430.083303 BAYLA + 0.288627707 SOL |
| F3 | `decrease_liquidity_v2 (0)` | the SOL-only range earned BAYLA fees from the sell that reached it | pass | no broken input (see below) | 19,647.513229 BAYLA + 0.001030884 SOL |
| F4 | `decrease_liquidity_v2 (0)` | a range no swap reached earned nothing | pass | no broken input (see below) | 0 + 0 base units |
| F5 | `swap_v2 + decrease_liquidity_v2` | of every fee the LPs collected 84%, 10.4% waits for the venue and 5.6% for the island; together they are 1% of what traders paid | pass | no broken input (see below) | BAYLA: LPs 84.000%, venue 10.400%, island 5.600%; SOL: LPs 84.000%, venue 10.400%, island 5.600%; fee 1.000% and 1.000% of input |
| V1 | `collect_protocol_fee` | a stranger cannot collect the venue's share | pass | no broken input (see below) | refused: NotApproved |
| V2 | `collect_protocol_fee` | the vault collects exactly the venue's share that built up, and the pool's count goes to zero | pass | no broken input (see below) | 15,456.652566 BAYLA + 0.073099979 SOL, proposal 20 |
| V3 | `collect_protocol_fee` | the venue's share landed in token accounts the vault owns | pass | no broken input (see below) | GRMtSx, GRMtSx |
| V5 | `collect_fund_fee` | a stranger cannot collect the island's share | pass | no broken input (see below) | refused: NotApproved |
| V6 | `update_amm_config (param 4)` | the vault can point a tier's fund share at any account, at any time (an admin path over the island's share) | pass | no broken input (see below) | fund owner re-pointed by one vault proposal |
| V7 | `collect_fund_fee` | the fund owner collects exactly the island's share that built up, into its own accounts | pass | no broken input (see below) | 8,322.812919 BAYLA + 0.039361525 SOL |
| V8 | `update_amm_config (param 4)` | tier 0's fund owner is the Workshop again | pass | no broken input (see below) |  |
| R1 | `create_operation_account` | the vault creates the operation account rewards need | pass | no broken input (see below) |  |
| R2 | `initialize_reward` | the vault funds a 1 BAYLA a second reward for 7 days: exactly 604,800 BAYLA leave the vault for the reward vault | pass | no broken input (see below) | 604,800 BAYLA |
| R3 | `initialize_reward` | a stranger cannot set up a reward on the pool | pass | no broken input (see below) | refused: NotApproved |
| R4 | `initialize_reward` | the pool's opener funds a second reward from her own coins | pass | no broken input (see below) | 302,400 REWARD |
| R5 | `set_reward_params` | before a reward opens, the vault can move its window (here to 90 s, paying 90 BAYLA more) | pass | no broken input (see below) | window 1792515957..1792516047, paid 90 BAYLA |
| R6 | `update_reward_infos` | anyone can bring the reward counters up to date | pass | no broken input (see below) | 6130 CU |
| R7A | `decrease_liquidity_v2 (rewards)` | an LP in range collects both rewards, no more than the stream paid so far | pass | no broken input (see below) | 17.802444 BAYLA after 30 s, 13.351833 REWARD |
| R7 | `decrease_liquidity_v2 (rewards)` | a position out of range earns no reward | pass | no broken input (see below) | 0 + 0 base units |
| R8 | `decrease_liquidity_v2 (rewards)` | over the whole window the LPs together collect what the stream emitted (90 BAYLA), never more | pass | no broken input (see below) | 89.999999 of 90 BAYLA |
| R9 | `collect_remaining_rewards` | after the end the vault takes back everything the stream did not owe | pass | no broken input (see below) | 604,800 BAYLA back |
| R10 | `collect_remaining_rewards` | a reward still running cannot be taken back | pass | no broken input (see below) | refused: NotApproved |
| R12 | `transfer_reward_owner` | a stranger cannot take over a pool's rewards | pass | no broken input (see below) | refused: NotApproved |
| R11 | `transfer_reward_owner` | the vault can hand a pool's owner and reward authority to someone else | pass | no broken input (see below) | pool B owner: bob |
| O1 | `open_limit_order` | the order takes exactly its BAYLA into the pool and records owner, price and side | pass | no broken input (see below) | tick 56280 (3.5968e-6 SOL per BAYLA) |
| O2 | `increase_limit_order` | adding to an order raises its total | pass | no broken input (see below) | 1,500,000 BAYLA |
| O3 | `decrease_limit_order` | cutting an unfilled order pays the coins back to its owner | pass | no broken input (see below) | 200,000 BAYLA back |
| O4 | `swap_v2 (fills the order)` | a buy moves the price past the order | pass | no broken input (see below) | 3.0062e-6 -> 4.4783e-6 |
| O5 | `settle_limit_order` | a stranger cannot settle someone's order | pass | no broken input (see below) | refused: ConstraintRaw |
| O6 | `settle_limit_order` | the keeper (the vault) cannot settle an order into its own account | pass | no broken input (see below) | refused: ConstraintTokenOwner |
| O7 | `settle_limit_order` | the keeper settles the filled order; the SOL goes to the order's owner, at the order's price, and the vault gets nothing | pass | no broken input (see below) | 4.675803056 SOL for 1,300,000 BAYLA (expected 4.675803), proposal 29 |
| O8 | `close_limit_order` | closing the order refunds its rent to the order's owner, none to the keeper | pass | no broken input (see below) | 0.00209496 SOL to erin |
| O9 | `decrease_limit_order + close_limit_order` | an owner can cancel an order in full and close it herself | pass | no broken input (see below) | all 200,000 BAYLA and 0.00209496 SOL rent back |
| A3 | `update_pool_status` | a stranger cannot pause a pool | pass | no broken input (see below) | refused: ConstraintAddress |
| A1 | `update_pool_status` | when the vault pauses swaps, a swap is refused | pass | no broken input (see below) | refused: NotApproved |
| A2 | `update_pool_status` | after the vault lifts the pause, swaps work again | pass | no broken input (see below) | 219,025.587978 BAYLA |
| V9 | `collect_fund_fee` | the vault, as admin, can also collect the island's share itself, into its own accounts, while the Workshop is the fund owner (the program allows the admin or the fund owner, as cp-swap does) | pass | no broken input (see below) | 0 BAYLA + 0.01406464 SOL to the vault, proposal 33 |
| E3 | `collect_excess_lamports` | a stranger cannot sweep spare SOL | pass | no broken input (see below) | refused: NotApproved |
| E1 | `collect_excess_lamports` | the vault receives exactly the spare SOL, and the BAYLA in the pool is untouched | pass | no broken input (see below) | 0.8 SOL to the vault |
| E2 | `collect_excess_lamports` | the sweep cannot take LPs' SOL out of the wrapped-SOL vault: its balance and lamports are unchanged | pass | no broken input (see below) | swept only the 0.1 SOL gift; balance 32.520705163 SOL kept |
| C1 | `close_position` | closing burns the NFT, closes its mint, account and record, and refunds all three rents to the owner | pass | no broken input (see below) | 0.00906888 SOL back |
| X1 | `update_operation_account` | a stranger cannot make anyone an operator | pass | no broken input (see below) | refused: NotApproved |
| X2 | `update_operation_account + initialize_reward` | the third reward may only be set up by the vault or an operator: carol, made an operator by the vault, can | pass | no broken input (see below) | 0.6048 USD funded |
| X3 | `update_operation_account` | the vault adds and removes operators and whitelisted reward coins | pass | no broken input (see below) | add, remove, both seen |
| X4 | `create_pool` | a coin with an unusual Token-2022 feature (a permanent delegate) cannot get a pool by default | pass | no broken input (see below) | refused: NotSupportMint |
| X6 | `create_support_mint_associated` | a stranger cannot let an unusual coin in | pass | no broken input (see below) | refused: NotApproved |
| X7 | `create_pool + create_support_mint_associated` | once the vault lets a coin in, anyone can open its pool | pass | no broken input (see below) | pool opened |
| X8 | `close_support_mint_associated` | the vault can withdraw the pass | pass | no broken input (see below) | closed |
| X9 | `create_dynamic_fee_config` | a stranger cannot make a dynamic fee setting | pass | no broken input (see below) | refused: NotApproved |
| X10 | `create_dynamic_fee_config + update_dynamic_fee_config` | the vault makes a dynamic fee setting and changes it | pass | no broken input (see below) | decay 600 -> 900 s |
| X11 | `create_customizable_pool` | anyone can open a pool that takes its fee in one coin only, with the dynamic fee the vault set | pass | no broken input (see below) | fee_on 1, decay 900 s |
| X12 | `create_permission_pda` | a stranger cannot grant the right to open extra pools | pass | no broken input (see below) | refused: NotApproved |
| X13 | `create_permissioned_pool` | a permission holder can open another pool for a pair that has one | pass | no broken input (see below) | pool #1 opened |
| X14 | `close_permission_pda` | once the vault withdraws the permission, no more extra pools | pass | no broken input (see below) | refused: AccountNotInitialized |
| X15 | `swap_router_base_in` | a two-hop route through both tiers spends exactly the BAYLA in, pays USD out, and leaves no SOL behind | pass | no broken input (see below) | 100,000 BAYLA -> 79.236486 USD, 92852 CU, 1026 bytes |
| X16 | `swap (old)` | the old swap cannot move a Token-2022 coin, so it cannot trade BAYLA | pass | no broken input (see below) | refused: AccountOwnedByWrongProgram |
| X17 | `open_position_v2` | the old path still works for a stranger, who pays Metaplex from her own wallet; the vault pays nothing | pass | no broken input (see below) | Metaplex name record 607 bytes; 0.01 SOL above its rent stays in it as Metaplex's fee |
| G1 | `every transaction` | no transaction touched any of the 39 keys Raydium's code hard-codes, except the SPL Memo program, which the deny list also carries; it was only named, never paid | pass | no broken input (see below) | 188 transactions, 188 accounts; Memo named in 25; no other deny key |
| G2 | `every transaction` | every account any transaction touched is one this run made or named (wallets, vault, pools, programs) | pass | no broken input (see below) | 188 accounts, all named |
| G3 | `every transaction` | every coin that moved anywhere landed with a test wallet, the vault or a pool | pass | no broken input (see below) | all landed with named owners |
| G4 | `the program itself` | the running program's bytes hold none of Raydium's 39 keys, as bytes or as text | pass | no broken input (see below) | 1523176 bytes searched |
| G5 | `the program itself` | the local program sits at the placeholder id with the vault as its upgrade authority (the deploy pack decides the real one) | pass | no broken input (see below) | program data 1523221 bytes |

## Instructions covered

| Instruction | Checks |
|---|---|
| `create_amm_config` | T1, T5, T6, T7 |
| `create_support_mint_associated` | X6, X7 |
| `update_amm_config` | T6, T7, T8, T9, V6, V8 |
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
| `collect_remaining_rewards` | R9, R10 |
| `update_reward_infos` | R6 |
| `set_reward_params` | R5 |
| `collect_protocol_fee` | V1, V2, V3 |
| `collect_fund_fee` | V5, V7, V9 |
| `open_position` | not run: deprecated: makes an SPL Token NFT with a Metaplex name record; open_position_v2 (X17) covers that path |
| `open_position_v2` | X17 |
| `open_position_with_token22_nft` | L1, L2, L3, L4, L5, L6 |
| `close_position` | C1 |
| `increase_liquidity` | not run: deprecated, SPL Token only: it cannot move BAYLA (Token-2022), as the old swap cannot (X16) |
| `increase_liquidity_v2` | L7 |
| `decrease_liquidity` | not run: deprecated, SPL Token only, for the same reason |
| `decrease_liquidity_v2` | L9, L8, F1, F2, F3, F4, F5, R7A, R7, R8 |
| `swap` | X16 |
| `swap_v2` | W1, W2, W3, W4, W5, W6, W7, F5, O4 |
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
2026-10-20. The local chain charges 6,960 a byte, so its own numbers are higher; only bytes carry over.

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
| program data account (the program's code) | 1,523,221 | 7.7386 | 10.6025 | deployer |
| program account | 36 | 0.0008 | 0.0011 | deployer |

## Heaviest transactions

| Transaction | Compute units | Bytes (limit 1,232) |
|---|---|---|
| a stranger opens a position the old way, with a Metaplex name record | 139,150 | 930 |
| alice: open position | 120,060 | 896 |
| dave: open position | 118,675 | 896 |
| alice adds SOL and USD to pool B | 114,078 | 896 |
| carol: open position | 110,728 | 896 |
| bob: open position | 107,461 | 896 |
| dave routes BAYLA -> SOL -> USD | 92,852 | 1026 |
| erin-nometa: open position | 90,799 | 896 |
| dave sells BAYLA for SOL, down through every range | 87,046 | 779 |
| carol withdraws everything | 77,179 | 879 |
| a visitor opens a custom pool: fee in SOL only, dynamic fee on | 70,919 | 665 |
| dave buys BAYLA with SOL, up through two ranges | 68,877 | 845 |
| carol: collect rewards after the end | 65,862 | 879 |
| dave opens the ODD pool with the pass | 65,831 | 671 |

## How to run

From `solana/clmm-localnet`, with the frontend's dependencies installed and WSL holding Solana's tools and a build
of the program at `CLMM_SO` (default `/root/clmm-p1/tegridy-clmm/target/deploy/raydium_clmm.so`):

```
node run.mjs                  # setup, fresh validator, the whole suite (about 15 minutes)
node run-mutants.mjs          # every broken input, then a clean run as the restore
node report.mjs               # this file
```
