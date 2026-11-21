# The house bidder

A small robot that keeps one honest, fully funded bid for Jungle Bay Ape Club (JBAC) NFTs on OpenSea, on behalf of the venue. GNSS Art can follow later; it is off until you turn it on.

It is a **liquidity service, not a profit engine**: JBAC sells about once a day, so the house bid gives sellers a fair place to sell when nobody else is bidding sensibly. It is labelled "House" on the site, and its rules and trades are published.

## How money moves

- **The house buys** when a seller accepts its bid. The house pays the bid in WETH. OpenSea's 1% comes out of that bid, so the seller nets 99% and the house pays exactly what it bid. No venue fee is added to house bids (it would only move house money from one pocket to the other).
- **The venue earns** only through the house's trading result: if it later sells an NFT for more than it paid. Selling is not built yet; for now the house only buys and holds, at most 3 JBAC.
- **Gas**: bids and normal cancels cost nothing. An approval, an on-chain cancel or the kill costs about $0.01 to $0.02 each at today's gas.

## What it does

Every minute, and at once when the market moves:

1. Reads OpenSea's live feed, the cheapest listings, recent sales and the chain.
2. Works out **fair value** from real sales (wash trades, insiders and outliers removed) checked against listings that have stood at least 30 minutes, from different sellers. Fair value may fall at once but rises at most 5% an hour, so a fake sale or a bait listing cannot drag it up.
3. Bids **fair value less 12%**, plus 5 points for each NFT it already holds, plus 5 points when the market fell more than 10% in a day. Never above 99% of the cheapest listing less 0.001 ETH (above that, a flipper could buy the floor and sell it straight to the house), and never above the ceiling you set in `policy.json`.
4. Keeps **one bid per collection**, for 1 or 2 NFTs, lasting 30 minutes. When it ends, a new one is posted at the new price. It changes price early at most once an hour.

## What it will never do

- Hold the key. A separate program, the signer (`tools/house-signer`), holds it and signs only bids whose every field matches its pinned template. The bot only asks.
- Look at other people's bids, or outbid anyone by a tick to get on top.
- Buy from, or sell to, the owner, the team, Safe signers or the venue's own contracts. A collection bid cannot choose its seller, so every fill is checked: a fill from an insider halts the bot.
- Keep bidding after anything strange: a mint, an owner change on a collection contract, an insider in a fill, a flagged (possibly stolen) NFT, the signer refusing anything, or its books not matching the chain. It cancels everything, kills on chain, and waits for you.
- Post a bid it has not checked itself: after the signer signs, the bot checks the signature belongs to the house and asks Seaport itself for the order's hash before posting.
- Use any private site data. It reads only public OpenSea and chain data.

## The keys folder

