# NOTES

A running log of things learned while working in this repo: measured constants,
traps that cost real time, and techniques that are not obvious from the code.

Rules for entries, so this stays worth reading:

- **Measured, not assumed.** If an entry states a number, it came from running
  something. Say what was run. A default you read in docs is not a measurement.
- **Lead with the belief that was wrong.** The useful part of a trap is the thing
  a competent person would otherwise have believed.
- **Transferable only.** Facts about *this codebase's shape* belong in the code
  or its comments. This file is for what you could not have learned by reading.
- Newest first.

---

## 2026-10-03: minted minus today's supply is what was burnt

**Believed:** for a fixed-supply ERC-20, everything ever minted minus `totalSupply()` is the
burn, so a burn figure needs one constant per token and one read.

**Measured:** QR, DRB and JBM on Base are ClankerTokens (IERC7802). Their verified source has
`crosschainBurn` and `crosschainMint`, callable only by the SuperchainTokenBridge predeploy
`0x4200000000000000000000000000000000000028`. At Base block 52136964 that proxy's EIP-1967
implementation slot reads zero, so the bridge is off today, and its admin slot reads
`0x4200000000000000000000000000000000000018`, the standard ProxyAdmin, so an ordinary upgrade
can switch it on. A bridge-out would then lower `totalSupply()` with nothing destroyed. The
same contract also has a public `burn()`, and the two cannot be told apart from the supply.
A first read of that proxy reported "no admin": the script held a mistyped slot constant, and
a slot nobody writes returns zero, which reads exactly like "no admin".

**Do:** before counting a fall in supply as a burn, read the token's source for every path
that lowers supply. Where a second one exists, count only the burn-address balance, show the
fall beside it as not counted, and do not print a "not burnt" figure. Paste the EIP-1967
slots from the standard (implementation `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`,
admin `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`): never retype one,
and treat a zero from a storage read as "nothing here OR the wrong slot".

## 2026-10-03: a pump.fun mint ends in "pump"

**Believed:** RIZZ (`5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k`) was not a pump.fun mint,
because its address has no "pump" suffix, so its minted supply could not be taken as
pump.fun's 1,000,000,000.

**Measured:** its create transaction
`4mKCtSuQtBgtFfpThuqgDxaVJzz7fhpkFTvbRj7xMYHysjPgNynzkYP5QU81Cs7b9hLuZBUATPbj3hazE8Vbs5Sc`
(slot 263919365, 2024-05-05) is pump.fun's `Create`: InitializeMint2 with pump's PDA as mint
authority, one MintTo of 1,000,000,000,000,000 base units, then the authority set to none.
Its bonding-curve account (seeds `bonding-curve` and the mint, under
`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) exists and is owned by pump, in the older
49-byte layout. The suffix came later. It proves nothing in the other direction either:
anyone can grind an address that ends in "pump". Finding the create transaction did not need
the mint's own history, which is too deep to page on a free RPC: the oldest signature of the
mint's Metaplex metadata account, or of its bonding-curve account, is the create transaction
and sits one or two pages down.

**Do:** prove pump.fun origin from the owner of the bonding-curve account or from the create
transaction, never from the address. To find a busy mint's first transaction, page an account
that only its creation and a few later events touch, not the mint.

## 2026-10-03: no element box past the card means every number fits

**Believed:** "no descendant's box runs past the card, and the page is no wider than the
window" proves a long figure fits on a phone. The first run printed zero overflow for twelve
bungalows at four widths, and its screenshots were filed as the proof.

**Measured:** two blind spots, both in that run. (1) The figure sat in a `min-w-0` cell
inside an `overflow-hidden` panel. A figure too wide for its row shrinks the cell and is
clipped, or its unit drops under it, and no element's box moves. Run with the figures set
to 26px on a 393px WebKit phone: the box check read 0 past the card and 0 page overflow,
and the page did not slide, while a check on the TEXT (a `Range` over the cell) reported 4
of the 5 rows, four with the unit on a second line and two with digits past the row. At
320px in Chromium the same: box check 0, text check 4 of 5. (2) Every screenshot from that run was
Vite's red error overlay. The page's market card fetches `/api/aggregator`; `vite` (dev) has
no such function, serves `api/aggregator.js` as a module, fails its import analysis and
paints the overlay over the whole page. The DOM under the overlay measured fine.

**Do:** measure a figure's fit on its text: `range.selectNodeContents(cell)`, then require
the rects to sit inside the row's padding box and to share one line. See the check fail
once at a size that cannot fit before trusting its zero. Take screenshots from
`vite preview` of a build, and open them: a measurement that passes says nothing about
what was painted.

## 2026-10-03: a helper that asks "the wallet" picks a network when the browser carries two

**Believed:** a "use my wallet" helper that tries the Ethereum provider and falls back to
Solana serves both kinds of visitor, and a Solana wallet's provider is at `window.solana`.

**Measured:** at 393px on a production build, with a stand-in for Trust Wallet's own
browser (`window.ethereum` and `window.trustwallet.solana`, each recording its calls), the
Heat reader's button sent `eth_accounts`, then `eth_requestAccounts`, and never called the
Solana provider. It did so on the home page, on the Solana launch door, and on trunk with
#714 merged after the top bar showed the connected Solana address. Once each network had
its own button, an Ethereum prompt approved after the Solana button was pressed replaced
the Solana address in the field.

**Do:** a fill or connect helper takes the network as an argument, and the caller names it:
the page's own network, or one button per network. Where the site already holds the
address (a connected wallet), use it and ask no provider. Two buttons are two answers that
can arrive in either order: drop an answer only when the field was written after its press
(typing, or another fill). "Latest press wins" was tried first and lost a prompt the
visitor approved after a second press on the same button had been refused. Read
`window.trustwallet.solana` wherever `window.solana` is read.

## 2026-10-03: a plain `vite build` is not the build the e2e suite runs against

**Believed:** `vite build --outDir <temp>` plus `vite preview --outDir <temp>` is the
production build, so any spec can run against it.

**Measured:** against such a folder `e2e/door-first-frame.spec.ts` failed 11 tests on
chromium ("/bayla: served the stock shell"). Against the `dist/` that `npm run build`
writes, the same eleven spec files listed 456 tests on chromium and mobile-chrome: 284
passed, 172 skipped by design, none failed. `npm run build` runs
`render-bungalow-doors.mjs` after `vite build`, and the door pages exist only after it.

**Do:** walk a flow on a plain `vite build`; run specs against `npm run build`. A local,
uncommitted config that spreads `playwright.config.ts` and overrides `webServer` (its own
port, `reuseExistingServer: false`), `use.baseURL` and `outputDir` keeps the run off
another session's preview on 4173.

## 2026-10-03: a `flex: 1 1 0; min-width: 0` field does not let a sibling wrap; it shrinks

**Believed:** `flex-wrap` on a form drops a third control to the next row on a phone.

**Measured:** at 393px the address field (`flex-1 min-w-0`), Read Heat and one wallet
button stayed on one row. The field's hint needs 158px and the field was left 99px on the
home page and 57px on the launch door. A line wraps on the items' starting sizes, and a
zero basis with no minimum starts at zero. With the wallet button in a `w-full sm:w-auto`
row of its own the field had 212px and 170px.

**Do:** give the control that must not squeeze the field its own full-width row below the
breakpoint, or give the field a real minimum. Pin it by measuring the hint's drawn width
(canvas `measureText` with the field's computed font) against the field's content width.

## 2026-10-03: a Solana blockhash lasts about 40 seconds on mainnet now, not a minute

**Believed:** a block takes about 0.4 seconds, so a blockhash (150 blocks) is good for
about a minute, and a 45-second clock on a review "stays well inside" it.

**Measured:** on mainnet (api.mainnet-beta.solana.com, apiVersion 4.3.0),
`getRecentPerformanceSamples` gave 219 to 228 slots a minute over five samples, and
`getBlockHeight` at 'confirmed' rose 114 in 30.6 seconds with the slot rising the same 114:
0.27 seconds a block, 150 blocks in about 40 seconds. Two `getLatestBlockhash` answers 46.7
seconds apart were 171 blocks apart, so the first was dead before the second was read: the
45-second clock ran out after the blockhash had died. A phone walk of Add liquidity (Pixel
5, a production build, mainnet reads, a wallet that refuses) took 3.0 seconds to prepare
and showed "too old" 42.4 seconds after the review appeared: the timer, not the chain.
Worked out from that rate and not pressed: the review's block-height check (25 blocks to
spare) refuses from 125 blocks, about 33 seconds after the blockhash is read.

**Do:** never turn blocks into seconds from a remembered block time; read
`getRecentPerformanceSamples` (numSlots over samplePeriodSecs) the day you size a clock, and
pin the clock to that number in a test. Let a block-height read decide, and treat any
wall-clock limit as the fallback for when the height cannot be read.

## 2026-10-03: a flag carried through a wallet's "Open app" link is an input anyone can write

**Believed:** after a phone visitor presses a wallet's "Open app" row and the page reopens
inside that wallet's own browser, the job is done, or at least the next step is obvious. And
once a marker in the address was added to make that page connect by itself: that only our
own press could ever put it there.

**Measured:** four testers who had not seen the code walked the built site as a Trust user.
Inside the wallet's browser the page asked the wallet for nothing and looked exactly like the
start; the same three presses had to be repeated, and one tester called it "the spot most
likely to produce: there was no way to connect". With a marker in the query the page
connected with zero presses, 1.6 s after arrival (3.4 s with a provider injected 2.5 s late).
Then three reviewers and three skeptics, each running real code, broke the first versions
nine ways. The ones that transfer:

- `WalletProvider autoConnect` (wallet-adapter-react 0.15.39) restores WHATEVER wallet name is
  saved. For a Wallet Standard wallet that is `connect({ silent: true })`; for a legacy
  injected adapter (`autoConnect() { await this.connect() }`) it is a full connect, the
  wallet's own prompt. So mounting a provider because of a link made a wallet prompt, or
  reconnect after the visitor had disconnected, with no press. `autoConnect` also takes a
  function `(adapter) => Promise<boolean>`: gate the restore there.
- The tab that WROTE the marker loads its own marked address again: Back from the wallet's
  link page, a reload, a tab the phone discarded. A 3 second timer does not cover it (a tab
  that has navigated away never runs it, and Playwright's WebKit recorded no `pagehide` at
  all), and a link pressed inside the 3 seconds leaves the marked entry in history, where
  the timer never looks. What held: a `sessionStorage` note in the origin tab that lasts as
  long as the tab (the wallet's browser has its own storage and never sees it), plus
  stripping the marker on `popstate`. Used up on first read, the note failed on the second
  marked load.
- Every wallet's app link is built from `window.location.href` inside `connect()`, upstream
  Phantom's included, so one `history.replaceState` just before the press covers them all.
  Put the flag in the QUERY: MetaMask's link is rebuilt from host, path and query and drops a
  fragment.
- With tab storage blocked the marker was not written, and the notice still promised the
  page would connect by itself. A helper that can fail must say so to the caller that words
  the notice.

**Do:** treat a URL flag that triggers behaviour as hostile input from the first line. Read
nothing out of it. Decide separately what a crafted link may cause in each kind of browser
(a computer, an ordinary phone browser with a wallet of its own, a wallet's own browser),
and write one test per kind against the REAL provider and adapters: fakes whose
`autoConnect` is a no-op passed while the real ones prompted. Not settled here: the rule
that tells a wallet's own browser from an ordinary one (no adapter offers "Open app" there)
rests on user agents nobody has read off a real device.

## 2026-10-03: React Router matches a path whatever its case; a hand-written path test does not

**Believed:** `isSolanaPage(pathname)` and the router agree about which page is on screen,
because both are given the same pathname.

**Measured:** `/Earn/bobo`, `/earn/%62obo`, `/Dashboard` and `/Curve-Launch/<mint>` all render
their route (React Router ignores case and decodes params), while a predicate comparing the
raw string said "not a Solana page". Two wallet providers were then mounted for one page and
the wallet was asked twice, 80 to 330 ms apart; with a wallet that refuses a second request
the approval landed nowhere. The same shape, without the case trick: a route (`/solana-lp`)
added to the router and not to the predicate.

**Do:** a predicate that mirrors the router has to match the way the router does:
`decodeURI`, and the `i` flag on the static part of the pattern (keep ids and addresses as
written), or mark the routes `caseSensitive`. And when a route is added, grep for every
hand-kept list of paths.

## 2026-10-03: three things a Playwright walk and a wording guard got wrong before they were right

**Believed:** `context.on('page')` is how to catch a popup; `route.abort()` on a navigation
models "the phone opened an app instead"; and a test that greps for `>Connect Wallet<`
proves the bare words are gone.

**Measured:**

- `context.on('page', ...)` registered before `context.newPage()` fires for that page too. A
  handler that closes "the popup" closed the page under test: `page.goto: net::ERR_ABORTED;
  maybe frame was detached`. Register it after creating the page, or skip `popup === page`.
- Aborting a main-frame navigation leaves Chromium on a blank error page, while WebKit stays
  where it was. A real phone that hands a link to an app leaves the browser ON the page. To
  model that in both engines, answer the link with `route.fulfill({ status: 204 })`.
- The guard caught `>Connect Wallet<` and a stock `<ConnectButton />`, and passed
  `{'Connect Wallet'}`, a ternary, a variable, and `Connect wallet` with a small w (each
  tried by mutation). After stripping comments, refuse the phrase anywhere in code, case
  ignored, and count uses of the replacement constant rather than its presence: the import
  line alone satisfied "contains".

**Do:** when a test guards WORDS, mutate the ways the words can be spelled, not only the
one spelling that existed.

## 2026-10-03: a button disabled "while connecting" is a dead end when the wallet never answers

**Believed:** the site could not see Phantom ("it wont even recognize my phantom wallet", the
owner's words), so the fault was in wallet detection.

**Measured:** in the owner's browser `window.phantom.solana.isPhantom` was true and a Wallet
Standard wallet named Phantom was registered with the Solana chains; the swap card read
"Connecting…" and was disabled, and the top bar's Connect did nothing. On production, a
Wallet Standard wallet named Phantom whose `standard:connect` returned a promise that never
settles, with `walletName` saved, gave the same screen 9 and 30 seconds after load: card
disabled, top bar `aria-disabled`, no dialog. wallet-adapter-react 0.15.39 keeps
`connecting` true until that promise settles, and resets it only when the adapter changes
or emits `disconnect`. The page connected by itself once the real wallet answered.

**Do:** never tie `disabled` to a promise that the user's own wallet settles. Keep the
control pressable and let the press lead somewhere (here the wallet list, where another
wallet can be picked: the provider resets on an adapter change), and say which wallet is
being waited on. Do not cancel the wait: an approval prompt may be open. A second connect
on the same Standard wallet does nothing while the first is pending (`StandardWalletAdapter`
1.1.5 returns early), so retrying the same wallet needs it to answer, or a reload. Fixed
in PR #715. A scripted `button.click()` on Connect in someone's real browser starts a real
wallet prompt that only they can answer: say so when a probe does that.

## 2026-10-03: a form that only greys out its button reads as "it does not work"

**Believed:** the open-a-pool form was broken or missing ("i still am not able to create lp
on solana").

**Measured:** in the owner's browser the form was open and correct. Under its two boxes, in
10px grey, it said "You have 0.005960758 SOL. Up to 0 SOL can go in after the fee to open,
the account deposits and network fees." and "You have 0 tokens.", and Review was greyed
out. Opening needs about 0.183 SOL before any SOL goes into the pool: a wallet with
0.879012984 SOL was told 0.695744984 could go in.

**Do:** when nothing the visitor types can make the button work, say that in one sentence
beside the button, with the number needed and the number held, before anything is typed.
A hint under an input answers "what is the most I can enter", not "why can I not proceed".
Done for the open and add forms in PR #716 (`cannotFundText`).

## 2026-10-03: a live money flow can be walked to the sign step with a wallet that is only a public address

**Believed:** checking the live site's open, add and remove flows needs a real wallet with
real money, or a local validator.

**Measured:** against https://memetics.finance at trunk a5c3d19a, Playwright registered a
Wallet Standard wallet whose account was a public mainnet address
(3wAjKgQN6HEV58wgsbedVb4ZSmJXc7i5wkRtZ9GTu9Dm, found as a recent fee payer on the BAYLA
mint) and whose `signTransaction` handed the bytes to Node through `exposeBinding` and then
threw `User rejected the request.` The site read that address's balances (0.879012984 SOL,
1,393,591.753468 BAYLA), built an 888-byte legacy transaction of 7 instructions that opens
a BAYLA/SOL pool on fee tier 1, ran its own test run and reached "Sign in wallet". After
the refusal it said "Not sent. Your wallet did not sign it." The captured bytes, run from
Node with `simulateTransaction` (`sigVerify: false`, `replaceRecentBlockhash: true`),
returned no error, 117,094 units, and a fee payer 480,774,560 lamports lower: the 0.4807
SOL the review printed. Nothing was signed and nothing was sent.

**Do:** copy the registration block from `frontend/e2e-solana/fixtures/testWallet.ts`,
drop the keypair, and make every sign feature capture and refuse. To find a funded address
use `getSignaturesForAddress` on the mint and then `getTransaction` for the fee payers:
`getTokenLargestAccounts` answered 429 on api.mainnet-beta.solana.com and "requires a
personal token" on publicnode. This cannot reach add or remove while no pool exists.

## 2026-10-03: the on-chain suite can run beside another session's, given its own validator ports, preview port and build folder

**Believed:** one machine runs one `npm run e2e:solana` at a time, because the validator
port, the preview port and the build folder are fixed.

**Measured:** another session's `solana-test-validator` 3.1.11 was listening on 8899 and
on 9900, the default faucet port (`ss -ltn` in WSL). A second one, started from a copy of
`start-validator.sh` with `--faucet-port 9911 --gossip-port 8111 --dynamic-port-range
8112-8160` added, `E2E_RPC_PORT=8999` and its ledger under `$HOME/audit1003/` (the script
writes its log beside the ledger's parent, so a shared parent shares the log), reached
READY with its own genesis hash while the first kept its own. `playwright.solana.config.ts`
fixes port 4180 and `os.tmpdir()/tegridy-solana-e2e` with `--emptyOutDir`, so a second run
of that config would empty the first run's build; an untracked config that spreads the
base one and overrides `webServer`, `use.baseURL` and `outputDir` (port 4191, its own
folder), run with `E2E_SOLANA_RPC=http://127.0.0.1:8999`, ran all 157 tests: 124 passed,
31 skipped by design, 2 failed. Not measured: whether the second validator starts without
the faucet flag.

The two failures were load, not code: both were "reload while unconfirmed" tests, run
while two other jobs were running vitest sweeps on the same machine. One (`lp-write` E12,
"transaction did not land", a 10-second wait in `landedTx`) passed in the same run at
phone size, and both passed when their files were run again alone on the same commit.

**Do:** give a parallel run all four of its own: validator ports, ledger folder, preview
port, build folder. Read "did not land" and "visible but not clickable" in a full run on
a busy machine as a reason to re-run that file alone, not as a break, and say which it was.

## 2026-10-03: create-if-missing opens a token account over an address a stranger already sent SOL to

**Believed:** an account that exists at a wallet's associated token address but is not a
token account is a broken account, so refuse to build on it.

**Measured:** two mainnet test runs from Node (`simulateTransaction`, `sigVerify: false`),
each one transaction: a System transfer of 650,240 lamports to a never-used associated
address, then `createAssociatedTokenAccountIdempotent` for that address. For the BAYLA
mint (Token-2022) and for wrapped SOL (classic) both returned no error, and the address
ended owned by the token program as an initialized account with amount 0. The fee payer
paid only the top-up: the wrapped-SOL run moved it by 1,493,440 lamports, which is the
650,240 it sent itself, 838,200 to reach the 1,488,440 deposit, and the 5,000 fee.

**Do:** treat an address owned by the System program with no data as an account that has
not been opened, wherever "absent" is decided, and refuse only another owner or data that
is not a token account. Treating only `null` as absent let anyone block a wallet's
withdrawals on the site for the price of one dust transfer. Fixed in PR #716 (`opened` in
`frontend/src/lib/launcher/solana/write/wsol.ts`).

## 2026-10-03: in `String.prototype.replace`, a replacement text that holds `$'` pastes in the rest of the input

**Believed:** `s.replace(oldLine, newLine)` with two plain strings swaps one line for the
other.

