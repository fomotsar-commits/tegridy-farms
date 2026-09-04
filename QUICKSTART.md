# Quickstart

**Last reconciled against the app on 2026-09-04.**

> **What changed in this pass.** Every step below used to carry a screenshot from
> `docs/screenshots/` — a directory that does not exist in this repository, so all **15**
> images had been rendering broken for as long as the file has been tracked. They are
> removed rather than replaced, because a missing image teaches a reader nothing and a
> promised one that never loads costs their trust twice. Three dead destinations went with
> them: `/docs`, `/drop/<address>` and a community Discord, none of which exist.

The app is live at **[memetics.finance](https://memetics.finance)** (also
**memetic.fun**). Pick a path.

- [Path 1 — Stake TOWELI](#path-1--stake-toweli)
- [Path 2 — Stake a bungalow token](#path-2--stake-a-bungalow-token)
- [Path 3 — Borrow against your NFT](#path-3--borrow-against-your-nft)
- [Path 4 — Launch a token](#path-4--launch-a-token)
- [Path 5 — Launch an NFT drop](#path-5--launch-an-nft-drop)

**Prerequisites (all paths):**
- A wallet — MetaMask, Rabby, Coinbase Wallet, **Phantom** or **Trust**, or anything
  WalletConnect-compatible. For the Solana surfaces use Phantom or another Solana wallet;
  **Trust is deliberately not offered on Solana**, because its adapter is legacy-only and
  would connect and then fail on every swap.
- Gas on whichever chain you are using — Ethereum, Base, Robinhood Chain, or SOL on Solana.
- Connect via the **Connect Wallet** button in the header.

---

## Path 1 — Stake TOWELI

**Read this before you start.** Locking TOWELI earns you a **boost** and a governance
position. It does **not** earn you ETH yield today: fees are paid per epoch, **no epoch has
ever opened**, and the front door's take is still parked in `ReferralSplitter` awaiting a
permissionless `recoverCallerCredit()` that nobody has called. Stake for the lock, the boost
and the position NFT — not for a yield stream that has never run. (See
[FAQ.md](FAQ.md#how-are-fees-distributed).)

### 1. Acquire TOWELI
Use the in-app swap at `/swap`, or the Uniswap V2 pool where the deep liquidity actually
is. TOWELI is **Ethereum-only** — there is no bridged version on Base, Robinhood or Solana,
and there never will be.

### 2. Go to the Farm
`/farm` shows the pools, the live APR and the boost table.

### 3. Approve and stake
Enter an amount, **Approve** (one-time), then **Stake**. Two wallet confirmations.

### 4. Pick a lock
Between **7 days and 4 years**, for a **0.4×–4.0×** boost, plus **+0.5×** with a JBAC NFT
(ceiling 4.5×). The UI previews the boost before you confirm.

> ⚠️ **Auto-Max Lock is a one-way door.** Enabling it sets your lock end to four years from
> that instant, and *disabling it does not restore your original duration*. The control says
> so before you throw it.

### 5. Track it
Your position appears under **My Positions**. Principal unlocks at the end of the lock.
**Early exit costs a flat 25% of the principal you withdraw**, paid to the treasury — it does
not taper as you approach maturity, and it is not recycled to the stakers who stayed.

---

## Path 2 — Stake a bungalow token

All **thirteen bungalows** on Jungle Bay Island have their own staking lighthouse. Each one
lives at its own door: `memetics.finance/<bungalow>` — for example `/pepe`, `/bnkr`, `/bayla`.

The two rails behave differently, and the difference is the whole decision:

| | EVM lighthouses (Ethereum, Base) | Solana lighthouses |
|---|---|---|
| Contract | `LighthouseLadder` — TOWELI's ladder exactly, 7d…4y at 0.4×…4.0× | Streamflow |
| Early exit | Yes, with a penalty | **None. At all.** |

> ⚠️ **The Solana pools have no way out.** Verified three ways: the program has only
> stake/unstake, unstake is refused before the duration elapses, and the position cannot be
> sold. There is no penalty exit and no admin release. The ceremony therefore defaults to a
> **7-day** ceiling and gates longer locks behind an explicit acknowledgement. Read the lock
> warning before you sign.

The lock ladder and its multipliers are visible **without connecting a wallet**.

---

## Path 3 — Borrow against your NFT

Fixed-term, peer-to-peer, no margin-call liquidations.

1. **Go to `/lending`.** Only supported collections appear.
2. **Select an NFT** as collateral.
3. **Browse offers** — each is a fixed principal, rate and term.
4. **Accept one.** ETH lands in your wallet on confirmation.
5. **Repay before expiry** to reclaim the NFT. Your loan shows under **My Loans** with a
   countdown.

Two things worth knowing: there is a short **grace window** after the deadline (plus separate
sequencer-aware and pause-extended grace), and repayment must cover a **minimum-interest
floor**, so quote the repayment at the moment you send it rather than reusing an older quote.
If a borrower defaults at maturity, the NFT transfers to the lender.

---

## Path 4 — Launch a token

Two rails, both permissionless, no launch-creation fee beyond gas:

- **Our own curve** (`/eth-curve`) — `TegridyCurveLauncher` on **Ethereum, Base and
  Robinhood**, graduating into a pool the protocol owns. Add an image, description and
  socials; they upload through Irys and bind by signature, so the token contract stays
  immutable. Every launch gets a permanent `/eth-curve/:token` page, and the creator can
  claim their fees from it.
- **The Doppler rail** (`/launch`) — a dynamic auction with a published fee constitution, a
  Fact Sheet, a permanent record at `/launch/:token` and afterlife tracking. ETH is the
  default base pair; **TOWELI** is the one opt-in alternative.

*(The Meteora Solana rail was deleted on 2026-08-23 — it graduated into a pool the protocol
does not own. `/solana-launch` no longer exists.)*

---

## Path 5 — Launch an NFT drop

1. **Open `/launchpad`** and click **Create Collection**.
2. **Name, symbol, supply cap, description**, cover art, optional pre-reveal placeholder.
3. **Mint terms** — price, per-wallet cap, start time, allowlist (CSV or paste), optional
   delayed reveal, royalty BPS (max 1000 = 10%).
4. **Review and deploy** — one `createCollection` transaction.
5. **Share it** from the collection page the wizard hands you.

---

## Troubleshooting

- **Wallet won't connect?** Refresh, switch network in the wallet, reconnect. A connection
  that hangs on "Confirm in the extension" will now surface a stalled state rather than
  spinning forever.
- **On a narrow window and can't find the nav?** Widen it. Between roughly 640px and 790px
  the desktop nav is gone and the mobile menu has not appeared yet — a known dead band, since
  the header is fixed so scrolling cannot recover it.
- **Transaction stuck pending?** Speed up or cancel from your wallet; the app picks up the
  new state. A **reverted** transaction is reported as a failure, never as a success.
- **NFT not showing in Lending?** Only supported collections are listed.
- **Seeing "could not read" instead of a number?** That is deliberate. The app refuses to
  render a failed read as a confident zero.

## Next steps

- [`/learn`](https://memetics.finance/learn) — guides and explainers
- [`/faq`](https://memetics.finance/faq) · [FAQ.md](FAQ.md)
- [`/changelog`](https://memetics.finance/changelog) · [CHANGELOG.md](CHANGELOG.md)
- [`/security`](https://memetics.finance/security) · [SECURITY.md](SECURITY.md)

Questions go to this repository's Issues or Discussions — **there is no Discord or Telegram
yet.** Community channels are unregistered operator work, and this file claimed one for
months.
