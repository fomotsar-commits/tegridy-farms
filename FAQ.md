# FAQ

**Last reconciled against the tree and the chain: 2026-09-04.**

> Four answers in this file used to describe features that do not exist — a creator portal,
> a governance forum, weekly referral payouts, and airdrops that have never run — and one
> said nothing was deployed on Base ten days after Base went live. They are corrected below
> rather than quietly deleted, because a FAQ is the surface a stranger trusts most and the
> record of what it got wrong is the reason to trust the rest.

## What am I looking at — Tegridy Farms, or memetics.finance?

Both, and the distinction is worth thirty seconds.

**memetics.finance** (also served at **memetic.fun**) is the venue: a hall of thirteen
bungalows on Jungle Bay Island, one per resident token, each with its own walls, market and
staking lighthouse. That is what you land on.

**Tegridy Farms** is the protocol and its code — this repository, the Solidity contracts,
and the TOWELI token. Since 2026-08-31 the venue no longer speaks in that name; the classic
Tegridy Farms surface lives whole behind its own door at
[`/toweli`](https://memetics.finance/toweli). Nothing was deleted.

## What is TOWELI?

The protocol's token: fixed supply (1,000,000,000), on **Ethereum only** — no bridge, no
wrapped version on any other chain, and none is planned. It is the input to staking, LP
farming, the boost curve, NFT-lending collateral and (once un-gated) gauge voting.

Note what that means on the other three chains: **the Base, Robinhood and Solana surfaces do
not pay TOWELI and do not stake it.** They earn fees, and those fees land in a remittance
Safe or a fee account, not in a staker's balance.

## How do I get it?

Swap for it — on the venue's front door, or on the Uniswap V2 pool where the deep liquidity
actually is. You can also earn it from LP farming rewards.

**What will not get you any:** there has never been an airdrop, and no grant has ever been
distributed. The airdrop and vesting rails exist in the repo and are **deployed nowhere**.
(This answer previously listed airdrops, grants, creator royalties and referral rebates as
ways to acquire TOWELI. Referral rewards pay in **ETH**, not TOWELI, and the other three have
never happened.)

## Is it audited?

**Not by a third party.** No professional firm review has been commissioned or completed, and
it is not scheduled.

Internal adversarial review is continuous and every wave runs find → *independent
refute-by-default* verify — most recently the launch-program audit (2026-08-15, 43 findings,
0 critical), the Slither triage (2026-08-25, where the adversarial pass rejected twelve of
the first pass's false-positive verdicts and all twelve were then fixed), a 45-agent island
gap scan (2026-08-30), and a four-lane sweep plus an external field review (2026-09-03).

**About `SPARTAN_AUDIT.txt`:** it applies an external *methodology*, but its own Appendix C
names the reviewer as an AI assistant acting at the repository owner's direction. It is not a
third-party audit and is not claimed as one.

The contracts are live on four chains today. Treat that as an **unaudited deployment**, not as
an audit that is still pending.

## How are fees distributed?

Aimed at veTOWELI stakers — but **not the whole fee, and not yet.**

On the live `SwapFeeRouter`, `stakerShareBps` is `10000` and `polShareBps` is `0`, so nothing
is split off to the treasury or to protocol-owned liquidity *at that step*. Those levers are
timelocked, and the floor is `MIN_STAKER_SHARE_BPS = 5000`.

**The step before it is the one that matters.** `_recordReferralFee` hands the entire fee to
`ReferralSplitter` at swap time, and the splitter keeps `referralFeeBps` — **20% today** — for
the swapper's referrer, or for the treasury when there is no qualified referrer. Either way
that slice is not staker yield, and it cannot be turned off: `proposeReferralFee` rejects `0`,
and `applyReferralSplitter(address(0))` reverts while the share is above zero, so the splitter
cannot be unwired either. The remaining ~80% is credited back to the router as `callerCredit`
and moves only when someone calls the **permissionless** `recoverCallerCredit()`.

Two things to be clear about:

1. **The rail has collected and has still paid nobody.** Fees have accrued; the balance sits in
   `ReferralSplitter` because `recoverCallerCredit()` has never been called; and
   `RevenueDistributor.totalDistributed()` reads `0`. No epoch has ever opened. (That is a
   statement about the mechanism on purpose — a wei figure is stale after the next swap.)
2. **The protocol burns nothing** — but the live token *can* be burned: `burn(uint256)` and
   `burnFrom(address,uint256)` are both in the deployed bytecode, so any holder may destroy
   their own TOWELI. One billion is the ceiling, not a constant.

See [TOKENOMICS.md](TOKENOMICS.md) for where each fee surface routes.

## What's the boost?

Lock TOWELI for 7 days → 4 years and earn a **0.4×–4.0×** boost, plus **+0.5×** if you hold a
JBAC NFT (ceiling 4.5×). Longer locks earn more.

Since 2026-08-30 that same ladder is the shape of every **EVM bungalow lighthouse** — the six
`LighthouseLadder` pools use TOWELI's exact curve, line for line.

## Can I stake a bungalow token?

Yes — all thirteen bungalows stake, at their own door (`memetics.finance/<bungalow>`). The two
rails are genuinely different and the app never blurs them:

- **The six EVM pools** (`LighthouseLadder` on Ethereum and Base) use the TOWELI ladder and
  have an **exit hatch**.
- **The five Solana pools** run on Streamflow, which has **no early exit at all** — verified
  three ways: the program has only stake/unstake, unstake is refused before the duration
  elapses, and the position cannot be sold. The ceremony therefore defaults to a 7-day ceiling
  and gates longer locks behind an explicit acknowledgement. **Read the lock warning before you
  sign; there is no way out and no penalty exit.**

## What happens if I unstake early?

On TOWELI staking: a **flat 25% penalty on the principal you withdraw**, transferred in full to
the protocol treasury. It does not shrink as your lock matures and it is **not** recycled to the
stakers who stayed (`EARLY_WITHDRAWAL_PENALTY_BPS = 2500`). If your lock has already expired,
use `withdraw()` — that path charges nothing.

Also worth knowing: **Auto-Max Lock is not reversible.** Enabling it sets your lock end to
four years from that instant, and disabling it does not restore your original duration.

## Is lending liquidation-free?

Fixed-term loans with no margin-call liquidations. If a borrower defaults at maturity the NFT
transfers to the lender — no surprise liquidations from oracle volatility mid-loan. There is a
short post-deadline grace window, plus separate sequencer-aware and pause-extended grace.

## Which chains is this on?

Four, and they do different jobs:

| Chain | What runs there | Where fees land |
|---|---|---|
| **Ethereum** | Everything — staking, the DEX, revenue distribution, NFT finance, both launchers | The staker rail (which has never paid) and the treasury Safe |
| **Base 8453** | The DEX + fee stack + curve launcher, live 2026-08-25 | A **remittance** Safe — queued for the bridge, *not* staker yield |
| **Robinhood 4663** | The same stack, live 2026-08-25 | The same remittance Safe |
| **Solana** | The Jupiter-routed swap (Instant / Limit / DCA) and five Streamflow lighthouses | A Solana fee account |

*(This answer used to read "Nothing is deployed on Base today… no dated commitment to build
them." That was written before the 2026-08-25 deploy and stayed wrong for ten days.)*

## Who controls the keys?

It is not one multisig, and on mainnet it is **still not a multisig at all**.

- **Most mainnet protocol contracts** — staking, LP farming, gauge controller, vote incentives,
  NFT lending, launchpad, premium access — are owned by a plain **EOA with no code**. On-chain
  timelocks gate the privileged actions, but a single key can still initiate all of them.
  **This is the single largest unresolved risk in the project.**
- **Treasury** `0x7D26…Bd7d` is a **2-of-2** Safe (not a 4-of-7).
- **TegridyNFTPoolFactory** is owned by a 2-of-3 Safe.
- **The Base / Robinhood legs** deployed with their role Safes in place, but those Safes sit at
  `nonce() == 0` — no ceremony has executed yet, and an N-of-M is unproven until something has
  actually executed at the new threshold.

The re-home is tracked in [`docs/SAFE_REHOME_RUNBOOK.md`](docs/SAFE_REHOME_RUNBOOK.md) and
[`docs/TODO_OPERATOR.md`](docs/TODO_OPERATOR.md). *(This answer used to point at
`NEXT_SESSION.md`, which was retired on 2026-08-19.)*

## How do I refer someone?

Generate a link in the app — but read this first, because the app now says it before you share
rather than after:

**If your voting power is below `MIN_REFERRAL_STAKE_POWER`, you earn nothing.** Your referee's
carve routes to the treasury in full, they pay exactly the same fee either way, and nothing
on-chain tells you it happened — `getReferralInfo` reports the same zeroes it would report for
someone with no referrals at all. There is also a **7-day minimum referral age**.

Rewards accrue in **ETH** and are claimed from `pendingETH(address)` when there is something to
claim. *(This answer used to promise rebates "claimable weekly from the dashboard", which
describes a cadence that does not exist.)*

## How do I become a creator?

By launching. There is **no creator portal and no application process** — that answer described
a feature that has never existed.

What is real: two token launchers (our own bonding curve on Ethereum/Base/Robinhood, and the
Doppler rail) and an NFT launchpad, all permissionless. A curve launch gets a permanent page and
the creator can claim their fees.

## What's the grant program?

**There isn't one running.** `CommunityGrants` is deployed and Etherscan-verified but its
frontend address is still zeroed, so the UI is gated — and there is **no governance forum** to
apply through. House law forbids funding grants out of capital the protocol has not earned, and
the protocol has not yet earned any, which makes the fee rail the real precondition.

## Is there a mobile app?

No. The web app is responsive and targeted at iPhone 14+ and iPad. A native app is an
aspiration; no work has started.