**Measured:** a scripted edit of `DashboardPage.tsx` whose new line held `prefix: '$', sub:`
left the file unparseable (vitest: "Transform failed with 1 error"). `$'` in a replacement
string means "the text after the match", so everything after the matched line had been
spliced into the middle of it; the tail of the new line turned up about 950 lines further
down, at line 1381. `$&`, `` $` `` and `$1` are read the same way.

**Do:** pass a function, `s.replace(oldLine, () => newLine)`, which is used as written,
and afterwards grep for a phrase from the new line and expect exactly one hit.

## 2026-10-03: a tab the browser extension cannot screenshot can still report what it drew, through the console

**Believed:** when the extension's tab is hidden and every evaluate and screenshot times
out, the owner's own browser can tell us nothing.

**Measured:** in Edge the extension's tab had `document.hidden` true. One synchronous
evaluate straight after `navigate` returned (readyState `interactive`, `<main>` empty);
every later one timed out at 45 seconds, and screenshots failed with "Script injection
timed out". A `MutationObserver` installed by that first evaluate, writing one
`console.log('[AUDIT] ' + JSON)` line whenever the page changed, was read back with the
extension's console reader: 11.3 seconds after navigation the page had its title, the
`lp-section` test id and "VENUE · LIVE". `clientWidth` was 0 in that tab, so it says
nothing about layout.

**Do:** install the observer in the one evaluate that works and read the console, not the
page. Use it for "did it render, and what did it read"; measure layout somewhere visible.

## 2026-10-03: a screenshot taken the moment a dialog exists shows it half see-through

**Believed:** the phone wallet list was transparent, with the page's text readable through
it.

**Measured:** the wallet adapter's `.wallet-adapter-modal-fade-in` wrapper had computed
opacity 0 at the moment `getByRole('dialog')` first resolved on desktop, 0.33 on an 820px
viewport, and 1 by 400ms on all three sizes. A screenshot at 4 seconds was solid.

**Do:** before judging or capturing a dialog, wait until the computed opacity of its fade
wrapper is 1. The same goes for a tall element screenshot: where the element passes under
a fixed header, the header is painted across the middle of the picture.

## 2026-10-03: a guard that names one spelling of a call covers one spelling

**Believed:** after #603/#609/#622 every receipt wait passed `onReplaced` and checked the hash,
because `receiptConsumers.guard.test.ts` failed any file that did not. And a status poller that
throws when its time runs out is fine, because the caller's `catch` can say what happened.

**Measured** (PR #696, trunk `ab739ff3`):

- The guard matched `useWaitForTransactionReceipt(`, the wagmi hook. `git grep
  waitForTransactionReceipt` found 11 direct `publicClient.waitForTransactionReceipt` calls and
  4 `getTransactionReceipt` re-reads it never saw. A real viem 2.56.8 public client driven
  through a scripted node (`frontend/src/lib/txErrors.direct.test.ts`) resolves a cancel, a
  speed-up and any other same-nonce transaction with the replacement's success receipt, the
  same as through the hook. On the pre-fix hooks, in vitest: a cancelled DCA swap was counted, a
  cancelled limit-order swap marked the order filled, a cancelled registration toasted "TWAP
  registered", and a zap recorded a cancelled approval as confirmed and sent the next step.
- A third spelling is inside `node_modules`: `@whetstone-research/doppler-sdk` 1.0.39
  `createDynamicAuction` waits with no `onReplaced` and returns `transactionHash: hash`, the
  submitted hash, so after a speed-up the caller holds a hash that never mined (read in
  `dist/evm/index.js`, not run).
- A re-read by hash cannot find a replacement. `getTransactionReceipt(sent)` answers only for
  `sent`, and viem's live wait finds a replacement from the pending transaction's sender and
  nonce, which it can no longer read once the original is dropped. So a transaction replaced
  after the live wait gave up stays unread for good.
- The Solana swap page's own poller threw `Could not confirm in time` after 60s and let a
  `getSignatureStatuses` rejection escape. With the real page under vitest and a scripted
  connection, a watch that ran out toasted `Swap failed`, and one rejected status read toasted
  `Swap failed` for a swap whose next read said confirmed.
- ethers is the other way round. Read in the installed ethers 6.17.0 source
  (`lib.esm/providers/provider.js`, `TransactionResponse.wait`; not run): a revert throws
  `CALL_EXCEPTION`, so `receipt.status === 0` after `await tx.wait()` is dead code, and every
  replacement throws `TRANSACTION_REPLACED`, a speed-up included (`reason: 'repriced'`,
  `cancelled: false`, with `receipt`). An ethers `catch` is three facts: reverted, replaced but
  ran, and unread.

**Do:**

- Pin a rule on the library call, not on the wrapper you fixed first. Grep every spelling
  (hook, client method, bare action import, SDK internals) and make the guard forbid the raw
  call outside one helper, with any exception named beside its reason.
- A wait that can outlive its transaction needs the sender and nonce if a later re-read must
  learn it was replaced. A hash alone cannot.
- A confirm poller returns an outcome (`confirmed`, `reverted`, `unknown`). It never throws
  for "time ran out" or for one failed read: a caller's `catch` will call both a failure.
- With ethers, `TRANSACTION_REPLACED` with `cancelled === false` is a success: take
  `error.receipt`.

---

## 2026-10-03: "above the fold at 390x844" measures the phone's screen, not the page its browser gets

**Believed:** a field that is whole inside 390x844 in a first-screen test is on an iPhone's
first screen.

**Measured:** 390x844 is the iPhone 13 and 14 screen. Playwright 1.62.1's own descriptors give
the page 390x664 on those two and 393x659 on an iPhone 15, the device behind the repo's
`iphone-safari` project (`frontend/playwright.config.ts`). The /solana-lp token address field
passed at 390x844; at those heights the whole field sat under the bottom bar and ended 47 to
52px past the first screen (fixed in b06445e1, PR #704, branch `feat/pools-solana-lp-tab`).

**Do:** measure a first-screen claim at the device's `viewport`, not its `screen`
(`FIRST_SCREENS` in `frontend/e2e/tab-target-size.spec.ts` on that branch adds 390x664 and
393x659), and do not set a device project's height to the screen's. Assert that
`window.innerHeight` is the height the case names, since a project may not give it.

---

## 2026-10-03: the "Main navigation" role matches the top bar from 800px up, so find the phone's bottom bar by position

**Believed:** `getByRole('navigation', { name: 'Main navigation' })` is the phone's bottom bar,
so its height is what to take off the first screen.

**Found:** two elements carry that label: `frontend/src/components/layout/BottomNav.tsx`
(`fixed bottom-0`, hidden from 800px) and the row in `frontend/src/components/layout/TopNav.tsx`
(hidden below 800px). A role query skips whichever is hidden, so at 800px and wider it returns
the top bar, and a height read from it is the wrong bar's.

**Do:** pick the bar by where it is. `bottomBarHeight` in `frontend/e2e/tab-target-size.spec.ts`
(branch `feat/pools-solana-lp-tab`, added in 3858c927) walks `nav[aria-label="Main navigation"]`
and keeps the one whose computed `position` is `fixed`, that has height, and whose bottom edge
is at `window.innerHeight`. It returns 0 when there is none, and each case asserts which it
expects.

---

## 2026-10-03: React's `useId` values differ between two loads of the same build, so normalise them before comparing HTML

**Believed:** the same build loaded twice renders the same HTML, so comparing a page's HTML
before and after a change shows only what the change did.

**Measured:** two loads of one build gave different `useId` values for the same elements, so
every comparison "differed" until the ids were normalised. react-dom 19.3.0 builds a client id
as `_r_<n>_` from one page-wide counter, in the order components first mount, so anything that
changes mount order changes every id after it. The ids land in `id`, `aria-describedby` and
`aria-labelledby` (`frontend/src/components/ui/InfoTooltip.tsx`,
`frontend/src/components/solana/lp/PanelFrame.tsx`).

**Do:** before comparing rendered HTML, replace every `_r_[0-9a-v]+_` with one fixed token on
both sides. A "same HTML before and after" claim (b06445e1 makes one for /pools) holds only
with that step.

---

## 2026-10-03: in Git Bash on Windows, an argument that starts with a slash is rewritten to a Windows path

**Believed:** a quoted argument reaches the program as typed.

**Measured:** in Git Bash, printing `process.argv` from node: `"/pools shows the tab"` arrives
as `C:/Program Files/Git/pools shows the tab`, so `npx playwright test -g "/pools ..."` is
given a pattern no test title matches. `git show origin/mvp-launch:.gitignore` arrives as
`origin\mvp-launch;.gitignore` and fails with "ambiguous argument", while `HEAD:.gitignore` and
`origin/mvp-launch:frontend/package.json` pass through untouched.

**Do:** prefix the command with `MSYS_NO_PATHCONV=1` (both then arrive as typed), or keep the
leading slash out of the pattern (`-g "pools ..."`). When a `-g` run finds no tests, print the
arguments the program received before doubting the test.

---

## 2026-10-03: `tests | tail -4 && git push` pushes on a red run, because a pipeline's status is its last command's

**Believed:** `&&` after a test command stops the push when the tests fail.

**Measured:** in bash, `false | tail -4 && echo pushed` prints `pushed`: the pipeline's exit
status is `tail`'s, which is 0. On 2026-10-03 a line of this shape pushed a branch with one
test red. That test was a load flake and passed on a re-run, but the guard had done nothing.
With `set -o pipefail` the same line exits 1 and prints nothing.

**Do:** `set -o pipefail` before the line, or run the tests on their own and check their exit
code (or `${PIPESTATUS[0]}`) before the push. Trimming output with `tail` or `head` is the
usual way this gets in.

---

## 2026-10-03: a near-full Solana transaction has no room for a memo, so give readers a read recipe instead

**Believed:** the way to make a kind of transaction findable later is to tag it with an SPL
Memo.

**Measured:** the curve launch's worst-case create, with the plant, is 1,210 of a legacy
transaction's 1,232 bytes (pinned in `frontend/src/lib/launcher/solana/write/prepare.test.ts`),
so 22 are left. A "PLANT <mint>" memo costs about 85: the memo program's 32-byte key, 3 bytes
of instruction framing and about 50 of text.

**Do:** name an account every such transaction must touch, and say what to filter by. Every
plant pays the Workshop's $BAYLA account (`WORKSHOP_BAYLA_ACCOUNT` in
`frontend/src/lib/launcher/solana/write/plant.ts`), so the recipe is that account's signatures
(`getSignaturesForAddress`), keeping the transactions that carry the plant's two instructions
(`plantInstructions`: a burn and a transfer of 50,000 $BAYLA each).

---

## 2026-10-02: `import.meta.env.DEV` is true in a `vite build` run with NODE_ENV=development

**Believed:** a dial honoured only when `import.meta.env.DEV` is true can count on a dev server
and never in a shipped bundle.

**Measured:** Vite inlines DEV from NODE_ENV even in `vite build`. A real build with
NODE_ENV=development and `VITE_HEAT_GATE=off` (a dashboard variable or a `.env` line is enough)
produced a bundle whose heat door opened to any wallet (920b8fc0, on #682 and #691; the
real-build test is now `frontend/src/lib/devServerDefine.test.ts`). The first fix read the flag
from a shared module, and the build split that into a 37-byte chunk `index.html` then
modulepreloaded (22 preloads, was 21; 8a83d9bc).

**Do:** decide from the command that compiled the code. `frontend/vite.config.ts` defines
`__VITE_DEV_SERVER__` as `command === 'serve'`; each gate reads it in place, beside DEV
(`src/lib/heat/heatGateConfig.ts`, `src/lib/launcher/solana/curveWriteFlag.ts`), so every build
folds the check to false inside its own file.

---

## 2026-10-02: a Doppler vesting's `releasedAmount` is what the maker claimed, not what has vested

**Believed:** `vestingOf(beneficiary, scheduleId).releasedAmount` on a DopplerERC20V1 token is how
much of the allocation has unlocked, so 0 means still locked.

**Measured:** it counts only what was taken through `release()`. Vested but unclaimed tokens
sit in `computeAvailableVestedAmount(beneficiary, scheduleId)` (both are in the Doppler SDK's
`dopplerERC20V1Abi`). The /launch maker card read a real launch with a one-day vesting as
"locked ... 0 tokens released so far" five months after all of it had unlocked (1435b4cd, #691).

**Do:** say "claimed so far". Before saying "locked", compare the schedule's dates with the time
of the read: ended is claimable now, before the cliff is locked, between is partly claimable, and
unreadable dates are not a lock (`lockText` in
`frontend/src/components/launcher/makerPlatesCopy.ts`).

---

## 2026-10-02: a Doppler vesting event proves nothing unless the Airlock created that token

**Believed:** a `VestingScheduleCreated` or `VestingAllocated` log at a token's address, in the
transaction that made it, is that token's maker allocation and lock.

**Found:** any contract can emit those events at its own address; they are ordinary logs. Before
982ccf28 (#691) the /launch maker card printed a lock for any token whose transaction carried
them, and called the transaction's sender the maker even when the call went through a smart
wallet or another contract.

**Do:** read an allocation only for a token the Airlock created: its own `Create` log for this
asset in the birth receipt (exactly one), or the Airlock's `getAssetData`
(`readAirlockAssetData` in `frontend/src/lib/launcher/tokenDossier.ts`). Name a maker only when
the birth transaction's `to` is the Airlock (`dopplerBirthFromReceipt` in
`frontend/src/lib/launcher/birthPlates.ts`); otherwise say it could not be named.

---

## 2026-10-02: an exact balance check on an account strangers can pay into lets anyone block the transaction

**Believed:** a pre-sign simulation should hold every token account to the exact change its
instructions make, since the instructions move exact amounts.

**Measured:** the curve launch's create held the maker's $BAYLA account to exactly -100,000 and
the island Workshop account to exactly +50,000, each against a balance read a moment earlier.
Anyone can send $BAYLA to either account in between (another launch's plant, or 1 base unit), and
every launch's plant pays the same Workshop account, so blocking every launch was cheap. 757b5cb8
(#682, #691) made both bounds one-sided; its new `prepare.test.ts` case is red on the exact bounds.

**Do:** on an account others can pay into, bound one way: the payer loses at most X, the
destination gains at least Y (`prepareCreateLaunch` in
`frontend/src/lib/launcher/solana/write/launch.ts`). Keep the exact amount, destination, mint and
decimals pinned in the instruction bytes the intent decoder checks (`write/intent.ts`).

---

## 2026-10-02: a local stand-in for a mainnet mint can be mainnet's own bytes with one field changed

**Believed:** a local validator gets either a copy of the real Token-2022 mint, whose null mint
authority means no test wallet can be given any, or a look-alike mint that is not mainnet's.

**Measured:** af62d286 (#682, #691) seeds $BAYLA at its real address from a read-only
`getAccountInfo` dump (`frontend/scripts/solana-localnet/golden/bayla-mint.mainnet.json`, slot
452541742) with only the mint authority (bytes 0-35) set to a test key from a fixed phrase.
`baylaMintStandIn` in `genesis-accounts.mjs` refuses a dump that is not that mint, a test pins
that the stand-in differs only in bytes 0-35, and `frontend/e2e-solana/global-setup.ts` refuses a
validator whose mint differs from the seeded bytes anywhere but the supply.

**Do:** copy mainnet's bytes, change the one field the test needs, pin that nothing else
changed, and have global setup refuse any other validator state.

---

## 2026-10-02: `tsc -b` does not type-check `frontend/e2e-solana`, because no project includes it

**Believed:** the type gate (`npx tsc -b --noEmit`, or `--force` locally) checks every
TypeScript file under `frontend/`.

**Measured:** `frontend/tsconfig.json` references three projects: app (`src`), node
(`vite.config.ts`, `playwright.config.ts`) and test (`src` tests). `tsc --showConfig` (5.9.3) on
each, at #691's head, lists none of the 17 `.ts` files in `frontend/e2e-solana`, nor
`playwright.solana.config.ts`. Playwright strips types without checking them, so a type error
there passes the gate and the run.

**Do:** until a project reference covers it, check it with a scratch config,
`{ "extends": "./tsconfig.node.json", "include": ["e2e-solana", "playwright.solana.config.ts"] }`,
run with `tsc -p`. Before calling a folder type-checked, find it in an `include` list.

---

## 2026-10-01 — a PR whose base moved can still merge exactly what its CI tested

**Believed:** once trunk moves under an open PR, its green checks no longer describe what a
merge would land, so the PR has to be updated and re-tested (about 70 minutes here, most of it
E2E) before it merges.

**Measured:** `git merge-tree --write-tree origin/mvp-launch origin/<branch>` prints the tree
the merge would produce, without touching any checkout. When that equals
`git rev-parse origin/<branch>^{tree}`, the merge lands byte for byte what the PR's CI ran on,
however far trunk has moved. On 2026-10-01 nine PRs landed in a row with no second CI run:
seven with equal trees, two by the file check below. Three of them (#680, #683, #681) had
merged the head of the PR ahead of them before their CI ran, so each was already tested on
the trunk it was about to become. Where the trees
differ, `git diff --name-only origin/<branch> <merged tree>` lists exactly what CI did not
see. For #677 and #678 that was only `.gitleaks.toml`, and `git grep` showed no build or test
reads its contents (one test checks that it exists, one mentions it in a comment), so their
green carried over.

**Do:** before merging, compare the merged tree with the PR's tree. Equal: merge, pinned with
`--match-head-commit`. Different: read the file list. Re-test unless no build or test can read
those files. To save the cycle, merge the head of the PR ahead into the next PR before its CI
runs. `mergeStateStatus` cannot tell you any of this: with no branch protection it reads
`CLEAN` on a stale base.

---

## 2026-10-01 — a recorded RPC read keyed `method:address` trips gitleaks on public data

**Believed:** a fixture that holds only public on-chain data cannot trip the secret scan.

**Measured:** gitleaks 8.30.1's `generic-api-key` rule flagged
`frontend/e2e/fixtures/baylaLadderPool.ts` lines 25 and 37 in #683. Those are keys of a
recorded Solana RPC read shaped `"getTokenAccountBalance:<base58 address>"`, and both
addresses are the BAYLA ladder's public token vaults (Token-2022 accounts owned by the pool
PDA, read on mainnet). Over #683's range (`5d7c363e..7328eac8`) the scan found 2 leaks with
the old config and 0 with both addresses listed as exact strings in `.gitleaks.toml` (#684). A
later commit on the same PR cannot clear the finding: the PR scan walks every commit in its
range, and the address is still in the commit that added it.

**Do:** key a recorded read by a label (`stakeVaultBalance`), not by `<method>:<address>`.
Where the address must appear, list it in `.gitleaks.toml` as an exact string, never as a
base58 shape (that file records why), and do it before or with the fixture, not after.

---

## 2026-10-01 — with `--no-options`, gpg will not create a missing home, and exits 2

**Believed:** gpg creates `~/.gnupg` on first use, so a script that runs it on a fresh
machine or CI runner just works.

**Measured:** with `--batch --no-options` and no existing home, gpg exits 2 with
`keyblock resource '<home>/pubring.kbx': No such file or directory`, even though it still
writes the ciphertext. This held for symmetric encrypt and decrypt alike, on GitHub's
`ubuntu-latest` (#677's CI), WSL gpg 2.4.4 with a fresh `HOME`, and Git for Windows gpg 2.4.9
with `GNUPGHOME` pointing at a folder that did not exist. It passed on this PC only because a
home already existed. `--no-autostart` is not a way around it: symmetric encryption needs
gpg-agent to choose its key-stretching strength, and without the agent gpg exits 2.

**Do:** give each gpg call its own fresh home: `mkdtemp`, mode 0700, passed with `--homedir`,
deleted afterwards. Git for Windows gpg (MSYS) reads a `C:\` home as a relative path, so pass
it the `/c/...` form. `scripts/ops/lib/gpg.mjs` does all of this. Judge success by the exit
status, never by output existing.

---

## 2026-10-01 — after `await findByRole(...)`, a re-render a promise queued meanwhile may not have committed

**Believed:** once `await screen.findByRole('dialog')` returns, the page is settled, so a
click on the next line reads the latest state.

**Measured** (React 19.2.8, @testing-library/react 16.3.3, vitest 4.1.11, jsdom): RTL's
`asyncWrapper` switches act mode off for the whole `findBy*`/`waitFor`, then resolves after
a `setTimeout(0)`. A promise that settles in that window (here, WalletProvider restoring a
saved wallet on mount) sets state outside any act scope, so React queues the re-render on
its Scheduler, which in Node is a `setImmediate`. The event loop decides which runs first.
On PR #684 (a `.gitleaks.toml`-only diff) the timer won on a CI runner: the row click
closed over the render that still said `connecting: true`, skipped `connect()`, and
`waitFor` timed out with `expected +0 to be 1` after ~1044 ms. A probe that forced that
order (open the dialog, drain microtasks only, click) failed the same way every run, with
the committed `connecting` still `true`.

**Do:** let async work started at mount finish inside an awaited `act()` before the first
`findBy*`. React keeps an async act's queue open until a later `setImmediate` finds it
empty (`recursivelyFlushAsyncActWork`), so a state update from a microtask chain is
queued and committed before act resolves. Where a click acts synchronously, assert right
after it: a `waitFor` around a call that never happens only turns a wrong state into a
one-second timeout.

---

## 2026-09-30 — keeping both sides of a NOTES or TODO conflict can turn a paragraph into a heading

**Believed:** a conflict in `NOTES.md` or `docs/TODO_OPERATOR.md` where two branches each add
sections at the top is resolved by keeping every section and joining them with the file's `---`
separator.

**Measured:** merging three branches that each added sections (2026-09-30), a script split each
side on `\n---\n\n` and joined them the same way. The last section of each side has no blank
line after it inside the conflict, so the join put `---` straight under a paragraph: 4 places
in the two files. In Markdown a `---` right under a text line is a setext heading underline, so
the whole paragraph above renders as a heading. No test reads for it.

**Do:** after resolving, list every `---` line whose previous line is not blank:
`awk 'NR>1 && $0=="---" && prev!="" {print FILENAME": "NR} {prev=$0}' NOTES.md docs/TODO_OPERATOR.md`.
The list must be empty.

---

## 2026-09-30 — with two push URLs, a push the first host refuses still reaches the second

**Believed:** an `origin` with two `pushurl`s (GitHub, then GitLab) stops at GitHub when GitHub
refuses a push, for example because its secret scanning found a key in it.

**Measured:** git pushes to each push URL in turn and goes on after one refuses (git 2.53,
throwaway repos, 2026-09-30). The "GitHub" repo's pre-receive hook refused `feat/leak`; the same
`git push` then printed `* [new branch] feat/leak -> feat/leak` for the "GitLab" repo, and
exited 1. The standby is public, so that push would have published the key.

**Do:** give the clone a pre-push hook. git runs it once per push URL, with that URL as `$2`. For
every URL after the first, ask the first host (`git ls-remote`) whether it now holds each ref
exactly as pushed, and refuse otherwise. `scripts/git-hosting/pre-push-standby.sh` does this and
`set-remotes.sh` installs it; without it, the set-remotes tests go red. A `--dry-run` push then
reports the second URL as refused, because the first took nothing.

---

## 2026-09-30 — a GitHub schedule that stops running tells someone

**Believed:** if GitHub's scheduled workflows stopped, a failed run, an issue or an email would
say so.

**Measured:** reported by the lead on 2026-09-30 (not re-read here: this work made no GitHub
calls). After the account's suspension (2026-09-24) and reinstatement (2026-09-29), no scheduled
workflow had run for more than five days, and none had resumed when this was written. Nothing
told anyone. A schedule that does not fire produces no run, so there is nothing to fail, and
every alarm those jobs had (issues, run emails) lived on GitHub too. One piece was checked
here: the nine backups downloaded on 2026-09-29, reported as every artifact GitHub held, end at
2026-09-21 (the folder names), so the Monday 2026-09-28 backup left no artifact. The exact date
of the last scheduled run needs `gh run list`, which this work did not call.

**Do:** watch a schedule from outside its host, by silence rather than by failure. The last step
of `synthetic-monitor.yml` pings healthchecks.io every 30 minutes; the check alarms when the
pings stop (`docs/OPS_SCHEDULER.md`, section 2). Ping on every run, pass or fail: a "fail"
ping holds the check DOWN, and a check that is already DOWN sends no email when the pings then
stop. Keep a copy of anything the host stores, too: `scripts/ops/pull-github-backups.mjs`
copies the weekly backup off GitHub.

---

## 2026-09-30 — a fake tool put first on PATH is the one a Git Bash child runs

**Believed:** a test that spawns Git Bash with a fake `curl` folder at the front of PATH runs
the fake.

**Measured:** `C:\Program Files\Git\bin\bash.exe` is a launcher that puts `/mingw64/bin` and
`/usr/bin` ahead of the PATH it was given, so `type -a curl` listed the real curl first. A test
meant to catch a ping sent real requests to hc-ping.com (a made-up check id, so nothing was
pinged) and took 8 seconds of retries.

**Do:** set PATH inside the shell (`bash -c 'PATH="$(cd "$FAKE_DIR" && pwd):$PATH"; . "$1"'`),
assert the fake actually ran, and point test URLs at a host that cannot resolve, such as
`.invalid` (RFC 2606), so a bypassed fake sends nothing.

---

## 2026-09-30 — a paged read whose row count matches the server's total read every row once

**Believed:** paging a PostgREST table with `Range` and `Prefer: count=exact`, then checking
that the rows read equal the reported total, proves every row was read.

**Measured:** against a fake PostgREST that pages in heap order, as a query with no `ORDER BY`
may, and moves one row to the end between page 1 and page 2 (what an UPDATE can do to a heap):
1,500 rows read, total 1,500, row 1000 missing and row 10 read twice. Sorted by primary key,
the update was harmless, but a delete before the page boundary plus an insert after it still
read 1,500 of 1,500 with row 1000 missing and no key repeated, so a duplicate check alone does
not catch it. Same fake; no real Postgres was run.

**Do:** page in primary-key order, and start each page on the last row of the page before. If
that row is not where it was, rows shifted: fail and re-run. Then check that no key repeats.
`scripts/ops/lib/supabase-dump.mjs` does all three.

---

## 2026-09-29 — a gitleaks config read from the base commit stops a change loosening its own scan

**Believed:** run gitleaks with `--config` and `--gitleaks-ignore-path` taken from the commit a
merge request builds on, and the merge request cannot loosen the scan of its own commits.

**Read in gitleaks v8.30.1's source** (`cmd/root.go`, by this branch's reviewer; not run here,
there is no gitleaks binary on this PC): gitleaks also loads `.gitleaksignore` from the folder
it scans, which is the change's own checkout. It also honours `gitleaks:allow` comments unless
`--ignore-gitleaks-allow` is set. So a change can add a secret and either its fingerprint in
`.gitleaksignore` or a `# gitleaks:allow` on the same line, and pass.

**Do:** scan a `git clone --no-checkout --shared` of the checkout (the same history, no
working-tree files), and pass `--ignore-gitleaks-allow`. `scripts/ci/gitleaks-range.sh` does
both.

---

## 2026-09-29 — a job on our own act runner starts as clean as a job on GitHub's VMs

**Believed:** each act job on a self-hosted runner starts from its image, as a GitHub-hosted
job does, so one pipeline cannot change what the next one runs.

**Read in act v0.2.89's source** (by this branch's reviewer; act is not installed here): every
job container gets the named volume `act-toolcache` at `/opt/hostedtoolcache`, and act never
removes it. Any job can plant a tool there, such as a fake node that `actions/setup-node` then
picks, for every later run on that Docker daemon. act's actions/cache server matches entries by
key and version only, with no branch scope. **Reproduced with git:** GitLab's shell executor
reuses one build folder, and a job that skips submodules sees them at the last job's commit, so
`git status` shows ` M contracts/lib/<x>`.

**Do:** run one job at a time, drop the volume before each run, give merge requests a
throwaway copy of the cache store, and leave submodules out of a clean-checkout check.
`scripts/ci/act-job.sh` does all of these.

---

## 2026-09-29 — copying `refs/stash` copies one stash, not the stash list

**Believed:** fetching or bundling a clone's `refs/stash` saves its stashes, and old stash
entries expire after 30 or 90 days like any other reflog entry.

**Measured:** only `stash@{0}` is a ref. The rest are the reflog of `refs/stash`, and no fetch,
push or bundle carries a reflog. Our first vault fetched `refs/stash` from a clone with 12 entries
and held 1 (git 2.53). They do not expire, though: git exempts `refs/stash` from reflog expiry
unless a `gc.refs/stash.*` setting exists. Three entries dated six months back survived `git gc`,
even with `gc.reflogExpire=1.day`; with `gc.refs/stash.reflogExpire=1.day` all three went.

**Do:** fetch each id from `git reflog show --format=%H refs/stash` into its own ref (the source
side needs `uploadpack.allowAnySHA1InWant`). `scripts/git-hosting/consolidate-refs.sh` does this,
and a mutant that keeps only the top entry goes red.

---

## 2026-09-29 — a bundle of a clone's branches does not hold the host's newest trunk

**Believed:** `git bundle create <file> --branches --tags` in a working clone backs up the trunk.

**Measured:** after the host merged a request and the clone fetched it, the new trunk was only
`refs/remotes/origin/mvp-launch`; the clone's own `mvp-launch` stayed at the old commit. The
bundle held the old one, so a restore from it would have deployed an older site.

**Do:** bundle with `--remotes` too, and when restoring, list every `*/mvp-launch` in every
bundle, then check that the chosen one contains what production serves
(`git merge-base --is-ancestor`). `backup-bundles.sh` and `docs/GIT_HOSTING.md` 5C do both.

---

## 2026-09-29 — act fails a workflow when one of its jobs did not run

**Believed:** a GitHub workflow run under act (or under Forgejo's runner, which is built on
act) exits non-zero when one of its jobs never ran.

**Read in act's source** (`pkg/runner/runner.go` and `pkg/runner/run_context.go` on master,
2026-09-29; not yet run here, there is no runner): a matrix act cannot expand, such as
`fromJSON(needs.x.outputs.y)` with an empty output, is logged as `Error while get job's
matrix` and then runs zero times. A job whose `runs-on` label has no `-P` mapping is skipped
with one info line and no result. act's exit code counts only jobs whose result is
`failure`, so both runs exit 0. act also expands a matrix before it checks the job's
`needs`, so a matrix job whose needs were skipped logs that same error where GitHub just
skips the job. And act ignores `on.push.paths`.

**Do:** never read act's exit code alone. List the jobs first (`act -l`), require a result
line for each one (`jobResult` in `--json --verbose` output; skips are logged at debug
level), and accept a job with no result only when a job it needs was skipped.
`scripts/ci/act-job.sh` does this and proves it with `--self-test`.

---

## 2026-09-29 — `node --env-file` hands the program each value as written

**Believed:** a `NAME=value` file loaded with `node --env-file` gives the program everything
after the `=`.

**Measured:** on node 24.13.0, an unquoted `B=has#hash` loads as `has`: a `#` anywhere in an
unquoted value starts a comment, not only after a space. `E=with=equals==` and CRLF endings load
intact, and quoted values keep their `#`. For a backup passphrase the cut is silent and
permanent: every file is encrypted with the shortened passphrase, and the offline copy never
opens one. `scripts/ops/lib/env-file.mjs` now reads the ops env file itself, and the ops CLIs
warn when node's own flag was used.

**Do:** never feed a secret through `node --env-file` unquoted. Prove a stored passphrase by
decrypting with the offline copy typed in, not with the file that did the encrypting.

---

## 2026-09-29 — `bash` spawned from a Windows-native process is Git Bash

**Believed:** a node test that spawns `bash` gets Git Bash on this PC.

**Measured:** from PowerShell, `bash` resolves to
`%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`, the WSL launcher. It does not pass the
caller's environment through, so a gpg round-trip test there decrypted with an empty passphrase
and failed. `scripts/lib/redact-url.test.mjs` fails 4 of 18 from PowerShell and passes 18 of 18
from Git Bash, for the same reason.

**Do:** probe the property the test needs (does the child see an env var you set?) rather than
trusting the name, and on Windows try `C:\Program Files\Git\bin\bash.exe` first.

---

## 2026-09-29 — a gpg that fails writes nothing to stdout

**Believed:** gpg either produces its output or produces none.

**Measured:** gpg 2.4.9 (Git for Windows). With one byte of a symmetric file flipped,
`gpg --decrypt` wrote all 262,144 bytes of unauthenticated plaintext to stdout, then printed
"encrypted message has been manipulated" and exited 2. Separately, the MSYS gpg called from a
native process read `--homedir C:\...` (and `C:/...`) as a relative path, failed, exited 2, and
still wrote a full ciphertext to stdout.

**Do:** the exit status is the verdict, never the presence of output. From a native process,
hand MSYS tools their data on stdin, or `/c/...` paths.

---

## 2026-09-29 — renaming `origin` takes every branch's upstream with it, so a bare `git push` still goes to the old host

**Believed:** after `git remote rename origin github` and `git remote add origin <new host>`, a
plain `git push` or `git pull` talks to the new origin.

**Measured:** `git remote rename` rewrites `branch.<name>.remote` for every branch that tracked
the old name (git 2.53, throwaway clone). After the rename and the add,
`branch.mvp-launch.remote` was `github`, `git push --dry-run -v` printed `Pushing to` the old
URL, and `git status -sb` showed `mvp-launch...github/mvp-launch`. The old host is the one being
left, so the day it comes back, a bare push lands there and skips the primary.

**Do:** after a rename, set every `branch.*.remote` that names the old remote to `origin`, and
give the old remote an unusable `pushurl` so a push to it fails loudly. The rename also carries
every `pushurl` the remote had, so with two of them a plain `git config remote.<name>.pushurl <x>`
fails ("cannot overwrite multiple values", git 2.53, 2026-09-29); use `--replace-all`.
`scripts/git-hosting/set-remotes.sh` does all of this, and a mutant without the re-point goes red.

---

## 2026-09-29 — a GitLab link to a file the repo does not have does not 404

**Believed:** a link check that follows each source link and fails on a 404 catches a link
to a path the repo does not hold.

**Measured** (curl, 2026-09-29, against the public `gitlab.com/gitlab-org/gitlab`):
`/-/blob/master/does-not-exist.md` answers `302` to `/-/tree/master`, which answers `200`.
So a wrong path lands on the repo root and every HTTP check passes. A folder under
`/-/blob/` also answers `302`, to `/-/tree/`. These answers do not depend on the request
headers. `/-/issues` does: with `Accept: text/html` it answers `302` to `/-/work_items`;
without that header it answers `404`, even with a browser's user agent. So a script that
does not send `Accept: text/html` can see a different answer from a browser.

GitHub, where the links go today, does answer a missing path with `404` (measured 2026-09-30
on our repo; a folder under `/blob/` answers `301` to `/tree/`). So a status check that passes
against GitHub says nothing about the day the links fail over to GitLab.

**Do:** check a source link's path against `git ls-files`, never against the host's status
code. `frontend/src/test/sourceLinks.test.ts` does this for every literal path in the code
and for every link the pages that link source render.

---

## 2026-09-24 — MetaMask's SDK does not read through your wagmi transports, and `enableAnalytics: false` does not switch its analytics off

**Believed:** once the CSP allows every RPC host in the wagmi transports, a connected wallet
can read; RainbowKit's MetaMask row disables MetaMask's analytics; and a desktop probe
with the extension, which shows no SDK socket, clears the CSP for MetaMask everywhere.

**Measured** (RainbowKit 2.2.11, wagmi connectors 8.2.0, @metamask/connect-evm 2.1.1,
viem 2.56.5; Playwright Pixel 5 and iPhone 15 against a production build with the
vercel.json CSP injected):
- On a phone, and on desktop with the extension, the row uses wagmi's `metaMask()`. It
  hands the SDK `supportedNetworks` = each chain's `rpcUrls.default.http[0]`, and the SDK
  `fetch`es 33 methods straight there (reads such as eth_call, eth_estimateGas,
  eth_getTransactionCount and receipts, plus eth_sendRawTransaction), with no fallback to
  the wallet. viem's mainnet default
  is `https://ethereum.reth.rs/rpc` (it moves between viem versions). Refused by the CSP,
  mainnet reads threw `RPCErr52 ... Failed to fetch` while Base (default allowed) answered.
  WalletConnect differs: wagmi builds its rpcMap from the transports.
