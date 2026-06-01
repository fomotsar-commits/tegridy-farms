# V4 Frontend Integration Spec

> For the V4-live-at-relaunch dual-AMM. Expands §4 of `V4_DEPLOY_AND_MIGRATION_RUNBOOK.md`.
> Frontend stack: Vite + React + wagmi/viem + RainbowKit; ABIs generated via
> `frontend/wagmi.config.ts` → `src/generated.ts`. **Spec only — wiring happens
> post-deploy (post-audit).** The point of this doc: make the #2 discount and #3
> boosted-LP actually reach users, and handle the dual-pool transition.

## 0. The one rule that makes #2/#3 work

A V4 hook sees the **router** as `sender`, not the user. So:
- **All app swaps MUST route through `TegridyV4SwapRouter`** (not raw UniversalRouter) —
  it authenticates the user into `hookData`, which is the only way the premium discount
  applies. Aggregator-routed swaps (1inch/0x) get no discount; that's expected.
- **Boosted-LP rewards come from depositing the position NFT into `TegridyBoostedLPStaker`**
  (not from merely holding a V4 position) — the staker attributes to the depositor.

## 1. Codegen / config
- Add to `wagmi.config.ts` + addresses map (per chain): `TegridyV4Hook`,
  `TegridyV4SwapRouter`, `TegridyBoostedLPStaker`, canonical `PoolManager`,
  `PositionManager`, `StateView`/`StateLibrary`. Regenerate `src/generated.ts`.
- Store the `PoolKey` (currency0=ETH/native or WETH, currency1=TOWELI, fee=DYNAMIC_FEE_FLAG,
  tickSpacing=60, hooks=TegridyV4Hook) as a constant; derive `poolId = keccak256(abi.encode(key))`.

## 2. Swap — `TradePage` / swap tab
- Call `TegridyV4SwapRouter.swap(key, {zeroForOne, amountSpecified, sqrtPriceLimitX96}, minOut, deadline, recipient)`.
  - `amountSpecified < 0` = exact-in. `minOut` from quote × (1 − slippage). `deadline` from user.
  - ERC20 input: approve the router (or Permit2). Native ETH: send `value`; router refunds excess.
- **Fee/quote display:** read `hook.quoteFee(routerAddr, encodeAbiParameters(['address'],[user]))`
  to show the *effective* (possibly discounted) fee; compute expected output from pool state.
- **Premium badge:** if `PremiumAccess.hasPremium(user)`, show "Gold Card — N% off fees".
- **Paused:** if `hook.paused()`, disable the swap button ("trading paused").
- **Dual-pool routing (migration):** quote V2 and V4; route to the better-priced pool (or
  V4 once its depth leads). Always use `TegridyV4SwapRouter` for the V4 leg.
- Keep the existing slippage presets / DCA / Alerts tabs. (DCA stays browser-only; a TWAMM
  pool for on-chain DCA is a separate, deferred build.)

## 3. Liquidity + boosted-LP — `FarmPage` / liquidity tab
- **Add V4 liquidity:** mint a full-range position via `PositionManager` (standard V4 flow) → user gets a position NFT.
- **Earn boosted rewards:** approve the NFT to `TegridyBoostedLPStaker`, then `deposit(tokenId)`.
  - APR display = staker `rewardRate` pro-rated × the user's boost. Read boost via
    `TegridyStaking.aggregateActiveBoostBps(user)` (0.4×–4.5×).
- **Claim:** `getReward()`. **Unstake:** `withdraw(tokenId)` (returns the NFT). `refreshBoost(user)` after a lock change.
- Show: deposited positions, `earned(user)`, effective vs raw liquidity, boost multiplier.

## 4. Premium — `PremiumPage` (Gold Card)
- The "Reduced Fees" benefit is now real and on-chain. Show the discounted fee + cumulative savings.
- Caveat copy: discount applies to swaps made **in-app** (via the trusted router), not external aggregators.

## 5. Dual-pool / migration UI
- Show V2 + V4 pools side by side; a "Migrate to V4" CTA (remove V2 LP → add V4 LP; ideally
  atomic via a helper/Enso). Surface the reward-weight ramp phase (T+0 → T+90d, per the runbook).
- After T+30d, V2 adds are blocked at the router level; keep V2 *withdraw* available forever.

## 6. Reads & indexer
- **On-chain reads:** pool price/tick via `StateLibrary.getSlot0(poolManager, poolId)`; hook
  params (`baseFeePips`, `polSkimBps`, `discountBps`, `stakerShareBps`, `paused`); staker
  (`earned`, `liquidityOf`, `effectiveBalanceOf`, `rewardRate`, `periodFinish`).
- **Indexer (Ponder):** add handlers for the new events — hook: `PolAccrued`, `PolSwept`,
  `FeesDistributed`, `BaseFeeSet`, `Paused/Unpaused`, `PoolAllowed`; staker: `Deposited`,
  `Withdrawn`, `RewardPaid`. Feeds Treasury/Activity/Leaderboard + points. Treasury page's
  "POL holdings / lifetime fees" now read from the hook's `FeesDistributed`/POL flow.

## 7. Unchanged
- Staking / governance / bounties / grants / lending / NFT pages (V2-style, orthogonal).
- The `Toweli` token. The Ponder schema gains V4 tables but the V2 ones stay.

## 8. Sequencing
- This spec now. Codegen + wiring + indexer handlers post-deploy. Behind the audit gate
  (no mainnet addresses to wire until the contracts ship).
