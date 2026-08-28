# Frontend audit — 2026-08-28 ("avant-garde condition" sweep)

**Operator instruction:** "do a full front end audit and ensure everything is avantegarde condition."
Six parallel read-only lanes over trunk `6d16ce31` (routes/dead-UI · money-path correctness ·
copy honesty · a11y/responsive/theming · bundle/chunk-graph · security surface) plus a live-prod
probe. Discipline: every lane finding required a quoted current `file:line` or was dropped;
~20 findings were independently re-verified by hand before any edit — **zero refuted**.

**Score: 53 verified findings (10 HIGH / 21 MED / 22 LOW). 46 FIXED in the five-commit
remediation wave on this branch; 7 tracked as named follow-ups.** The deepest structural wins:
the twice-shipped prod-only chunk-weld class now has a mutation-tested red check inside
`npm run build`, and 14 real routes that were invisible to every guard now carry coverage.

## What was already in avant-garde condition (verified clean — do not re-hunt)

- **Security HIGHs: none.** Curve-identity XSS is structurally closed (https-only website,
  anchored handle regexes, txid-only image URLs, React text nodes; spoof-resistance via
  owner-filtered GraphQL + address re-check). SSRF boundaries closed on every api/ handler;
  origin-allowlist parity is test-enforced across 15 handlers; SIWE cookie is
  httpOnly+Strict+Secure, no JWT in storage; the index.html JSON-LD sha256 CSP pin recomputes
  to exactly the pinned value; `frame-ancestors 'none'` + HSTS preload live on prod.
- **Money-path fundamentals:** chainId pinned on every multichain read/write repo-wide;
  every swap floor's displayed quote == submitted minOut; curve fee copy (1%, 40/25/35, 3.69%)
  matches the deploy config; all `@solana/*` static importers live in lazy chunks; the entry
  polyfill invariant held.
- **a11y machinery:** global `:focus-visible` outline beats every `outline-none`; the
  `.text-white/N` contrast floor rewrites body-text alphas to ≥0.55; reduced-motion is honored
  globally (CSS + MotionConfig); all data tables have overflow containment; live build dated
  current on prod via lazy-chunk fingerprints; SIWE 200 / analytics mounted.
- **F45 closed by removal:** light mode was deleted 2026-08-23 (operator decision recorded in
  index.css; dark-only tripwire test exists). The old "25 pages at 1.39:1" exposure no longer
  exists on any reachable page.

## Fixed in this wave (by commit)

### `frontend(honesty)` — 20 stale/overclaiming surfaces
HIGH ContractsPage omitted the ETH-custodying curve launcher while claiming completeness → new
three-chain Token Launcher group (addresses from constants/registry, per-chain explorer links,
L2 rows excluded from the mainnet-Etherscan verify query so verified contracts can't badge
"unverified"). HIGH×5 in the app-wide Towelie assistant ("No L2 yet", referrer-only referrals,
unconditioned Gold-Card yield, "not redeployed" for July-live contracts, "two chains") + the
flagship curve finally gets an assistant entry. HIGH FAQ "Ethereum Mainnet only" (fed to
crawlers via JSON-LD) → the real four-chain answer; the escaped "earn ETH from swap fees"
phrasing is now BANNED by regex in revenueClaimHonesty (premiumBenefits' read-conditioned
branch excepted; pre-fix FAQ text provably trips it). The meteoraRetired tripwire's quote-gate
(which let bare-JSX "runs on Meteora's curve" survive) closed. Meta truth: manifest×2 +
index.html drop "token launches on Solana", sitemap swaps the deleted /solana-launch for
/eth-curve, SecurityPage meta stops claiming audits/bounty its own banner denies. HomePage's
"Live · Ethereum" curve card → three chains; the farm tile stops promising the LP pool whose
funded period ended 06-15. navConfig's dead Solana rail loses the bare "Tegridy Curve" name.
Date stamps corrected to real last-change dates. `.env.example` gains the 7 quiet-closed vars
the code reads (4 route revenue); the dead DBC entry marked READ-BY-NOTHING.

### `frontend(bundle)` — the weld class gets a gate
`scripts/check-dist-graph.mjs` in `npm run build`: entry chunk must carry the polyfill markers;
vendor-solana must be absent from the entry's STATIC import closure (dynamic import is the
sanctioned path) and from modulepreload. Fails on empty dist/matched-nothing. **Mutation-tested
6 ways against a fixture dist** (marker strip / direct static / transitive static via plumbing /
preload / empty scanner / pass). main.tsx's backwards comment (claimed buffer "matches no
manualChunks rule" — unassigned buffer was the bug) rewritten; bs58/base-x/bn.js/safe-buffer
preemptively pinned into shared-plumbing (the Irys↔Solana shared-dep shape that produced both
prior welds); CurveChart now imports the pure geometry/format modules, not the web3.js-carrying
barrel.