- A phone browser gets the SDK's relay transport: it opens `metamask://connect/mwp?...`,
  then a websocket to `wss://mm-sdk-relay.api.cx.metamask.io/connection/websocket`.
  Refused, WebKit drops the session to `disconnected` and throws
  `null is not an object (evaluating 'this._transport.close')`. Desktop with the extension
  uses a browser transport and never opens that socket.
- RainbowKit passes `enableAnalytics: false`, the old `@metamask/sdk` option. connect-evm
  v2 reads `analytics.enabled`, and wagmi spreads your parameters and then sets
  `analytics: { integrationType: 'wagmi' }`, so no config reaches it. It POSTs to
  `mm-sdk-analytics.api.cx.metamask.io`; refused, it retries on a backoff capped at 30s
  and logs `Sender: Failed to send batch` each time.

**Do:** allowlist what the SDK build contains, not what your config names: read `wss://`
and RPC URLs out of the shipped package and each chain's `rpcUrls.default`. To test a CSP
locally, `vite preview` sends no Vercel headers: inject it with Playwright
`route.fetch()` + `fulfill({ response, headers })` on document requests, with
`serviceWorkers: 'block'`. `route.abort()` a custom-scheme deep link (a 204 blanks the
page in WebKit). `globalThis.__METAMASK_CONNECT_MULTICHAIN_SINGLETON__` resolves to the
SDK core; `invokeMethod({ scope: 'eip155:1', request })` drives its read router with no
wallet present.

---

## 2026-09-24 — a CORS allowlist in a framework's user routes does not decide who can read

**Believed:** the indexer's `allowedOrigins` in `indexer/src/api/index.ts` is its CORS policy,
so removing a host there stops that host reading the indexer.

**Measured:** against the live indexer, `OPTIONS /graphql` from four origins (three on the list,
one invented) all answered `204` with `Access-Control-Allow-Origin: *`, and
`allow-methods: GET,HEAD,PUT,POST,DELETE,PATCH`. That is Hono's default method list, not the
`GET, POST, OPTIONS` the file sets, so a different layer answered. Ponder 0.8.33 mounts
`cors({ origin: "*" })` before user routes (`src/server/index.ts:94` in its source), and
Hono's cors answers OPTIONS without calling `next`. On `POST`, a listed origin was echoed by
name and an invented one kept `*`. Every response also carried `allow-credentials: true`,
which neither layer sets.

**Do:** before trusting a CORS change, send the preflight and compare the answered
`allow-methods` with the ones you configured. If they differ, your middleware never saw the
request.

---

## 2026-09-24 — a comment that names a guard is not a guard until the guard reads the file

**Believed:** `bot/src/config.test.js` said the bot's default origins were held to `SITE_URL`
by `frontend/src/lib/__tests__/canonicalHost.test.ts`, so the bot's documented defaults
could not drift from the code.

**Measured:** `canonicalHost.test.ts` has never read anything under `bot/`; its only "bot" is
a Twitterbot user agent. #478 (2026-09-12) moved the defaults in `bot/src/config.js` to
memetics.finance and wrote that pointer in the same commit, and `bot/.env.example` and
`bot/DEPLOY.md` went on naming memetic.fun as the default for twelve days. A second pointer,
in `bot/src/venueClient.js`, credited `venueClient.test.js` with the signing-parity proof
that the test's own header hands to `api/__tests__/bot-noncustodial.test.js`.

**Do:** when a comment says "X is pinned by Y", grep Y for X before relying on it or
repeating it. If Y does not read X, write the guard or drop the claim.

---

## 2026-09-22 — a `toContain('80°')` pin stays green on a page that says 180°

**Believed:** a test that asserts a threshold goes red when the page shows a different
threshold.

**Measured:** `'180°'.includes('80°')` is true (node), so an assertion written as
`toContain('80°')` passes against a page that reads 180°. Such a pin cannot fail on the one
value it exists to pin. The heat floor and band pins match a standalone number
(`(^|[^0-9])80°`) or the whole sentence instead.

**Do:** anchor a numeric assertion. Substring matching on a number is safe only while no
longer number contains it, which is a fact about the future value, not the present one. The
same shape hides 3 inside 13 and 30 inside 130.

---

## 2026-09-22 — a regex comment stripper turns one `//` line into a 93-line blind spot

**Believed:** a `prose()` helper that deletes comments before scanning source is a fair way
to ask "does the shipped text still say this".

**Measured:** `prose()` removes `/* ... */` with a regex. Line 4 of
`frontend/api/_lib/flames.js` is a `//` line that contains `/*`, so the strip ran from there
to the next `*/` on line 97 and the guard read nothing for 93 lines of real code. It was
passing against an empty string. The replacement reads strings and JSX text through the
TypeScript compiler instead of stripping text. Mutation check over 22 single-mutation runs:
9 mutations the old guard passed are red under the new one, the 8 it already caught stay
red, and 3 negative controls (the same sentence in a `//` comment, in a JSX comment, and
inside a URL string) stay green.

**Do:** a guard that answers "is this text shipped" has to parse, not strip. Prove it the
way a mutation proves a test: put the forbidden text in code and in a comment, and check the
guard goes red exactly once.

---

## 2026-09-22 — a fixed `webServer` port with `reuseExistingServer` makes the second checkout test the first one's build

**Believed:** two worktrees of one repo can run Playwright at the same time, because each
has its own `dist`.

**Measured:** `frontend/playwright.config.ts` sets `baseURL: 'http://localhost:4173'`,
`webServer.command: 'npx vite preview --port 4173'`, `port: 4173` and
`reuseExistingServer: !process.env.CI`. The second run finds 4173 already listening, does
not start its own preview, and drives every spec against the other worktree's build. It
reports a clean pass and names no tree. Five worktrees shared this box this session; each
run used an uncommitted `frontend/playwright.local.config.ts` with its own port, and none
went near 4173.

**Do:** when a runner can reuse a server, the port belongs to the checkout, not to the repo.
Give each worktree its own port in a local, uncommitted config, and do not trust a green
e2e run that could not say which build it loaded.

---

## 2026-09-22 — an exact-count pin over prose from a live read fails downward, and that is not a regression

**Believed:** `e2e/em-dash-zero.spec.ts` counts em dashes per route, so a red means someone
added one.

**Measured:** one run went red on four routes for counting FEWER than pinned: `/yield` 14 of
21, `/launch` 23 of 26, `/eth-curve` 14 of 15, `/curve-launch` 12 of 14, with no shipped
source changed in that pass. Those routes render prose out of live reads, so a failed read
or a loaded box renders less prose and the count drops. The spec's own failure message then
invites you to lower the pin. All four passed on retry, and the same command run again was
103 passed, 0 failed.

**Do:** read the direction before believing a count pin. Lowering it on a downward failure
writes a bad reading into the guard. A count over content the build does not contain wants
an upper bound plus a separate assertion that the section rendered at all.

---

## 2026-09-21 — to find everything a key controls, search the field that names the key

**The belief:** "which Streamflow pools does this key run?" can be answered by listing
the pools for the token and checking each one's authority. **It can't.** A search by the
BAYLA mint (`searchStakePools({ mint })`) found **2** stake pools administered by the
OneDrive faucet key. A search on the authority field itself — `getProgramAccounts` on the
stake program with a `memcmp` of the key at `StakePool.authority`, offset 74 — found **6**.
The other four were pools for other tokens (BOBO, SOY, RIZZ and one more). A mint search
can only find the mint you already thought to ask about. Each of the 6 stake pools also
had a reward pool, so the real answer was 12 accounts. All 12 were then handed to a new
admin in one transaction.

Take the offset from the program's IDL (the account's field order, plus 8 bytes of
discriminator), not from memory. Check it by confirming the matches decode as that
account type with that field set to the key. **A wrong offset returns an empty list,
which reads exactly like "this key controls nothing"** — measured: the same query for the
current admin returns 6 accounts at offset 74, and 0 at offsets 73 and 42.

### A simulated call's first error can be about a precondition, not your question

To learn whether the key could pull funds, a `clawback` was simulated with signature
checking off. It failed with `3012 AccountNotInitialized` on the `to` account — the
key's own token account for BAYLA did not exist. **That says nothing about whether
clawback is allowed**, only that the program never got as far as checking. Anyone can
create that account first, so the honest simulation creates it in the same transaction
and then claws back. That run reached the real check: `6015 ClawbackNotPossible` at
`clawback.rs:94`. Before reading "impossible" into a simulation error, confirm the error
names the thing you asked about. If it names a missing account, a wrong owner or a
blockhash, satisfy that and simulate again.

### `git fetch` never moves your local `mvp-launch`

A "what does my PR add" check over `mvp-launch..HEAD` reported **3,421** added lines for
a PR that adds **56**: in a worktree the local `mvp-launch` branch sat **48 commits**
behind `origin/mvp-launch` — one day's merges — so the range included trunk's own new
commits. `git fetch` updates `origin/mvp-launch` and leaves
the local branch where it was, so even "fetch first" doesn't fix a check that names the
local ref. Every range check — diff, scan, `git log` — should say `origin/mvp-launch`.

---

## 2026-09-20 — gitleaks checks every commit in a PR, so fixing a flagged value in a later commit does nothing

