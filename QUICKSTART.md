# Tegriddy Farms — Quickstart

Welcome to Tegriddy Farms. Pick your path below and be up and running in **≤5 minutes**.

- [Path 1 — Earn yield on TOWELI](#path-1--earn-yield-on-toweli)
- [Path 2 — Borrow against your NFT](#path-2--borrow-against-your-nft)
- [Path 3 — Launch an NFT drop](#path-3--launch-an-nft-drop)

**Prerequisites (all paths):**
- A Web3 wallet (MetaMask, Rabby, or WalletConnect-compatible)
- Some ETH for gas on the supported network
- Wallet connected to Tegriddy Farms via the **Connect Wallet** button in the top-right

---

## Path 1 — Earn yield on TOWELI

**ETA: ≤5 min.**

You hold (or want to hold) TOWELI and earn emissions + trading-fee boosts by locking it in the farm.

### 1. Acquire TOWELI

Head to the in-app swap, or use any supported AMM link from the footer. Swap ETH (or another supported asset) for **TOWELI**.

![Step 1](docs/screenshots/step1.png)

### 2. Navigate to the Farm

Open the sidebar and click **Farm**, or go directly to `/farm`. You'll see the active pools, current APR, and total TOWELI locked.

![Step 2](docs/screenshots/step2.png)

### 3. Approve and stake

Enter the amount of TOWELI you want to lock, click **Approve** (one-time), then **Stake**. Confirm both transactions in your wallet.

![Step 3](docs/screenshots/step3.png)

### 4. Pick a lock duration

Choose a lock between **1 week and 4 years**. Longer locks earn a larger veTOWELI multiplier and higher share of emissions. The UI previews your boosted APR before you confirm.

![Step 4](docs/screenshots/step4.png)

### 5. Done — track your position

Your stake and projected rewards now appear in **My Positions**. Claim rewards anytime; principal unlocks at the end of your chosen lock period.

![Step 5](docs/screenshots/step5.png)

---

## Path 2 — Borrow against your NFT

**ETA: ≤5 min.**

Use an eligible NFT as collateral and take out an ETH loan without selling.

### 1. Go to Lending

Open `/lending` from the sidebar. You'll see your wallet's eligible NFTs and a marketplace of active offers from lenders.

![Step 1](docs/screenshots/step1.png)

### 2. Select an NFT as collateral

Pick the NFT you want to borrow against. The panel shows current floor price, max LTV, and the best-available offers for that collection.

![Step 2](docs/screenshots/step2.png)

### 3. Browse offers

Compare offers by **principal, APR, and duration**. Sort by best rate or shortest term. Each card shows the total repayment due and the liquidation condition.

![Step 3](docs/screenshots/step3.png)

### 4. Accept an offer

Click **Accept**, review the loan terms in the modal, then sign the transaction. Your NFT transfers to the lending escrow and you receive ETH in the same tx.

![Step 4](docs/screenshots/step4.png)

### 5. Receive ETH and track repayment

ETH lands in your wallet immediately. Your open loan appears under **My Loans** with a countdown to the due date. Repay anytime before expiry to reclaim your NFT.

![Step 5](docs/screenshots/step5.png)

---

## Path 3 — Launch an NFT drop

**ETA: ≤5 min.**

Spin up a mint-ready ERC-721 drop with allowlist, reveal mechanics, and royalties — no Solidity required.

### 1. Go to the Launchpad

Open `/launchpad` from the sidebar and click **Create Collection**. The wizard walks you through four short steps.

![Step 1](docs/screenshots/step1.png)

### 2. Create the collection

Enter **name, symbol, supply cap, and description**. Upload cover art and (optionally) a pre-reveal placeholder image. The wizard validates as you type.

![Step 2](docs/screenshots/step2.png)

### 3. Configure mint terms

Set **mint price, per-wallet cap, start time, and allowlist (CSV or paste)**. Toggle **delayed reveal** if you want to reveal metadata post-mint. Set your royalty BPS (max 1000 = 10%).

![Step 3](docs/screenshots/step3.png)

### 4. Review and deploy

The review screen shows gas estimate and full config. Click **Deploy**, sign in your wallet, and wait for the confirmation (~30s on most networks).

![Step 4](docs/screenshots/step4.png)

### 5. Share your mint page

On success you'll get a shareable `/drop/<address>` URL, a copy-paste embed snippet, and an admin dashboard for pausing, updating the base URI, and withdrawing proceeds.

![Step 5](docs/screenshots/step5.png)

---

## Troubleshooting

- **Wallet won't connect?** Refresh the page, switch network in your wallet, then reconnect.
- **Transaction stuck pending?** Speed it up or cancel from your wallet; Tegriddy will pick up the new state automatically.
- **NFT not showing in Lending?** Only supported collections are listed — check the **Supported Collections** page in the footer.

## Next steps

- Read the full docs: `/docs`
- Browse the changelog: `/changelog`
- Security and audits: `/security`

Questions? Jump into the community Discord linked in the footer.
