# Ethereum tokens to BAYLA: research and recommendation (2026-10-17)

Research only. Nothing is built and no product code changed. The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md): anything here the owner approves goes there.

## Money first

- **A venue fee taken through Relay is not paid to our wallet when the order fills.** Relay holds it as a USDC balance on its own books until we claim it (on Base), and takes the claim's gas out of it ([Relay app fees](https://docs.relay.link/features/app-fees)). Relay's fee page names no share kept by Relay. One search result said Relay keeps 25% of app fees, and Relay's own pages do not say so. **Not confirmed either way: get it in writing from Relay before a fee is switched on.**
- **Going through an aggregator instead of Relay directly pays a third party on every order.**
  - LI.FI adds its own 0.25% to every order ([LI.FI fees](https://docs.li.fi/faqs/fees-monetization)), and it hands every BAYLA order to Relay anyway.
  - Bungee adds 0.2%.
  - Squid keeps 50% of the venue's fee ([Squid fees](https://docs.squidrouter.com/api-and-sdk-integration/key-concepts/collect-fees-1.md)).
  - For comparison, CoW keeps 25% of the venue's CoW fee (CIP-75, written up in PR #862).
- **A route that lands BAYLA directly never touches our BAYLA/SOL pool.** That holds for Relay, LI.FI and deBridge alike.
  - The BAYLA is bought in pump.fun's pool `8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n` (live Jupiter quotes, 2026-10-17), so that pool's fee goes to its owners and LPs.
  - The venue earns only its fee on the Ethereum leg.
  - The owner ruled that a trader's route through another venue is not a leak when it pays more. It is still a trade our pool and its LPs never see.
- **Already true today, by owner decision of 2026-10-02: a SOL to BAYLA buy that the site sends through Jupiter carries no venue fee.** pump.fun's pool rejects the fee on the SOL side, and the site rebuilds the trade without it ([jupiterFeeRetry.ts:3-17](../frontend/src/lib/solana/swap/jupiterFeeRetry.ts)). A buy that goes to our own pool pays the venue 0.16% of the trade ([TODO_OPERATOR.md:449-453](TODO_OPERATOR.md)).
- deBridge's licence keeps any positive slippage for deBridge ([deBridge legal](https://docs.debridge.com/dln-details/overview/legal)). That is the trader's money, not the venue's, and the trader never sees it.

## The answer

1. **The contact's reading is not true today.** Three things stop it:
   - CoW is Ethereum-only.
   - CoW refuses an order smaller than its own fee.
   - The site has no route from Ethereum to Solana ([solana.ts:5](../frontend/src/lib/solana.ts)).
2. **Build it, as "bring your Ethereum tokens to BAYLA", not as "sweep your dust".** Real dust does not survive the trip (see "Dust" below). Most dust wallets also cannot pay for the one approval a memecoin needs.
3. **The path:**
   - Relay, called directly, delivers SOL to the visitor's own Solana wallet.
   - Our own swap then buys BAYLA from our pool whenever it pays at least as much as Jupiter ([route.ts:7](../frontend/src/lib/solana/route.ts)).
   - That is two signatures on one page, plus an approval for a token not yet approved.
   - No new program, no new contract, no bridge of our own.
4. **Do not build:**
   - venue-paid gas for empty wallets;
   - a multi-token sweeper;
   - a deBridge or Mayan hook into our pool;
   - anything through LI.FI, Squid or Across.

**Why deliver SOL rather than BAYLA:**
- It is the only way the BAYLA buy can reach our pool, because no service can call our program (see below).
- It leaves the new Solana wallet with SOL to pay for its next transaction. Relay cannot add a gas top-up on Solana.
- It costs the trader about the same.
  - On a $20 order, before our fee, Relay's SOL leg costs 0.43%.
  - Landing BAYLA directly costs 2.33%, which already includes pump.fun's pool fee and the BAYLA account rent.
  - Add our pool's 1% and the same rent to the SOL path and the two end up close. Which pool has the better price on the day decides the rest.

## Who can do it (live quotes, 2026-10-17)

| Service | Ethereum token in | Delivers on Solana | Can it land in our pool? | Code and audits | Track record |
|---|---|---|---|---|---|
| **Relay** | any token its source swappers (0x, KyberSwap) can price; TOWELI and PEPE quoted | SOL, USDC, BAYLA (BAYLA through DFlow) | No: its call steps take Ethereum addresses only | SDK MIT; settlement contracts carry MIT headers; audits by Spearbit/Cantina (2025-02), Certora (2025-06), Zellic (2025-11, 2026-04) | $20B+ (Feb 2026); no incident found |
| LI.FI | yes | SOL, USDC, BAYLA (BAYLA through Relay) | No: its Composer is Ethereum-side only | contracts LGPL-3.0; 110 audit reports, 101 of them by one researcher | exploits in 2022 ($600k) and 2024 ($11.6M), both draining unlimited approvals |
| Mayan | yes | SOL, USDC; **not BAYLA** (no route at any size) | Only through a new program of ours plus a keeper (custom payload) | SDK MIT; Solana programs have no verified build | ~$20B (Sep 2026) |
| deBridge | yes | SOL, USDC, BAYLA | Possibly, through a Solana hook we would write. Whether solvers fill it is unverified | contracts BSL 1.1; API licence proprietary and bans "aggregation" use | $20B+, no incident claimed |
| Across | USDC only | USDC only, to a wallet that already has a USDC account | No | BUSL-1.1 | Solana relayer exploit 2026-07-17 (~$4.5M gross, paid by the relayer; users lost nothing); Solana intents still off |
| Squid | Solana is a closed beta | SOL, USDC | No | router source not public | keeps 50% of the venue's fee |
| Jupiter | no cross-chain swap of its own; its bridge page points to deBridge and GUM | | Jupiter does not route through our pool program ([LpDisclosures.tsx:52](../frontend/src/components/solana/lp/LpDisclosures.tsx)), and listing needs an audit first | | |

Today Jupiter routes SOL to BAYLA only through pump.fun's pool. USDC to BAYLA goes USDC to SOL (Kipseli), then pump.fun's pool. Our LI.FI proxy ([aggregator.js:71-90](../frontend/api/aggregator.js)) is same-chain, price-only, and its fee leg is blocked ([swapFee.ts:111-116](../frontend/src/lib/fees/swapFee.ts)). Nothing cross-chain runs on the site today.

## What a $20 order costs

Live quotes on 2026-10-17, with ETH at about $2,400, SOL at about $103, and gas at about 0.1 gwei. The input is 20 USDC on Ethereum.

| Route | Arrives | Trader's cost | Venue gets |
|---|---|---|---|
| Relay to SOL, our 0.5% set | 0.1921 SOL ($19.81) | 0.93% including our $0.10, plus about $0.02 to $0.05 of approve and deposit gas | $0.10 into the Relay balance, then 0.16% of the BAYLA buy if our pool wins |
| Relay to BAYLA, our 0.5% set | 28,925 BAYLA ($19.43) | 2.83% including our $0.10 | $0.10 only |
| LI.FI to BAYLA, no venue fee | $19.12 | about 4.4% (LI.FI 0.25%, Relay $0.24, spread) | nothing |
| Mayan Swift to SOL | about $19.87 | about $0.13 | its referrer fee, if one is set |
| deBridge to BAYLA | $19.78 | about $3.42 (a flat 0.001 ETH plus $0.94) | its affiliate fee, if one is set |

**How money moves on the recommended path:**
- **What the trader pays:**
  - Ethereum gas, from their own ETH.
  - Relay's fee, out of the order ($0.04 on $20 to SOL).
  - Our venue fee, out of the order.
  - The BAYLA buy: our pool's 1% (0.84% to its LPs, 0.16% to the venue), or, if Jupiter pays more, pump.fun's pool fee.
  - About 0.002 SOL of rent for the first BAYLA account, either way.
- **What the venue earns:**
  - The fee we set on the Relay leg, as a share of the order's input value. At 0.5% that is $0.10 on $20.
  - 0.16% of the BAYLA buy when our pool has the better price.
- **What Relay earns:** its own fee. It pays integrators no share of it below $10M a month of volume ([Relay fees](https://docs.relay.link/references/api/api_core_concepts/fees.md)).

## Dust: where moving stops being worth it

Gas is cheap today, about 0.1 gwei; it reached 1.87 gwei three days ago. At that price an approve costs about $0.01 and a swap-and-send about $0.05 to $0.07. Two things make it dearer in practice:
- Wallets often tip 1 gwei, which makes gas about 10 times dearer.
- Solvers price gas high: CoW priced it at 8 to 17 times the live base fee.

What that means per token:
- **Below about $0.50, nothing works.**
- **Below about $5, every route loses more than 10%.** The one exception is a visitor who holds ETH, tips low and uses Relay. Measured losses:
  - CoW: 5 to 11% on $5 (PEPE 10.6%), and 19% on $1.
  - Relay: 5.7% on $5 to BAYLA, and 19% on a $1.26 TOWELI order.
- **deBridge costs about $3.40 to $3.70 per order whatever the size**, so it is out below about $35. Mayan costs about $0.12 to $0.48 per order.
- **A token with no liquidity gets no quote at all.** CoW answers `NoLiquidity`; Relay and LI.FI find no route.

So the page should:
- quote first;
- show the cost as a share of the order;
- refuse an order whose cost is above a cap the owner sets, for example 10%. Trust Wallet's dust cleaner does the same.

## The approval problem

A wallet with no ETH cannot send the approval most memecoins need.

**Few memecoins support a gasless permit:**
- 9 of 50 Ethereum memecoins checked (18%) support an EIP-2612 permit. PEPE, SHIB, FLOKI and MOG do not.
- About half of the top 250 tokens do.

**What each service offers instead:**
- **Relay:** gasless only for USDC (an EIP-3009 signature) or for a token already approved to Permit2. A first Permit2 approval is an on-chain, unlimited approval, paid in ETH.
- **LI.FI:** gasless only for wallets already delegated to Uniswap's Calibur contract (EIP-7702).
- **Mayan:** its gasless mode returned no quote in any test.
- **deBridge:** every order needs 0.001 ETH sent with it.
- **CoW:** gasless approval works only for tokens with a permit.

**The only way to serve a zero-ETH wallet that holds a memecoin without permit is EIP-7702 plus a sponsor who pays the gas.** That means the venue fronts ETH on every attempt, and strangers can farm it. **Do not sponsor.** Show the visitor the live gas figure instead (about $0.05 to $0.60 today, depending on their wallet's tip).

## How a stranger could abuse each option

**Relay direct (recommended):**
1. **Swap the output, refund or fee address** in the request, through a tampered page or a browser extension.
   - Our server builds the request.
   - `recipient` is the connected Solana wallet and `refundTo` is the connected Ethereum wallet.
   - `appFees` is set on the server only.
   - The page compares the quote's `details.recipient` and `fees.app` with what it asked for before anything is signed.
2. **Approval phishing:** a spoofed step asks the visitor to approve an attacker.
   - Every step's `to` must be on a fixed list: the token being sold (for its approve), Relay's contract `0x4cd00e387622c35bddb9b4c962c136462338bc31` (seen in today's quotes; confirm against Relay's published list), and Permit2.
   - Every approval is for the exact amount. Today's Relay approve was exactly 20 USDC.
   - Never ask for an unlimited approval. Both of LI.FI's losses came from unlimited approvals.
3. **Look-alike tokens, and token names written as bait:**
   - List only tokens that have a live quote.
   - Never show a token's own name as a link.
   - Hard-code the BAYLA mint `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump`. Relay marks BAYLA as unverified.
4. **Burning our API key or rate limit:** keep the key on the server, as `JUPITER_API_KEY` already is ([aggregator.js:163-180](../frontend/api/aggregator.js)).
5. **Theft of the fee balance:** whoever controls the fee recipient address can claim Relay's app fees. Use a team Safe; Relay accepts EIP-1271 signatures.

**LI.FI:**
- Every Relay risk above, plus its 0.25% on every order.
- A history of unlimited-approval drains.
- A widget that fills in the destination from the page URL unless the destination is pinned in its config.

**deBridge hook into our pool:**
- A new instruction set that we write and maintain: new surface.
- Whether solvers will fill it is unknown.
- A manual cancel needs SOL on Solana.
- Refunds arrive in USDC, not the memecoin.
- deBridge does not check the affiliate recipient.
- deBridge keeps any positive slippage.

**Mayan custom payload:**
- A new program of ours, plus a keeper we pay to run.
- On Mayan's MCTP route, setting our fee raised Mayan's own fee by the same amount, so the trader pays twice.
- A Swift order that is not gasless accepts any refund address.

**Venue-sponsored gas (EIP-7702):**
- A stranger drains the sponsor wallet with orders that never complete.
- Phishing for 7702 delegations: a delegation pointed at a bad contract hands over the whole wallet.

## If the owner says go: the smallest build

1. **Server:** one new `relay` entry in [aggregator.js](../frontend/api/aggregator.js), shaped like the LI.FI entry.
   - It allows `POST /quote/v2` only, with a fixed list of fields.
   - The destination is fixed to SOL on Solana.
   - The fee and the fee recipient are added on the server.
   - The API key is read from a server-only env var.
2. **Page:** a "Bring tokens from Ethereum" card on the Solana swap page. It needs both wallets connected, which the `<SolanaProviders mixed>` mode in PR #858 provides.
3. **Signing:**
   - Run the checks from the abuse list first.
   - Then run Relay's returned steps with the wallet connection we already have.
   - Copy Relay's step loop from its MIT `relay-kit` verbatim rather than writing our own.
4. **Buying BAYLA:**
   - When Relay's status says the order is filled, open our existing SOL to BAYLA swap with the amount received.
   - The review always shows, per the owner's ruling of 2026-10-13.
5. **Tests, each seen red first:** the card refuses to send when
   - the recipient does not match;
   - the fee does not match;
   - a step's `to` is not on the list;
   - an approval is unlimited;
   - the cost is above the cap.

**Owner calls:**
- (a) Go or no-go.
- (b) The venue fee on the Relay leg: 0, 0.25% or 0.5%. CoW's is 0.5% in #863. Also, which Ethereum-side Safe claims it.
- (c) A Relay API key, made by the owner. Relay says a key has been required since 2026-10-02, though keyless calls still worked today.
- (d) The cost cap above which the card refuses an order.

## Sources

**Live calls on 2026-10-17:**
- Relay `api.relay.link/quote/v2`, LI.FI `li.quest/v1/quote`, Mayan `price-api.mayan.finance/v3/quote`, deBridge `dln.debridge.finance/v1.0/dln/order/create-tx`, Across `app.across.to/api/swap/approval`, CoW `api.cow.fi/mainnet/api/v1/quote`, Jupiter `lite-api.jup.ag/swap/v1/quote`.
- Ethereum gas from `eth_feeHistory` on publicnode and drpc.
- ETH price from CoinGecko, Coinbase and Kraken.

**Docs, read 2026-10-17:**
- Relay:
  - [app fees](https://docs.relay.link/features/app-fees)
  - [fees](https://docs.relay.link/references/api/api_core_concepts/fees.md)
  - [Solana](https://docs.relay.link/references/api/api_guides/solana.md)
  - [security](https://docs.relay.link/references/protocol/security.md)
  - [fee sponsorship](https://docs.relay.link/features/fee-sponsorship)
- LI.FI:
  - [fees](https://docs.li.fi/faqs/fees-monetization)
  - [Solana](https://docs.li.fi/introduction/lifi-architecture/solana-overview)
  - [gasless](https://docs.li.fi/guides/gasless-transactions)
  - [Composer limits](https://docs.li.fi/composer/lifi-api/reference/limitations)
  - [2024 exploit](https://revoke.cash/exploits/lifi-2024)
- Mayan:
  - [fees](https://docs.mayan.finance/build/fees-earning)
  - [custom payload](https://docs.mayan.finance/integration/custom-payload)
  - [gasless](https://docs.mayan.finance/features/gasless-execution)
- deBridge:
  - [fees](https://docs.debridge.com/dln-details/overview/fees-supported-chains)
  - [Solana hooks](https://docs.debridge.com/dln-details/integration-guidelines/order-creation/hooks/solana-hook-data)
  - [affiliate fees](https://docs.debridge.com/home/monetization/affiliate-fees)
  - [legal](https://docs.debridge.com/dln-details/overview/legal)
- Across:
  - [embedded actions](https://docs.across.to/introduction/embedded-actions)
  - [Solana relayer exploit](https://cryptobriefing.com/across-protocol-solana-bridge-attack/)
- Squid: [fees](https://docs.squidrouter.com/api-and-sdk-integration/key-concepts/collect-fees-1.md)
- CoW:
  - [fees](https://docs.cow.fi/governance/fees)
  - [hooks FAQ](https://docs.cow.fi/overview/cow-hooks/cow-hooks-faq)
- Jupiter: [bridges](https://docs.jup.ag/user-docs/onramp/onboard/bridges)

**Not confirmed:**
- whether Relay keeps any share of app fees;
- whether Relay creates the BAYLA account for a brand-new wallet;
- which chain a failed Relay order refunds on;
- whether deBridge solvers would fill a hook into a pool Jupiter does not index;
- Mayan's gasless mode on Ethereum.
