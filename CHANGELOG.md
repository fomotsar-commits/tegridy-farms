# Changelog

What changed for a user of memetics.finance, one plain line per change, newest first,
grouped by the UTC date it reached `mvp-launch`, by pull request or by direct push. This
page keeps the newest thirty days.

## [Unreleased]

### 2026-10-03

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

### 2026-09-21

- The BAYLA staking cards are rebuilt, and the wrong readings the rebuild turned up are fixed.
- The changelog page can name the builder of a change beside its date.
- memetic.fun is no longer treated as a name for this venue.

### 2026-09-20

- tegridyfarms.vercel.app redirects to memetics.finance instead of serving a second copy of the venue.
- The footer carries the owner's permanent Discord invite.

### 2026-09-19

- The dead Discord invite and the retired Telegram handle are gone from the footer.

### 2026-09-18

- The launch gate's reading names the tier as the wallet's own, and its verdicts carry no em dash.
- "Check graduation" no longer says a token has not graduated from a read it never made.

### 2026-09-17

- The venue opens straight to the page; the arrival film plays only from "Watch the arrival" on /island.
- Leaving the BAYLA lock ladder early costs the time left over four years, capped at 75 percent.
- A live reward rate on the BAYLA lock ladder can no longer be lowered.
- The lock ladder card shows no APR, states its reward window honestly, and promises nothing it cannot prove.
- "Nothing to claim" is no longer shown over revenue balances that were never read.
- The USDT approval reset now happens when it is needed, not skipped on an unread allowance.
- The staking runway is no longer invented from a failed read.
- An ended LP reward period no longer reads as a live 0.00% APR on /farm.
- The liquidity card no longer says "Confirmed" after an approval, before the real action is sent.
- A Gold Card membership that could not be read is no longer sold back to its owner on /premium.
- "Not enough TOWELI" is no longer said about a balance nobody read.
- Nakamigos: an unread listings feed no longer shows as a healthy empty market.
- The NFT pool owner's panel no longer hides a queued timelock change behind an unread value.
- Pool volume is no longer printed from an unread fee rate, and /treasury no longer shows a 0.00% POL share from an unread LP supply.
- The home page's /swap card stops describing one pair on one route.
- An unread input no longer tells a staker they are a Seedling on the score card.
- Nakamigos: a listings set from one venue no longer speaks for the whole market.
- Nakamigos: an unread listings source no longer reads as an empty market.
- An unread staking, LP or referral read no longer shrinks your points.
- The arrival curtain keeps its time budget even when the page is busy.
- The zap planner checks your wallet's chain against the pool's, not against itself.
- A Connect Wallet button with no wallet modal to open is disabled.
- The launchpad no longer arms Mint or names a sale phase from an unread sale state.
- The token picker and token detail dialogs keep focus and scroll lock steady while the page re-renders.

### 2026-09-15

- Four buttons that said "Connect Wallet" and were disabled for saying it now open the wallet modal.
- The venue's icons carry their version in the path, so clients stuck on the old Nakamigos mark update.
- The BAYLA lighthouse card keeps its Connect button now that deposits are closed.
- Trust Wallet connects on the Solana side of the venue.

### 2026-09-14

- The art studios show every surface, doors are authorable, and the island mark replaces the old icon.

### 2026-09-13

- The venue no longer speaks in prose as one of its residents.
- GeckoTerminal trades and charts load through a caching edge instead of failing under the rate limit.
- One canonical host for every page and for the sitemap.
- The TOWELI/ETH pool card no longer labels the venue's own fee as an LP APR.
- Nakamigos: collection and trait offers name the token that fills them, and can be accepted.
- /pools stops calling itself /solana.

### 2026-09-12

- The old BAYLA Streamflow pool is closed to new deposits; existing stakers can still claim and leave.
- A live BAYLA lighthouse position that is still earning can claim again.
- The remaining mainnet reads load for a wallet connected on Base or Robinhood.
- Seven more mainnet reads no longer go blank for a wallet on Base.
- The arrival curtain always lifts inside its time budget.

