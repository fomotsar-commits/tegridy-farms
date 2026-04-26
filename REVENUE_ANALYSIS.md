# Tegridy Farms — Revenue Mechanism Analysis

_Prepared 2026-04-17. All figures sourced from the production deploy scripts
(`contracts/script/DeployFinal.s.sol`, `DeployV3Features.s.sol`, `DeploySwapFeeRouterV2.s.sol`,
`DeployAuditFixes.s.sol`, `DeployNFTLending.s.sol`) and verified against each contract's
hard-cap `constant`. "Cap" = the max the contract will let the owner set, even via timelock._

---

## 1. Every revenue lever in the protocol

| # | Lever | Where collected | Current rate | Hard cap | Who pays | Who receives |
|---|-------|-----------------|--------------|----------|----------|--------------|
| 1 | Swap fee (own DEX path) | `SwapFeeRouter.sol` via `swapExactETHForTokens`/`…ForETH` | **mutable state var** — Swap fee is a mutable state var on `SwapFeeRouter` queryable via `feeBps()` getter; default 50 bps (0.50%) configurable via 48h timelock | 1.00 % (`MAX_FEE_BPS = 100`, hard constant) | Swapper | 100 % → `RevenueDistributor` → stakers (pro-rata TOWELI lock-weighted) |
| 2 | Swap fee (Uniswap fallback path) | same | same — `feeBps()` getter (mutable state var) | 1.00 % | Swapper | same |
| 3 | Premium discount on #1/#2 | `SwapFeeRouter.premiumDiscountBps` | **50 %** (`PREMIUM_DISCOUNT_BPS = 5000`) | 100 % | — (discount, not a fee) | Gold Card / Premium subscribers pay 0.25 % instead of 0.50 % |
| 4 | Referral cut of swap fee | `ReferralSplitter.recordFee()` | **20 %** of protocol fee (`REFERRAL_FEE_BPS = 2000` in Final) or **10 %** (V2/AuditFixes). Which actually deployed depends on broadcast — confirm. | — | — (split, not a fee) | Qualifying referrer (≥ 1000 TOWELI voting power); otherwise redirected to treasury |
| 5 | Premium subscription | `PremiumAccess.subscribe` | **0.01 ETH / month** (`PREMIUM_MONTHLY_FEE` in Final) **or 10 000 TOWELI / month** (older) | no cap | Subscriber | Treasury |
| 6 | Launchpad mint fee | `TegridyDropV2` clones initialized by `TegridyLaunchpadV2` (V1 source deleted 2026-04-19) | **5 %** of mint proceeds (`LAUNCHPAD_FEE_BPS = 500`) | 10 % (`MAX_PROTOCOL_FEE_BPS = 1000`) | Minter (indirect — creator nets 95 %) | Platform fee recipient (treasury) |
| 7 | NFT royalty (secondary) | ERC-2981 on each drop | Set per-collection by creator, capped at 100 % | 100 % (creator choice) | Secondary-market buyer | Creator |
| 8 | P2P loan fee (ERC-20 collateral) | `TegridyLending.repayLoan` | **5 % of interest earned** (`LENDING_FEE_BPS = 500`) | 10 % | Borrower (out of interest) | Treasury |
| 9 | P2P loan fee (NFT collateral) | `TegridyNFTLending.repayLoan` | **5 % of interest earned** (`NFT_LENDING_FEE_BPS = 500`) | 10 % | Borrower | Treasury |
| 10 | NFT AMM trade fee | `TegridyNFTPool.swap*` | **0.50 %** (`POOL_FEE_BPS = 50`) | 10 % | Trader | Pool's `protocolFeeRecipient` (factory-configured → treasury) |
| 11 | Vote-incentive (bribe) fee | `VoteIncentives.depositBribe` | **`bribeFeeBps`** (not fixed in scripts — live value via `VoteIncentives.bribeFeeBps()`). Expected 3 % = 300 bps based on `useBribes.ts:27` fallback. | — | Briber | Treasury (splits with voters who claim) |
| 12 | Gauge emissions budget | `GaugeController` | **1 000 000 TOWELI / epoch** (`EMISSION_BUDGET = 1_000_000e18`) | — | Treasury (dilution) | LP Farmers + voted gauges |
| 13 | Staking base rewards | `TegridyStaking` → `RevenueDistributor` | 100 % of #1/#2 | — | — | TOWELI stakers |
| 14 | LP farming rewards | `TegridyLPFarming.notifyRewardAmount` | Arbitrary TOWELI fund from owner, capped at `MAX_REWARD_RATE = 100 TOWELI/sec` | 100/sec | Treasury | LP stakers (boosted by TegridyStaking NFT up to 4.5×) |
| 15 | POL accumulator | `POLAccumulator.accumulate` | Up to `accumulateCap` per cooldown | cooldown + cap configured at deploy | — | Protocol-owned liquidity (locked forever in pair) |

