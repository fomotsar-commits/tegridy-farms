# DefiLlama: the two listings

DefiLlama lists a protocol through pull requests on two of its GitHub repositories. Both are
free. Neither has a minimum size or asks for an audit (its docs and both repositories' rules,
read 2026-11-27). This folder holds everything for both. Both were sent on 2026-11-28, and the
volume one was merged there the same day: see "Sent" below, and do not open either again.

| What it shows | Their repository | Our file | The text to paste |
|---|---|---|---|
| Value locked in our pools | `DefiLlama/DefiLlama-Adapters` | `DefiLlama-Adapters/projects/memetics-finance/index.js` | `DefiLlama-Adapters/PR.md` |
| Volume, fees and revenue | `DefiLlama/dimension-adapters` | `dimension-adapters/dexs/memetics-finance.ts` | `dimension-adapters/PR.md` |

Both of our files read program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` straight from the
chain, and each passed DefiLlama's own test command in a local copy of their repository; the
output is in each `PR.md`. The volume adapter that DefiLlama merged is their maintainer's rewrite
of ours: see "Volume: merged" below.

## Sent

Both pull requests were opened on 2026-11-28 from the owner's GitHub account, on the owner's
word. Each holds the one file named above:

- Value locked: https://github.com/DefiLlama/DefiLlama-Adapters/pull/22424
- Volume, fees and revenue: https://github.com/DefiLlama/dimension-adapters/pull/11422

Each adapter was tested again that day on DefiLlama's current code before it went. Value locked
read $19.43k over 34 pools. Volume read $398.65 for the 24 hours to 2026-11-27 23:00 UTC (the
first test, a day earlier, read $124.73: the figure moves that much from day to day).

- One pull request per repository: do not open either again. A reviewer's change goes into
  the same pull request, on the branch `add-memetics-finance` of the owner's fork of that
  repository.
- The logo is in each body as a link to `https://memetics.finance/icons/a5bed999/icon-512.png`:
  a pull request opened from the command line cannot attach a file.
- A commit made through GitHub's file API is stamped with the account's primary email address,
  not the no-reply address our own commits carry. For a commit that goes to someone else's
  repository, set its author and committer to the no-reply address when the commit is made.