### 2026-09-11

- The named trade tape no longer returns a server error, and /chart shows its live data.
- A wallet last used on Base no longer sees the mainnet farm as empty and ended.
- The arrival curtain no longer covers a page that has already loaded.
- The LP farming card says when its farm-wide reads failed, and its Stake button guards on them.
- During a pause, the staking card's exit sends the call that works for your position.
- An old ?tab=liquidity link lands on the liquidity page.
- The LP farming section keeps its heading while it loads.

### 2026-09-10

- The BAYLA lock ladder gets its staking card.
- The arrival's backdrop is the door.

### 2026-09-07

- The lighthouse card's max boost quotes the longest lock you can pick, and /dashboard shows rewards that can no longer be claimed as stranded.

### 2026-09-06

- A BAYLA lighthouse position past the claim limit is no longer offered a claim that fails, and can still leave.
- The home page opens on the heat instrument: your own number first.
- Liquidity has one chain-aware page, and the swap page stops duplicating it.
- On Base and Robinhood the swap page says why it cannot quote instead of going quiet.
- The mobile menu shows one row per section.
- /liquidity and /farm no longer scroll sideways on a phone.
- The top bar is six words with no dropdown, and liquidity has its own section.

### 2026-09-05

- The six EVM ladders point at their redeployed pools, and deposits reopen.
- Deposits are closed on the six EVM ladder pools built before the fix.
- Nakamigos: My Bids, bid history, My Offers and My Listings load again.
- Four fixes from the 4 September field review.
- /chart, /competitions and /copy-trading can reach the indexer again.
- Nakamigos collection listings load through the venue's proxy again.
- Eleven more places where a failed read showed as a fact now say they could not read.
- Nakamigos: a route that is gone for good says so instead of retrying.
- Nakamigos: accepting an offer no longer spends gas on an approval when the fill cannot be built.
- The close button works on every titled dialog.
- A failed read no longer renders as a fact on the worst two surfaces a sweep found.
- A missing Alchemy key no longer falls back to a shared public key.
- The nav logo loads its small image again, 1.5 KB instead of 189 KB.
- Two images that shared one derived file each show their own, and /gallery is wired.
- The zap-off icon on /security draws correctly.

### 2026-09-04

- The More menu goes from 21 rows to 7, behind tabbed hubs.
- Homepage images that rendered broken in production load again.
- A rejected Alchemy key says so instead of answering 200.
- The Alchemy RPC proxy reports upstream failures as failures.
- Art images are about 31 percent smaller across ten routes.
- An EVM ladder's empty-pool rewards can no longer be taken by a three-wei stake.
- Headings use Archivo, and one more wallet can connect.
- Swap quotes from the seven aggregators are checked for shape before they are shown.
- The floating assistant bubbles no longer eat taps on a phone.
- Three security defects found by code scanning are fixed.
- Ten places where a failed read showed as a fact now say they could not read.
- The 3 September field review's findings are resolved.
- Every nav entry that said SOON is now a working page.

### 2026-09-03

- Phantom appears in both wallet modals, and the Solana swap is rebuilt.

### 2026-09-01

- The lighthouse stake card is a labelled grid that no longer breaks mid-line on a narrow screen.
- The Tegridy name is retired from every rendered surface, and the venue speaks as itself.

### 2026-08-31

