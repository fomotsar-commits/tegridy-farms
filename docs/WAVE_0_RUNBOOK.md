# Wave 0 Runbook

One linear checklist that takes the protocol from "post-session-11 working tree" to "everything patched is live on mainnet and GitHub reflects reality."

Do these in order. Each step is a single command or a single dashboard click.

**Estimated time:** 45–90 minutes + 48h timelock waiting periods if you redeploy anything owner-transferred.

---

## Pre-flight (5 min)

### Check your local setup

```bash
cd "C:/Users/jimbo/OneDrive/Desktop/tegriddy farms"

# Forge installed?
forge --version  # expect 1.5.x or newer

# Contracts build?
cd contracts && forge build

# Tests green?
forge test
# expect: 1921 passed; 0 failed

cd ..
```

If any of those fail, fix before proceeding.

### Check `.env` files exist with non-placeholder values

```bash
test -f contracts/.env && echo "contracts/.env present"
test -f frontend/.env  && echo "frontend/.env present"
```

If missing, copy from `.env.example` and fill in real values. Required keys for this runbook:

**`contracts/.env`:**
- `PRIVATE_KEY` — deployer EOA (needs ~0.05 ETH for all the redeploys)
- `RPC_URL` — mainnet (Alchemy / Infura / LlamaRPC / your own node)
- `ETHERSCAN_API_KEY` — required if you want auto-verification
- `MULTISIG` — placeholder OK for now (multisig step is deferred)
- `TEGRIDY_STAKING` = `0x626644523d34B84818df602c991B4a06789C4819`
- `TEGRIDY_LP` = `0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6`
- `LP_TOKEN` = `0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6`

**`frontend/.env`:**
- `VITE_WALLETCONNECT_PROJECT_ID`
- `VITE_RPC_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `ALLOWED_ORIGIN`
- Plus optional Supabase keys

---

## Step 1 — Rotate `.env` secrets (10 min)

**Why first:** Per the audit, a private key + API keys were at some point kept in `.env` working files. They were never pushed to git (verified via `git log --all --full-history`). Rotate anyway — assume anything ever typed into a file is compromised.

Rotate each, in order:

### 1.1 Alchemy / Infura RPC key
- Log into your provider dashboard
- Revoke the old key
- Generate a new one
- Paste into `contracts/.env RPC_URL` and `frontend/.env VITE_RPC_URL`

### 1.2 Etherscan API key
- https://etherscan.io/myapikey → delete the existing + regenerate
- Paste into `contracts/.env ETHERSCAN_API_KEY`

### 1.3 WalletConnect project ID
- https://cloud.walletconnect.com → your project → regenerate
- Paste into `frontend/.env VITE_WALLETCONNECT_PROJECT_ID`

### 1.4 Upstash Redis
- https://console.upstash.com → your DB → regenerate REST token
- Paste both URL + token into `frontend/.env`

### 1.5 Supabase (if present)
- https://supabase.com/dashboard/project/_/settings/api → regenerate anon + service keys
- Paste into `frontend/.env`

### 1.6 Deployer private key
This is the big one.

**If the old EOA held treasury ETH or was owner of any live contract:**
1. Generate a new EOA in a fresh wallet (MetaMask / Foundry / hardware wallet).
2. Fund the new EOA with ~0.1 ETH.
3. From the OLD EOA (careful: it's the still-current owner), send every contract's ownership to a **holding address you control from a fresh key**, via each contract's `transferOwnership(newAddr)` + `acceptOwnership()` 2-step. List of contracts with `onlyOwner` gates:
   - TegridyStaking, TegridyLPFarming, SwapFeeRouter, POLAccumulator
   - GaugeController, VoteIncentives
   - RevenueDistributor, ReferralSplitter, PremiumAccess
   - CommunityGrants, MemeBountyBoard
   - TegridyLending, TegridyNFTLending, TegridyNFTPoolFactory
   - TegridyLaunchpad
4. Once ownership migrates, the old EOA is effectively idle. Rotate `PRIVATE_KEY` in `contracts/.env` to the NEW key.

**If the old EOA was "cold" (never actually compromised, no treasury):**
Skip step 1.6 — just make sure the `.env` file is no longer accessible to any IDE you don't trust.

### 1.7 Verify nothing tracked in git

```bash
git log --all --full-history -- contracts/.env frontend/.env
# Expected output: nothing (no history, files never committed)

git ls-files | grep -E "\.env$|\.env\.local"
# Expected output: nothing
```

If either prints lines, you have history to purge with `git filter-repo` or `bfg`. Flag it in an issue; don't force-push without backup.

---

## Step 2 — Apply Supabase migration 002 (5 min)

**Why:** `frontend/api/orderbook.js`, `trade_offers.js`, `push/subscribe.js` all INSERT/SELECT against tables that don't exist on the live Supabase project. Every API call currently 500s.

### 2.1 Open the SQL Editor

https://supabase.com/dashboard/project/{YOUR_PROJECT}/sql/new

### 2.2 Paste the migration

Copy the full contents of `frontend/supabase/migrations/002_native_orders_trades_push.sql` into the editor. It creates `native_orders`, `trade_offers`, `push_subscriptions` and backfills explicit SELECT RLS policies on five pre-existing tables.

### 2.3 Click Run

Expected result: green "Success. No rows returned."

### 2.4 Verify tables exist

Run in the same SQL editor:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('native_orders', 'trade_offers', 'push_subscriptions');
```

