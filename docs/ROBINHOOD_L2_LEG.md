# Robinhood Chain (4663) leg — what ships, what doesn't, and the one honest compromise

**Written 2026-08-20.** Companion to [BASE_L2_GO_NO_GO.md](./BASE_L2_GO_NO_GO.md); everything
that memo says about why staking/RevenueDistributor/ReferralSplitter/POLAccumulator stay off
an L2 applies here verbatim and is not repeated.

## Chain facts (verified on-chain 2026-08-20, block 42,788,875)

| Fact | Value | How verified |
|---|---|---|
| Chain ID | **4663** (testnet is 46630 — scripts refuse it) | `cast chain-id` vs `https://rpc.mainnet.chain.robinhood.com` |
| Stack | Arbitrum Orbit (Nitro), ETH gas, blob DA | docs.robinhood.com/chain; ArbSys precompile carries code |
| Canonical WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `symbol()`/`name()` "WETH", 18 decimals; matches official contracts page + Doppler SDK |
| Explorer | robinhoodchain.blockscout.com (Blockscout, NOT Etherscan v2) | docs.robinhood.com/chain/connecting |
| Safe infra | 1.3.0 + 1.4.1 proxy factories AND the 1.4.1 L2 singleton carry code | `cast code` on canonical addresses |
| Multicall3 | deployed at the canonical address | `cast code` |
| **Chainlink sequencer uptime feed** | **NONE** | Chainlink L2 sequencer-feeds directory lists Base/Arbitrum/OP/…, not 4663 |

## The compromise: an attested uptime feed

`SequencerCheck` (audit H-9) refuses a zero feed on any chain but mainnet, and the feed is
consumed by the SwapFeeRouter conversion path (via `SwapFeeRouterConvertLib`), TegridyTWAP,
and every `TegridyDropV2` dutch-auction mint — where it is **baked immutably into every clone
the launchpad ever creates**. With no Chainlink feed the choice was: no Robinhood leg at all,
or a stand-in.

The stand-in is [`src/AttestedSequencerUptimeFeed.sol`](../contracts/src/AttestedSequencerUptimeFeed.sol):
Chainlink's exact uptime dialect (`answer` 0/1, `startedAt` = when the answer was set, so
consumers' grace windows work unchanged), flipped by the **PAUSE_GUARDIAN Safe** (whose
existing job is already "notice an incident and act"), owned by the MULTISIG Safe, and
**one-shot forwardable** to the real Chainlink feed the day one ships — after which every
manual control is dead forever and no consumer redeploys (that forwarding is why consumers
point at this address instead of waiting: TWAP's feed is immutable).

Stated honestly: **attested ≠ observed.** If the attestor sleeps through a real outage,
consumers get no post-resume grace and can read pre-outage AMM state — the exact risk
Chainlink automates away. Bounded by: the attestor is a hot Safe with an incident runbook,
the flip is in that runbook, and the surface disappears at `forwardTo`. Every runbook printed
by the deploy scripts says this out loud.

## What ships on 4663

| Leg | Script | Contents |
|---|---|---|
| MVP spine | `script/robinhood/DeployRobinhoodMVP.s.sol` | AttestedSequencerUptimeFeed (skipped if a real feed address is passed), TegridyFactory (guardian = Safe **at construction** — no rotation, see the F-30-10 lesson), TegridyRouter, TegridyTWAP, SwapFeeRouter (sink = FEE_REMITTANCE Safe), SwapFeeRouterAdmin |
| Verify | `script/robinhood/VerifyRobinhoodMVP.s.sol` | R-INV-0..14, incl. attestor/owner checks on the stand-in and the uptime-dialect probe |
| Launch rail | `script/robinhood/DeployRobinhoodLaunchRail.s.sol` | TegridyLaunchpadV2 (+DropV2 template), LockVault, VestingFactory, AirdropFactory, LaunchRugEscrow (openings ship DISABLED), LaunchLockView. Guardians wired pre-transfer. **Requires the deployed uptime feed — run the MVP leg first.** |
| LP farming | `script/robinhood/DeployRobinhoodLPFarming.s.sol` | NullBoost (flat 1.0x — no veTOWELI here to boost with) + TegridyLPFarming against an operator-chosen 18-decimal reward token. **The reward token is economics, not engineering — the script refuses to pick one.** |

Base gets the same two new legs (`script/base/DeployBaseLaunchRail.s.sol`,
`DeployBaseLPFarming.s.sol`) with the real Chainlink feed
`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` as the default.

Deploy order on 4663: Safes ceremony (4 disjoint, proven signers) → `DeployRobinhoodMVP` →
Safe accepts ×4 + `acceptFeeToSetter` (24h) → `VerifyRobinhoodMVP` green →
`DeployRobinhoodLaunchRail` (feed = the deployed stand-in) → rail accepts ×5 →
farming only after a pair exists and a reward token is chosen.

## What deliberately does NOT ship

- **Staking / RevenueDistributor / ReferralSplitter / POLAccumulator** — Base memo reasons,
  unchanged. `FeesDistributed` on 4663 means "queued for the bridge", not "paid to stakers".
- **The Doppler token-launcher rail on 4663** — the SDK has a 4663 address book, but the
  chain has **no UniswapV4Migrator and no V1 StreamableFeesLocker** (V2-only, different key
  shape). Our current migration policy (`uniswapV4` + V1 locker) structurally cannot run
  there; picking a replacement (UniswapV2MigratorSplit into OUR factory pair would match the
  own-venue directive) is a product decision with its own verification pass — tracked as
  follow-up, not smuggled into this leg. Doppler-on-Base has full module parity and needs
  only the per-chain address book on the frontend side.
- **Dutch-auction grace constants review** — DropV2's 4h `SEQUENCER_GRACE_PERIOD` is
  compile-time and was tuned on Arbitrum/Base history; 4663 inherits it. Revisit only with
  outage data.

## Frontend contract-behavior notes (for the chain-aware surfaces)

- `DropV2.currentPrice()` returns `type(uint256).max` as an outage sentinel on L2s, and its
  view path no-ops on a zero feed while `mint()` reverts — UIs must render "minting paused",
  never a buy button, when they see the sentinel.
- Per-chain factory addresses mean per-chain `CollectionCreated*` indexing and a per-chain
  section in `frontend/scripts/addresses.json` (the single-source registry).
