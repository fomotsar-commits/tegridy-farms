# Tegriddy Farms V2 Roadmap
## Issues to bundle into the next redeployment

### HIGH PRIORITY — Economic/Product

1. **Route fees to RevenueDistributor automatically**
   - SwapFeeRouter: add `withdrawFeesToDistributor(address revDist)` that sends accumulated ETH directly
   - Or: make RevenueDistributor an approved fee destination in SwapFeeRouter
   - Currently: fees go to treasury, owner must manually forward

2. **Boost decay for expired locks**
   - Expired positions keep earning boosted rewards until withdrawn
   - Fix: zero `boostedAmount` when `block.timestamp >= lockEnd` in the reward math
   - Or: Curve-style linear decay over lock duration

3. **Gauge voting system for VoteIncentives**
   - Currently bribes are dividends to all stakers regardless of votes
   - Need: `vote(epoch, pair)` function, only voters for a pair claim that pair's bribes
   - Reference: Velodrome/Aerodrome gauge model

4. **Add increaseAmount() to TegridyStaking**
   - Users currently can't add tokens to existing positions
   - Must withdraw (with penalty if locked) and re-stake

### MEDIUM PRIORITY — Gas/Architecture

5. **Remove dead penalty code from TegridyStaking**
   - `totalPenaltyUnclaimed`, `totalPenaltyAccumulated`, `totalRewardsAccumulated` — always 0
   - Read via `_reserved()` on every updateReward call — ~6,300 gas wasted per tx
   - `reconcilePenaltyDust()` — manages a variable that's always 0
   - `totalPenaltiesRedistributed` — misleading name, tracks treasury sends

6. **Redeploy TegridyFactory with timelocks**
   - Current factory has instant `setFeeTo()` — no timelock, no 2-step
   - Should match the timelock pattern used in all other contracts
   - Also: feeToSetter key (`0x0c41e76D...`) needs to be recovered or transferred

7. **Make CommunityGrants PROPOSAL_FEE configurable**
   - Currently `constant` at 42,069 TOWELI — can't change without redeployment
   - Add timelocked setter with min/max bounds

8. **Deploy tokenURI reader contract**
   - Position NFTs show blank on marketplaces
   - Deploy external contract for on-chain SVG metadata
   - TegridyStaking.tokenURI() delegates to the reader

9. **Add voting power delegation**
   - Implement IVotes interface (OZ ERC721Votes pattern)
   - Users can delegate without transferring NFT
   - Enables DAO tooling (Tally, Snapshot on-chain mode)

### LOW PRIORITY — Nice-to-Have

10. **Checkpoint totalBoostedStake**
    - Currently live uint256, not historically queryable
    - Add OZ Checkpoints.Trace208 for consistent denominator in epoch claims

11. **Auto-compound option**
    - Claim rewards → re-stake in single tx
    - Or: external compounder contract (Beefy-style)

12. **L2 deployment scripts**
    - Add Base/Arbitrum deploy configs
    - Chain-specific WETH, router addresses

13. **Event indexing setup**
    - Subgraph schema or Ponder config
    - Historical position/claim/distribution queries

14. **On-chain TWAP oracle for POLAccumulator**
    - Backstop for off-chain slippage params
    - Removes Flashbots Protect dependency

15. **Fix IVotingEscrow interface field names**
    - RevenueDistributor, VoteIncentives, CommunityGrants
    - Names are cosmetically wrong (ABI positions are correct)
    - Clean up for code clarity

### NOT DOING

- **Proxy/upgradeability pattern** — Immutable contracts are a feature, not a bug. Users trust that code can't change under them. Migration is the tradeoff.
- **Permissionless pair creation fee** — Matches Uniswap V2. Gas cost of CREATE2 is the natural deterrent.
- **ACC_PRECISION upgrade to 1e18** — Would require full migration of all positions. Current 1e12 is safe for realistic parameters.