Default `C:\Users\jimbo\evm-keys\house-bidder\` (choose another with `--keys <dir>`; never inside OneDrive, which can roll a file back). It holds:

| File | What it is |
|---|---|
| `keystore.json` | the house key, password-protected. Made by `house-signer create`, which prints only the address. |
| `house-bidder.env` | `HOUSE_OPENSEA_API_KEY`, `HOUSE_RPC_HTTP` (comma list), `HOUSE_RPC_WS` (optional), `HOUSE_SEND_URLS`, `HOUSE_PIN_COMMIT` (the commit a live run must be at). |
| `policy.json` | the limits both the signer and the bot obey. Start from `exec/policy.example.json` and fill in `house` and `fundingWallet`. |
| `insiders.json` | everyone who must never trade with the house: `{ "version": 1, "wallets": [{ "address": "0x…", "who": "greencifer.eth", "note": "…" }], "contracts": ["0x…"] }`. The treasury Safe's signers, the operator wallet and the venue's contracts are also built in. |
| `STOP` | if present, nothing new is signed or posted. Any file whose name starts with "stop", in any letter case, counts (`STOP`, `STOP.txt`, the `STOP.txt.txt` Windows makes), and so does a keys folder that cannot be read. The signer's kill writes one itself. |
| `ledger.jsonl`, `trades.csv`, `status.json` | the bot's own records (append-only ledger, one row per NFT bought, the latest status). |

## Start in shadow mode (the default)

```
cd frontend
node scripts/house-bidder.mjs shadow
```

Shadow mode reads the real market and plans real bids, but never contacts the signer: nothing is signed, posted or sent. It treats any sale at or below its standing price as a fill it would have had, and writes the same ledger marked `shadow: true`. Run it for two weeks, then read:

```
node scripts/house-bidder.mjs report --shadow
node scripts/house-bidder.mjs board          (a page at http://127.0.0.1:8796)
```

`shadow --fresh` starts the shadow record over.

## Go live

1. Create the key with the signer, fund the house wallet with a little ETH for gas and the WETH budget, and put its address in `policy.json` and in the site's house registry (`frontend/src/lib/house/houseRegistry.json`, so the site labels it "House").
2. Check everything: `node scripts/house-bidder.mjs status` lists every check a live start makes and which do not pass yet.
3. Prove the order shape once: `node scripts/house-bidder.mjs canary --confirm --price 0.02` places one JBAC bid for one NFT for 30 minutes, checks OpenSea lists it, and cancels it.
4. Start the signer (`house-signer serve`, it asks for the password), then:

```
node scripts/house-bidder.mjs run --live
```

A live start refuses unless: the keys folder and the code are outside OneDrive; the git tree is clean and at `HOUSE_PIN_COMMIT`; the house is in the site's registry; there is no STOP file; and the signer answers for the same house, the same `policy.json` and the same commit.

## Stop, kill, restart

- **Stop**: `node scripts/house-bidder.mjs stop` writes the STOP file. The running bot cancels every bid (without gas), and if OpenSea had already handed a buyer a fill signature in the last 5 minutes, it also kills on chain and waits for that to be mined before it exits. If that kill cannot be sent, or is not all mined, it says so in capitals, lists every bid that can still be filled, and exits with code 1: run the signer's own kill then.
- **Kill**: `node scripts/house-bidder.mjs kill` writes STOP, then has the signer set the WETH approval to zero and bump the Seaport counter, which ends every house bid at once (about $0.02). If the signer is not running, use its own kill: `node tools/house-signer/src/cli.mjs kill`.
- **Ctrl+C** just stops the bot. Its bids end on their own within 30 minutes.
- **After a halt**, read the reason (`status`, the board, or the last `breaker` line of the ledger), deal with it, then restart with `run --live --ack-halt`. A market pause (a fast price drop, a dead feed, 3 NFTs bought in a day) lifts on its own after 2 hours, bidding for one NFT at a time for a day. A pause because the chain could not be read for 3 minutes (`chain-stale`) lifts as soon as it can be read again.
- **Unfinished fill checks**: when the checks on an NFT the house bought cannot be completed (its 90-day history or OpenSea's flags cannot be read), no new bid is posted until they pass. After 5 tries a `review` line asks you to look; `run --live --ack-halt` clears them once you have.
- **Disk space**: the bot will not start, and posts no new bid, with under 1 GB free on the keys folder's drive, so it can always write down the cancels, fills and kills it makes. If the disk does fill up, cancels and the kill still go out, and what could not be written is printed instead.

## Daily limits

At most 0.15 WETH and 3 NFTs bought a UTC day, and about 8 transactions; one flagged (possibly stolen) NFT in a month halts it. These numbers are in `brain/params.mjs`, in code on purpose: changing one is a commit, so the published rules change only for a published reason.

The signer has its own budget too: 20 transactions and 0.05 ETH of gas in any 24 hours, or what `policy.json`'s optional `daily` says (`{ "maxTxs": 20, "maxGasWei": "50000000000000000" }`; the kill is never counted). The bot counts each transaction at the most it could cost and never asks for one past that budget, since any refusal from the signer halts it.

## For developers

- `brain/`: pure decisions (planner, exposure, breakers, fill monitor, books check, report, backtest).
- `exec/`: what acts (executor, ledger, loop, signer pipe client, signature check, board).
- The data layer (`data/`) and the signer (`tools/house-signer`) are separate pieces; the tests here run against fakes of their published shapes (`exec/__tests__/fakes.mjs`).
- Tests: `npx vitest run scripts/house-bidder` from `frontend/`.
