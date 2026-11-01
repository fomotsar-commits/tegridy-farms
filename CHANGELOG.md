# Changelog

What changed for a user of memetics.finance, one plain line per change, newest first,
grouped by the UTC date it reached `mvp-launch`, by pull request or by direct push. This
page keeps the newest thirty days; an older day moves to `docs/CHANGELOG_EARLIER.md`.
The site's Changelog tab shows both files.

## [Unreleased]

### 2026-10-31

- Dashboard: once you have a lock, stake or pool share, the big figure is Total, what your wallet holds and your positions together, with Holdings and Positions under it. No total is printed while a part is still being read, could not be read or has no price, and that part says which.
- Pools: picking Ethereum, Base or Robinhood Chain in the network menu now shows that network's pools even when your wallet stays on another network. Before, a wallet that did not switch kept the page on its own network, so a pick of Base still listed Ethereum's pool. When your wallet is on a different network from the one picked, a line above the form says so, with a button to switch; adding or removing waits until the wallet is there.
- Home page: the TVL now counts what is staked with us, not only what our pools hold: the BAYLA lock ladder and the lighthouse pools on Solana, TOWELI staking, and the ladders on Ethereum and Base, retired ones included while they still hold stakes. Each counts what people staked in it, never the rewards it holds, with the coin at its market price (Jupiter's on Solana, DefiLlama's on Ethereum and Base). What counts shows pools and staking chain by chain. When a staking pool cannot be read, or a staked coin has no market price, it says "TVL at least".

### 2026-10-30

