# DefiLlama: the two listings, ready to send

DefiLlama lists a protocol through pull requests on two of its GitHub repositories. Both are
free. Neither has a minimum size or asks for an audit (its docs and both repositories' rules,
read 2026-11-27). This folder holds everything for both. Nothing here has been sent: the owner
opens each pull request.

| What it shows | Their repository | Our file | The text to paste |
|---|---|---|---|
| Value locked in our pools | `DefiLlama/DefiLlama-Adapters` | `DefiLlama-Adapters/projects/memetics-finance/index.js` | `DefiLlama-Adapters/PR.md` |
| Volume, fees and revenue | `DefiLlama/dimension-adapters` | `dimension-adapters/dexs/memetics-finance.ts` | `dimension-adapters/PR.md` |

Both read program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT` straight from the chain. Each
passed DefiLlama's own test command in a local copy of their repository on 2026-11-27; the
output is in each `PR.md`.

## What the listing will show

- **Value locked: $20.03k** (34 pools). Our own site said $20,081 in the same minute. The $50
  between them is fees set aside in the pools for the vault and the Workshop, which DefiLlama's
  rule leaves out (about $25 to $30), our one range pool ($1.54, a different program) and the
  SOL price each side used.
- **Volume: only what fee-paying traders did: $124.73** in the 24 hours to 2026-11-27 06:00
  UTC. Our own price robot's swaps are not in it. See the first decision below.
- **How the money is shown.** A swap pays the pool's 1% trade fee. Liquidity providers keep 84%
  of it (0.84% of the swap). The other 16% (0.16% of the swap) is shown as revenue: 10.4% of the
  fee to the vault and 5.6% to the Workshop, each under its own label. Only the vault's part is
  also shown as protocol revenue, DefiLlama's name for what a treasury collects. Opening a pool
  pays the vault 0.15 SOL: shown as revenue and as protocol revenue.

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
   either way.
3. **Fields only the owner can settle**, marked in each `PR.md`: the logo file to attach
   (`frontend/public/icons/a5bed999/icon-512.png` is 512 by 512), whether to name TOWELI as the
   protocol's token (the text says "None on Solana"), the CoinGecko and CoinMarketCap ids (left
   empty) and the referral answer (the text says "Not on these Solana pools").

## Steps

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

The volume test reads one transaction at a time from Solana's public endpoint, so a busy day
takes several minutes.

## What changes on our side later

- A change to a fee tier's protocol or fund rate (the split's next step, for one) needs a dated
  line in `dexs/memetics-finance.ts` beside `FUND_SHARE_START`, sent to DefiLlama as a small
  pull request the week it executes. The adapter reads today's rates from the chain, and Solana
  keeps no history of them.
- Range pools are a second program and are in neither adapter. One pool holds $1.54 today.
- If the program passes a few thousand transactions a day, the volume adapter should move to
  DefiLlama's Allium helper, as `dexs/deepswap.ts` does. Only DefiLlama can run that one.
