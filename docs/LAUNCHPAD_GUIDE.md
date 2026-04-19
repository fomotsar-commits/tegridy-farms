# Launchpad Guide

A walkthrough for artists and collectors deploying an NFT collection through the Tegridy Farms Launchpad. Written for someone who is comfortable with a wallet but has never interacted with permanent storage (Arweave / Irys) before.

## 1. Overview

The Launchpad is a click-deploy flow for ERC-721 drops. You bring images and a CSV of traits; the wizard uploads everything to permanent decentralized storage, deploys an ERC-721 contract in your name, and hands you back an Etherscan link and a contract address you can share with collectors.

At the end, you'll have:

- **An ERC-721 contract** deployed to Ethereum mainnet under your wallet's ownership.
- **Permanent image + metadata storage** on Arweave (via Irys) — not IPFS, not a server we control.
- **OpenSea-ready collection metadata** (cover, banner, description, royalty) via ERC-7572 `contractURI()`.
- **Admin controls**: pause, set mint phase (closed / allowlist / public / dutch), reveal, withdraw proceeds, cancel-and-refund.

You stay the sole owner of the contract. The Tegridy Farms team does not take custody, cannot mint on your behalf, and cannot change your royalty or metadata after deploy.

## 2. Prerequisites

- A wallet (MetaMask, Rabby, Rainbow — anything EIP-1193) with an Ethereum mainnet balance.
- Enough ETH for:
  - **Contract deployment gas**: roughly **0.01–0.02 ETH** depending on network conditions. The factory uses EIP-1167 minimal proxies, so it's cheaper than deploying a fresh contract.
  - **Permanent storage**: **$10–15 of ETH** for a 10,000-item collection with ~1 MB images. Smaller or larger collections scale linearly. The wizard shows an exact quote before you confirm.
- Your images (PNG / JPG / WebP / GIF) in a folder.
- A CSV of traits — see section 3.

## 3. CSV format

The CSV is how the Launchpad knows which traits go with which image. It's a [Thirdweb-style](https://blog.thirdweb.com/guides/how-to-upload-csv-to-ipfs/) format — one row per token, columns for the filename, name, optional description, and up to 16 trait pairs.

### Required columns

| Column        | Purpose                                                        |
|---------------|----------------------------------------------------------------|
| `file_name`   | Filename as uploaded (e.g. `1.png`). Must match exactly.       |
| `name`        | Display name on OpenSea (e.g. `Towelie #1`).                   |

### Optional columns

| Column                  | Purpose                                                           |
|-------------------------|-------------------------------------------------------------------|
| `description`           | Per-token description. If blank, empty string is used.            |
| `attribute_N_trait`     | Trait category (e.g. `Background`). `N` is `0` through `15`.      |
| `attribute_N_value`     | Trait value (e.g. `blue`).                                        |

Trait pairs must be complete — if you supply `attribute_0_trait` you must also supply `attribute_0_value`. Missing pairs are silently skipped.

### Worked example

See [`/sample-collection.csv`](../frontend/public/sample-collection.csv) — you can download it from the wizard via the "Download template" link under the CSV picker.

```csv
file_name,name,description,attribute_0_trait,attribute_0_value,attribute_1_trait,attribute_1_value,attribute_2_trait,attribute_2_value
1.png,Towelie #1,Don't forget to bring a towel,Background,blue,Rarity,Common,Mood,Chill
2.png,Towelie #2,Don't forget to bring a towel,Background,green,Rarity,Common,Mood,Hyped
3.png,Towelie #3,Don't forget to bring a towel,Background,red,Rarity,Rare,Mood,Chaotic
```

Save the file as UTF-8. Excel / Numbers / Google Sheets all export this format by default.

## 4. Image requirements

- **Formats**: PNG, JPG, WebP, or GIF. SVG is rejected (too many attack vectors).
- **Filenames**: must exactly match the `file_name` column in the CSV, case-sensitive. `1.png` is not the same as `1.PNG`.
- **Size**: no hard cap, but we warn at 20 MB per file and block at 100 MB. Over 5 MB per image is usually a sign that something should be compressed.
- **Count**: no hard cap, but expect a warning over 10,000 files. Upload cost and time both scale with total bytes.
- **Aspect ratio**: any — the contract doesn't care. OpenSea displays however you upload.

Tips:

- Keep filenames simple: `1.png` through `10000.png` is the easiest to debug.
- Compress first. [Squoosh](https://squoosh.app/) is a one-click tool that cuts PNG size 50–80%.
- If you're doing a delayed reveal, upload the "real" images separately later via the admin panel; the wizard can deploy with only a placeholder.

## 5. Step-by-step walkthrough

### Step 1 — Connect

Connect your wallet. The wizard checks you're on Ethereum mainnet (or the supported testnet if you're experimenting). No signature is requested yet.

### Step 2 — Upload

Fill in the collection metadata:

- **Collection Name** (e.g. `Towelies`). Shown on Etherscan + OpenSea.
- **Symbol** (e.g. `TOWEL`). 3–8 uppercase letters is the convention.
- **Description** (optional). Supports plain text; no markdown.
- **Max Supply** (e.g. `10000`). Cannot be increased after deploy.
- **Mint Price** in ETH (e.g. `0.05`). Can be adjusted later by the contract owner.
- **Max / Wallet** — per-wallet mint cap. `0` means no cap.
- **Royalty** — EIP-2981 secondary royalty. Cap is 10%; most creators set 5–7.5%.
- **External Link** (optional). Must start with `https://`.
- **Cover / Banner** — the OpenSea cover (square) and banner (wide hero) images. Strongly recommended.
- **Images** — select all of them at once. Browsers support multi-select and folder-drop.
- **Traits CSV** — the file from section 3.