- The venue wears the island mark on every icon, and Tradermigos reads Marketplace where visitors see it.
- The hall of doors opens under the venue hero, the arrival opens no modal, and every resident gets its own walls.
- The front door stops saying Tegridy Farms and speaks as the venue.
- The EVM bungalow dashboard no longer offers staking buttons that could only revert.
- Every visitor sees the lock ladder's tiers, connected or not.
- All six EVM lighthouses move to ladder pools.
- The install offer waits for the first-run dialogs instead of stacking a third.
- The lighthouse card shows the pool's full rate range and leads with what changes the decision.
- The EVM lighthouse card offers TOWELI's lock ladder, 7 days to 4 years, with an early exit.
- PEPE's lighthouse lands, so all thirteen bungalows stake, and six EVM residents are no longer told they are on Solana.
- A barely funded vault no longer prints a full APR above its own banner saying it pays 0%.
- Four Base staking cards that could not read their pools now load.
- The four Solana lighthouses go live: BOBO, SOY, BRAINLET and RIZZ.
- SOY and BRAINLET point at their real mints instead of look-alike tokens.
- Five Base lighthouses go live, and RIZZ moves to the chain it lives on.

### 2026-08-30

- All thirteen bungalows are built out, with a round of lighthouse exit-safety fixes.
- The BAYLA lighthouse moves to its replacement pool, where a longer lock earns more.

### 2026-08-29

- The Connect button is no longer cut off on a tablet, and the lighthouse lock warning comes before the wallet prompt.
- The lighthouse lock picker starts at the shortest lock instead of 30 days, on a pool with no early exit.
- The /pools status card is readable over bright bungalow art.
- The Solana LP venue opens on /pools, with a swap client and the venue's own pool router.
- The Bayla farm no longer claims a swap fee the venue is not taking.

### 2026-08-28

- Bayla's dashboard states the pool's rate and its vault together.
- Bayla's staking card is rebuilt with preset lock buttons, her Solana swap is wired, and her dashboard is reworked.
- A frontend audit wave fixes 46 verified findings.
- Bayla's page shows her market chart, trade tape and holder distribution.
- /bayla-studio lets art be picked and placed inside a bungalow skin.
- /eth-curve lists live launches, every launch gets a permanent /eth-curve/:token page, and a creator can claim their fees.

### 2026-08-27

- The lighthouse pool reads through the venue's RPC proxy, and features that are live stop saying they are being built.
- /nakamigos stops loading a font the site's security policy always blocked.
- Solana pages stop failing in production builds on a missing Buffer.
- Solana pages no longer crash in production on a blocked stylesheet import, and the top nav gets a bungalow chooser.
- Tokens launched on the EVM curve carry an image, a description and socials, signed by their creator.
- The BAYLA lighthouse card reads its live mainnet pool.
- BAYLA staking uses the Token-2022 program BAYLA's mint lives on, instead of assuming the legacy one.

### 2026-08-26

- The BAYLA lighthouse staking card is built, ready to switch on when its pool exists.
- The TOWELI staking card stops promising a JBAC boost it cannot grant, a dry pool shows a real zero APR, and a claim receipt shows the amount paid.
- The Base and Robinhood curve launchpads are live.
- An NFT loan repay covers the minimum-interest floor, so it no longer reverts.
- The /bayla page keeps its own title after it loads.
- Nakamigos: four more places where a failed read looked like a fact.
- An RPC endpoint that refused every request is dropped from all five failover lists.
- Bungalow doors unfurl, and Bayla gets her dashboard.
- 332 KB less JavaScript before first paint.
- The orderbook's fill checks no longer depend on a single Alchemy key.

### 2026-08-24

- The Base and Robinhood legs, graduation stacks, and the venue's own EVM curve.
- A reverted transaction no longer shows as a success anywhere.
- Ghost links, false claims and dead references are removed from the site.
- Bungalow doors in the /bayla format, with in-venue BAYLA trading and heat.
- NFT finance: a repay pays past a stale quote, and repay or claim failures show.
- Same-origin requests are no longer refused at the API's resource gates.
- Bayla speaks for herself, token first.
- Jungle Bay bungalows: Bayla's background, and a bungalow picker after the intro.
- The Meteora launch rail is retired, and Solana graduation facts point at the venue's own pool.
- Colours that pointed at a missing theme token use real ones.

### 2026-08-23

- Light mode is removed.

## Earlier

The long form lives in git. `git show 531813e6:CHANGELOG.md` is this file as it stood before
it was cut to one line per change, and `git log` holds every change since.
