# Wave Two — the ruler, the gate, the births

Implementation record for the Jungle Bay Island build directive (`jbi-memetics-build-directive`),
the launch gate spec (`jbi-launch-gate`) and the birth socket card (`jbi-birth-socket-config-card`).

Three phases, strict order: **the ruler → the gate → the births.**

---

## ⚠️ The one deviation from a prior operator decision — READ FIRST

**The 180-day tenure floor is gone. The gate is now a degrees floor: 80° (Resident).**

The venue previously gated launching on 180 days of `held_since_unix`
(`LAUNCH_MIN_HELD_DAYS`, operator decision 2026-08-07, re-affirmed 2026-08-08). The
island's launch-gate spec retires that rule in terms it repeats twice:

> "There is no 180-day rule in your code, for any asset."
> "NO token list, NO 180-day check, NO calendar, anywhere in this codebase. If you find
> yourself writing one, you have drifted from spec."

The build directive's own conflict rule is *"where any two documents disagree, the newer
one wins, and you flag the disagreement instead of resolving it silently"* — so the newer
spec was implemented and this section is the flag.

**Why the island's version is defensible on the merits:** heat is TWAB-based and
zero-anchored, so held time is already priced *inside* the number. A fresh bag reads cold
and cannot buy the floor however large it is; a wallet that held through the year reads
warm. A separate day-counter adds no safety the curve does not already provide, while
failing the wallet that has held several measured tokens deeply for five months and
passing the wallet that has held dust for six.

**Who this changes:** anyone with ≥80° island_heat may now launch regardless of tenure;
anyone below 80° may not, regardless of tenure. Of 49 real wallets sampled on 2026-08-07,
13 cleared 80° (2 Elder, 6 Builder, 5 Resident).

**How to reverse it:** `VITE_HEAT_LAUNCH_FLOOR` moves the floor; `VITE_HEAT_GATE=off`
stops the gate denying at all (it still reads and still logs). Neither needs a code change.

---

## Phase 1 · The ruler

| Piece | Where | Note |
|---|---|---|
| Oracle client | `src/lib/heat/heatClient.ts` | Hard timeout **6s**; TTL cache **3 min**; successes only |
| Server proxy | `frontend/api/_lib/heat.js` | Upstream budget **4.5s**, strictly below the client's 6s so our honest 502 is reachable |
| The card | `src/components/HeatCard.tsx` | One component. `address` pins it; `variant="embedded"` drops chrome only |

The card renders degrees to 2dp, the tier word verbatim, held-since, the reckoning date
from `as_of_unix`, and the per-token breakdown straight from the response. **The breakdown
is the roster** — when the island enrols new tokens the card grows with zero code changes.

Mounted on: `/leaderboard`, `/exposure`, and inside the gate's COLD state on all three
launch rails.

**Register law, enforced by review not by code:** never restyle the judgment, never
translate tiers into yield language, never hide the reckoning date.

## Phase 2 · The gate

One primitive. `meetsHeatFloor(address, { floor, maxAgeDays })` in
`src/lib/heat/launchGate.ts`, over the pure `gateDecision()` in `heatOracle.ts`.

**Exactly three states.** `WARM` (≥ floor, lane opens) · `COLD` (below floor, the wallet
sees its own degrees and what warmth is) · `STALE` (old reading **or** oracle silent —
honest error and retry, never a fake verdict).

**Fail-closed, in this order:** no reading → STALE · stale reading → STALE · below floor →
COLD · at/above floor → WARM. Freshness is checked *before* the floor, because a stale
reading may not **fail** anyone either.

A cold wallet is **COLD, not STALE.** It carries `as_of_unix: null` because nothing has
been reckoned, so nothing can have gone out of date — this resolves the open question
logged against null `as_of_unix` on 2026-08-07.

**Audit surface.** Every decision is logged with the reading it used —
`{ address, degrees, tier, as_of, floor, verdict }` — in `src/lib/heat/gateAudit.ts`. The
row freezes the floor it was taken against, so a floor that moves later cannot rewrite
history. Deliberately **not** the consent-gated analytics sink: a wallet that declined
analytics still deserves to know what the door read. The row's `id` is
`gate_decision_id` on the wire.

**Enforcement.** EVM `launchToken()` after the integrator guard and before any SDK work
(`LaunchError('heat-denied', { broadcast: false })`). Solana `submitLaunch()` **first**,
above the descriptor build — `HeatGateDenied` is a plain `Error` subclass on purpose so
`wasBroadcast()` reads false and the refusal truthfully says nothing was submitted.

**⚠️ The gate is ADVISORY.** Both rails sign client-side, so anyone can call the Doppler
Airlock or the Meteora program directly. It raises the floor on the path we control and
proves nothing about the path we do not. Real enforcement needs an island-signed
attestation the venue contract can verify — still open with the island.

**Garden lane** (`src/lib/heat/certification.ts`): `isCertified(community)` reads
island-published state and fails closed in every branch that is not an explicit island
`certified: true`. No endpoint is published yet, so it answers `not-published` and the lane
stays dark. **The venue never self-declares certification.**

## Phase 3 · The births

