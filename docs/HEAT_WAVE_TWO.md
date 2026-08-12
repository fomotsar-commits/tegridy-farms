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
| Record schema + pure builder | `frontend/api/_lib/record-core.js` (re-exported by `src/lib/launcher/birthRecord.ts`) |
| The record route | `frontend/api/_lib/record.js` + `record-evm.js` + `record-solana.js` |
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

## The record route — chain-derived (operator decision, 2026-08-09)

`GET /record/:chain/:ca.json`. Nothing is stored, so there is nothing to forge, no write
path to defend, and no snapshot that can drift from the chain it describes. The record
improves over time as facts become provable, which is the most literal reading of the
stamp it carries.

**The rewrite is load-bearing, not cosmetic.** `vercel.json`'s SPA fallback is
`/((?!api/).*)` — the negative lookahead only excludes `api/…`. Without the record
rewrite sitting *above* it, `/record/…` is rewritten to `index.html` and answers **200
with HTML forever**; a health check on `res.ok` would report it healthy. A second
catch-all (`/record/:path*`) exists so a malformed path also reaches the function and
gets a JSON 404 rather than an HTML 200. Any smoke check must assert
`content-type: application/json` **and** `schema_version === 1` — never just `res.ok`.

**What is readable, per rail:**

| | Ethereum | Solana |
|---|---|---|
| `decimals` | read, chain wins over the pinned 18 | read from the SPL mint (byte 44) |
| `total_supply` | read | read (u64 LE, BigInt — no 2^53 loss) |
| `name` / `symbol` | read | `unread` — Metaplex strings are NUL-puffed and our own curve rail writes no metadata account |
| `plates` | from `vestedTotalAmount()` on the Doppler template | `unread` |
| `birth_block` / `birth_tx` / `creator` | from the Airlock `Create` log (needs `ETHERSCAN_API_KEY`) | `unread` |
| `fee_instruction` | `unread`, permanently — see below | `unread` |
| `locks.liquidity` | `unread` — the V1 locker has no token → tokenId index | `unread` |

**`fee_instruction` is unread in every phase on the EVM rail, and that is final.** The
split exists only as calldata to `Airlock.create`; `getAssetData`'s ten words contain no
fee split; and StreamableFeesLocker V1 is *verify-if-known* (`positions(uint256)`), never
*enumerate* — there is no token → position-tokenId index on V1 at all. Do not build a
`graduated === true` branch: it cannot fire.

**`chain=base` 404s.** It is a valid `BirthChain` and the socket accepts it, but there is
no Base address book and no Base RPC server-side. Answering with mainnet addresses would
be a fabricated record.

**Caching a failure is the lie that lasts 300 seconds.** A 200 whose fields are all null
is honest for one request and false for the next five minutes. `TRANSIENT_UNREAD` splits
"a read failed this time" from "this rail cannot prove this, ever", and any transient
entry forces `Cache-Control: no-store`.

### Three honesty defects this pass fixed in the shipped builder

1. **A fabricated liquidity claim.** `readMigrationStream` takes `_client` (unused) and
   returns a hardcoded `locked: false`, which `gate.ts` renders as *"Liquidity is not
   locked; it may be withdrawable by the liquidity owner."* The builder copied that
   sentence into `locks[0].note` — publishing an assertion about a locker nobody queried.
   The page has its own guard (`unverifiedGateChecks`); the record now has one too
   (`liquidityReadable`).
2. **An inverted premine disclosure.** `collectTokenFacts` declares `vesting[]` and never
   pushes to it, so a provably-vested premine arrived with an empty array — and the
   builder labelled it *"no on-chain vesting schedule was read"* with `locked: false`.
   That is an unlocked insider slice published for a token whose insider slice is locked.
   It now reads `teamAllocationVestedBps`, which is the fact that survives.
3. **Unknown rendered as absent.** `sheet.name || null` turned an unread name into `null`
   with nothing in `unread`; and `RawTokenFacts.unreadFields` carries *Solidity method
   names* while `unread` carries *record field names*, so piping one into the other would
   publish `"totalSupply"` in a field-name list. `UNREAD_FIELD_BY_METHOD` translates, and
   the builder auto-declares null-ish fields.

### Where the shared core lives now

