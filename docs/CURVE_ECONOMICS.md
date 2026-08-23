# Own-curve economics — the numbers, and why (2026-08-23)

The owner set the reserve (3.69%) and asked me to research the competition and pick the
**graduation targets** and the **fee split**. This is the reasoning and the resulting
defaults, all encoded in `script/curve/DeployCurveLauncher.s.sol` (overridable per deploy).

## Fee split — 40% creator / 25% treasury / 35% protocol (of the 1% trade fee)

The 1% trade fee is split three ways in `TegridyCurveLauncher._accrueFee`: creator and
treasury take their exact bps shares (rounding down), and **protocol keeps the remainder**,
so the three always sum to exactly the fee. `creator + treasury <= 10000` is enforced at
config time.

| bucket | share | who / why |
|---|---|---|
| **Creator** | **40%** | The volume magnet. Distribution — not fee mechanics — is what wins launchpad markets, and creators bring the order flow. 40% matches **Clanker** (40% creator / 60% protocol) and sits below **pump.fun** (~50% via Project Ascend) and our own **Meteora/Solana** parity (48%). We can run below the max because we *also* give the creator's launch graduate-to-us LP **and** the 3.69% survival reserve — total creator+ecosystem value is competitive even at 40%. |
| **Jungle Bay treasury** | **25%** | Ecosystem survival funding — buybacks / bid-wall / community grants. A SECOND ecosystem stream alongside the supply reserve, and the "fee-recycling → bid-wall" lever that the survivors of the 2024–25 launchpad wars converged on (supply-mining is the documented dead pattern). Swept permissionlessly to the treasury address. |
| **Protocol** | **35%** | Keeps the launchpad's own lights on (dev, infra, the rails). The protocol is capital-starved, so this is a real, load-bearing 35% — the remainder after creator + treasury. |

Benchmarks that set the frame (2025–26, researched):
- **Clanker** (Base): 1% swap fee → 40% creator / 60% protocol.
- **pump.fun**: 1% trade fee; Project Ascend / Dynamic Fees routed up to ~50% to creators;
  Jan 2026 added multi-wallet fee splitting.
- **BonkFun "Classic"**: 0% creator (all to liquidity depth); "BONKERS" flips creator up.
- **Virtuals** (Base): 1% trading fee, 42k VIRTUAL graduation, 10-yr LP lock.
- **Meteora DBC / our Solana curve**: 48% creator.

The split is per-launch config (snapshotted at create), so it can be re-tuned for future
launches without touching live ones. All three destinations are addresses the owner
controls: `treasury` (owner-settable, permissionless sweep), protocol (owner withdraw),
creator (creator pull).

## Graduation targets — per chain, tuned for "projects actually succeed"

The graduation target is the real ETH/SOL a curve raises before it completes and seeds the
pool. The tension, from the research: pump.fun graduates at ~85 SOL (~$12–15k) and **under
2% of tokens ever graduate**; Virtuals sits higher (~$42k+) — deeper pools, even fewer
graduations. Too low → a shallow pool that rugs on the first sell; too high → almost
nothing graduates.

Our edge lets us sit at or slightly below the proven bar: the **3.69% reserve** backstops
post-graduation depth/incentives, and the **heat score** curates which launches get in at
all — so a given graduation target yields a healthier pool for us than the same number does
for an uncurated venue. That argues for targets that maximize the graduation *rate* while
the reserve keeps the graduated pool viable.

| chain | default graduation target | rationale |
|---|---|---|
| **Ethereum mainnet** | **4 ETH** | Fewer, more serious launches; high gas filters tourists. ~$7–8k raise → a pool the reserve tops up. Higher would strand most launches below the line. |
| **Base (8453)** | **2 ETH** | Cheap gas, high retail throughput — the pump.fun-shaped degen venue. A lower bar lifts the graduation rate; ~$3.5–4k + reserve is a viable PumpSwap-class pool. |
| **Robinhood (4663)** | **1.5 ETH** | A nascent chain with thin liquidity — the lowest bar so up-and-coming projects can actually reach graduation and seed the chain's first real pools. |
| **Solana (own curve)** | **~75 SOL** (recommended in MAINNET_RUNBOOK §5b) | Slightly below pump.fun's ~85 SOL to graduate MORE projects, still deep enough to clear Jupiter's routing threshold. The Solana program computes the continuity-exact target from this raise; keep the 2-way creator/protocol split there (a treasury bucket on Solana is a Rust change + re-audit — the treasury cut folds into the protocol share for now). |

Each EVM target implies `virtualEth = graduationEth / 19` (the price-continuity default —
the pool lists within 5% of the final curve price, so no rug-shaped candle at graduation).
The price rises ~20× from the opening buy to graduation, standard for the shape.

**These are defaults, not commitments.** Every value is an env override on the deploy
script (`GRADUATION_ETH_WEI`, `CREATOR_FEE_SHARE_BPS`, `TREASURY_FEE_SHARE_BPS`, …), and the
per-launch config setter re-tunes future launches on-chain. Re-derive against live prices at
deploy time — the dollar figures above move with ETH/SOL, the token amounts don't.