| Piece | Where |
|---|---|
| Record schema + pure builder | `src/lib/launcher/birthRecord.ts` |
| Signed relay to the island | `frontend/api/_lib/births.js` (`?resource=births`) |
| Queue + visible retry | `src/lib/launcher/birthNotify.ts` |
| Launch-path glue | `src/lib/launcher/notifyBirth.ts` |
| Ops surface | `src/components/BirthQueuePanel.tsx` → `/admin` |
| Covenant, dormant | `src/lib/launcher/covenant.ts` |

**Decimals, pinned per rail.** The ETH rail is fixed at 18 (DopplerERC20V1 hardcodes it —
not a per-launch choice). The curve rail is **not** fixed: `mint.decimals` is a launch
parameter (6 default, 6–9 supported), so it is snapshotted and printed. `railDecimals()`
**refuses to invent** a Solana precision — an unread one is `null` and named in `unread`,
never defaulted to 18. Wrong precision voids comparability across every record, chart and
plate the venue serves.

**Unknown is never zero.** Every unread field is `null` and named in `unread[]`. An empty
fee instruction is declared unread rather than published as "no fees are charged" — the
launch-time split is not provable for an arbitrary token and the real one is only readable
from the locker after graduation.

**The notify never blocks and never fails silently.** `enqueueBirth` is synchronous,
infallible, and idempotent per `(chain, ca)`. Delivery is a separate flush that walks the
queue **serially** (the island's `/api/*` is 100 req/min shared with the Heat oracle). A
failure stays queued with its error and attempt count; a `422` parks as `rejected` for a
human rather than grinding a permanent failure. `200 already_enrolled` is a **success** —
retries are free forever.

**Signing.** The secret is server-side only; a signature the browser could produce is one
anybody could produce. The body is serialised **once** into a Buffer, that Buffer is
HMAC'd, and that same Buffer is sent — a re-serialisation between signing and sending
breaks the signature, which is the failure the island's card warns about. Six keys, strict:
a seventh is rejected locally and named, never silently dropped.

**Chain truth, never approximated.** If `birth_block` cannot be read, the notify is
**withheld** rather than sent with a guess — heat is time-weighted, so the birth block is
the zero point of every degree the token will ever earn.

**Covenant.** `COVENANT_SPLIT` (50/20/15/10/5) is declared, sums to 100%, and is
**dormant**: `isCovenantActive()` returns false with no env var that can flip it.
`covenant.test.ts` walks the source tree and fails if any launch-path module imports it —
"covenant math active nowhere" is enforced, not asserted.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITE_HEAT_GATE` | on | `off` stops the gate denying. It still reads and still logs |
| `VITE_HEAT_LAUNCH_FLOOR` | `80` | Degrees floor. Non-numeric/≤0 overrides are **ignored**, not obeyed |
| `VITE_HEAT_MAX_AGE_DAYS` | `7` | Freshness window |
| `VITE_ISLAND_CERTIFICATION_URL` | unset | Garden lane stays dark while unset |
| `VITE_CANONICAL_ORIGIN` | `https://memetic.fun` | Origin used to build `record_url` |
| `MEMETICS_BIRTH_SECRET` | **unset** | Server-side HMAC secret. **Arrives separately from seacasa** |
| `BIRTHS_GLOBAL_RPM` | `40` | Our cap, set under the island's shared 100/min |

## Go-live checklist

1. Obtain `MEMETICS_BIRTH_SECRET` from seacasa; set it in Vercel (server-side, **not** `VITE_`).
   Until it is set, `?resource=births` answers `503 no_secret` and births stay queued —
   deliberately, so a backlog is visible rather than silently dropped.
2. Decide where the JSON birth record is **hosted** — see below. `record_url` already has
   its final shape (`/record/:chain/:ca.json`); only the server that answers it is open.
3. Confirm the floor with the island (80° is what the spec states) and set
   `VITE_HEAT_LAUNCH_FLOOR` explicitly rather than relying on the default.
4. Verify a real read: connect a warm wallet and confirm the door shows WARM, then confirm
   the audit row on `/admin`.

## Open: where the record JSON is served from

The record's **shape**, **builder** and **URL** are done and tested. What is not decided is
which server answers `GET /record/:chain/:ca.json`, because the honest options trade off
differently and it is an operator call:

- **Publish at create into Supabase** (migration + `?resource=birth-record`). Serves the
  full record including the fee instruction, which is a launch-time config input and is
  *not* chain-readable before graduation. Cost: a public write path that must be
  authenticated or verified on-chain, or a squatter can publish a record for a token they
  did not launch. **Not shipped for that reason** — an unauthenticated public write is not
  something to add without a decision.
- **Derive from chain on read.** No storage, no trust, tamper-proof, and it improves over
  time as facts become provable. Cost: the fee instruction reads as `unread` until
  graduation, and it needs the Airlock/locker selectors ported to the serverless side.
- **Publish to Irys at create.** Permanent and immutable, reuses machinery the EVM launch
  path already has. Cost: an extra wallet-funded upload per launch, and the Solana rail
  does not have the same uploader.

Recommendation: **derive from chain**, and let `unread: ["fee_instruction"]` be honest
until graduation. It is the only option with no new trust assumption, and "Every lock
verifiable onchain" is the stamp the record itself carries.
