import { m } from 'framer-motion';
import { pageArt } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';

interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

// Each card rotates through a distinct art piece so every entry feels its own.
// Uses pageArt with a dedicated changelog-cards pageId so card art stays
// disjoint from the page background (which uses the 'changelog' pageId).
const CARD_ART = Array.from({ length: 16 }, (_, i) => pageArt('changelog-cards', i));

const CHANGELOG: ChangelogEntry[] = [
  {
    date: 'August 1, 2026',
    title: 'The Solana Rail Is Armed — and the Lock On It Was Weaker Than Advertised',
    items: [
      'Something now exists on Solana mainnet for the first time: the partner configuration that our Meteora launcher launches against. Yesterday\'s note said nothing had ever been created there; that is no longer true. What has still not happened is a launch — zero tokens have gone through this rail, and every number shown on the Solana launch page remains a default the software proposes, not a record of anything that has traded',
      'The Solana launch page has not changed and will not: it has no signer and no submit button, by design. Launches are signed by the operator outside the app. If you read "the rail is armed" as "you can launch on Solana here", that is the wrong reading — arming the rail and opening it to the public are separate steps, and only the first has happened',
      'The safety check protecting every fee this rail will ever earn was weaker than our own documentation claimed. Meteora\'s fee-claim signer has full custody of accrued fees and can send them anywhere, so that signer has to be a genuine multi-signature vault. Our check proved the vault was derived from a real Squads account — but never opened that account to look inside. A 1-of-1 "multisig", which is just one key with extra steps, would have passed as multi-signature custody. Worse, a different kind of Squads account could have been substituted entirely, producing a configuration whose fee claimer nobody can ever sign for — which would have stranded every partner fee permanently, with no recovery',
      'The check now opens the account. It confirms the account really is a multisig — matched on the identifying bytes at its head, so no substitute type gets through — and requires at least two signers. Anything else is refused rather than assumed safe. We verified the check genuinely bites by deliberately weakening it and confirming the test that should fail does fail',
      'The uncomfortable part, stated plainly: the instruction "fix that guard before creating the configuration" was written in our own notes, and the fix had been written on July 26 — but it was never published to the shared repository, so the code everyone actually ran still had the weak check when the configuration was created. It is published now. We are recording this rather than quietly shipping the fix, because the gap between "we wrote a fix" and "the fix is in what runs" is exactly the kind of thing that is easy to leave unsaid',
    ],
  },
  {
    date: 'July 30, 2026',
    title: 'Launcher Repairs, and What Is Built But Not Live',
    items: [
      'The launch button had been refusing roughly six attempts in seven. The wizard demanded an ETH/USD price less than 5 minutes old, but the mainnet price feed publishes on a roughly 1-hour heartbeat — measured across 40 consecutive rounds, every single gap exceeded the limit while the feed was perfectly healthy. The launch path now uses a window matched to the feed; swap quotes keep the tight one, where a stale price is a real loss',
      'The whole of the protocol\'s 15% fee line was routed to an address that could never claim it. The fee locker pays only whoever calls it, and RevenueDistributor has no function through which such a call could ever be made — so naming it would have stranded that line permanently, and the locker only lets the CURRENT beneficiary re-point its own slot, which RevenueDistributor could no more do than claim. Both fee legs now route to the treasury multisig, which can originate the claim. The honest cost: that line is not staker yield today, and the Fact Sheet no longer says it is',
      'TOWELI-paired launches were submitting an auction band about 10x wrong — a declared $300k down to $30k went on-chain as roughly $30.1k down to $8.3k — and it simulated successfully, so nothing downstream would have caught it. The launcher now rebuilds the band from the exact numbers it is about to sign and refuses before signature if they disagree with the declared band by more than 2%',
      'The Launch Explorer and Afterlife could never have listed anything: the feed behind them was a hardcoded empty list. Launches are now discovered from on-chain records and matched to us by reading each token\'s registry entry. A token we cannot prove is ours is never shown — and if any record fails to read, the surface says plainly that it could not look, rather than showing a confident short list. "Nothing has launched yet" and "we could not check" are different answers, and they now read differently',
      'The post-graduation fee re-attestation added on July 26 called a function the deployed fee locker does not have. Every call reverted, and the code reported that as "not graduated", so no token could ever have been re-attested. Its tests passed the whole time because they mocked a response the real contract never produces. Rewritten against the contract\'s actual interface, probed directly on-chain, with the parts that genuinely cannot be read labelled unreadable instead of reported as "nothing there"',
      'Launcher fee revenue was both invisible and uncollectable: balances were read through a function name that does not exist on the deployed contract — failing silently, so it would have shown "nothing to claim" over any balance that did accrue (all currencies read zero at the time of the fix, and no launch has yet gone through this rail) — and nothing in the app ever called the withdraw function at all. Both fixed, with balances now on an operator page that keeps "nothing owed", "could not read" and "partially read" as three visibly different answers',
      'Two things that had never worked at all. memetic.fun was not on its own API allowlist — verified live, a request from the site to its own endpoint came back 403 — so every Solana price and data call made from your browser on the live site was being rejected outright, with eleven other endpoints one code path from the same failure. Fixed on all twelve, with a test pinning each of them (it checks the known twelve by name, so it does not yet catch a thirteenth endpoint added later). And the Solana operator tool could never build a transaction, because it never set a fee payer or a recent blockhash; that is why nothing has ever been created on Solana mainnet through it',
      'Built, explicitly NOT live: the contracts that would graduate a launch into a Uniswap V4 pool carrying our own hook (TegridyLiquidityMigrator and TegridyFeeLocker) are written and tested, but the migrator address in the app is still zero — and while it is zero, every launch graduates exactly as it does today, into Doppler\'s standard hookless pool. LockerClaimer, the small contract that would let the 15% line reach TOWELI stakers instead of the treasury, is written, tested and wired to nothing. On Solana there are now two programs in this category and neither is on mainnet: a constant-product AMM fork from July 10 that is devnet groundwork only — never deployed to any cluster — and explicitly not audited, and a bonding curve built on July 30 and put under CI. Neither has ever held anyone\'s funds',
      'A note covering everything above, learned the hard way in July: a change merged into the repository is not a change on the live site until the site is redeployed. All of this landed in the repository on July 30 and was deployed on July 31 — so if you are reading this on memetic.fun, it is live, not merely merged. The items marked "built, not live" above stay that way regardless of any deploy: those are gated on an address or an audit, not on shipping the site',
    ],
  },
  {
    date: 'July 29, 2026',
    title: 'Tests, and a Backup, That Had Never Run',
    items: [
      '13 contract test files — 126 tests — had never executed in CI. The test patterns could not reach any subdirectory, and ten top-level files matched nothing at all. Among them were all five regression tests written for the July 12 audit: added, and never once run. They now run, generated from a single manifest, with a guard that fails the build on any test file no slice claims. All of this runs in the public repository, so the workflow runs are checkable without taking our word for any of it',
      '37 invariant tests had never run either — AMM k-growth and LP-supply conservation, NFT-pool price monotonicity and fee accrual, staking and reward invariants, fee-router conservation, TWAP first-observation. They had been assumed too slow to gate; measured and tuned, the gate now runs them at 32 runs x depth 256 — 8,192 calls per invariant, about a minute. All 37 passed on their first-ever execution',
      'The browser end-to-end suite had been allowed to fail without failing the build — an escape hatch added in May 2026 and never revisited. All six failing specs turned out to be stale test selectors rather than product bugs. Fixed, and the hatch removed. Now the part that matters, because leaving it out would be the same defect this entry is about: 40 test runs across five specs are still skipped, because no pipeline supplies the forked chain they need. The skip sits at the group level, so it takes out more than the money paths: only about a quarter of those are the stake/swap/liquidity/borrow/claim transactions, and the rest are plain render checks for /farm, /swap, /liquidity and /nft-finance. So the green check does not even prove those four pages render. The machinery to run them was built the same week and deliberately not wired in yet',
      'The database backup workflow had never taken a backup. Every scheduled run since June 15 reported success while dumping, encrypting and uploading nothing. Those tables hold signed marketplace orders that exist nowhere else and cannot be reconstructed from chain data. It now fails loudly until the backup is actually configured',
      'The public Dune queries behind our on-chain figures carried a precision bug that silently truncated ETH amounts — any sub-1-ETH figure returned 0. Caught by running a query against an answer already known, and traced through four wrong forms before landing on one verified at both magnitude extremes. Honest status: the corrected form is published in the repository and applied to one of the five live queries so far, the other four still carry the old divisor, and there is no published dashboard yet',
    ],
  },
  {
    date: 'July 28, 2026',
    title: 'Trust Hub, Launch Radar, and Two Money-Path Corrections',
    items: [
      'New /trust hub names the token scanner, deployer graph and wallet-exposure tools as one anti-rug suite and explains how to read a result — concentration is not fraud, and a gap is shown as a gap. They had been sitting under a generic "Stats" heading beside protocol vanity metrics, and were missing from the footer entirely',
      'Launch Radar on the launch page: a market-wide feed of brand-new pools, each row deep-linking into the scanner. It is separately labelled as NOT from this rail and endorses nothing. The Launch Explorer and Afterlife stay empty until a launch of ours graduates — filling them with market-wide pools would have fabricated a track record. What we did not notice at the time: the feed behind those two surfaces was hardcoded empty, so they could not have listed one of ours either. That was found and fixed on July 30',
      'Radar honesty fix, found while checking the live site: the upstream feed reported a 12-minute-old scam pool at $1,016,163,865 per token, which rendered as by far the largest liquidity figure on the page. Rows whose upstream price is not a physically plausible market price now read "—" (unmeasured) rather than repeating fiction faithfully',
      'Shared /scan and /deployer links now unfurl as real preview cards naming what is being looked at. The card never asserts a verdict, score or safety band — the real read is computed in your browser, so a card claiming "safe" could contradict the page it links to',
      'Home page gained a "Launch & Verify" section and a third hero button, "Scan a token" — the scanner is genuinely useful with no wallet connected, while the other two calls to action both asked you to connect or buy first. Strictly additive: no existing section, copy or art was moved or removed',
      'Two money-path corrections on the live launcher. On a TOWELI-paired launch the 15% protocol line was routed to a contract that only ever handles ETH, so it could never have become staker yield — it now routes to the treasury and the Fact Sheet label follows the sink. And an RPC timeout while waiting for a launch receipt used to re-offer the same launch button, inviting a duplicate token, split liquidity and a double payment; the page now says the launch may already be on-chain, links the pending transaction, and gates any retry behind an explicit acknowledgement',
      'Turned off the GitHub Sponsors button on the public repo — it pointed at an address that is scheduled to stop being the treasury during the multisig rebuild',
    ],
  },
  {
    date: 'July 25-26, 2026',
    title: 'TOWELI-Paired Launches, a Solana Preview, and Two Trade Tabs Nobody Could Reach',
    items: [
      'Launches can now be paired with TOWELI instead of ETH — ETH stays the default and TOWELI is an opt-in alternative in the wizard. Proven on a mainnet fork before enabling rather than just reasoned about; a long-standing note in our own code claiming Doppler rejects ERC-20 base pairs turned out to be a misdiagnosis and was corrected',
      'The Solana launch page is reachable as a configuration preview instead of a "Soon" placeholder. Honest scope: there is no in-app submit and no signer on that page. A Solana launch would be run by an operator through a command-line tool that checks on-chain that the fee address is genuinely the vault of a Squads multisig. Stated limit: that check proves ownership and derivation, not the signing threshold — a 1-of-1 multisig would pass it — so the threshold has to be confirmed by hand in Squads\' own tooling, and the tool prints that warning every time it runs. In practice that tool could not build a transaction at all until it was fixed on July 30, and nothing has ever been launched on Solana mainnet through it. TOWELI is never deployed on Solana',
      'Corrected the fee disclosure: the 15% protocol line had been described as going to "Tegridy stakers + POL". Protocol-owned liquidity is funded by a separate contract and receives none of that line. Fixed everywhere the claim appeared — and the surviving half of that claim, "stakers", was itself corrected to the treasury over the following days',
      'Added an explicit anti-sniper line to the launch review step — the descending Dutch price means a block-0 buyer pays the most',
      'The CoW market-swap comparison panel and a TWAP order tab had both been fully built and tested but were never mounted on any page — no file imported them. Both are now live on the trade page. The TWAP tab self-gates to smart-account wallets and shows everyone else the exact calldata rather than pretending it can submit',
      'Art was added to every previously art-less modal, banner and standalone page — launch, scanner, deployer, wallet exposure, launch simulator and Solana launch — completing the 26-piece drop, along with fixes for the near-black scrims and negative z-index that had been hiding the first pass entirely',
    ],
  },
  {
    date: 'July 24, 2026',
    title: 'A Full-Surface Sweep: One Crashed Marketplace and Several Broken Promises',
    items: [
      'The entire Tradermigos marketplace had been crashing. Four of its components used an animation import that throws inside the app-wide strict wrapper they render under, so visiting /nakamigos dropped the whole marketplace into the error page. Confirmed with a probe rather than by reading. Fixed, with a source-level guard that fails the build if anyone reintroduces that import',
      'The "Attest disclosures on-chain" button on a completed launch reverted 100% of the time: the Fact Sheet disclosure schema was never registered on mainnet, verified independently through two public endpoints. The button now checks whether the schema exists and disables itself with an honest note rather than selling you a guaranteed-failed transaction. The launch page had also been promising a day-2 economy of "farming, gauges" while the gauge contract address is zero; that claim is gone',
      'Every referral link shared from the Tegridy Score page produced zero attribution — it was built pointing at the swap page, and only the home route reads the referral parameter. Fixed to match the working widget exactly',
      'NFT lending\'s "Claim Default" button was enabled a full hour before the contract permits it — the contract enforces a one-hour grace period after the deadline, so for that entire window the button guaranteed a reverting transaction. Now gated on the real deadline',
      'Two money-path fixes. Browser-watched limit orders could fill BELOW your target: they triggered on the market price but executed on our thin native pool, and the signing math took the lower of the two, so a "buy at 25M per ETH" order could fill near 13M. The order now floors at your target net of disclosed fees and slippage, and simply does not fill if the pool cannot honor it. Separately, scheduled DCA buys had quoted and executed only on the native pool — missing better Uniswap prices, and stranded entirely when the native pool could not price. ETH-input buys now take whichever venue is better net of the protocol fee; token-input deliberately stays native, because a keeper cannot assume a second approval',
      'The wallet-exposure page had been calling the scanner without a data source, so every holding self-gated to "unmeasured" and the concentration scoring the page exists for never rendered. Wired to the same live holder source /scan already used. Separately, the scanner backend had been fabricating "no holders" whenever the upstream provider rate-limited it, and caching that answer for two minutes; it now returns an honest not-enabled or transient state',
      'A pass over claims that had drifted from the contracts. The early-exit staking penalty was described on the FAQ, the Risks page and the chatbot as "redistributed to stakers"; the contract sends it to the treasury, and the on-chain event had already been renamed to say so. The Gold Card was described as paid in ETH, granting 3x points, and not deployed — all three wrong. The referral invite promised the joiner a bonus the splitter only ever pays the referrer. A home-page "82+ findings resolved" tile, which the Security page itself declines to publish a count for, was replaced with something checkable. "Restake for bonus yield" buttons were being shown to every staker for a feature that is not deployed. And the Risks page status column now derives from the on-chain address check, so it cannot drift again',
      'Fixed the impermanent-loss calculator, which applied the loss to your deposit instead of to the hold-and-do-nothing value — so at a 75% drawdown it showed LPing beating holding, the exact opposite of the lesson it exists to teach',
    ],
  },
  {
    date: 'July 22, 2026',
    title: 'The Token Launcher Opens',
    items: [
      'The Ethereum token launcher is live at /launch: a four-step wizard (details, tier and curve, fees and disclosure, review) that deploys a token into a Doppler V4 dynamic auction, built on Doppler\'s already-deployed mainnet contracts rather than a fork. It had been sitting finished behind a "coming soon" wall since the previous week',
      'The fee rules were published up front rather than left as a marketing dial. The split — 70% creator, 10% to attention beneficiaries the creator names at launch, 15% Tegridy, 5% Doppler — applies to the graduated Uniswap V4 pool, whose trade fee is 0.30%. It is NOT a split of the 1% auction fee: during the auction the protocol takes a third-party integrator fee through an address it controls off-chain, so no split of that 1% is enforced on-chain and none is promised. Terms §7 is the authoritative statement of this and should be read over any summary here',
      'Disclosure on that 15%. At go-live the Fact Sheet described it as going to "Tegridy stakers + POL". Both halves of that were wrong. It was corrected to "stakers" on July 26, to "treasury" for TOWELI-paired launches on July 28, and to "treasury" on both legs on July 30, which is what it says today. The label was wrong for eight days on a live surface, and the three entries above are the repair log',
      'Every launch publishes a Fact Sheet — a disclosure, explicitly not a certificate and not an endorsement. Its tiers are structural checks run by code, not opinion: audited non-upgradeable template, no mint, tax, blacklist or upgrade functions, LP locked, insider float capped, vesting on-chain. Launch listings are ordered deterministically; there is no pay-to-rank',
      'Rehearsed end to end on a mainnet fork before the switch was flipped: a real launch transaction mined successfully and produced a token from the whitelisted Doppler template, with the fee split resolving correctly',
      'Disclosure: the address that collects our share of launch trade fees is a single-key wallet, not a multisig. Our own runbook asked for a multisig there and the operator chose the hot wallet knowingly. It holds no admin power over any contract — it only receives fees — and can be re-pointed. Second disclosure: the launcher opened while our own checklist still wanted TOWELI trading activity and a deeper pool first. That gate was waived on purpose, and the switch is reversible',
      'Correction: flipping the switch in code did not immediately change the live site. The site kept serving an older build and showed "coming soon" at /launch until a redeploy on July 26 made it real for visitors. If you tried to launch between July 22 and July 26 and saw the old page, that is why. The Solana launcher stayed gated on this date and opened as a preview later, on July 26',
    ],
  },
  {
    date: 'July 22, 2026',
    title: 'Tools to Check What Launches',
    items: [
      '/scan — paste any Ethereum or Solana token address and get a read on contract safety and holder concentration. The design rule is that it never fabricates: an unmeasured signal drops out of the score rather than defaulting to a flattering zero, and the report separates hard facts (mint and freeze authority, LP lock, source verification) from softer signals. Honest limit: neither chain gives a free way to enumerate every holder, so the scanner reads the largest ones only — roughly the top 100 on Ethereum, a hard top 20 on Solana — and says so on the page. Because those are the biggest holders, a "concentrated" result is an upper bound, never an understatement. Where the Ethereum holder source is not configured, the page says unavailable rather than guessing',
      '/launch-simulator shows what distribution band and Fact Sheet tier a token would earn before you launch it, and runs entirely in your browser. /deployer looks up a deployer address and shows how its previous launches actually turned out, saying "unobserved" where the data does not exist instead of inventing a track record. Tradermigos gained a Market Integrity tab for wash-trade, coordinated-ownership and fake-floor signals, with its coverage gaps stated on the page',
      'The home page proof-of-life feed was widened past TOWELI trades to fee distributions, protocol-liquidity changes, gauge votes and graded launches. The gauge and launch rows self-gate to nothing, because the gauge contract address is zero and no launch of ours has graduated — the feed shows an empty section rather than a fabricated one',
      'Correction: the wallet-exposure page at /exposure shipped in this wave but was not connected to the scanner\'s data source, so every holding scored as "unmeasured" and the scoring the page exists for never appeared. That was fixed on July 24. A related feature, rug-replay, was dropped rather than shipped hollow',
      'Two pre-relaunch staking contracts still hold real deposits — 1,000 TOWELI in one, 100 TOWELI in the other, both confirmed on-chain and both unlocked. The Farm page now shows a withdraw-only exit card to whoever holds those positions and nothing at all to everyone else; there is no path to stake into the retired contracts, only to get out. Both are also listed on the Contracts page as "retired — withdraw only" so they can be found without connecting a wallet',
      'Limit orders on the trade page had been broken in production: they pointed at an API path that was never routed, so both placing an order and checking its status failed. Fixed, with a test that pins the URL against the real routing config so it cannot drift again',
    ],
  },
  {
    date: 'July 21, 2026',
    title: 'NFT Lending, NFT Pools, Launchpad and Premium Go Live',
    items: [
      'Four contracts from the audited July 16 batch are now wired into the app and usable: NFT lending (0x89BeB6cc…f14F), the NFT pool factory and its bonding-curve AMM (0xbB8E49Ba…6F5B), Launchpad V2 (0xa6149B4d…0dF7) and Premium access (0x9DC2675B…a3F5). The contracts had been on mainnet since July 16; this is the day the app started pointing at them',
      'Checked against mainnet before the switch was flipped. Ownership was read back on-chain for all four — three sit on the deployer key with no pending transfer, and the pool factory is still owned by the earlier Safe, which is precisely why its owner powers were confirmed bounded rather than assumed: immutable pool template, 48-hour timelock on capped fees, pausing that can never block LP withdrawals, fees to the treasury. All 214 function signatures in the app\'s contract interfaces were checked against the deployed bytecode: 212 present, the two misses sitting in an export the app never calls',
      'Fees, set on-chain and checkable: NFT lending takes 5% of interest earned, hard-capped at 10%, with changes timelocked and the rate snapshotted when an offer is made so it cannot be raised on a loan already in flight. The NFT pool factory takes 0.5% to the treasury. Premium costs 10,000 TOWELI a month',
      'Deliberately still gated: the token-collateral lending market (TegridyLending) stays switched off until the TOWELI pool is deep enough for its price oracle to be safe. Gauge voting, vote incentives, community grants and the meme bounty board also stay off — those spend money rather than earn it, and they wait on a revenue line',
      'Removed two labels the go-live exposed as false on the Contracts page: "V3Features bundle redeploy queued" (nothing was queued) and "Awaiting protocol Safe acceptOwnership()" (that transfer was deliberately cancelled on July 18). Deployed rows now carry only their live verification badge; undeployed rows keep an automatic "pending deploy" badge',
    ],
  },
  {
    date: 'July 18-20, 2026',
    title: 'Marketplace Money-Path Hardening',
    items: [
      'Fixed a live defect in the native order book: rows posted as "offers" were never filtered out of the listings feed. Anyone could post a validly-signed order demanding someone else\'s NFT for near-nothing and have it render in the listings table with a Buy button — and a second variant could poison the displayed floor price, the sweep calculator and every floor-relative chip. Listings are now filtered to actual listings',
      'Closed an ownership bypass on the listing path: the check meant to confirm you own an NFT before listing it returned "yes" without checking for ERC-1155 items, so changing one number in a request would have stored a listing for an NFT the poster does not own — showing up in the public book and the floor stat with a working Buy button. Nobody could have been robbed, since a purchase would revert, but the cost was poisoned floor prices and wasted buyer gas. Listings are pinned to ERC-721 and the ownership check now refuses anything it cannot verify',
      'Pinned where your ETH goes. A stored order carried its own contract address, and the app used that value as both the contract it called and the recipient of the payment. It is now checked against a short allowlist of the real Seaport contracts and refused if it does not match — on the buy path, the peer-to-peer trade path and the cancel path',
      'Native listings are ETH-only now, enforced on both the server and the client. The server had been accepting listings priced in WETH, USDC, USDT or DAI, which the app would have rendered as if they were ETH. Offers are deliberately untouched — ERC-20 bidding is the normal way to bid on an NFT and still works',
      'Nothing stopped the same NFT from sitting in two live orders at once. Both signatures are valid but only one can fill, and the loser is an innocent buyer whose purchase reverts. Overlapping orders are now detected and resolved before the seller signs, and the guard that catches them fails closed instead of failing silently',
      'Relisting an NFT while at the hourly listing cap could cancel your existing listing and then refuse the new one, leaving you with nothing. The cancel now happens immediately before the replacement is written. Listings are also capped at 30 days — an unbounded end date previously crashed the save outright',
      '"My Listings" could show "No active listings" during a degraded read, which reads as "my listings were cancelled". It now keeps what is on screen and says the data is stale',
      'Multi-NFT bundle listings were built during this period but are switched OFF and have never been enabled. The pre-go-live audit returned no-go, and the flag is still off today',
    ],
  },
  {
    date: 'July 18-19, 2026',
    title: 'Every Core Contract Source-Verified, and Unbacked Claims Removed',
    items: [
      'All 14 contracts from the June relaunch are now Etherscan source-verified — confirmed through the Etherscan API, not assumed. TegridyTWAP had been quietly missing from the verification list the whole time; the new live badge is what caught it. The Contracts and Security pages now show a per-address "source verified" badge read live from Etherscan, linking straight to the code, and every failure path — rate limit, network error, malformed response — shows "unchecked". It will never show a false "verified", and never libel one of our own live contracts as "unverified"',
      'Killed a banner that had been running sitewide all month promising an "NFT boost bonus +10% for all holders". Nothing paid it — no reward path could even read the number, and our own FAQ contradicted it. The real boost is a flat on-chain +0.5x for JBAC holders and is not date-limited. The test that had asserted the banner rendered was rewritten to fail if anyone adds an unbacked reward claim again',
      'Removed numbers that were never backed by anything: the home page\'s "82 Findings Resolved" (an aggregate the Security page itself refuses to publish), and the leaderboard\'s "Streak" and "Multiplier" tiles, which were frozen at 0d and 1x for every user forever and could never move',
      '"Base APR" and "Staking APR" are now called "Emissions APR" everywhere. The four- and five-digit number was impersonating the real-yield thesis; it is emissions, and it now says so. The Premium page was cut back to the two benefits that actually exist — real ETH yield through staking, and JBAC lifetime access — because the fee discount is not in the contract, "priority gas" is not a real thing, and Smart Alerts and Advanced Analytics already ship free to every wallet',
      'Security page claims corrected: "No Oracle Risk" was one click from being disproved (the protocol runs a TWAP oracle and a Chainlink sequencer feed) and now reads "On-Chain TWAP Pricing — no external price feeds". Bug-bounty tiers dropped their non-credible fixed dollar figures, and the Treasury page now says plainly that its near-zero balance is by design: opex comes from ETH fees, there is no pre-funded war chest',
      'Swap now displays the number and the venue that will actually execute. Aggregator quotes had been shown as the headline output under a route label naming a venue the transaction never touches; that quote is now disclosed as context instead of presented as the route. Limit orders were also backwards — the browser-only watcher that dies when you close the tab was the primary button and the real CoW Protocol order was buried. CoW is now primary: it settles on-chain, survives closing the tab, and is gasless to place',
      'Fixed a real money-path bug on liquidity: the remove amount was derived from a lossy float, so a 100% withdrawal could compute more than you actually held and revert, and very small positions could not be removed at all. It is now computed from the exact on-chain balance. Transaction history had also been silently returning nothing in production, because the API auth method we had switched to is rejected by Etherscan v2',
      'The nine ownership-transfer windows the July 16 batch left open to a previously flagged Safe were cancelled on-chain and re-read afterwards: owner unchanged, no pending owner, no expiry. To be clear, windows-closed is not the same as re-homed — those contracts still need to move to a rebuilt multisig, and fund-touching features stay gated until they do',
      'Both launchers existed but appeared in no navigation anywhere — the only way to reach /launch or /solana-launch was to type the URL, and the Solana page had no inbound link from anything at all. They are now in the nav with "Soon" pills bound to the real go-live gate, so a pill clears itself only when that launcher is genuinely enabled',
      'The Farm now surfaces ETH paid out, epochs settled and share claimed with a link to the RevenueDistributor on Etherscan instead of hiding the panel while the number is still zero — and the Claimable figure ticks per second instead of looking frozen between 30-second refreshes, interpolated from the contract\'s own arithmetic, re-baselined against the chain on every refetch, capped so it parks rather than inventing rewards, and display-only so it can never reach a transaction. Elsewhere: the Community page leads with what is genuinely live, gallery buys settle in-app on the Tegridy order book instead of bouncing you out to OpenSea, the NFT-Finance page\'s initial download dropped from about 1.27 MB to about 57 KB, and Tradermigos stopped lagging on phones and iPads',
    ],
  },
  {
    date: 'July 16, 2026',
    title: 'Eleven Contracts Deployed On-Chain, Still Gated in the App',
    items: [
      'Eleven contracts were deployed to Ethereum mainnet and Etherscan-verified: GaugeController, VoteIncentives (plus its admin sister), PremiumAccess, TegridyNFTPoolFactory, TegridyNFTLending (plus its admin sister), MemeBountyBoard, CommunityGrants, TegridyLaunchpadV2 and its TegridyDropV2 template. Every address was published in the README so anyone can read the code on Etherscan',
      'On-chain is not the same as usable. The app kept its placeholder on all of these pages — the frontend addresses stayed at zero pending the multisig ownership handoff. NFT lending, the NFT pool AMM, the launchpad and the premium tier were un-gated five days later. Gauge voting, vote incentives, community grants and the bounty board are deployed but still gated today',
      'Each contract in the batch cleared a fresh pre-deploy adversarial audit wave before it was allowed to go out — 8 GO, 1 GO-WITH-FIXES, 0 NO-GO, with zero Critical, High or Medium findings. It caught a CommunityGrants footgun where a grant sized between 30% and 50% of the pot was approvable but reverted on every payout attempt: approved and never payable',
      'Before any of the batch was broadcast, the launchpad\'s protocol-fee recipient was corrected from the stale pre-relaunch treasury to the live 2-of-2 Safe. That address is baked into every collection clone and is only forward-changeable, so it had to be right first',
      'TegridyLending — borrowing against your TOWELI staking position — was deliberately NOT in this batch. It depends on the on-chain TWAP oracle, which is not bootstrapped yet, so it stays undeployed until the native pool is deep enough to support it',
      'The bytecode that went out carries a June fix to a booby-trap class in ownership handoff: an outgoing or compromised owner could queue a hostile timelocked proposal moments before transferring ownership, and without a flush the timer keeps running, so the incoming owner inherits an executable proposal — several of which have permissionless execute paths. CommunityGrants, MemeBountyBoard, TegridyLPFarming and VoteIncentivesAdmin now flush every in-flight proposal when a new owner accepts ownership. Honest scope: the two contracts in that June sweep that were already live — the POL accumulator and the LP farm — keep their deployed bytecode and would only carry the fix after a future redeploy',
      'A pre-deploy fix to the lending contract: its owner-only recovery path for stray NFTs walked every loan ever made, so it would have run out of gas and become unusable past a few thousand loans. Replaced with a constant-time lookup, and given its first test coverage — the function had none',
      'The README was rewritten to match reality rather than intent: the protocol-owned TOWELI/WETH pool is described as seeded but shallow rather than "seeding pending", and the feature table gained a distinct state for "deployed on-chain but still gated in the app" so the two are never conflated',
    ],
  },
  {
    date: 'July 12, 2026',
    title: 'Audit Wave, a Live Authorization Bug, and a Disclosure Channel',
    items: [
      'A full audit of the contract set closed 6 findings — 1 High (the V4 hook credited protocol-owned-liquidity fees into a slot shared with withheld JIT-fee claims, which would have let POL sweeps take LP fees and could brick removeLiquidity), 4 Medium, 1 Low. Every one of them was on a contract that was not deployed at the time; the live June relaunch contracts were clean',
      'An economics pass three days earlier had caught two more Mediums, again on undeployed contracts: NFT lending\'s protocol-wide 10,000-offer cap counted lifetime offers instead of open ones, so once 10,000 offers had ever existed no lender could ever make another — permanently, with no on-chain recovery. And the TWAP oracle\'s ownership-handoff flush could be stuffed with junk entries until the incoming owner\'s acceptOwnership ran out of gas',
      'First security audit of the backend and serverless layer. One real authorization bug, and it was live: any signed-in user could add or remove chat reactions attributed to any other wallet by calling the database function directly and bypassing the server. Blast radius was cosmetic — no funds, no personal data — and it was fixed and applied to the production database the same day. The Solana RPC proxy was also locked to a read/send method allowlist so it cannot be used as an open proxy',
      'Published a responsible-disclosure policy at /.well-known/security.txt: scope, a private contact, a no-pursuit commitment for good-faith researchers, and a pointer to the SEAL 911 emergency responder network. It states plainly that no paid bug bounty is live yet. A security-contact tag was also added to the TOWELI and SwapFeeRouter source, where it renders on Etherscan',
    ],
  },
  {
    date: 'July 11, 2026',
    title: 'Proof Read Off the Chain, and an Honest Status Report',
    items: [
      'New "Prove It" panel on the home page: every headline claim is read straight off the contracts at page load — total supply, percentage burned (the balance of the dead address), and the swap fee from SwapFeeRouter — and each row links to the exact Etherscan page you can check it on. A June audit had found a fake supply figure and a fee mismatch in the copy; this makes that class of drift structurally impossible',
      'New Live Protocol Pulse on the home page — a feed of what is actually moving on-chain. It deliberately renders nothing while the protocol is quiet rather than showing an empty activity box. At the time it was added the pool had zero trades in 24 hours, so it correctly showed nothing',
      'New Position Health Center at the top of the Dashboard: it warns you before you lose something rather than after — lock expiring within 7 days and the exact boost multiplier you would drop, lock already ended with the boost at risk, and rewards sitting unclaimed, each with a one-tap action. Nothing at all appears if you have no staking position',
      'Swap quotes had been broken in production and nowhere else. The site\'s catch-all routing rule was shadowing the API for GET requests, so a quote request got the app\'s own HTML page back instead of a price; underneath that, the API function only matched one path segment, so every real multi-segment endpoint hit a platform 404 and never reached any code; and a fail-closed origin check was rejecting every legitimate quote fetch with a 403, because browsers do not send an Origin header on same-origin GET requests. All three fixed. Safe read requests no longer require an Origin, while write requests still must come from an allow-listed one',
      'Read the mainnet state directly rather than trusting internal notes, and published the result. The good news: the protocol\'s own TOWELI/WETH pool is seeded and trading close to market price, so the swap, stake and farm loop works today. Older internal notes calling the pool empty were wrong',
      'The bad news, stated plainly: the pool is shallow — roughly 776,000 TOWELI and 0.0203 WETH. The TWAP oracle refuses to take an observation below a 10-WETH-per-side reserve floor, so the oracle cannot be started, and everything depending on it — the token-collateral lending market (TegridyLending) and protocol-owned liquidity accumulation — stays gated. Clearing that floor at market price would take about 38% of total supply, which the protocol does not hold. The treasury is empty',
      'Ownership is still not decentralized, and the June attempt to hand it over failed quietly: the transfer to the multisig expired without being accepted, so all 8 owned contracts still sit behind the single deployer key. The handoff has to be re-initiated from scratch',
      'The scripts to deepen the pool and bootstrap the oracle were written and dry-run against live mainnet, and the dry runs caught two real bugs before either could waste a transaction. Nothing was executed on-chain: the pool was unchanged. Admin and pool-touching transactions now broadcast through a private send path so they cannot be front-run',
      'Fixed two broken visuals: the Supply Distribution donut on the Tokenomics page rendered blank in production (a chart container measuring itself as zero pixels wide on route remount), and the three stat pills on the TOWELI/ETH pool card were green text on solid purple and read as empty boxes. Page transitions were also made real — the route wrapper had been named AnimatedRoutes for a long time without animating anything',
    ],
  },
  {
    date: 'June 18, 2026',
    title: 'A Solana Swap Surface — Built, Shipped Dark',
    items: [
      'Status first, because it matters: this entire surface ships gated OFF. The /solana page is hidden from the nav and renders a "not deployed" state until the operator sets a Tegridy-owned Solana fee account in the site configuration. Nothing in the repository records that step being completed, so treat this as built, not launched',
      'What was built: swap any SPL pair through the Jupiter API, with a platform fee taken only when one leg of the pair is SOL or USDC — any other pair simply runs fee-free rather than breaking. TOWELI never touches Solana: no bridge, no wrapped token, no own on-chain program',
      'Safety: per-pair risk warnings from Jupiter Shield (honeypot, freeze authority, mint authority, transfer fee, low liquidity), verified / unverified / Token-2022 badges, an "I understand, swap anyway" gate on flagged or unverified tokens, and a pre-sign simulation that refuses to send a swap that would revert, so you do not pay gas to fail',
      'On-chain limit orders filled by Jupiter\'s keepers, with no browser tab to keep open, and an "Earn" rail that buys a liquid-staking token through the same swap. Limit orders ship with the integrator fee off — that requires a separate referral-account setup we have not done',
      'Your RPC traffic never leaves our origin: balances, sending and confirmation all proxy through our own endpoint, so a keyed production RPC URL stays server-side instead of being inlined into the public bundle. Token icons are deliberately proxied and never fetched from arbitrary hosts, which also stops leaking which tokens you are looking at',
      'Two adversarial reviews found 17 verified issues that were fixed — including a limit-order path that bypassed the risk warnings entirely, and a risk gate matching severity levels Jupiter never actually emits, making it dead code',
    ],
  },
  {
    date: 'June 14-16, 2026',
    title: 'Marketplace Upgrades, and a Pass That Is Not Live',
    items: [
      'On wallets that support EIP-5792, approvals and fulfillment collapse into one confirmation instead of a prompt per collection, and multi-item cart sweeps buy in one confirmation — verified end to end with a live wallet, including a clean unwind when the user declines. Wallets without support fall back to the sequential flow, and a confirmed batch can never double-execute',
      'Fixed a latent defect found while building this: native listings had been signed with a restricted Seaport order type that reverts at fulfillment against our zero zone, meaning those orders were never fillable. New listings sign the open type and the old rows expire on their own',
      'Sale stats and price history now exclude self-sales — the same wallet on both sides of a trade — so a wallet cannot wash-trade the displayed volume, averages and sparklines upward. The rows still appear, flagged "possible wash": nothing is hidden, only the aggregates change',
      'On an exact price tie between a native listing and an OpenSea listing, the native one now wins. You pay the identical price, because the native 1% is carved out of the seller\'s proceeds and never added to the buyer, and a strictly cheaper OpenSea listing still wins, so the lowest price is always the one you get',
      'The buy grid finally honors the trait filter (it had lived only in the gallery, so "cheapest listed Gold Background" meant cross-referencing by hand) and gained a "Best Value" sort that ranks rarity per ETH. The native order book got a real mobile card layout below 640px instead of a horizontally scrolling six-column table',
      'Not live, stated plainly: a Tegridy Pro Pass membership page was built this week, with perks that are additive only, but the Pro Pass collection has never been deployed. Its address is still all zeros, the page reads "Minting soon", and that is still true today. Separately, a router that would credit referrals on native NFT buys was written the same week as an explicit draft — not deploy-ready, pending a mainnet-fork test suite and an external audit — and has never been deployed or wired to anything',
    ],
  },
  {
    date: 'June 13, 2026',
    title: '690-Finding Frontend Audit — and Three Things That Were Silently Broken',
    items: [
      'Every page was audited in a live browser at real viewport sizes and by code read: 690 findings, worked through an 838-item sequenced remediation plan. The audit reports and the plan are committed in the repo rather than merely asserted',
      'Every ERC20 sell had been reverting. The app asked you to approve one router and then executed the swap against a different one, so the transfer failed at gas estimation before anything could happen. Approval now always targets the exact contract that pulls your tokens, with a test asserting spender equals executor on every route',
      'Every marketplace Cancel had been a gas-burning no-op. The cancel call was built with the wrong trailing field, so Seaport hashed a phantom order: the transaction mined, the toast said "cancelled", the row disappeared from your screen — and the real listing or bid stayed 100% fillable. All four cancel paths now rebuild the order against the offerer\'s live on-chain counter',
      'DCA and limit orders had been priced against Uniswap while executing on our own pool, so every triggered swap reverted and burned gas for nothing. Both now take their execution quote from the venue they actually trade on, and skip cleanly instead of submitting an unprotected swap when the pool cannot price it',
      'The list of blockchain endpoints the app talks to contained dead and browser-blocked entries, which users experienced as "nothing loads". Corrected to endpoints verified live, with failover that actually falls over',
      'Honesty sweep across every promise surface: removed a fabricated Immunefi partnership and its dead "submit a report" link, dropped a hardcoded "Verified on Etherscan" badge the sources had not earned, corrected the Terms fee to 0.5%, replaced "Audited — Bug Bounty Active" with what is actually true, aligned admin-control copy to the single-operator-key reality with a link to the treasury Safe, and fixed a tokenomics "Rewards Remaining" figure that could only ever go up — it now reads the on-chain end date and counts down',
      'Demo and fallback data stopped impersonating real collectors with perpetually-fresh "2 minutes ago" timestamps that made sample rows look like live trades; the placeholders are now obviously synthetic and pinned to a fixed past date. Loading skeletons that could latch forever now time out into a retryable error, the swap form shows live quotes to visitors who have not connected a wallet, and an accessibility pass landed keyboard tab patterns, dialog focus traps, app-wide reduced-motion support and iPhone safe-area fixes',
      'Behind the scenes: order creation no longer fails when a data provider hiccups, retrying on a fallback key and then public endpoints instead of returning an error. A weekly encrypted backup of the signed-order database was added at the same time — and it is only fair to record that this backup reported success while doing nothing, and produced zero artifacts for its entire life, until that was caught and fixed on July 29',
    ],
  },
  {
    date: 'June 10-11, 2026',
    title: 'Peer-to-Peer Trading, Wallet Messaging, and a Day of Breakage',
    items: [
      'Swap NFTs directly with another wallet: one signed Seaport order, no custom escrow contract holding anyone\'s assets — a deliberate choice after the NFT Trader escrow exploit of December 2023. The maker offers NFTs plus an optional WETH sweetener, and only a wallet that genuinely owns the requested NFTs can fill the trade, enforced on-chain rather than by our server',
      'Trade Board: post an open offer with no named counterparty — "any token from this collection for mine" — and the first qualifying wallet to fulfill wins, atomically, in a single transaction. The board surfaces what you can actually fill, floating open posts you hold the tokens for to the top with a "You can fill this" badge instead of showing a passive chronological wall',
      'Dutch trades — offers that negotiate themselves. A maker\'s WETH sweetener can rise until someone accepts, and a taker\'s ETH ask can decay, both running on Seaport\'s own built-in linear interpolation rather than any new mechanism of ours, with live tickers on the trade card. Alongside it, a fairness meter that values each selected token at floor times its exact rarity multiplier and shows a signed "roughly plus or minus X% for you" instead of a crude floor sum',
      'Wallet-to-wallet direct messages with ENS names, unread badges, read receipts, per-wallet block, and trade cards rendered inline in the thread that you can accept without leaving the conversation',
      'Opt-in browser notifications for trade offers, fills and declines. Worth noting what this replaced: the previous notification code had never worked end to end, because no service worker was ever registered, so it waited forever. The bell appears only once the operator has configured push keys',
      'Share cards for NFTs and collections that unfurl with a live floor price, plus per-token deep links — and a fix for "Copy shareable link", which had been copying a route that 404\'d for every collection',
      'Recorded because it happened: the peer-to-peer surface shipped broken. For about a day the trades page 404\'d and the trade window crashed on load, and the portfolio profit-and-loss tab crashed into an error state that then latched across the other tabs. Both were fixed the following day',
    ],
  },
  {
    date: 'June 8-9, 2026',
    title: 'Swap Routing Repaired, and a Credibility Pass',
    items: [
      'Swaps you selected as Uniswap routes had been sent to our own thin TOWELI/WETH pool carrying a Uniswap-derived minimum output, so they reverted. That was the common case, and it was breaking swaps. Genuine Uniswap trades now execute on the real Uniswap router',
      'Trades that route through our own pool go through SwapFeeRouter, so the protocol fee is captured on native volume and flows into the staker / protocol-liquidity / treasury split. The quote compares the native route net of that fee, so our own venue is only chosen when it still beats Uniswap after the fee is taken — you are never worse off than going straight to market. Honest caveat: while the native pool stays shallow, Uniswap wins nearly every quote, so this fee path is largely inert. It activates on its own once protocol-owned liquidity makes our pool the best-priced venue',
      'The home page said "0.3% on each trade" — that is the LP pool fee, not the staker fee. Reworded so the two stop being conflated',
      'A third of the primary navigation dead-ended in "Contract Not Deployed" walls. NFT Finance, Community/Governance and the Gold Card left the nav until their contracts actually exist — every one stays reachable by URL and returns to the nav automatically the moment its address lands in the app\'s contract list. Note: this was overridden three days later by a flag that force-showed NFT Finance and Governance ahead of their deploys, so those pages showed a placeholder until the contracts went live on July 16 and July 21',
      'Removed the four "PROPOSED — NOT GUARANTEED" pool cards with em-dash statistics from the Farm page — they promised pools nobody had committed to',
      'The homepage stopped displaying "Total Volume: --", "Total Swaps: 0" and a $9 staked figure. Live metrics now appear only once they mean something, and the space is filled meanwhile with claims that are true on day zero. The staking APR keeps the real on-chain rate, but above 1,000% it is labeled for what it is: an early-TVL bootstrap rate, not a sustainable yield',
      'A real-yield strip reads cumulative ETH paid to stakers straight from the RevenueDistributor contract, with an Etherscan link to verify it yourself. It renders nothing at all until the first distribution actually lands — it cannot show a zero and it cannot show a number the chain does not have',
      'Marketplace trust gaps closed: a wrong-chain buy now fails immediately instead of broadcasting a doomed transaction, a pre-flight order-status check stops a stale listing from burning a buyer\'s gas, and the activity feed stopped claiming a WebSocket connection when it actually polls every 12 seconds. The fee pitch also dropped its stale "1% vs OpenSea\'s 2.5%" line — OpenSea has been at 1% since September 2025 — in favor of the true claim: a flat 1% to the treasury, settled on-chain',
      'The marketplace stopped going down with its backend. Order-book reads now degrade gracefully when the database is unreachable, and the rate limiter falls back to in-memory counting instead of returning a 503 across the whole read surface — both written in response to a real outage on June 9',
      'Security fix: a refactor had quietly dropped the size guard on launchpad uploads. The surviving checks only fired after the wallet had already funded the storage provider, so an over-cap upload could send ETH before anything rejected it. The guard is restored, and three tests that had been marked expected-to-fail flipped back to passing',
    ],
  },
  {
    date: 'June 7, 2026',
    title: 'LP Farming Goes Live, and the Home Page Starts Reading the Chain',
    items: [
      'LP farming went live: the Farm\'s LP-staking panel and the Dashboard\'s staked-LP view were un-gated against the deployed TegridyLPFarming contract at 0x1171268A…e149, seeded with 2,000 TOWELI over a 7-day reward period. Honest follow-up, because a changelog that announces this and never says what happened next is not worth reading — that reward period ended on June 15, 2026 and has not been re-funded since. LP positions can still be staked and withdrawn; there are no LP emissions accruing today',
      'A live math bug on the Farm and Dashboard. Above 10,000% the APR is displayed with a thousands separator, and the projection code read that string as a plain number — so "28,567" was read as 28. Every "Projected Earnings", "Earnings Projection" and boost-schedule APY figure was rendering roughly a thousand times too low, against a live base APR of about 28,567%. This was active, not theoretical',
      'The home page started reading the chain: a "By the Numbers" strip showing on-chain volume, real yield, the reward pool, daily emissions, total staked and swap count — public, with no wallet connected and no indexer in the path. This is the ancestor of the "Prove It" panel that landed in July',
      'The Farm surfaced staking incentives and daily emissions that had been present on-chain but shown nowhere in the app, alongside the real uncapped APR rather than a clipped one',
      'The stake form now reads the per-wallet cap and the minimum straight off the contract, which killed the "Likely to Fail" dead end people were hitting with no explanation, and the LP stake input got the same treatment',
      'The site consolidated to one domain: tegridyfarms.xyz was dropped and every reference repointed, so tegridyfarms.vercel.app became the only site at the time (it was later superseded by memetic.fun, which is canonical today). If you had bookmarked the old domain, that is when it stopped being canonical. The security@ and conduct@ addresses on the retired domain went with it, replaced by community channels — and, from July 12, a machine-readable disclosure contact at /.well-known/security.txt',
      'Smaller fixes you would have felt: /trade stopped returning a 404 and now redirects to the swap page, importing a token no longer hangs on older tokens whose symbol is stored as raw bytes (MKR and SAI among them), and the Risks page gained a plain-language reference of the protocol\'s hard limits and parameters',
    ],
  },
  {
    date: 'June 6, 2026',
    title: 'Mainnet Relaunch',
    items: [
      'Relaunched the live protocol from a brand-new deployer wallet — every contract running on mainnet today carries fresh bytecode with all previously-merged fixes (DeployMVP)',
      '14 contracts deployed and wired: TOWELI, TegridyStaking (+ admin/view sisters), the native TOWELI/WETH DEX (Factory/Router/Pair), RevenueDistributor, SwapFeeRouter (+ admin), POLAccumulator, TegridyTWAP, ReferralSplitter, and the TokenURIReader',
      'Addresses wired into the app from frontend/src/lib/constants.ts; staking seeded with a one-time 6.4M TOWELI emissions pool',
      'Deferred from the relaunch (not deployed; their pages stay gated until each clears a pre-deploy audit wave and goes live): gauge voting, vote incentives, community grants, premium / Gold Card, lending, NFT pools, and the launchpad',
    ],
  },
  {
    date: 'May 4, 2026',
    title: 'Pass-7 Adversarial Multi-Agent Audit + Remediation',
    items: [
      'Three parallel worktree agents (oracle/AMM, staking/governance, lending/NFT) attacked everything claimed closed by the prior 6 internal passes plus the Spartan external review',
      'Surfaced 13 NEW findings: 1 Critical (V4 hook fee delta never settled — every V4 swap would have reverted CurrencyNotSettled if the hook deployed), 6 Highs (TWAP fail-open carve-out, gauge-removal permanent brick, lending-side missing post-condition checks on staking transferFrom, settled-vs-settled cross-loan reward drain, claimStuckCollateral retry hole), 4 Mediums (POL bypass cooldown, V4 claimFees ManagerLocked, LP-farming stale-boost siphon, NFTLending removal-cancel retry budget), 1 Low + 1 Info',
      'All 13 closed in same-week remediation using battle-tested patterns mirrored from existing in-codebase fixes (TegridyNFTLending`s `_safeOutboundTransfer`, TegridyLending`s `lastBypassUsed` cooldown) and the canonical Uniswap V4 reference (`FeeTakingHook.sol`)',
      'New regression suite at contracts/test/PASS7_*.t.sol — 9 files, 15 tests — converted from "asserts exploit" to "asserts fix" and all passing',
      'Sign-off: $1M TVL acceptable with operational guardrails; $10M+ requires paid firm engagement targeting per-tokenId attribution + V4 hook semantics + boost-cache lifetime architectural cluster',
      'Master report: .audit_101/PASS7_2026_05_03.md',
    ],
  },
  {
    date: 'May 3, 2026',
    title: 'Pass-6 Fresh-Eyes Meta-Audit',
    items: [
      'Meta-audit informed by 2024-2026 DeFi exploit retrospectives (Curve, Euler, KyberSwap Elastic, Penpie, Pendle, Sturdy, Inverse, Platypus, BlueBerry, Munchables, Velocore, BonqDAO, Hundred, Atlantis, Onyx, Conic, Jimbos, Radiant, Poly Network) re-aimed at the cumulative 388-finding history of passes 1-5',
      '5 NEW contract HIGHs + 5 NEW contract MEDs + 1 frontend CRIT + 5 frontend HIGHs + 1 frontend LOW — all closed',
      '4 NEW invariant suites locking down the pass-6 fix surfaces (13 stateful invariants × 1.664M total calls, zero reverts)',
      'Critical frontend fix: replaced 7 Vercel `vercel.json` aggregator rewrites that were open proxies with hardened serverless wrappers (rate limit, origin allowlist, query allowlist, body/response caps, 53 new tests)',
      'Master report: .audit_101/PASS6_2026_05_03.md',
    ],
  },
  {
    date: 'April 26, 2026',
    title: 'Post-Remediation Audit Campaign',
    items: [
      'Closed 3 Critical + 7 High + 5 Medium vulnerabilities discovered during a focused audit + verification campaign (27 commits)',
      'Found that R017 / R020 / R023 / R028 fixes were doc-claimed but not actually shipped to main; landed those plus 4 additional Mediums',
      'Architectural splits — TegridyStaking + TegridyStakingAdmin (29.5KB → 22.5KB) and SwapFeeRouter + SwapFeeRouterAdmin (25.9KB → 16.7KB) — both contracts now under the EIP-170 24,576-byte mainnet limit',
      'Frontend: refreshBoost auto-detection hook for users who acquire JBAC NFTs after staking',
      'Indexer: 4 new event types tracked plus admin-contract subscriptions',
      'New source of truth: .audit_101/POST_REMEDIATION_LEDGER.md',
    ],
  },
  {
    date: 'April 18, 2026',
    title: 'Visual Identity Refresh',
    items: [
      'South Park palette adopted: kyle-green stat text and Kenny-orange day mode',
      'Dark mode is now the default; light/day mode toggles in manually',
      'Per-card art with translucent black content panels across Dashboard, Farm, Tokenomics, Changelog, Security, Community, and NFT Finance',
      'Nakamigos art gallery renamed to Tradermigos across splash, marketplace header, and top-bar action',
      'Top-bar Points slot swapped for Tradermigos; Points moved into the More dropdown',
      'More dropdown now opens under the More button instead of spilling under Community',
      'Collection cards on NFT Lending now use per-project canonical art (JBAC skeleton, Nakamigos pixel, GNSS Art render)',
      'Launchpad feature bullets recolored with the full South Park character palette',
      'FAQ + Changelog page-background scrims removed; Tegridy Score ring digit is kyle green',
      'History page: surface a readable message when the Etherscan proxy returns a non-JSON response instead of the raw "Unexpected token" parse error',
      'Broken /splash/*.png fallback paths fixed to the actual .jpg assets (kills the broken-image stub in the marketplace header)',
    ],
  },
  {
    date: 'April 14, 2026',
    title: 'NFT Finance UX Overhaul',
    items: [
      'Added How It Works guides across all NFT Finance sections',
      'Added tooltips for DeFi terminology',
      'Added repayment previews and risk banners for borrowers',
      'Added step indicators for multi-transaction flows',
      'Improved empty states with actionable guidance',
      'Added intro overview cards and mobile-friendly tab navigation',
    ],
  },
  {
    date: 'April 14, 2026',
    title: 'NFT Lending & AMM Deployment',
    items: [
      'Note: this V1 deployment was superseded — these contracts were not carried through the June 2026 relaunch. They were rebuilt in the audited 2026-07-16 batch and NFT lending + the NFT pool factory went live on 2026-07-21.',
      'Deployed TegridyNFTLending contract (generic NFT collateral)',
      'Deployed TegridyNFTPool & TegridyNFTPoolFactory (bonding curve AMM)',
      'Whitelisted JBAC, Nakamigos, GNSS collections for lending',
      'Full 3-tab UI for NFT Lending (Lend, Borrow, My Loans)',
      'Full 3-tab UI for NFT AMM (Trade, Create Pool, My Pools)',
    ],
  },
  {
    date: 'April 2026',
    title: 'Security Hardening',
    items: [
      'Applied fixes for several v4 audit findings (C-02, C-03, H-01, H-03, M-02). Full status in SECURITY_AUDIT_300_AGENT.md',
      'Added WETH fallback on acceptOffer (audit M-02)',
      'Added reentrancy tests for NFT Pool contracts',
      'Added sandwich attack simulation tests',
    ],
  },
  {
    date: 'March 2026',
    title: 'Community Features Launch',
    items: [
      'Launched Community Grants voting system',
      'Launched Meme Bounty Board',
      'Added Vote Incentives (bribes) for governance participation',
      'Referral system with on-chain tracking',
    ],
  },
  {
    date: 'February 2026',
    title: 'Core Protocol Launch',
    items: [
      'Deployed TegridyFactory, TegridyPair, TegridyRouter (Uniswap V2 fork)',
      'Deployed TegridyStaking with NFT positions and boost mechanics',
      'Deployed RevenueDistributor (100% fee sharing)',
      'Deployed SwapFeeRouter for fee capture',
      'Launched Dashboard, Farm, Swap, and Tokenomics pages',
    ],
  },
];