Found while fixing an ops CLI that printed its RPC URL, API key included, on every run
([#648](https://github.com/fomotsar-commits/tegridy-farms/pull/648),
[#646](https://github.com/fomotsar-commits/tegridy-farms/pull/646)).

**The belief:** if gitleaks flags a string in a PR, a follow-up commit that removes it
turns the check green. **It doesn't.** `gitleaks-action` scans the PR's whole **commit
range**, not the final tree, so the commit that added the string stays in range and the
check stays red. Measured on #646: a random-looking 32-character test fixture was flagged
as `generic-api-key` on entropy alone. It went green only after the branch was rewritten
so the string never entered history, then force-pushed.

What to do instead:

- **Make fixtures dull on purpose.** `FAKEKEYFAKEKEYFAKEKEYFAKEKEY0000` is the same length
  as a real key and exercises the same code, but has low entropy and says what it is.
  Shannon entropy in bits per character, computed with `-Σ p·log2 p`: the flagged random
  fixture **5.00** (gitleaks reported the same 5.0, so this is the number it uses),
  `0123456789abcdef` ×2 **4.00**, `FAKEKEY…0000` **2.50**, `deadbeef` ×4 **2.16**.
  Repeating a string does not lower its entropy; using fewer distinct characters does.
- **Don't add a `.gitleaks.toml` allowlist entry for a value you made up.** That allowlist
  applies to every rule, and the file itself says entries should get deleted, not added.
- **To rewrite without losing commit messages:** `git rebase <base> --exec '<fix> && git
  commit --amend --no-edit'`. Then check both ways — `git log -S` only looks at diffs, so
  also `git grep` the tree of every commit in the range.
- **Delete the safety tags afterwards.** A local tag that still points at a pre-rewrite
  commit keeps the string reachable, and this repo's origin does carry tags, so
  `push --tags` would ship it. Don't bundle the tag before deleting it, the usual habit
  with a ref: the bundle keeps exactly what the rewrite removed.
- **Check whether a value already passed the gate.** If a merged commit added it, the rule
  accepts it. The ladder program id (44-character base58, entropy 4.74, not allowlisted)
  came in through #579, so repeating it is safe.

The flip side: because it only scans new commits, gitleaks **cannot** see a secret that
was committed before the scanner existed. An Etherscan key committed in `9b59e212` is
still readable in this public repo's history, and the gitleaks check is green.

### A test that shows a vulnerable pattern by running it gets flagged for that pattern

A test was added to stop anyone reverting a URL check to a substring match. It contained
the substring match, to show that it passes on an attacker's URL. CodeQL flagged that line
as a new high-severity `js/incomplete-url-substring-sanitization` alert (#646, `:206`) — one
commit after the original instance was fixed. CodeQL reads the line, not the purpose.

Fix: describe the weak form in a comment; don't execute it. The test kept its teeth —
reverting the helper to a substring check still fails it (2 of 17 tests in
`scripts/lib/redact-url.test.mjs`, 5 of 14 in the `frontend/` copy). Unmeasured: whether
vitest's `expect(x).toContain(host)` form triggers the rule the way `x.includes(host)`
does. Nobody here has a CodeQL run on that form.

### The `\b` trap in the 2026-09-12 entry happened again — so don't build the regex at all

The 2026-09-12 entry below explains the mechanics: in a template literal `\b` is a
backspace character, not a word boundary, and writing a file through a shell heredoc can
eat a backslash, so `\\b` arrives as `\b`. It recommends `String.raw`. That entry existed,
and the trap still hit again here in a new form.

A check meant to find every place a script printed an endpoint built its regex out of the
variable names it had just found:

```js
const wanted = new RegExp(`\b(?:${idents.join('|')})\b`);   // written as \\b
```

It matched nothing, so it reported **zero** problems against four scripts that were
definitely printing a key.

The better fix is not to escape it correctly. It is to not build a regex at all: split the
expression into identifiers and look each one up in a `Set`.

```js
const mentions = (expr.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).some((t) => idents.has(t));
```

That is right for a second reason too. `$` is allowed in a JavaScript variable name and is
a special character in a regex, so a pattern built from names can be wrong however
carefully it is written. It also stops `rpc` matching inside `rpcTimeoutMs`.

Running the mutation check **first**, against the known-bad code, is what caught it.
Written after the fix, the check would have passed for a reason that looked right, and
guarded nothing.

### A mutation check that silently didn't happen looks exactly like a pass

To prove a test has teeth, you break the code on purpose and expect the test to fail. Here
one of those deliberate breaks was eaten by shell quoting, so the file didn't change — and
the suite reported **17 of 17 passing**. That result proved nothing, and it looked the same
as a real pass. Before believing it, grep for the line you broke and confirm it changed.

Re-run the mutation check after **deleting** an assertion too, not only after adding one.
Removing a line is exactly when a test can quietly stop proving anything.

### "Was the leaked key rotated?" can be answered without the ledger, and without seeing either key

`docs/SECRET_ROTATION.md`'s incident log was empty. That looks exactly like "never rotated",
and it could also mean "rotated, not written down". It can't tell you which.

Compare fingerprints instead: `sha256` the value in the old commit
(`git show '<commit>^:<path>' | grep … | sha256sum`) and the value configured today, and
compare the two digests. Neither key is printed. Measured on the Etherscan key: 34
characters in both, different digests, so it **was** replaced. That still doesn't say
whether the **old** key was revoked at the provider — that's a separate check.

### A vitest rooted at `frontend/` can import files above its root

`frontend/vitest.config.ts` stresses that nothing above `frontend/` can be **collected** as a
test. That's true, but it's easy to read as "nothing above `frontend/` can be used". A test
under `frontend/` importing `../../../scripts/lib/caller-credit.mjs` resolved and passed.
So one helper at repo-root `scripts/lib/` can serve both trees.

### An ignore file that starts with `*` and then `!dir/**` needs globs, not names

`.vercelignore` starts with `*`, then re-includes `!frontend` / `!frontend/**`. The last
matching line wins, so everything under `frontend/` is uploaded **unless a later line
excludes it**. It excluded `frontend/.env` and `frontend/.env.local` by name, so
`.env.production`, `.env.staging` and every other env file would have been uploaded with
their values by a repo-root `vercel --prod`. A test that applies the file's own rules to
ten env filenames found eight uploaded. Fixed with `frontend/.env*`.

## 2026-09-20 — a `waitFor` on a string that renders outside the async state is not a gate

`HeatCard.test.tsx` → `element D … paints the room's row FIRST and the whole flame
SECOND` went red on [#640](https://github.com/fomotsar-commits/tegridy-farms/pull/640),
a PR whose diff was **one markdown file**, and passed on a plain re-run:

```
AssertionError: the scoped number never rendered: expected -1 to be greater than -1
```

The test waited on the card's heading before reading `container.textContent`:

```ts
await waitFor(() => expect(screen.getByText(/Your held time in PEPE/i)).toBeTruthy());
const text = container.textContent ?? '';
const scoped = text.indexOf('338.21');           // -1 under load
```

That heading renders **outside** `state.kind === 'ready'` — on purpose, so a cold
room still names what it reads. It is on screen from the first frame, so the
`waitFor` returned on its **first poll**, with no relation to the read resolving.
The two strings it then compared live only in the ready branch.

### The rule

**The gate string and the asserted strings must come from the same render branch.**
A gate that renders unconditionally cannot tell you an async read has landed. When
you write `waitFor`, ask *which* branch prints the string you are waiting on — not
merely whether that string eventually shows up.

Corollary for `findBy*` / `waitFor` over `container.textContent`: waiting for
**each string you are about to index** is self-checking, because a string that only
exists post-read doubles as the read's own completion signal.

### `-1` from `indexOf` is a race tell, not a defect

An ordering assertion that fails `expected -1 to be greater than -1` has not caught
a mis-ordering — it never rendered the thing at all. Same family as
the repo's recurring "an unreadable value must not read as fine": the sentinel for *absent* got
compared as if it were a *position*. Ordering tests over `indexOf` should establish
presence inside the wait, then compare positions outside it, so the two failure
modes cannot be confused in the log.

### A negative assertion behind a false gate passes vacuously — forever

The sibling test, one function down, had the identical gate and was worse for it:

```ts
await waitFor(() => expect(screen.getByText(/Your held time in PEPE/i)).toBeTruthy());
expect(container.textContent).not.toMatch(/Where the .* comes from/i);
```

An **absence** is satisfied by an empty room. Mutating the component so `scopeTo`
stopped applying — the exact defect the test names — left it **green**, because the
gate returned before anything rendered. It never had a chance to fail. Unlike the
ordering test it did not flake, so nothing ever drew attention to it.

**Do:** whenever a test asserts `not.toMatch` / `not.toContain` / `queryBy… toBeNull`,
check what proves the DOM was *populated* at that moment. An absence assertion needs
a positive gate that the same render produced.

### Reproducing a CI-only async race locally: 250ms, not 0

`setTimeout(…, 0)` on the mock's resolve did **not** reproduce it — RTL's `waitFor`
runs inside React's async `act`, whose microtask flush drains a 0ms timer before the
callback's first poll. The suite stayed 59/59 green and the race looked unreproducible.

A **real** delay does it, deterministically:

```ts
h.fetchHeat.mockImplementation(
  () => new Promise((resolve) => setTimeout(() => resolve(wireReading({ … })), 250)),
);
```

250ms is far past any microtask flush and well inside `waitFor`'s 1000ms default, so
a *correctly* gated test still passes while a falsely gated one fails every run. This
turns "flaky on a loaded runner" into a deterministic local red — which is what makes
it mutation-checkable at all.

### Mutation-check the race and the defect *together*

The cell that matters is not "does the fix stop the flake" but **"does the fix still
catch the real defect on a slow runner"**:

| # | Mutation | Pre-fix | Post-fix |
|---|---|---|---|
| 2 | swap render order | RED (ordering) | RED (ordering) |
| 3 | read resolves 250ms late | **RED (`-1`)** | green |
| 4 | **2 + 3** | RED (`-1` — *wrong reason*) | **RED (ordering)** |
| 5 | `scopeTo` stops applying | RED | RED |
| 6 | **5 + 3** | **green — vacuous** | RED |

Cells 4 and 6 are the ones a "just make it wait longer" fix fails. A fix that made
the race disappear by loosening the assertion would show green in cell 4, and that
is indistinguishable from a fix that works — unless you run the defect mutation and
the race mutation *at the same time*.

## 2026-09-20 — a backgrounded build reads the worktree it finds, not the branch you launched it from

**Believed:** a long `npm run build && playwright test` started in the background is
pinned to the branch that was checked out when it started, so it is safe to switch
branches in the same worktree while it runs and come back for the result.

**Measured:** it is not. The build and the test run are ordinary processes reading
files off disk when they get to them, and a worktree has exactly one checkout. A
build launched on a branch carrying a new `vercel.json` alias, with `git checkout`
of a docs branch run a minute later, produced `dist/llms.txt` at **4,052 bytes** —
the *other* branch's output — where the correct build is **4,077**. Nothing warned;
the build exited 0 and the e2e run that followed would have reported a clean pass
for a tree nobody intended to test. The 25-byte difference was the only tell, and
only because that file's size was already known.

This is the same hazard as "your worktree is not private", with the sharp edge
pointed inward: the other session that moves your files can be *you*, one tool call
later. The e2e result is the dangerous half — a green run against the wrong tree
reads exactly like a green run against the right one.

**Do:** while a build or test is running, treat that worktree as owned by it —
no `checkout`, no `stash`, no rebase. Work that must happen meanwhile goes in a
second worktree, or waits. Cheap insurance when it matters: have the job print one
fact that identifies the tree it actually built (a byte count, a grep -c of the
change under test) as its first line of output, so a wrong-tree run announces
itself instead of passing quietly.

---

## 2026-09-19 — a grep of `dist/` proves a string is absent, never that a link is

**Believed:** to prove the site ships no community link, grep the built output for
`discord.gg` and `t.me/`. A clean grep means clean.

**Measured** on a full `npm run build` of trunk `34095814`. `discord.gg` really is absent
from every file in `dist/`. `t.me/` is not: `dist/assets/CurveTradePanel-*.js` contains
`function U(e){return` `` `https://t.me/${e}` `` `}`. That is
`telegramUrl()` from `src/lib/launcher/curveIdentity.ts:274` — a URL **builder** for a
launched token's own declared handle, read from that token's Arweave identity metadata and
rendered only when a token declares one. No venue handle ships, and the handle is filtered
by `cleanHandle()` first (`curveIdentity.ts:116`, and `cleanWebsite` accepts `https:` only),
so the grep hit is not a defect. But it is a hit, and "zero `t.me` strings" was the wrong
claim to make from a grep.

The inverse of the same mistake sits in the invite scanner that answer eleven built.
`shippedFiles()` (`scripts/lib/discord-invites.mjs`) picked files by directory and
extension, and so read `public/*.svg` but not `public/sample-collection.csv` — a file users
download from the upload wizard (`Step2_Upload.tsx:262`) — and read `scripts/llms-txt.mjs`
but not `scripts/addresses.json`, the ledger that script renders into `dist/llms.txt`. The
writer was scanned while one of its two text inputs was not. Both are now in the scan, each
mutation-checked red.

**Do:** when the question is "does this ship", grep to find candidates and then **read what
builds the string** — a template literal in a minified bundle is one identifier away from
looking like a link. And when choosing a scan's surface, include a file because its text
reaches a user, not because of the folder it lives in: the inputs to a generator ship just
as surely as the generator does.

---

## 2026-09-18 — two copies of one poller under fake timers never overlap, so neither is ever stale

**Believed:** mounting a polling hook twice in one jsdom window (two `renderHook`s sharing
its localStorage) and advancing fake timers is a fair two-tab test. Both intervals are due
at the same instant, so each copy acts on what it read before the other one wrote.

**Measured** while writing the cross-tab test for `useLimitOrders` (PR #629), with the RPC
mocks resolving immediately. `vi.advanceTimersByTimeAsync` runs due timers one at a time and
drains the microtask queue between callbacks. Tab A's whole interval callback (price read,
lock claim, send, receipt, mark filled, lock released) therefore finished before tab B's
callback started, although B was due in the same millisecond. On the old hook the first poll
fired one order **twice**: B acted on the lock A had just released. With the fix, B re-read
storage right after A's write and was never stale when it wrote. As a result, the test built
to catch a stale tab's whole-list save ("creating an order in a stale tab does not put a
filled order back to active") **passed with `createOrder` reverted to exactly that save**,
the mutant it existed to kill.

**Do:** mount the second copy half an interval later (`renderHook`, then
`advanceTimersByTimeAsync(interval / 2)`, then `renderHook`). Each step is then one copy's
check (A, B, A, B), and between a check of A's and B's next one, B holds whatever it last
read. With that stagger the same test failed on the mutant, as intended. Run the mutant
against the staggered version to prove the window exists. Separately, jsdom fires no
`storage` event for a write in the same window. Two mounted hooks never hear each other,
which is the right worst case for a guard, but a `storage` listener then needs its own test
that dispatches the event by hand.

---

## 2026-09-18 — a record saved before the wallet answers cannot know its on-chain index, and a OneDrive file is not a file to `Dirent.isFile()`

### The chain numbers only what lands

**Believed:** a contract that assigns an index on push (`commitIndex = list.length`, then
push) gives this browser's Nth commit index N-1, so the client can save the index along
with the salt. The source said so in a comment ("index ≈ current length") and promised a
reconciliation ("we'll reconcile by reading `voterCommits.length` on next refetch") that no
code ever carried out.

**Measured** (PR #628) against a model of exactly the checks the contract's reveal makes:
index in range, not revealed, hash at THAT index. Commit, reject it in the wallet, then
commit again and let the second one land. The page offered two reveals and the model
rejected both: `['CommitHashMismatch', 'CommitNotFound']`. The rejected commit's record
took index 0, so the real commit was saved at index 1 while the chain holds it at 0. A
commit made from another browser, or a cleared list, shifts the numbering the same way.

**Do:** persist the content (salt, pair, power, hash), never an identifier the chain has
not assigned yet. Resolve the identifier by matching the content against the chain
(`voterCommitCount`, then every `voterCommits(i)`, and match on the hash), and offer nothing
while any slot is unread, since an unread slot may be the one the record lives at. Keep
every saved record: a record whose commit has not landed can mean still pending,
rejected, or reverted, and the chain cannot tell those apart until the commit window
closes (the same rule as #616, from the other side).

### A OneDrive placeholder is a symlink to Node

**Believed:** two docs-honesty tests going red locally with "FAQ.md is not being scanned"
meant a scanner or path regression.

**Measured** in a worktree under OneDrive: `Get-Item FAQ.md` reported
`Archive, ReparsePoint`, and `fs.readdirSync(root, { withFileTypes: true })` returned it
with `isFile() === false`, `isSymbolicLink() === true`. `ROADMAP.md` was the same;
`README.md` and `CONTRACTS.md` in the same directory were plain files. Both scanners keep
`e.isFile()` entries only, so they dropped exactly those two files. A Linux CI checkout has
no reparse points, so CI stays green. The scanners' must-scan lists are what turned a silent
skip into a loud red.

**Do:** before trusting a local red from a test that enumerates files, check the attributes
of the files it names. A scanner that must not miss a file should `statSync` the entry,
which follows the link, rather than trust the dirent type; and it should carry a must-scan
list, as these do.

---

## 2026-09-18 — a deploy receipt's CREATE transactions are not the list of contracts it created

**Believed:** the top-level `transactions[]` of a Foundry broadcast receipt
(`contracts/broadcast/<Script>.s.sol/<chainId>/run-*.json`) whose `transactionType` is `CREATE`
or `CREATE2` list every contract the run deployed. A registry guard that walks them would then
have a closed world.

**Measured** (newest receipts on trunk `f0e3ca7b` + PR #614, fixed in PR #626): a contract
created *inside* a transaction never appears as a top-level CREATE. Foundry lists it under that
transaction's `additionalContracts` (`transactionType`, `contractName`, `address`, `initCode`),
whatever the parent's own type is. There were 6 on mainnet and 4 on Base. Five of the six
mainnet ones had no registry row, and two of those were **live**: the clone templates that the
TegridyLaunchpadV2 and TegridyNFTPoolFactory constructors deploy and expose as immutable
`dropTemplate()` / `poolImplementation()`, which every clone DELEGATECALLs. On Base, the four
role Safes from `createProxyWithNonce` were the chain's **only** creations, so the guard printed
"read ZERO Base CREATEs". That reads as "no receipts". The receipts were there; the guard had
not read them.

### Where nested creations come from

- A constructor that deploys a helper (`dropTemplate = address(new TegridyDropV2())`) nests it
  under the parent's CREATE.
- A factory call (`createPair`, `createProxyWithNonce`) nests it under a CALL.
- `contractName` is `null` when Foundry has no artifact for the created code. That was all four
  Safe proxies, so a scan keyed on names would drop them too.

### A nested address cannot be keyed by (from, nonce)

#614 re-derives each top-level CREATE from its sender and nonce, because a receipt's labels can
be wrong. That does not carry over. A CALL child's creator nonce lives in the creator's on-chain
history, and a CREATE2 salt lives in the call's arguments. The one derivable case is a
constructor's children: a contract's nonce starts at 1 (EIP-161), so its first child is
`getContractAddress({ from: parent, nonce: 1n })`. That held for all four here. For anything
else, read the chain: each parent's getter returned its child's address.

### A non-zero exit is not a killed mutant

Two of my own mutations of the "unreadable nested entry fails" branch misled me. The first
changed only the `fail(...)` message and left the call in place, so the self-test stayed green,
correctly, and looked like a missing test. The second turned `fail(` into `void (` in front of a
trailing comma. `void (x,)` is a **syntax error**, so the verifier and the self-test both exited
1 without printing a single FAIL line, and that looked like a kill. A mutant is killed only when
the run prints the assertion you expected it to trip.

---

## 2026-09-18 — a bare `vite build` ships every derived-image URL and none of the images

**Believed:** `vite build` is the build, and `npm run build` only wraps it in checks.

**Measured** in a fresh worktree of trunk `c446ac67`, where `frontend/public/_derived/` does not
exist because it is gitignored: `npx vite build` exits 0. The shipped JS still computes
every `srcset` from `src/lib/artDerivatives.generated.json`, which IS committed, so the page
asks for images that were never generated. The nav logo is the first casualty: its 128 px
candidate, `/_derived/art/island-mark-png-128.webp`, is in no output directory. Served by
`vite preview`, that URL answered **200 `text/html`** (the SPA fallback handing back the app
shell), not a 404. Jungle Bay Island's answer eleven reported a 404 for it; its answer
twelve withdrew that — the island saw the broken-image glyph and inferred the code without
reading the status. So there is one reading, not two, and it is the 200: the failure nothing
that checks status codes notices. Re-measured 2026-09-19 on a full `npm run build` of trunk
`34095814`: the real derivative answers `200 image/webp`, while any missing asset path
(`/_derived/...`, `/assets/...`, `/art/...`) answers `200 text/html`.

`npm run build` avoids it only by order: `generate-image-derivatives.mjs` runs first, and
`verify-dist-derivatives.mjs` runs last. Pointed at the bare build, that gate exits 1 and
lists all 1,314 advertised candidates as missing, so it is the check that knows. Its header
records the production outage this shape has already caused once (20 of 27 homepage
images, when the generator ran as a skipped `prebuild` hook). Production builds with the
full chain, so production is fine.

**Do:** build with `npm run build`, never `vite build` alone, for anything that will be
looked at: a preview, a probe, a reviewer's box. If a build has to be hand-rolled, run
`node scripts/generate-image-derivatives.mjs` before it and
`node scripts/verify-dist-derivatives.mjs` after it.

---

## 2026-09-17 — a replaced transaction's receipt wait resolves, and a speed-up looks exactly like a cancel

**Believed:** when a wallet cancels or speeds up a pending transaction, viem's
`waitForTransactionReceipt` throws `TransactionReplacedError` (ethers did), so a success
receipt means your transaction ran. And if it does resolve instead, checking
`receipt.transactionHash === hash` is the fix.

**Measured** against @wagmi/core 3.6.5 / viem 2.56.5, driving the real action and the real
`useWaitForTransactionReceipt` hook through a scripted EIP-1193 node: the submitted hash has
no receipt, `eth_getTransactionByHash` still returns it pending, and the next block holds a
same-sender, same-nonce transaction whose receipt is success. All three reasons (`cancelled`,
`repriced`, `replaced`) RESOLVE the wait with the replacement's receipt: `status: 'success'`,
the replacement's hash. Nothing throws. viem 2 does not define `TransactionReplacedError` at
all. The reason arrives only through `onReplaced`, which wagmi's hook forwards to the action
and leaves out of its query key.

A wallet cancel is a 0-value send to yourself, so its receipt is a success, and every surface
that read `isSuccess` confirmed the action that was cancelled.

### The hash check is wrong the other way

A speed-up (same to, value and calldata, more gas) resolves exactly like a cancel: another
hash, a success receipt. It is the same call, and it ran. Calling it "did not happen" invites
a resend that pays twice, and speed-up is the most common replacement there is. Nothing in
the receipt tells the two apart; only `onReplaced`'s reason does.

**Do:** pass `onReplaced` on every wait and record the reason per submitted hash. Count a
foreign receipt as success only when the reason is `repriced`. With no recorded reason, say
you can't tell, and never "it did not happen". Bind any proof or stored record to the hash
that mined, not the one you submitted: a proof link to a hash that was sped up points at a
transaction that never mined. (PR #622.)

---

## 2026-09-17 — `git log -G` dates code by its first *mention*, comments included

**Believed:** the oldest commit that `git log --all --reflog -G '<call>' -- <file>` returns
is the commit that introduced the call.

**Measured:** while re-verifying `MICROSCOPE_REMEDIATION_2026_05_01.md` (#620), row H5
("restaking calls `staking.kick(tokenId)` first") was checked this way.
`-G 'staking\.kick\('` on `TegridyRestaking.sol` put the oldest hit at `f9a3656b`
(2026-05-02). That commit only adds a *comment* that mentions `staking.kick(tokenId)`. The
first real call, `try staking.kick(info.tokenId) {} catch {}`, landed in `86b69f70` on
2026-05-16, two weeks later. `-G` greps every changed diff line, comments and NatSpec
included, and this repo's comments routinely name the fix they anticipate.

The same trap works in reverse. `_jsonEscape` appears in history only inside a comment
saying it was removed; no commit ever defined it.

**Do:**

- Treat the first `-G` hit as a lead, then open its diff.
- When the question is "did this code ever exist, and when", anchor the pattern on code
  shape (`-G 'try staking\.kick\(info'`) rather than on a name.
- For a negative claim, extract the function body from every historical version and grep
  it with comments stripped: `git log --all --reflog --format=%H -- <path>`, then
  `git show <sha>:<path>`, then a brace-matcher. That disproved H4's "the transfer path
  decays" across all 124 versions of `_settleRewardsOnTransfer`, where a name grep could
  only have said "no hits".

---

## 2026-09-17 — viem returns the revert that wagmi throws, and a receipt waiter outlives the component that started it

**Believed:** a `catch` around a receipt wait means the transaction failed; and a hook that
settles its own state when the receipt arrives keeps that state right, because the wait
lives in the hook.

**Measured** on the DCA and limit-order keepers and three create flows (PR #618), against
the installed viem 2.56.5 source and pre-fix vitest runs. Both were wrong.

### Same function name, opposite contract

`useWaitForTransactionReceipt` (wagmi) THROWS on a reverted receipt, so its `isError` is two
facts. `publicClient.waitForTransactionReceipt` (viem, called directly) RETURNS the reverted
receipt; its promise rejects only when no receipt could be read (180s default timeout,
`TransactionReceiptNotFoundError`, transport). So in a `publicClient` catch nothing at all is
known about the transaction. Five sites called that catch a failure. Two were keepers that
then released the schedule or order; one unread receipt produced a second swap on every
poll (3 in 3 polls, measured).

**Do:** in a `publicClient` wait, the `status !== 'success'` branch is the revert and the
catch is "unread". Decide per site what state is safe while unread, and never let it mean
"try again automatically".

### Settling state after an await: unmounted means never

viem waits up to 180 seconds. A user who leaves the page in that time unmounts the hook, and
a functional `setState` on an unmounted component is dropped without running, including any
`localStorage` write placed inside the updater. The DCA hook's success path saved that way,
so a swap that landed was never recorded, and the next mount found the schedule due again.
A vitest that unmounts before rejecting the wait reproduces it.

**Do:** record the in-flight hash when the wallet returns it, and write it through storage
first, then apply the same change to state by id. Settle keyed on that hash, so the old
waiter coming back after a re-read (or a second tab) cannot count it twice.

---

## 2026-09-17 — a registry section the verifier never iterates is unchecked, whatever `expect` it carries

**Believed:** a registry row that carries `expect: { type: "contract" }` is asserted. The
verifier runs offline on every push and `--onchain` daily, both are green, and the fix for a
missed section is to add its name to the loops.

**Measured** (PR #614; the pre-fix mutation was run first, on trunk's verifier). Every check
walked `reg.solana` and `reg.ethereum` by name. In a `base` row, each of these exited 0: a
truncated address, a non-address, two rows on one address, `expect.type: "contarct"`, a deleted
`role`. A new top-level `"arbitrum"` array holding `0xdead…beef` also exited 0. The 31 rows in
`base` and `robinhood`, 10 of them with `expect` blocks, had never been read by anything. The
green was real. It covered fewer rows than the file holds.

Adding the names to the loops got two things wrong. Both showed up only once the rows were
actually read:

- **A uniqueness check keyed on the raw value false-positives across scopes.** A CREATE address
  depends only on (deployer, nonce). So `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3` is three
  different contracts on chains 1, 8453 and 4663, and CREATE2 twins repeat by design. Keyed by
  (chain, address), the widened check found 9 real duplicates: the same L2 Safe registered in
  `base` or `robinhood` and again as an `ethereum` row with `chainId: [8453, 4663]`. Folding the
  copies together turned up two statuses that said "nonce()==0 everywhere". On Base the nonces
  were 5 and 1.
- **Reading a section can still mean skipping it.** `mainnet.base.org` answered batches of 5 and
  10 `eth_getCode` calls. A batch of 16 got back a single
  `-32014 maximum 10 calls in 1 batch` object. With 20 Base pairs in the read, every Base row came
  back NOT CHECKED. That was correctly UNKNOWN rather than ABSENT, and exactly as inert as never
  reading them. The old read held only 4 Base pairs, so it never hit the cap. CI reports 20 of 127
  skipped as a *partial* warning, so the job stays green.

**Do:** when a checker names the sections it reads, close the set. Fail on any top-level key it
does not handle, so the next section added fails loudly instead of passing silently. Key
uniqueness by the scope it must hold in (here, the chain), not by the raw value. After widening a
read, check the NOT CHECKED count *for the new scope*, not the total.

---

## 2026-09-17 — a ledger row that holds on trunk today can still be false: read it at the ledger's own commit

**Believed:** a remediation ledger row saying "Closed" can be checked against today's
trunk. If the property it names holds on trunk, the row is right.

**Measured** re-checking the staking and LP Medium rows of
`.audit_101/MICROSCOPE_REMEDIATION_2026_05_01.md` (#608). Three rows each described a
specific change. None of those changes exists on any ref, reflog or stash, and a trunk-only
check passes two of the three rows anyway:

| Row | Ledger's closure | At the ledger's own commit `7e7a4a15` | Trunk today |
|---|---|---|---|
| M-S1 | `emergencyWithdrawPosition` gains `updateReward` | still open | holds, via a different fix (`d6b1f5b1`, next day) |
| M-S5 | `notifyRewardAmount` drops its `duration` argument | still open | holds, via a different fix (`f89c97a7`, next day) |
| M-S7 | floor division becomes ceiling division | still open | still open |

The ledger was committed at 23:31 the night before the fixes that actually closed M-S1 and
M-S5 landed. "The property holds today" gets two rows right while their descriptions stay
fiction. A later session trusting the M-S1 row would then believe `updateReward` guards the
path. It doesn't: three other pieces do, and the committed suite doesn't see them. With all
three reverted, all 554 tests in the 16 suites that deploy and pause staking still pass.

**Do:** check a "Closed" row at three points, not one:
1. **The ledger's own commit:** `git show <ledger-commit>:<file>`. Was the row true when written?
2. **All history:** `git log --all --reflog -G '<pattern>'`. Did the described change ever exist?
3. **Trunk and the deployed build:** does the property hold now, and *by what*?

If (3) holds by a different mechanism than the row names, rewrite the row. The mechanism is the
thing the next reader will rely on.

### A commit message's "no code change" is a claim too

`d6b1f5b1`'s message says DS2-04 "documented the pause-aware accumulator design choice in
NatSpec; no code change". Its diff adds the `&& !paused()` guard, a pre-pause
`_accumulateRewards()` call and the `unpause()` reset: the three lines that actually close M-S1.
Read `git show <c> -- <file>`, not `git show -s`.

### `git log -G` is always an extended regex

`git log -G 'notifyRewardAmount\(uint256 [a-z_]+, *uint256'` matched three commits. Under a
basic regex, `\(` would open a group that never closes, which is an error, and `+` would be a
literal plus sign. So `-G` parses the pattern as an extended regex whether or not `-E` is given,
and `\(` there is a literal parenthesis.

### Under via_ir, `vm.warp(block.timestamp + dt)` can reuse a stale timestamp

A test body that called `vm.warp(block.timestamp + ...)` three times paid out exactly the
pre-unpause share and zero for the day after unpause. That is only possible if the last warp
landed at or before the unpause timestamp, i.e. that `block.timestamp` read returned an earlier
value. The same test paid the exact expected amount once every warp went through a storage
clock seeded from a literal (`uint256 t = 1_000_000;` then `t += dt; vm.warp(t);`), which never
reads `block.timestamp`. The failure was a plausible number, not a revert. Seed the clock from a
literal, not from a local copy of `block.timestamp`, or read time with
`vm.getBlockTimestamp()`, which several suites here already do.

---

## 2026-09-17 — a rule moved into a tested helper is not pinned where it is called

**Believed:** once an honesty rule is a pure, well-tested function, a page that calls it
is covered. If someone put the page's old inline logic back, the helper's tests would
catch it.

**Measured** while porting `verdictFromReads` (#597), the rule that keeps "couldn't read
the locker" apart from "this token hasn't graduated". It has 6 unit tests, and 6 mutations
of the helper's body were each killed. Then the *caller* was restored verbatim to its
pre-fix form: `LaunchPage.tsx`'s inline `if (!stream) → 'not-graduated'`, with the helper
left intact. **All 31 tests in the helper's file stayed green.** Only a source-level pin on
the call site (`launchReattestVerdictWiring.test.ts`) went red. A helper test proves the
rule exists. It says nothing about whether anyone calls it.

**Do:** make "restore the caller verbatim" its own mutation, separate from mutating the
helper. When the caller can't be rendered cheaply (an unexported component, or a path
that needs a connected wallet), pin the call site in source, as
`launchPriceWiring.test.ts` does. Strip comments before matching, so prose about the old
bug can't satisfy the pin.

### Incidental: an "unknown" message can make the opposite claim

The rescued copy for the new unknown state said the gap "says nothing about this token",
then ended with "the fee split committed at launch is unaffected and still on-chain". That
asserts a launch split exists for whatever address was pasted, including tokens that
never came through the rail. Fixing a false *negative* claim is exactly when a false
*positive* one slips in. Check both directions: does an unknown state avoid the negative
claim, and does it avoid asserting anything positive about the input?

---

## 2026-09-17 — wagmi reports a revert as an ERROR, so `isError` is two facts that need opposite advice

**Believed:** `useWaitForTransactionReceipt()` hands back a reverted transaction the way the
JSON-RPC does, as a receipt on `data` with `status: 'reverted'` and `isSuccess: true`, and
`isError` means the receipt could not be read. Every money hook here was written to that:
revert branches keyed off `isSuccess && data.status !== 'success'`, and `isError` toasted
"Transaction failed". A unit suite mocked exactly that shape and stayed green.

**Measured** by driving the installed `@wagmi/core` 3.6.5 `waitForTransactionReceipt` against
a local anvil through a switchable JSON-RPC proxy (one scratch script, each case a real
mined transaction):

| Real outcome | What the action throws |
|---|---|
| revert | `CallExecutionError` → `ExecutionRevertedError` |
| revert, state changed afterwards | `CallExecutionError` (the replay is pinned to the tx's own block) |
| revert, replay `eth_call` slower than 10s | bare `Error('unknown reason')` |
| success, `eth_getTransactionReceipt` → `{result: null}` | `TransactionReceiptNotFoundError` |
| **revert**, `eth_getTransactionReceipt` → `{result: null}` | `TransactionReceiptNotFoundError` |
| success, receipt/tx reads HTTP 500 | `HttpRequestError` |
| revert, `getTransaction` 500s during the replay | `HttpRequestError` |
| node unreachable, or 429 on every call | nothing: **never errors**, loads forever |

On `status === 'reverted'` wagmi does not return the receipt. It replays the transaction with
viem's `call` to recover a reason and **throws**. So no revert ever reaches `isSuccess`, and
every revert branch keyed off it was unreachable code. A real revert went down the `isError`
path and said "Transaction failed" (or, in `useSwap`, nothing, with the in-flight latch left
set). The unit mock encoded the wrong belief, so it could not notice.

Three consequences that transfer to any wagmi app:

1. **Split `isError` by error type, and default to "unreadable".** A `CallExecutionError`
   can only come from wagmi's revert branch, because viem's receipt waiter never calls
   `call`. Everything else is "we could not read it". That includes the bare `Error` in
   row 3: it also comes from the revert branch, but a bare `Error` is a shape anything can
   throw. The default matters because the two mistakes are not symmetric: calling an
   unreadable success "reverted, try again" makes the user pay twice, while calling a
   revert "unconfirmed, check the explorer" costs them one click.
2. **"Unreadable" copy must not guess the outcome.** Rows 3, 5 and 7 are real reverts that
   land on the unreadable side. "It may well have succeeded" is false for them. The honest
   sentence is "we can't tell whether it went through; check before you resend".
3. **An outage is not an error at all.** With wagmi's default `timeout: 0`, a node that is
   simply down never rejects: the hook sits in `isLoading` forever. Any UX that waits for
   `isError` to release a spinner or a latch waits forever.

**Do:** pin the library's error shapes with a test that runs the REAL action against a
scripted EIP-1193 provider (`custom({ request })`, `retryCount: 0`, `pollingInterval: 20`
runs a whole receipt wait in ~16ms), not a hand-built mock of the hook. A mock of the hook
repeats whatever the author believed. Then pin the hooks against both shapes.

### A ref latch leaves the button enabled, so `toBeEnabled` cannot see a dead CTA

`useSwap` guards `executeSwap` with `isPendingRef`. Left set, it does not re-render, so the
Swap button stays enabled and every click returns at the guard's line. The rescued e2e leg
asserted `toBeEnabled()` after the fault, and that passes on the broken code. **Do:** assert
the click reaches the chain. Read the fork's send count before the click, click, and poll
for it to grow. In unit form, call the action twice and count `writeContract` calls.

---

## 2026-09-17 — `gh`'s `--json files` stops at 100 files, and says nothing

**Believed:** a sibling-PR check ("does any open PR touch the files I touched?") is one
query: `gh pr list --json number,files`, filtered on your paths. An empty result means no
overlap.

**Measured** (gh 2.92.0, PR #591 in this repo): `changedFiles` is **113**, and `.files` has
**100** entries, from both `gh pr view 591 --json files` and `gh pr list --json files`.
There is no warning, no truncation marker and no flag to page it. `frontend/src/pages/TradePage.tsx`
was one of the 13 dropped, so an open-PR filter for that path came back **empty** while
#591 changes it. `gh pr diff 591 --name-only` listed all 113, and the REST endpoint
`pulls/591/files?per_page=100&page=2` returned the missing 13.

The PRs this hides are the big ones, which are the likeliest to overlap with you.

**Do:** treat `.files` as a sample whenever it is shorter than `changedFiles`, and re-read
those PRs in full:

```bash
gh pr list --state open --limit 100 --json number,changedFiles,files \
  --jq '.[] | select(.changedFiles > (.files|length)) | .number' |
  while read -r n; do gh pr diff "$n" --name-only | sed "s/^/#$n /"; done
```

---

## 2026-09-17 — "element(s) not found" on `getByRole(role, { name })` does not say which half failed

**Believed:** when `getByRole('dialog', { name: /select token/i })` fails with
`element(s) not found`, the dialog did not open.

**Measured** while mutation-checking an a11y test (a dist copy with the dialog's
`aria-labelledby` pointed at an id nothing renders): the failure text was identical to a
dialog that never opened. The dialog **was** open. The locator matches role and name
together, so an unnamed dialog is "not found" too. A mutant that fails for the wrong reason
proves nothing about the assertion it was aimed at.

**Do:** read `error-context.md` in the test's output directory before trusting the
reason. Its page snapshot prints a named node as `- dialog "Select Token":` and an unnamed one as
`- dialog:`. Here it showed `- dialog:` directly above `- heading "Select Token"`: open,
titled, unlabelled. That settles it in one grep, with no rerun.

---

## 2026-09-17 — a Foundry broadcast's `hash` can belong to a different transaction of the same run

**Believed:** in `contracts/broadcast/<Script>.s.sol/<chainId>/run-*.json`, `transactions[i].hash`
is the hash of `transactions[i]`. If that hash exists on chain, succeeded, and sits in the
recorded block, the entry is proven.

**Measured** while verifying receipts rescued from abandoned branches (PR #598). For every
entry I fetched the on-chain tx at the same `(from, nonce)`, choosing only among the file's own
recorded hashes, then compared `to`, the full calldata and the created address:

- `DeployBaseMVP.s.sol/8453` (14 txs, all in one Base block): **10 of 14 entries carry the hash
  of a different entry.** The *set* of hashes is exact. Each entry's nonce, calldata and
  `contractAddress` are exact. `receipts[]` is internally consistent: each receipt's fields
  belong to its own `transactionHash`. Only the `transactions[i].hash` pairing is wrong. The file
  says TegridyFactory was created by the tx that actually called `setSequencerFeed`.
- `DeployRoleSafes.s.sol/8453`, already on trunk: 3 of 4 wrong.
- Mainnet runs from the same deployer (1, 2, 5 and 5 txs): all correct.
- Blockscout's explorer index gave the same pairing independently.

Every mislabelled hash passes the "exists, status 1, right block" check. That check therefore
cannot catch it; only comparing the tx *content* can. The cause was not established (forge
version, concurrent sends on 2-second blocks?). Do not write it down as known.

Two traps on the verification path, measured the same day:

- `ethereum-rpc.publicnode.com` answers `eth_getTransactionByHash` / `eth_getTransactionReceipt`
  for June-2026 mainnet txs with HTTP 200 and `"result": null`. `eth.drpc.org` and
  `eth-mainnet.public.blastapi.io` return those same txs. A null looks exactly like "this hash was
  never mined".
- An Etherscan v2 free key gets `NOTOK "Free API access is not supported for this chain"` for
  `chainid=8453`. `https://base.blockscout.com/api/v2/transactions/<hash>` is keyless and returns
  status, block, nonce, `created_contract` and the decoded method.

**Do:** key broadcast entries by `(from, nonce)`, never by `hash`. When the question is "which tx
created X", take the answer from the chain (the receipt at that nonce) or from an explorer's
creation index, not from the JSON. Treat a null tx lookup as UNKNOWN until a second provider
agrees.

---

## 2026-09-17 — mutate an effect's condition without its deps and the mutated line never runs

**Believed:** to prove a test pins an effect's gate, swap the flag in its condition
(`if (!isSuccess …)` → `if (!isReceiptFetched …)`) and watch the test go red. If it
stays green, the test is missing a case.

**Measured** in PR #613's mutation rig, on the success-toast effects in PoolCard
(AMMSection) and OwnerAdminPanelV2. The condition-only swap SURVIVED both revert tests
(5/5 and 4/4 green), and the tests were fine. The deps still read `[isSuccess, txHash]`.
A reverted receipt sets the fetched flag but leaves the derived `isSuccess` false and the
hash unchanged, so React never re-ran the effect and the mutated condition was never
evaluated. Swapping the deps too, `[isReceiptFetched, txHash]`, which is how the
regression would actually be written, killed both, each by its own revert test.

eslint tells the two mutants apart. On AMMSection the condition-only one raised
`react-hooks/exhaustive-deps` ("missing dependency: 'poolTxReceiptFetched'"): 8 warnings
against trunk's 7. The faithful one was lint-clean at 7.

**Do:** mutate an effect's condition and its deps together. Before you believe a
survivor, lint the mutant: an `exhaustive-deps` warning on it means the mutant was not
faithful and the survival proves nothing.

---

## 2026-09-17 — a value handed across a Suspense render is gone if the render that took it is thrown away

**Believed:** carrying a value from pre-React markup into a lazily loaded component is a
module variable plus `useState(() => takeDraft())`, where take reads and clears; a unit
test that the store hands the value over proves the handoff; and an e2e that aborts the
entry chunk covers the seconds before the app loads.

**Measured** on a production build of the venue's static first frame (answer ten, PR #591),
with chunks held by a Playwright route handler and released by hand. All three were wrong,
and the store's own unit test was green the whole time.

### A render thrown away by Suspense runs your initializer again

An address typed into React's fallback was in the store, and the real field mounted empty,
every run. The home page's first render suspends on a sibling lazy chunk, React discards
that render with its state, and the retry's initializer ran again and found the store
already cleared. Reproduced in vitest by rendering the component beside a child that throws
a promise once: red with the take in the initializer, green with a peek in render and the
clear in `useEffect`.

**Do:** in render, only read (repeatable); consume in an effect, which runs only for a render
that committed. Test a handoff through a boundary that really suspends, not through the store.

### DOMContentLoaded waits for module scripts; `readyState === 'interactive'` does not

A classic script in `<head>` deferred its wiring of the static form to `DOMContentLoaded` so
the body markup would exist. On the phone throttle (150 ms RTT, 1.6 Mbps, CPU 4x) the markup
painted at about 0.7 s and `DOMContentLoaded` fired only after the entry module graph had run,
about 7.5 s. With the entry chunk held, the listener never ran at all. A `readystatechange`
listener that acts once `readyState !== 'loading'` wired the form while the chunk was still
held: readiness turns interactive when parsing ends, before deferred and module scripts run.

### Chromium fires `blur` on a focused node as it is removed, while it is still connected

Focus an input, then remove it with `replaceChildren`. Chromium dispatched `blur`
synchronously with `isConnected === true` and `document.activeElement` already moved; WebKit
dispatched no `blur` at all. So at event time a blur handler cannot tell "React swapped this
field out" from "the visitor tapped away". What worked: decide one microtask later and check
`isConnected` then. React's commit, including the replacement field's layout effect, finishes
before any microtask runs.

### An aborted chunk proves the no-script path, not the slow-script path

`route.abort()` on the entry chunk tested the static form's plain GET and could not see any
of the three defects above, which only exist while the markup is on screen and the app is on
its way. Holding the request (`await gate; await route.continue()`) and releasing it by hand
showed all three. Two traps in that harness: `page.waitForURL` waits for `load` by default,
which a page whose entry chunk is held never reaches (use `waitUntil: 'commit'`); and a
`page.goto` that must not wait for scripts needs `waitUntil: 'commit'` too.

### On Windows, stopping the shell that ran `npx vite preview` leaves node serving

Killing the backgrounded Git Bash shell left its `node.exe` child running; four previews
survived that way. The survivor holds `lightningcss.win32-x64-msvc.node` open, and the next
`npm ci` failed EPERM on that file after it had already deleted most of `node_modules`. Find
them by command line (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) and stop
them by PID before reinstalling.

---

## 2026-09-17 — a view that copies a write path's arithmetic has to copy its guards too

**Believed:** `StakingMonitorView.earned` could be trusted during a pause because its math is a
line-for-line copy of the write path. `StakingViewLib.earnedFromMem` does the same
elapsed × rate projection, the same pool cap and the same debt subtraction as
`accumulateRewards` followed by `getReward`, and it carries a comment demanding lockstep with its
storage twin.

**Measured** (`contracts/test/StakingMonitorViewPause_2026_09_17.t.sol`, forge 1.5.1, PR #624): the copy
took the arithmetic and left out the condition around it. `accumulateRewards` projects only
`if (… && !cfg.isPaused)`, and the pause flag is not among the view's inputs. Two equal stakers,
one day, pause, one emergency withdrawal, three paused days: the view showed **302,400** TOWELI
and `getReward` at the unpause instant paid **43,200**. The lockstep comment could not catch
this. Both copies inside the library agree with each other; the guard lives in the caller's
`Cfg`, which neither copy sees.

### Pin the view to the write path while the guard is active, and in both directions

- "While paused, `earned()` equals what `getReward` pays at the unpause instant" failed on the old
  code (302,400 vs 43,200).
- A test asserting only "the view does not move while paused" passes a view that never projects
  at all. That mutant (always anchor at now) passed the paused leg and was killed only by the
  second leg: "while running, `earned()` equals what the claim pays."
- Mutation results: pre-fix, always-frozen and inverted-check each fail at least one leg. Neither
  leg compares against a literal, so both survive a change of rate, pool size or boost curve.

### Read the guard in the same call as the math

The fix reads `paused()` inside the view's own `eth_call`, so pause state is never unknown: a
failed read reverts the whole view. The frontend alternative was to read `paused()` in a separate
multicall batch and redo the math in TypeScript. That adds a third state, "pause unread", which
then needs its own withheld display (an unread flag must not read as "running"), plus a second
copy of the math that can drift the same way this one did. When a guard can be read on-chain next
to the numbers it gates, read it there.

---

## 2026-09-17 — `git bundle verify` passes a bundle cut in half, so a safety net is only proven by restoring from it

**Believed:** a bundle that `git bundle verify` accepts is a backup you can delete against.
The command is named for exactly that check, it exits 0, and it prints "The bundle records a
complete history."

**Measured** (git 2.53.0.windows.1). A throwaway repo with 6 commits of random 200 KB files,
bundled with `git bundle create full.bundle --all` (1,201,601 bytes); `half.bundle` is the
first 600,800 bytes of that file:

| check | `full.bundle` | `half.bundle` |
|---|---|---|
| `git bundle verify` in the source repo | pass | **pass** |
| `git bundle list-heads` | pass | **pass** |
| `git bundle verify` in an empty repo | pass | **pass** |
| `git fetch <bundle> 'refs/*:refs/r/*'` in an empty repo | pass | fail: `early EOF`, `index-pack died` |

`verify` and `list-heads` read the bundle's header (its ref list and prerequisite commits) and
check the prerequisites against the current repository. Neither reads the pack data that follows.
A partial copy, an interrupted download or a disk-full write can leave the header intact, and then
both checks still pass.

This was caught while reviewing a branch cleanup whose design was "bundle it, verify the bundle,
then delete": the verify step proved nothing about the part that mattered.

**Do:** prove a bundle by restoring from it before you delete what it backs up. Fetch it into a
fresh repository that holds only the bundle's prerequisites, check that every oid you meant to
keep is present (`git cat-file --batch-check`), and run `git fsck --connectivity-only`. Record a
hash of the proven file, so anything that later trusts the bundle can check that it is still the
file that was proven.

### Two more places a zero-loss cleanup quietly loses the last copy

- **`.git/lost-found/other/` can hold the only copy of a blob.** `git fsck --lost-found` writes
  each dangling blob's *content* into a file named by its oid. Once gc prunes the object, that
  file is all that remains. In this repo 3 of the 13 files there hashed to their own names
  (`git hash-object --no-filters <file>` equals the filename) while `git cat-file -e <oid>`
  failed. A cleanup that treats `lost-found` as a folder of names and deletes it destroys
  content. Move it instead. The files in `lost-found/commit/` really are just names.
- **Loose-ref file timestamps are not evidence of recent use.** A guard that skipped tags whose
  `.git/refs/tags/<name>` file had changed in the last 72h protected nothing within the same
  hour: another session's `gc --auto` packed every ref into `packed-refs`, and the loose files
  disappeared. Use something the packing cannot erase, such as the tagged commit's date, or a
  name convention that live work actually follows.

---

## 2026-09-16 — a merge train's green ticks are claims about a base, a scope and a moment

**Believed:** working a backlog of open PRs is bookkeeping. A PR whose checks read green
is ready, `gh pr checks` exiting 0 means the checks passed, and a stale branch is one
click from current.

**Measured** while triaging the open-PR backlog against `mvp-launch`, every one of those
was wrong in a way that would have merged something nobody had checked.

### `gh pr checks` exits 0 on the checks that exist, not the checks that should

On a PR whose base is not a trunk branch, `gh pr checks <n>` exits **0** with 11 of the 32
gates a trunk-based PR runs. It reports the check-runs that were created, and a job whose
workflow never triggered creates none, so nothing in the output is red and nothing says
"missing". The 2026-09-12 stacked-branch entry below records a stacked PR reading
`all-checks-pass: SUCCESS`; the extra fact here is that the exit code agrees with it, so a
script that gates on `$?` is exactly as blind as a human reading the tick.

**Do:** list the NAMED contexts the touched paths must produce, look each one up in
`gh pr checks --json name,state,workflow`, and treat an absent context as a failure. A
count floor does not fix this (see the 2026-09-12 `all-checks-pass` entry below): which
workflows run at all is path-dependent.

### The aggregators finish before the frontend gate starts

`all-checks-pass` and `all-tests-pass` are the terminal jobs of `solana-ci` and
`Contracts CI` (the 2026-09-12 entry below has the table). On #576, a frontend PR, both
were green at 15:54, `Build` started at 16:03 and both E2E jobs at 16:07, and the long
E2E run finished at 16:47. A reviewer who stopped at the two green "all-*" names would
have merged before the frontend was built, and nearly an hour before its E2E finished.
They are not a frontend gate at any point in the run, not just early in it.

### A green is computed against the base as of the last push

A PR's checks ran against the trunk that existed when it was last pushed. Across the
backlog, PRs sat **48 to 216 commits** behind `mvp-launch`. The oldest of them predate
`em-dash-zero.spec.ts` entirely (it arrived in `350dfa9d` on 2026-09-09), and the rest had
run it only in an earlier revision, before the per-route budgets they would be merged
against were rewritten. Their greens were true statements about a tree that no longer
exists: nothing had re-run them.

**Do:** refresh a PR onto current trunk before trusting its green, and wait for the new
run. An old tick is evidence about its merge base, not about the merge.

### `allow_update_branch: false` does not turn `update-branch` off

The repository reads `allow_update_branch: false`
(`gh api repos/<owner>/<repo> --jq .allow_update_branch`), and the first draft of this
plan concluded from that value that `gh pr update-branch` was unavailable. It is not. On
2026-09-16 `gh pr update-branch 567` answered "PR branch updated" and GitHub pushed
`536976e7`, a two-parent merge committed as GitHub, and the same call then refreshed
fourteen more PRs. The setting governs whether GitHub always *suggests* the button, not
whether the API works; GitHub had authored update-branch merges here on 2026-09-04 too. A
setting's value is only a claim about its effect until the effect has been measured.

**Do:** refresh with `gh pr update-branch <n>`. For a stacked PR, retarget first
(`gh pr edit <n> --base mvp-launch`) and update second, so the one push runs against the
trunk gates. #482's refresh was pushed a minute before its retarget, ran against the old
base, and the retarget did not re-run anything.

### A lockfile marked `binary` cannot be three-way merged

`.gitattributes` declares `package-lock.json  binary`, and the `binary` macro unsets
`merge`, so git will not three-way merge `frontend/package-lock.json`: any two branches
that both change it conflict on the whole file, however disjoint the edits. Dependabot
PRs that touch the lockfile therefore land **one per rebase cycle** — merge one, and every
other lockfile PR goes CONFLICTING until Dependabot regenerates it against the new trunk.
Sequence them, and do not read a wall of conflicts as a wall of broken PRs.

### A monitor alarm about a healthy site, fifteen times

The literal-301 probe in the 2026-09-15 entry below had failed **15 consecutive runs** and
commented **14 times** on issue #566 by the time its fix (#573) was opened, about a site
that was serving correct 308 redirects the whole time. With #573 still open a day later,
the issue held **19** of those comments (the latest at 2026-09-16 10:05Z). The durable rule is that entry's:
assert a redirect's class and target, not a literal code. What the backlog adds is the
count: fourteen false comments on one issue is fourteen chances to learn to skip it.

---

## 2026-09-15 — a monitor that pins a vendor's status code fails the day the vendor is right

**Believed:** a permanent redirect is a 301, so a synthetic probe can assert
`[ "$code" = "301" ]` and thereby be asserting "this alias redirects permanently".

**Measured:** Vercel's `redirects` array never emits 301. `"permanent": true` emits
**308**; `"permanent": false` emits **307**. Measured with `curl -sI` against three
live aliases — all three 308, one hop, path and query preserved. There is no setting
on a `redirects` entry that yields 301; you have to abandon `permanent` for a raw
`statusCode` to get one.

The failure mode this produced is the transferable part. **One commit** both created
the redirect with `permanent: true` *and* rewrote the monitor to demand a literal
`301`. It went red on the first scheduled run after merging and stayed red for **14
consecutive runs** across three trunk commits, while production behaved exactly as
designed. The check asserted a status code the config it shipped alongside could not
emit — and because both halves rode in one commit, there was no "it used to pass"
signal to bisect toward.

**Why a literal is the wrong pin.** The invariant the probe exists to defend is
*permanent, and onto the canonical host*. `301` is one vendor's spelling of half of
that. Pinning the spelling fails on a correct implementation-detail change and, worse,
stays silent if the platform later emits a permanent code you never enumerated. Assert
the property:

```bash
case "$code" in 301|308) : ;; *) fail ;; esac
```

That is *stricter* than the `30[0-9]` it replaced, because 302/303/307 now fail: a
temporary here means someone flipped `permanent` to false and the canonicalisation
signal quietly stopped consolidating.

**308 is not a downgrade.** It is the method-preserving twin of 301 (RFC 7538) and
search engines consolidate on it identically. There was nothing to fix in production
— "make the monitor green" and "fix the site" were different tasks and only one of
them was real. A red monitor is a claim about production that itself needs checking.

**Do:** when probing a managed platform, enumerate every code that satisfies the
property you actually care about, and find out what the platform emits — one
`curl -sI` — rather than inferring it from what the config field is *named*.
`permanent: true` does not mean 301.

### The corollary that cost the two days: an alarm must say what tripped it

The probe wrote its failure text to `$GITHUB_OUTPUT` only, for use as an issue body.
**`gh run view <id> --log-failed` does not render `$GITHUB_OUTPUT`** — it showed the
`run:` script source and a bare `exit 1`. The one fact needed to act (WHICH host, and
what it actually returned) was recoverable only by re-running the probe by hand.

An alarm whose own log cannot name what tripped it gets ignored, and this one was, for
two days, by everyone who looked at it. If a step composes a human-readable failure
report, print it to stdout **as well as** to wherever the automation consumes it. The
duplication costs one line and is the difference between a triaged alarm and wallpaper.

---

## 2026-09-15 — the knob that makes one file input strict does not make the action strict

**Believed:** hand a GitHub Action a path to a file that is not there and the step fails.
`softprops/action-gh-release` even advertises an input called `fail_on_unmatched_files`,
which reads like the action's policy for missing files.

**Read** (not run — see the caveat at the end) from the action's own source at the SHA this
repo pins, `efb35369`:

- `body_path` is **soft, with no opt-out**. `releaseBody()` in `src/util.ts:57-69` wraps the
  read in a try/catch that only `console.warn`s, then returns `config.input_body`:

      if (config.input_body_path) {
        try { return readFileSync(config.input_body_path, 'utf8'); }
        catch (err) { console.warn(`⚠️ Failed to read body_path ... Falling back to 'body' input.`); }
      }
      return config.input_body;

  If `body` is not also set, that returns `undefined`, and the consumer coerces it:
  `src/github.ts:688` reads `releaseBody(config) || ''`. So an unresolvable `body_path`
  publishes an **empty release body on a green run**. Nothing in the action's 19 declared
  inputs can harden this.
- `fail_on_unmatched_files` governs a **different** input. Its only two consumers are
  `src/run.ts:16` and `:46`, both on `config.input_files` — the release *assets*. It never
  reaches `releaseBody`. It also defaults to soft: `parseConfig` reads
  `env.INPUT_FAIL_ON_UNMATCHED_FILES == 'true'`, so unset is `false`, so an asset glob that
  matches nothing warns and publishes a release with no assets.

So one action carries two file inputs with two different policies, and the strictness knob
that exists names the one you were not worried about. **Seeing a hardening option in an
action's input list is not evidence that the action is strict; check which input it is
wired to.**

The same shape has a third policy elsewhere in this repo's workflows. `actions/upload-artifact`
takes `if-no-files-found`, which is configurable *and* defaults to `warn`. Surveyed across
`.github/workflows/` by walking the parsed YAML: 11 upload steps, 8 set the flag (5 `error`,
3 `warn`), and 3 sit on the default — so **6** sites treat "produced nothing" as a warning and
a green job. Three policies for one idea (no opt-out / opt-in-and-defaults-soft /
configurable-and-defaults-soft) across two actions is why this has to be checked per input
rather than remembered per action.

That survey had to be structural, and the first pass of this entry got it wrong by not being.
`grep -c if-no-files-found` over the same files returns **9**, not 8, because one of the matches
is inside a *comment* explaining the setting rather than setting it (`solana-ci.yml:439`). The
grep-derived numbers were in this entry's first draft and were corrected before it left the
worktree. A
comment naming a setting is a claim about configuration, not configuration — the same trap the
2026-09-11 entry records for gate comments and wrong-chain notices, arriving here through a
counting tool instead of a reader.

**How to check it**, without trusting a README that may describe a different version than the
one pinned:

    gh api repos/<owner>/<repo>/contents/src/util.ts?ref=<pinned SHA> --jq '.content' | base64 -d

Reading the pinned SHA is the point. A floating tag's docs and the bytes that actually run in
CI are different artifacts.

**Caveat, stated because this file's rule requires it:** the empty-body consequence is derived
from reading that source plus the fact that the caller leaves `body` unset. It was **not**
observed in a release run — the workflow it was found in has never executed even once. The
line numbers and the input survey are reads; the consequence is an inference from them.

**Why it is worth knowing beyond the warning:** it changes what counts as a safe edit. Renaming
the generated file this repo feeds to `body_path` looked like a free string swap. Because the
failure mode is a silent green, "move it to `${{ runner.temp }}`" — a change to how the path
*resolves*, not just what it says — would have had no rehearsal that could catch it going
wrong. When an input is soft, the cost of being wrong about it is paid silently and later, so
the change that touches the fewest mechanisms wins.

## 2026-09-14 — a wallet adapter's declared capability is the SHIM's opinion, not the wallet's

**Believed:** `supportedTransactionVersions` on an official `@solana/wallet-adapter-*`
package tells you what that wallet can sign. On 2026-09-02 this repo read
`@solana/wallet-adapter-trust`'s `supportedTransactionVersions = null`, correctly
decoded it (null narrows to legacy-only; it does **not** mean "all versions"), and
excluded Trust from every Solana surface on the grounds that the wallet could not
sign the v0 transactions this venue sends. A guard test was written to keep it out.

**Measured, twelve days later:** the package was right about itself and wrong about
Trust. Read from Trust's own sources, not the shim:

- `trustwallet/trust-web3-provider`, `adapter/src/wallet.ts` — Trust's **own** Wallet
  Standard implementation — declares `supportedTransactionVersions: ['legacy', 0]` on
  both `solana:signTransaction` and `solana:signAndSendTransaction`.
- Its injected provider, `src/solana_provider.js`, reads `tx.version` and serializes
  with `requireAllSignatures: false, verifySignatures: false` — the versioned path.
- `wallet-core` has shipped `VersionedTx` / `V0Message` since PR #2935, merged
  **2023-02-20**, which closed "[Solana] Support versioned transactions".

`@solana/wallet-adapter-trust@0.1.18`, published **2026-09-10**, still says `null`.
So the metadata had been wrong for roughly three and a half years and was republished
wrong four days before it was read.

**Why this generalises past Solana.** These adapter packages are third-party shims
around someone else's product. The wallet ships on its own cadence; the shim is
updated when a volunteer gets to it. A capability *claim* in the shim is evidence
about the shim. A capability *denial* is not evidence about the wallet at all.

**Do:** when a wallet shim says a wallet cannot do something, and that denial is the
reason you are about to exclude the wallet, go read the wallet's own provider or
Wallet Standard source before believing it. It is a ten-minute read and it is the
difference between "this wallet is broken" and "this package is stale". Vendor an
adapter with the honest declaration rather than adopting the package — a wallet's own
`registerWallet` implementation is the authority, and it is public.

### The declared capability gates only SOME paths — find out which one your SDK takes

The version check does **not** live in the adapter. In `@solana/wallet-adapter-base`
(`esm/signer.js`) it lives in exactly two methods on `BaseSignerWalletAdapter`:
`sendTransaction` and `signAllTransactions`. **`signTransaction` has no gate at all.**

That matters because SDKs disagree about which one they call. Measured here:

| Path | Route | Hits the declared-version gate? |
| --- | --- | --- |
| swap / limit / DCA | `adapter.sendTransaction` | yes |
| Streamflow staking | `client.execute()` → `signAndExecuteTransaction` → `invoker.signTransaction(tx)` | **no** |

Both send a v0 `VersionedTransaction` (`@streamflow/common` compiles one via
`compileToV0Message`). So a legacy-only adapter throws the adapter's clean
`Sending versioned transactions isn't supported by this wallet` on one path, and on
the other sails past the check and fails inside the wallet with whatever that wallet
says. Same defect, two symptoms, and a guard asserting the declared value catches
neither on the second path.

**Do:** before reasoning about what a declared capability protects, `grep` the SDK for
which method it actually calls. `isSignerWallet(invoker) → invoker.signTransaction` is
the common bypass shape and it appears in more than one SDK.

### A dist grep is evidence only after you prove the code path is REACHABLE in that build

Checking that a wallet refactor had not dropped Trust from the EVM connect modal,
`grep -rl "com.trustwallet.app" dist/assets/*.js` returned **nothing**. Read naively
that says the refactor deleted the wallet. It did not: `wagmi.ts` builds its wallet
list inside an `if (projectId)` branch, no `.env` exists in a fresh worktree, so
`VITE_WALLETCONNECT_PROJECT_ID` was undefined and rolldown eliminated the **entire**
list — Phantom, Trust, WalletConnect, Rainbow, Base and Rabby together. The tell was
cheap and should have been the first check: grep for a *sibling* that the change did
not touch (`phantom.ethereum`). It was also absent, so the absence was about the
build, not the diff.

Rebuilt with `VITE_WALLETCONNECT_PROJECT_ID=<any 32 hex chars>`: `com.trustwallet.app`
present in the wagmi chunk, and the shared icon module resolved into its own chunk
imported by both sides rather than pulling one stack into the other.

**Do:** a zero from a dist grep is a *reading*, and an unreachable code path returns
the same zero as a deleted one. Before believing it, grep for an untouched sibling
symbol from the same branch. If the sibling is missing too, you measured your env.

### `autoConnect` + a `Loadable` deep-link branch = a page that navigates itself away

Wallet adapters model "app not installed, but we can hand off to it" as
`WalletReadyState.Loadable`, and `connect()` in that state is not a connection — it
assigns `window.location.href` to a universal link. `WalletProvider` is commonly
mounted with `autoConnect`, and the default `autoConnect()` just calls `connect()`.
Composed, that is: every returning visitor whose stored wallet selection is the
deep-linkable one gets navigated off the site on page load, having clicked nothing.

Upstream's Phantom adapter guards it (`autoConnect` runs only from `Installed`) with a
two-line comment and no test. Any hand-rolled or vendored adapter has to re-derive the
guard, and nothing fails loudly if it does not — on desktop, where adapters get
written, `Loadable` never occurs.

**Do:** if an adapter has a `Loadable`/redirect branch, override `autoConnect` to run
only from `Installed`, and pin it with a test that asserts `location.href` is
**unchanged** after `autoConnect()`. Also make an injected provider always win over
the redirect, or the wallet's own in-app browser can bounce itself in a loop.

### Incidental

- `useStandardWalletAdapters` dedupes a legacy adapter against a registered Wallet
  Standard wallet by **exact `name` string match** (it drops yours and logs a
  `console.warn`). A vendored adapter's `name` is therefore a load-bearing contract,
  not a label: Trust registers as `"Trust"`, so an adapter calling itself
  `"Trust Wallet"` — which is what the EVM modal calls it — would render a second,
  dead row beside the real one.
- `scopePollingDetectionStrategy` runs its detector **synchronously** as its last step
  ("Strategy #4"), so an adapter's `readyState` is already settled when the constructor
  returns. Tests can assert it without waiting; the 1s interval only covers late
  injection.
- SLIP-44 for Solana is **501**; Trust's dApp-browser handoff is
  `https://link.trustwallet.com/open_url?coin_id=<slip44>&url=<encoded>`. A wrong
  `coin_id` still opens the browser, so this fails silently on the wrong chain.

## 2026-09-13 — correct bytes at an unchanged URL reach nobody who already resolved that URL

**Believed:** if a site's icon files are wrong, replacing the bytes fixes it. The
HTTP cache is the only thing between the file and the viewer, so serving the
icon with `Cache-Control: public, max-age=0, must-revalidate` means every client
re-checks and picks up the new art on its next visit.

**Measured:** the venue's `apple-touch-icon.png` and both manifest icons carried
a retired project's pixel logo, and a commit replaced all three with the correct
mark. Production served the correct bytes from that moment — verified live,
`curl -sI https://<site>/apple-touch-icon.png` returning `200 image/png`,
`Cache-Control: public, max-age=0, must-revalidate`, ETag matching the new file.
Weeks later the retired icon was still showing in a wallet's in-app browser, on
its tab cards and in its search bar.

The reason is that `Cache-Control` governs *the HTTP cache*. It says nothing to
a client that resolved this origin's icon once, wrote the image into its own
store keyed by **origin**, and never asks the network again. Browsers, in-app
webviews, home-screen launchers and link unfurlers all keep a store like this.
For them a new icon at an old filename does not exist — there is no request for
a header to be attached to.

What reaches them is a URL they have never seen, so the version token has to move in
the markup and in every manifest, not just on disk. **Where in the URL it moves
matters too.** The first fix put the token in a query (`/favicon.png?v=<token>`); two
days later it moved into the path (`/icons/<token>/favicon.png`). A store that
normalises or strips the query sees the URL it already holds, and nothing on the
server side reveals which stores do that. A new path is a strict superset of a new
query: every store that would notice the query notices the path, and so do the
ones that ignore queries. Keep the canonical root files (`/favicon.ico`,
`/apple-touch-icon.png`) as copies and never move them, because a deleted one falls
into the SPA rewrite described below.

Two things that follow:

- **The revalidation headers were never the problem, so tightening them is not
  the fix.** It is easy to spend the whole investigation on `Cache-Control`,
  `ETag` and CDN `Age` — all of which were already correct here — because those
  are the knobs a server exposes. The stale copy was never in a layer the server
  can address.
- **Derive the version token from the icon bytes, not by hand.** A hand-bumped
  literal lets someone change the art and leave the token alone, which is the
  original bug reproduced exactly. Hashing the icon files and asserting the
  markup carries that hash means art that moves without its URL moving fails,
  and the failure prints the token to paste in. The invariant worth pinning is
  "when the bytes change, the URL changes with them" — **not** "the icon is the
  right one", which was true for the entire life of the bug and would have
  proved nothing.

**The second half, and the reason a client had nothing better to fall back to:**
under an SPA rewrite, a missing well-known asset is not a 404. The config here
rewrites `/((?!api/).*)` to `/index.html`, and there was no `favicon.ico` on
disk, so `GET /favicon.ico` returned **`200 text/html`, 12801 bytes** — verified
live. Plenty of in-app browsers probe that root path before they parse a single
`<link>` tag. A fetcher that gets a 200 it cannot decode has no failure to fall
back *from*: it does not learn "no icon here", it just keeps whatever it already
had. A real `.ico` on disk both answers the probe and removes the ambiguity.

Generalises past favicons: any SPA-rewritten origin returns a decodable-looking
200 for `/robots.txt`, `/.well-known/*`, `/sitemap.xml` and every other
convention-probed path it does not actually ship. Absence and success are the
same response, and only the client's parser can tell them apart.

---

## 2026-09-13 — a source scanner's exemptions are where the bugs live, and `[^>]*` cannot match a JSX tag

**Believed:** a registry that must stay in step with the code can be held there by
a scan: read every call site, compare against the list, fail on the difference.
Call sites the scan cannot resolve — a computed argument, a loop index — are a
small, harmless remainder, so skipping them keeps the guard honest.

**Measured:** the skipped remainder was where both real defects were.

A hand-maintained inventory of 418 art surfaces had two guards over it, and both
asked only *"is everything the code renders in the list?"*. Running the reverse
question for the first time: **54 of the 418 were rendered by nothing at all** —
whole retired pages, and 17 cards on a page that had been rebuilt down to 2.
Nothing had ever asked, so nothing had ever said.

And the exemption itself hid the opposite defect. The scanners matched
`pageId="literal"`, so a surface selected by a computed value was invisible to
them — it could neither be flagged as missing nor as dead. Two of the most-seen
surfaces on the site were reachable *only* that way:

    pageId={IS_ARRIVAL || identity ? 'home' : 'venue-home'}
    const PAGE_ID = 'eth-curve';  …  <PageArtBackdrop pageId={PAGE_ID} />

The home-page hero was unregistered and unplaceable in the editing tool for
months, while an overrides file carried a saved pick for it the whole time —
a pick nothing could display, edit, or reconcile.

Three things that transfer:

- **Run the reverse direction of any consistency guard at least once.** "Is
  everything used in the list?" and "is everything in the list used?" are
  different questions with different failure modes, and a codebase that only
  ever asks the first accumulates dead entries silently — forever, because the
  guard is green. A dead registry entry is worse than clutter when the registry
  is an editing surface: it accepts input, writes a record, and affects nothing.
- **`[^>]*` cannot match a JSX tag.** Any prop holding an arrow function
  (`onClick={() => x}`) contains a `>` that truncates the match, so the parse
  silently pairs an attribute with one from a *later* tag. This produced
  confident, entirely wrong findings until the extractor was rewritten to walk
  the tag tracking brace and quote depth. Same trap for any regex over a
  brace-delimited language.
- **Enumerate the components before scanning for them, and read each one's
  defaults.** The first pass covered two of the five components that resolve
  this value, and reported live entries as dead because their call sites were in
  the other three. Three of the five default the index to `0`, so a tag with no
  index prop anywhere in it still renders index 0 — a scan looking for an
  explicit index sees nothing and concludes the surface is unused.

The general shape: a static scanner is an argument with premises — *these*
components, *this* call syntax, *these* defaults. The premises are invisible in
the output, and a green result asserts them just as loudly as it asserts the
conclusion. Before trusting a sweep, check the number it resolved: this one
found 282 surfaces before the missing components were added and 302 after, and
the 20-surface gap was the whole difference between a wrong answer and a right
one.

---

## 2026-09-12 — a route stub whose pattern stops matching does not fail, it silently measures the unstubbed page

**Believed:** if a Playwright `page.route(glob, r => r.abort())` is in the spec, the
branch under it is the aborted one. A stub is either applied or the test errors.

**Measured:** neither. When the app moved its GeckoTerminal reads from
`api.geckoterminal.com` to a same-origin edge, the spec's
`'**api.geckoterminal.com/**'` matched nothing and Playwright reported *nothing at
all* — no warning, no unmatched-route error. The spec kept passing for two days
against a branch it was not pinning, then reddened trunk when that branch's copy
happened to differ by one character class.

Proof it was inert, three runs on the same build, same route, identical source:

| stub | prose em dashes on `/competitions` |
|---|---|
| `'**api.geckoterminal.com/**'` (dead) | 16 |
| `'**resource=gecko-read**'` (live) | 17 |
| no `page.route` at all | 16 |

The dead stub and *no stub* agreeing exactly is the signature. If a stub is
load-bearing, assert that: count `requestfailed` under it, or fail the test when
the handler was never invoked. A stub you cannot prove fired is a comment.

### Under `vite preview`, a missing `/api/*` is not a 404 — it is 200 text/html

This is what turned an inert stub into a *wrong* measurement rather than merely a
live one. `vite preview` runs no serverless function, and the SPA fallback answers
any unmatched path with the index document, 200. So a client that checks
`res.ok` before parsing sails through the status check and dies at
`res.json()`. The failure is classified at a different layer:

- aborted at the socket → `network` → *"The trades feed could not be reached — that
  is an outage, not an empty tape."*
- 200 text/html → `schema` → *"The trades feed returned something unreadable."*

Same outage to the user, different sentence, and here a different em-dash count.
Any assertion over the WORDS of a failure — not just its presence — is really an
assertion about which layer the read died at, and `vite preview` moves that layer
relative to production. Fail-closed code paths are not interchangeable just
because they both render "could not read".

### Writing down the correct pattern is not the same as applying it

The fixture had already been updated, in prose, to say the old glob
"intercepts nothing now; the equivalent is `'**resource=gecko-read**'`". Two specs
still holding the old literal were not changed in that commit, so the note
documented the breakage instead of preventing it. A note describing the right
value, next to callers still using the wrong one, reads as done and is not.

**Do:** when a URL a test depends on moves, export the pattern as one constant and
import it. `grep` for the old literal in the same commit that writes the note —
the note is the weakest possible fix.

### An exact count over text built from a failed read cannot hold

The guard budgeted `/competitions` at 17 prose em dashes. Thirteen were the read
ledger: one `not read — <why>` chip per resident pool, plus one sentence per
distinct failure reason. That number is a function of how many pools are
registered, how many answered, and which reason each failure got — a third
party's behaviour, not reviewable copy. It was fated to drift and it did.

**Do:** exclude such a subtree by structure (a marker attribute the walker skips,
plus a source guard pinning who may declare it), rather than budgeting it. The
test of a good exclusion is that the remaining number stops moving: with that
structural fix, proposed in #564 and still open, the route read 4 aborted, 4 on
the fallback, and 4 unstubbed.

---

## 2026-09-12 — the same string at a second site is not automatically the same bug: read the GATE before the copy

**Believed:** a known-bad string still live at a second site, present at the fixing
PR's merge base, is a site the sweep did not reach — the same defect, closed by
applying the same rewrite.

**Measured** (PR #561 against #474, the string `'Trade ETH ↔ TOWELI via Uniswap V2
with custom slippage controls.'`, byte-identical at `TradePage.tsx:92` and
`HomePage.tsx:832`): the two sites render under different gates, so the rule that
condemned the first does not reach the second. TradePage has no arrival-voice gate
at all. The HomePage grid is inside `IS_TOWELI_ARRIVAL && !bungalowIdentity` — one
resident's own page, where naming that resident is correct and deliberate. The
cheapest evidence was two lines down in the SAME array literal: the neighbouring
card names the same ticker on purpose (`farmCardDesc` → "Stake TOWELI to earn now"),
hoisted to a lib and already pinned by a different test. Applying #474's rule here
would have turned a reviewed line red, and the ruling's own test header warns
against exactly that — "banning the word would have forced the venue to hide one
resident to prove it favours none".

There WAS a real defect at the second site, but a different one that the string
match happened to sit on: the copy named one of the NINE sources `useSwapQuote`
races, so it understated the surface rather than mis-voicing it. The correct fix
and the assumed fix pointed opposite ways on the ticker — keep it, not delete it.

**Do:** when a known-bad string turns up at a second site, read the gate that site
renders under before reusing the first site's fix. Two occurrences of one string
can be one bug, two unrelated bugs, or one bug and one correct usage. Check the
siblings in the same literal first: a neighbour that keeps the "bad" pattern
deliberately is the cheapest available proof that the rule does not apply there.

### Incidental — `\b` inside a template literal is a BACKSPACE, and a negated matcher then passes vacuously

A regex assembled as ``new RegExp(`\b(?:W?ETH)\b\s*…`)`` is not the regex you
wrote. In a template literal `\b` is U+0008 and `\s` is a literal `s`, so the
compiled source came out as `\b(?:W?ETH)\bs*[…]+s*TOWELI\b` — measured in node
against the pre-fix string: the intended pattern matches, that one does not. Because
the assertion was `.not.toMatch()`, the broken pattern would have PASSED, silently,
against the very string it existed to ban. The mutation check is what surfaces this;
a guard written this way and never watched fail reads green forever.

Generating the file through a script adds a second, independent backslash level to
lose (heredoc → script → disk ate one here, turning the intended `\\b` into `\b`).
`String.raw` removes both problems at once and is the right default for any regex
source built from a template.

## 2026-09-12 — a green that ran nothing, a green that covers a different workflow, and a red that only timed out

**Believed:** a vitest run that exits 0 ran the suite, a context called
`all-checks-pass` covers the PR's checks, and a pre-fix test that goes red has
done its job whichever way it went red.

### `--reporter=<name-that-does-not-exist>` is a silent no-op

`npx vitest run --reporter=basic` in `frontend/` printed a stack ending in

```
code: 'ERR_LOAD_URL'
...
[exited with code 0]
```

`basic` is not a reporter in this vitest, so vitest tried to resolve it as a
**custom reporter module**, failed to import it, and exited **0** with **zero test
files collected**. Nothing in the output says "0 tests" — the summary lines a real
run prints (`Test Files`, `Tests`) are simply absent, which reads like truncation.
`--reporter=dot` on the same tree reported `Test Files 603 passed (603)`.

Same shape as the cancellation trap in
`reference_trunk_ci_starved_by_cancellation`: the exit code is not the question.
**Gate on the summary line, not the status** — `grep -E "Tests  " out` is the
check, `$?` is not. This bites twice, because piping vitest into anything
(`| tail`, `; echo $?`) also reports the *last* command's status: a run that
printed `VITEST EXIT: 1` was reported by the surrounding shell as exit 0.

### Await a sentinel that exists in BOTH worlds, then assert synchronously

Writing a render-level test for a read-honesty fix, the natural shape is

```js
expect(await screen.findByText(/floor depth not measured/i)).toBeInTheDocument();
```

Against the **pre-fix** component that copy does not exist, so `findByText` burns
the whole `waitFor` budget and fails with a timeout — measured at **1022ms**, next
to 38–627ms for the legs that failed on a value. A timeout is a weak result: it is
also what you get from a component that never finished loading, a mock that never
resolved, or a typo in the matcher. It cannot separate "the copy is absent" from
"nothing rendered at all".

Rewritten to await a heading that renders in both the pre- and post-fix worlds,
then assert synchronously:

```js
expect(await screen.findByRole("heading", { name: /Floor Depth/i })).toBeInTheDocument();
expect(screen.getByText(/floor depth not measured/i)).toBeInTheDocument();
```

the same pre-fix run fails in **241ms** with `TestingLibraryElementError: Unable to
find an element with the text: …` — an immediate, specific statement that the
component rendered and the copy is not in it.

**Do:** in a mutation check, `await` something both versions render. Only the
assertion should target what changed.

### `all-checks-pass` is not the PR's checks

Measured on a docs-only PR (#552). `gh pr checks --json name,bucket,workflow`:

| context | workflow |
| --- | --- |
| `all-checks-pass` | **solana-ci** |
| `all-tests-pass` | **Contracts CI** |
| `Lint, Type Check & Test` | **CI** |
| `CodeQL (javascript-typescript)` | **CodeQL** |

Neither aggregate spans the PR. They are the terminal jobs of the solana and
contracts workflows, so on a docs or frontend change those workflows skip every
job, their aggregate passes **in seconds**, and the frontend's real gate is still
running in a different workflow. Watching the list settle, `all-checks-pass` and
`all-tests-pass` both read `pass` while `Lint, Type Check & Test` and `CodeQL`
were still `pending`.

It looks like a race and is not one — it is a **scope** error. The name claims the
PR; the job covers one workflow. This is the mechanism behind the existing rule
that a check-COUNT floor is unsound: which workflows contribute at all is
path-dependent, so both the count and any "all-*" name mean something different
per PR.

**Do:** assert the NAMED contexts that matter for the paths you touched — for a
frontend change that is `Lint, Type Check & Test`, not `all-checks-pass`. Add
`workflow` to the `gh pr checks --json` field list; without it a context's real
scope is invisible.

### Incidental

- `getByText` with a **regex** matches every node whose text contains it, so adding
  the same phrase to a summary line and to a detail line breaks a query that was
  unique the day before (`Found multiple elements`). Matching the exact full string
  separates them without scoping to a container.
- A render-level outage test does not automatically need fake timers. Retry sleeps
  only exist on paths that retry: in `frontend/src/nakamigos`, a proxy rejection
  carrying a plain `Error` is non-retryable to `api.js`'s `withRetry` (it retries
  `TypeError` and `ApiError.isRetryable` only), and the orderbook's `degraded: true`
  answer is deliberately not retried. Picking those legs let 11 render tests run on
  real timers in 3.81s of test time.

## 2026-09-12 — an equality-based invariance test is blind to every field that is equal for the wrong reason

**Believed:** the strongest way to pin "X must not change what this reports" is to
assert the whole report is equal with X set and unset. Nothing can hide in an
object comparison.

**Measured** (PR #514's `farmReadsWalletChain.test.ts`, whose stated subject is
"the wallet's chain does not decide what the farm reports"; the subject under test
was `usePoolData`'s `batchRan`, carrying a `chainId === CHAIN_ID` term the
`enabled` gate beside it had already lost):

- The suite builds one all-success fixture and asserts
  `figures(reportOn(hook, 8453))` equals `figures(reportOn(hook, CHAIN_ID))`, with
  one scalar checked non-zero first so two unread reports cannot pass as equal.
- Put the chain term back on `batchRan` and that suite still passes **10/10**, run
  alone, while the hook's own suite fails 4 of 31 on the same tree. The three
  unread flags are `false` on both sides of the equality, because under an
  all-success fixture there is nothing to be unread about. The equality held, and
  held for the wrong reason.
- The 4 that fail are the ones that break **one** read off mainnet. Breaking a read
  is what makes a failure flag take a value worth comparing.

The guard against "two unread reports are equal too" was already there and was not
enough: it proves the READS landed, not that any FLAG was exercised.

**Do:** for each boolean in a report, ask what fixture makes it `true`. If no case
in the invariance suite produces that fixture, the equality assertion is not
covering that field, however wide the object comparison looks. An invariance test
needs one fixture per interesting value, not one fixture and a wide `toEqual`.

## 2026-09-12 — a stacked branch can hold a reference that exists in neither parent

**Believed:** a semantic conflict between a branch and trunk shows up as a merge
conflict, a type error in the branch, or a red check. A clean `merge-tree` and a
green branch mean the merge is sound.

**Measured** (PR #490 `fix/pool-reserve-unread`, stacked four deep under
`mvp-launch`; trunk's #514 had deleted the `onMainnet` declaration from
`usePoolData.ts` while #490 added a new line using it):

- Both parents are internally consistent. On #490's branch `onMainnet` is declared
  and `npx tsc -b --force` is clean; on trunk the name does not appear at all. The
  dangling reference exists **only in the merge**, so neither branch's own build
  can see it, and there is nothing for `merge-tree` to report: all nine commits
  cherry-pick onto trunk with zero conflicts.
- In the merged tree `npx tsc -b --force` gives
  `src/hooks/usePoolData.ts(59,34): error TS2304: Cannot find name 'onMainnet'`.
- That undersells it. An undeclared free variable is a **runtime**
  `ReferenceError`, not a type complaint: vitest on the cherry-picked stack gives
  27 failures, all `ReferenceError: onMainnet is not defined`, across every test
  that renders the hook. So the hook throws on every render rather than returning
  a wrong number — a different and louder class of consequence for the pages
  that call it, which a type error alone does not suggest.
- The branch's own CI cannot catch it, and says so in green. Of 15 workflows, the 7
  with a `pull_request` trigger and a branch filter all read `branches: [main,
  mvp-launch]`; the only unfiltered one is `solana-ci.yml`. On a PR opened with
  base `fix/pool-reserve-unread`, `gh pr checks` reported **`all-checks-pass:
  SUCCESS`** with only `scope` and `all-checks-pass` actually run: the other 7
  Actions jobs, `build` and `diff-guard` among them, were `SKIPPED`, so the
  frontend was never built. A stacked PR's green tick is an assertion
  about which jobs were eligible, not about the code — and a job that did run
  would be testing the parent that compiles.

**Do:** for a branch whose base is not trunk, `git merge-tree --write-tree trunk
<head>` and then typecheck **and run the tests of** the resulting tree; a clean
merge-tree exit only means git found no textual conflict. When trunk has DELETED a
declaration a stacked branch still reads, expect a free variable rather than a type
mismatch, and expect it to throw rather than to compute wrongly.

## 2026-09-12 — a guard whose two operands come from one source, hidden by a correct refusal from the wrong cause

**Believed:** the zap had a chain guard. `planZap(descriptor, routes, expectedChainId)`
refuses on `descriptor.chainId !== expectedChainId` with a dedicated refusal code
(`chain-mismatch`), a message naming both chains, and a passing test. The hook that calls
it reads `useChainId()`. Every part a reviewer looks for was present.

**Measured:** the caller built `descriptor.chainId` from `useChainId()` and then passed
that same `chainId` as `expectedChainId`. Two different expressions, two sensible names,
one variable — so the comparison was `x !== x`. Unreachable on every chain, for every
wallet, under every config. Not weakened: absent.

Rendering the hook with the wallet on 8453 and on 4663, with usable routes in hand,
returned `{ ok: true }` — a composed plan for contracts that exist on neither chain.
`planner.test.ts` was green throughout, because it calls `planZap` directly and supplies
both numbers itself: it pinned the FUNCTION, and the defect was in the CALL. Restoring
the old argument after the fix failed exactly the three new caller-level tests and
nothing else — including a positive control on the right chain, which passed both before
and after.

**What made it read as working:** a wallet on the wrong chain *was* refused — by
something else. `useSwapQuote` gates its reads on the wallet's chain, so off mainnet
every leg came back without a floor and the zap refused with `route-unavailable`:
"no floor to submit". The user saw a refusal, so nobody went looking. But it blamed the
route for a network problem, and the real guard sat dead behind two unrelated gates,
either of which could move without anyone knowing it was load-bearing.

**Do:**

- Read a guard's operands back to their **source**, not their names. A parameter named
  for what it *should* be is not evidence that it is that. The question is not "does this
  compare the right things" but "can these two expressions ever differ".
- A unit test that supplies **both** sides of a comparison cannot see this class, however
  thorough it is. The test has to be written at the caller, where only one side is free.
  This is the same shape as a mock that answers a query the real thing would refuse
  (2026-09-10, below): the double removes the very degree of freedom under test.
- When a bad state *is* refused, check **which** refusal. A misattributed refusal is the
  strongest camouflage available: the visible behaviour is correct, so the wrong
  component gets the credit and the right one rots. Grep the refusal a user actually
  sees back to the branch that emits it before concluding a guard works.
- A guard standing behind other gates is not redundancy — it is untested code with a
  test-shaped comment on it. Either something must reach it, or it should not be there.

## 2026-09-12 — a threshold fitted to a sample with a GAP is a guess wearing a measurement's clothes

**Believed:** a Streamflow CLASSIC reward entry stops being payable once its cumulative
`accounted_amount` passes `u64::MAX`. This was not reasoned from an IDL — it was established by
simulating the real `claim_rewards` against all eight live entries of a mainnet pool, with every
entry above the value reverting 6000 and every entry below it succeeding. Eight for eight.

**Measured, six days later:** wrong twice over. Scanning the whole program with
`getProgramAccounts` plus a `dataSlice` over just the counter field, **5,868 of 9,797** entries
with a non-zero counter are already past that value, and the largest is **22,000,000x past it** —
each written by a successful claim, since only a successful claim writes that field. And on the
pool itself the verdicts split perfectly on something else entirely: the pool's reward RATE was
changed at a known instant, and the 2 entries created before it revert while all 16 created after
it pay.

**Why eight-for-eight was not enough.** The sample had a hole in exactly the wrong place — its
successes topped out at 78% of the candidate threshold and its reverts started at 265%. Nothing
measured the band between, so a LOWER BOUND was indistinguishable from an exact line. And the two
reverting entries were also the two oldest, so a second variable ("predates a rate change") fit
the same eight points just as well. The first hypothesis named won by default.

**Technique, whenever a boundary is inferred from live samples:**

- **Check the sample BRACKETS the boundary.** Points either side of a gap do not locate a line,
  they bound a region. If nothing was measured between the highest pass and the lowest fail, the
  honest output is an interval — and code must not act as though it is a point.
- **Ask what else explains the same split.** Sort the failures by every field you have, not only
  the one you suspect. Here, sorting by `created_ts` against the pool's `last_amount_update_ts`
  gave a perfect 2/16 split that the counter could not improve on.
- **Widen the population before trusting the mechanism.** One pool's 8 entries said one thing and
  the program's 9,797 said the opposite. A program-wide scan over a single sliced field is cheap:
  `dataSize` + `dataSlice` returns thousands of rows in one call.
- **Measure the PAYOUT, not the exit code.** Simulate with
  `{sigVerify:false, replaceRecentBlockhash:true, accounts:{encoding:'base64', addresses:[ata]}}`
  and diff the returned post-state against the current balance. A claim that "succeeds" while
  transferring zero is not evidence a position is alive. (That config-object overload needs a
  `VersionedTransaction`; a legacy `Transaction` fails with "Invalid arguments".)

**The design rule this produced, which is the durable part:** a threshold may WARN; only the
program may VETO. The cost asymmetry is enormous and one-directional — a claim that reverts costs
a network fee, a claim never offered costs the whole balance. The code now attempts every claim
that has a pending balance and takes its verdict from the chain's own error, even where a
predicate is right 18 times out of 18.

---

## 2026-09-12 — a source guard that searches the whole file answers about the file, not the code it names

**Believed:** a guard for "this timer is armed in a layout effect" could be written
as: find the timer, then compare the last `useLayoutEffect(` before it against the
last `useEffect(` before it. Whichever is nearer is the effect it sits in.

**Measured:** nearness in a file is not enclosure. With the deadline moved back into
a passive effect AND one comment above the timer naming the layout hook in passing,
the guard stayed GREEN: the exact mutation it exists to catch walked through it. The
fooling text was not hypothetical either, since that effect's own comments name both
kinds of hook.

**Technique:** a source guard must read the construct that ENCLOSES the code it is
about, and must ignore comments. Walk back from the line you matched to the nearest
line that opens the construct, skipping comment lines, and assert on that line. Then
mutate twice: the plain break (it must red), and the plain break PLUS the text that
could fool it (it must still red). A guard is only as good as its second mutation.

## 2026-09-12 — a timeout and the animation it bounds can be counting from different moments

**Believed:** one line of arithmetic settles whether a deadline cuts an animation
short: the deadline fires at 2,500 ms, the animation needs 2,400 ms, so the animation
always finishes first.

**Measured:** the two numbers start from different moments. The deadline was armed in
a layout effect, during the commit that puts the overlay in the DOM. The animation's
clock is stamped later, in a passive effect that first builds a WebGL post-processing
pass. Whatever that gap costs -- paint, chunk parse, GL context creation -- is spent
before the animation starts counting and not before the deadline does, so the real
margin is smaller than the arithmetic, and on a slow machine the deadline can cut an
animation that is running on time.

**Technique:** before comparing a timeout against a duration, write down which moment
each side counts from. If they differ, either anchor both to the same stamp, or keep
the bound and say in the test what it is: a floor, short by however long the gap runs.
The arithmetic is not wrong, it is optimistic, and the comment is where that belongs.

---

## 2026-09-12 — `Page.captureScreenshot` is served by the renderer it is screenshotting

**Believed:** a CDP screenshot is taken by the browser, so it can observe a page
whose main thread is blocked.

It cannot. Probing whether a compositor-driven opacity animation still advances
during a long task, the driver slept to a wall-clock instant and called
`Page.captureScreenshot`. Every sample came back *after* the block ended: asking
for +2,000 / +2,600 / +2,900 / +3,500 ms returned frames at +3,261 / +3,295 /
+3,326 / +3,396 ms. The screenshot path waits on the same blocked renderer, so
the clock it appears to offer is the clock being investigated. It read "the
overlay was still opaque at the deadline" — agreeing with the bug, for the wrong
reason.

**`Page.startScreencast` is a different channel.** Frames are *pushed* as the
compositor produces them, and each carries `metadata.timestamp` (epoch seconds),
so delivery latency does not smear the measurement. Re-probed with a solid
3,000 ms busy loop across the deadline: 20 frames arrived *during* the block, with
the overlay's opacity ramping smoothly to 0.

**Do:** to answer "what was on screen at time T" for any T where script might be
busy, use the screencast and the frame's own timestamp. Convert the page's clock
with `performance.timeOrigin + performance.now()` to compare against it. Treat
`captureScreenshot`, `page.screenshot()`, and anything routed through
`page.evaluate` as main-thread instruments — fine for a quiescent page, useless
for this question.

---

## 2026-09-12 — a compositor animation's `startTime` is set at the first frame, not at creation

**Believed:** `el.animate(...)` starts the animation now, so a fade given the same
duration as a deadline finishes at the same moment.

It starts at the first frame the browser produces after creation, and on a loaded
machine that frame is not soon. Measured on a real app under a blocked main
thread: the overlay's first painted frame came **107 ms** after a MutationObserver
stamped the node's insertion, and the fade finished at **3,002 ms** against a
3,000 ms budget — having spent an entire 100 ms slack allowance on nothing but
waiting to begin. The animation was correct; its zero was late.

`animation.startTime = document.timeline.currentTime` dates it from the current
commit instead. Same build, same block: the fade completed at **2,892 ms**.

**Not the same trap as "a timeout and the animation it bounds can be counting from
different moments" above**, though it is the same theme. That one is about a clock
*your own code* stamps in a later effect; this one is the browser assigning a clock
you never wrote, inside an API that looks synchronous.

**Do:** pin `startTime` whenever an animation's *end* is a deadline rather than a
decoration. `document.timeline.currentTime` is `null` before the document's first
frame, so guard it. Note this is the same error as arming a `setTimeout` *at* a
budget instead of inside it, one layer down — a deadline that begins late can only
end late, and the lateness is invisible because the animation's own duration is
exactly right.

---

## 2026-09-12 — a compositor emits frames only when something changes, so "assert a frame in [a, b]" fails correct code

**Believed:** with a screencast running at `everyNthFrame: 1`, frames arrive
continuously, so a test can assert that some frame inside a window shows the
expected state.

Frames are produced on change. Once a fade settles at opacity 0 the compositor has
nothing further to draw and goes quiet: in one run the last frame of the fade was
at **+2,918 ms** and the next at **+3,598 ms**, a 680 ms hole straddling the
3,000 ms instant under test. An assertion requiring a frame inside
`[budget, budget + 400]` therefore failed a curtain that was demonstrably gone.

The opposite shape fails too, and more dangerously. "The first frame at or after
the budget" was satisfied on one run by a frame at **+3,568 ms** — 168 ms after
the blocked thread came back — so the *ordinary timers* answered it and the
assertion would have passed on the unfixed build.

**Do:** what is on screen at time T is **the last frame at or before T**, because
that frame persists until the next one. Assert on that, and separately assert it
post-dates whatever perturbation the test introduced, so a stale pre-test frame
cannot answer for it.

---

## 2026-09-12 — a timing constant can make a whole code path unreachable, and the profile will not mention it

**Believed:** the expensive function you can see in the phase that is running is
the one to optimise.

An arrival overlay's suspected cost was a glitch effect doing a full-canvas
`getImageData` → per-pixel loop → `putImageData`, twice per call. It never ran.
The phase branches on `pieceTime >= 1400`, and the variant's own `artDuration` is
1,200, so `pieceTime` is bounded at 1,200 and the branch is dead — for that
variant only; the other one, at 2,600, runs it every time.

Reading the arithmetic found it, but **counting** is what settled it: patching
`CanvasRenderingContext2D.prototype.getImageData`/`putImageData` to log size and
count over one full overlay lifetime returned **0 `putImageData` calls** and 2
`getImageData`, both at viewport size and both belonging to a different function
entirely. A sampling profile agreed by omission, which is the weakest possible
form of agreement — absent entries are indistinguishable from cheap ones.

The same profile named the real top consumer: a decorative background component
animating 530 particles **behind the opaque overlay**, at 597 ms per run, more
than anything the overlay itself spent. It was not in the file under
investigation.

**Do:** before optimising a named suspect, instrument the primitive it is accused
of over-using and count calls over one real run. A census answers "did this run at
all, and how much", which is two questions a flame chart answers only by
inference. And profile the whole page, not the component you suspect: work that is
invisible is still work.

---

## 2026-09-11 — dropping a read gate re-arms every control the unread state was holding down

**Believed:** a gate like `enabled: … && useChainId() === CHAIN_ID`, on reads already pinned
with `chainId: CHAIN_ID`, only decides whether a figure shows. Delete it and the worst case is
one more RPC call.

**Found** (#526): CollectionDetailV2's Mint button had no chain term in its `disabled` expression.
Off mainnet it was held down by `!drop.priceReadOk`, and that was false only because the gated
price read never ran. Deleting the gate, correctly, lets the price land on Base, and the button
arms under its own label "Switch to Ethereum Mainnet". `mint()` refused by itself, so a click
only toasted, but the disabled state had been an accident of the read gate. Measured with the
fix in place: removing the explicit `!drop.onMainnet` from `mintDisabled` fails both connected
off-mainnet cases in `CollectionDetailV2.offMainnet.test.tsx`, on `toBeDisabled()`.

**Do:** before deleting a read gate, grep its consumers for controls that need a positive read
(`*ReadOk`, `status === 'success'`, `!== undefined`) and ask whether the gate was that control's
real guard. If it was, write the guard into the control.

**The test-side twin, same session: a guard's test can be held by an upstream copy of the
guard.** `useAutoRefreshBoost` gates on the wallet's chain, and its test "stays quiet on the
wrong chain" looked like it pinned that. It did not. The hook's input `holdsJBAC` came from
`useNFTBoost`, which carried the same gate, so off mainnet it was `null` and the hook was
disabled regardless. Measured (vitest, the original test file):
- with the pre-fix `useNFTBoost` and `useAutoRefreshBoost`'s own gate deleted, the test
  **passes**;
- with `useNFTBoost`'s gate dropped, the same deletion **fails** it.

The mutation that proves a guard is "delete this guard, with every upstream copy of it gone",
not "delete this guard" in a tree where something else still holds the line.

## 2026-09-11 — the partial-coverage scan over- AND under-reports, and a pre-fix run can fail for the wrong reason

**Believed:** the per-index scan's gap list (method: #502) is the set of reads that
publish an outage as a zero. Fix the list and the file is clean.

**Measured** on six candidate files at trunk `1325f685`. Each gap index was
adjudicated by what its zero *asserts*, then fixed and mutation-checked in PRs #508
#512 #515 #517 #518, which are still open, so those fixes are not on trunk yet:

- **It over-reports.** 25 gap indices; 15 made a claim or armed a control. Of the
  other 10: a fail-closed owner panel, two reads with no consumer, a display
  fallback, three allowances whose only failure mode is an extra Approve, two reads
  whose failure renders the same `–` as a real zero, and one claim that is **true by
  construction**. An unread `paidPerWallet` renders "No refund owed", but only on a
  cancelled sale, and `cancelSale()` reverts `CancelAfterFirstMint` once anything has
  minted. Read the contract before signalling.
- **It under-reports.** Four claim sites have no `status === 'success' ? … : 0` to
  match:
  - a collapse through an intermediate `undefined`
    (`x = ok ? r : undefined; n = x ? f(x) : 0`), twice in one hook;
  - a separate `useBalance` feeding the same "Not enough ETH" claim as a batch read;
  - an early `return { …, lpSupply: 0n }` that zeroed a value the hook *had* read,
    whenever the price feed was stale. That became "0.00% of LP supply" on the
    treasury page.
- **The claim can be the bug when the control is already safe.** A CTA was disabled
  on an unread balance before any fix, because a collapsed 0 is short of any amount.
  "Fails closed" was true, and the button still said "Not enough TOWELI" about a
  wallet nobody read.

**New vacuity shape for the pre-fix run.** Testing an unexported component meant
adding `export` in the fix. Restoring trunk's file for the pre-fix run then fails
*every* test on the missing named export. That is a red run that proves nothing about
behaviour. Reconstruct pre-fix as trunk **plus only the test-enabling change**. The
honest split was then 4 fail / 2 pass, and the 2 are the genuine-zero guard rails.

**Redundant gates make equivalent mutants.** Gating `insufficientX` on
`balanceXKnown` *and* the CTA's `disabled` on `balanceUnknown` makes removing either
one unobservable: the label checks "unknown" first, and `disabled` has the other
gate. One of two belt-and-braces gates always survives a single-line mutation.
Decide which one the tests pin and say so, rather than chasing it.

**An animated figure asserted at t=0 proves nothing.** A score ring that eases
from 0 over 1200ms of `requestAnimationFrame` is empty one frame after render
whatever the score is, so "the ring is empty during an outage" passed — and a
mutation that fills the ring from the UNDERSTATED score survived it. Driving the
clock instead killed it: `vi.useFakeTimers({ toFake: ['requestAnimationFrame',
'cancelAnimationFrame', 'performance'] })` then `act(() =>
vi.advanceTimersByTime(1500))`. That also took the file from ~4s of real waiting
(one `waitFor` was already timing out at 4000ms) to 70ms. A wall-clock wait would
have been the threshold flake this file warns about elsewhere.

**Tooling trap.** JSX *text* does not process `\u` escapes: `Minting closed —
the creator…` rendered six literal characters with tsc and eslint clean. The Claude
Code Edit tool normalises `—` in both strings, so it cannot target the literal
escape ("old_string and new_string are exactly the same"). Fix it with a script that
builds the backslash from `String.fromCharCode(92)`.

**Do:** read the scan's output as a lower bound on where to look and an upper bound
on what to fix. For each gap, write down what the zero asserts before touching it.
Reconstruct pre-fix states rather than just `git show`-ing them.

---

## 2026-09-11 — a callee that never rejects has failure shapes a `.catch` cannot see

**Believed:** a flag set in the `.catch` around a fetcher tells an outage from an empty
result. `fetchListings` relied on one to choose between "temporarily unavailable" and
"No active listings", and the first fix proposed was to read the fetcher's returned
`error` instead.

**Measured** (PR #535, vitest 4.1.11, trunk `ce4fac5e`): the native-orderbook fetcher
fails in three shapes, and the `.catch` saw only the rarest.

- A network failure **resolves** as `{ orders: [], error }`, because the fetcher's own
  `try` wraps its retry loop. With the proxy down, the real function resolved in
  3015ms, and `fetchListings` returned the healthy `source: "opensea"` with no error,
  3 runs of 3.
- The server's soft-fail for an unreachable database is a **200** with
  `degraded: true` and no `error` field at all. Reading `error` still misses it. Only
  the server's handler shows the shape exists.
- Only a chunk-load failure of the lazily imported module **rejects**.

The rule on top was too narrow as well. It called an outage only when *every* source
failed, so OpenSea down beside an empty native book still read as an empty market. A
one-line mutation back to that rule, with the flag already fixed, left 4 of 6
unread-source tests reading as healthy.

**Do:** before choosing a failure detector, list every shape the callee can produce: a
rejection, a resolved error field, and a success status carrying a soft-fail flag. For
the third, read the server. Then fold them into one shape at the callee, so no caller
has to know there were three.

### A turn-capped fake-timer drain passes alone and times out in the file

**Believed:** `for (let i = 0; i < 120 && !settled; i++) await
vi.advanceTimersByTimeAsync(500)` is a bounded way to skip a retry's sleeps.

**Measured:** in the full file two tests hit `Test timed out in 5000ms`, while alone
each ran correctly in 8–9ms. Instrumented, the trigger was an
`afterEach(() => vi.doUnmock(...))`. After it, 6 of 11 tests spent all 120 turns with
the request under test still unsent: 0 `fetch` calls when the loop exited. Four of
those settled on their own afterwards, because they had no timers left to run. The two
whose request fails needed the retry's fake timers advanced, and nothing advanced them
any more. Without that `afterEach`, the request went out at turn 0–1 in every test
that sent one. Across five variants, moving a `vi.resetModules()` test to the start or
the end changed nothing; removing the `afterEach`, or draining until settled, fixed it.

That first pre-fix run went red on the two timeouts, one of them a counter-test that
should have passed: a red for the wrong reason, like the missing export in #520.

**Do:** drain until the promise settles (`while (!settled) await
vi.advanceTimersByTimeAsync(n)`) and let the test's timeout be the bound. A turn cap
bounds turns, not the work they wait on.

## 2026-09-11 — an exact gas estimate is only good for the second it was taken in

**Believed:** if `eth_estimateGas` returns N, the same transaction against the same
state mines at limit N. (A step earlier in the same chase: that the cost was
"non-monotonic in the gas limit" — offer more gas, burn less. It was neither.)

**Measured** (anvil 1.5.1, mainnet fork, `removeLiquidityETH` on a Uniswap-V2-style
pair; automine off, every block timestamp pinned by hand with
`evm_setNextBlockTimestamp` + `evm_mine`; byte-identical calldata and state):

| estimate taken at | mined at | limit | used | result |
|---|---|---|---|---|
| T (= the pair's last update) | T | 207,033 | 163,888 | success |
| T | **T+1** | 207,033 | **206,923** | **reverted — out of gas** |
| T | T+1 | 310,549 (×1.5) | 172,080 | success |

A V2 pair's `_update` writes both cumulative prices only when `block.timestamp` has
moved since its last update. `pair.burn` cost 101,958 in the same second and 112,199
one second later: the +10,241 is exactly those two SSTOREs. **Anvil lets consecutive
blocks share a timestamp**, and a transaction sent with no `gas` is priced by anvil's
own estimate against the pending block, exact to the gas — so anything estimated in
the same second as the pair's last touch and mined in the next one is ~10k short.
"Burn less at a higher limit" was the same-second block being cheaper, not the limit.

Where it bit: an e2e bridge that forwarded the app's gas-less `eth_sendTransaction`
unpadded. The UI runs add → approve → remove inside about a second, so the remove
was often estimated in the add's second. The real spec against a fresh fork, trunk
code: 2 of 9 runs failed, both out of gas one second after the add. Padded +50%, as a
wallet would: 0 of 14, including one run where the race happened and the padding
absorbed it.

**Also measured:** anvil does **not** reject a gas-less send whose estimate fails. It
mines it at the block gas limit (60,000,000 observed) and it reverts on-chain.

**Do:** pad any transaction you hand a node without a limit. When a revert's
`gasUsed` is within ~1% of its limit it ran out of gas — look at what changed
between estimate and inclusion (timestamp, block, state), not at the arguments.

### A test that dies at 3.0m and passes in 4.8s is an unbounded wait

The first attempt ran into the whole 180s test budget; every assertion in the spec
had a 20-30s budget. The error was `locator.getAttribute: Test timeout of 180000ms
exceeded`: a Playwright locator read with no `timeout` inherits the TEST's, and the
receipt link it wanted had been removed (the surface clears it 4s after a success).
So the run printed nothing about what went wrong. A duration far beyond every
assertion budget means an unbounded wait, not a slow system — find it, and bound
every locator read that sits inside a poll.

## 2026-09-11 — anvil's `--retries` never retries a 408, and `--compute-units-per-second` never throttles

**Believed:** anvil's fork flags let it ride out a flaky upstream. Raise `--retries`,
lengthen `--fork-retry-backoff`, lower `--compute-units-per-second`, and a free RPC
plan's intermittent timeout gets absorbed.

**Checked** in the source of anvil 1.7.1 (tag `v1.7.1`, the version CI pins) and the
alloy-transport 2.0.1 it locks. The fork provider retries through alloy's
`RetryBackoffLayer`, whose `should_retry` is `TransportErrorKind::is_retry_err`: HTTP
**429 and 503** and no other status (plus a few rate-limit JSON-RPC bodies, a null
response, a missing batch item). A 408 returns on the first answer. `--retries` caps that
layer and `--fork-retry-backoff` is its sleep, so neither ever engages on a 408.
`compute_units_per_second` is read only *inside* the retry branch, to lengthen a backoff.
It is not a rate limiter and never delays a first attempt; `--no-rate-limit` just sets it
to `u64::MAX`.

**Measured** on anvil 1.5.1 (alloy-transport 1.1.1, the same predicate), with a logging
shim between anvil and drpc that answered drpc's own 408 body to the first ask of a fresh
account's reads:

| arm | `anvil_setBalance` | upstream asked |
|---|---|---|
| 408, no flags | `failed to get account … HTTP error 408` | once |
| 408, `--retries 10 --fork-retry-backoff 100` | same error | once |
| 408, `--no-rate-limit --compute-units-per-second 50 --timeout 90000` | same error | once |
| **429**, no flags (control) | ok | twice (`429,200`) |

The control is what makes "once" mean something: the counter sees a retry when anvil
makes one.

**Worse on 1.7.1 — and reproduced there.** A failed fork read inside block building hits
`apply_pre_execution_changes().expect(…)`, a panic. CI's anvil died with SIGABRT on the
EIP-2935 history-contract read (`GetStorage(0x0000f908…2935, …, HTTP error 408`) and
every later test failed in ~150ms. anvil 1.5.1 does not read that contract when mining
(checked, also under `--hardfork prague`), so this one needs the pinned binary: unzip the
release into a scratch dir and point the harness at it with an env var, leaving the
machine's `~/.foundry/bin` alone. Done that way, the panic reproduces byte-for-byte, down
to `mem/mod.rs:1324`, under every flag combination in the table — and does not happen at
all with the retry sitting below anvil.

**Do:**

- Retry *below* anvil, in front of `--fork-url`, and pass refusals (401/403/404/410)
  through on the first answer so a dead endpoint still fails in its own words.
- To learn whether a client retries status X, put a counting shim in front of it and
  inject X, **with a control status the client is known to retry**. A soak against the real
  endpoint cannot stand in for this. On 2026-09-11, 40 drpc forks at ~180 reads each saw
  zero 408s, though the same endpoint had cost 2 of 30 CI jobs. The rate moves with the
  provider's load and cannot be summoned.
- A deadline-bounded retry loop must hand back the last *real* answer when the deadline
  cuts a retry short. A first draft turned drpc's 408 into a relay-made 504 whenever a
  backoff landed the next attempt just before the deadline (a 504 at 431ms against a 400ms
  deadline, in the unit test that caught it). That swaps the upstream's words for the
  retrier's.
- **A proxy owes the client the upstream's response HEADERS, not just its body.** anvil
  builds the `HTTP diagnostics:` block in its error out of them — on a real failure that is
  `cf-ray` and `server`, the ids the provider asks you to quote. A relay answering with
  `content-type` alone loses them on the one answer that matters, the one it gave up on.
  Encoding and framing headers still stop at the proxy, because `fetch` has already decoded
  the body.

## 2026-09-11 — a gate's comment and a hook's wrong-chain notice are claims, not evidence

**Believed:** when sweeping read gates, a gate whose comment explains it, or a hook
that already tells the user it is on the wrong chain, can be left as it is.

**Measured** (PR #537: eight hooks gated on `useChainId() === CHAIN_ID`, every
read in them pinned `chainId: CHAIN_ID`):

- Three comments justified the gate with a wrong-chain read that would "silently
  return garbage" (useSwapQuote), "returns 0 garbage" (useSwapAllowance) or would
  "price another chain's assets" (`lib/portfolio/sources.ts`). All three were
  false: the per-call pin sends each of those reads to mainnet. Two of the gates
  were still right to keep, for reasons nobody had written down. A quote is the
  swap's arguments, and its aggregator leg is scoped to the wallet's chain on
  purpose. An allowance is displayed nowhere and only decides writes. The third
  gate was wrong to keep: the portfolio refused to total legs that the Dashboard
  showed beside it, read from the same contracts.
- `useWalletExposure` did signal the wrong chain. Its page said "Switch to Ethereum
  mainnet to read your holdings." Directly beneath, the same page said "No tracked
  ERC-20 balances in this wallet": the gated read left `holdings` empty, and the
  empty-state branch never looked at the flag.

**Technique:** decide a gate by what its value reaches. A displayed figure loses
the gate. A write's argument, or the only thing disarming a control, keeps it.
Re-derive the reason from the code rather than inheriting the comment, and write
the real one down. Judge "already honest" by every branch the collapsed value
reaches, not by whether a notice exists somewhere on the page.

## 2026-09-11 — a line-ending check that fires on every file is counting lines

**Believed:** `git show <rev>:<path> | grep -c $'\r'` counts a blob's CRLF lines.

**Measured:** inside a `$( … )` substitution, in the Git Bash this repo's agents
run on, it returned each file's total line count: 272 of 272, 609 of 609, and
"CRLF" for all 40 of 40 sampled hooks. It nearly got #526's replayed files
re-committed to "fix" endings that were already LF. The same substitution over a
known-LF string (`printf 'a\nb\n'`) returned 2. `tr -dc '\r' | wc -c` read 0 CR
bytes in every blob, and the replayed blobs had the same OIDs as the originals.

**Technique:** before acting on a check that reports "all N", run it on a known
negative. Count the byte (`tr -dc '\r' | wc -c`), not lines matching a pattern.
Prove a replay exact with blob OIDs (`git rev-parse <rev>:<path>`), not
`git patch-id`, which ignores whitespace.

## 2026-09-11 — a per-test timeout is a third clock, and a slow body can be a sleep

**Believed** (the candidate list in the 2026-09-10 entry "a flake-candidate list
ranked by duration mixes two clocks"): `holderOutageRender` was the one thin test
— 3528ms, "about 1.4x headroom" against the 5000ms body bound — because of its
in-body `await import()`, and `--testTimeout=2000` would reproduce it on demand,
as it had for the previous instance of this class.

**Measured** (vitest 4.1.11, trunk `dd7885ba`, each body split with
`performance.now()`, 3 runs of the file alone):

| test | bound | in-body import | the rest of the body |
|---|---|---|---|
| CollectionHealth (the "thin" one) | **20000ms**: `it(name, fn, 20000)` | 36–41ms | `findByText` **3160–3198ms** |
| HolderAnalytics | 5000ms | **276–315ms** | ~70ms |

All three beliefs were wrong.

1. **The third argument to `it()` is its own clock**, and the CLI does not
   override it. Under `--testTimeout=200` the 20000ms test passed at ~3170ms
   while its 5000ms neighbour timed out, 3 runs of 3. So read the closing
   `}, N)` before calling a test near-timeout. That entry's table is wrong for
   `holderOutageRender` :53 and for every in-body import in
   `offerBookOutageHonesty` — each of those tests passes 20000 or 30000.
2. **The slow part was a sleep, not a load.** Three seconds of that body is a
   retry backoff: `lib/orderbook.js`'s `withRetry` sleeps 1s, then 2s. It runs
   because Node's `fetch` cannot parse the relative URL `/api/orderbook` under
   jsdom (`Failed to parse URL from /api/orderbook?...`), and the code treats
   that as transient. It measured 3012–3027ms every run. A cold import grows
   with CPU load and a timer barely does, so a split that shows one near-constant
   segment of whole seconds is a timer. No import hoist moves it.
3. **A repro gate has to be sized from the split, not the reported duration.**
   `--testTimeout=2000` **passed** on the unfixed file, because the real in-body
   cost was ~300ms. A 200ms gate then failed one post-fix run of three at 235ms
   during a load spike. What separated the two cleanly: a threshold between the
   quiet pre-fix (≥292ms) and post-fix (≤98ms) durations, 165ms, with pristine
   and fixed runs **interleaved** so load drift lands on both. The unfixed file
   timed out 6 of 6 and the fixed one passed 6 of 6 (45–147ms, CPU load 3–100%).

**Do:** split a slow test with `performance.now()` before choosing a fix; read the
`it()` call's third argument before naming its bound; size any timeout gate from
the split, interleave it, and record the load next to every number.

### A timeout's second failure is a ghost

The full-suite run after the fix was the heavier of the two (415s vs 314s). In
it, `volumeFallbackHonesty`'s Hero test — 4921ms in the run before — hit `Test
timed out in 5000ms.`, and the test after it failed as well, with
`expected [ <span …(2)></span> ] to have a length of +0 but got 1`. That second
failure is not a second defect. Forcing the first test to time out
(`-t Hero --testTimeout=400`) produced the identical assertion 3 runs of 3;
letting it finish (`--testTimeout=1500`) passed 6 of 6. A timeout does not cancel
the body. Vitest stops waiting, runs cleanup and moves on, and the body resumes
when its import resolves — rendering into the next test's document.

**Do:** in a red run, fix the first timeout in a file and re-run before reading
any failure that follows it.

### Incidental

- A relative-URL `fetch` under jsdom is an instant `TypeError`. Any component
  that calls its own `/api/...` therefore runs its error path, and its retry
  schedule, in every test that renders it — whatever the test thinks it covers.
- A "mutation applied" check can be defeated by the fix's own comment. `grep -c
  'await import('` counted the new comment explaining why the import was hoisted,
  and the script correctly refused to run. Anchor the check on the code's shape
  (`= await import(`), not on a phrase a comment can repeat.
- The fix itself, full suite on the same base, before → after: HolderAnalytics
  874ms → 208ms, and a botLink signature test with the same shape 1033ms → 2ms.
  Both were measured in the heavier of the two runs.

## 2026-09-11 — a test that lets two endings race pins only the one that wins

**Believed:** the arrival curtain has a hard deadline so that it is gone within its
3,000 ms budget, and `arrival.spec.ts` asserted exactly that budget with no input, so the
deadline was taken to be under test.

**Measured:** the curtain ends on whichever comes first, its own animation or the
deadline, and on an unloaded box the animation won at about 2,880 ms. So the test never
ran the deadline: deleting the deadline timer left it green. The deadline's own bug
(armed at the budget, so always a few ms late) surfaced only when a slow CI runner let
the animation lose, at 3,002 to 3,010 ms in three tries of three (PR #524). Throttling the
CPU makes that path likely, never certain. Taking the curtain's 2D context away stops the
animation outright, and then only the deadline can end the curtain. That test failed 10
of 10 on the pre-fix build (3,011 to 3,021 ms), passed 20 of 20 on #530's fix (2,903 to
2,916 ms), and failed 4 of 4 with the deadline timer deleted.

**Technique:** when two mechanisms race to end something, test each one with the other
disabled. A test that lets them race pins only the winner on the machine running it, so
a mutation of the loser cannot fail it. Disable the rival at a boundary the test can
reach (here, an init script that makes `getContext` return null for the curtain's canvas
only), assert that the disabling happened, and assert something only the loser's path
produces (the curtain was still up when the deadline's dissolve began), so that a third
way of ending cannot pass for it.

## 2026-09-11 — a deadline armed at the budget can only be met late

**Believed:** `setTimeout(finish, BUDGET)` enforces "gone within BUDGET". The arrival
curtain's timer was armed at exactly 3,000 ms, and its e2e asserted `lifetime <= 3000`.

**Measured:** CI read the curtain at 3,002 to 3,010 ms in five tries on one PR, and the
same commit passed at 2,935 ms on a retry. A timer fires at or after its delay, the
removal it triggers still costs a render, and this timer was armed in a passive effect,
which runs after paint, so its clock started after the one the test reads. With the CPU
throttled locally, trunk's curtain lived 3,105 to 3,288 ms (x4) and 3,421 to 3,542 ms
(x6). Arming it in a layout effect and ending it 100 ms early brought those to 2,982 to
3,021 ms and 3,030 to 3,090 ms. That holds the budget at CI's load, and at x4 in five
runs of six. At x6 it still misses: the timer cannot fire until the frame in progress
ends, and on a saturated main thread nothing fires on time.

**Technique:** a timer can keep an "at most N ms" promise only by firing early. Keep a
measured slack back from the budget, bound it in a test from both sides (larger than the
lateness measured, smaller than the time the on-time path needs), and start the timer's
clock where the test's clock starts. To reproduce a few-ms timing flake locally, throttle
the CPU with CDP (`Emulation.setCPUThrottlingRate`) until the slow path is the one that
runs. Then measure the old build and the new build interleaved at the same rate, because
back-to-back batches measure the box's load as much as the change.

## 2026-09-11 — a callback prop in a useCallback's deps restarts every effect that lists it

**Believed:** listing `finalize` in a long-lived effect's dependencies was harmless,
because nothing about the component changes while it plays.

**Measured:** `finalize` was `useCallback(..., [onComplete])`, and the parent passed
`onComplete={() => setSplashDone(true)}`, a new function on every render (this build has
no React Compiler). So every render of the parent cleared the curtain's deadline and
armed a fresh one, and re-ran the canvas effect, which starts the animation again from
its first phase. A unit test showed it on trunk code: after a re-render at 2,000 ms the
deadline had not fired by 3,000 ms, and the canvas effect had run 3 times for one mount.

**Technique:** keep a callback prop out of long-lived effects' dependency chains. Hold it
in a ref updated in a layout effect, and call `ref.current` from a stable callback. Test
it by re-rendering with a NEW function and asserting two things: the effect did not
re-run (count something it does once per run, here `getContext`), and the new function
is the one that gets called.

### A callback prop in an effect's deps is only a bug if the SETUP has side effects

A sweep flagged five components that list an `onClose` prop in an effect's deps
while the parent passes an inline arrow, so the effect tears down and re-runs on
every parent render. Only **two** were worth changing.

The separator is what the effect's *setup* does:

- **Real:** setup focuses an element or locks body scroll. Every parent render
  runs cleanup (restore focus to the opener) then setup (focus the panel), so the
  caret is yanked away from whoever is typing and the scroll-lock save/restore
  churns. `SolanaSwapPage` re-renders about once a second while a quote is live.
- **Benign:** setup only does `addEventListener`. Removing and re-adding the same
  document listener in the same tick is invisible. Three of the five were this,
  and their focus / scroll-lock effects already carried correct deps.

**Do:** classify by what the setup *does* before fixing all N. "Prop in deps" is a
smell, not a defect; fixing the benign ones is churn in files you then owe a
re-verify.

**The measurement that settles it**, and it is cheap: spy on
`HTMLElement.prototype.focus`, render the component under a parent that re-renders,
and count. Pre-fix, one re-render moved the count 1 -> 3 -- +2 per render, one from
the cleanup and one from the setup. That +2 *is* the caret theft, and it makes the
invariant ("a parent re-render adds no focus calls") pinnable without asserting any
literal about dep arrays.

Fix shape is the latest-ref: hold the prop in a ref updated in a layout effect, read
`ref.current` from the handler, and let the setup effect be mount-scoped.

## 2026-09-11 — a local fallback that accepts a bad argument hides it until production

**Believed:** a green unit suite plus a working dev server means a rate-limited
API handler works, because every call to the limiter goes through the same module
in both places.

**Measured:** `/api/aggregator?resource=tape` answered `500
FUNCTION_INVOCATION_FAILED` on every production request (both domains, reproduced
with curl) while its unit suite and every local run were green. The handler called
the global limiter without `windowSec`. The shared limiter builds Upstash's sliding
window as `` `${windowSec} s` ``, so production built `"undefined s"` and Upstash
threw ("Unable to parse window size"). Off Vercel the same module falls back to an
in-memory limiter, which took `undefined` without complaint: the window became
`NaN` and never reset, and nothing threw. The handler's own suite mocked the limiter
module entirely. Three layers each looked fine: the mock, the fallback, and an
untyped options object.

**Technique:** when a library has a lenient local fallback and a strict production
backend, test the ARGUMENTS a caller passes, not the fallback's behaviour. Here:
assert the mocked limiter was called with `windowSec`, and add a source check that
every call site passes one (45 of them; one was missing it). No runtime test can see
this class, because every path the tests reach is the lenient one.

## 2026-09-11 — a guard calibrated in CI measures CI's environment, not production's

**Believed:** an exact-count e2e guard that is green in CI means the deployed page
reads the same, because the bundle is byte-identical.

**Measured:** the same per-route spec (a count of prose em dashes, asserted exactly),
run against production after a deploy, read five routes differently: `/chart` 36
against CI's 0, `/developers` 11 (10), `/copy-trading` 12 (11), `/alerts` 14 (17),
`/launch` 30 (31). The bundle was identical; the environment was not. Production had
an indexer URL configured and answering, serverless functions running, and push
keys set. CI's `vite preview` build had none of the three, so no branch gated on them
ever rendered there. `/chart`'s 36 were tooltips and table rows on the indexed chart,
a branch CI can never reach.

**Technique:** write down where a guard's numbers hold, and for branches CI cannot
render, pin the copy at the source instead (here, a scan of the chart's components,
its lib and the hooks that feed it). Then run the same guard against production
after each deploy: every difference is an environment-gated branch the CI run never
saw.

## 2026-09-11 — a test for one clause of an OR is vacuous under an all-fail fixture

**Believed:** "every read fails" is the strongest fixture for an unread flag. If the
flag fires when everything fails, it fires.

**Measured** (PR #514, `useLPFarming`'s
`statsUnread = poolStatsUnread || minStakeUnread || <clause over four more reads>`):
with a chain term put back on the clause alone, both new tests, one hook-level and
one rendered, still PASSED, 60/60, under an all-fail fixture. `poolStatsUnread` had
set the union by itself, so the clause under test never decided anything. Failing
ONE leg that only the clause covers, while the totals and the minimum land, the same
mutation failed exactly 6 of 63.

**Do:** to test one member of an OR, make every other member false, and assert that
they are false in the test itself. Then the member under test is the only thing
that can answer. "Everything failed" tests the union, not the clause.

## 2026-09-10 — a reverted tx renders no receipt, so DOM assertions blame the UI

**Believed:** asserting a receipt link appeared is a sufficient check that a money-path
transaction landed.

It is not, and the failure mode is actively misleading. These surfaces render **one**
receipt line, for **any** confirmed transaction (an approval included), and render
**nothing at all** for a reverted one. So when a burn reverts, the assertion is left
looking at whichever earlier receipt is still on screen. The same single root cause
produced three different messages depending only on poll timing — the previous step's
receipt still being up, an approval's receipt satisfying the check and a puzzling
failure four lines later, or no link at all. None of them says "it reverted".

**Do:** on a fork, read the transaction's fate off the node, not off the DOM —
`expectMinedSuccessfully(page, what, forkTxCount(page))` in `e2e/fixtures/wallet.ts`.
Assert the chain *first*, then keep the DOM assertion; one pins the chain, the other
pins the UI.

---

## 2026-09-10 — pinning a fork block costs you the archive, and then the deadline

Two traps that both look like "the app is broken", both hit while pinning
`ANVIL_FORK_BLOCK` to reproduce a flake.

**1. A pinned block is an archive request.** Forking at *latest* works on every public
endpoint; forking at a block a few hours old does not. Measured, forking at a block
~1,900 behind head: `eth.drpc.org` 408 "Request timeout on the free plan",
`ethereum-rpc.publicnode.com` 403, `eth.merkle.io` 429, `1rpc.io` and
`eth.rpc.blxrbdn.com` "historical state not available". Working:
`eth-mainnet.public.blastapi.io`, `gateway.tenderly.co/public/mainnet`,
`rpc.flashbots.net`. CI does not pin, so CI is unaffected — this bites the person
reproducing.

**2. A pinned block's clock lags, and every router call then reverts.** The app stamps
`deadline = Date.now()/1000 + 1800` from the *browser's* clock;
`TegridyRouter.MAX_DEADLINE` is 2 hours. So once the fork's `block.timestamp` lags
wall-clock by more than **90 minutes**, every add, remove and swap reverts
`DEADLINE_TOO_FAR` — not `EXPIRED`. Pinning a block that was fresh in the morning and
re-running it after lunch silently converts a working suite into a wall of failures.
This is the mirror of the `advanceForkTime` trap already noted in `wallet.ts`: pushing
the chain *ahead* gives `EXPIRED`, letting it fall *behind* gives `DEADLINE_TOO_FAR`.

---

## 2026-09-10 — zeroing an input does not withdraw the claim built on it

**Believed:** F100 fixed "the LP farm advertises a live APR after its reward
period ends" by zeroing the reward rate once `periodFinish` passed. Its commit
said the UI would "never advertise a dead emission schedule". The per-day tile
did read 0, so the fix looked complete.

**Measured** by mounting the real `useLPFarming` hook under `LPFarmingSection`
with mainnet's own state: past `periodFinish` 1781493095, and a residual
`rewardRate` of 3306878306878306 still in storage. The APR hero rendered `0.00%`
in green, captioned "estimated from staked TVL · falls as more LP is staked".
The derived figure's null-guard tested whether its *inputs* were present (pool
loaded, supply non-zero, something staked, price positive), and they all were.
A zero numerator over a finite denominator is a well-formed number, so the guard
let it through as a confident, live-looking APR. The caption written for the
ended state sat in the null branch the guard never took, so it was unreachable
in exactly the state it was written for.

**Do:** when a fix neutralises an input by setting it to 0, don't stop at that
input. Trace every value derived from it, and ask whether the zero reaches the
screen as "absent" or as "zero". Guards that test whether data is present cannot
see a semantic state such as "ended". The state has to be passed down as its own
flag and checked first. An unreachable branch whose copy names a real state is
the cheapest detector there is.

### A counter-test's fixture default can pin the next bug

A sibling PR on the same section added a "genuine zero" counter-test, `reports
a real empty farm as 0, and keeps the invitation`. Its point was sound: an empty
farm is publishable, and a fix that blanked every zero would be a bug. But its
base fixture was documented as "all reads landed, on an **ended** schedule with
nothing staked". So it asserted "be the first to stake LP" on a farm paying
nothing, which is exactly the bug above. Merging the two branches locally left
**1 failure in 103: that test**. Giving it a live schedule made it 103/103.
"Every read landed, every value zero" is not a neutral state. It is a specific
state of the system, with claims attached.

**Do:** in a counter-test ("the honest case must still render X"), set the state
the claim depends on explicitly, and never inherit it from a base fixture's
defaults. Before calling a fix done, list open PRs (`gh pr list --state open`),
check which of them touch your files (`gh pr diff <n> --name-only`), merge the
overlapping ones into a throwaway branch, and run both suites. Two PRs can each
be green and still contradict each other.

Aside, from the same simulation: `git merge --abort` refuses ("not uptodate")
once you edit a file the merge *added*. On a throwaway branch that still points
at your own HEAD, `git reset --hard` is the clean exit.

## 2026-09-10 — "deployed == source" means the BROADCAST's commit, and a write mock never encodes

**Believed:** to confirm a live contract behaves like `contracts/src`, build trunk
and compare it with the chain; and a hook test that asserts
`functionName: 'x'` on the wagmi write mock proves the button can send `x`.

**Measured** on TegridyStaking (`0xcaDc93E96De58EA554c71ca609974625615E046D`) while
re-wiring its paused exit (#510):

- **Trunk was the wrong build target.** Five commits had touched
  `TegridyStaking.sol` since the deploy. The Foundry broadcast
  (`contracts/broadcast/<Script>.s.sol/<chainId>/run-latest.json`) records a
  top-level `"commit"`, here `833b757`. Built at that commit in a detached
  worktree (`forge build src/TegridyStaking.sol`, via_ir, 21 s wall), the executable
  runtime matched the chain byte for byte: **24,284 of 24,337 bytes.**
- **The other 53 bytes are CBOR metadata, and they did not match although the
  code did.** A metadata mismatch is not a code mismatch. Strip
  `2 + uint16(last two bytes)` from the end of both before comparing.
- **Two kinds of slot differ by construction; handle both rather than skipping
  them.** Library link slots (`deployedBytecode.linkReferences`): fill them from
  the broadcast's `libraries` and assert the chain holds the same 20 bytes at
  every offset (10 of 10 matched). Immutables (`immutableReferences`) compile as
  zeros: adopt the chain's values and PRINT them, so a wrong constructor argument
  is visible (20 slots, 2 addresses).
- **A wagmi write mock never ABI-encodes.** With the new ABI entry deleted
  (mutation), 58 of 59 tests in the affected files still passed, including the
  one asserting `functionName: 'emergencyWithdrawPosition'`. A real wallet would
  have thrown `AbiFunctionNotFoundError` at encode time. The only test that
  failed runs `encodeFunctionData` against the real ABI and checks the selector
  (`0x5f667fc0`) read out of the deployed dispatcher, which pins the ABI to the
  chain and not just to itself.
- **Fork-proving behaviour does not need the repo's build.** A standalone Foundry
  project (only `forge-std` plus an inline interface) compiled 20 files in 2.3 s,
  and 4 tests against `vm.createSelectFork("https://eth.drpc.org")` ran in 10 s.
  Every call hit the on-chain bytecode, so repo source was not what got tested.
  Make the rig BINDING first: top up the reward reserve and assert
  `earned() > 0` before comparing "pays" with "forfeits". Otherwise both look
  like "returned the principal".

**Do:** before changing UI semantics on a live contract, build the broadcast's
`commit`, not trunk, and compare with metadata stripped, link slots asserted and
immutables printed. Then diff just the functions you depend on between that
commit and trunk. For every hand-written ABI entry a button relies on, keep one
test that ENCODES the call against the real ABI.

---

## 2026-09-10 — the retry's error is not the failure's error

**Believed:** when an E2E test fails all three attempts, the last attempt's error
is the failure — and a money-path spec that goes red on the first trunk commit
containing a PR that touched that page is that PR's regression.

**Observed** (`E2E Tests (Anvil fork — money paths)`, trunk `1325f685`, run
`34558450845`, `e2e/stake.spec.ts` stake → claim → unstake):

| attempt | error |
|---|---|
| 1 | `anvil_setBalance: failed to get account … HTTP error 408 … "Request timeout on the free plan, please upgrade to paid plan"` |
| retry #1 | `stake: no explorer link to a transaction hash appeared` (30s) |
| retry #2 | the same, 30s |

Only attempt 1 named the cause: the fork's upstream RPC refused during test
setup. Both retries reported a downstream symptom that reads exactly like an app
defect — on a commit that had just merged a change to `/farm`.

**Re-running the same job on the same SHA: 22/22 clean, 0 flaky.** Same code,
different outcome — the upstream, not the merge.

**Do**, when a fork-backed E2E goes red:

1. Read attempt 1's error, not the last retry's. Here only attempt 1 named the
   cause.
2. Grep the log for the upstream's own words — `free plan`, `HTTP error 4`,
   `failed to get account` — before reading any assertion.
3. Re-run the job on the same SHA. It is the one test that separates "the code
   changed" from "the world changed", and it costs a single job.

The fork upstream is `eth.drpc.org`'s keyless tier (`.github/workflows/ci.yml`).
Until a funded key goes in `secrets.ANVIL_FORK_URL`, expect this to recur — and
to land on whichever PR merged last.

## 2026-09-10 — a guard that cannot fire is armed, not inert

**Believed:** a condition that is always true under the current config is dead
weight at worst. `enabled: isDeployed && chainId === CHAIN_ID` on a read that is
already pinned `chainId: CHAIN_ID` looks like harmless belt-and-braces.

**Measured** (`@wagmi/core` 3.6.5 source as installed, git history, and a real
browser):

- Under a ONE-chain wagmi config, `useChainId()` cannot leave that chain.
  `createConfig` ignores a connector's move to an unconfigured chain ("If chain
  is not configured, then don't switch over to it"), and `validatePersistedChainId`
  rejects an unconfigured persisted one. The gate was added (R043, 2026-04-26)
  under `chains: [mainnet]`, so it was always true and never observed doing
  anything.
- Adding Base and Robinhood (2026-08-21) made `useChainId()` follow the wallet.
  That commit pinned 135 reads so they would come from mainnet "exactly as
  before", and left the gates next to those pins alone. From that day the gates
  fired, and nothing had ever tested what happens when they do.
- `useChainId()` is a PERSISTED store value, not "the wallet's chain":
  `partialize` writes `chainId` to localStorage and `actions/disconnect.js` never
  resets it. In Playwright Chromium, logged out, with `wagmi.store` seeded
  `{ chainId: 8453, current: null }` (what a disconnect leaves behind), the store
  still read 8453 after the app loaded.
- A disabled TanStack query is neither loading nor failed. `isLoading` is
  `isPending && isFetching` (query-core `queryObserver.js`), fetchStatus is
  `idle`, and `data` is undefined. So there is no skeleton, every per-index
  `status` check reads as not-success, and any unread flag scoped by the same
  gate stays silent. In that browser run the LP farm printed "Total LP Staked
  0.0000", "Total Funded 0 TOWELI" and "be the first to stake LP" on 8453, while
  the same run on chain 1 printed 528.1998 and 2,000 TOWELI. With the gate
  removed, both chains printed the chain-1 text.

**Why no test saw it:** the shared wagmi mock answered reads whatever
`query.enabled` said, so every gate was invisible to every test that used it.
Making it honour `enabled` broke exactly one suite of 38 (`useBribes.test.ts`,
5 tests). Those tests stubbed reads of a contract whose address is zeroed, which
are reads production never issues.

**Do:**
- When a config widens (one chain to many, a flag to a list), grep for guards
  that compare against the OLD single value. They change meaning with no diff.
- Treat `useChainId()` as "last known chain", including for disconnected
  visitors. Gate WRITES on it; pin READS with `chainId` instead of gating them.
- A test double must refuse what the real thing refuses. A mock that serves
  disabled queries turns every `enabled:` condition into untested code.

## 2026-09-10 — a partial-coverage gap gets fixed one leg at a time, by whoever trips on which leg

**Believed:** a green `node frontend/scripts/check-unread-signal.mjs` means no file
outside its baseline publishes an unread contract read as a zero.

**Measured:** the guard's verdict is one `SIGNAL_RE.test(src)` per **file**, so one
`…Unread` flag anywhere passes a file that collapses eleven reads and signals three.
At `f8bda8b9`, `useLPFarming.ts` was exactly that: `positionUnread` over indices 5–7,
nothing over the other eight, beside a green guard. It then took **three separate
changes** to cover the farm-wide reads of that one file, each fixing the leg it had
tripped over: `3610c147` (MIN_STAKE, [10]), `7d6fdab6` (the pool totals, [0][4]) and
#499 (the rest of the set, [1][2][3][9]). `032af111` has since put this shape on the
guard's printed blind-spot list and added a census, which on trunk `1325f685` reads
**16 files, 69 collapse sites** exempted by a file-scoped signal. By its own comment
the census measures exposure and does not go down as legs are fixed — so it cannot
say *which* reads are unguarded.

**Do:** turn the census into findings with a per-index diff, per `data`-ish variable:

- collapsed = `X?.[i]?.status === 'success' ? … : 0n | 0 | [] | false | ''`
- covered = `X?.[i]?.status !== 'success'` — **and** the bare `X[i]?.status` form
  written after a `!!data` guard, **and** `=== 'success'` inside a positive-polarity
  `const …ReadOk = …;` flag. Without the last two the scan reported covered reads as
  gaps (two false alarms on trunk) and missed a real signal (`useNFTDropV2.ts:111`).
- Match the ternary's middle with `[^;]{0,200}?`, **not** `[\s\S]{0,200}?`. The
  permissive form lets a lazy match run into the next statement, pairing an index
  whose fallback is *not* a zero with the next line's `: ''` — it reported the wrong
  index and hid the real one until tightened.

The output is a candidate list, not a verdict. On trunk `1325f685` it finds eight
guard-passing files with uncovered collapses. Adjudicated: `useLPFarming` [1][2][3][9]
(#499; [8] is left out on purpose, see below); `useUserPosition` [3], where `paused`
collapses to `false`; and `useNFTDropV2`, which signals index 1 of its eleven
collapses, so an unread `maxSupply` makes `isSoldOut = maxSupply > 0 && …` read "not
sold out". Not yet adjudicated: `AMMSection`, `useAddLiquidity`, `useFarmStats`,
`usePoints`, `usePoolTVL`.

**A gap is not automatically a bug — ask which way the zero fails, then what it
costs.** In the same batch, `allowance → 0n` reads "not approved": no stake is ever
armed on it, but Approve re-arms after every approval while the read keeps failing,
so "fails closed" is not a bound on cost. `MIN_STAKE → 0n` fails the other way —
`minStake > 0n && …` *disarms* the minimum guard — and is still deliberately not
blocked: the contract enforces the minimum regardless, so the section says the
minimum is unread and leaves Stake armed, because refusing a legitimate stake over one
unanswered read of a constant costs more than a revert. Same collapse, same batch,
three different right answers.

### How a read failure actually arrives on this stack

**Believed:** a whole-batch failure leaves `data` undefined; and one hook's eleven
calls cannot be split across requests, because `lib/wagmi.ts` configures no `batch`.
Both wrong — and #499 was first written, reviewed and committed against them.

**Measured** (installed wagmi 3.7.7, @wagmi/core 3.6.5, viem 2.56.1 — read from source):

- The query does **not** reject. `allowFailure` defaults to `true` (viem
  `actions/public/multicall.js:54`; @wagmi/core `actions/readContracts.js:5`). A
  rejected aggregate3 request becomes one `status: 'failure'` entry per call
  (`multicall.js:164-174`), and any other throw falls back to per-call `allSettled`
  failure entries (`readContracts.js:33-42`; only `ContractFunctionExecutionError` is
  rethrown). A total outage is eleven `'failure'` entries with `data` **defined** and
  `isError` **false**. `data` is undefined only before the first fetch or while the
  query is disabled.
- Absent config is not "off": @wagmi/core `createConfig.js:132` defaults
  `batch: { multicall: true }`. Every call is then queued into one scheduler shared by
  the whole client and cut into aggregate3 requests at 1024 bytes of calldata, so one
  hook's reads can land in different requests and fail independently.

So on this stack `!data` and `isError` catch **no** RPC failure, whole or partial —
only per-index `status` checks do. Partial failure exists by construction; how often
it happens in production has not been measured.

**Do:** before reasoning from what a config file leaves out, read the library's
default for it. Before writing "the query failed", check whether the library can make
the query fail at all.

---

## 2026-09-10 — an accordion that unmounts closed answers is invisible to every DOM audit

**Believed:** mounting an accordion's answer only while it is open
(`{isOpen && <div id={panelId}>…</div>}`, framer-motion's `AnimatePresence`
pattern) is the accessible shape, as long as the button carries `aria-expanded`
and `aria-controls`.

**Measured** on `/faq` with the repo's axe sweep (`e2e/a11y-routes.spec.ts`,
Chromium, production build under `vite preview`, `--workers=1`). The route carried
`aria-valid-attr-value` as a known violation: every closed button's
`aria-controls` named an id that was not in the document. With every panel always
rendered and given the `hidden` attribute while closed, the finding is gone. The
route's exact known-violation list went from `['aria-valid-attr-value']` to `[]`
and the sweep stayed green.

**The second cost is silent.** Anything that reads the page's text (a
banned-string guard, a copy census, an em-dash count) has nothing to read in an
answer that is not mounted, so on an unmount-on-close page it checks the
questions and nothing else. Seen directly with the panels mounted: one forbidden
answer added under a harmless question ("How does staking work?") turned the
voice census red, although that answer was closed and nothing on screen showed
it.

**Technique:** keep the panel mounted and toggle `hidden`. That takes it out of
view and out of the accessibility tree, so a screen reader still meets only the
open answer, while its text stays in the DOM. A walker that judges a page's copy
must then NOT skip `hidden` subtrees. Skipping `aria-hidden` is still right,
because that marks decoration rather than content.

## 2026-09-10 — `toHaveURL(/x$/)` anchors on the query string, and a redirect inside a lazy page waits for that page

**Believed:** after `page.goto('/swap?tab=liquidity')`, `await expect(page).toHaveURL(/liquidity$/)`
proves the app redirected to `/liquidity`.

**Measured** (Playwright 1.62, chromium, `frontend/e2e/liquidity.spec.ts`, 50 runs with an
init script logging every `history.replaceState`): the assertion passed on its first poll
while the page was still on `http://host/swap?tab=liquidity` in **48 of 50** runs — that
URL ends in "liquidity" too. The line asserted nothing; the only real wait was the next
one (the `h1`), so a failure "at the URL check" was really the heading line. Assert the
path: `toHaveURL(url => url.pathname === '/liquidity')`.

**Second trap, same test.** The redirect was a `useEffect` inside the lazy page it was
redirecting *away from*. A stack captured inside the `replaceState` hook named
`TradePage-<hash>.js` as the caller, and the request log gave the order: host chunk →
page chunk (109 KB) → full swap render → *then* the destination's two chunks — four
serial lazy loads where a direct visit has two. Moving it to a route-level `<Navigate>`,
normalised to each run's `load` event under 8 workers: redirect p50 665ms → 164ms,
heading p50 1274ms → 728ms, runs that fetched the swap chunks 30/30 → 0/30.

**Reproducing it:** 50 unthrottled runs, at 1 and at 8 workers, never failed. A 6x CDP
CPU throttle (`Emulation.setCPUThrottlingRate`, chromium only) reproduced the reported
failure in 1 of 5 — URL check passed on `/swap?tab=liquidity`, then the heading timed
out after 5s with `Received string: "Swap"`, the redirect firing 6.6s after `load` —
while the fixed build passed 5/5 with the redirect at most 1.05s after `load`. A load
flake you cannot reproduce is a throttle level you have not tried.

**Do:** decide URL-only redirects where the URL is first read (the route element), never
in an effect inside a lazy component. To pin it, *hold* the chunks the redirect must not
need — `page.route(pattern, () => {})` never answers — so a regression fails every run,
not only the slow one (pre-fix: 4/4 device projects failed; post-fix: 4/4 passed). Pair
it with a control that the pattern still matches a request somewhere, or a chunk rename
silently turns the hold into a no-op.

---

## 2026-09-10 — a waited `count()` can still be vacuous: the role was wrong

**Believed:** a `count()`-gated assertion that reads 0 right after `page.goto` is
a timing bug. Wait for the page to mount and the count becomes honest.

**Measured** (#519: `e2e/a11y-smoke.spec.ts`, "TradePage swap amount input has a
contextual aria-label", instrumented; all four device projects at `--workers=1`,
production build under `vite preview`). The old test ran `goto('/swap')`, then
`if ((await getByRole('textbox', { name: /amount of .* to pay/i }).count()) > 0)`
assert visible. `count()` read 0 on every project:

| project | count() ran at | route mounted then? | count() |
|---|---|---|---|
| chromium | +153ms after load | no (skeleton `aria-busy`) | 0 |
| iphone-safari | +739ms | no | 0 |
| ipad-safari | +152ms | no | 0 |
| mobile-chrome | +902ms | **yes**, input in the DOM | **0** |

After mount, on every project: textbox **0**, spinbutton **1**.

`<input type="number">` has the implicit role **spinbutton**, not textbox, and
Playwright's role engine follows that mapping. So `getByRole('textbox')` never
matches a number input. There's no error and no timeout, just 0. A fix that
waited for mount and kept the textbox locator would have been exactly as vacuous,
with a convincing-looking wait in front of it. mobile-chrome is the proof: the
timing was already fine there, and the count was still 0.

Mutation check: with the label changed so it no longer matched, the OLD test
still PASSED 4/4. The rewrite locates the input by structure, then asserts
`toHaveAccessibleName`. It FAILED 4/4 with
`Received string: "Amount of ETH a11ymutant"`, a value rather than
"element not found".

**Do:** before trusting a role locator on an `<input>`, read its `type`: number →
spinbutton, range → slider, search → searchbox. When a conditional reads 0,
separate "not there yet" from "never matches": count the raw CSS selector next to
the role locator, before and after mount.

### A fix recipe derived from one gate can miss the second

Its sibling test (OnboardingModal) skipped on every run. The known reason was
real: the fixture pre-seeds the modal's seen-key. But clearing the key alone still
rendered nothing: no dialog within 8s, 4/4 projects. That's because a second,
unrelated condition decides whether the auto-open variant is mounted at all.
Written straight into the test, the one-gate recipe would have turned a false
green into a new red.

**Do:** run a fix recipe as a probe (log the state it claims to produce) before
encoding it as an assertion. A skip reason that was never measured can be wrong
twice.

---

## 2026-09-10 — a flake-candidate list ranked by duration mixes two clocks

**Believed:** a list of slow tests with "headroom vs 5000ms" is a fix queue, and
the fix for a cold `await import(...)` inside a test is to hoist it to a static
import at the top of the file.

**Checked** against the source of four candidates listed that way:

| file | the import sits in | bound |
|---|---|---|
| `holderOutageRender.test.jsx` :34, :53 | `it()` body | 5000ms |
| `offerBookOutageHonesty.test.jsx` :48 (and 9 more at the same depth) | `it()` body | 5000ms |
| `offerErrorHonesty.test.jsx` :85 | top-level `beforeEach` | **10000ms** |
| `cancelAllWalletGuard.test.jsx` :124-125 | top-level `beforeEach` | **10000ms** |

*Corrected 2026-09-11 (see "a per-test timeout is a third clock, and a slow body
can be a sleep"): `holderOutageRender` :53 and every in-body import in
`offerBookOutageHonesty` sit in tests that pass an explicit `20000` or `30000`,
so neither is on the 5000ms clock.*

Half the list was on the other clock. And `cancelAllWalletGuard` calls
`vi.resetModules()` before that import **on purpose**: its comment says a static
import "would give them two" `CollectionContext` instances, so the provider and the
component would stop sharing state. Hoisting it would not fix a flake; it would
break the thing the test exists to check.

**Do**, before touching any slow-test candidate:

1. Find where the cost sits — body (5s) or hook (10s). See the entry below.
2. `grep resetModules` in the file. If it resets, a hoist is illegal. The only move
   that keeps module identity is a bare warming import at the top, because every
   post-reset import still comes from one registry.
3. Only then rank by duration.

Measured on merged trunk `f8bda8b9` (full suite, 588 files / 8343 tests, 0
failures, a quiet 188s run), slowest test per file: `holderOutageRender` **3528ms,
its import in the body — about 1.4x headroom, the only thin one** ·
`offerBookOutageHonesty` 1810ms · `offerErrorHonesty` 1638ms (hook plus one body
import, not split) · `cancelAllWalletGuard` 1494ms (hook) · `bot-noncustodial`
251ms — the same test that was seen timing out at 5020ms under heavy load. One run
ranks nothing.

**The general form:** a conclusion is only as wide as the population screened. The
first sweep for this flake class looked only at files that reset inside hooks,
found nothing close to its bound, and reported that — while a body-bound test sat
at 1.4x in a directory the sweep never covered.

## 2026-09-10 — "flaky" can be a UI defect, and a warn-only gate hides it forever

**Believed:** a test that fails then passes on retry is nondeterministic — timing
noise in the harness — and a CI job that ends green has nothing to report.

**Measured** (`e2e/claim-rewards.spec.ts`, the Anvil-fork job, six consecutive CI
runs on trunk, read from the job logs):

| outcome | attempt 1 | retry #1 |
|---|---|---|
| clean pass | 2.5s / 3.8s / 3.9s | — |
| fail → pass | 6.4s / 6.4s / 6.7s | 2.6s / 2.6s / 3.3s |

(Whole-test durations, not read latency — 5s of each failure was the assertion
waiting and giving up, so the underlying read is known only to EXCEED 5s. Its
ceiling was never observed, because nothing waited long enough to see it. Worth
saying out loud: a failed assertion measures your budget, not the thing.)

The retry is not a second roll of the same die. Attempt 1 pays an Anvil fork's
COLD state — the first read of every storage slot is a round trip to the public
upstream — and by retry the fork has cached it. **A retry that is consistently
~2.5x faster than the attempt it replaces is measuring a warm cache, not luck.**
That signature separates "slow" from "broken" before you read any app code.

The 5s number on the other side of it is Playwright's default `expect` timeout.
Nothing in the repo chose it; the assertion simply never named one, and the
cold-fork cost straddles it.

**Do:** when a test is called flaky, diff attempt-1 against retry duration first.
Comparable → nondeterminism. Retry much faster → first-run cost, and the fix is
either a named budget or removing the dependency on that cost.

### The gate that let it live on trunk

`playwright.config.ts` sets `retries: process.env.CI ? 2 : 0`, and ci.yml's
money-path guard fails the run on `skipped != 0` but only `::warning`s on
`flaky != 0` — deliberately, so one fork-RPC flake cannot read as a coverage
loss. Both decisions are individually right. Together they mean a defect that
fails EVERY first attempt still produces a green job, forever, with the evidence
sitting in a warning nobody opens.

**Do:** a warn-only flaky lane needs someone reading the warnings. Grep job logs
for `passed only on retry` across recent runs — a title that appears in most of
them is not flaky, it is failing with a retry budget covering for it.

### The defect underneath: a skeleton that hides its section's name

`LPFarmingSection` early-returned a loading skeleton that drew two grey
`animate-pulse` bars where its `<h2>LP Farming</h2>` and subtitle go. Both are
compile-time constants — no read gates them — so the section withheld its own
identity for the length of an RPC round trip: an unnamed region to a screen
reader, and the one unlabelled box among five labelled sections to everyone else.

That is not a brief flicker. Read from the installed packages, not from docs:
viem 2.56.1's `http` transport defaults to a **10s** timeout and retries **3x**
per transport (`buildRequest.js`: `retryCount = 3`), the app puts two endpoints
behind a `fallback`, and `App.tsx` sets `retry: 2` on the QueryClient with
TanStack's default backoff (`min(1000 * 2**n, 30000)` — 1s then 2s). A degraded
RPC therefore holds a "loading" state for tens of seconds.

**Do:** a skeleton should shimmer what the read decides and print what it does
not. Text that is a literal in the component has nothing to wait for.

### Why this made the test unfixable-by-timeout

The assertion was `getByRole('heading', {name: /lp farming/i})`. With no heading
in the skeleton, that single locator had to mean two different things — "the
section mounted" and "its reads landed" — so there was no budget that was both
tight enough to catch a section wedged in its skeleton and loose enough to
tolerate a cold fork. Splitting it (heading = mounted, a read-derived stat =
landed, each with its own budget) is what made a named timeout honest rather
than a way to stop the test complaining.

**Do:** if you cannot pick a timeout without trading away a real failure, the
assertion is conflating two facts. Split it before tuning the number.

### Incidental

- `anvil.exe` and `cast.exe` are blocked by Windows Application Control on this
  box, sandboxed or not ("An Application Control policy has blocked this file").
  The fork job cannot be reproduced locally here — CI job logs are the
  measurement of record. `vitest` and `playwright` (mock mode) run fine.
- The default preview port 4173 is routinely held by another session's `vite
  preview`, and `playwright.config.ts` sets `reuseExistingServer: !CI` — so a
  local run silently tests whatever build that server holds. Verify the port is
  free (`netstat -ano | grep :4173`) or run with a config on another port.

---

## 2026-09-10 — a slow vitest "test" is often a slow *hook*, and hooks get 10s

**Believed:** a test reported at 2353ms is 2353ms from its 5000ms `testTimeout`,
so ranking tests by reported duration ranks them by flake risk.

**Measured** (vitest 4.1.11, `frontend/`):

| construct | bound | failure text |
|---|---|---|
| test body | **5000ms** | `Test timed out in 5000ms.` |
| `beforeEach` | **10000ms** | `Hook timed out in 10000ms.` |

A 6s `beforeEach` **passes**, and vitest reports the test as 6016ms — hook time is
folded into the *test's* duration. So a "2.3s test" whose body is
`expect(x).toBe(1)` is really a 2.3s hook with 4x headroom, not 2x.

**Do:** before calling a slow test near-timeout, find out whether its cost is in a
hook or a body. Duration alone does not rank risk.

### The cheap fix when the cost is one cold module load

Files that do `vi.resetModules()` + `await import(...)` pay the cold
fetch+transform **once**, in whichever block runs first; every later re-import is
~1ms, because `resetModules` clears the module *registry*, not the transform
cache. A bare top-level `import "../thing.js";` warms the graph during collection,
which nothing bounds, and leaves every reset in place.

Measured under full-suite load (581 files / 8145 tests): 2353ms → **5ms** and
3173ms → **11ms**, with zero source changes. Comment it as NOT dead code, or the
next reader deletes an import that appears unused.

### When you may NOT replace resets with a seam

Swapping per-test `vi.resetModules()` + re-import for a static import plus an
exported `__resetXCaches()` is only sound if the module reads env **exclusively
inside functions** and the seam clears **all** its top-level mutable state.

- `frontend/api/_lib/apiAuth.js` **qualifies** — env is read inside `getRedis()` /
  `getKeyStore()`, and `__resetApiAuthCaches()` clears all five memos.
- `frontend/api/_lib/seaport-verify.js` **does not** — `SEAPORT_CHAIN_ID` and
  `IS_PRODUCTION` are read at module scope, `_publicClient` has no seam, and two
  tests assert the *throw module scope raises* on a bad chain id, which a static
  import cannot express at all.
- `frontend/api/orderbook.js` **does not** — `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`
  are read at module scope and feed a `createClient` **singleton**, with no seam.

**Do:** grep the module for top-level `let` / `var` / `new Map()` / `new Set()` and
for `process.env` outside a function body, *before* touching the test.

### Run the mutation check AFTER the change, not only before

Neutering the resets in `orderbook.bundle-guards.test.js` failed **0** tests before
the warming import — the reset was inert, true only by coincidence, because every
block set identical env. After the import it fails **22**: the warmed instance is
evaluated before any `beforeEach` sets the Supabase env, so its client is `null`
and only the per-block re-import picks up a live one.

The change turned a coincidence into a pinned invariant — but a pre-change mutation
check alone would have reported the weaker, and by then stale, conclusion.
Mutation-check both sides of a change that alters *when* a module is evaluated.

### Incidental

- Suite wall-clock is a poor signal on a shared box. Between two runs of the same
  581 files it moved 249s → 307s, driven by jsdom `environment` setup going
  2169s → 2823s across *untouched* files. Compare per-test durations, not totals.
  Load moves the verdict too, not only the total. Two later full-suite runs of one
  tree, ~4 hours apart (2026-09-12), went 196.65s and 450.16s,
  with jsdom `environment` at 1787s and 3638s — across *untouched* files. The slow
  one failed 4 tests in 2 files, each a 5000ms body timeout plus one follow-on
  failure from the timed-out test's un-cleaned DOM (`Found multiple elements`,
  `expected length 0 got 1`). Both files passed in isolation and neither imported
  the change under test. **A timeout cascade under load is not a defect in the code
  you just wrote** — re-run before believing it, and compare per-phase durations,
  not the verdict.
- `no-unused-vars` does not flag a bare side-effect `import "x";` — it declares no
  binding. Lint will not remove the warming import; a human might.