- DefiLlama's automated reviewer (CodeRabbit) reviews every pull request there. On the volume
  one it asked for changes, which shows as a red X beside the pull request. Two more commits
  answered it, and it approved on 2026-11-28. What changed: a token's own transfer fee is
  counted in volume (the program's event carries the amount after that fee); the one fee share
  that existed before the split is rounded once; transactions are read two at a time through
  their `PromisePool`; and every signature page is asked for at a finalized slot past the
  window's end, so a node that lags refuses instead of answering short. The description in
  `dimension-adapters/PR.md` is as it stood when the pull request was merged.
- To clear that reviewer's change request: fix or answer each of its threads in the pull
  request, then post `@coderabbitai approve` as a comment of its own. It withdrew one request
  on evidence: a `fees/` copy of the adapter is not needed (`dexs/deepswap.ts` has none, and
  DefiLlama publishes its fees). Editing the description after it has reviewed makes its
  checks stale, so edit the description first. Its title format is
  `[type] protocol-name - description`.
- On the value-locked pull request the same reviewer left one small suggestion and no change
  request: read each pool's fee counters and its vault balances in one call. Not done.
- The value-locked pull request still waits for a DefiLlama maintainer; the automated
  reviewer's word is not that.

### Volume: merged on 2026-11-28

DefiLlama's maintainer `bheluga` merged the volume pull request on 2026-11-28 05:58 UTC, after
rewriting the adapter in it (their commit "refactor using allium"). What runs at DefiLlama is
their version:
https://github.com/DefiLlama/dimension-adapters/blob/master/dexs/memetics-finance.ts
(merge commit `c56bde05e1dfc43b7dacad2107f4441b2b6f2314`). `dimension-adapters/dexs/memetics-finance.ts` here is
our own last version, the pull request's third commit, which reads the chain over RPC: kept
for cross-checks, and not what DefiLlama runs. A later change goes to their file, on a new
branch of the owner's fork.

What their version keeps, and what it changes:

- Kept: the price robot's fee-free swaps are not volume. Fees are the 1% trade fee and the
  0.15 SOL to open a pool. The vault's 10.4% of each trade fee (16% before 2026-10-19) and the
  pool-opening fee are revenue and protocol revenue.
- Changed: the Workshop's 5.6% is shown under supply side revenue, beside the liquidity
  providers' 84%, still under its own label "Swap Fees To Fund Owner". We had put it under
  revenue and offered this move in the pull request; DefiLlama's rule puts a share paid to a
  partner there. The amounts are the chain's either way.
- Changed: a token's own transfer fee is not added to volume, and a pool's creator fee is not
  read (no pool charges one today).
- It reads swaps from Allium, DefiLlama's data provider, so its test runs only with
  DefiLlama's key. The fee tiers' rates are still read from the chain.
- After a merge the figures can take a day to show. Their template says to tell them in their
  Discord only if more than 24 hours pass. On 2026-11-28 their API did not answer for
  `memetics-finance` yet.

## What the listing will show

- **Value locked: $20.03k** (34 pools). Our own site said $20,081 in the same minute. The $50
  between them is fees set aside in the pools for the vault and the Workshop, which DefiLlama's
  rule leaves out (about $25 to $30), our one range pool ($1.54, a different program) and the
  SOL price each side used.
- **Volume: only what fee-paying traders did: $124.73** in the 24 hours to 2026-11-27 06:00
  UTC. Our own price robot's swaps are not in it. See the first decision below.
- **How the money is shown.** A swap pays the pool's 1% trade fee. Liquidity providers keep 84%
  of it (0.84% of the swap). As merged, the vault's 10.4% of the fee
  (0.104% of the swap) is shown as revenue and as protocol revenue, DefiLlama's name for what a
  treasury collects. The Workshop's 5.6% is shown beside the liquidity providers' share, under
  supply side revenue, with its own label. Opening a pool pays the vault 0.15 SOL: shown as
  revenue and as protocol revenue.

## Decisions before sending: two settled, one open

1. **Settled by the owner, 2026-11-27: the price robot's swaps stay out of volume, and both
   listings go.** DefiLlama's written rule is that a protocol's own trades are never volume,
   and our robot trades free of fees. The adapter leaves out every swap that paid no fee,
   which is exactly the robot's. So DefiLlama's figure will be lower than the one figure our
   site shows, and the pull request says why. Our site keeps its one figure, robot included.
2. **Settled by the owner, 2026-11-27: the Workshop's share counts as revenue.** The adapter
   shows it under revenue with its own label, "Swap Fees To Fund Owner", and keeps it out of
   protocol revenue, which stays the vault's part alone, so every figure is true as labelled.
   A reviewer may still ask to move it: DefiLlama's written rule counts as revenue what the
   protocol keeps, and puts a share paid to a partner beside the liquidity providers'. The
   pull request says where the 5.6% goes and offers the move. The amounts are the chain's
   either way. **2026-11-28: DefiLlama's maintainer made that move when merging**, so on
   DefiLlama the 5.6% is under supply side revenue, not revenue.
3. **Fields only the owner can settle**, marked in each `PR.md`: the logo file to attach
   (`frontend/public/icons/a5bed999/icon-512.png` is 512 by 512), whether to name TOWELI as the
   protocol's token (the text says "None on Solana"), the CoinGecko and CoinMarketCap ids (left
   empty) and the referral answer (the text says "Not on these Solana pools").

## Steps (done on 2026-11-28; kept for the record)

1. On GitHub, fork `DefiLlama/DefiLlama-Adapters`. In the fork, add
   `projects/memetics-finance/index.js` with the contents of our file. Change nothing else.
2. Open a pull request to their `main` branch. Title and body: `DefiLlama-Adapters/PR.md`.
   Attach the logo. Tick "Allow edits by maintainers".
3. Fork `DefiLlama/dimension-adapters`. Add `dexs/memetics-finance.ts` with the contents of
   our file. Change nothing else.
4. Open a pull request to their `master` branch. Title and body: `dimension-adapters/PR.md`.
   Paste the first pull request's link where the body asks for it. Tick "Allow edits by
   maintainers".
5. Do not post in their Discord: both repositories say they watch every pull request. If a
   reviewer asks for a change, bring the comment back here.

## To check it again before sending

In a fresh copy of each of their repositories (outside OneDrive), with our file copied in:

```
pnpm i --ignore-scripts
node test.js projects/memetics-finance/index.js      # in DefiLlama-Adapters
pnpm test dexs memetics-finance                      # in dimension-adapters, the last 24 hours
pnpm test dexs memetics-finance 2026-11-07           # one past day: the date is the day after
```

The volume lines run our own RPC version of the adapter, which reads a few transactions at a time
from Solana's public endpoint, so a busy day takes several minutes. The version DefiLlama merged
runs only with their Allium key.

## What changes on our side later

- A change to a fee tier's protocol or fund rate (the split's next step, for one) needs a dated
  line in DefiLlama's `dexs/memetics-finance.ts` beside `FUND_SHARE_START`, sent to DefiLlama as a small
  pull request the week it executes. The adapter reads today's rates from the chain, and Solana
  keeps no history of them.
- Range pools are a second program and are in neither adapter. One pool holds $1.54 today.
- The volume adapter at DefiLlama is on their Allium helper since the merge. A change to it is a
  pull request against their file; we cannot run its test, so the pull request must say so.