export default function ChangelogPage() {
  usePageTitle('Changelog', 'Protocol development history and updates');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="changelog" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-32 pb-20">
        {/* Header */}
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">Changelog</h1>
          <p className="text-gray-400 text-sm md:text-base">
            Protocol updates and development history
          </p>
        </m.div>

        {/* Timeline */}
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[19px] md:left-[23px] top-2 bottom-2 w-px bg-purple-500/20" />

          <div className="space-y-8">
            {CHANGELOG.map((entry, idx) => (
              <m.div
                key={idx}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + idx * 0.08 }}
                className="relative pl-12 md:pl-14"
              >
                {/* Timeline dot */}
                <div className="absolute left-[14px] md:left-[18px] top-[22px] w-[11px] h-[11px] rounded-full bg-purple-500 border-2 border-purple-400 shadow-[0_0_8px_var(--color-purple-50)]" />

                {/* Card */}
                <div
                  className="rounded-xl relative overflow-hidden"
                  style={{ border: '1px solid var(--color-purple-12)' }}
                >
                  <div className="absolute inset-0">
                    <img src={CARD_ART[idx % CARD_ART.length]!.src} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </div>
                  {/* Translucent black content panel — art still bleeds through the border,
                      text stays readable against the dimmed backdrop.
                      AUDIT 2026-05-30 (mobile+iPad re-pass, CRIT): bumped scrim 0.55 → 0.85
                      because the bright orange/yellow jungle-ape art (idx > 0 cards) made body
                      copy essentially invisible at iPad portrait. Higher backdrop-blur too. */}
                  <div className="relative z-10 m-2 md:m-3 rounded-lg p-4 md:p-5" style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    {/* Date badge */}
                    <span className="inline-block text-xs font-semibold text-purple-300 bg-purple-500/20 px-3 py-1 rounded-full mb-3" style={{ backdropFilter: 'blur(4px)' }}>
                      {entry.date}
                    </span>

                    {/* Title */}
                    <h2 className="text-white text-lg font-bold mb-4" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>{entry.title}</h2>

                    {/* Items */}
                    <ul className="space-y-2.5">
                      {entry.items.map((item, iIdx) => (
                        <li key={iIdx} className="flex items-start gap-2.5 text-sm text-gray-200 leading-relaxed" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
                          <svg
                            className="w-4 h-4 text-green-400 shrink-0 mt-0.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </m.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