---

## 2. Where the money actually goes

**Revenue in (from users):**
- Swap fees (#1, #2, premium-discounted at #3)
- Premium subs (#5)
- Launchpad mint fee (#6)
- Loan fees on interest (#8, #9)
- NFT AMM trade fee (#10)
- Vote-incentive fee (#11)

**Revenue out (to users):**
- 100 % of swap fees → stakers via `RevenueDistributor`  (#13)
- Referrers keep 10–20 % of the swap fee (#4)
- LP farmers get TOWELI emissions (#14)
- Gauge voters claim bribes (#11)
- NFT royalties → creators (#7)

**Revenue to "the house" (treasury):**
- Launchpad mint fee (5 %)
- Loan protocol fee (5 % of interest)
- NFT AMM trade fee (0.5 %)
- Premium subs (100 %)
- Forfeited referral fees (when referrer < 1000 TOWELI voting power)
- Bribe fees (3 %)

---

## 3. Are we too greedy or too generous? Lever-by-lever verdict

### Too generous (leaving money on the table)

| Lever | Why | Suggested range |
|-------|-----|-----------------|
| **Swap fee → stakers = 100 %** | Uniswap V3 charges 0.30 %/0.05 %/0.01 % and sends **0 %** to holders (LPs + protocol only). We send **100 % to stakers**, zero to treasury. Treasury cannot self-fund dev, bug-bounty, or POL buys — everything has to come from TOWELI emissions (#12) or the 5 %-ish fee surfaces. | Send **80–90 % to stakers, 10–20 % to treasury**. Stakers still win vs. Uni, and treasury gets runway. Change via `proposeFeeChange` on `SwapFeeRouter` is already a 24 h timelock (no contract patch). |
| **LENDING_FEE_BPS = 5 %** | NFTfi charges **5 % of interest** — we match. Gondi charges **0 %**, Arcade charges **2 %**. But our lending is P2P with no order book, so we need the volume — 5 % on top of 0 liquidity is why nobody lends. | Drop to **2–3 % of interest** until we have ≥ $1M TVL. `proposeProtocolFeeChange` timelock covers it. |
| **POOL_FEE_BPS = 0.50 %** (NFT AMM) | Sudoswap charges 0.50 % protocol + 0–100 % creator → we match Sudo's protocol fee. But Sudo has liquidity, we don't. Consider temporary promotional 0.25 % to seed pools. | **0.25 %** launch → 0.50 % once TVL > $500k |
| **Premium discount = 50 %** | Halving the fee for Gold Card holders is **massive generosity** — every Gold Card in circulation is a perpetual 50 % discount forever. If Gold Cards ever trade at ≥ ~6 months of avg swap fee / holder, buying one pays for itself. | Either (a) cap the discount to **first N swaps/month**, (b) time-box it ("first year only"), or (c) reduce to **25–35 %**. |

### Too greedy (will strangle the feature)

| Lever | Why | Suggested range |
|-------|-----|-----------------|
| **LAUNCHPAD_FEE_BPS = 5 %** | Manifold = 2 %, Zora = 5 % + minter fee, Thirdweb = 5 %. Foundation = 15 %, Catalog = 10 %. We're at median — not greedy on paper, **but** we don't have audience, tooling, or distribution vs. Zora/Manifold. Creators will route mints via them. | **3 % launch** — competitive with Manifold, bookend lower than Zora. Ratchet up to 5 % once we have ≥ 100 collections. |
| **Bribe fee = 3 %** | Votium = 4 %, Hidden Hand = 4 %. We're slightly cheaper — _not_ too greedy. But: we're invisible and they have tens of $M. Drop to 2 % and advertise it. | **2 %** |
| **PREMIUM_MONTHLY_FEE = 0.01 ETH** | At ETH = $3k this is $30/mo — **4× Uniswap "Unicorn"/subscription services** and Uniswap doesn't even charge. What do you get for $30? A 50 % swap fee discount. You need to swap **$40k/mo at our volume** just to break even vs the sub fee. Virtually no one will subscribe. | **0.003 ETH/mo** (~ $9) **and** keep 50 % discount — break-even drops to ~$12k swap volume/mo, realistic for engaged users. Or scale the discount by tier (Bronze/Silver/Gold). |

### Rate-about-right

| Lever | Benchmark | Verdict |
|-------|-----------|---------|
| Swap fee 0.50 % | Uniswap V2 = 0.30 %, V3 = 0.05–1.00 %, Sushi = 0.30 %, Curve = 0.04 % for stables | **Slightly high for majors, fair for long-tail.** Most TOWELI volume is the token itself, where users don't have a choice, so 0.50 % is fine. Consider pair-specific `setPairFeeBps` — already supported — to run **0.30 % on TOWELI/WETH** for deep-book competitiveness but 0.50 % on exotic pairs. |
| Referral 20 % of swap fee | Hop Protocol = 10 %, 1inch = 0 %, native Uniswap = 0 %. Most aggregators keep it all. | **Generous but deliberately so** — this is the single best viral loop the protocol has. Keep it. |
| Royalty (creator-set, capped 100 %) | Same everywhere | ✓ |
| Emission budget 1M TOWELI/epoch | N/A — entirely tokenomic, depends on runway | Depends on circulating supply. 1M/week × 52 = 52M/yr; if total = 1B, that's ~5 % annual inflation to LPs. That's **aggressive** but defensible for protocol launch. Plan sunset curve. |

---

## 4. Five concrete calibration moves

1. **Treasury take-rate on swap fees: 0 % → 15 %.**
   Biggest single change. Proposal: `swapFeeRouter.proposeFeeChange(50)` stays at 0.50 %, but route the split as 15 % treasury / 85 % stakers. _Requires a contract patch_ to split in `distributeFeesToStakers()` — currently sends 100 % of `accumulatedETHFees` to `revenueDistributor`. Estimated treasury lift at $500k/mo volume: **$375 / mo**. Scale with volume.

2. **Drop `LAUNCHPAD_FEE_BPS` to 3 % for first 12 months.**
   `launchpad.proposeProtocolFeeChange(300)`. Rationale: we can't out-Manifold Manifold on tooling, so out-cheapen them. Advertise loudly.

3. **Drop `LENDING_FEE_BPS` to 2 % until TVL > $1M.**
   Same timelock path. Peer-rate: Gondi = 0 %.

4. **Cut `PREMIUM_MONTHLY_FEE` to 0.003 ETH.**
   Current $30/mo requires ~$40k/mo swap volume to break even. At $9/mo the break-even is ~$12k/mo — achievable for active users. This is the only change that turns Premium from a vanity feature into real revenue.

5. **Time-box the Premium discount, OR step it per tier.**
   The `premiumDiscountBps = 50 %` *forever* for any JBAC Gold Card holder is a permanent yield drag. Options:
   - **Time-box**: only discount year 1 post-subscribe.
   - **Tier**: Bronze (10 %) / Silver (25 %) / Gold (50 %) — requires `PremiumAccess` refactor.
   - **Cap monthly discount in ETH**: max refund value = 0.01 ETH/mo. Needs new state + check in `SwapFeeRouter.calculateFee`.

---

## 5. What's currently blocked / broken and costing us revenue right now

- **TegridyFeeHook has no deploy script** (blocker B7 in AUDIT_FINDINGS.md). This is the Uniswap V4 hook that would let us collect fees on **external** V4 pools routed through TOWELI. Every swap that happens on V4 today is 0 revenue for us.
- **DCA + Limit Orders are browser-only** — means every closed tab is a missed trade that never reaches `SwapFeeRouter`. Gelato Web3 Functions keeper = ~$50/mo, would unlock real revenue. Do it.
- **ReferralSplitter qualification gate = 1000 TOWELI voting power.** At $0.01/TOWELI that's $10 — fine. At $0.10/TOWELI that's $100 — starts locking out small referrers. Watch this.
- **Launchpad mint feed is mocked, no refund UI, no reveal UI.** Creators cannot use this yet, so #6 earns zero. Top UI priority.
- **Indexer runs but frontend never queries it.** Not directly a revenue issue, but it means we can't show "top referrers", "top briber", or "top gauge winners" leaderboards — those are the social/virality features that drive #1 and #11.

---

## 6. Decision tree — if you want revenue quickly, in order

1. **Unblock launchpad fee (#6)**: ship refund + reveal UI → creators can actually use it → 5 %/3 % of their mint revenue.
2. **Reroute 15 % of swap fee to treasury (#1)**: single contract patch, 24 h timelock, recurring.
3. **Cut PREMIUM_MONTHLY_FEE to 0.003 ETH (#5)**: pricing reality check, recurring.
4. **Ship a DCA/LimitOrder keeper**: converts a broken feature into recurring swap fee volume.
5. **Deploy `TegridyFeeHook` + wire into a V4 pool**: captures swap volume you currently don't see at all.

_End of analysis._