### `frontend(a11y)` — touch, contrast, and the inert class
44px mobile floors (`min-h-[44px] … md:min-h-0`, desktop untouched) on: TradePage 50%/MAX +
slippage + token selectors, CurveTradePanel toggle/max/chips, LPFarming MAX×2, LaunchBuyPanel
buttons, TopNav's 28px trio (incl. the full-reload replay button). **Tailwind-v4 finding:** four
inputs used v3 `placeholder-white/NN` — an INERT class on v4 — leaving default-gray placeholders
at ~2.6:1 (swap token search included); migrated to `placeholder:text-white/60`. Colored
low-alpha text escaping the white-only contrast floor fixed (DCA data-loss warning 2.66:1,
LaunchBuyPanel emeralds, TransactionReceipt Close 3.76:1). border-glow's infinite repaint now
also stilled on iPads (768–1024) with the R038 nav-link touch rule duplicated there; the nav's
`#22c55e` literals tokenized as `--color-kyle-bright`.

### `frontend(curve)` — receipts and the deferred window
Buy/sell/approve/finalize/claim all track hash→receipt with explicit status (revert = red toast,
never silent); buttons hold through mining with a distinct label; balance/allowance poll at 15s
and refetch on confirmed receipts (no more double-approval invite / stale sell max); the
claim's pre-mine refetch double-submit window closed. **Deferred graduation** (contract rejects
buys at `ethReserve ≥ graduationEth` even while `graduated=false`; third-party-forceable):
Buy closes with an explanation, Sell stays open, and permissionless `finalizeGraduation` gets
its first UI caller. Non-curve addresses get an honest "no launch here" instead of eternal
"Loading…". The maxUint256 sell approval is disclosed. All pinned by new view tests.

### `frontend(security+routes)` — exfil trim and the invisible doors
CSP connect-src −10 gratuitous hosts (9 proxy-only upstreams + dropped eth.merkle.io) — pure
post-XSS exfil allowance, re-verified zero direct fetches. The unwired R080 zod schemas carry a
loud NOT-WIRED header so they can't be cited as protection. The 14 bungalow door routes
(expression-built, regex-invisible, zero coverage for months while the sync guard passed) are
now derived by the guard from the same BUNGALOWS map and enumerated in the fixture with
HomePage's known-violation set — a new bungalow arrives with coverage or the guard reds.

## Follow-ups (named, owned)

1. **Wire the R080 zod schemas** at aggregator.ts's seven `res.json()` boundaries (chip spawned;
   graceful per-provider degradation; the amountOut inline guard stays the load-bearing check).
2. `clsx` unused dep + `@types/papaparse` in dependencies — needs a lockfile regen (`npm i`),
   not doable from a deps-less worktree; fold into the next dependabot-adjacent change.
3. vendor-solana carries duplicate nested `@streamflow` copies of @solana packages (bytes only,
   lazy chunk) — dedupe lockfile ranges when convenient.
4. Towelie assistant: consider deriving live/deployed status lines from constants.ts instead of
   prose (three drift incidents now; a generated answer can't rot).
5. `EthCurvePage`'s not-deployed branch is dead code on every configured chain — prune when
   convenient (kept tonight; it still renders for chain-unconfigured wallets).
6. Run `ANALYZE=true vite build` once deps exist locally to eyeball the post-pin chunk sizes
   (the dist gate enforces correctness; this is for the bytes).
7. OG image (`og.png`) regeneration ritual if og copy changes further (unchanged tonight —
   og:description was already honest).

## Method notes

- The verify-before-fix rule earned its keep in reverse tonight: ~20 hand-checks, zero agent
  false positives — the "quote the current line or drop it" prompt discipline appears to be the
  active ingredient.
- One self-caught regression during the wave: widening a CSS media block re-scoped the R038
  nav-link touch rule OFF phones (closing-brace insertion) — caught by re-reading the region,
  fixed by duplicating the rule into both blocks. Structural CSS edits deserve a post-edit read.
- This worktree has no frontend node_modules (OneDrive EPERM class), so the verification lane
  for this branch is PR CI: tsc -b, vitest, the PROD BUILD (which now runs the new dist gate),
  Playwright E2E, and the a11y sweep — the exact gates that matter for these changes.