The wizard runs inline validation as you add files. Red messages are blocking; amber messages are warnings.

### Step 3 — Preview

A grid of the first 12 tokens rendered with your CSV attributes. Scan for typos. The CSV is parsed here and any row issues are surfaced. If something looks wrong, go back to step 2.

### Step 4 — Fund & upload

The wizard calculates exactly how much ETH is needed to permanently store your images and metadata on Arweave, then asks you to confirm two transactions:

1. **Fund** — moves ETH from your wallet into the Irys bundler. Takes one block.
2. **Upload** — pushes every image and every metadata JSON. Takes 1–10 minutes depending on collection size.

If the browser closes mid-upload, any bytes already paid for are still yours — Irys receipts are permanent. You can resume by reconnecting the wallet and re-entering the wizard; the draft persistence (see FAQ) will bring you back where you left off.

### Step 5 — Deploy

A single transaction to `TegridyLaunchpadV2.createCollection(...)`. The factory deploys a minimal proxy of `TegridyDropV2`, initializes it with your params, and emits `CollectionCreated`. You'll see:

- The new collection contract address.
- An Etherscan link (source pre-verified — our factory uses the canonical template bytecode).
- An OpenSea link (indexed within 5–30 minutes post-deploy).

You are the owner. Admin functions are on the collection contract itself.

## 6. FAQ

**What if my browser closes mid-wizard?**
The wizard persists to IndexedDB on every state change. Re-opening the page with the same wallet reloads your draft. File inputs (images, cover, banner) have to be re-picked because the browser can't serialize them, but every other field is remembered.

**Can I edit metadata after reveal?**
Yes. The contract owner can call `setBaseURI(newUri)` or `setContractURI(newUri)` at any time. ERC-7572 emits `ContractURIUpdated` so OpenSea re-indexes within an hour.

**Can I cancel a sale and refund?**
Yes. `cancelSale()` moves the contract to the `CANCELLED` phase. Every minter can then call `refund()` and get back exactly what they paid — the ETH is held in the contract until claimed. Once cancelled, you can't un-cancel; this is a one-way switch by design.

**What's the royalty max?**
10,000 basis points = 100%, but realistically OpenSea enforces its own caps. Most creators set 500–750 bps (5–7.5%). The value is stored in EIP-2981 and in the `contractURI` JSON so marketplaces without 2981 support can read it either way.

**Is there a platform fee?**
Yes. The factory is configured with a small platform fee (basis points, capped at 10% and timelocked for change). It's split off at `withdraw()` time. Current rate is visible on [Etherscan](https://etherscan.io/) by reading the factory.

**Can collectors mint directly from Etherscan?**
Yes, the `mint(quantity, proof)` function is public and verified. For allowlist phase you need a valid Merkle proof — most creators distribute a mint page that fetches the proof for the connected wallet automatically.

**How do allowlist proofs work?**
You generate a Merkle tree off-chain from the list of wallet addresses. Each leaf is `keccak256(abi.encodePacked(address(this), wallet))`. The wizard doesn't set an allowlist at deploy time — use `setMerkleRoot(root)` from the admin panel after deploy to enable it.

**What is Arweave? Why not IPFS?**
Arweave stores data permanently via a one-time up-front payment, no pinning required. IPFS requires someone to keep a node up indefinitely. Irys is a bundler that makes Arweave uploads fast and cheap by batching them.

## 7. Troubleshooting

**"Wallet rejected funding transaction"**
You declined the Irys fund tx, or the wallet failed to sign. Hit Retry in the wizard. The quote is re-fetched each time so the amount will be fresh.

**"Upload stuck at N%"**
The Irys bundler has timed out. Don't refresh yet — hit Retry first. The wizard resumes from the last confirmed chunk. If retry fails three times, the wizard surfaces the raw error; usually it's a browser extension blocking large requests.

**"Etherscan says contract not verified"**
Wait 5–10 minutes. The factory uses the canonical `TegridyDropV2` bytecode, which Etherscan recognises by hash — verification is automatic but not instant. If it's still unverified after 30 minutes, paste the [`TegridyDropV2.sol`](../contracts/src/TegridyDropV2.sol) source manually.

**"Transaction is pending forever"**
Gas price spiked above what your wallet quoted. Speed up the tx from your wallet's pending-tx panel with a 20% gas bump, or cancel and resubmit.

**"CSV row count doesn't match image count"**
The wizard shows which rows reference missing files and which files have no row. Either add the missing image, add the missing row, or delete the extras. The wizard won't let you advance until counts match.

**"Mint is paused after deploy"**
That's the default. The wizard deploys with `initialPhase = CLOSED` unless you explicitly set otherwise. Open minting from the admin panel via `setMintPhase(2)` (public) or `setMintPhase(1)` (allowlist, after setting a merkle root).

**Anything else?**
Open a [Discussion](https://github.com/fomotsar-commits/tegriddy-farms/discussions) with the collection address, the transaction hash, and a screenshot of the wizard state.
