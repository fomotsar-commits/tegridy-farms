# Frontend Blockers — 30-Day UX Push

Things the frontend cannot solve from inside its own code. Each blocker
lists the surface it gates, what's actually needed, who owns it, and the
workaround the frontend is using today so the app keeps working without it.

Per the working agreement: the frontend does not touch `contracts/`. If
a contract change is needed it goes here, not in a PR.

---

## B-1 — Indexer host

**Gates:** P0-2 (indexer wired to frontend), P0-3 (WebSockets on indexer
events), P1-5 (real top-N leaderboards from indexer aggregates).

**What's needed:** the Ponder server in `indexer/` running somewhere
reachable from the Vercel project. Either:

- **Hosted** — Railway / Render / Fly.io / Cloudflare Containers / a
  small VPS. Set `INDEXER_URL` in the Vercel project env to the
  resulting `https://…/graphql` URL.
- **Public CDN edge** — same setup, but also set `VITE_INDEXER_URL`
  in the frontend build env so the bundled JS hits the URL directly.

**Workaround today:** the frontend code reads `resolveIndexerUrl()` and
returns `isAvailable: false` when no URL is configured. Every call-site
falls back to existing RPC/Etherscan reads, so the app keeps working —
it just doesn't get the speed-up the indexer is meant to deliver.

**Owner:** Ops / infra (not frontend).

---

## B-2 — TegridyLaunchpadV2 mainnet broadcast

**Gates:** P0-1 (launchpad-first home goes live with real drops), P0-2
(indexer `dropCollection` table starts populating).

**What's needed:** broadcast the compiled `TegridyLaunchpadV2.sol`
factory from the new wallet (see `project_relaunch.md` memory). After
broadcast, two pointer updates:

- `frontend/src/lib/constants.ts:62` — replace
  `TEGRIDY_LAUNCHPAD_V2_ADDRESS` placeholder with deployed address.
- `indexer/ponder.config.ts` — set `TEGRIDY_LAUNCHPAD_V2_ADDRESS` env
  var (already wired to read from process.env). Tighten
  `startBlock: TEGRIDY_FACTORY_START` to the actual broadcast block.

**Workaround today:** the launchpad-home gallery
(`LaunchpadHomePage`) detects the zero placeholder and renders a
day-0 hero pointing creators at the wizard. The indexer factory entry
is a no-op until the address changes — no errors, just no rows.

**Owner:** Contracts / deploy (not frontend).

---

## B-3 — V2 Drop countdown timestamps not on-chain-readable

**Gates:** P0-1 cards show phase labels ("Public mint", "Dutch
auction") instead of a ticking countdown.

**What's needed:** `TegridyDropV2` exposes `configureDutchAuction(...)`
as a setter but no public getter for `dutchStartTime` / `dutchDuration`
/ `dutchStartPrice` / `dutchEndPrice`. The frontend can compute current
Dutch price via the existing `currentPrice()` view, but can't render
"ends in 04:12:33" without those getters.

**Three options for whoever owns this next:**

1. Add view getters to `TegridyDropV2` (contract change — not frontend
   scope).
2. Emit a `DutchAuctionConfigured(startTime, duration, startPrice,
   endPrice)` event in `configureDutchAuction`, then index it. Phase
   labels stay, but the page can also show an exact countdown.
3. Accept phase-labels-only — that's where the gallery ships today.

**Workaround today:** option 3. Cards show "Dutch auction" / "Public
mint" badges with no countdown.

**Owner:** Contracts (if the team wants countdowns).

---

## B-5 — Keeper choice for recurring swaps + limit orders

**Gates:** P1-4 feature revival (DCA + Limit Order tabs).

**What's needed:** a keeper (third-party or self-hosted) that watches
chain state and pings the protocol when a user's "swap every N hours"
or "swap when price < X" condition is met. Without one, every "fires
later" UI we ship is dishonest because the schedule depends on the
user's browser tab staying open.

Trade-offs documented in
[`docs/adr/001-keeper-choice.md`](docs/adr/001-keeper-choice.md):
Gelato vs Chainlink Automation vs self-hosted bot vs leave-off.

**Workaround today:** the tabs and dashboard alerts are removed (P1-4).
Component files (`DCATab.tsx`, `LimitOrderTab.tsx`,
`useDCA.ts`, `useLimitOrders.ts`) stay on disk so the UI rebuild on
top of the chosen keeper is mechanical, not a from-scratch rewrite.

**Owner:** Ops + product (pick the keeper); then frontend (re-wire
the tabs).

---

## B-4 — Telegram bot delivery surface (P2-8)

**Gates:** P2-8 of the 30-day push (Telegram notification bot).

**What's needed:** a Telegram bot token plus a process / runtime to
host the bot. The user's brief asks for `services/telegram-bot/` as a
Node service; deployment target is TBD. Listed here so the bot doesn't
quietly land without an environment that can actually run it.

**Workaround today:** none yet — P2-8 is unstarted.

**Owner:** Ops + frontend (the bot itself).