- Pools, Venue AMM: a new Arbitrage card under Start here lists every pool whose price is far enough from Jupiter’s listed price for a trade to pay, most profitable first, and for each says what to pay, what comes back, the profit after the pool’s fee (and the token’s transfer fee, when it has one), where that fee goes (liquidity providers, memetics.finance, a pool’s creator), and the pool’s price after; its Swap opens the swap page on that trade with the amount filled in. The card says when its figures were read, reads again every 30 seconds while the tab is in view, keeps the last figures and says their age when a read fails, and has Read again. Every pool row and every pool’s card now have Swap beside Add, opening the swap page on that pair, and each row shows what the pool holds in dollars at Jupiter’s prices beside its name. The arbitrage lines under a row and the page’s Details drop-down are gone (the Rates and status cards say the same). A swap link to a coin Jupiter does not list now opens on that coin, read from the chain, instead of sliding to SOL and BAYLA; while a link’s coin is being looked up the swap form waits (no quote, no Buy), and a coin that could not be looked up at all is said, with the pair the form opened on instead.
- Pools: on a phone, each row of Venue AMM's All pools list puts its Add, Swap and View buttons under the pool's details, so its name, its dollar figure, its details and its tags use the row's whole width instead of under half of it.
- TOWELI staking: the farm page and the dashboard say "Beta is over", because staking v1 is closing. One line under it says where v1 stands, read from the chain: rewards still running, rewards stopped (with whether the reward reserve can pay what you've earned), or paused, when your stake comes out with no 25% penalty; on a lock that has not ended, that exit gives up rewards you have not claimed. When the chain can't be read, it says so. The site no longer takes new stakes, lock extensions or Auto-Max Lock into v1, and Zap no longer offers the staking lock; Claim and every way out stay, and Claim is switched off on the dashboard during a pause. A withdrawal's receipt now shows what came back (an early exit's net of its penalty), and the exit during a pause gets one too. A new staking contract replaces v1; its date is not set.
- Every room's door shows its torches from Jungle Bay Island: how many of twelve are lit, the next torch's price in $BAYLA, who lit the last one and when, and Torch it, which opens the room's page on the island. A pool that pays nothing shows them above its notice. The home has a strip under the doors: $BAYLA locked in the ladder, $BAYLA fed to the fire, the flames, the days left in the season and the island's last torch. Each is read on load; one that cannot be read is left out, never shown as 0.
- Solana swap and the Range tab: a coin whose ticker copies SOL, USDC, BAYLA or an island coin at another address now reads "fake SOY" (for example), as on the pool screens. In the swap page's token list, a coin the site does not name itself shows its whole address, not just its first and last characters. The Range tab names every coin by its own ticker, with its whole address, instead of "tokens".
- Home page: TVL now shows beside the all-time volume. It is what our pools hold on Solana, Ethereum, Base and Robinhood, read from the chains every minute, with each chain's figure under What counts. When a chain cannot be read, it says "TVL at least" and names that chain. The all-time volume is now counted every five minutes instead of every few hours, and both figures refresh on the page every minute.
- Bungalow staking: when the reward program can never pay a position's rewards, the message now says your stake is safe, instead of calling it BAYLA on every bungalow.
- Earn: a new Harvest card claims your staking rewards from every pool with one button, instead of opening each pool. Once a wallet is connected it reads each lighthouse pool and the lock ladder on Solana, and each lighthouse pool on Ethereum and Base, lists what each pays in its own coin, and sends each pool's own claim, one wallet approval per claim. Each pool pays from its own reward vault; the venue takes nothing. A pool it could not read says so. A reward the pool cannot pay yet, one paid in another coin, and the TOWELI farm (whose claim can also extend your lock) are left for their own page.
- Harvest is also on every pool's page (such as BAYLA's) and on the dashboard: a room's own, the island's, and the one on the home page. There it shows only while you have something to claim. After a harvest, the pool's own card and the dashboard read your rewards again, and a claim made on a pool's card updates Harvest, so neither shows a reward the other already paid.
- Cardano swap: the coin box now takes the coin’s address as people copy it. Paste the address DexScreener shows, the policy id alone, an asset1… id, or a Cardanoscan, Cexplorer or pool.pm link to the coin. A policy id with one coin under it finds that coin; one shared by several coins lists them by ticker to pick from. A DexScreener or GeckoTerminal link names a trading pair, not a coin, and the box says so. Nothing about how a swap is priced, checked or signed changed.
- Harvest, wherever it appears, asks your wallet once per network for all its claims, instead of once per claim, when the wallet can sign several at once (on Solana, most can; on Ethereum and Base, a wallet that offers batched calls). On Solana each claim is still its own transaction, so one a pool refuses takes no other with it, and each is test-run first so a claim that would be refused is never put to your wallet. A wallet that signs one at a time is asked once per claim, as before.
- Cardano swap: a slow chain read now costs the price far less often. The pool’s read, which the price needs, was cut off after 10 seconds, and our chain data service (Koios) sometimes takes longer, so about one try in four showed “The pool could not be read just now”. A pool read that is too slow, or meets a failing gateway, is now asked once more, with 15 seconds; only when both asks fail does the page say it could not read the pool. The second ask counts against the site’s daily read budget like any other.
- On a pool's page Harvest now sits inside the pool's own card, beside what it says you earned (on BAYLA's, in the lock ladder's Earned panel), instead of above it. When Harvest could not read your Solana pools, it asks again after 20 seconds and a minute, so a moment's failed read no longer hides it until you reload, and the dashboard's Refresh reads Harvest again too.
- Dashboards show what your positions are worth in dollars. The island dashboard (home page and /dashboard) prints each lock's, stake's and pool share's worth on its row and a Positions total beside Holdings. A Solana room's dashboard (BAYLA's, for one) gets a Your positions card listing your lock-ladder locks and pool shares there, with their worth and total, and its lighthouse Staked figure shows its worth too, as do Ethereum and Base rooms' "Your principal". A lock or stake is its coins at today's price (rewards not yet claimed are left out); a pool share is both of its sides. No total is printed while a position has no price or a part could not be read. On a wide screen, the island dashboard's big "Dashboard" heading no longer has its last letters cut off.

### 2026-10-29

- Pools: on Venue AMM's All pools list, a Solana pool whose price is more than 3% above or below Jupiter's market price gets a red "Price over 3% above Jupiter" (or "below Jupiter") tag. Under it, one line says about how much a trader could make by trading the pool back to the market price and how big that trade is, and a second says what that trade pays in fees to the pool's liquidity providers and to memetics.finance. That profit comes out of the pool's liquidity providers, and it is a ceiling: it leaves out the trader's costs on the other side. The list reads Jupiter's prices once for every pool; a pool's own card checks again with live quotes, and its figure can differ by a few points. When those prices can't be read, the list says so and marks no pool. For a token with a transfer fee, the figure counts what the token keeps back of that trade, and the fee line says how much; when the list can't tell whether a token has one, it shows the tag without a figure.
- BAYLA lock ladder: each of your positions now shows how much BAYLA it earns a day and that as an APR on its stake, and "You in this pool" shows your wallet's total a day and its APR. Both come from your weight (stake × lock boost), so a longer lock shows more, and both are at today's rate: they fall when others lock, rise when they leave, and stop when the reward window ends unless it is refilled. The pool's own figures still carry no percentage.
- Solana pools: a token with a transfer fee can now have a pool. Opening one, adding to it, taking out of it and swapping in it work, with the fee taken the pool program's way. The review says how many tokens the token itself keeps, for whoever collects its fee (never the pool or memetics.finance), and every amount shown is after it. The token's card warns that the fee is taken going in, coming out and on every trade, and, when someone can still change the fee, that it can be raised to all of every transfer. Range pools and Add with one coin still turn such a token away.

### 2026-10-28

- The site no longer shows the retired EVM features: the Community tabs for grants, bounties, vote incentives and gauge voting, the Token Lending, Pooled Lending and Pay in Instalments tabs on NFT Finance, the /airdrop and /vesting pages, the restaking lines on the farm and the dashboard, the auto-compounding vault option in Zap, and their rows on Contracts, Tokenomics, Risks and Security. Their contracts left the source in PR #1041; nothing on chain changed.
- Contracts page: Gauge Controller, Vote Incentives, Community Grants and Meme Bounty Board no longer link to a source file. Their source left this repository on 2026-10-27; each row says so, and their verified source is on Etherscan. The Tegridy Restaking and Tegridy Lending rows are gone: neither contract was ever deployed, and their source left with them.
- Notice: range pools' second fee tier, 0.25% of each swap, becomes 1% once the team's vault approves and executes it, which is no sooner than 48 hours after its second approval. Then every range pool charges 1%. No range pool exists on that tier, and the site has never shown it. Of each fee, 84% stays with the liquidity providers whose range is in use, 10.4% goes to memetics.finance and 5.6% to Jungle Bay Island.
- Range pools: the range program's source now charges 0.5 SOL to open a range pool, paid to the team's vault, by each of the three ways it opens one. It reaches mainnet only when the vault executes an upgrade, which is not proposed yet. Until then the program on mainnet charges nothing to open one: the fee tiers exist since 2026-10-27, so anyone can open a range pool for free until that upgrade executes.
- TOWELI staking: when the reward reserve can't pay, the site now says so. A claim that pays nothing (on the farm page or the dashboard) says nothing was paid and your rewards stay owed, instead of showing a receipt for TOWELI that was never sent. Claimable stops ticking up and says the reserve is empty. The early-withdraw confirm says how much unpaid reward that exit would lose for good. The exit offered during a pause no longer promises to pay rewards the reserve can't cover.
- Connect: Coinbase Wallet is on the Ethereum, Base and Robinhood Chain list by name, with Coinbase's mark, third on a phone. It was there as "Base", fifth on a phone, past the four a phone shows without a swipe. On a phone, tapping it opens this page in the Coinbase Wallet app, where every kind of Coinbase wallet connects; before, it opened Coinbase's sign-in, which takes only an email or a passkey. On a computer it still opens Coinbase's sign-in, and a computer with the Coinbase extension shows the extension's row instead. The connect menu now names Coinbase for Solana too, where it has been listed since September.

### 2026-10-25

- The dashboard opens at once for a wallet it has read before in this browser: it shows that wallet's last reading straight away, says "As of 3h ago · updating" beside Refresh, and swaps in the new reading as it arrives. A part the new reading cannot read still says so, never the old figures. On /dashboard a Solana wallet connected here before reconnects as the page opens, not 1.5 seconds later. Measured on a returning visit: rows in about 0.6 seconds, down from about 3.3.
- Pools: a room's Add SOL + coin now opens Add with one coin at the top of the Venue AMM page, above everything else, with the pool's price, the outside price, the gap between them and how each trade's fee splits as rows inside it. The page no longer jumps down to the form, and nothing loading above it moves it. The pool finder, every pool and the rest of the page sit below.
- Solana pools: a pool opened on the launch fee tier without a launch (free to open on the pool program running now) is never listed, swapped in or added to from this site, and a link or a position that names one says so in one bold line. Holders of one can still remove their liquidity. Graduated launch pools are unchanged.
- Pools: the Range tab is on, right of Venue AMM on the Solana network. Range pools have one fee tier, 1%. It is not on the chain yet, so until the team's vault makes it the tab says there is no pool to put liquidity in, and Solana swaps find no range pool to route through.
- Pools: the Solana LP tab is gone. Its pool finder, Add liquidity, Remove liquidity and Open a pool were already on the Venue AMM tab, which now sits left of Range. The Pools menu opens Venue AMM, and an old /solana-lp link opens /pools on the same token.
- Pools: while the page is still reading the chain, or if the read fails, the top of the Venue AMM page no longer says "No pool can be opened here yet". It says nothing until the read lands.
- The dashboard on phones and iPads: its big picture now shows there too. On a phone it is a wide strip that stays under the top bar while your coins and positions scroll beneath it; on an iPad held upright it stands beside them and stops where your list does. With no mouse to follow, it shows the row you scroll to, and that row lights up; SOL and ETH show their chain's mark. With no wallet connected it sits under the connect buttons, and on a phone held sideways it does not stay on screen. On a computer the picture now stays in view while you scroll a long list.
- Cardano swap: Swap's network menu now lists Cardano. /cardano swaps ADA for a coin, or a coin for ADA, through that pair's Minswap V2 pool, signed in a Cardano wallet (Eternl, Lace, VESPR, Begin, Typhon, GeroWallet or NuFi). The page names each coin by its ticker and whole id, shows every fee and who gets it before you sign, and follows your order until Minswap's batcher fills it or sends it back. The venue charges no fee on Cardano yet.
- Moving between pages: on a phone, pages now just open, with no one-second glitch between them. On a computer or tablet the glitch no longer runs into or out of a room with an Add door or the Pools pages; everywhere else it stays, art and all.

### 2026-10-24

- The Nakamigos marketplace is no longer linked from the home page, the site index, the island lobby or the sitemap. It still opens at /nakamigos.
- Solana pools: the pool program's upgrade was rolled back, so it runs its 2026-09-29 build again: pool share tokens can't get a name in wallets and the launch fee tier is open to anyone again until it is upgraded once more. The lines you read before adding liquidity or opening a pool say so again: our pool program is Raydium's, with only its admin keys changed.
- Solana swap: Buy all bungalows buys every coin itself. A coin our own pool pays more for is bought in our pool, in the same order, instead of being sent to the swap form for its own review. Wallets that can sign several transactions at once (Phantom, Solflare, Backpack and most others) are asked once for the whole order; any other wallet once per coin. When SOL's price cannot be read, the order asks again every few seconds instead of once a minute. It also compares prices correctly again: since 2026-10-23 it misread every Jupiter quote and counted every coin as our pool's, even where Jupiter paid more (about 30% more for BRAINLET).
- Solana pools: adding to a launch pool Jupiter has no price for now warns when its price may have been moved without a trade: when nobody has traded it yet it holds more than its shares account for, or when it has had long gaps between trades over the last half hour. Its own average counts only after 24 minutes of trading, not 10. Such a pool is no longer the price the token's other pools are checked against. Removing liquidity is unchanged.
- Solana swap: when your limit orders or DCAs cannot be read, the Limit and DCA tabs say so, with Try again. Before, they said "No open orders" or "No active DCAs".
- Solana swap: Buy asks Jupiter for less, so it waits less. A quote under 10 seconds old is built as shown instead of asked for again, our pools are read at the click instead of after Jupiter's answer, the trending list, the risk warnings and the pair's prices are shared by every visitor for a short time (prices are still read fresh in USD mode), and "Swap confirmed" is checked every second for the first 10 seconds.
- On a 320px-wide phone the menu button stays on screen: below 360px the top bar's memetics.finance name sits on two lines. The Solana swap page no longer slides sideways at that width.
- Solana pools: memetics.finance now serves a name and a picture for the pool shares of six more pools on its pool program: RIZZ/SOL LP, SOY/SOL LP, BOBO/SOL LP, BRAINLET/SOL LP (symbol BRAIN-SOL), CRYING/SOL LP and SOL/USDC LP. A bungalow coin's share shows that bungalow's door art in its ring, the others show BAYLA's. Wallets show these names only once each share has its on-chain name record and the vault renames it, which needs the pool program upgraded again first.

### 2026-10-23

- Solana LP: a new card, Every position, lists who holds a share of each of our pools, with each holder's whole address, share of the pool and what it pays out now; the connected wallet's own rows say You. Your positions still lists only your wallet's.
- A launched token's page: when the maker's allocation, the maker's create-buy or the token's Provenance cannot be read, the card says so in one plain sentence and keeps what failed under Details. The Provenance card no longer uses em dashes.
- Solana pools: the pool program was upgraded. It now has one added instruction, which lets a pool's share token carry a name and a picture in wallets, and one added check: opening a pool the public way no longer accepts the launch fee tier, which is kept for launches. Its on-chain security contact is an email and links on memetics.finance. The lines you read before adding liquidity or opening a pool say so: our pool program is Raydium's, with its admin keys changed, one added instruction that names pool share tokens and one added check that keeps the launch fee tier for launches, and those changes have not had their own independent review yet. "The program" card on /pools and /solana-lp no longer says the program is waiting for an upgrade.
- Analytics events are kept for 90 days and then deleted automatically, every hour, and the Privacy page now says so. Before, nothing deleted them.
- Solana swap: buying a Token-2022 coin such as BAYLA with SOL now carries the 0.50% site fee shown on the form, paid in SOL, like every other SOL pair. Before, Jupiter refused the fee on these coins and the swap went out with no fee.
- Solana swap: Buy all bungalows opens with every coin's figure already on it, at the coin's market price less the site fee, marked "market price". Each coin's exact quote replaces its figure as it lands, about one a second, and Buy waits for all five. Reopening the order within a minute keeps its quotes instead of starting over.
- Solana swap: when Jupiter is busy and turns a call away during Buy, the press waits a moment and asks again (up to twice) instead of stopping with "Not sent" or "Swap not checked". The same holds for Buy all bungalows and Add with one coin.

### 2026-10-22

- Solana swap: the Buy all bungalows order shows each coin's figure as soon as it is read, instead of holding all five until the slowest read came back. Our pools are read alongside Jupiter's quotes now, not before them; a coin whose comparison is still on its way says "Comparing our pool…" under its figure, and Buy waits for it.
- Swap: Buy all bungalows is a numbered ticket stub with the order's coins running on a tape, and the order it opens is a numbered sheet with each coin's door picture and a strip that shows the order's progress. The dashboard draws what the wallet holds by value, each coin's share of it, a tape of the coins held, and each lock's place on the ladder.
- The dashboard shows your connected wallets: the SOL, ETH and island coins they hold, with dollar values where a price was read, and your positions here (locks, stakes and pool shares) with amounts, unlock dates and what each has earned. A part that could not be read says so, with Try again. Every pool on the island is one press away under it.
- The home has the island's dashboard on top of the Swap, Lock BAYLA and Add SOL + BAYLA cards: every pool on the island, numbered, with its picture, its chain and its lock terms. /dashboard shows the same.
- The home's Add SOL + BAYLA card stays in its place while its pool is being read, and says so if the read fails; it used to disappear until the read came back.
- Solana pools' Rates card says each part of the venue's cut as a share of the fee and of the trade, and says in bold, in plain sight, when a fee tier pays anything but the agreed split: the island's part kept by the team's vault, another wallet, or other rates. Before, a tier that sent the island's part to the vault read as fine.
- The home's all-time volume says it counts our pools on Base and Robinhood as well as Ethereum, and is counted every few hours, which is how often it runs. It says "not up to date" only after nine hours with no count, or when a count fails.
- Solana LP: every pool card now shows what is in the pool, its price, the outside price and the difference in plain view, above the deposit checks and the Add buttons. They were inside More about this pool.
- Notice, updated: range pools get two fee tiers, 1% and 0.25% of each swap, no sooner than 2026-10-23 14:00 UTC (it said seven days from 2026-10-21). Of each fee, 84% stays with the liquidity providers whose range is in use, 10.4% goes to memetics.finance and 5.6% to Jungle Bay Island.
- With reduced motion on, the Tradermigos splash holds its art still, every piece in sight, with no sparks or flashes; the pieces had kept bouncing.
- Opening a new pool on Ethereum, Base or Robinhood Chain: the form shows the market price from that network's Uniswap V2 pool, Match the market price fills the other amount at it, and a price you type off the market says how far off it is.
- Base and Robinhood Chain: Liquidity lists the venue's own pools on that network, with what each holds and how its 0.3% fee is split; Add or Remove opens the form on that pool.
- Solana pools: every coin shows its ticker. A coin that is not one of the island's shows the ticker it gives itself, with its whole address under it, on the All pools list, its pool card and Your positions. One that copies the ticker of one of ours, or of SOL, USDC or USDT, reads “fake”, as in “fake SOY”.

### 2026-10-21

- /island and /bayla have the home's Swap, Lock BAYLA and Add SOL + BAYLA cards.
- A room's lore and the staking pool it has on record are one press away, under Read the story and its coin's staking.
- Add with one coin on a Solana pool no longer says "Withdraw any time": it says there is no lock, but the team's vault can pause removing.
- A pool's price, the one you press to flip every pool's price, is easier to tap: its press area is 44 px tall, and the price looks the same.
- On a phone, a press on the bottom edge of the venue card's Program address on /pools and /solana-lp now copies that address; it copied the Config address under it.
- Solana pools: the Risks drop-down on every add, open and review, and the pools page's small print, now say that each change the team's vault makes (pausing removals, changing fees, replacing the pool program) waits 48 hours after both its keys approve. They said it had no waiting period, which stopped being true on 2026-10-19.
- The home shows the venue's all-time volume, counted every hour, with the time it was counted.
- On a wide screen the page column steps up with the screen, from 1536px, and a room lays its cards on a grid: the price chart beside the burn, held time and holders, the lore across all.
- Swap: one amount buys every island coin on the chain.
- Room staking on Ethereum and Base: the card reads the early-exit penalty from the pool it shows instead of assuming 25%. Today's six pools still charge a flat 25%; the pools the owner deploys next keep the ladder's law, the time left on your lock over four years capped at 75%, and the card quotes each position the moment they go live.
- The marketplace fee is now 0.5%, half OpenSea's 1%.

### 2026-10-20

- A room's numbered line on a phone now slides to show the section you are reading; it had lit Holders and Lore off its right edge.

### 2026-10-19

- The menu is the site's index: every section's word with its pages under it, a Jump to field (Ctrl+K opens it), and the word Menu beside the ☰ on a computer. A room's page gets a numbered line under the top bar, lit as you scroll, one tap to each section.

### 2026-10-18

- Base and Robinhood Chain: Pools opens on each network's own coins, not Ethereum's TOWELI; Robinhood's Swap opens on ETH to USDG; a refused switch is said.
- Heat and Rooms are now Island; the menu gains More.
- The home: the chain row gains ROBINHOOD, which opens the curve on Robinhood Chain, and BASE now opens the curve on Base (it opened your wallet's chain, or Ethereum with no wallet). The home's Swap and Add SOL + BAYLA cards each have the network drop-down; picking another network opens that network's Swap or Pools page.
- The Changelog tab (/changelog) now shows this list.
- BOBO, SOY, BRAINLET and RIZZ each have a SOL pool on the venue now, so each room gets Add SOL + its coin, second on its first screen, as BAYLA's has.
- Pool prices flip with a press: press any pool's price and every pool on the page shows it the other way round, such as "1 SOL = 157,392 BAYLA".

### 2026-10-17

- The menu (the ☰ button) is redesigned: it opens full screen, as a circle from the button, with big numbered rows and a picture for each (on a computer, one large picture that changes with the row under the pointer). On phones its last rows are no longer covered by the bottom bar.
- The home's row of three cards is NFT Finance, Marketplace and Launch; Hold and Provide LP left it.
- Inside a room, Heat (top bar and phone bar) opens that room's own page, such as /bayla, instead of leaving for the venue home. Inside the BAYLA room (any Solana room): Pools opens Solana LP on BAYLA, the scanner offers "Try BAYLA" instead of TOWELI, and when Add SOL + BAYLA cannot open its form the card says "This pool's Add form was not opened", no longer "your position's pool".
- Every pool card (Solana LP, Pools and the home): in view are the pool, what LPs keep and what the venue takes, whether swaps and withdrawals are open, the deposit check and Add. What the pool earned, its last 20 transactions, what each trade pays, its price and its address are under "More about this pool". A pool that charges a creator fee still shows the wallet it pays.
- Solana LP, Pools and the home's liquidity card: the amber line about what the team's vault can do is no longer on the page or on the add, open and review forms. The same sentence, word for word, now leads each "Risks" drop-down.
- The home page has three short cards in one row under the Heat reader: Swap (SOL to BAYLA), Lock BAYLA and Add SOL + BAYLA, with one wallet connection for all three; a phone stacks them.
- One network drop-down on Swap, Pools and Launch: Ethereum, Base, Robinhood Chain, Solana. Swap and Pools run on Base and Robinhood Chain (Swap: our pools or Uniswap V2, whichever pays more); a network with nothing there is greyed, with why.
- Lock, inside a bungalow, opens that bungalow's own pool; Back to Earn lists every pool.
- Heat is the only number a person has here now: points, the Venue Score, the Bronze, Silver and Gold tiers and the trading competitions are gone. A room whose reward vault is empty shows no rate and says it pays nothing until funded.
- Adding liquidity to a room's coin is up front now. The BAYLA room has an "Add SOL + BAYLA" button beside Trade, the home's Provide LP card opens the list of every Solana pool (each row with Add), and after a Heat read the home says which of your coins you can add to. Each opens Add with one coin on that coin's SOL pool.
- Solana wallet list on phones: on Android, Phantom opens this page in its own app; inside a wallet's own browser, that wallet is listed once; the whole list fits a small screen.

### 2026-10-16

- Solana pools: the risk line on every add, open and review now says what the team's vault can do (pause removing, change fees or replace the pool program, with 2 of 2 keys and no wait) and that no outside firm has checked our changes.
- Solana LP: a pool whose price is more than 3% off now says what that costs you as a share of what you add, where it said the whole gap went to the first trade. The pool stays open to deposits.
- Solana LP and Pools: opening a pool is called "Open a pool" on its buttons and card, and above its button the card says the whole cost read from the chain: the venue's fee plus account setup you do not get back (about 0.04 SOL today).
- Solana LP, "Add with one coin": the swap step's review now shows its price change. On a route where the site fee cannot be taken (BAYLA's pump.fun route), it no longer says 0.50%: the first Sign sends nothing and shows the review again with "No site fee on this route", and the next Sign sends exactly that.
- Solana LP, Remove liquidity: once a withdrawal is confirmed, the card says what you got (about this much SOL and this much of the token) and offers Swap it, which opens the Solana swap on that token, and Add to another pool, which brings the All pools list up. Close is still there.
- Solana LP: each row of All pools carries short warning tags, such as Trading off, Frozen or Little money in pool, and busy moments no longer hold a pool's Add button back.

### 2026-10-15

- Solana swaps and the price checks behind Add liquidity keep working when Jupiter retires its free host, once the venue's Jupiter key is set on the server; until then nothing changes.
- The bar reads Heat, Rooms, Lock, Launch and Swap, on a phone and on a wide screen. Pools, Check, the island, the records and Dashboard are in the menu, which now opens at every width; Pools still opens Solana LP. The footer is eight links. No bar or tab strip says Soon: a tab that is off is not listed.
- Towelie in the corner: a press on a tab sliding under him as you scroll now opens the tab instead of going to Towelie, in Safari on an iPad too.
- Launch token pages: the disclosure attestation line now gets a real answer, "Attested" or "No attestation", where it said "Cannot verify" on every token. When the check cannot run it says so in one plain sentence, and the technical error waits under Details.
- Launch: the graduation fee line, and the integrator fees on Admin, now count the fees held in launched tokens as well as in ETH and TOWELI. They asked the browser's network connection for the full launch history, which every free provider refuses, so they always warned "only base pairs were checked". They now read it from the site, as the launch list already does.
- Pro Terminal on an iPad held upright (and any window 768 to about 940px wide): the page no longer scrolls sideways. The pools table was widening the whole page by up to 122px; it now scrolls inside its own card, as it always did on a laptop.
- A shared link to the site now unfurls as the home page's own first picture, Bayla at the door, on X, Discord and Telegram. It used to be a text card. A page with its own picture keeps it. X keeps an old card for about a week per link.
- Solana adds, removals, pool openings and swaps: taking your time on the review no longer shuts the wallet. It opens unless something you would sign for changed, and a new warning still stops it.
- Solana LP: every pool on the venue is now listed under the finder as soon as the page opens (pair, fee tier, what it holds, price), with no token to search first. View opens that token's pools. When there are more pools than the list holds, it says so and the search finds the rest.
- Launched token pages (/launch and /eth-curve): the maker's allocation and create-buy now ask other hosts for the launch receipt, and say "could not be read" only when none has it.
- Swap (Ethereum): the venue's swap fee goes only to the venue's own Safe on the trade's chain. Ethereum was set to the Base Safe, which nobody controls there, so the Ethereum swap fee is off until that is fixed. No fee ever went to it.
- Bungalows: clicking through several in a row no longer ends in "rate-limiting, try again" on the price chart and the trades. When GeckoTerminal is busy, the last copy shows with the time it was read.
- Solana swap: token pictures hosted on Irys show again. The image service we use for token pictures started refusing Irys, so those tokens showed letters instead; they now load from Irys directly.

### 2026-10-14

- Pools: Create, Add and Remove come first, then your positions, one Rates card (trade fee, to the pool, to the venue) and one Swap routes card. Four cards that repeated the fee split are now that one table. Ethereum Add / Remove says Add and Remove, not "Grow the Crop" and "Pull Crop Out".
- Earn: a farm or pool whose rewards have ended no longer takes new stakes; the TOWELI/ETH LP farm says it stopped paying on Jun 15, 2026. Withdraw, Claim and Exit still work.
- Bungalows: a lock-ladder or lighthouse pool that pays 0 rewards now, because it was never funded or its rate is 0, no longer takes new stakes. All six Ethereum and Base ladders (PEPE, QR, MFER, BNKR, DRB, JBM) read a rate of 0 on Oct 14, 2026, and nobody is staked in them. Each says so in one line; claim and exit still work, and Stake comes back by itself once a pool is funded.
- NFT owner panel: plain wording in place of the dashes in its notices.
- Bayla lighthouse staking: when a claim or an unstake fails, the reason is read from the program that failed, never from numbers in the error's text. A claim the reward program can never pay could be called "vault short" when a compute count in the error happened to read 6012, which stopped the rescue that frees your stake; and a lock that had not opened could be called "vault short" too.
- Solana LP: "Add with one coin" on our own pools swaps part of your coin for the other, through Jupiter or the pool, whichever pays more, then adds both. Two signatures; if the second is cancelled, it is offered again for an hour.
- A tab left open while the site is updated now refreshes itself once, to the same address, the next time you open a page it has not loaded yet. It used to show "Something went wrong". It never refreshes while a transaction is at your wallet or on its way: it says the site was updated and gives you a Refresh button.
- Earn: the Referrals tab is gone. An old /referrals link opens Earn. A referral link (`/?ref=…`) still works anywhere on the site, and the TOWELI room's dashboard still shows your referral link and lets you claim what it earned.
- Solana swap: one line under the form, and the same on our pool's review, gives the pair's 24h average traded price (weighted by volume, worked out by the site) and how far your trade's price is above or below it. How it is worked out is in a drop-down. When the pair traded too little it says so, and a failed read says "could not be read". It never holds a trade.
- Staking and pools: the card you have money in now wears a steady green ring and a "You’re in" mark, on every staking card, lock ladder, LP farm, your Solana pool shares and the dashboard, so your position is the first thing you see. Cards you are not in keep their purple pulse.
- Fewer words again on Pools, Earn, the pool rooms, NFT Finance, the Marketplace and the Bayla bungalow: a heading and a line per page, the explaining under "Details" or "How it works". Pools on a phone went from 570 visible words to 220.
- Earn on a phone: the Open button for every pool is on the first screen; before, it sat off the right edge of the list. In the TOWELI room, Connect wallet is on the first screen instead of eight screens down.
- NFT Finance: Lend, Borrow and My Loans and the form are one screen down instead of three and a half; the four-step explanations and the shield’s small print fold away.
- Marketplace: the opening animation has an Enter button from the first moment and leaves on its own after about three seconds; the first screen then shows Browse, Buy, Sell / List and Make offer. The marketplace is now in the bungalow studios as "Island · Marketplace", so a skin can dress its backdrop and cards.
- Bayla bungalow: two more doors, Marketplace and NFT loans, on the front page and the dashboard. The studio’s NFT group is now called "NFT Finance".
- Earn and Liquidity on a phone: each pool's Open or Provide button now sits on the screen beside the pool's name. It used to sit past the right edge of the list, reachable only by swiping the list sideways, with nothing to say so. The pool's chain and terms (on Liquidity, its TVL and routed volume) now show under its name.
- A quiet nod to Jungle Bay's music: the footer, the island page and an empty History now link to the collective on Spotify and YouTube. Plain links only, nowhere near a trade, a stake or a warning.
- Bayla bungalow: hand-picked art on 102 more surfaces, across Pools, Earn and the rest of the site, placed in the Bayla studio.
- A link to one part of a page now lands on that part while the page is still loading, when its address is opened directly, and when the same link is pressed again. "The bungalows" on the Island page often left you at the top of the home page instead. "See what you'd earn" on the TOWELI farm now opens the estimate in the TOWELI room; it used to open the front page, which has no estimate.
- After the site goes back to an earlier version, a page could stay broken for one browser: it had asked for a script or a stylesheet while the site did not have it, and kept the wrong answer for up to a year. The site's background worker no longer keeps that answer, and it asks the site again when the browser itself kept it. A browser that does not run the worker is not covered yet.
- Pools and Earn, every tab: each page has a background and each card a picture, and both studios list them all, under the tab's own name (Pools · Add / Remove, Solana LP, Venue AMM, Zap; Earn · Staking, Pool rooms, NFT Loans, Referrals, Yield, Copy Trading, Competitions, Checkout). The same goes for every other tab's cards. Pictures rotate until a studio places one.
- Fewer words on every main page and tab: each says what it does in a line, with the fine print under a small "Details", "How it works" or "Risks" drop-down. What you earn, what the venue takes and every warning stay on screen.
- Solana swap: a swap in one of our own pools now always stops on its review before your wallet is asked. Before, a swap whose fresh quote matched the form went straight to the wallet.
- Solana swap through Jupiter: when the test run of Jupiter's transaction cannot run, nothing is sent and the page says "could not run just now, so nothing was sent. Press again." Before, the transaction went to your wallet unchecked.
- Solana swap: "Swap would fail" now gives only a cause the network itself wrote, in plain words, or a fixed sentence. It no longer shows a line a token's own program printed.
- Swap (Ethereum and Solana): one Ethereum / Solana switch above the swap card. The second, fixed one that covered the top of the form and the review when you scrolled is gone.
- Solana DCA: a recurring order with a Token-2022 token such as BAYLA, on either side, is refused with one sentence before anything is signed: Jupiter's recurring orders cannot run it. Cancel still works for orders already running.
- Solana DCA: the hint now says Jupiter's real minimum, $50 per buy, and when the page has read the price it says what each buy is worth and holds Start below $50.
- Solana swap: a swap you sent and that is not confirmed yet now holds Buy for that wallet, by either route, in every tab of the site and after a reload, with its signature and a link. Buy comes back when the network says it landed, failed or can no longer land, after 10 minutes, or when you turn it back on. Another wallet is not held.
- Solana swap: a wallet whose answer did not come back now reads "Sent or not, we cannot tell" with what was pressed, and the amount is cleared. A price or transaction that could not be fetched at the press reads "Not sent" with the reason, and the form stays as it was. Neither says "Swap failed" any more.
- Solana swap, DCA, limit orders, the BAYLA lock ladder and lighthouse staking: a cancel in the wallet reads the same everywhere, including Trust's cancel that carries only code 4001, and a wallet that was never asked says why.
- Solana swap: a swap sent from the same wallet in another tab now also stops a press already under way here. An open review of a swap in our pool closes and shows the hold card, and a press through Jupiter is stopped just before the wallet. Either way the page says "Not sent" and your wallet is not asked.
- Solana swap with site data blocked: switching to another wallet and back no longer turns Buy back on while the first wallet's swap may still land.
- Solana swap: a wallet that cannot take Jupiter's kind of transaction, or a page with no wallet chosen, now reads "Not sent" with the reason, not "Sent or not, we cannot tell".
- Lighthouse staking: if the wallet signed and the send then stopped, the page now says it cannot tell whether the stake, unstake or claim was sent, and asks you to check your wallet first. It no longer says "Nothing moved".
- Solana swap: when your wallet's answer is lost before a signature comes back, Buy is now held for that wallet too, until the swap can no longer land (2 minutes at most) or you turn it back on. The card says no signature is known.
- Solana swap through Jupiter: the hold of a sent swap now ends as soon as the swap's own blockhash can no longer land, read from the network, instead of waiting out a block-height estimate. The 10-minute limit stays.
- Solana swap through Jupiter: when the test run cannot run twice in a row, the page says "This check keeps failing on our side. Nothing was sent." and, when one of our pools quotes the trade, offers its review.
- Solana swap: the "Swap submitted" note no longer has a dash in it.
- Solana DCA: at most one warning line shows at a time. A Token-2022 token comes first, then "Insufficient", then the under-$50 line.
- Solana swap in our own pool: after a swap that is not confirmed, "I checked my wallet: start over" now turns Buy back on in one press. It still says this does not cancel the swap.
- Lighthouse staking: the rescue that closes a position and gives up its unclaimed rewards now runs past a failed claim only when the network's own log names the reward program's error 6000. A message that only contains the number no longer counts.
- Solana LP: a pool card is now headed by its pair and fee, for example "BAYLA / SOL · 1% tier", like your positions. What the pool has earned comes right under its price, before the fees and the deposit checks. Addresses show short, with the whole address, Copy and Explorer one press away. A token the site lists, such as BAYLA, is named in the amounts and the price instead of "tokens".
- Venue AMM: the fee sheet now shows the public fee tier first, the one every pool opened from this site uses. On mainnet that is 1% a trade, of which liquidity providers keep 0.84% of each trade. The launch pools' tier is under it, as before.
- NFT Finance in a narrow window with a mouse: small arrows now sit over each end of the row of section tabs that has more tabs past it, and a press moves the row along by one tab. They do not show on a phone or a tablet, where the row is swiped, and the keyboard still moves between the tabs themselves.
- Home: the headline no longer jumps 44.5px down, or changes its letter spacing, when the page finishes loading on a phone.
- Home and the TOWELI home: each chain pill (Solana, Ethereum, Base) can be pressed anywhere in an area 46.5px tall, up from 24.5px. The pills look the same.
- Changelog: on a 360px phone, long lines (file paths like ".audit_101/...") wrap inside their card instead of being cut off at its edge.
- NFT Finance, Pooled Lending: on a 360px phone the "Not deployed" badges stay on screen and the page no longer slides 6px sideways.
- TOWELI room: Towelie's round button in the corner steps aside while a row of section tabs is under it, so it never covers a tab. It comes back when the tabs scroll away.
- Launch: on a phone the four steps wrap onto a second line instead of being cut off at "Fees & disclo".
- Heat card: "Post my number" and "How heat is earned" now have a 16px gap between them.
- Solana positions: one transaction reads "The one transaction read on your shares is not a deposit" instead of "None of the 1 transaction". A busy network during "Find this share's pool on the chain" says "the network is busy; try again in a minute" instead of "HTTP 429".
- Safari on pages without a tab row: a text field you tap no longer ends up 2px under the top bar. The page keeps 74px clear under the bar, up from 64px.
- Safari: the label above a text field you tap (for example "Campaign address" on Airdrop) now shows below the top bar, not under it.
- Pages with a row of section tabs (Pools, Earn, Launch, Check, the island's pages, Learn and the rest): the row now scrolls away with the page instead of staying pinned under the top bar, where it covered fields, buttons and links on 19 of the 21 pages measured once you scrolled.
- NFT Finance: the row of section tabs now sits above the overview cards, so on a 390x844 phone it is whole on screen and no longer half under the bottom bar.
- Home on a phone: the address field and the "Read Heat" button no longer grow from 37.5px to 44px tall, or the button's words from 13px to 14px, when the page finishes loading.
- Venue AMM: under the public fee tier's rates, how they are read (or why none could be) now sits in a closed "How it works" or "Why no fee" drop-down, as it already did for the launch tier.
- TOWELI room, footer, welcome screen, Lore and Security pages: the sentences about where Ethereum swap fees go now say a referral share comes off first and the rest goes toward stakers. The TOWELI room no longer says fees go to "the liquidity engine and operations", a share that is 0 on chain.
- NFT collection owners: the owner panel now proposes a price, allowlist or auction change and carries it out 24 hours later (the one-step buttons it had always failed), shows what is waiting, and will not switch a live sale straight between a fixed price and an auction.

### 2026-10-10

- Shared heat links: a memetics.finance/read link for a wallet the island reads now shows the island's painted card of that wallet when it is posted. A cold wallet, or one the island could not be asked about, keeps the venue's card.
- Every page now opens at the top before it is drawn, in the marketplace and across the venue. Before, a page you moved to could show part-way down for a moment and then jump to the top, and on Safari a collection page could pull you back to the top if you began scrolling in its first half second.
- Read Heat: each room shows your place in it as the island counts it, for example "12th of 498 measured", on the room's own read and under each room on the card. A wallet the island does not rank shows no place. "Post my number" now starts with the degrees and carries the place in your deepest room.
- Solana swap: the page opens on SOL to $BAYLA, and inside a Solana bungalow on SOL to that bungalow's coin. A link that names a coin still opens on that coin. $BAYLA is marked as this venue's own coin and asks for no tick box, as it has since 2026-10-08.
- Home: the chain pills read Solana, Ethereum, Base.
- After a visit to the TOWELI bungalow, the venue's own pages keep the venue's footer and words, and Towelie stays on the farm's pages. The same goes for every bungalow's footer card. The art and the Swap link still follow the bungalow you opened last, and so does the dashboard.
- Phones whose browser draws the page under the status bar (such as a Galaxy S25 in the Phantom app): the tab row and the bottom bar's icons stay in place, and on narrow phones the big headline no longer runs to the edge.
- On those same phones, a button or field you move to with the keyboard, and a section a link jumps to, now stops clear of the header, the row of tabs and the bottom bar. With the bars drawn taller there, it used to stop partly behind them.
- NFT Finance on a phone or an iPad: a link straight to a section, such as the Launchpad, now opens with that section's tab in view in the row of tabs, clear of the fade at the row's right edge. It used to sit out of sight past the right edge. Pressing a tab that is cut off at the edge of the row now brings it fully into view; it used to be selected and stay cut off.
- Solana LP: each position now shows what you put in, what it is worth, the fees it earned and how that compares with just holding both tokens. Fees are already inside your pool shares, so there is nothing to claim.
- Solana LP: each pool card shows its last trade and how much each share has grown since the pool opened, and one press reads its last 20 transactions. The row that read "Fees waiting: venue's share" is now "Venue's cut, not collected yet".
- Solana LP, swaps in our own pools and launch trades: when a wallet fails to sign without ever opening its prompt, the card now says what the wallet said, or that this page is no longer connected to it, instead of "You cancelled in your wallet". A real cancel still reads as a cancel.
- Solana LP: two short cards under your positions say how you earn and how the venue earns, with the rates read from the chain and the team's shared wallet as an address you can check.
- Liquidity page: "How do I get paid?" now says liquidity providers keep the whole 0.3% pool fee (the venue's one-sixth cut had never been switched on), and that the venue earns a separate fee on swaps sent through this site's own router.
- TOWELI room, Tokenomics and the assistant no longer say stakers' ETH waits for "when the native pool launches": a payout round waits on 1 ETH of fees reaching the distributor, and the venue's swap fee went 20% to referrals and 80% toward stakers.
- Solana swap: the four staking tokens under "Earn SOL staking yield" no longer show a rate. The four figures (7.5%, 7.2%, 7.0% and 8.0%) were typed into the code and read from nowhere. Each card now names its token, and the note says the page reads no staking rate and what the venue takes on the buy.
- Solana LP: a position and a pool card also say the pace so far and how long it covers, when the pool's own fee record shows that trades paid for it. It is measured from the chain and is never a forecast.
- Solana LP: a read that never answers now ends after 20 seconds and says so.
- Solana swap: when Jupiter quotes more but its transaction fails its test run, the page offers the trade in our pool, saying how much higher Jupiter's quote was, with a review before you sign.
- Solana swap: if the trade on the form changes while a swap through Jupiter is being checked (a token from a link that loads late), nothing is sent and the page says so. Before, your wallet could be asked for the pair the form no longer showed.
- Solana swap: a read that fails or is slow no longer decides where your trade goes. When our pools or Jupiter could not be read, the page says so instead of "No route" or "cannot be traded".
- Solana swap: while a swap through Jupiter is on its way to your wallet, the form, the tabs and the token rails are held and the page describes that trade, not our pool's. A swap is kept in your activity under the wallet that signed it, even if you switch accounts before it lands, and your balance is read again after any swap.
- Site wording now says a Solana swap goes to our own pools or through Jupiter, whichever pays you more, and that a swap in our pool pays that pool's fee inside the quote (1% on a public pool, 0.16% of the trade to the venue).
- Solana LP, Add liquidity: each amount box has 25%, 50% and 75% buttons beside Max. For SOL the percent is of what can go in after fees and account deposits, not of your whole balance, and the other amount follows the pool as before.
- Solana LP, Add liquidity: a short "What if the price moves" table under Review says how a position compares with just holding both tokens: the same if the price ends where it was, about 5.7% less if it doubles or halves, 20% less at 4 times or a quarter. Fees are not counted in it, and it is arithmetic, not a forecast.
- Once launching is switched on, the details file the site writes for a new Solana token says it was made on memetics.finance. It was set to say memetic.fun, which is another project's site. No token has been launched yet, so no launch carries the old address.
- Solana LP: when the page could not check the network as it loaded, it now checks again by itself every 15 seconds. Add liquidity, Remove liquidity and Open a pool come back without pressing Read again or reloading the page.
- Solana swap and launch pages: a read the network never answers is given up after 10 seconds and shown as a read that failed. It used to be waited on for the whole visit. The Solana LP page keeps its own 20 seconds, so each read is timed once and the message names the wait that applied.
- Ethereum, Base and Robinhood Chain reads: a host that starts its answer and then stops is given up after 10 seconds and the next host is asked, so a bungalow's burn card no longer says "Reading" for good.
- An answer that starts and then stops is now given up at its time limit, the same as one that never comes, on heat readings, payment links, uploads, NFT listings and the other reads that waited with no limit.
- Pools, in the top bar, the menu and the phone's bottom bar, now opens the Solana LP tab. The Ethereum form is the tab to its left, Add / Remove.
- NFT Finance on an iPad held upright, or in any window from 768 to 1,118 pixels wide: the page no longer slides sideways. The row of six section tabs was wider than the screen and carried the page with it. It now scrolls inside itself, with a fade at its right edge while more tabs are out of view.
- TOWELI: on the narrowest phones (320 to 360 wide) the "Fixed supply" figure no longer runs under the green tick. A value too wide to sit beside its label drops onto the line below it.
- In the marketplace, a purchase, accepted offer, trade, cancel or approval you sped up in your wallet counts as done, under the transaction that confirmed, instead of being called failed or waiting forever.
- In the marketplace, when a transaction's result cannot be read, the site says it cannot tell and links to Etherscan, instead of saying it failed and offering Retry.
- In the marketplace, a transaction you cancelled or replaced in your wallet says it did not happen, and one that reverted says it reverted.
- The marketplace's Speed Up button follows the faster transaction it sent, and sends nothing for a purchase that already confirmed.
- On every page with a row of section tabs under the top bar (Pools, Earn, Launch, Stats, Trust & Safety and the rest), a button or field you move to with the keyboard, and a section a link jumps to, now stops below the tabs. It used to stop behind them, where it could not be seen or pressed.

### 2026-10-08

- Token names in wallets: the files a wallet reads now name our tokens by the bungalow and then by what the token does: Bayla Staking for the lighthouse staking receipt, Bayla LP SOL and Bayla LP USDC for the two pool shares. The short tickers are unchanged.
- Solana swap: fewer steps and less to read. A swap in our own pool goes straight to your wallet when nothing needs a second look, and the risk tick-box is gone for SOL, USDC and BAYLA and asked once per token for the rest.
- Solana LP: a pool priced in a coin Jupiter has no price for (in practice only BAYLA) can be opened and added to, with a warning before you sign. A price that could not be read still switches both off.
- Solana LP: when Jupiter has no price for a token with a launch pool, its other pools are checked against the launch pool's price. No token has a launch pool yet, so nothing reads differently today.

### 2026-10-07

- Solana LP on a phone: the small links and buttons keep their finger-sized press area without stretching the page around them. The "what to do next" sentence reads as one paragraph again, the venue status card is back to the height it had, and "View on the explorer" is easier to press. With a keyboard, the focus ring goes round the words of each of them.
- Pool shares and the lighthouse staking receipt: the site now serves a name and a picture for the BAYLA/SOL and BAYLA/USDC pool share tokens and for the Staked BAYLA receipt, at memetics.finance/mint/ followed by the token's address and .json. A wallet shows them only once that link is written on each token, which has not happened yet.

### 2026-10-06

- Solana swap: a trade now goes to our own pool when it pays you at least as much as Jupiter, and to Jupiter when it does not. The line under the quote says which, and a swap in our pool opens a review first.

### 2026-10-04

- Solana LP on a small phone: a warning that names a long address no longer runs off the edge of its card, the three "Pair with" choices stay inside the form, the amounts on the add and remove reviews no longer break in the middle of a number, and the small links and buttons (the swap link in the form, Refresh and the copy buttons on the venue status card) are full-size press targets.
- Solana LP: a pool can be paired with SOL, USDC or BAYLA. Open a pool has a "Pair with" choice, so a BAYLA/USDC pool can be opened from the site. Every amount, price and review is in the pool's own coin; the fee to open and the account deposits are still paid in SOL. Pools are listed SOL first, then USDC, then BAYLA.
- Solana LP: any token can have a pool. No price, a price more than 3% off the market, a freezable token or a copied name is now a warning before you sign; tokens with a transfer fee and anything not read are still refused.
- Your positions: each position has an Add more liquidity button beside Remove liquidity. It opens the Add form of the pool that share is in, never another pool's.
- Open a pool: when a token has several pools, the card points to the biggest one whose price is at the market, and "In all, from your wallet" now counts the tokens as well as the coin and the SOL.
- TOWELI: on a phone the "Burned forever" and "Fixed supply" rows are no longer cut off with an ellipsis. A long value wraps onto a second line.
- Burn tracker: a Solana read that never answers is given up after 20 seconds, and the card says it could not read, with Refresh ready again. It used to say "Reading" for good. With no connection, Refresh on an Ethereum or Base bungalow now says it could not read; it used to do nothing and leave the old figure up.
- The dashboard of an Ethereum or Base bungalow (PEPE, QR, MFER, BNKR, DRB, JBM) sits in the page column with side margins. Its cards used to run to the edges of the window.
- Read Heat: inside a wallet's own browser that carries both Ethereum and Solana, such as Trust Wallet's, the button offers "Use my Ethereum address" and "Use my Solana address" instead of asking for Ethereum only.
- Solana pools and trades: a review you take your time reading can still be signed. Sign in wallet builds it again on fresh numbers first; if every line reads the same your wallet opens, and if any line changed you are shown which, beside the button. It used to say the quote was too old and send you back to the form. A launch review is unchanged.
- Every bungalow now has a burn tracker: the percent of everything ever minted that is burnt, the amount and where it went, read from the token's own chain. A burn that could not be read says so and never shows as zero.
- TOWELI: the "Burned forever" row on its page now prints the same figure as the burn card, 25.76% of everything minted. It read 25.8% of supply.

### 2026-10-03

- Solana LP on a phone: the tab opens on Create a pool, Add liquidity and Remove liquidity, with the site's own Solana tokens as buttons, so no address has to be pasted.
- Solana LP: the open-a-pool and add-liquidity forms start with the wallet and the amount boxes. The long notes that used to fill two phone screens above them now follow the form, and the review still repeats the main ones before you sign. A wallet that cannot pay is told so first, with what to do next.
- Solana LP: when a token already has a pool, the Open a new pool card has a button that opens that pool's Add liquidity form (the first pool on the venue, BAYLA/SOL, was opened on 2026-10-03). A greyed Review button now says why right above it.
- Solana LP: Remove liquidity takes you to Your positions, which says that is where liquidity is taken out and, for a wallet with no shares, that there is nothing to remove yet.
- The page that Pools opens has a link to the Solana LP tab on its first screen, and the Pools icon in the phone's bottom bar stays lit on every Pools tab.
- Connecting on a phone with no wallet in the browser: the wallet list says that Open app loads the page inside that wallet's own app.
- Open a pool: a token that already has a pool can have another. The card names the biggest pool that passes the checks and suggests adding to it first, and the Open a pool button stays, so anyone can open a separate pool of their own. Before, the button was taken away once one passing pool existed.
- Solana LP: in a Solana room (BAYLA, BOBO, SOY, Brainlet, RIZZ) one button looks up that room's token, so a phone does not have to paste its address. After a lookup the page moves to the answer, and a token with no pool yet says that opening the pool is how the first liquidity goes in.
- Pools has a Solana LP tab that opens on the pool finder: find a pool, add or remove liquidity, or open a pool on the venue's own Solana AMM.
- Solana pools: a wallet that cannot open a pool or add liquidity yet is told so in plain words, with how much SOL that needs before anything goes into the pool, how much the wallet has, and whether it holds the token. The form used to only grey out Review.
- Solana pools: SOL that a stranger sends to your wrapped-SOL, token or pool-share address before that account exists no longer blocks Remove liquidity, Add liquidity, opening a pool, a curve buy or a pool swap. The site opens the account over it and you pay only what is missing from its deposit.
- Solana pools: a token, a pool share or a lamport that someone sends you or the fee account between the balance read and the test run no longer ends Review with "Blocked: the simulation shows a different token amount than this screen says". Taking more from you than the review says, or paying you less than the minimum, is still blocked.
- Solana pools: when this site cannot build a withdrawal for a token, the message no longer points to a section that is not on screen.
- On the pools page and in the Solana curve and pool-swap panels, a comma typed in an amount, percent or slippage box works as the decimal point, so a phone keypad with a comma and no point can enter 0,5. A pasted amount with thousands commas, such as 68,066, is still refused and never read as 68.066.
- A real token amount too small to show at four decimals reads "<0.0001" instead of "0" on the liquidity, launch and trade screens.
- Pool pages: a token whose name or symbol is a look-alike spelling of a well-known one (SoIana, S0L, TOWELl, BAYLA Token) is flagged as a copy, and this site does not open pools or take deposits for it. Letters or digits outside plain A to Z and 0 to 9 get a warning.
- Launcher: names such as $SOL and Official $BAYLA are refused as copies, by the same rule the pool pages use.
- Open a pool: when our pool index lists its maximum of 96 pools for a token, the button is no longer switched off. The card says the token has more pools than the index lists, and it no longer says a new pool would be the first.
- Your positions: pool shares already matched to their pool are listed first, and reading again does not repeat index lookups that found nothing in the last minute.
- On /curve-launch, while launching is off, the "Who may plant" door shows a wallet's reading and says "Launching here is not switched on yet." It no longer tells a wallet at 80 degrees or more that the launch lane is open, and the "Open a launch" card says launching is off too.
- When a Solana transaction is turned away because it took too long to sign, the card says so and tells you to start over. Nothing was sent.
- Solana swap: when your wallet balance cannot be read, the page shows "Balance: –" with a Retry button instead of "Balance: 0". A balance that really is zero still shows 0.
- Solana swap: "No route" appears only when Jupiter itself says there is no route. If a quote could not be fetched, the page says that and offers "Try again" without you retyping the amount.
- Dashboard, TOWELI room: the TOWELI Price card says "Could not load" when no price source answers, instead of loading forever or showing $0.00000000.
- Solana Connect no longer goes dead while a wallet is being waited on. If Phantom or another wallet is locked, or its approval window opened where you did not see it, the Connect buttons still open the wallet list, the page says which wallet it is waiting for and what to do, and you can pick another wallet without reloading.
- On a Solana page (/pools, /solana, /curve-launch, a Solana pool, or the dashboard in a Solana room) the Connect button at the top opens the Solana wallet list, and shows your Solana address once connected. Before, it connected only Ethereum and Base wallets there.
- Tapping your Solana address at the top opens the wallet list, which now names the wallet in use and has a Disconnect.
- On every other page the Connect button at the top now asks which network first, Solana or Ethereum, so a Solana wallet can be connected from the home page, the Earn list and the doors. Once a wallet is connected the button lists both networks.
- A Solana wallet you connected stays connected as you move between pages, and comes back on your next visit. With an Ethereum wallet connected too, the button at the top names the Ethereum account off the Solana pages and lists both wallets when tapped.
- On a phone, a wallet's "Open app" row in the Solana wallet list now finishes the job. The site opens again inside that wallet's app and asks the wallet to connect by itself. Before, the page inside the app looked like the start again, and Connect, Solana and the wallet had to be pressed a second time. The page left behind says where the connect went.
- Connect buttons that open the Ethereum wallet list (swap, liquidity, TOWELI's pages and the exposure scan) now say "Connect Ethereum wallet" instead of "Connect Wallet".
- The indexer's upload parser moves to a release that fixes two published denial-of-service flaws; it takes effect at the indexer's next deploy.
- A DCA or limit-order swap your wallet cancelled no longer counts as done: the schedule does not count it and the order goes back to waiting. A sped-up swap still counts.
- A TWAP or stop-loss whose registration your wallet cancelled no longer says it was registered, and no CoW order is signed on top of a token approval your wallet cancelled.
- A zap stops at a step your wallet cancelled and says it was replaced, instead of calling it confirmed and sending the next step.
- A cancelled integrator fee withdrawal no longer says Withdrew, and a cancelled curve launch says it was cancelled instead of reporting a missing launch log.
- When the result of a CoW token approval or an integrator fee withdrawal cannot be read, the site says it cannot tell and points to the explorer, instead of showing an error.
- A DCA swap that landed is counted even when the browser will not save to storage, instead of showing Confirming forever, and another open tab can no longer make that schedule swap twice.
- On the Solana swap page, a swap, DCA or limit order that was sent but not confirmed while the page watched says it cannot tell and links to Solscan, instead of saying it failed, and one failed status check no longer reads as a failure.
- On Solana, a BAYLA lock ladder transaction, a DCA or a limit order is called failed only once the network has confirmed the failure; a failure seen before that is watched until the network decides, as a swap already was.
- On /pools, the fee sheet's trader-pays figure for launch pools adds the creator fee that every launch pool charges on top of its trade fee, and shows that fee on its own line, paid to the token's creator. It had shown the trade fee alone, so a trade there read cheaper than it is.
- On /pools, the fee tiers, each pool's card, the add-liquidity panel and its review say what a trade on that pool costs, creator fee included when the pool charges one, and say so when a pool charges none.
- On /pools, a pool you open is shown at its tier's trade fee alone, because a pool opened from this site never charges a creator fee.
- On /pools, the venue card says anyone can open a pool only while the fee tier it read takes new pools.
- The /pools fee sheet's note about where its rates come from no longer has an em dash.
- The site's own tests now run on Vitest 5 and jsdom 30; nothing a visitor sees changes.

### 2026-10-02

- An Ethereum launch's page (/launch) shows the maker's wallet, its allocation and whether its vesting still locks it, read from the launch transaction Doppler's Airlock made.
- A Memetics Curve launch's page shows the maker's create-buy and its wallet, read from the launch transaction, and says the curve has no lock. Each card in its launches list says the figure is on that page.
- /nb1, the island's open lot, opens on its own heading and picture from the first second, and its link preview carries no em dash.
- The BAYLA lock ladder card says 2,000,000 of its rewards came from the island's Workshop on 2026-09-24.
- On /eth-curve, the create form opens only through the Who may plant door, and Create launch reads the wallet's held time again before anything is signed or sent. The launches list and trading stay open to anyone.
- The launch door reads 80 served degrees in every production build: no setting can switch it off or lower it.
- A Solana launch is never announced to the island as a birth, even by a hand-made request.
- Once launching is switched on, every Solana launch on /curve-launch plants 100,000 $BAYLA in its own create transaction: 50,000 burned and 50,000 to the island's Workshop.
- Every launch page says under its door that it is a venue launch; on /curve-launch it also says a plant is 100,000 $BAYLA, half burned.
- Once launching is switched on, the Solana launch form shows the plant and your $BAYLA before Review, and will not review a launch your wallet cannot plant.
- Once launching is switched on, the Solana launch review lists the plant: 100,000 $BAYLA, 50,000 burned and 50,000 to the island's Workshop, from your own $BAYLA account.
- Once launching is switched on, a Solana launch's page shows the maker's create-buy as a share of the supply with the maker's wallet, says it has no lock, and shows whether its launch transaction carried the plant. The launches list shows the same maker figure.
- The indexer moves from Node 20, which stopped getting security fixes in April, to Node 24 at its next deploy; the site already ran on 24 and is now held there.
- The marketplace lists the six Jungle Bay family collections: Gold Cards trade here with the same flat 1% fee, four more can be browsed here and link out to OpenSea, and Junglets shows its facts only.
- When the site cannot read a transaction's result, it says so and points to the explorer, instead of saying the transaction failed.
- A reverted transaction says it reverted, and the Swap button no longer stays stuck after one.
- A transaction your wallet cancelled or replaced is no longer shown as a success; a sped-up one still is.
- A limit order can no longer be sent twice from two open tabs.
- Share to X posts your receipt (amount, lock, boost, APR and the transaction link) with @JungleBayAC and your room's hashtag, and always fits X's 280 characters.
- The receipt card image is drawn before you tap Share, so the share sheet, the image copy and the X window open on your tap instead of after it, where a browser such as iPhone Safari can block them.
- Copy Image on a receipt copies the card as a picture; it had been copying only the text, because the image could not be drawn.
- On a phone, Share to X attaches the receipt card through the share menu, and closing the menu still leaves a link to post it on X; on a computer it opens X and copies the card for you to paste.
- When Copy Image cannot copy the picture, it copies the receipt as text and says so, and if nothing could be copied it says that too.
- A receipt no longer shows a broken character where a long name is cut in the middle of an emoji.
- The security policy no longer puts memetic.fun in scope.
- The indexer no longer treats memetic.fun as a name for this venue.
- memetic.fun can no longer call the venue's API as if it were the venue.
- On /pools, fees appear only once read from the chain: a failed read says the fee tiers could not be read just now and offers Try again, where it used to show an old fee proposal.
- On /pools, a site built without the pool program's id says so, where it used to say the AMM was being redeployed.
- The privacy policy says exactly what an error report holds: one is sent only with your consent and without cookies, wallet addresses and tokens are removed before it is stored, and withdrawing consent deletes any report still waiting in your browser.
- The privacy page gives 14 days' notice at its top: from 16 October 2026, error reports you opt in to are stored on our server, kept for 30 days and then deleted automatically, and none is sent or stored before that date.

### 2026-10-01

- On /pools, a connected Solana wallet can add liquidity to one of our Solana pools whose checks pass, and take its share back out. Each transaction is read again, checked and test-run on the network before the wallet is asked to sign.
- On /pools, a token with no passing pool can be opened as a new pool on the public fee tier, where traders pay 1% a trade. The fee to open the pool goes to the team's vault and is read live, and the Open a pool button appears only once that tier exists on the network.
- Before anyone adds liquidity, /pools says our pool program is Raydium's with only its admin keys changed, that those changes have not had their own independent review yet, what the team's two-signature vault can switch off, change or upgrade, and that Jupiter does not send trades to these pools yet, so most trades will be arbitrage bots. It shows no yield, because none has been measured.
- If adding liquidity ever has to be paused, /pools keeps taking liquidity out working and says adding and opening pools are paused.
- On /pools, the Solana section finds a token's pools by its address, checks the token and each pool's fee tier, price and status, and shows a connected wallet's pool shares.
- On /pools, a token or pool check that could not be read says so, and never shows as safe, healthy or empty.
- /pools no longer says the Solana swap sends a trade to our own pool when ours pays more. The swap compares the two and still trades through Jupiter.
- /curve-launch reads the live Solana launch program. Launching and trading from the site are switched off for now, and the Solana Curve tab says Soon.
- On /curve-launch, the Who may plant door reads a wallet's heat from the island. Once launching is switched on, the create form opens only for a Solana wallet at Resident or better, and Review reads that wallet again before anything is signed.
- Once launching is switched on, a Solana launch's page says a maker at Resident or better can grow a new token through the memetics.finance gate, and that the program itself accepts any wallet.
- Towelie says Solana has our own curve at /curve-launch instead of saying Solana is swap-only.
- Source and audit links on /contracts, /security, /risks and the trust hub go through memetics.finance/source, which forwards them to wherever the code is hosted.
- On the six Ethereum and Base rooms' farms, the swap-fee line names the room's own chain, not Solana, and says what that chain's swap fee really is.
- On /competitions, the board is called the Volume board, and it links to the island's flames board, ranked by heat.
- The heat ladder, its next-tier hint and the explainer's tier list use the island's current tiers: Builder at 300 degrees and Elder at 800.
- The hero, the FAQ and llms.txt read the island's current sentence on rooms.
- The heat explainer reads the island's whole current paragraph, and its current lines on weight and the Apes.
- The heat words now match the island's /heat page: Builder 300°, Elder 800°, every other room adds a quarter of its own, the island's own weigh heavier, your clock on a token starts at your first hold, and Base is named beside Ethereum and Solana.
- On /curve-launch, the door says the island reads every linked wallet, where it used to say a Solana-only wallet cannot be measured.
- The venue counts 12 bungalows, as the island does, and /nb1 is the island's next open lot, linked to its harbor.
- The BAYLA room links to the island's ledger.
- No room's farm page lists a pump.fun creator-fee share as a way to fund its pool.
- The Memetics Curve pitches no longer say a launch takes one signature.
- The /farm Earn header no longer calls lock length held time.
- The birth record calls a Token-2022 mint a Token-2022 mint, instead of saying it is not a mint.
- The Garden lane on /launch no longer says a certified launch runs under the island's covenant instead of the venue's split.
- A bungalow link opens on its own name and picture from the first second.
- The hero, the FAQ and llms.txt say linked wallets read as a single flame.
- The heat explainer's button reads How heat is earned, and Hide once open.
- Every room's farm page reads without an em dash in its hero, its funding card and its heat card.
- On a computer or an iPad, the Solana connect window offers WalletConnect, with its QR code inside the window.
- The Solana connect window has Solflare and Backpack rows: on a phone or an iPad they open this page inside the wallet's own app.
- Page titles, which a screen reader hears on every page change, carry no em dash.
- On a phone, connecting MetaMask no longer stalls after the MetaMask app opens, and MetaMask can estimate gas on Ethereum.
- The Solana wallet list shows every wallet, adds MetaMask and Coinbase Wallet, and a wallet saved on a phone no longer traps Connect.
- The closed BAYLA lighthouse pool is shown only to wallets still staked in it, as a claim box under the lock ladder.
- A Solana staking pool or position that could not be read says so and offers Try again, on /farm and the dashboard.
- Every source link on /contracts opens a file, the TOWELI and fee hook rows say their source is not in the repo, the fee hook row no longer says a redeploy is queued, and the page says a linked file can be newer than the deployed code.

### 2026-09-24

- On phones and iPads the Copy Trading tab reads CT, and no tab runs into the next one.

### 2026-09-22

- Staking cards say how the island reads a locked bag.
- The heat explainer reads the island's sentences.
- Bungalow links open once, on the room's hero.

## Earlier

The long form lives in git. `git show 531813e6:CHANGELOG.md` is this file as it stood before
it was cut to one line per change, and `git log` holds every change since.