Expected: 3 rows.

### 2.5 Smoke-test an API endpoint

```bash
curl -s https://tegridyfarms.xyz/api/orderbook
# Expected: {"orders":[]} or similar — NOT a 500.
```

If you still get 500, the RLS policy may be wrong. Check `frontend/api/_lib/supabase.js` uses the correct `SUPABASE_URL` and `SUPABASE_ANON_KEY` env vars.

---

## Step 3 — Redeploy the three patched contracts (20 min + ~0.02 ETH gas)

Three contracts have working-tree patches that aren't on mainnet yet:

| Contract | Patch | Source |
|---|---|---|
| `TegridyLPFarming` | `exit()` convenience function + stake-time boost refresh | [commit 0468faf](https://github.com/fomotsar-commits/tegridy-farms/commit/0468faf) |
| `TegridyNFTLending` | `GRACE_PERIOD = 1 hours` gating repayLoan + claimDefault | [commit 0468faf](https://github.com/fomotsar-commits/tegridy-farms/commit/0468faf) |
| `TegridyDrop` (template) | `MintPhase.CANCELLED`, `cancelSale()`, `refund()`, `paidPerWallet` | [commit 0468faf](https://github.com/fomotsar-commits/tegridy-farms/commit/0468faf) |

### 3.1 Run the helper script

```bash
cd "C:/Users/jimbo/OneDrive/Desktop/tegriddy farms"
./scripts/redeploy-patched-3.sh
```

The script runs `forge script` for each of the three contracts in sequence with `--broadcast --verify`, echoes the broadcast JSON paths, and exits non-zero if any step fails.

**Expected output tail:**
```
✓ TegridyLPFarming       deployed at 0x...
✓ TegridyNFTLending      deployed at 0x...
✓ TegridyDrop template   deployed at 0x...
```

If any deploy fails with "insufficient funds" — fund the deployer and retry.
If verify fails with "already verified" — ignore, source is on Etherscan.
If Etherscan API is flaky — manually verify later via `forge verify-contract`.

### 3.2 Print the constants.ts patch

```bash
npx tsx scripts/diff-addresses.ts
```

**Expected output:**
```
// frontend/src/lib/constants.ts — patch to apply:
- export const LP_FARMING_ADDRESS = '0xa5AB...' as const;
+ export const LP_FARMING_ADDRESS = '0xNEW...' as const;
- export const TEGRIDY_NFT_LENDING_ADDRESS = '0x63baD...' as const;
+ export const TEGRIDY_NFT_LENDING_ADDRESS = '0xNEW...' as const;
- (TegridyDrop is the per-Drop clone template — likely NOT in constants.ts; leave as template reference)
```

### 3.3 Apply the patch

Open `frontend/src/lib/constants.ts` and apply the diff **exactly** as printed. Then update the same addresses in:

- `README.md` § Deployed contracts (search for the old address, replace with new)
- `docs/MIGRATION_HISTORY.md` — add a row: "old address → deprecated, new address → canonical, reason: session-8 patch redeploy"

### 3.4 Commit together

```bash
git add frontend/src/lib/constants.ts README.md docs/MIGRATION_HISTORY.md
git commit -m "chore(deploy): redeploy 3 patched contracts + constants + migration history"
git push origin main
```

### 3.5 Verify on Etherscan

For each new address:
- https://etherscan.io/address/{ADDR}#code — source matches `contracts/src/*.sol` at the session-6 HEAD?
- Read functions return expected values? (e.g. `TegridyLPFarming.exit()` is now callable, `TegridyNFTLending.GRACE_PERIOD()` returns `3600`)

---

## Step 4 — Deploy TegridyFeeHook (15 min + ~0.015 ETH gas)

**Why:** Audit blocker B7. The Uniswap V4 fee hook has source in repo but has never been deployed because the contract requires a CREATE2 address satisfying the flag bitmask `0x0044`.

### 4.1 Set the env vars

```bash
export POOL_MANAGER=0x... # Uniswap V4 PoolManager on mainnet
export REVENUE_DIST=0x332aaE555b1164eA45c2291fD7eDfa97aAA264D8  # current RevenueDistributor
export TEGRIDY_FEE_HOOK_BPS=30  # 0.3% default, raise/lower to taste
export MAX_MINING_ITER=200000   # default fine; bump if salt-mining exhausts
```

*Uniswap V4 PoolManager mainnet address:* check https://docs.uniswap.org/contracts/v4/deployments for the canonical address; the contract changes across test/prod deployments. At time of writing (Apr 2026) it may still be undergoing rollouts — verify before you broadcast.

### 4.2 Run the deploy script

```bash
cd contracts
forge script script/DeployTegridyFeeHook.s.sol:DeployTegridyFeeHook \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

The script mines a salt that produces a hook address matching `0xXXXXXXXXXXXXXXXX0044`. Mining typically takes 10k–100k iterations. Expected wall-time: 30s–3min.

Expected tail output:
```
Mined salt: 0x...
Predicted hook address: 0x....0044
Low-16 bits: 68
TegridyFeeHook deployed to: 0x...
```

### 4.3 Wire the hook into a V4 pool

This step is outside the script. You need to create (or migrate) a V4 pool with the hook address. Consult Uniswap V4 docs for pool-initialization via `PoolManager.initialize()`. Typically:

```solidity
PoolKey memory key = PoolKey({
    currency0: Currency.wrap(WETH),
    currency1: Currency.wrap(TOWELI),
    fee: 3000,                      // 0.3% LP fee
    tickSpacing: 60,
    hooks: IHooks(TEGRIDY_FEE_HOOK_ADDRESS)
});
poolManager.initialize(key, startingSqrtPriceX96);
```

### 4.4 Update constants + docs

```bash
# In frontend/src/lib/constants.ts add:
export const TEGRIDY_FEE_HOOK_ADDRESS = '0x...0044' as const;

# In docs/MIGRATION_HISTORY.md add:
# | TegridyFeeHook | 0x...0044 | CANONICAL | Session-12 CREATE2 deploy |
```

Commit together.

---

## Step 5 — Run the OG PNG rasterizer (2 min)

**Why:** Social crawlers that don't render SVG (older Discord, Slack previews, image CDN proxies) miss the hero banner.

```bash
cd "C:/Users/jimbo/OneDrive/Desktop/tegriddy farms"
npx --yes -p @resvg/resvg-js@2 node scripts/render-og-png.mjs
```

Expected output:
```
✓ wrote frontend/public/og.png (NNN KB, 1280×640)
✓ wrote docs/banner.png (NNN KB, 1280×640)
```

Then update `frontend/index.html`:
```html
<!-- BEFORE -->
<meta property="og:image" content="https://tegridyfarms.xyz/og.svg" />

<!-- AFTER -->
<meta property="og:image" content="https://tegridyfarms.xyz/og.png" />
<meta property="og:image:secure_url" content="https://tegridyfarms.xyz/og.svg" />
```

Commit + push.

---

## Step 6 — Smoke-test production (10 min)

After everything above lands:

### 6.1 Visit https://tegridyfarms.xyz with a fresh browser profile

- `/` → audit badge links to `/security` correctly, YieldCalculator renders for disconnected wallet
- `/farm` → ConnectPrompt renders (no crashes); connect wallet → Farm UI renders
- `/swap` → Quote panel renders
- `/lending` → NFT Finance tabs render
- `/community` → Gauge voting UI has the commit-reveal mode toggle visible (if you deployed the patched GaugeController from the rewrite + redeploy flow — NB: GaugeController is NOT in the 3-contract redeploy set above; separate decision)

### 6.2 Check social preview

Paste `https://tegridyfarms.xyz` into the Discord preview tester: https://discohook.org → "Send from webhook" → verify hero image renders (PNG with the Tegridy Farms wordmark + 3 pillars).

Or test via Twitter's Card Validator: https://cards-dev.twitter.com/validator

### 6.3 Check GitHub

Open https://github.com/fomotsar-commits/tegridy-farms and verify:
- README badges are green (Contracts CI / CodeQL / Slither)
- AUDITS.md links all resolve (no 404s)
- Every audit file under SECURITY_AUDIT_*.md is browsable
- The Actions tab shows the latest CI run green

---

## Deferred (handle later, not this runbook)

- **Multisig migration** — decide signer set, deploy Safe, transfer all ownerships. Planned separately; see `docs/MULTISIG_MIGRATION.md` when we write it.
- **TOKENOMICS.md allocation** — needs team decision on distribution; session-12 will finalise after you provide the percentages.
- **Public community surface** — see `docs/COMMUNITY_LAUNCH.md`.
- **Revenue calibration** — each lever change is a 24-48h timelock proposal. Queue after multisig is in place.

---

## If something goes wrong

1. **Don't panic** — every step above is either reversible (no ETH moves) or has a built-in safety net (2-step ownership, timelock delays, pull-pattern refunds).
2. **Pause the contract** if you suspect something's wrong: every contract with `onlyOwner` has `pause()`. Pauses trade safety for liveness — reasonable during incident response.
3. **Open a GitHub issue** with a tag `incident:` and share as much of the broadcast JSON as you can without revealing keys.
4. **Talk to your security researcher contacts** in parallel. The bug bounty is active (`security@tegridyfarms.xyz`) but an active incident can also go to trusted external eyes.

---

*Last updated: 2026-04-18.*