`buildBirthRecord` and friends moved to `frontend/api/_lib/record-core.js` (plain ESM,
zero imports, plus a co-located `.d.ts`), and `src/lib/launcher/birthRecord.ts` re-exports
it. A lambda cannot import a `.ts` module, and the repo's existing answer to that — a
hand-written JS port with a "keep in sync" comment, see `_lib/launcher-outcomes.js` — is
exactly the fork the directive forbids. `cloneImplTarget` moved for the same reason: both
rails must agree on what a Doppler clone is, and Doppler deploys the **Solady** layout, so
a copy that parsed only EIP-1167 would make every real launch look unverified.

⚠️ The core is bundled into the **browser** as well as the lambda. Keep it pure: no
`node:` imports, no `process.env`, no `fetch`, no `Buffer`.


### What the adversarial review found after the route shipped

A four-lens pass (honesty · hostile input · read correctness · refactor integrity)
produced 32 candidates; three survived independent refutation, and all three were
reproduced against the real code before being patched.

1. **Bytes alone decided what a Solana mint was.** `decodeMintAccount` rejected only
   buffers *shorter* than 82 bytes, and the owning program was never checked. A 165-byte
   SPL **token account** therefore decoded as a mint — its bytes 44/45 sit inside the
   owner pubkey, so one with `byte45 == 1` and `byte44 <= 18` passed the decimals and
   is-initialised checks by coincidence, and bytes 36..44 of that pubkey were published
   as `total_supply` with no `unread` entry. Grinding such a keypair takes seconds.
   Fixed with an exact 82-byte length **and** a token-program owner allowlist checked
   before decoding — both are needed, because exact-length alone still admits an
   82-byte account of an unrelated program, and the owner check alone still admits a
   165-byte Token-2022 token account.

2. **bps truncation moved locked supply into the unlocked plate.** `teamAmount` was
   recomputed from the truncated bps rather than the exact `vestedTotalAmount()`, and the
   remainder became the public-sale plate at `locked: false`. A 0.001% premine truncated
   to 0 bps, the team plate vanished, and the record published a single 10000-bps
   "Public sale" — the same fabricated full-float claim the plates suppression exists to
   prevent, reached by another road. Exact base-unit amounts now travel end to end and
   **the sale is the remainder**, not a round trip.

3. **A template token with an unreadable supply declared nothing.** The two branches that
   set `unread: ["plates"]` were `isDopplerTemplate && supply > 0n` and
   `!isDopplerTemplate`; a Doppler clone whose `totalSupply()` read failed matched
   neither, so `plates: []` was published as if enumerated.

The common shape is worth naming: **each was a path where "we did not read this" reached
the JSON as a confident value.** That is the one failure this document exists to prevent,
and it took a hostile reader plus a live mainnet run to find all four instances of it
(the fourth — a fabricated 100%-float plate — was caught by running the route against
USDC, not by any test).


### And the one it led back to: an unverified claim was being attested on-chain

Tracing defect (1) upstream found that it did not start in the birth record. The fact
sheet itself asserted *"Liquidity is not locked; it may be withdrawable by the liquidity
owner."* for every token on the EVM rail — and
`attestation.canonicalDisclosuresJson` folds the whole `liquidity` object into
`disclosuresDigest`, which is published **on-chain and permanent**.

`readMigrationStream` takes `_client` (unused) and returns a hardcoded
`locked: false, unsupported: true` without touching the chain. So `locked: false` carried
two meanings — "read, and unlocked" and "never asked" — and `toLiquidityDisclosure`
rendered both as the same sentence. The page had a guard for the gate check
(`unverifiedGateChecks`); the digest had none.

`LiquidityDisclosure.readable?: boolean` now carries the distinction. **Absent means
read**, so every existing producer is untouched; `lockResolverFor` sets
`!stream.unsupported`; the default resolver and the `.catch` fallback both set `false`,
because a thrown read is not a finding of "unlocked". `buildBirthRecord` inherits the
sheet's value when no flag is passed, so record and sheet cannot disagree.

⚠️ **This changes `disclosuresDigest` for future attestations on this rail.** That is the
point — the previous digest committed to a false statement. Attestations are revocable
timestamped disclosures, and no already-published one can be improved either way.

A genuine unlocked finding is still stated plainly. Suppressing "we read it and it is
unlocked" would be the opposite failure, and a test pins it.
